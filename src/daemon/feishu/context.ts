import { LRUCache } from "lru-cache";
import pLimit, { type LimitFunction } from "p-limit";
import type { ConversationId, MessageId, PmId } from "../../shared/domain.ts";
import type { FeishuCardId, FeishuChatId, FeishuMessageId, FeishuOpenId } from "../../shared/feishu.ts";
import {
  FEISHU_ATTACH_WAIT_MS,
  FEISHU_CARDKIT_BUDGET_PER_SECOND,
  FEISHU_CHAT_CACHE_MAX,
  FEISHU_INBOUND_QUEUE_MAX,
  FEISHU_MEDIA_QUEUE_MAX,
  FEISHU_OUTBOUND_QUEUE_MAX,
  FEISHU_SEEN_MESSAGES_MAX,
  FEISHU_UPLOAD_CONCURRENCY,
  MESH_MAX_DEVICES_PER_ACCOUNT,
} from "../../shared/limits.ts";
import { feishuCardkitBudgetShare, type FeishuAccountBot } from "./account-bot.ts";
import { createFeishuAvatarCache, type FeishuAvatarCache } from "./avatars.ts";
import { fetchMembers } from "./chat-sync.ts";
import { createFeishuContextWindows, createFeishuDirectory, type FeishuContextWindows, type FeishuDirectory } from "./directory.ts";
import type { FeishuFileService, FeishuOutboundFile, FeishuUploaded } from "./files.ts";
import type { FeishuSdkOptions, registerFeishuApp } from "./sdk.ts";
import type { FeishuSecrets } from "./secrets.ts";
import type { FeishuLedgerPort, FeishuServiceOptions } from "./service.ts";
import { createFeishuStore, type FeishuPostRecord, type FeishuStore } from "./store.ts";
import { createFeishuCardkitBudget, type FeishuCardkitBudget, type FeishuStreamState } from "./stream.ts";
import type { FeishuTransport } from "./transport.ts";

export interface LaneTask {
  key: string | null;
  run: () => Promise<void>;
  mark: MessageId | null;
}

export interface Lane {
  tasks: LaneTask[];
  running: boolean;
}

export interface LaneQueue {
  lanes: Map<FeishuChatId, Lane>;
  count: number;
  limit: number;
  paused: (chatId: FeishuChatId) => boolean;
}

export interface StreamSlot {
  state: FeishuStreamState;
  chatId: FeishuChatId;
  timer: ReturnType<typeof setTimeout> | null;
  timerAt: number | null;
  posted: { cardId: FeishuCardId; messageId: FeishuMessageId; text: string } | null;
}

export interface UploadJob {
  startedAt: number;
  done: Promise<void>;
  result: FeishuUploaded | null | undefined;
  follows: Set<string>;
}

export type AttachmentScope = "pm" | "router";

export interface AttachmentSlot {
  file: FeishuOutboundFile;
  row: FeishuPostRecord | null;
  job: UploadJob | null;
  result: FeishuUploaded | null | undefined;
  sending: boolean;
}

export interface HostCard {
  messageId: FeishuMessageId;
  cardId: FeishuCardId | null;
}

interface ApprovalCard {
  cardId: FeishuCardId;
  messageId: FeishuMessageId;
  sequence: number;
  sas: string | null;
  deviceName: string;
  settled: boolean;
}

interface LinkState {
  transport: FeishuTransport | null;
  transportKey: string | null;
  files: FeishuFileService | null;
  secrets: FeishuSecrets | null;
  wsStarted: boolean;
  wsUp: boolean;
  downSince: number | null;
  authFailed: boolean;
  lastError: string | null;
  disconnectError: string | null;
  missing: string[];
  mentionOnly: boolean;
  scopesChecked: boolean;
  scopesInflight: Promise<void> | null;
}

interface AppState {
  ownerName: string | null;
  registration: { url: string; expiresAt: number; abort: AbortController } | null;
  bindCode: { code: string; expiresAt: number } | null;
  accountBot: FeishuAccountBot | null;
  syncedRouterChatId: FeishuChatId | null;
  lastDisconnectedAt: number | null;
  lastDissolveChats: boolean;
}

interface LifeState {
  closed: boolean;
  closing: Promise<void> | null;
  connectingCount: number;
  transportQueue: Promise<void>;
  unsubscribe: (() => void) | null;
  offLease: (() => void) | null;
  offMesh: (() => void) | null;
  idleWaiters: { resolve: () => void; uploads: boolean }[];
}

interface CatchUpState {
  seen: LRUCache<FeishuMessageId, true>;
  gateEpochs: Map<FeishuChatId, number>;
  cursorHold: Map<FeishuChatId, number>;
  epoch: number;
  targetEpoch: number;
  inflight: Promise<void> | null;
  hadLiveSession: boolean;
}

interface ControlState {
  syncRequested: boolean;
  connectionRequested: boolean;
  dirty: Set<FeishuChatId>;
  active: { connection: boolean; replaying: ReadonlySet<FeishuChatId> } | null;
  retry: ReturnType<typeof setTimeout> | null;
}

interface UploadState {
  jobs: LRUCache<string, UploadJob>;
  limit: LimitFunction;
  timers: Set<ReturnType<typeof setTimeout>>;
  inFlight: number;
}

interface CatalogRefreshState {
  inflight: Promise<void> | null;
  pms: Set<PmId>;
  router: boolean;
}

export interface FeishuContext {
  options: FeishuServiceOptions;
  db: FeishuServiceOptions["db"];
  ledger: FeishuLedgerPort;
  log: (line: string) => void;
  now: () => number;
  store: FeishuStore;
  attachWaitMs: number;
  transportFactory: () => Promise<(options: FeishuSdkOptions) => FeishuTransport>;
  registerFn: () => Promise<typeof registerFeishuApp>;
  directory: FeishuDirectory;
  contexts: FeishuContextWindows;
  avatars: FeishuAvatarCache;
  budget: FeishuCardkitBudget;
  link: LinkState;
  app: AppState;
  life: LifeState;
  catchUp: CatchUpState;
  control: ControlState;
  inbound: LaneQueue;
  outbound: LaneQueue;
  uploads: UploadState;
  streams: Map<ConversationId, StreamSlot>;
  activeTurns: Set<ConversationId>;
  sendTimes: LRUCache<string, number[]>;
  approvalCards: LRUCache<string, ApprovalCard>;
  lastGeneration: LRUCache<PmId, number>;
  catalogRefresh: CatalogRefreshState;
}

export function createFeishuContext(options: FeishuServiceOptions): FeishuContext {
  const now = options.now ?? Date.now;
  const store = createFeishuStore(options.db);
  const catchUp: CatchUpState = {
    seen: new LRUCache({ max: FEISHU_SEEN_MESSAGES_MAX }),
    gateEpochs: new Map(),
    cursorHold: new Map(),
    epoch: 0,
    targetEpoch: 0,
    inflight: null,
    hadLiveSession: false,
  };
  const control: ControlState = { syncRequested: false, connectionRequested: false, dirty: new Set(), active: null, retry: null };
  const ctx: FeishuContext = {
    options,
    db: options.db,
    ledger: options.ledger,
    log: options.log,
    now,
    store,
    attachWaitMs: options.attachWaitMs ?? FEISHU_ATTACH_WAIT_MS,
    // The official SDK adds about 40 MB once loaded, so daemons without Feishu never import it.
    transportFactory: async () => options.createTransport ?? (await import("./sdk.ts")).createFeishuSdkTransport,
    registerFn: async () => options.register ?? (await import("./sdk.ts")).registerFeishuApp,
    directory: createFeishuDirectory(async (chatId) => fetchMembers(ctx, chatId)),
    contexts: createFeishuContextWindows(),
    avatars: createFeishuAvatarCache(store, now),
    budget: createFeishuCardkitBudget(() => feishuCardkitBudgetShare(FEISHU_CARDKIT_BUDGET_PER_SECOND, options.mesh?.activeDevices() ?? 1)),
    link: {
      transport: null,
      transportKey: null,
      files: null,
      secrets: null,
      wsStarted: false,
      wsUp: false,
      downSince: null,
      authFailed: false,
      lastError: null,
      disconnectError: null,
      missing: [],
      mentionOnly: false,
      scopesChecked: false,
      scopesInflight: null,
    },
    app: {
      ownerName: null,
      registration: null,
      bindCode: null,
      accountBot: null,
      syncedRouterChatId: null,
      lastDisconnectedAt: null,
      lastDissolveChats: false,
    },
    life: {
      closed: false,
      closing: null,
      connectingCount: 0,
      transportQueue: Promise.resolve(),
      unsubscribe: null,
      offLease: null,
      offMesh: null,
      idleWaiters: [],
    },
    catchUp,
    control,
    inbound: { lanes: new Map(), count: 0, limit: FEISHU_INBOUND_QUEUE_MAX, paused: (chatId) => catchUp.gateEpochs.has(chatId) },
    outbound: { lanes: new Map(), count: 0, limit: FEISHU_OUTBOUND_QUEUE_MAX, paused: () => control.active !== null },
    uploads: { jobs: new LRUCache({ max: FEISHU_MEDIA_QUEUE_MAX }), limit: pLimit(FEISHU_UPLOAD_CONCURRENCY), timers: new Set(), inFlight: 0 },
    streams: new Map(),
    activeTurns: new Set(),
    sendTimes: new LRUCache({ max: FEISHU_CHAT_CACHE_MAX }),
    approvalCards: new LRUCache({ max: MESH_MAX_DEVICES_PER_ACCOUNT }),
    lastGeneration: new LRUCache({ max: FEISHU_CHAT_CACHE_MAX }),
    catalogRefresh: { inflight: null, pms: new Set(), router: false },
  };
  return ctx;
}

export const isCenter = (ctx: FeishuContext) => ctx.options.lease === undefined || ctx.options.lease.holding();

// The center waits for its WSClient; other devices never open one and send over HTTP right away.
export const isReady = (ctx: FeishuContext) =>
  !ctx.life.closed && ctx.link.transport !== null && !ctx.link.authFailed && (isCenter(ctx) ? ctx.link.wsUp : true);

export const owner = (ctx: FeishuContext): FeishuOpenId | null => ctx.store.app()?.ownerOpenId ?? null;

export const displayOwner = (ctx: FeishuContext) => ctx.app.ownerName ?? "主人";

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
