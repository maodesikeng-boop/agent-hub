import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import { isDeviceId, type DeviceId } from "../../shared/api.ts";
import { parseFeishuAppId, parseFeishuChatId, parseFeishuMessageId, type FeishuAppId, type FeishuChatId, type FeishuMessageId } from "../../shared/feishu.ts";
import {
  FEISHU_INBOUND_CLAIM_SYNC_WAIT_MS,
  FEISHU_INBOUND_CHECKPOINT_CURSORS_MAX,
  FEISHU_INBOUND_CHECKPOINT_PLAINTEXT_MAX_BYTES,
  FEISHU_INBOUND_CHECKPOINT_RECEIPTS_MAX,
  FEISHU_INBOUND_CURSORS_MAX,
  FEISHU_INBOUND_FLUSH_TIMEOUT_MS,
  FEISHU_INBOUND_HYDRATE_TIMEOUT_MS,
  FEISHU_INBOUND_PEER_HYDRATE_CONCURRENCY,
  FEISHU_INBOUND_PEER_UNSUPPORTED_TTL_MS,
  FEISHU_INBOUND_RECEIPTS_MAX,
  FEISHU_INBOUND_RECEIPTS_TTL_MS,
  FEISHU_INBOUND_STATE_FILE_MODE,
  FEISHU_INBOUND_STATE_MAX_BYTES,
  MESH_MAX_DEVICES_PER_ACCOUNT,
  RELAY_LEASE_CHECKPOINT_MAX_BYTES,
} from "../../shared/limits.ts";
import type { AccountId, MeshLeaseName } from "../../shared/mesh.ts";
import type { RelayLeaseCheckpointPutRequest, RelayLeaseCheckpointRecord } from "../../relay/protocol.ts";

export const FEISHU_INBOUND_RECEIPT_PHASES = ["held_offline", "claimed", "handled"] as const;
export type FeishuInboundReceiptPhase = (typeof FEISHU_INBOUND_RECEIPT_PHASES)[number];

export interface FeishuInboundCursorEntry {
  chatId: FeishuChatId;
  lastInboundAt: number;
  lastMessageId: FeishuMessageId | null;
  updatedAt: number;
}

export interface FeishuInboundReceipt {
  messageId: FeishuMessageId;
  chatId: FeishuChatId;
  messageAt: number;
  phase: FeishuInboundReceiptPhase;
  claimedBy: DeviceId;
  epoch: number;
  updatedAt: number;
}

export interface FeishuInboundStateSnapshot {
  version: 1;
  appId: FeishuAppId;
  seq: number;
  cursors: Record<string, FeishuInboundCursorEntry>;
  receipts: Record<string, FeishuInboundReceipt>;
}

export type FeishuInboundClaimDecision =
  | { kind: "claimed"; receipt: FeishuInboundReceipt }
  | { kind: "duplicate"; existing: FeishuInboundReceipt };

export type FeishuInboundHoldDecision =
  | { kind: "held"; receipt: FeishuInboundReceipt }
  | { kind: "duplicate"; existing: FeishuInboundReceipt };

export interface FeishuInboundPruneLimits {
  receiptTtlMs: number;
  maxReceipts: number;
  maxCursors: number;
  maxBytes: number;
}

export interface FeishuCheckpointCryptoKeyInput {
  accountId: AccountId;
  appId: FeishuAppId;
  appSecret: string;
}

export interface FeishuCheckpointAad {
  accountId: AccountId;
  leaseName: MeshLeaseName;
  epoch: number;
  seq: number;
}

export type FeishuInboundRelayGetResult =
  | { kind: "ok"; checkpoint: RelayLeaseCheckpointRecord | null }
  | { kind: "unsupported" }
  | { kind: "unavailable" };

export type FeishuInboundRelayPutResult =
  | { kind: "ok"; checkpoint: RelayLeaseCheckpointRecord }
  | { kind: "stale_epoch"; currentEpoch: number }
  | { kind: "stale_seq"; currentSeq: number }
  | { kind: "unsupported" }
  | { kind: "unavailable" };

export interface FeishuInboundRelayPort {
  accountId(): AccountId | null;
  getCheckpoint(name: MeshLeaseName, signal?: AbortSignal): Promise<FeishuInboundRelayGetResult>;
  putCheckpoint(name: MeshLeaseName, request: RelayLeaseCheckpointPutRequest, signal?: AbortSignal): Promise<FeishuInboundRelayPutResult>;
}

export type FeishuInboundPeerFetchResult =
  | { kind: "ok"; state: FeishuInboundStateSnapshot | null }
  | { kind: "unsupported" }
  | { kind: "unavailable" };

export type FeishuInboundPeerPushResult =
  | { kind: "ok" }
  | { kind: "unsupported" }
  | { kind: "unavailable" };

export interface FeishuInboundPeerPort {
  onlinePeers(): DeviceId[];
  fetchPeerState(peerId: DeviceId, signal?: AbortSignal): Promise<FeishuInboundPeerFetchResult>;
  pushPeerState(peerId: DeviceId, state: FeishuInboundStateSnapshot, signal?: AbortSignal): Promise<FeishuInboundPeerPushResult>;
}

export interface FeishuInboundSyncOptions {
  selfId: DeviceId;
  stateFile: string | null;
  initialAppId?: FeishuAppId | null;
  legacyCursors?: () => FeishuInboundCursorEntry[];
  appCredentials: () => { appId: FeishuAppId; appSecret: string } | null;
  leaseEpoch: () => number | null;
  relay?: FeishuInboundRelayPort;
  peers?: FeishuInboundPeerPort;
  now?: () => number;
  log: (line: string) => void;
}

export interface FeishuInboundSync {
  snapshot(): FeishuInboundStateSnapshot | null;
  exportForWire(): FeishuInboundStateSnapshot | null;
  cursorOf(chatId: FeishuChatId): FeishuInboundCursorEntry | null;
  receiptOf(messageId: FeishuMessageId): FeishuInboundReceipt | null;
  isAlreadyExecuted(messageId: FeishuMessageId): boolean;
  retryFrom(chatId: FeishuChatId, sinceMs: number): number | null;
  seedLocalCursor(chatId: FeishuChatId, cursor: { lastInboundAt: number; lastMessageId: FeishuMessageId | null }): void;
  tryClaim(input: { messageId: FeishuMessageId; chatId: FeishuChatId; messageAt: number; isOwnerOfChat: boolean }): FeishuInboundClaimDecision;
  ownsClaim(receipt: FeishuInboundReceipt): boolean;
  releaseClaim(receipt: FeishuInboundReceipt): void;
  markHandled(input: { messageId: FeishuMessageId; chatId: FeishuChatId; messageAt: number; advanceCursor: boolean }): void;
  tryHoldOffline(input: { messageId: FeishuMessageId; chatId: FeishuChatId; messageAt: number }): FeishuInboundHoldDecision;
  advanceCursor(chatId: FeishuChatId, cursor: { lastInboundAt: number; lastMessageId: FeishuMessageId | null }): void;
  mergeRemote(remote: FeishuInboundStateSnapshot): boolean;
  hydrate(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<boolean>;
  flush(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  waitForClaimSync(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  resetForApp(appId: FeishuAppId | null): void;
  close(): Promise<void>;
}

const clockSchema = z.int().nonnegative();
const appIdSchema = z.custom<FeishuAppId>((value) => parseFeishuAppId(value) !== null);
const chatIdSchema = z.custom<FeishuChatId>((value) => parseFeishuChatId(value) !== null);
const messageIdSchema = z.custom<FeishuMessageId>((value) => parseFeishuMessageId(value) !== null);

const cursorSchema = z.strictObject({
  chatId: chatIdSchema,
  lastInboundAt: clockSchema,
  lastMessageId: messageIdSchema.nullable(),
  updatedAt: clockSchema,
});
const receiptSchema = z.strictObject({
  messageId: messageIdSchema,
  chatId: chatIdSchema,
  messageAt: clockSchema,
  phase: z.enum(FEISHU_INBOUND_RECEIPT_PHASES),
  claimedBy: z.custom<DeviceId>((value) => typeof value === "string" && isDeviceId(value)),
  epoch: clockSchema,
  updatedAt: clockSchema,
});
const snapshotSchema = z.strictObject({
  version: z.literal(1),
  appId: appIdSchema,
  seq: clockSchema,
  cursors: z.record(z.string(), cursorSchema),
  receipts: z.record(z.string(), receiptSchema),
});

export function createEmptyFeishuInboundState(appId: FeishuAppId): FeishuInboundStateSnapshot {
  return { version: 1, appId, seq: 0, cursors: {}, receipts: {} };
}

export function parseFeishuInboundStateSnapshot(value: unknown): FeishuInboundStateSnapshot | null {
  const result = snapshotSchema.safeParse(value);
  if (!result.success) return null;
  const state = result.data;
  const cursors = Object.entries(state.cursors);
  const receipts = Object.entries(state.receipts);
  if (cursors.length > FEISHU_INBOUND_CURSORS_MAX || receipts.length > FEISHU_INBOUND_RECEIPTS_MAX) return null;
  if (cursors.some(([id, cursor]) => id !== cursor.chatId) || receipts.some(([id, receipt]) => id !== receipt.messageId)) return null;
  return Buffer.byteLength(JSON.stringify(state)) <= FEISHU_INBOUND_STATE_MAX_BYTES ? state : null;
}

const compareText = (a: string, b: string) => a === b ? 0 : a > b ? 1 : -1;
const receiptAgeAnchor = (receipt: FeishuInboundReceipt) => Math.max(receipt.updatedAt, receipt.messageAt);
const phaseRank = (phase: FeishuInboundReceiptPhase) => FEISHU_INBOUND_RECEIPT_PHASES.indexOf(phase);

type StateEntry = FeishuInboundCursorEntry | FeishuInboundReceipt;
const entrySizes = new WeakMap<StateEntry, { id: string; bytes: number }>();

function entryBytes(id: string, entry: StateEntry): number {
  const cached = entrySizes.get(entry);
  if (cached?.id === id) return cached.bytes;
  // Allow one comma per entry, including the last entry in each record.
  const size = Buffer.byteLength(JSON.stringify({ [id]: entry })) - 1;
  entrySizes.set(entry, { id, bytes: size });
  return size;
}

function compareCursor(a: FeishuInboundCursorEntry, b: FeishuInboundCursorEntry): number {
  return a.lastInboundAt - b.lastInboundAt || a.updatedAt - b.updatedAt || compareText(a.lastMessageId ?? "", b.lastMessageId ?? "");
}

function compareReceipt(a: FeishuInboundReceipt, b: FeishuInboundReceipt): number {
  return phaseRank(a.phase) - phaseRank(b.phase) || a.epoch - b.epoch || a.updatedAt - b.updatedAt ||
    compareText(a.claimedBy, b.claimedBy) || a.messageAt - b.messageAt || compareText(a.chatId, b.chatId);
}

const wireLimits = {
  maxReceipts: FEISHU_INBOUND_CHECKPOINT_RECEIPTS_MAX,
  maxCursors: FEISHU_INBOUND_CHECKPOINT_CURSORS_MAX,
  maxBytes: FEISHU_INBOUND_CHECKPOINT_PLAINTEXT_MAX_BYTES,
};

export function pruneFeishuInboundState(
  snapshot: FeishuInboundStateSnapshot,
  now: number,
  {
    receiptTtlMs = FEISHU_INBOUND_RECEIPTS_TTL_MS,
    maxReceipts = FEISHU_INBOUND_RECEIPTS_MAX,
    maxCursors = FEISHU_INBOUND_CURSORS_MAX,
    maxBytes = FEISHU_INBOUND_STATE_MAX_BYTES,
  }: Partial<FeishuInboundPruneLimits> = {},
): FeishuInboundStateSnapshot {
  const state = { ...createEmptyFeishuInboundState(snapshot.appId), seq: snapshot.seq };
  let bytesLeft = maxBytes - Buffer.byteLength(JSON.stringify(state));
  const take = <T extends StateEntry>(entries: [string, T][], out: Record<string, T>) => {
    for (const [id, entry] of entries) {
      const cost = entryBytes(id, entry);
      if (cost > bytesLeft) continue;
      out[id] = entry;
      bytesLeft -= cost;
    }
  };
  const cursors = Object.entries(snapshot.cursors)
    .sort(([ak, a], [bk, b]) => compareCursor(b, a) || compareText(ak, bk)).slice(0, maxCursors);
  const receipts = Object.entries(snapshot.receipts)
    .filter(([, receipt]) => now - receiptAgeAnchor(receipt) <= receiptTtlMs)
    .sort(([ak, a], [bk, b]) => receiptAgeAnchor(b) - receiptAgeAnchor(a) || compareText(ak, bk)).slice(0, maxReceipts);
  take(cursors, state.cursors);
  take(receipts, state.receipts);
  return state;
}

function mergeEntries<T>(a: Record<string, T>, b: Record<string, T>, compare: (first: T, second: T) => number): Record<string, T> {
  const result = { ...a };
  for (const [id, incoming] of Object.entries(b)) {
    const existing = a[id];
    if (existing === undefined || compare(incoming, existing) > 0) result[id] = incoming;
  }
  return result;
}

export function mergeFeishuInboundState(
  local: FeishuInboundStateSnapshot,
  remote: FeishuInboundStateSnapshot,
  now: number,
  limits?: Partial<FeishuInboundPruneLimits>,
): FeishuInboundStateSnapshot {
  if (local.appId !== remote.appId) return local;
  return pruneFeishuInboundState({
    ...local,
    seq: Math.max(local.seq, remote.seq),
    cursors: mergeEntries(local.cursors, remote.cursors, compareCursor),
    receipts: mergeEntries(local.receipts, remote.receipts, compareReceipt),
  }, now, limits);
}

export function deriveFeishuCheckpointKey({ accountId, appId, appSecret }: FeishuCheckpointCryptoKeyInput): Buffer {
  return Buffer.from(hkdfSync("sha256", appSecret, `fusa-feishu-checkpoint-v1:${accountId}:${appId}`, "feishu-inbound-checkpoint-aes-256-gcm", 32));
}

function encodeAad({ accountId, leaseName, epoch, seq }: FeishuCheckpointAad): Buffer {
  return Buffer.from([accountId, leaseName, epoch, seq].join("\n"));
}

const checkpointEnvelope = /^v1\.([\w-]{16})\.([\w-]{22,})$/;

export function encryptFeishuCheckpoint(snapshot: FeishuInboundStateSnapshot, key: Buffer, aad: FeishuCheckpointAad): string {
  const plaintext = JSON.stringify(snapshot);
  if (Buffer.byteLength(plaintext) > FEISHU_INBOUND_CHECKPOINT_PLAINTEXT_MAX_BYTES) throw new RangeError("Feishu checkpoint exceeds plaintext limit");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(encodeAad(aad));
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return `v1.${iv.toString("base64url")}.${sealed.toString("base64url")}`;
}

export function decryptFeishuCheckpoint(ciphertext: string, key: Buffer, aad: FeishuCheckpointAad): FeishuInboundStateSnapshot | null {
  if (ciphertext.length > RELAY_LEASE_CHECKPOINT_MAX_BYTES) return null;
  const parts = checkpointEnvelope.exec(ciphertext);
  if (parts === null) return null;
  try {
    const iv = Buffer.from(parts[1]!, "base64url");
    const data = Buffer.from(parts[2]!, "base64url");
    if (data.toString("base64url") !== parts[2] || data.length - 16 > FEISHU_INBOUND_CHECKPOINT_PLAINTEXT_MAX_BYTES) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(encodeAad(aad));
    decipher.setAuthTag(data.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
    return parseFeishuInboundStateSnapshot(JSON.parse(plaintext.toString("utf8")));
  } catch {
    return null;
  }
}

export function readFeishuInboundStateFile(file: string, expectedAppId: FeishuAppId | null, now: number): FeishuInboundStateSnapshot | null {
  try {
    const fd = openSync(file, "r");
    try {
      const { size } = fstatSync(fd);
      if (size > FEISHU_INBOUND_STATE_MAX_BYTES) return null;
      const data = Buffer.alloc(size + 1);
      let offset = 0;
      while (offset < data.length) {
        const read = readSync(fd, data, offset, data.length - offset, null);
        if (read === 0) break;
        offset += read;
      }
      if (offset !== size) return null;
      const state = parseFeishuInboundStateSnapshot(JSON.parse(data.toString("utf8", 0, size)));
      return state !== null && (expectedAppId === null || state.appId === expectedAppId) ? pruneFeishuInboundState(state, now) : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function writeFeishuInboundStateFile(file: string, snapshot: FeishuInboundStateSnapshot): void {
  const text = JSON.stringify(snapshot);
  if (Buffer.byteLength(text) > FEISHU_INBOUND_STATE_MAX_BYTES) throw new RangeError("Feishu inbound state exceeds file limit");
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic.sync(file, text, { mode: FEISHU_INBOUND_STATE_FILE_MODE });
}

type SyncWait = { signal?: AbortSignal; timeoutMs?: number };
type MessageInput = Pick<FeishuInboundReceipt, "messageId" | "chatId" | "messageAt">;
type CursorInput = Pick<FeishuInboundCursorEntry, "lastInboundAt" | "lastMessageId">;
const leaseName = "feishu";

function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const abort = () => resolve(undefined);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

class StateBudget {
  private bytes = 0;
  private cursors = 0;
  private receipts = 0;
  private expireAfter = Infinity;

  constructor(state: FeishuInboundStateSnapshot | null) {
    for (const cursor of Object.values(state?.cursors ?? {})) this.replaceCursor(undefined, cursor);
    for (const receipt of Object.values(state?.receipts ?? {})) this.replaceReceipt(undefined, receipt);
  }

  replaceCursor(previous: FeishuInboundCursorEntry | undefined, next: FeishuInboundCursorEntry) {
    this.bytes += entryBytes(next.chatId, next) - (previous === undefined ? 0 : entryBytes(next.chatId, previous));
    if (previous === undefined) this.cursors++;
  }

  replaceReceipt(previous: FeishuInboundReceipt | undefined, next: FeishuInboundReceipt) {
    this.bytes += entryBytes(next.messageId, next) - (previous === undefined ? 0 : entryBytes(next.messageId, previous));
    if (previous === undefined) this.receipts++;
    this.expireAfter = Math.min(this.expireAfter, receiptAgeAnchor(next) + FEISHU_INBOUND_RECEIPTS_TTL_MS);
  }

  needsPrune(state: FeishuInboundStateSnapshot, now: number) {
    const header = { ...createEmptyFeishuInboundState(state.appId), seq: state.seq };
    return this.cursors > FEISHU_INBOUND_CURSORS_MAX || this.receipts > FEISHU_INBOUND_RECEIPTS_MAX ||
      now > this.expireAfter || this.bytes + Buffer.byteLength(JSON.stringify(header)) > FEISHU_INBOUND_STATE_MAX_BYTES;
  }
}

class InboundSync implements FeishuInboundSync {
  private state: FeishuInboundStateSnapshot | null;
  private budget: StateBudget;
  private active = new WeakSet<FeishuInboundReceipt>();
  private persisted: FeishuInboundStateSnapshot | null;
  private flushPending: ReturnType<typeof setImmediate> | null = null;
  private lifetime = new AbortController();
  private readonly unsupportedPeers = new Map<DeviceId, number>();
  private publishing: Promise<void> | null = null;
  private published: FeishuInboundStateSnapshot | null = null;
  private publishedEpoch: number | null = null;
  private closed = false;
  private readonly now: () => number;

  private readonly opts: FeishuInboundSyncOptions;

  constructor(opts: FeishuInboundSyncOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    const appId = opts.initialAppId === undefined ? opts.appCredentials()?.appId ?? null : opts.initialAppId;
    const stored = opts.stateFile === null ? null : readFeishuInboundStateFile(opts.stateFile, appId, this.now());
    this.state = appId === null ? null : stored ?? createEmptyFeishuInboundState(appId);
    this.budget = new StateBudget(this.state);
    this.persisted = this.state;
    if (stored === null && this.state !== null && opts.legacyCursors !== undefined &&
      opts.stateFile !== null && !existsSync(opts.stateFile)) {
      const cursors = Object.fromEntries(opts.legacyCursors().map((entry) => [entry.chatId, entry]));
      this.replaceState(pruneFeishuInboundState({ ...this.state, cursors, seq: Number(Object.keys(cursors).length > 0) }, this.now()));
      this.persist();
    }
  }

  snapshot() { return this.state; }

  exportForWire() {
    return this.state === null ? null : pruneFeishuInboundState(this.state, this.now(), wireLimits);
  }

  cursorOf(id: FeishuChatId) { return this.state?.cursors[id] ?? null; }

  receiptOf(id: FeishuMessageId) {
    const receipt = this.state?.receipts[id];
    return receipt !== undefined && this.now() - receiptAgeAnchor(receipt) <= FEISHU_INBOUND_RECEIPTS_TTL_MS ? receipt : null;
  }

  private canRetry(receipt: FeishuInboundReceipt) {
    return receipt.phase === "claimed" && receipt.claimedBy === this.opts.selfId && !this.active.has(receipt);
  }

  isAlreadyExecuted(id: FeishuMessageId) {
    const receipt = this.receiptOf(id);
    return receipt !== null && receipt.phase !== "held_offline" && !this.canRetry(receipt);
  }

  retryFrom(chatId: FeishuChatId, sinceMs: number): number | null {
    if (this.state === null) return null;
    let earliest = Infinity;
    const cutoff = this.now() - FEISHU_INBOUND_RECEIPTS_TTL_MS;
    for (const receipt of Object.values(this.state.receipts)) {
      if (receipt.chatId === chatId && receipt.messageAt >= sinceMs && receiptAgeAnchor(receipt) >= cutoff && this.canRetry(receipt)) {
        earliest = Math.min(earliest, receipt.messageAt);
      }
    }
    return Number.isFinite(earliest) ? earliest : null;
  }

  private replaceState(next: FeishuInboundStateSnapshot | null) {
    this.state = next;
    this.budget = new StateBudget(next);
  }

  private persist(state = this.state) {
    if (this.closed || state === this.persisted) return;
    const file = this.opts.stateFile;
    if (file !== null && state !== null) writeFeishuInboundStateFile(file, state);
    this.persisted = state;
  }

  private persistBestEffort() {
    try {
      this.persist();
    } catch (error: unknown) {
      this.logError(error);
    }
  }

  private cancelScheduledFlush() {
    if (this.flushPending === null) return;
    clearImmediate(this.flushPending);
    this.flushPending = null;
  }

  private scheduleFlush() {
    if (this.closed || this.flushPending !== null) return;
    this.flushPending = setImmediate(() => {
      this.flushPending = null;
      void this.flush();
    });
  }

  private update(cursor: FeishuInboundCursorEntry | null, receipt: FeishuInboundReceipt | null) {
    const state = this.state;
    if (this.closed || state === null) return;
    if (cursor !== null) this.budget.replaceCursor(state.cursors[cursor.chatId], cursor);
    if (receipt !== null) this.budget.replaceReceipt(state.receipts[receipt.messageId], receipt);
    const next = {
      ...state,
      seq: state.seq + 1,
      cursors: cursor === null ? state.cursors : { ...state.cursors, [cursor.chatId]: cursor },
      receipts: receipt === null ? state.receipts : { ...state.receipts, [receipt.messageId]: receipt },
    };
    const now = this.now();
    if (this.budget.needsPrune(next, now)) this.replaceState(pruneFeishuInboundState(next, now));
    else this.state = next;
  }

  private cursorEntry(chatId: FeishuChatId, cursor: CursorInput): FeishuInboundCursorEntry | null {
    const current = this.cursorOf(chatId);
    if (current !== null && (cursor.lastInboundAt < current.lastInboundAt ||
      (cursor.lastInboundAt === current.lastInboundAt && (cursor.lastMessageId === null || cursor.lastMessageId === current.lastMessageId)))) return null;
    return { chatId, ...cursor, updatedAt: this.now() };
  }

  seedLocalCursor(chatId: FeishuChatId, cursor: CursorInput) {
    if (this.cursorOf(chatId) === null) this.advanceCursor(chatId, cursor);
  }

  advanceCursor(chatId: FeishuChatId, cursor: CursorInput) {
    const next = this.cursorEntry(chatId, cursor);
    if (next === null) return;
    this.update(next, null);
    this.scheduleFlush();
  }

  private makeReceipt(input: MessageInput, phase: FeishuInboundReceiptPhase): FeishuInboundReceipt {
    return {
      messageId: input.messageId, chatId: input.chatId, messageAt: input.messageAt,
      phase, claimedBy: this.opts.selfId, epoch: this.opts.leaseEpoch() ?? 0, updatedAt: this.now(),
    };
  }

  tryClaim(input: MessageInput & { isOwnerOfChat: boolean }): FeishuInboundClaimDecision {
    const existing = this.receiptOf(input.messageId);
    if (existing !== null) {
      if (this.canRetry(existing)) {
        this.active.add(existing);
        return { kind: "claimed", receipt: existing };
      }
      if (existing.phase !== "held_offline" || !input.isOwnerOfChat) return { kind: "duplicate", existing };
    }
    const receipt = this.makeReceipt(input, "claimed");
    this.update(null, receipt);
    this.active.add(receipt);
    return { kind: "claimed", receipt };
  }

  ownsClaim(receipt: FeishuInboundReceipt) {
    return !this.closed && this.active.has(receipt) && this.receiptOf(receipt.messageId) === receipt;
  }

  releaseClaim(receipt: FeishuInboundReceipt) {
    this.active.delete(receipt);
  }

  markHandled(input: MessageInput & { advanceCursor: boolean }) {
    const previous = this.receiptOf(input.messageId);
    const handled = previous === null ? this.makeReceipt(input, "handled") : { ...previous, phase: "handled" as const, updatedAt: this.now() };
    const cursor = input.advanceCursor ? this.cursorEntry(input.chatId, { lastInboundAt: input.messageAt, lastMessageId: input.messageId }) : null;
    this.update(cursor, handled);
    this.scheduleFlush();
  }

  tryHoldOffline(input: MessageInput): FeishuInboundHoldDecision {
    const existing = this.receiptOf(input.messageId);
    if (existing !== null) return { kind: "duplicate", existing };
    const receipt = this.makeReceipt(input, "held_offline");
    const previous = this.state;
    this.update(null, receipt);
    try {
      this.persist();
    } catch (error: unknown) {
      this.replaceState(previous);
      throw error;
    }
    return { kind: "held", receipt };
  }

  mergeRemote(remote: FeishuInboundStateSnapshot) {
    if (this.closed || this.state === null || remote.appId !== this.state.appId) return false;
    const merged = mergeFeishuInboundState(this.state, remote, this.now());
    if (JSON.stringify(merged) === JSON.stringify(this.state)) {
      this.persist();
      return false;
    }
    const next = { ...merged, seq: Math.max(merged.seq, this.state.seq + 1) };
    this.persist(next);
    this.replaceState(next);
    return true;
  }

  private signal(options: SyncWait, fallbackMs: number) {
    return AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(options.timeoutMs ?? fallbackMs), ...(options.signal === undefined ? [] : [options.signal])]);
  }

  private peers() {
    const now = this.now();
    for (const [id, until] of this.unsupportedPeers) if (until <= now) this.unsupportedPeers.delete(id);
    return [...new Set(this.opts.peers?.onlinePeers() ?? [])]
      .filter((id) => id !== this.opts.selfId && !this.unsupportedPeers.has(id)).slice(0, MESH_MAX_DEVICES_PER_ACCOUNT);
  }

  private notePeerResult(id: DeviceId, kind: string) {
    if (kind !== "unsupported") return;
    if (this.unsupportedPeers.size >= MESH_MAX_DEVICES_PER_ACCOUNT) this.unsupportedPeers.delete(this.unsupportedPeers.keys().next().value!);
    this.unsupportedPeers.set(id, this.now() + FEISHU_INBOUND_PEER_UNSUPPORTED_TTL_MS);
  }

  private async forPeers(signal: AbortSignal, run: (id: DeviceId, port: FeishuInboundPeerPort) => Promise<void>) {
    const port = this.opts.peers;
    if (port === undefined) return;
    const peers = this.peers();
    for (let i = 0; i < peers.length && !signal.aborted; i += FEISHU_INBOUND_PEER_HYDRATE_CONCURRENCY) {
      await Promise.all(peers.slice(i, i + FEISHU_INBOUND_PEER_HYDRATE_CONCURRENCY).map((id) => run(id, port).catch((error: unknown) => this.logError(error))));
    }
  }

  private async pullRelay(signal: AbortSignal): Promise<FeishuInboundStateSnapshot | null> {
    const { relay } = this.opts;
    const accountId = relay?.accountId() ?? null;
    const credentials = this.opts.appCredentials();
    if (relay === undefined || accountId === null || credentials === null) return null;
    const result = await relay.getCheckpoint(leaseName, signal);
    if (signal.aborted || result.kind !== "ok" || result.checkpoint === null) return null;
    const { epoch, seq, ciphertext } = result.checkpoint;
    const key = deriveFeishuCheckpointKey({ accountId, ...credentials });
    return decryptFeishuCheckpoint(ciphertext, key, { accountId, leaseName, epoch, seq });
  }

  async hydrate(options: SyncWait = {}) {
    if (this.closed || this.state === null) return false;
    const signal = this.signal(options, FEISHU_INBOUND_HYDRATE_TIMEOUT_MS);
    let changed = false;
    const merge = (state: FeishuInboundStateSnapshot | null) => {
      if (state !== null && !signal.aborted) changed = this.mergeRemote(state) || changed;
    };
    await untilAbort(Promise.all([
      this.pullRelay(signal).then(merge).catch((error: unknown) => this.logError(error)),
      this.forPeers(signal, async (id, port) => {
        const result = await port.fetchPeerState(id, signal);
        if (signal.aborted) return;
        this.notePeerResult(id, result.kind);
        if (result.kind === "ok") merge(result.state);
      }),
    ]), signal);
    return changed;
  }

  private async pushRelay(wire: FeishuInboundStateSnapshot, epoch: number, signal: AbortSignal): Promise<boolean> {
    const { relay } = this.opts;
    const accountId = relay?.accountId() ?? null;
    const credentials = this.opts.appCredentials();
    if (relay === undefined || accountId === null || credentials?.appId !== wire.appId) return false;
    const key = deriveFeishuCheckpointKey({ accountId, ...credentials });
    const seq = wire.seq;
    const ciphertext = encryptFeishuCheckpoint(wire, key, { accountId, leaseName, epoch, seq });
    const result = await relay.putCheckpoint(leaseName, { epoch, seq, ciphertext }, signal);
    return !signal.aborted && result.kind === "ok" &&
      result.checkpoint.epoch === epoch && result.checkpoint.seq === seq && result.checkpoint.ciphertext === ciphertext;
  }

  private async publish(signal: AbortSignal) {
    while (!signal.aborted) {
      const state = this.state;
      const epoch = this.opts.leaseEpoch();
      if (state === null || state.seq === 0 || (this.published === state && this.publishedEpoch === epoch)) return;
      const wire = pruneFeishuInboundState(state, this.now(), wireLimits);
      let mirrored = false;
      const [stored] = await Promise.all([
        epoch === null || epoch === 0 ? false : this.pushRelay(wire, epoch, signal).catch((error: unknown) => { this.logError(error); return false; }),
        this.forPeers(signal, async (id, port) => {
          const result = await port.pushPeerState(id, wire, signal);
          if (signal.aborted) return;
          this.notePeerResult(id, result.kind);
          if (result.kind === "ok") mirrored = true;
        }),
      ]);
      if (signal.aborted) return;
      if (stored || ((epoch === null || epoch === 0 || this.opts.relay === undefined) && mirrored)) {
        this.published = state;
        this.publishedEpoch = epoch;
      }
      if (this.state === state) return;
    }
  }

  async flush(options: SyncWait = {}) {
    if (this.closed) return;
    this.cancelScheduledFlush();
    this.persistBestEffort();
    const signal = this.signal(options, FEISHU_INBOUND_FLUSH_TIMEOUT_MS);
    if (signal.aborted) return;
    if (this.opts.relay === undefined && this.opts.peers === undefined) return;
    if (this.publishing === null) {
      const lifetime = this.signal({}, FEISHU_INBOUND_FLUSH_TIMEOUT_MS);
      const task = untilAbort(this.publish(lifetime), lifetime).catch((error: unknown) => this.logError(error));
      this.publishing = task.finally(() => {
        if (this.publishing === pending) this.publishing = null;
      });
      const pending = this.publishing;
    }
    await untilAbort(this.publishing, signal);
  }

  async waitForClaimSync(options: SyncWait = {}) {
    this.persist();
    await this.flush({ ...options, timeoutMs: options.timeoutMs ?? FEISHU_INBOUND_CLAIM_SYNC_WAIT_MS });
  }

  resetForApp(appId: FeishuAppId | null) {
    if (this.closed || appId === (this.state?.appId ?? null)) return;
    this.cancelScheduledFlush();
    this.active = new WeakSet();
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.publishing = null;
    this.published = null;
    if (appId === null) {
      if (this.opts.stateFile !== null) rmSync(this.opts.stateFile, { force: true });
      this.replaceState(null);
      this.persisted = null;
    } else {
      const next = createEmptyFeishuInboundState(appId);
      this.persist(next);
      this.replaceState(next);
    }
  }

  async close() {
    this.cancelScheduledFlush();
    this.persistBestEffort();
    this.closed = true;
    this.lifetime.abort();
    await this.publishing;
  }

  private logError(error: unknown) {
    this.opts.log(`飞书：入站检查点同步失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function createFeishuInboundSync(options: FeishuInboundSyncOptions): FeishuInboundSync {
  return new InboundSync(options);
}
