// Single source of truth for account-wide Feishu inbound cursors, receipts, E2EE relay checkpoints, and peer mirrors.
import type { DeviceId } from "../../shared/api.ts";
import type { FeishuAppId, FeishuChatId, FeishuMessageId } from "../../shared/feishu.ts";
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
  appCredentials: () => { appId: FeishuAppId; appSecret: string } | null;
  leaseEpoch: () => number | null;
  relay?: FeishuInboundRelayPort;
  peers?: FeishuInboundPeerPort;
  onCursorAdvanced?: (entry: FeishuInboundCursorEntry) => void;
  now?: () => number;
  log: (line: string) => void;
}

export interface FeishuInboundSync {
  snapshot(): FeishuInboundStateSnapshot | null;
  exportForWire(): FeishuInboundStateSnapshot | null;
  cursorOf(chatId: FeishuChatId): FeishuInboundCursorEntry | null;
  receiptOf(messageId: FeishuMessageId): FeishuInboundReceipt | null;
  hasAccountedReceipt(messageId: FeishuMessageId): boolean;
  isAlreadyExecuted(messageId: FeishuMessageId): boolean;
  seedLocalCursor(chatId: FeishuChatId, cursor: { lastInboundAt: number; lastMessageId: FeishuMessageId | null }): void;
  tryClaim(input: { messageId: FeishuMessageId; chatId: FeishuChatId; messageAt: number; isOwnerOfChat: boolean }): FeishuInboundClaimDecision;
  markHandled(input: { messageId: FeishuMessageId; chatId: FeishuChatId; messageAt: number; advanceCursor: boolean }): void;
  tryHoldOffline(input: { messageId: FeishuMessageId; chatId: FeishuChatId; messageAt: number }): FeishuInboundHoldDecision;
  advanceCursor(chatId: FeishuChatId, cursor: { lastInboundAt: number; lastMessageId: FeishuMessageId | null }): void;
  mergeRemote(remote: FeishuInboundStateSnapshot): boolean;
  hydrate(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<boolean>;
  flush(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  waitForClaimSync(messageId: FeishuMessageId, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  resetForApp(appId: FeishuAppId | null): void;
  close(): Promise<void>;
}

/**
 * Precondition: appId is a validated FeishuAppId.
 * Postcondition: returns an empty version-1 snapshot with seq 0 and empty cursors and receipts maps.
 */
export function createEmptyFeishuInboundState(appId: FeishuAppId): FeishuInboundStateSnapshot {
  void appId;
  throw new Error("Not implemented");
}

/**
 * Precondition: value is an untrusted JSON payload from disk, peer mTLS, or decrypted relay ciphertext.
 * Postcondition: returns a validated FeishuInboundStateSnapshot when every identifier, phase, and bound is valid, or null otherwise.
 */
export function parseFeishuInboundStateSnapshot(value: unknown): FeishuInboundStateSnapshot | null {
  void value;
  throw new Error("Not implemented");
}

/**
 * Precondition: snapshot is a valid state object and now is a non-negative epoch timestamp in milliseconds.
 * Postcondition: returns a copy with expired receipts removed and receipt count, cursor count, and UTF-8 JSON bytes within limits.
 */
export function pruneFeishuInboundState(
  snapshot: FeishuInboundStateSnapshot,
  now: number,
  limits?: Partial<FeishuInboundPruneLimits>,
): FeishuInboundStateSnapshot {
  void snapshot;
  void now;
  void limits;
  throw new Error("Not implemented");
}

/**
 * Precondition: local and remote are valid state snapshots and now is a non-negative epoch timestamp in milliseconds.
 * Postcondition: returns local unchanged when appId differs; otherwise computes the commutative, associative, idempotent join (max cursor timestamp, max receipt phase rank held_offline < claimed < handled) and prunes to limits.
 */
export function mergeFeishuInboundState(
  local: FeishuInboundStateSnapshot,
  remote: FeishuInboundStateSnapshot,
  now: number,
  limits?: Partial<FeishuInboundPruneLimits>,
): FeishuInboundStateSnapshot {
  void local;
  void remote;
  void now;
  void limits;
  throw new Error("Not implemented");
}

/**
 * Precondition: input contains a valid accountId, appId, and non-empty appSecret shared by trusted devices.
 * Postcondition: returns a deterministic 32-byte AES-256-GCM key derived with HKDF-SHA256.
 */
export function deriveFeishuCheckpointKey(input: FeishuCheckpointCryptoKeyInput): Buffer {
  void input;
  throw new Error("Not implemented");
}

/**
 * Precondition: key is a 32-byte Buffer from deriveFeishuCheckpointKey and aad binds accountId, leaseName, epoch, and seq.
 * Postcondition: returns an opaque v1.<iv>.<ciphertextAndTag> ASCII envelope whose UTF-8 byte length fits within RELAY_LEASE_CHECKPOINT_MAX_BYTES.
 */
export function encryptFeishuCheckpoint(snapshot: FeishuInboundStateSnapshot, key: Buffer, aad: FeishuCheckpointAad): string {
  void snapshot;
  void key;
  void aad;
  throw new Error("Not implemented");
}

/**
 * Precondition: ciphertext is an untrusted string returned by the relay and key/aad match the expected credentials and metadata.
 * Postcondition: returns the decrypted and schema-validated snapshot on authentication success, or null on tamper, wrong secret, AAD mismatch, or malformed payload without throwing.
 */
export function decryptFeishuCheckpoint(ciphertext: string, key: Buffer, aad: FeishuCheckpointAad): FeishuInboundStateSnapshot | null {
  void ciphertext;
  void key;
  void aad;
  throw new Error("Not implemented");
}

/**
 * Precondition: file is the local state/feishu-inbound.json path; expectedAppId filters out stale data from a different Feishu app when non-null.
 * Postcondition: returns the parsed and pruned snapshot if present and valid, or null when missing, corrupt, oversized, or belonging to another app without throwing.
 */
export function readFeishuInboundStateFile(
  file: string,
  expectedAppId: FeishuAppId | null,
  now: number,
): FeishuInboundStateSnapshot | null {
  void file;
  void expectedAppId;
  void now;
  throw new Error("Not implemented");
}

/**
 * Precondition: file is the local state/feishu-inbound.json path and snapshot has been pruned within FEISHU_INBOUND_STATE_MAX_BYTES.
 * Postcondition: atomically replaces file with mode FEISHU_INBOUND_STATE_FILE_MODE so concurrent readers never observe partial JSON.
 */
export function writeFeishuInboundStateFile(file: string, snapshot: FeishuInboundStateSnapshot): void {
  void file;
  void snapshot;
  throw new Error("Not implemented");
}

/**
 * Precondition: options provide selfId, credential lookup, lease epoch lookup, and optional relay/peer sync ports.
 * Postcondition: returns a coordinator that synchronously persists pre-execution claims, advances cursors only on handled/explicit cursor updates, merges remote state deterministically, and aborts background work on close().
 */
export function createFeishuInboundSync(options: FeishuInboundSyncOptions): FeishuInboundSync {
  void options;
  throw new Error("Not implemented");
}
