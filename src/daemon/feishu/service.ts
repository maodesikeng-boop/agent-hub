import type { FeishuChatId } from "../../shared/feishu.ts";
import type { MeshApprovalView } from "../../shared/mesh.ts";
import type { PmId } from "../../shared/domain.ts";
import type { ModelCatalogs } from "../driver/model-catalog.ts";
import type { SqliteLedger } from "../ledger/index.ts";
import type { CenterLease } from "../mesh/lease.ts";
import type { RouterDispatcher } from "../router/dispatcher.ts";
import type { Db } from "../store/index.ts";
import type { FeishuAccountBot, FeishuLocalInbound, FeishuPeerAppSync } from "./account-bot.ts";
import { api, handleError, isChatGone, sendText } from "./api.ts";
import { onRawCardAction } from "./card-actions.ts";
import { feishuChatMarker } from "./chats.ts";
import { exportPeerApp, localPmChats, syncTransport } from "./connection.ts";
import { createFeishuContext, type FeishuContext } from "./context.ts";
import { releaseAllInboundGates } from "./inbound-catchup.ts";
import type { FeishuInboundPeerPort, FeishuInboundRelayPort, FeishuInboundStateSnapshot } from "./inbound-checkpoint.ts";
import { onRawEvent } from "./inbound-dispatch.ts";
import { settleIdle, whenIdle } from "./lanes.ts";
import { scheduleApprovalCardsSync } from "./mesh-approvals.ts";
import { drainBeforeClose, onLedgerChange } from "./replay.ts";
import type { FeishuSdkOptions, registerFeishuApp } from "./sdk.ts";
import { readFeishuSecrets } from "./secrets.ts";
import { applyPeerApp, createSetupService } from "./setup-service.ts";
import type { FeishuSetupService } from "./setup.ts";
import type { FeishuTransport } from "./transport.ts";

export type FeishuLedgerPort = Pick<
  SqliteLedger,
  | "snapshot"
  | "onChange"
  | "getMessage"
  | "getSandboxApproval"
  | "getPersona"
  | "editPersona"
  | "getRouterSettings"
  | "updateRouterSettings"
  | "postUserMessage"
  | "requestStop"
  | "answerAsk"
  | "resolveRouterItem"
  | "decideTaskNode"
  | "recheckUserBlocker"
  | "userBlockerVendor"
  | "messagesAfter"
  | "getRouterItem"
  | "getRouterCommand"
>;

export interface FeishuServiceOptions {
  db: Db;
  ledger: FeishuLedgerPort;
  router: Pick<RouterDispatcher, "submitCommand"> | null;
  models?: Pick<ModelCatalogs, "list"> & Partial<Pick<ModelCatalogs, "current" | "availability">>;
  secretsFile: string;
  inboundStateFile?: string;
  inboundRelay?: FeishuInboundRelayPort;
  inboundPeers?: FeishuInboundPeerPort;
  uploadsDir: string;
  sentFilesDir: string;
  device: { id: string; name: string };
  lease?: CenterLease;
  log: (line: string) => void;
  createTransport?: (options: FeishuSdkOptions) => FeishuTransport;
  register?: typeof registerFeishuApp;
  now?: () => number;
  attachWaitMs?: number;
  mesh?: FeishuServiceMeshHooks;
}

export interface FeishuServiceMeshHooks {
  activeDevices(): number;
  onAppChanged(sync: FeishuPeerAppSync): void;
  onChatsSynced(chats: { chatId: FeishuChatId; pmId: PmId }[]): void;
  approvals(): { approvals: MeshApprovalView[]; joinedIds: ReadonlySet<string> } | null;
  beginApproval(requestId: string): Promise<unknown>;
  answerApproval(requestId: string, match: boolean): Promise<unknown>;
  onChange(listener: () => void): () => void;
}

export interface FeishuService extends FeishuLocalInbound {
  setup: FeishuSetupService;
  useAccountBot(bot: FeishuAccountBot): void;
  eligibleForLease(): boolean;
  syncLeaseConnection(): Promise<void>;
  exportPeerApp(): FeishuPeerAppSync | null;
  applyPeerApp(sync: FeishuPeerAppSync): Promise<void>;
  exportInboundState?(): FeishuInboundStateSnapshot | null;
  applyInboundState?(state: FeishuInboundStateSnapshot): void;
  localPmChats(): { chatId: FeishuChatId; pmId: PmId }[];
  start(): Promise<void>;
  idle(): Promise<void>;
  /** Unsubscribes, drains outbound for up to FEISHU_CLOSE_DRAIN_MS, then disconnects and clears timers and caches; idempotent. */
  close(): Promise<void>;
}

async function chatDescription(ctx: FeishuContext, chatId: FeishuChatId): Promise<string | null> {
  const local = ctx.store.chatById(chatId);
  if (local !== null && local.archivedAt === null) {
    if (local.target.kind === "pm" && local.target.pmId !== null) return feishuChatMarker(ctx.options.device.id, local.target.pmId);
    if (local.target.kind === "router") return "";
  }
  try {
    const data = await api(ctx, "chat.get", { chat_id: chatId });
    return typeof data.description === "string" ? data.description : "";
  } catch (error) {
    if (isChatGone(error)) return null;
    throw error;
  }
}

function subscribe(ctx: FeishuContext) {
  const { life, options } = ctx;
  life.unsubscribe ??= ctx.ledger.onChange((change) => onLedgerChange(ctx, change));
  if (options.lease !== undefined && life.offLease === null) {
    life.offLease = options.lease.onChange(() => {
      void syncTransport(ctx);
    });
  }
  if (options.mesh !== undefined && life.offMesh === null) {
    life.offMesh = options.mesh.onChange(() => {
      scheduleApprovalCardsSync(ctx);
    });
  }
}

async function start(ctx: FeishuContext) {
  subscribe(ctx);
  try {
    ctx.link.secrets = await readFeishuSecrets(ctx.options.secretsFile);
  } catch (error) {
    handleError(ctx, error);
    return;
  }
  const app = ctx.store.app();
  if (ctx.link.secrets === null || app === null || !app.enabled) return;
  ctx.options.lease?.refresh();
  // Do not await the long connection: a slow network or Feishu outage must not delay daemon startup.
  void syncTransport(ctx);
}

function unsubscribeAll(ctx: FeishuContext) {
  const { life } = ctx;
  life.unsubscribe?.();
  life.unsubscribe = null;
  life.offLease?.();
  life.offLease = null;
  life.offMesh?.();
  life.offMesh = null;
  ctx.app.registration?.abort.abort();
  ctx.app.registration = null;
}

function clearQueuesAndCaches(ctx: FeishuContext) {
  for (const timer of ctx.uploads.timers) clearTimeout(timer);
  ctx.uploads.timers.clear();
  ctx.uploads.jobs.clear();
  ctx.uploads.limit.clearQueue();
  for (const queue of [ctx.inbound, ctx.outbound]) {
    for (const lane of queue.lanes.values()) {
      queue.count -= lane.tasks.length;
      lane.tasks.length = 0;
    }
  }
  ctx.control.dirty.clear();
  ctx.catchUp.epoch++;
  ctx.catchUp.targetEpoch = 0;
  releaseAllInboundGates(ctx);
  ctx.catchUp.seen.clear();
  ctx.catchUp.cursorHold.clear();
  ctx.activeTurns.clear();
  ctx.directory.clear();
  ctx.contexts.clearAll();
  ctx.catalogRefresh.pms.clear();
  ctx.catalogRefresh.router = false;
}

// Order matters: stop new work, drain outbound while still connected, then mark closed and tear down the transport.
async function shutdown(ctx: FeishuContext) {
  unsubscribeAll(ctx);
  await drainBeforeClose(ctx);
  ctx.life.closed = true;
  await syncTransport(ctx);
  clearQueuesAndCaches(ctx);
  settleIdle(ctx);
}

export function createFeishuService(options: FeishuServiceOptions): FeishuService {
  const ctx = createFeishuContext(options);
  return {
    setup: createSetupService(ctx),
    useAccountBot(bot) {
      ctx.app.accountBot = bot;
      bot.learnChats(options.device.id, localPmChats(ctx));
    },
    eligibleForLease: () => !ctx.life.closed && ctx.link.secrets !== null && ctx.store.app()?.enabled === true && !ctx.link.authFailed,
    syncLeaseConnection: () => syncTransport(ctx),
    exportPeerApp: () => exportPeerApp(ctx),
    applyPeerApp: (sync) => applyPeerApp(ctx, sync),
    localPmChats: () => localPmChats(ctx),
    handleEvent(raw, queuedAt) {
      onRawEvent(ctx, raw, queuedAt);
    },
    handleCardAction: async (raw) => onRawCardAction(ctx, raw),
    async say(chatId, text) {
      await sendText(ctx, { chatId }, text);
    },
    chatDescription: (chatId) => chatDescription(ctx, chatId),
    start: () => start(ctx),
    idle: () => whenIdle(ctx, true),
    close() {
      ctx.life.closing ??= shutdown(ctx);
      return ctx.life.closing;
    },
  };
}
