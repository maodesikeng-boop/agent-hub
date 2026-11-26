import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceId } from "../../shared/api.ts";
import type { FeishuAppId, FeishuChatId, FeishuMessageId } from "../../shared/feishu.ts";
import {
  FEISHU_INBOUND_CATCHUP_WINDOW_MS,
  FEISHU_INBOUND_CHECKPOINT_CURSORS_MAX,
  FEISHU_INBOUND_CHECKPOINT_PLAINTEXT_MAX_BYTES,
  FEISHU_INBOUND_CHECKPOINT_RECEIPTS_MAX,
  FEISHU_INBOUND_CURSORS_MAX,
  FEISHU_INBOUND_PEER_UNSUPPORTED_TTL_MS,
  FEISHU_INBOUND_RECEIPTS_MAX,
  FEISHU_INBOUND_RECEIPTS_TTL_MS,
  FEISHU_INBOUND_STATE_MAX_BYTES,
  RELAY_LEASE_CHECKPOINT_MAX_BYTES,
} from "../../shared/limits.ts";
import type { AccountId } from "../../shared/mesh.ts";
import { resolveHubPaths } from "../../shared/paths.ts";
import { findResourceEntry } from "../../shared/resource-registry.ts";
import { VENDOR_LIST } from "../../vendors/registry.ts";
import type { RelayLeaseCheckpointPutRequest, RelayLeaseCheckpointRecord } from "../../relay/protocol.ts";
import { dataDirDenyList } from "../driver/write-scope.ts";
import { createResolveFolder } from "../ledger/files.ts";
import { createLedger, type SqliteLedger } from "../ledger/index.ts";
import type { CenterLease } from "../mesh/lease.ts";
import { openDatabase } from "../store/db.ts";
import { type Db } from "../store/index.ts";
import { migrate } from "../store/migrate.ts";
import { createFeishuAccountBot, createFeishuOfflineInbox, type FeishuAccountBot, type FeishuAccountMeshPort, type FeishuForwardedEvent } from "./account-bot.ts";
import {
  createEmptyFeishuInboundState,
  createFeishuInboundSync,
  decryptFeishuCheckpoint,
  deriveFeishuCheckpointKey,
  encryptFeishuCheckpoint,
  mergeFeishuInboundState,
  parseFeishuInboundStateSnapshot,
  pruneFeishuInboundState,
  readFeishuInboundStateFile,
  writeFeishuInboundStateFile,
  type FeishuInboundPeerFetchResult,
  type FeishuInboundPeerPort,
  type FeishuInboundPeerPushResult,
  type FeishuInboundRelayPort,
  type FeishuInboundStateSnapshot,
} from "./inbound-checkpoint.ts";
import { FEISHU_GROUP_MSG_SCOPE, FEISHU_REQUIRED_SCOPES } from "./scopes.ts";
import { createFeishuService, type FeishuService } from "./service.ts";
import { createFakeFeishu, type FakeFeishu } from "./test-helpers.ts";
import type { FeishuRawMessageEvent } from "./transport.ts";

const ACCOUNT_ID = "github:1001" as AccountId;
const APP_A = "cli_sharedAppA1" as FeishuAppId;
const APP_B = "cli_sharedAppB2" as FeishuAppId;
const SECRET_A = "sec_shared_alpha_123";
const SECRET_B = "sec_shared_beta_456";
const TOKYO = "11111111-1111-4111-8111-111111111111" as DeviceId;
const MAC = "22222222-2222-4222-8222-222222222222" as DeviceId;
const LINUX_C = "33333333-3333-4333-8333-333333333333" as DeviceId;
const OWNER = "ou_owner1";
const GUEST = "ou_guest1";
const ROUTER_CHAT = "oc_p2p" as FeishuChatId;
const PM_CHAT = "oc_pmMac1" as FeishuChatId;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function barrier() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { release = resolve; });
  return { reached, release };
}

function tempDir(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function userMessage(
  id: string,
  text: string,
  at: number,
  overrides: Partial<FeishuRawMessageEvent> = {},
): FeishuRawMessageEvent {
  return {
    type: "im.message.receive_v1",
    messageId: id,
    chatId: ROUTER_CHAT,
    chatType: "p2p",
    senderOpenId: OWNER,
    senderType: "user",
    content: text,
    mentionedBot: false,
    threadId: null,
    resources: [],
    createTime: at,
    ...overrides,
  };
}

interface SharedRelayStub {
  holder: DeviceId | null;
  epoch: number;
  checkpoint: RelayLeaseCheckpointRecord | null;
  unsupported: boolean;
  putCount: number;
  portFor(deviceId: DeviceId): FeishuInboundRelayPort;
}

function createSharedRelayStub(now: () => number): SharedRelayStub {
  const stub: SharedRelayStub = {
    holder: TOKYO,
    epoch: 1,
    checkpoint: null,
    unsupported: false,
    putCount: 0,
    portFor(deviceId: DeviceId): FeishuInboundRelayPort {
      return {
        accountId: () => ACCOUNT_ID,
        async getCheckpoint() {
          if (stub.unsupported) return { kind: "unsupported" };
          return { kind: "ok", checkpoint: stub.checkpoint === null ? null : structuredClone(stub.checkpoint) };
        },
        async putCheckpoint(_name, req: RelayLeaseCheckpointPutRequest) {
          stub.putCount++;
          if (stub.unsupported) return { kind: "unsupported" };
          if (stub.holder !== deviceId || stub.epoch !== req.epoch) {
            return { kind: "stale_epoch", currentEpoch: stub.epoch };
          }
          if (stub.checkpoint !== null && stub.checkpoint.epoch === req.epoch && req.seq <= stub.checkpoint.seq) {
            return { kind: "stale_seq", currentSeq: stub.checkpoint.seq };
          }
          stub.checkpoint = {
            epoch: req.epoch,
            seq: req.seq,
            updatedAt: now(),
            writer: deviceId,
            ciphertext: req.ciphertext,
          };
          return { kind: "ok", checkpoint: structuredClone(stub.checkpoint) };
        },
      };
    },
  };
  return stub;
}

interface HubNode {
  deviceId: DeviceId;
  name: string;
  root: string;
  db: Db;
  ledger: SqliteLedger;
  service: FeishuService;
  bot: FeishuAccountBot;
  fake: FakeFeishu;
  submitted: { clientId: string; text: string }[];
  submitDelay: (() => Promise<void>) | null;
  lease: CenterLease;
  setLease(holding: boolean, holder: DeviceId | null, epoch: number): void;
  online: boolean;
}

function createHubCluster(clockRef: { now: number }, relay: SharedRelayStub) {
  const sharedFeishu: FakeFeishu = createFakeFeishu({ clock: () => clockRef.now });
  sharedFeishu.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
  const nodes = new Map<DeviceId, HubNode>();
  const onlineListeners = new Map<DeviceId, Set<(id: DeviceId) => void>>();

  const makeNode = async (deviceId: DeviceId, name: string, initialHolding: boolean, initialEpoch: number): Promise<HubNode> => {
    const root = tempDir(`feishu-hub-${name.toLowerCase()}-`);
    const dataHome = join(root, ".agent-hub");
    mkdirSync(join(dataHome, "state"), { recursive: true });
    const db = openDatabase(join(root, "hub.sqlite"));
    migrate(db);
    const ledger = createLedger(db, {
      pmHomeRoot: join(dataHome, "pm-home"),
      dataHome,
      userHome: root,
      osSandboxed: () => true,
      worktreesDir: join(dataHome, "worktrees"),
      resolveFolder: createResolveFolder({ dataHome, userHome: root }),
    });
    const nodeFake = createFakeFeishu({ clock: () => clockRef.now });
    nodeFake.chats = sharedFeishu.chats;
    nodeFake.sent = sharedFeishu.sent;
    nodeFake.history = sharedFeishu.history;
    nodeFake.cards = sharedFeishu.cards;
    nodeFake.granted = sharedFeishu.granted;

    let holding = initialHolding;
    let holder: DeviceId | null = initialHolding ? deviceId : relay.holder;
    let epoch = initialEpoch;
    const leaseListeners = new Set<(h: DeviceId | null) => void>();
    const lease: CenterLease = {
      holding: () => holding,
      holder: () => holder,
      epoch: () => (holding ? epoch : null),
      refresh: () => {},
      onChange: (fn) => {
        leaseListeners.add(fn);
        return () => leaseListeners.delete(fn);
      },
      close: async () => {},
    };
    const submitted: { clientId: string; text: string }[] = [];
    const peerPort: FeishuInboundPeerPort = {
      onlinePeers: () => [...nodes.values()].filter((n) => n.deviceId !== deviceId && n.online).map((n) => n.deviceId),
      async fetchPeerState(peerId): Promise<FeishuInboundPeerFetchResult> {
        const peer = nodes.get(peerId);
        if (peer === undefined || !peer.online) return { kind: "unavailable" };
        return { kind: "ok", state: peer.service.exportInboundState?.() ?? null };
      },
      async pushPeerState(peerId, state): Promise<FeishuInboundPeerPushResult> {
        const peer = nodes.get(peerId);
        if (peer === undefined || !peer.online) return { kind: "unavailable" };
        peer.service.applyInboundState?.(state);
        return { kind: "ok" };
      },
    };
    const nodeRef: { current?: HubNode } = {};
    const service = createFeishuService({
      db,
      ledger,
      router: {
        async submitCommand(input) {
          if (nodeRef.current?.submitDelay !== null && nodeRef.current?.submitDelay !== undefined) {
            await nodeRef.current.submitDelay();
          }
          submitted.push({ clientId: input.clientId, text: input.text });
          return {
            id: submitted.length,
            clientId: input.clientId,
            text: input.text,
            status: "answered",
            reply: `ok:${input.text}`,
            error: null,
            plan: null,
            createdAt: clockRef.now,
            updatedAt: clockRef.now,
          } as never;
        },
      },
      secretsFile: join(dataHome, "state", "feishu-secrets.json"),
      inboundStateFile: join(dataHome, "state", "feishu-inbound.json"),
      inboundRelay: relay.portFor(deviceId),
      inboundPeers: peerPort,
      uploadsDir: join(dataHome, "uploads"),
      sentFilesDir: join(dataHome, "sent-files"),
      device: { id: deviceId, name },
      lease,
      now: () => clockRef.now,
      log: () => {},
      createTransport: () => nodeFake,
    });
    const listeners = new Set<(id: DeviceId) => void>();
    onlineListeners.set(deviceId, listeners);
    const meshPort: FeishuAccountMeshPort = {
      selfId: deviceId,
      deviceName: (id) => nodes.get(id)?.name ?? null,
      isOnline: (id) => nodes.get(id)?.online ?? false,
      async post(id, _path, body) {
        const peer = nodes.get(id);
        if (peer === undefined || !peer.online) throw new Error("peer offline");
        return (await peer.bot.acceptForwarded(body as FeishuForwardedEvent)) ?? {};
      },
      onOnline: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
    const bot = createFeishuAccountBot({
      mesh: meshPort,
      local: service,
      inbox: createFeishuOfflineInbox(db),
      now: () => clockRef.now,
      log: () => {},
    });
    service.useAccountBot(bot);
    await service.start();
    const node: HubNode = {
      deviceId,
      name,
      root,
      db,
      ledger,
      service,
      bot,
      fake: nodeFake,
      submitted,
      submitDelay: null,
      lease,
      online: true,
      setLease(nextHolding, nextHolder, nextEpoch) {
        holding = nextHolding;
        holder = nextHolder;
        epoch = nextEpoch;
        for (const fn of leaseListeners) fn(nextHolder);
      },
    };
    nodeRef.current = node;
    nodes.set(deviceId, node);
    cleanups.push(async () => {
      bot.close();
      await service.close();
      ledger.close();
      db.close();
    });
    return node;
  };

  const notifyOnline = (cameOnline: DeviceId) => {
    const target = nodes.get(cameOnline);
    if (target !== undefined) target.online = true;
    for (const [id, set] of onlineListeners) {
      if (id !== cameOnline) for (const fn of set) fn(cameOnline);
    }
  };

  const deliverLive = async (node: HubNode, event: FeishuRawMessageEvent) => {
    node.fake.event(event);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await node.service.idle();
  };

  return { fakeFeishu: sharedFeishu, nodes, makeNode, notifyOnline, deliverLive };
}

describe("Feishu inbound state lattice, pruning, E2EE, and persistence", () => {
  it("merges cursors and receipt phases as a commutative, associative, idempotent lattice isolated by appId (S4, S5)", () => {
    const t = 1_764_136_000_000;
    const msg1 = "om_same_ts_1" as FeishuMessageId;
    const msg2 = "om_same_ts_2" as FeishuMessageId;
    const a: FeishuInboundStateSnapshot = {
      ...createEmptyFeishuInboundState(APP_A),
      seq: 2,
      cursors: {
        [ROUTER_CHAT]: { chatId: ROUTER_CHAT, lastInboundAt: t + 1000, lastMessageId: msg1, updatedAt: t + 1000 },
      },
      receipts: {
        [msg1]: { messageId: msg1, chatId: ROUTER_CHAT, messageAt: t + 1000, phase: "held_offline", claimedBy: TOKYO, epoch: 1, updatedAt: t + 1000 },
      },
    };
    const b: FeishuInboundStateSnapshot = {
      ...createEmptyFeishuInboundState(APP_A),
      seq: 4,
      cursors: {
        [ROUTER_CHAT]: { chatId: ROUTER_CHAT, lastInboundAt: t + 2000, lastMessageId: msg2, updatedAt: t + 2000 },
      },
      receipts: {
        [msg1]: { messageId: msg1, chatId: ROUTER_CHAT, messageAt: t + 1000, phase: "claimed", claimedBy: MAC, epoch: 2, updatedAt: t + 1500 },
        [msg2]: { messageId: msg2, chatId: ROUTER_CHAT, messageAt: t + 1000, phase: "handled", claimedBy: MAC, epoch: 2, updatedAt: t + 2000 },
      },
    };
    const c: FeishuInboundStateSnapshot = {
      ...createEmptyFeishuInboundState(APP_A),
      seq: 3,
      cursors: {
        [PM_CHAT]: { chatId: PM_CHAT, lastInboundAt: t + 500, lastMessageId: null, updatedAt: t + 500 },
      },
      receipts: {
        [msg1]: { messageId: msg1, chatId: ROUTER_CHAT, messageAt: t + 1000, phase: "handled", claimedBy: MAC, epoch: 2, updatedAt: t + 2500 },
      },
    };

    const ab = mergeFeishuInboundState(a, b, t + 3000);
    const ba = mergeFeishuInboundState(b, a, t + 3000);
    expect(ab).toEqual(ba);
    expect(ab.seq).toBe(4);
    expect(ab.cursors[ROUTER_CHAT]?.lastInboundAt).toBe(t + 2000);
    expect(ab.receipts[msg1]?.phase).toBe("claimed");
    expect(ab.receipts[msg2]?.phase).toBe("handled");

    const abc = mergeFeishuInboundState(ab, c, t + 3000);
    const a_bc = mergeFeishuInboundState(a, mergeFeishuInboundState(b, c, t + 3000), t + 3000);
    expect(abc).toEqual(a_bc);
    expect(mergeFeishuInboundState(abc, abc, t + 3000)).toEqual(abc);
    expect(abc.receipts[msg1]?.phase).toBe("handled");

    // Different appId must never mix into local state.
    const foreign = createEmptyFeishuInboundState(APP_B);
    foreign.seq = 99;
    expect(mergeFeishuInboundState(abc, foreign, t + 3000)).toEqual(abc);
  });

  it("enforces dual TTL, count, and byte bounds across 30,000 messages and 250 chats over 30 days (S7)", () => {
    const start = 1_760_000_000_000;
    const thirtyDaysMs = 30 * 24 * 60 * 60_000;
    const end = start + thirtyDaysMs;
    const state = createEmptyFeishuInboundState(APP_A);
    for (let c = 0; c < 250; c++) {
      const chatId = `oc_chat${String(c).padStart(4, "0")}` as FeishuChatId;
      const at = start + Math.floor((thirtyDaysMs * c) / 250);
      state.cursors[chatId] = { chatId, lastInboundAt: at, lastMessageId: null, updatedAt: at };
    }
    for (let i = 0; i < 30_000; i++) {
      const messageId = `om_vol_${String(i).padStart(6, "0")}` as FeishuMessageId;
      const chatId = `oc_chat${String(i % 250).padStart(4, "0")}` as FeishuChatId;
      const at = start + Math.floor((thirtyDaysMs * i) / 30_000);
      state.receipts[messageId] = {
        messageId,
        chatId,
        messageAt: at,
        phase: "handled",
        claimedBy: TOKYO,
        epoch: 1,
        updatedAt: at,
      };
    }

    const prunedLocal = pruneFeishuInboundState(state, end);
    const localReceipts = Object.values(prunedLocal.receipts);
    const localCursors = Object.values(prunedLocal.cursors);
    expect(localReceipts.length).toBeLessThanOrEqual(FEISHU_INBOUND_RECEIPTS_MAX);
    expect(localReceipts.length).toBeGreaterThan(0);
    expect(localReceipts.every((r) => end - Math.max(r.updatedAt, r.messageAt) <= FEISHU_INBOUND_RECEIPTS_TTL_MS)).toBe(true);
    expect(localCursors.length).toBeLessThanOrEqual(FEISHU_INBOUND_CURSORS_MAX);
    expect(Buffer.byteLength(JSON.stringify(prunedLocal), "utf8")).toBeLessThanOrEqual(FEISHU_INBOUND_STATE_MAX_BYTES);

    const prunedWire = pruneFeishuInboundState(state, end, {
      receiptTtlMs: FEISHU_INBOUND_RECEIPTS_TTL_MS,
      maxReceipts: FEISHU_INBOUND_CHECKPOINT_RECEIPTS_MAX,
      maxCursors: FEISHU_INBOUND_CHECKPOINT_CURSORS_MAX,
      maxBytes: FEISHU_INBOUND_CHECKPOINT_PLAINTEXT_MAX_BYTES,
    });
    expect(Object.keys(prunedWire.receipts).length).toBeLessThanOrEqual(FEISHU_INBOUND_CHECKPOINT_RECEIPTS_MAX);
    expect(Object.keys(prunedWire.cursors).length).toBeLessThanOrEqual(FEISHU_INBOUND_CHECKPOINT_CURSORS_MAX);
    expect(Buffer.byteLength(JSON.stringify(prunedWire), "utf8")).toBeLessThanOrEqual(FEISHU_INBOUND_CHECKPOINT_PLAINTEXT_MAX_BYTES);

    const key = deriveFeishuCheckpointKey({ accountId: ACCOUNT_ID, appId: APP_A, appSecret: SECRET_A });
    const ciphertext = encryptFeishuCheckpoint(prunedWire, key, { accountId: ACCOUNT_ID, leaseName: "feishu", epoch: 1, seq: 1 });
    expect(Buffer.byteLength(ciphertext, "utf8")).toBeLessThanOrEqual(RELAY_LEASE_CHECKPOINT_MAX_BYTES);
  });

  it("encrypts relay checkpoints blindly with AEAD AAD binding and rejects tamper or rotated secrets (S4, S6)", () => {
    const snap = createEmptyFeishuInboundState(APP_A);
    const secretChat = "oc_secretChat999" as FeishuChatId;
    const secretMsg = "om_secret_msg_999" as FeishuMessageId;
    snap.seq = 3;
    snap.cursors[secretChat] = { chatId: secretChat, lastInboundAt: 10_000, lastMessageId: secretMsg, updatedAt: 10_000 };
    snap.receipts[secretMsg] = {
      messageId: secretMsg,
      chatId: secretChat,
      messageAt: 10_000,
      phase: "handled",
      claimedBy: TOKYO,
      epoch: 2,
      updatedAt: 10_000,
    };
    const keyA = deriveFeishuCheckpointKey({ accountId: ACCOUNT_ID, appId: APP_A, appSecret: SECRET_A });
    const keyB = deriveFeishuCheckpointKey({ accountId: ACCOUNT_ID, appId: APP_A, appSecret: SECRET_B });
    const aad = { accountId: ACCOUNT_ID, leaseName: "feishu" as const, epoch: 2, seq: 3 };
    const ciphertext = encryptFeishuCheckpoint(snap, keyA, aad);

    expect(ciphertext).not.toContain(secretChat);
    expect(ciphertext).not.toContain(secretMsg);
    expect(ciphertext).not.toContain(APP_A);
    expect(decryptFeishuCheckpoint(ciphertext, keyA, aad)).toEqual(snap);
    // Secret rotation, tampered byte, and swapped epoch/seq AAD must fail closed as null.
    expect(decryptFeishuCheckpoint(ciphertext, keyB, aad)).toBeNull();
    const tampered = `${ciphertext.slice(0, -2)}${ciphertext.endsWith("AA") ? "BB" : "AA"}`;
    expect(decryptFeishuCheckpoint(tampered, keyA, aad)).toBeNull();
    expect(decryptFeishuCheckpoint(ciphertext, keyA, { ...aad, epoch: 3 })).toBeNull();
    expect(decryptFeishuCheckpoint(ciphertext, keyA, { ...aad, seq: 4 })).toBeNull();
  });

  it("recovers safely from corrupt or oversized state files and rejects malformed wire snapshots (S8)", () => {
    const dir = tempDir("feishu-inbound-corrupt-");
    const file = join(dir, "feishu-inbound.json");
    const now = 1_764_136_000_000;

    writeFileSync(file, "{ truncated-json", "utf8");
    expect(readFeishuInboundStateFile(file, APP_A, now)).toBeNull();

    writeFileSync(file, JSON.stringify({ version: 99, appId: APP_A, seq: 1, cursors: {}, receipts: {} }), "utf8");
    expect(readFeishuInboundStateFile(file, APP_A, now)).toBeNull();

    writeFileSync(file, " ".repeat(FEISHU_INBOUND_STATE_MAX_BYTES + 128), "utf8");
    expect(readFeishuInboundStateFile(file, APP_A, now)).toBeNull();

    const valid = createEmptyFeishuInboundState(APP_A);
    valid.seq = 5;
    writeFeishuInboundStateFile(file, valid);
    expect(readFeishuInboundStateFile(file, APP_A, now)).toEqual(valid);
    expect(readFeishuInboundStateFile(file, APP_B, now)).toBeNull();

    expect(parseFeishuInboundStateSnapshot({ version: 1, appId: "bad", seq: 1, cursors: {}, receipts: {} })).toBeNull();
    expect(parseFeishuInboundStateSnapshot({ version: 1, appId: APP_A, seq: -1, cursors: {}, receipts: {} })).toBeNull();
  });

  it("resolves feishuInboundFile across macOS, Linux, and Windows and keeps it inside the Worker deny boundary (S10)", () => {
    const mac = resolveHubPaths({}, "/Users/tester", { platform: "darwin" });
    const lin = resolveHubPaths({}, "/home/tester", { platform: "linux" });
    const win = resolveHubPaths({}, "C:\\Users\\tester", { platform: "win32" });
    expect(mac.feishuInboundFile).toBe("/Users/tester/.agent-hub/state/feishu-inbound.json");
    expect(lin.feishuInboundFile).toBe("/home/tester/.agent-hub/state/feishu-inbound.json");
    expect(win.feishuInboundFile).toBe("C:\\Users\\tester\\.agent-hub\\state\\feishu-inbound.json");

    expect(findResourceEntry("data_dir", "feishuInboundFile")).not.toBeNull();
    const homeDir = tempDir("feishu-inbound-scope-");
    const paths = resolveHubPaths({}, homeDir, { home: homeDir });
    const state = createEmptyFeishuInboundState(APP_A);
    writeFeishuInboundStateFile(paths.feishuInboundFile, state);
    const denied = dataDirDenyList({ dataDir: homeDir, readable: [], connectable: [] });
    expect(denied.some((p) => p === paths.stateDir || p === paths.feishuInboundFile)).toBe(true);
  });
});

describe("FeishuInboundSync coordinator degradation, shutdown, and isolation", () => {
  it("degrades cleanly on 404 from legacy relay and legacy peer, and re-probes peers after backoff TTL (S6)", async () => {
    let now = 1_764_136_000_000;
    const dir = tempDir("feishu-sync-compat-");
    const relay = createSharedRelayStub(() => now);
    relay.unsupported = true;

    let peerFetchCalls = 0;
    let peerSupported = false;
    const peerSnap = createEmptyFeishuInboundState(APP_A);
    const msgId = "om_from_upgraded_peer" as FeishuMessageId;
    peerSnap.seq = 2;
    peerSnap.receipts[msgId] = {
      messageId: msgId,
      chatId: ROUTER_CHAT,
      messageAt: now - 1000,
      phase: "handled",
      claimedBy: MAC,
      epoch: 1,
      updatedAt: now - 1000,
    };

    const sync = createFeishuInboundSync({
      selfId: TOKYO,
      stateFile: join(dir, "feishu-inbound.json"),
      appCredentials: () => ({ appId: APP_A, appSecret: SECRET_A }),
      leaseEpoch: () => 1,
      relay: relay.portFor(TOKYO),
      peers: {
        onlinePeers: () => [MAC],
        async fetchPeerState() {
          peerFetchCalls++;
          return peerSupported ? { kind: "ok", state: peerSnap } : { kind: "unsupported" };
        },
        async pushPeerState() {
          return peerSupported ? { kind: "ok" } : { kind: "unsupported" };
        },
      },
      now: () => now,
      log: () => {},
    });
    cleanups.push(() => sync.close());

    await sync.hydrate();
    expect(peerFetchCalls).toBe(1);
    expect(sync.isAlreadyExecuted(msgId)).toBe(false);

    // Within backoff TTL, legacy 404 peer is not hammered again.
    now += 60_000;
    await sync.hydrate();
    expect(peerFetchCalls).toBe(1);

    // After FEISHU_INBOUND_PEER_UNSUPPORTED_TTL_MS, peer upgraded and hydrate picks up its state.
    peerSupported = true;
    now += FEISHU_INBOUND_PEER_UNSUPPORTED_TTL_MS + 1;
    await sync.hydrate();
    expect(peerFetchCalls).toBe(2);
    expect(sync.isAlreadyExecuted(msgId)).toBe(true);
  });

  it("aborts in-flight hydrate and flush cleanly on shutdown without late writes (S3)", async () => {
    const now = 1_764_136_000_000;
    const dir = tempDir("feishu-sync-shutdown-");
    const stateFile = join(dir, "feishu-inbound.json");

    let releaseFetch!: () => void;
    const lateSnap = createEmptyFeishuInboundState(APP_A);
    lateSnap.seq = 10;
    lateSnap.cursors[ROUTER_CHAT] = { chatId: ROUTER_CHAT, lastInboundAt: now, lastMessageId: null, updatedAt: now };

    const sync = createFeishuInboundSync({
      selfId: TOKYO,
      stateFile,
      appCredentials: () => ({ appId: APP_A, appSecret: SECRET_A }),
      leaseEpoch: () => 1,
      peers: {
        onlinePeers: () => [MAC],
        fetchPeerState: () =>
          new Promise<FeishuInboundPeerFetchResult>((resolve) => {
            releaseFetch = () => resolve({ kind: "ok", state: lateSnap });
          }),
        pushPeerState: async () => ({ kind: "ok" }),
      },
      now: () => now,
      log: () => {},
    });

    const hydratePromise = sync.hydrate();
    await sync.close();
    releaseFetch();
    await hydratePromise;
    expect(sync.cursorOf(ROUTER_CHAT)).toBeNull();
    expect(readFeishuInboundStateFile(stateFile, APP_A, now)).toBeNull();
  });

  it("matches receipts by immutable messageId even with identical timestamps and clears on app switch (S4, S5)", () => {
    const now = 1_764_136_000_000;
    const dir = tempDir("feishu-sync-id-");
    let currentApp: FeishuAppId = APP_A;
    const sync = createFeishuInboundSync({
      selfId: TOKYO,
      stateFile: join(dir, "feishu-inbound.json"),
      appCredentials: () => ({ appId: currentApp, appSecret: SECRET_A }),
      leaseEpoch: () => 1,
      now: () => now,
      log: () => {},
    });
    cleanups.push(() => sync.close());

    const m1 = "om_same_ms_1" as FeishuMessageId;
    const m2 = "om_same_ms_2" as FeishuMessageId;
    expect(sync.tryClaim({ messageId: m1, chatId: ROUTER_CHAT, messageAt: now, isOwnerOfChat: true }).kind).toBe("claimed");
    expect(sync.tryClaim({ messageId: m1, chatId: ROUTER_CHAT, messageAt: now, isOwnerOfChat: true }).kind).toBe("duplicate");
    // Same millisecond, distinct messageId must still be accepted.
    expect(sync.tryClaim({ messageId: m2, chatId: ROUTER_CHAT, messageAt: now, isOwnerOfChat: true }).kind).toBe("claimed");

    currentApp = APP_B;
    sync.resetForApp(APP_B);
    expect(sync.isAlreadyExecuted(m1)).toBe(false);
    expect(sync.snapshot()?.appId).toBe(APP_B);
  });

  it("resumes a durable unfinished claim only on its original device", async () => {
    const now = 1_764_136_000_000;
    const stateFile = join(tempDir("feishu-claim-restart-"), "feishu-inbound.json");
    const options = {
      stateFile, initialAppId: APP_A, appCredentials: () => null, leaseEpoch: () => 1, now: () => now, log: () => {},
    };
    const messageId = "om_unfinished" as FeishuMessageId;
    const message = { messageId, chatId: ROUTER_CHAT, messageAt: now, isOwnerOfChat: true };
    const first = createFeishuInboundSync({ ...options, selfId: TOKYO });
    expect(first.tryClaim(message).kind).toBe("claimed");
    await first.waitForClaimSync();
    expect(readFeishuInboundStateFile(stateFile, APP_A, now)?.receipts[messageId]?.phase).toBe("claimed");
    await first.close();

    const peer = createFeishuInboundSync({ ...options, selfId: MAC });
    expect(peer.isAlreadyExecuted(messageId)).toBe(true);
    expect(peer.tryClaim(message).kind).toBe("duplicate");
    await peer.close();

    const restarted = createFeishuInboundSync({ ...options, selfId: TOKYO });
    expect(restarted.isAlreadyExecuted(messageId)).toBe(false);
    expect(restarted.tryClaim(message).kind).toBe("claimed");
    restarted.markHandled({ ...message, advanceCursor: true });
    await restarted.close();

    const finished = createFeishuInboundSync({ ...options, selfId: TOKYO });
    expect(finished.tryClaim(message).kind).toBe("duplicate");
    expect(finished.cursorOf(ROUTER_CHAT)?.lastMessageId).toBe(messageId);
    await finished.close();
  });

  it("writes completed receipts and cursors together at the next durability boundary", async () => {
    const now = 1_764_136_000_000;
    const stateFile = join(tempDir("feishu-coalesced-writes-"), "feishu-inbound.json");
    const sync = createFeishuInboundSync({
      selfId: TOKYO, stateFile, initialAppId: APP_A, appCredentials: () => null, leaseEpoch: () => 1, now: () => now, log: () => {},
    });
    cleanups.push(() => sync.close());
    const first = { messageId: "om_first" as FeishuMessageId, chatId: ROUTER_CHAT, messageAt: now, isOwnerOfChat: true };
    const second = { ...first, messageId: "om_second" as FeishuMessageId };
    sync.tryClaim(first);
    await sync.waitForClaimSync();
    sync.markHandled({ ...first, advanceCursor: true });
    expect(readFeishuInboundStateFile(stateFile, APP_A, now)?.receipts[first.messageId]?.phase).toBe("claimed");
    sync.tryClaim(second);
    await sync.waitForClaimSync();
    const checkpoint = readFeishuInboundStateFile(stateFile, APP_A, now);
    expect(checkpoint?.receipts[first.messageId]?.phase).toBe("handled");
    expect(checkpoint?.cursors[ROUTER_CHAT]?.lastMessageId).toBe(first.messageId);
    expect(checkpoint?.receipts[second.messageId]?.phase).toBe("claimed");
  });
});

describe("Cross-hub Feishu end-to-end deduplication acceptance scenarios", () => {
  async function moveLeaseToMac(relay: SharedRelayStub, tokyo: HubNode, mac: HubNode) {
    relay.holder = MAC;
    relay.epoch = 2;
    tokyo.setLease(false, MAC, 1);
    mac.setLease(true, MAC, 2);
    await mac.service.syncLeaseConnection();
    await mac.service.idle();
  }

  async function bootstrapPair(clockRef: { now: number }, relay: SharedRelayStub) {
    const cluster = createHubCluster(clockRef, relay);
    const tokyo = await cluster.makeNode(TOKYO, "Tokyo", true, 1);
    const mac = await cluster.makeNode(MAC, "MacBook Pro", false, 0);

    await tokyo.service.setup.saveCredentials({ brand: "feishu", appId: APP_A, appSecret: SECRET_A });
    const bind = tokyo.service.setup.issueBindCode();
    await cluster.deliverLive(tokyo, userMessage("om_bind", bind.code, clockRef.now));
    await vi.waitFor(() => expect(tokyo.service.setup.status().ownerOpenId).toBe(OWNER));
    await tokyo.service.idle();

    const exported = tokyo.service.exportPeerApp()!;
    expect(exported.kind).toBe("configured");
    await mac.service.applyPeerApp(exported);
    await mac.service.idle();
    return { cluster, tokyo, mac };
  }

  it("replays neither M1 on takeover nor M2 on bounce-back across two hubs (S1)", async () => {
    const clockRef = { now: 1_764_136_360_000 };
    const relay = createSharedRelayStub(() => clockRef.now);
    const { cluster, tokyo, mac } = await bootstrapPair(clockRef, relay);

    // 1. Tokyo handles M1 while holding epoch 1.
    clockRef.now += 7_000;
    const m1 = userMessage("om_incident_m1", "Check Tokyo status", clockRef.now);
    await cluster.deliverLive(tokyo, m1);
    expect(tokyo.submitted.map((c) => c.clientId)).toEqual(["feishu:om_incident_m1"]);

    // 2. Tokyo stops; Mac takes epoch 2; user sends M2 during handoff.
    clockRef.now += 14_000;
    tokyo.online = false;

    clockRef.now += 3_000;
    const m2 = userMessage("om_incident_m2", "Now run on Mac", clockRef.now);
    cluster.fakeFeishu.recordMessage(m2);

    await moveLeaseToMac(relay, tokyo, mac);

    // Mac must NOT replay M1, and must execute M2 exactly once.
    expect(mac.submitted.map((c) => c.clientId)).toEqual(["feishu:om_incident_m2"]);

    // 3. Tokyo restarts and reclaims epoch 3; Tokyo must NOT replay M2.
    clockRef.now += 8_000;
    mac.setLease(false, TOKYO, 2);
    await mac.service.syncLeaseConnection();

    relay.holder = TOKYO;
    relay.epoch = 3;
    cluster.notifyOnline(TOKYO);
    tokyo.setLease(true, TOKYO, 3);
    await tokyo.service.syncLeaseConnection();
    await tokyo.service.idle();

    expect(tokyo.submitted.map((c) => c.clientId)).toEqual(["feishu:om_incident_m1"]);
  });

  it("handles two consecutive Router DM turns across a hub switch without replaying turn 1 (S2)", async () => {
    const clockRef = { now: 1_764_136_400_000 };
    const relay = createSharedRelayStub(() => clockRef.now);
    const { cluster, tokyo, mac } = await bootstrapPair(clockRef, relay);

    clockRef.now += 2_000;
    await cluster.deliverLive(tokyo, userMessage("om_turn_1", "First turn", clockRef.now));
    expect(tokyo.submitted).toHaveLength(1);

    clockRef.now += 2_000;
    await moveLeaseToMac(relay, tokyo, mac);

    clockRef.now += 2_000;
    await cluster.deliverLive(mac, userMessage("om_turn_2", "Second turn", clockRef.now));

    expect(tokyo.submitted.map((c) => c.clientId)).toEqual(["feishu:om_turn_1"]);
    expect(mac.submitted.map((c) => c.clientId)).toEqual(["feishu:om_turn_2"]);
  });

  it("finishes a claimed Router DM exactly once when the hub changes during claim sync (S3)", async () => {
    const clockRef = { now: 1_764_136_460_000 };
    const relay = createSharedRelayStub(() => clockRef.now);
    const portFor = relay.portFor.bind(relay);
    let writeGate = Promise.resolve();
    relay.portFor = (id) => {
      const port = portFor(id);
      if (id !== TOKYO) return port;
      return { ...port, putCheckpoint: (...args) => writeGate.then(() => port.putCheckpoint(...args)) };
    };
    const { tokyo, mac } = await bootstrapPair(clockRef, relay);
    const checkpointWrite = barrier();
    const claimMirrored = barrier();
    writeGate = checkpointWrite.reached;
    const apply = mac.service.applyInboundState!;
    const spy = vi.spyOn(mac.service, "applyInboundState").mockImplementation((state) => {
      apply(state);
      if (state.receipts.om_lease_flip?.phase === "claimed") claimMirrored.release();
    });
    clockRef.now += 2_000;
    try {
      tokyo.fake.event(userMessage("om_lease_flip", "Message during hub handoff", clockRef.now));
      await claimMirrored.reached;
      expect(tokyo.submitted).toEqual([]);
      const takeover = moveLeaseToMac(relay, tokyo, mac);
      checkpointWrite.release();
      await takeover;
    } finally {
      checkpointWrite.release();
      spy.mockRestore();
    }
    await tokyo.service.syncLeaseConnection();
    await tokyo.service.idle();
    expect([...tokyo.submitted, ...mac.submitted].map((c) => c.clientId)).toEqual(["feishu:om_lease_flip"]);
  });

  it.each(["succeeds", "fails"] as const)("handles a claimed Router DM when the old hub %s after takeover (S3)", async (outcome) => {
    const clockRef = { now: 1_764_136_500_000 };
    const relay = createSharedRelayStub(() => clockRef.now);
    const { cluster, tokyo, mac } = await bootstrapPair(clockRef, relay);

    const started = barrier();
    const finish = barrier();
    const submit = vi.fn(async () => {}).mockImplementationOnce(async () => {
      started.release();
      await finish.reached;
      if (outcome === "fails") throw new Error("injected Router submission failure");
    });
    tokyo.submitDelay = submit;

    clockRef.now += 2_000;
    tokyo.fake.event(userMessage("om_inflight_m1", "Long Router turn", clockRef.now));
    try {
      await started.reached;
      clockRef.now += 2_000;
      cluster.fakeFeishu.recordMessage(userMessage("om_after_inflight_m2", "Follow-up during failover", clockRef.now));
      await moveLeaseToMac(relay, tokyo, mac);
      expect(mac.service.exportInboundState?.()?.receipts.om_inflight_m1?.phase).toBe("claimed");
      expect(mac.submitted.map((c) => c.clientId)).toEqual(["feishu:om_after_inflight_m2"]);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      finish.release();
      await vi.runAllTimersAsync();
      await tokyo.service.idle();
    } finally {
      finish.release();
      vi.useRealTimers();
    }

    expect(tokyo.submitted.map((c) => c.clientId)).toEqual(["feishu:om_inflight_m1"]);
    expect(submit).toHaveBeenCalledTimes(outcome === "fails" ? 2 : 1);
    expect(mac.service.exportInboundState?.()?.receipts.om_inflight_m1?.phase).toBe("handled");
  });

  it("deduplicates non-deliver routes and suppresses false 15-minute gap reminders on takeover (S5)", async () => {
    const clockRef = { now: 1_764_136_600_000 };
    const relay = createSharedRelayStub(() => clockRef.now);
    const { cluster, tokyo, mac } = await bootstrapPair(clockRef, relay);

    // Tokyo handles /settings and keeps handling messages over 20 minutes (> FEISHU_INBOUND_CATCHUP_WINDOW_MS).
    clockRef.now += 1_000;
    await cluster.deliverLive(tokyo, userMessage("om_settings_1", "/settings", clockRef.now));
    const sentAfterSettings = cluster.fakeFeishu.sent.length;

    clockRef.now += FEISHU_INBOUND_CATCHUP_WINDOW_MS + 5 * 60_000;
    await cluster.deliverLive(tokyo, userMessage("om_later_1", "Still alive on Tokyo", clockRef.now));
    clockRef.now += 1_000;
    await cluster.deliverLive(tokyo, userMessage("om_settings_recent", "/settings", clockRef.now));

    // Standby Mac had a 20-minute-old local cursor; takeover must not replay recent /settings or post a false gap reminder.
    clockRef.now += 5_000;
    const sentBeforeTakeover = cluster.fakeFeishu.sent.length;
    await moveLeaseToMac(relay, tokyo, mac);

    const newPosts = cluster.fakeFeishu.sent.slice(sentBeforeTakeover);
    expect(newPosts.some((p) => p.content.includes("离线超过"))).toBe(false);
    expect(newPosts).toEqual([]);
    expect(sentAfterSettings).toBeGreaterThan(0);
    expect(mac.submitted).toEqual([]);
  });

  it("deduplicates PM offline holds across hubs while letting the owning device execute once without false gap reminders (S5)", async () => {
    const clockRef = { now: 1_764_136_900_000 };
    const relay = createSharedRelayStub(() => clockRef.now);
    const { cluster, tokyo, mac } = await bootstrapPair(clockRef, relay);
    const linuxC = await cluster.makeNode(LINUX_C, "LinuxC", false, 0);
    await linuxC.service.applyPeerApp(tokyo.service.exportPeerApp()!);
    await linuxC.service.idle();

    const { pm, conversation } = mac.ledger.createPm({ name: "MacPM", mode: "hands_on", persona: "" });
    const conversationId = conversation.id;
    cluster.fakeFeishu.chats.set(PM_CHAT, {
      chatId: PM_CHAT,
      name: "MacPM",
      description: `fusa:${MAC}:pm:${pm.id}`,
      avatar: null,
      members: [
        { member_id: OWNER, name: "Owner" },
        { member_id: GUEST, name: "Guest" },
      ],
    });
    mac.bot.learnChats(MAC, [{ chatId: PM_CHAT, pmId: pm.id }]);
    tokyo.bot.learnChats(MAC, [{ chatId: PM_CHAT, pmId: pm.id }]);
    linuxC.bot.learnChats(MAC, [{ chatId: PM_CHAT, pmId: pm.id }]);
    mac.db.run(
      "INSERT INTO feishu_chats (chat_id, target, pm_id, name, label, created_at, updated_at) VALUES (?, 'pm', ?, 'MacPM', 'MacPM', ?, ?)",
      PM_CHAT,
      pm.id,
      clockRef.now,
      clockRef.now,
    );
    mac.db.run(
      "INSERT INTO feishu_inbound_cursors (chat_id, last_inbound_at, last_message_id, updated_at) VALUES (?, ?, NULL, ?)",
      PM_CHAT,
      clockRef.now,
      clockRef.now,
    );

    // Mac goes offline; Tokyo receives M_off and holds it in offline inbox.
    mac.online = false;
    clockRef.now += 2_000;
    const mOff = userMessage("om_pm_offline_1", "Run tests on Mac", clockRef.now, {
      chatId: PM_CHAT,
      chatType: "group",
      mentionedBot: true,
    });
    await cluster.deliverLive(tokyo, mOff);
    await vi.waitFor(() =>
      expect(cluster.fakeFeishu.sent.filter((s) => s.chatId === PM_CHAT && s.content.includes("离线")).length).toBe(1),
    );

    // Hub fails over to LinuxC while Mac is still offline and Feishu redelivers M_off -> zero duplicate offline notice.
    clockRef.now += 3_000;
    tokyo.setLease(false, LINUX_C, 1);
    await tokyo.service.syncLeaseConnection();
    relay.holder = LINUX_C;
    relay.epoch = 2;
    linuxC.setLease(true, LINUX_C, 2);
    await linuxC.service.syncLeaseConnection();
    await cluster.deliverLive(linuxC, mOff);
    const noticesAfterLinuxC = cluster.fakeFeishu.sent.filter((s) => s.chatId === PM_CHAT && s.content.includes("离线")).length;
    expect(noticesAfterLinuxC).toBe(1);

    // Mac wakes up after >15m, takes hub, and Tokyo also comes back to drain -> zero false gap reminder, PM gets M_off once.
    clockRef.now += FEISHU_INBOUND_CATCHUP_WINDOW_MS + 60_000;
    const beforeWake = cluster.fakeFeishu.sent.length;
    linuxC.setLease(false, MAC, 2);
    await linuxC.service.syncLeaseConnection();
    relay.holder = MAC;
    relay.epoch = 3;
    cluster.notifyOnline(MAC);
    mac.setLease(true, MAC, 3);
    await mac.service.syncLeaseConnection();
    await tokyo.service.idle();
    await mac.service.idle();

    const wakeNotices = cluster.fakeFeishu.sent.slice(beforeWake).filter((s) => s.chatId === PM_CHAT && s.content.includes("离线超过"));
    expect(wakeNotices).toEqual([]);
    const pmMessages = mac.ledger.messagesAfter(conversationId, 0, 20).filter((m) => m.sender === "user");
    expect(pmMessages).toHaveLength(1);
    expect(pmMessages[0]!.text).toContain("Run tests on Mac");
  });

  it("seeds from legacy SQLite feishu_inbound_cursors on upgrade without state/feishu-inbound.json (S8)", async () => {
    const clockRef = { now: 1_764_137_200_000 };
    const relay = createSharedRelayStub(() => clockRef.now);
    const cluster = createHubCluster(clockRef, relay);
    const tokyo = await cluster.makeNode(TOKYO, "Tokyo", true, 1);

    await tokyo.service.setup.saveCredentials({ brand: "feishu", appId: APP_A, appSecret: SECRET_A });
    const bind = tokyo.service.setup.issueBindCode();
    await cluster.deliverLive(tokyo, userMessage("om_legacy_bind", bind.code, clockRef.now));
    await vi.waitFor(() => expect(tokyo.service.setup.status().ownerOpenId).toBe(OWNER));
    await tokyo.service.idle();

    // Remove state/feishu-inbound.json while leaving SQLite feishu_inbound_cursors intact, then verify historical message before cursor is skipped.
    const stateFile = join(tokyo.root, ".agent-hub", "state", "feishu-inbound.json");
    rmSync(stateFile, { force: true });
    const oldAt = clockRef.now - 10_000;
    cluster.fakeFeishu.recordMessage(userMessage("om_before_legacy_cursor", "Historical message", oldAt));

    const seeded = readFeishuInboundStateFile(stateFile, APP_A, clockRef.now);
    expect(seeded).toBeNull();
    expect(tokyo.service.exportInboundState?.()?.cursors[ROUTER_CHAT]?.lastInboundAt).toBeGreaterThanOrEqual(clockRef.now);
  });

  it("preserves vendor-neutral delivery across all 8 registered vendors without altering payload text (S9)", async () => {
    expect(VENDOR_LIST.map((v) => v.id)).toEqual(["claude", "agy", "codex", "pi", "deepseek", "cursor", "opencode", "kimi"]);
    const clockRef = { now: 1_764_137_500_000 };
    const relay = createSharedRelayStub(() => clockRef.now);
    const { cluster, tokyo, mac } = await bootstrapPair(clockRef, relay);

    for (const [idx, vendor] of VENDOR_LIST.entries()) {
      clockRef.now += 1_000;
      const msgId = `om_vendor_${vendor.id}_${idx}`;
      await cluster.deliverLive(tokyo, userMessage(msgId, `Prompt for ${vendor.id}`, clockRef.now));
    }
    expect(tokyo.submitted.map((c) => c.text)).toEqual(VENDOR_LIST.map((v) => `Prompt for ${v.id}`));

    // Hand off to Mac: none of the 8 vendor turns may replay.
    clockRef.now += 2_000;
    await moveLeaseToMac(relay, tokyo, mac);
    expect(mac.submitted).toEqual([]);
  });
});
