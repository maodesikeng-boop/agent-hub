// 飞书通道（docs/feishu-design.md）：守护进程里的一层适配器。账本、驱动、任务图不改流程，只在入口和出口各接一处：
// - 入：长连接事件先由 inbound.ts 解析、routing.ts 分流，再调账本原有的接口（postUserMessage、requestStop、answerAsk、
//   decideTaskNode、recheckUserBlocker、resolveRouterItem）或总助的 submitCommand；
// - 出：账本 onChange 的变化由 outbound.ts 投影成意图，再交给 stream.ts、cards.ts、files.ts 经传输层发出去。
// 不变量：
// - 账本是唯一的真相；飞书里点按钮、发消息和网页上一样走账本，账本推变化后两边各自刷新；
// - 长连接回调 3 秒内返回（只解析、入队；卡片点击先回 toast），处理排队，上限 FEISHU_INBOUND_QUEUE_MAX / FEISHU_OUTBOUND_QUEUE_MAX；
// - 飞书消息编号当 clientId（feishu:<message_id>），重推天然幂等；
// - 发到同一个群每秒不超过 FEISHU_CHAT_SENDS_PER_SECOND 条（飞书同一个群里机器人共享 5 QPS）；
// - 同一张拍板卡在项目群和总助单聊各有一份，点哪份都走同一个账本接口；后点的那份账本回 conflict，转成 toast“已经定过了”；
// - 群被别人解散或机器人被移出（chat_gone）时：已归档的记录不动（是我们自己解散的）；项目群记下解散时间，下一次对齐当成取消归档重建
//   （唤醒方式、访客档位沿用，建群 uuid 换新的 generation）；总助单聊删记录，主人下次私聊时认回；
// - 所有发送都在主聊天流里：不传 reply_in_thread，不回复某条消息；
// - 飞书挂了、凭证失效都不影响网页和 agent：这里的错误只记日志和状态，不往账本抛。
import { lookKey, type SlimeLook } from "../../shared/slimes.ts";
import { randomInt, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Change } from "../../shared/api.ts";
import { askOf, userMessageDedupeKey, type ConversationId, type Message, type MessageId, type PmId } from "../../shared/domain.ts";
import {
  feishuDisplayName,
  parseFeishuAppId,
  parseFeishuCardId,
  parseFeishuChatId,
  parseFeishuMessageId,
  parseFeishuOpenId,
  type FeishuBindCodeResponse,
  type FeishuCardId,
  type FeishuChatId,
  type FeishuChatTarget,
  type FeishuChatView,
  type FeishuConnectionState,
  type FeishuImageKey,
  type FeishuMessageId,
  type FeishuOpenId,
  type FeishuStatusView,
} from "../../shared/feishu.ts";
import type { SqliteLedger } from "../ledger/index.ts";
import { ConversationNotFoundError, LedgerRequestError } from "../../shared/ledger.ts";
import {
  FEISHU_BIND_CODE_TTL_MS,
  FEISHU_CARD_ACTION_DEADLINE_MS,
  FEISHU_CARD_MAX_BYTES,
  FEISHU_CARDKIT_BUDGET_PER_SECOND,
  FEISHU_CHAT_CACHE_MAX,
  FEISHU_CHAT_SENDS_PER_SECOND,
  FEISHU_CLOSE_DRAIN_MS,
  FEISHU_CONTROL_RETRY_MS,
  FEISHU_CATCHUP_MAX_MESSAGES,
  FEISHU_ATTACH_WAIT_MS,
  FEISHU_INBOUND_CATCHUP_CONCURRENCY,
  FEISHU_INBOUND_CATCHUP_MAX_MESSAGES,
  FEISHU_INBOUND_CATCHUP_MAX_PAGES,
  FEISHU_INBOUND_CATCHUP_OVERLAP_MS,
  FEISHU_INBOUND_CATCHUP_WINDOW_MS,
  FEISHU_INBOUND_QUEUE_MAX,
  FEISHU_MEDIA_QUEUE_MAX,
  FEISHU_MEDIA_RETRY_MAX,
  FEISHU_MESSAGE_LIST_PAGE_SIZE,
  FEISHU_OUTBOUND_QUEUE_MAX,
  FEISHU_PAGE_SIZE,
  FEISHU_SEEN_MESSAGES_MAX,
  FEISHU_UPLOAD_CONCURRENCY,
  MAX_UPLOAD_BYTES,
  MESH_MAX_DEVICES_PER_ACCOUNT,
} from "../../shared/limits.ts";
import { LRUCache } from "lru-cache";
import pLimit from "p-limit";
import { attachmentsOf, isLedgerWakeup } from "../../shared/attachments.ts";
import type { MeshApprovalView } from "../../shared/mesh.ts";
import type { RouterCommandRecord, RouterItem } from "../../shared/router.ts";
import type { UserBlockerId } from "../../shared/user-blockers.ts";
import { sentFilesOf } from "../../shared/sent-files.ts";
import type { RouterDispatcher } from "../router/dispatcher.ts";
import type { ModelCatalogs } from "../driver/model-catalog.ts";
import type { CenterLease } from "../mesh/lease.ts";
import type { Db } from "../store/index.ts";
import { resolveUpload } from "../uploads.ts";
import { feishuCardkitBudgetShare, type FeishuAccountBot, type FeishuLocalInbound, type FeishuPeerAppSync } from "./account-bot.ts";
import { createFeishuAvatarCache, renderFeishuAvatar, type FeishuAvatarImage } from "./avatars.ts";
import {
  feishuAskOptions,
  feishuCardRefOf,
  feishuCardStateOf,
  renderAskCard,
  renderChatPolicyCard,
  renderMeshApprovalCard,
  renderReplyCard,
  renderRouterAskCard,
  renderRouterItem,
  renderRouterSettingsCard,
  renderTextCard,
  unrenderableReplyText,
  type FeishuAttachmentView,
  type FeishuCardJson,
  type FeishuCardRef,
  type FeishuCardState,
} from "./cards.ts";
import { AGENT_VENDORS, bundledModelCatalog, isAgentVendor, vendorLabel, type AgentVendor, type ModelCatalog } from "../../shared/vendors.ts";
import { desiredFeishuChats, FEISHU_CHAT_MARKER_PATTERN, feishuChatCreateUuid, feishuChatMarker, planFeishuChatSync, type FeishuChatOp } from "./chats.ts";
import { createFeishuContextWindows, createFeishuDirectory, type FeishuMember } from "./directory.ts";
import { createFeishuFileService, planFeishuFile, type FeishuFileService, type FeishuOutboundFile, type FeishuUploaded } from "./files.ts";
import { parseFeishuCardAction, parseFeishuEvent, type FeishuInbound, type FeishuInboundAction } from "./inbound.ts";
import { resolvePmModelEdit, resolveRouterModelEdit, type FeishuPmModelView } from "./model-picker.ts";
import { catchUpIntents, projectFeishuChange, splitFeishuMarkdown, type FeishuOutboundIntent, type FeishuProjectionContext } from "./outbound.ts";
import { GUEST_NO_FILES, routeFeishuAction, routeFeishuMessage, type FeishuActionRoute } from "./routing.ts";
import { checkFeishuScopes, FEISHU_APP_ADDONS, FEISHU_GROUP_MSG_SCOPE, feishuAppPreset } from "./scopes.ts";
import type { FeishuSdkOptions, registerFeishuApp } from "./sdk.ts";
import { readFeishuSecrets, removeFeishuSecrets, writeFeishuSecrets, type FeishuSecrets } from "./secrets.ts";
import { FeishuSetupError, type FeishuSetupService } from "./setup.ts";
import { createFeishuStore, type FeishuChatBinding, type FeishuPostRecord, type FeishuPostRef } from "./store.ts";
import { createFeishuCardkitBudget, stepFeishuStream, type FeishuStreamEffect, type FeishuStreamEvent, type FeishuStreamState } from "./stream.ts";
import {
  FEISHU_CARD_TOO_LARGE_CODE,
  FeishuApiError,
  FeishuAuthError,
  FeishuRegistrationError,
  feishuDataOf,
  isFeishuRejection,
  feishuStringField,
  type FeishuCardActionResponse,
  type FeishuMethod,
  type FeishuMethodArgs,
  type FeishuRawCardAction,
  type FeishuRawEvent,
  type FeishuRawMessageEvent,
  type FeishuTransport,
} from "./transport.ts";

/** 通道用到的账本接口。 */
export type FeishuLedgerPort = Pick<
  SqliteLedger,
  | "snapshot"
  | "onChange"
  | "getMessage"
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
  /** 总助：主人在单聊里的话交给它；没开总助分派引擎时是 null，单聊回“总助没开”。 */
  router: Pick<RouterDispatcher, "submitCommand"> | null;
  /** 模型目录与设备可用性（设置卡选项与提醒卡“已处理”重查共用）；没给时用打包目录。 */
  models?: Pick<ModelCatalogs, "list"> & Partial<Pick<ModelCatalogs, "current" | "availability">>;
  secretsFile: string;
  uploadsDir: string;
  sentFilesDir: string;
  device: { id: string; name: string };
  lease?: CenterLease;
  log: (line: string) => void;
  /** 测试里换成假的传输层和假的扫码。 */
  createTransport?: (options: FeishuSdkOptions) => FeishuTransport;
  register?: typeof registerFeishuApp;
  now?: () => number;
  /** 发卡前等附件的窗口，默认 FEISHU_ATTACH_WAIT_MS；测试里调短。 */
  attachWaitMs?: number;
  mesh?: FeishuServiceMeshHooks;
}

export interface FeishuServiceMeshHooks {
  /** 当前账号里连着飞书的设备数（用于平分 cardkit 预算）；未登录时回 1。 */
  activeDevices(): number;
  /** 本机扫码接入、认主人或断开飞书时推给所有在线可信设备。 */
  onAppChanged(sync: FeishuPeerAppSync): void;
  /** 本机对齐完项目群后广播给在线可信设备。 */
  onChatsSynced(chats: { chatId: FeishuChatId; pmId: PmId }[]): void;
  /** 账号里等批准的设备和已在账号里的设备编号；未登录回 null。 */
  approvals(): { approvals: MeshApprovalView[]; joinedIds: ReadonlySet<string> } | null;
  beginApproval(requestId: string): Promise<unknown>;
  answerApproval(requestId: string, match: boolean): Promise<unknown>;
  onChange(listener: () => void): () => void;
}

export interface FeishuService extends FeishuLocalInbound {
  setup: FeishuSetupService;
  useAccountBot(bot: FeishuAccountBot): void;
  /** 本机是否有可用飞书凭证（供中心租约 eligible 判断）。 */
  eligibleForLease(): boolean;
  /** 租约持有状态变化时同步开启或关闭 WSClient 长连接（关闭完成后 resolve）。 */
  syncLeaseConnection(): Promise<void>;
  /** 导出本机当前飞书凭证或最近一次断开记录，经双向 TLS 发给可信设备。 */
  exportPeerApp(): FeishuPeerAppSync | null;
  /** 收下可信设备推来的飞书凭证或断开通知（幂等，不再次往外广播）。 */
  applyPeerApp(sync: FeishuPeerAppSync): Promise<void>;
  /** 本机当前未归档的项目群列表（供广播给中心缓存归属）。 */
  localPmChats(): { chatId: FeishuChatId; pmId: PmId }[];
  /** 后置：有凭证且没暂停就连长连接、订阅账本变化；没配过只订阅不连。连不上不抛错，状态里写原因。 */
  start(): Promise<void>;
  /** 后置：排着的进出事件和在途的附件上传都处理完（测试用）。 */
  idle(): Promise<void>;
  /** 后置：先退订账本、按 FEISHU_CLOSE_DRAIN_MS 排空出站并收尾还在流式的卡，再关连接、取消扫码、清掉计时器和内存缓存。可以重复调。 */
  close(): Promise<void>;
}

/** 飞书来的消息和总助指令的 clientId 前缀：feishu:<message_id>，飞书重推同一条消息天然幂等。 */
const FEISHU_CLIENT_PREFIX = "feishu:";
/** 解散群时群已经没了（被别人解散、机器人被移出）：不算错。 */
const CHAT_GONE_CODES = new Set([232011, 232006, 232010]);
const isCardJson = (value: unknown): value is FeishuCardJson => typeof value === "object" && value !== null && "schema" in value && value.schema === "2.0";
const ALREADY_DECIDED = "已经定过了";
const STALE_POLICY_CARD = "这张设置卡已换新，在群里发 /群设置 叫出最新的";
const STALE_ROUTER_SETTINGS_CARD = "这张设置卡已换新，发 /设置 叫出最新的";
/** 用户消息还没回完的状态：排着、送达、在处理。 */
const AWAITING_REPLY: ReadonlySet<string> = new Set(["queued", "delivered", "processing"]);
/** 网页上发的话镜像到群里时卡片的标题。 */
const MIRROR_TITLE = "网页上说";
/** 整轮没写正文、状态卡又撤不回时，卡上留的一行。 */
const NO_REPLY_TEXT = "（这一轮没有文字回复）";
/** 飞书里发的文件没收下（超过 MAX_UPLOAD_BYTES、下载失败）时回的一句。 */
const missedFilesText = (names: readonly string[]) =>
  `没收下：${names.map((n) => `「${n}」`).join("、")}（超过 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB 或下载失败），压小一点重发试试。`;
/** 原文只进日志。 */
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function formatOfflineQueuedPrefix(queuedAt: number): string {
  const d = new Date(queuedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `（离线期间 ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} 发的）`;
}

/** 给人看的错误（设置页的 lastError）：不带飞书和网络的原文，原文只进日志。 */
function feishuErrorText(error: unknown): string {
  if (error instanceof FeishuSetupError) return error.message;
  if (error instanceof FeishuAuthError) return `飞书凭证失效（错误码 ${error.code}），请重新扫码或重填 App Secret`;
  if (error instanceof FeishuApiError) return `飞书拒绝了一次请求（错误码 ${error.code}），详情已记进日志`;
  return "连飞书时出了意外的错，详情已记进日志";
}

/** 一条串行的工作线（一个群一条）：保证同一个群里的发送有先后，各群之间并行。 */
interface Lane {
  tasks: LaneTask[];
  running: boolean;
}

interface LaneTask {
  /** 同一个 key 的任务排在队尾时只留最新的一份（流式推送）。 */
  key: string | null;
  run: () => Promise<void>;
  /** 飞书拒收、放弃这一件时把群的水位推到这条消息，重连不再补它。 */
  mark: MessageId | null;
}

/** 一个项目经理对话的流式卡片：状态机现状、计时器、已推上去的正文（abandon 时留着它）。 */
interface StreamSlot {
  state: FeishuStreamState;
  chatId: FeishuChatId;
  timer: ReturnType<typeof setTimeout> | null;
  timerAt: number | null;
  posted: { cardId: FeishuCardId; messageId: FeishuMessageId; text: string } | null;
}

/** 一个附件的上传：开始的时间、结果（undefined 还在传或被断线打断，null 没传上）。 */
interface UploadJob {
  startedAt: number;
  done: Promise<void>;
  result: FeishuUploaded | null | undefined;
  /** 卡已发出、等它传完补发和改卡的目标集合（按 scope:chatId 去重）。 */
  follows: Set<string>;
}

type AttachmentScope = "pm" | "router";

/**
 * 一个附件这一刻的样子：feishu_posts 里的记录（有就以它为准）；没有记录时看上传：job 为 null 是没在传（发卡时算还在传，
 * 重画已发的卡时不画），result 同 UploadJob。
 */
interface AttachmentSlot {
  file: FeishuOutboundFile;
  row: FeishuPostRecord | null;
  job: UploadJob | null;
  result: FeishuUploaded | null | undefined;
  sending: boolean;
}

/** 挂附件的那张卡。 */
interface HostCard {
  messageId: FeishuMessageId;
  cardId: FeishuCardId | null;
}

/** 前置：迁移 0035 已跑。后置：返回的服务还没 start。 */
export function createFeishuService(options: FeishuServiceOptions): FeishuService {
  const { db, ledger, log } = options;
  const now = options.now ?? Date.now;
  const store = createFeishuStore(db);
  // 官方 SDK 加载后多占约 40 MB：没配飞书的守护进程不加载（docs/feishu-design.md「性能」）
  const transportFactory = async () => options.createTransport ?? (await import("./sdk.ts")).createFeishuSdkTransport;
  const registerFn = async () => options.register ?? (await import("./sdk.ts")).registerFeishuApp;

  let transport: FeishuTransport | null = null;
  let transportKey: string | null = null;
  let files: FeishuFileService | null = null;
  let secrets: FeishuSecrets | null = null;
  let wsStarted = false;
  let wsUp = false;
  /** 长连接上次断开的时刻；连上后清空，重连时据此记断了多久。 */
  let downSince: number | null = null;
  let authFailed = false;
  let lastError: string | null = null;
  let disconnectError: string | null = null;
  let missing: string[] = [];
  let mentionOnly = false;
  let ownerName: string | null = null;
  let registration: { url: string; expiresAt: number; abort: AbortController } | null = null;
  let bindCode: { code: string; expiresAt: number } | null = null;
  let unsubscribe: (() => void) | null = null;
  let offLease: (() => void) | null = null;
  let offMesh: (() => void) | null = null;
  let accountBot: FeishuAccountBot | null = null;
  let syncedRouterChatId: FeishuChatId | null = null;
  let lastDisconnectedAt: number | null = null;
  let lastDissolveChats = false;
  let transportQueue: Promise<void> = Promise.resolve();
  let closed = false;
  let closing: Promise<void> | null = null;

  const isCenter = () => options.lease === undefined || options.lease.holding();
  /** 中心要等 WSClient 连上才算出站就绪（断线攒着等重连补发）；非中心不开 WSClient，有 HTTP 传输层即可直发出站和处理转发入站。 */
  const isReady = () => !closed && transport !== null && !authFailed && (isCenter() ? wsUp : true);

  const directory = createFeishuDirectory(async (chatId) => fetchMembers(chatId));
  const contexts = createFeishuContextWindows();
  const avatars = createFeishuAvatarCache(store, now);
  const budget = createFeishuCardkitBudget(() => feishuCardkitBudgetShare(FEISHU_CARDKIT_BUDGET_PER_SECOND, options.mesh?.activeDevices() ?? 1));
  const streams = new Map<ConversationId, StreamSlot>();
  /** 每个群最近几次发消息的时间（同一个群每秒不超过 FEISHU_CHAT_SENDS_PER_SECOND 条）。 */
  const sendTimes = new LRUCache<string, number[]>({ max: FEISHU_CHAT_CACHE_MAX });
  const seenInboundMessages = new LRUCache<FeishuMessageId, true>({ max: FEISHU_SEEN_MESSAGES_MAX });
  const inboundGateEpochs = new Map<FeishuChatId, number>();
  const inboundCursorHold = new Map<FeishuChatId, number>();
  let inboundEpoch = 0;
  let inboundCatchUpTargetEpoch = 0;
  let inboundCatchUpInflight: Promise<void> | null = null;
  let hadLiveSession = false;
  let scopesInflight: Promise<void> | null = null;
  let scopesChecked = false;
  let connectingCount = 0;
  const approvalCards = new LRUCache<
    string,
    { cardId: FeishuCardId; messageId: FeishuMessageId; sequence: number; sas: string | null; deviceName: string; settled: boolean }
  >({ max: MESH_MAX_DEVICES_PER_ACCOUNT });

  // ---- 排队 ----

  const inbound = { lanes: new Map<FeishuChatId, Lane>(), count: 0, limit: FEISHU_INBOUND_QUEUE_MAX, paused: (chatId: FeishuChatId) => inboundGateEpochs.has(chatId) };
  // 建群对齐、补发时出站任务先排着不发（两边会改同一批群和水位），做完再接着发
  const outbound = { lanes: new Map<FeishuChatId, Lane>(), count: 0, limit: FEISHU_OUTBOUND_QUEUE_MAX, paused: (_chatId: FeishuChatId) => control !== null };
  type Queue = typeof outbound;
  // 附件在队列外并发预传（docs/feishu-design.md「交付与附件」）：几 MB 的图片、视频慢慢传，不挡文字卡片、流式推送和改卡；
  // 键是 消息编号:第几个。传完的记进 feishu_posts 后删掉，断线打断的也删掉（重连按 uploading 记录重新传）
  const uploads = new LRUCache<string, UploadJob>({ max: FEISHU_MEDIA_QUEUE_MAX });
  const uploadLimit = pLimit(FEISHU_UPLOAD_CONCURRENCY);
  const uploadTimers = new Set<ReturnType<typeof setTimeout>>();
  let uploadsInFlight = 0;
  const attachWaitMs = options.attachWaitMs ?? FEISHU_ATTACH_WAIT_MS;
  let syncRequested = false;
  let connectionRequested = false;
  /** 要从水位起整段补发的群（出站排不进、发送遇到暂时性错误）：只挡这几个群，别的群照常发。 */
  const dirtyChats = new Set<FeishuChatId>();
  /** 正在做的对齐和补发：connection 时每个群都在补，否则只补 replaying 里的群。 */
  let control: { connection: boolean; replaying: ReadonlySet<FeishuChatId> } | null = null;
  let retryControl: ReturnType<typeof setTimeout> | null = null;
  /** 这一轮还在跑的对话（session.status 推来的）：补发只收尾已经结束的那几轮留下的流式卡。 */
  const activeTurns = new Set<ConversationId>();
  const idleWaiters: { resolve: () => void; uploads: boolean }[] = [];
  const busy = () =>
    connectingCount > 0 ||
    inbound.count > 0 ||
    outbound.count > 0 ||
    control !== null ||
    inboundCatchUpInflight !== null ||
    (wsUp && inboundCatchUpTargetEpoch > 0) ||
    (isReady() && retryControl === null && (syncRequested || connectionRequested || dirtyChats.size > 0));
  const settleIdle = () => {
    for (const waiter of idleWaiters.splice(0)) {
      if (busy() || (waiter.uploads && uploadsInFlight > 0)) idleWaiters.push(waiter);
      else waiter.resolve();
    }
  };
  /** uploads 为 true 时连在途的附件上传一起等（测试用）；停机排空不等上传，没传完的留着 uploading 记录，重启接着传。 */
  const whenIdle = (uploads: boolean) =>
    busy() || (uploads && uploadsInFlight > 0) ? new Promise<void>((resolve) => idleWaiters.push({ resolve, uploads })) : Promise.resolve();

  // 建群对齐和补发不进队列，只记一个“要做”的标记：满载时不会被丢，出站队列排空后合并成一次执行，暂时性错误隔 FEISHU_CONTROL_RETRY_MS 再试
  const requestControl = (kind: "sync" | "connection") => {
    if (kind === "sync") syncRequested = true;
    else connectionRequested = true;
    pumpControl();
  };

  const markDirty = (chatId: FeishuChatId) => {
    dirtyChats.add(chatId);
    pumpControl();
  };

  const scheduleRetry = () => {
    if (!isReady() || closed || retryControl !== null) return;
    retryControl = setTimeout(() => {
      retryControl = null;
      pumpControl();
    }, FEISHU_CONTROL_RETRY_MS);
    retryControl.unref?.();
  };

  const retrySyncLater = () => {
    syncRequested = true;
    scheduleRetry();
  };

  const pumpControl = () => {
    if (closed || !isReady() || control !== null || retryControl !== null || outbound.count > 0) return;
    const connection = connectionRequested;
    const sync = syncRequested || connection;
    const replaying = new Set(dirtyChats);
    if (!sync && replaying.size === 0) return;
    connectionRequested = syncRequested = false;
    dirtyChats.clear();
    control = { connection, replaying };
    void Promise.resolve().then(async () => {
      if (connection) await ensureScopesChecked();
      if (owner() === null) return;
      // 对齐出错不挡补发：补发只管已经建好的群，没对齐完的稍后再对齐
      let syncSettled = true;
      if (sync) {
        try {
          await ensureRouterChat();
          scheduleApprovalCardsSync();
          syncSettled = await syncChats();
        } catch (error) {
          if (error instanceof FeishuAuthError) throw error;
          handleError(error);
          syncSettled = false;
        }
      }
      if (connection || replaying.size > 0) {
        const failed = await catchUp(connection, replaying);
        for (const chatId of failed) dirtyChats.add(chatId);
        if (failed.size > 0) scheduleRetry();
      }
      if (!syncSettled) retrySyncLater();
    }).catch((error: unknown) => {
      handleError(error);
      connectionRequested ||= connection;
      syncRequested ||= sync;
      for (const chatId of replaying) dirtyChats.add(chatId);
      scheduleRetry();
    }).finally(() => {
      control = null;
      for (const [name, lane] of outbound.lanes) startLane(outbound, name, lane);
      pumpControl();
      settleIdle();
    });
  };

  const drain = async (queue: Queue, name: FeishuChatId, lane: Lane) => {
    while (!queue.paused(name)) {
      const task = lane.tasks.shift();
      if (task === undefined) break;
      try {
        if (!closed && isReady()) await task.run();
      } catch (error) {
        handleError(error);
        if (queue === outbound && isFeishuRejection(error)) {
          // 飞书明确拒收（卡片过期、内容不合规）：再发也一样，放弃这一件，后面的照常发
          if (task.mark !== null && store.chatById(name) !== null) store.advanceWatermark(name, { messageId: task.mark }, now());
        } else if (queue === outbound) {
          queue.count -= lane.tasks.length;
          lane.tasks.length = 0;
          dirtyChats.add(name);
          scheduleRetry();
        }
      } finally {
        queue.count--;
      }
    }
    lane.running = false;
    if (lane.tasks.length === 0 && queue.lanes.get(name) === lane) queue.lanes.delete(name);
    else startLane(queue, name, lane);
    pumpControl();
    settleIdle();
  };

  const startLane = (queue: Queue, name: FeishuChatId, lane: Lane) => {
    if (lane.running || lane.tasks.length === 0 || queue.paused(name)) return;
    lane.running = true;
    queueMicrotask(() => { void drain(queue, name, lane); });
  };

  const admit = (queue: Queue, name: FeishuChatId, task: LaneTask, limit = queue.limit): boolean => {
    if (closed || !isReady()) return false;
    let lane = queue.lanes.get(name);
    const last = lane?.tasks.at(-1);
    if (task.key !== null && last?.key === task.key) {
      last.run = task.run;
      return true;
    }
    if (queue.count >= limit) return false;
    if (lane === undefined) {
      lane = { tasks: [], running: false };
      queue.lanes.set(name, lane);
    }
    lane.tasks.push(task);
    queue.count++;
    startLane(queue, name, lane);
    return true;
  };

  const inboundTask = (run: () => Promise<void>): LaneTask => ({ key: null, run, mark: null });

  /** 这个群的出站要不要先等补发：在补的、等着补的群不排新任务，补发从账本读，账本是准的，队列只是加速。 */
  const awaitingReplay = (chatId: FeishuChatId) =>
    connectionRequested || control?.connection === true || dirtyChats.has(chatId) || control?.replaying.has(chatId) === true;

  /** 出站任务排不进（满了，或这个群在等补发）：流式预览直接丢（下一块文字带着全文）；别的记下这个群，之后从账本整段补发。 */
  const enqueue = (chatId: FeishuChatId, run: () => Promise<void>, opts: { key?: string; preview?: boolean; mark?: MessageId } = {}) => {
    const preview = opts.preview === true;
    if (awaitingReplay(chatId)) {
      if (!preview) markDirty(chatId);
      return;
    }
    if (admit(outbound, chatId, { key: opts.key ?? null, run, mark: opts.mark ?? null }) || preview) return;
    if (isReady() && !closed) lastError = "飞书出站队列已满，正在从账本补发";
    markDirty(chatId);
  };

  const handleError = (error: unknown) => {
    if (error instanceof FeishuAuthError) {
      authFailed = true;
      wsUp = false;
      options.lease?.refresh();
      void syncTransport();
    }
    lastError = feishuErrorText(error);
    log(`飞书：${errorText(error)}`);
  };

  /** 飞书明确拒收的这一件（过期、撤回、内容不合规）放弃，记日志；网络、限流这类暂时性错误往外抛，由补发重试。 */
  const unlessRejected = async (run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      if (!isFeishuRejection(error)) throw error;
      handleError(error);
    }
  };

  // ---- 调飞书 ----

  const api = async <M extends FeishuMethod>(method: M, args: FeishuMethodArgs[M]): Promise<Record<string, unknown>> => {
    if (transport === null) throw new Error("飞书没连上");
    return feishuDataOf(method, await transport.call(method, args));
  };

  const waitSendSlot = async (chatId: string) => {
    for (;;) {
      const current = now();
      const times = (sendTimes.get(chatId) ?? []).filter((t) => current - t < 1000);
      const oldest = times[0];
      if (times.length < FEISHU_CHAT_SENDS_PER_SECOND || oldest === undefined) {
        sendTimes.set(chatId, [...times, current]);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, oldest + 1000 - current));
    }
  };

  /** 在主聊天流里发一条（不带 reply_in_thread、不回复某条消息）。to 是群或主人（总助单聊还没有编号时按 open_id 发）。 */
  const sendMessage = async (
    to: { chatId: FeishuChatId } | { openId: FeishuOpenId },
    msgType: FeishuMethodArgs["message.create"]["msg_type"],
    content: unknown,
    uuid: string,
  ): Promise<{ messageId: FeishuMessageId; chatId: FeishuChatId | null }> => {
    const receive = "chatId" in to ? to.chatId : to.openId;
    await waitSendSlot(receive);
    const data = await api("message.create", {
      receive_id_type: "chatId" in to ? "chat_id" : "open_id",
      receive_id: receive,
      msg_type: msgType,
      content: msgType === "interactive" && isCardJson(content) ? serializeCard(content) : JSON.stringify(content),
      uuid: uuid.slice(0, 50),
    });
    const messageId = parseFeishuMessageId(feishuStringField(data, "message_id"));
    if (messageId === null) throw new Error("飞书发消息没回消息编号");
    return { messageId, chatId: parseFeishuChatId(feishuStringField(data, "chat_id")) };
  };

  const serializeCard = (card: FeishuCardJson) => {
    const json = JSON.stringify(card);
    if (Buffer.byteLength(json) > FEISHU_CARD_MAX_BYTES) throw new FeishuApiError("card", FEISHU_CARD_TOO_LARGE_CODE, "飞书卡片超过体积上限");
    return json;
  };

  /** 卡片实体（以后要改的卡）：先建实体再按 card_id 发。 */
  const postCardEntity = async (chatId: FeishuChatId, card: FeishuCardJson, uuid: string) => {
    const data = await api("card.create", { type: "card_json", data: serializeCard(card) });
    const cardId = parseFeishuCardId(feishuStringField(data, "card_id"));
    if (cardId === null) throw new Error("飞书建卡片没回卡片编号");
    const { messageId } = await sendMessage({ chatId }, "interactive", { type: "card", data: { card_id: cardId } }, uuid);
    return { cardId, messageId };
  };

  const updateCard = async (cardId: FeishuCardId, sequence: number, card: FeishuCardJson, uuid: string = randomUUID()) => {
    await api("card.update", { card_id: cardId, card: { type: "card_json", data: serializeCard(card) }, sequence, uuid });
  };

  const sendText = (to: { chatId: FeishuChatId } | { openId: FeishuOpenId }, text: string) => sendMessage(to, "text", { text }, `fusa-t-${randomUUID()}`);

  // ---- 账本这边的查询 ----

  const pmOfConversation = (conversationId: ConversationId): PmId | null =>
    db.get<{ pm_id: number | null }>("SELECT pm_id FROM conversations WHERE id = ? AND kind = 'pm'", conversationId)?.pm_id ?? null;
  const pmNameOf = (pmId: PmId | null): string | undefined =>
    pmId === null ? undefined : db.get<{ name: string }>("SELECT name FROM pms WHERE id = ?", pmId)?.name;
  const conversationOfPm = (pmId: PmId): ConversationId | null =>
    db.get<{ id: number }>("SELECT id FROM conversations WHERE kind = 'pm' AND pm_id = ? ORDER BY id LIMIT 1", pmId)?.id ?? null;
  const latestMessageId = (conversationId: ConversationId): MessageId | null =>
    db.get<{ id: number | null }>("SELECT max(id) AS id FROM messages WHERE conversation_id = ?", conversationId)?.id ?? null;
  const isActivePm = (pmId: PmId) => db.get(
    "SELECT 1 FROM pms WHERE id = ? AND NOT EXISTS (SELECT 1 FROM pm_archives WHERE pm_id = ?)", pmId, pmId,
  ) !== undefined;
  const activeTarget = (chat: FeishuChatBinding | null): FeishuChatTarget | null => {
    if (chat === null || chat.archivedAt !== null) return null;
    if (chat.target.kind === "router") return chat.target;
    const pmId = chat.target.pmId;
    return pmId !== null && isActivePm(pmId) ? { kind: "pm", pmId } : null;
  };
  const liveChatOfPm = (pmId: PmId): FeishuChatBinding | null => {
    const chat = store.chatOfTarget({ kind: "pm", pmId });
    return activeTarget(chat) === null ? null : chat;
  };
  const projection: FeishuProjectionContext = {
    chatOfConversation: (conversationId) => {
      const pmId = pmOfConversation(conversationId);
      return pmId === null ? null : liveChatOfPm(pmId);
    },
    routerChat: () => (isCenter() && store.app()?.ownerOpenId ? store.chatOfTarget({ kind: "router" }) : null),
    pmOfConversation,
    awaitingUser: (conversationId) => {
      // sender != 'agent' 让查询走 messages_conversation_non_agent 部分索引，不用扫过一长串工具调用
      const row = db.get<{ meta: string | null; status: string | null }>(
        "SELECT meta, status FROM messages WHERE conversation_id = ? AND sender != 'agent' AND sender = 'user' ORDER BY id DESC LIMIT 1",
        conversationId,
      );
      if (row === undefined || !AWAITING_REPLY.has(row.status ?? "")) return false;
      return !isLedgerWakeup({ sender: "user", meta: row.meta === null ? null : (JSON.parse(row.meta) as Record<string, unknown>) });
    },
  };

  const owner = () => store.app()?.ownerOpenId ?? null;
  const displayOwner = () => ownerName ?? "主人";

  // ---- 成员 ----

  async function fetchMembers(chatId: FeishuChatId): Promise<FeishuMember[]> {
    const members: FeishuMember[] = [];
    let pageToken: string | undefined;
    do {
      const data = await api("chat.members", { chat_id: chatId, page_size: FEISHU_PAGE_SIZE, ...(pageToken ? { page_token: pageToken } : {}) });
      for (const item of (data.items as { member_id?: string; name?: string }[] | undefined) ?? []) {
        const openId = parseFeishuOpenId(item.member_id);
        if (openId !== null) members.push({ openId, name: item.name ?? "" });
      }
      pageToken = data.has_more === true ? (feishuStringField(data, "page_token") ?? undefined) : undefined;
    } while (pageToken !== undefined);
    const o = owner();
    const me = o === null ? undefined : members.find((m) => m.openId === o);
    if (me !== undefined && me.name !== "") ownerName = feishuDisplayName(me.name);
    return members;
  }

  // ---- 状态 ----

  const connectionState = (): FeishuConnectionState => {
    if (registration !== null) return "registering";
    const app = store.app();
    if (secrets === null || app === null) return "unconfigured";
    if (!app.enabled) return "disabled";
    if (authFailed) return "auth_failed";
    if (!isReady()) return "connecting";
    if (app.ownerOpenId === null) return "awaiting_owner";
    if (missing.length > 0) return "needs_permission";
    return "connected";
  };

  const chatView = (chat: FeishuChatBinding): FeishuChatView | null => {
    if (chat.target.kind === "pm" && chat.target.pmId === null) return null;
    const o = owner();
    const guests = (directory.peekMembers(chat.chatId) ?? []).filter((m) => m.openId !== o).length;
    return {
      chatId: chat.chatId,
      target: chat.target as FeishuChatTarget,
      name: chat.name,
      mode: guests > 0 ? "shared" : "solo",
      triggerMode: chat.triggerMode,
      guestTier: chat.guestTier,
      guestCount: guests,
      archived: chat.archivedAt !== null,
    };
  };

  const status = (): FeishuStatusView => {
    const app = store.app();
    return {
      state: connectionState(),
      brand: app?.brand ?? secrets?.brand ?? null,
      appId: app?.appId ?? null,
      botName: app?.botName ?? null,
      ownerOpenId: app?.ownerOpenId ?? null,
      ownerName: app?.ownerOpenId ? displayOwner() : null,
      registration: registration === null ? null : { url: registration.url, expiresAt: registration.expiresAt },
      missing: [...missing],
      lastError,
      ...(options.lease !== undefined ? { hosting: isCenter() } : {}),
      chats: store.chats().flatMap((c) => (c.target.kind === "router" && !isCenter() ? [] : (chatView(c) ?? []))),
    };
  };

  // ---- 连接 ----

  const ackAllRouterEvents = () => {
    const chat = store.chatOfTarget({ kind: "router" });
    if (chat === null) return;
    const max = db.get<{ id: number | null }>("SELECT max(id) AS id FROM feishu_router_events")?.id;
    if (max !== null && max !== undefined) store.ackRouterEvent(chat.chatId, max, now());
  };

  const localPmChats = (): { chatId: FeishuChatId; pmId: PmId }[] =>
    store.chats().flatMap((c) => (c.target.kind === "pm" && c.target.pmId !== null && c.archivedAt === null ? [{ chatId: c.chatId, pmId: c.target.pmId }] : []));

  const notifyLocalChats = () => {
    const chats = localPmChats();
    accountBot?.learnChats(options.device.id, chats);
    options.mesh?.onChatsSynced(chats);
  };

  const exportPeerApp = (): FeishuPeerAppSync | null => {
    const app = store.app();
    if (secrets !== null && app !== null && app.enabled) {
      return {
        kind: "configured",
        brand: app.brand,
        appId: app.appId,
        appSecret: secrets.appSecret,
        botOpenId: app.botOpenId,
        botName: app.botName,
        ownerOpenId: app.ownerOpenId,
        routerChatId: store.chatOfTarget({ kind: "router" })?.chatId ?? syncedRouterChatId,
        updatedAt: app.updatedAt,
      };
    }
    if (lastDisconnectedAt !== null) {
      return { kind: "disconnected", dissolveChats: lastDissolveChats, updatedAt: lastDisconnectedAt };
    }
    return null;
  };

  const broadcastPeerApp = () => {
    const sync = exportPeerApp();
    if (sync !== null) options.mesh?.onAppChanged(sync);
  };

  const teardownTransport = async () => {
    const old = transport;
    const wasWs = wsStarted;
    transport = null;
    transportKey = null;
    files = null;
    wsStarted = false;
    wsUp = false;
    downSince = null;
    disconnectError = null;
    scopesChecked = false;
    scopesInflight = null;
    approvalCards.clear();
    inboundEpoch++;
    inboundCatchUpTargetEpoch = 0;
    releaseAllInboundGates();
    if (retryControl !== null) clearTimeout(retryControl);
    retryControl = null;
    for (const [id, slot] of streams) dropStream(id, slot);
    if (old !== null && wasWs) await old.stop().catch((error: unknown) => log(`飞书：断开时出错：${errorText(error)}`));
  };

  const checkScopes = async () => {
    const data = await api("application.scopes", {});
    const granted = ((data.scopes as { scope_name?: string; grant_status?: number }[] | undefined) ?? [])
      .filter((s) => s.grant_status === 1 && typeof s.scope_name === "string")
      .map((s) => s.scope_name!);
    const check = checkFeishuScopes(granted);
    missing = check.missing;
    mentionOnly = check.mentionOnly;
    scopesChecked = true;
  };

  const ensureScopesChecked = (): Promise<void> => {
    if (scopesChecked) return Promise.resolve();
    scopesInflight ??= checkScopes().finally(() => {
      scopesInflight = null;
    });
    return scopesInflight;
  };

  const releaseInboundGate = (chatId: FeishuChatId, maxEpoch?: number) => {
    const gateEpoch = inboundGateEpochs.get(chatId);
    if (gateEpoch === undefined) return;
    if (maxEpoch !== undefined && gateEpoch > maxEpoch) return;
    inboundGateEpochs.delete(chatId);
    const lane = inbound.lanes.get(chatId);
    if (lane !== undefined) startLane(inbound, chatId, lane);
  };

  const releaseAllInboundGates = (maxEpoch?: number) => {
    for (const chatId of [...inboundGateEpochs.keys()]) releaseInboundGate(chatId, maxEpoch);
  };

  const isCatchUpStale = (runEpoch: number) => closed || !wsUp || transport === null || inboundEpoch !== runEpoch;

  const noteInboundQueueDrop = (chatId: FeishuChatId, at: number) => {
    const prev = inboundCursorHold.get(chatId);
    inboundCursorHold.set(chatId, prev === undefined ? at : Math.min(prev, at));
  };

  const catchUpInboundChat = async (chat: FeishuChatBinding, includeOverlap: boolean, runEpoch: number) => {
    const app = store.app();
    const target = activeTarget(chat);
    const activeTransport = transport;
    if (app === null || target === null || activeTransport === null || isCatchUpStale(runEpoch)) return;
    if (target.kind === "pm" && mentionOnly) {
      log(`飞书：入站补拉跳过项目群 chatId=${chat.chatId} pmId=${target.pmId} reason=missing_scope:${FEISHU_GROUP_MSG_SCOPE}`);
      return;
    }
    const catchUpNow = now();
    const cursor = store.inboundCursor(chat.chatId);
    if (cursor === null) return;
    if (cursor.lastInboundAt === null) {
      store.saveInboundCursor(chat.chatId, { lastInboundAt: catchUpNow, lastMessageId: null }, catchUpNow);
      return;
    }
    const windowFloorMs = Math.max(cursor.chatCreatedAt, catchUpNow - FEISHU_INBOUND_CATCHUP_WINDOW_MS);
    const anchorMs = includeOverlap ? cursor.lastInboundAt - FEISHU_INBOUND_CATCHUP_OVERLAP_MS : cursor.lastInboundAt;
    const sinceMs = Math.max(windowFloorMs, anchorMs);
    const startSec = Math.max(0, Math.floor(sinceMs / 1000));
    const endSec = Math.max(startSec + 1, Math.ceil(catchUpNow / 1000) + 60);
    const chatType: "p2p" | "group" = target.kind === "router" ? "p2p" : "group";

    const fetched: FeishuRawMessageEvent[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    while (pages < FEISHU_INBOUND_CATCHUP_MAX_PAGES && fetched.length < FEISHU_INBOUND_CATCHUP_MAX_MESSAGES) {
      if (isCatchUpStale(runEpoch)) return;
      const page = await activeTransport.listMessages({
        chatId: chat.chatId,
        chatType,
        botOpenId: app.botOpenId,
        startTimeSec: String(startSec),
        endTimeSec: String(endSec),
        sortType: "ByCreateTimeDesc",
        pageSize: Math.min(FEISHU_MESSAGE_LIST_PAGE_SIZE, FEISHU_INBOUND_CATCHUP_MAX_MESSAGES - fetched.length),
        ...(pageToken !== undefined ? { pageToken } : {}),
      });
      if (isCatchUpStale(runEpoch)) return;
      pages++;
      let reachedBeforeFloor = false;
      for (const raw of page.items) {
        if (raw.createTime < sinceMs) {
          reachedBeforeFloor = true;
          continue;
        }
        fetched.push(raw);
        if (fetched.length >= FEISHU_INBOUND_CATCHUP_MAX_MESSAGES) break;
      }
      if (!page.hasMore || page.pageToken === null || reachedBeforeFloor) break;
      pageToken = page.pageToken;
    }

    fetched.reverse();
    const missedEvents: Extract<FeishuInbound, { kind: "message" }>[] = [];
    for (const raw of fetched) {
      if (!includeOverlap && cursor.lastMessageId !== null && raw.messageId === cursor.lastMessageId) continue;
      const parsed = parseFeishuEvent(raw, app.botOpenId);
      if (parsed === null || parsed.kind !== "message") continue;
      if (seenInboundMessages.has(parsed.messageId)) continue;
      missedEvents.push(parsed);
    }

    if (isCatchUpStale(runEpoch)) return;
    if (missedEvents.length === 0) {
      inboundCursorHold.delete(chat.chatId);
      return;
    }
    const available = Math.max(0, inbound.limit - inbound.count);
    const accepted = missedEvents.slice(0, available);
    const dropped = missedEvents.slice(available);
    if (accepted.length > 0) {
      let lane = inbound.lanes.get(chat.chatId);
      if (lane === undefined) {
        lane = { tasks: [], running: false };
        inbound.lanes.set(chat.chatId, lane);
      }
      lane.tasks.unshift(...accepted.map((ev) => inboundTask(() => handleInbound(ev, null))));
      inbound.count += accepted.length;
      startLane(inbound, chat.chatId, lane);
    }
    if (dropped.length > 0) {
      const firstDropped = dropped[0]!;
      if (firstDropped.at > 0) noteInboundQueueDrop(chat.chatId, firstDropped.at);
      directory.markAllStale();
      lastError = "飞书入站队列已满，请重发未收到回复的消息";
      const targetKind = chat.target.kind === "router" ? "router" : `pm:${chat.target.pmId ?? "none"}`;
      log(
        `飞书：入站补拉队列已满 chatId=${chat.chatId} target=${targetKind} dropped=${dropped.length} queued=${accepted.length} limit=${inbound.limit} firstDroppedId=${firstDropped.messageId}`,
      );
    } else {
      inboundCursorHold.delete(chat.chatId);
    }
  };

  const pumpInboundCatchUp = () => {
    if (closed || !wsUp || inboundCatchUpInflight !== null || inboundCatchUpTargetEpoch === 0) return;
    const runEpoch = inboundCatchUpTargetEpoch;
    inboundCatchUpTargetEpoch = 0;
    const includeOverlap = hadLiveSession;
    inboundCatchUpInflight = (async () => {
      try {
        await ensureScopesChecked();
      } catch (error) {
        if (error instanceof FeishuAuthError) handleError(error);
        else log(`飞书：入站补拉前检查权限出错：${errorText(error)}`);
        return;
      }
      if (isCatchUpStale(runEpoch) || owner() === null || store.app() === null) return;
      const catchUpLimit = pLimit(FEISHU_INBOUND_CATCHUP_CONCURRENCY);
      let abortedByAuth = false;
      await Promise.all(
        store.chats().map((chat) =>
          catchUpLimit(async () => {
            if (isCatchUpStale(runEpoch) || abortedByAuth || activeTarget(chat) === null) {
              releaseInboundGate(chat.chatId, runEpoch);
              return;
            }
            try {
              await catchUpInboundChat(chat, includeOverlap, runEpoch);
            } catch (error) {
              if (error instanceof FeishuAuthError) {
                abortedByAuth = true;
                handleError(error);
                return;
              }
              const code = error instanceof FeishuApiError ? String(error.code) : "network";
              const targetKind = chat.target.kind === "router" ? "router" : `pm:${chat.target.pmId ?? "none"}`;
              log(`飞书：入站补拉跳过会话 chatId=${chat.chatId} target=${targetKind} code=${code} reason=${errorText(error)}`);
            } finally {
              releaseInboundGate(chat.chatId, runEpoch);
            }
          }),
        ),
      );
      if (!isCatchUpStale(runEpoch) && !abortedByAuth) hadLiveSession = true;
    })().finally(() => {
      releaseAllInboundGates(runEpoch);
      inboundCatchUpInflight = null;
      if (inboundCatchUpTargetEpoch > 0 && wsUp && !closed) pumpInboundCatchUp();
      settleIdle();
    });
  };

  const onConnected = () => {
    const epoch = ++inboundEpoch;
    if (downSince !== null) {
      hadLiveSession = true;
      log(`飞书：长连接已重连，断了 ${Math.round((now() - downSince) / 1000)} 秒`);
      if (disconnectError !== null && lastError === disconnectError) lastError = null;
    }
    downSince = null;
    disconnectError = null;
    wsUp = true;
    scopesChecked = false;
    directory.markAllStale();
    if (retryControl !== null) clearTimeout(retryControl);
    retryControl = null;
    const existingActive = store.chats().filter((c) => activeTarget(c) !== null);
    if (existingActive.length > 0) {
      for (const chat of existingActive) inboundGateEpochs.set(chat.chatId, epoch);
      inboundCatchUpTargetEpoch = epoch;
      pumpInboundCatchUp();
    } else {
      inboundCatchUpTargetEpoch = 0;
      hadLiveSession = true;
    }
    requestControl("connection");
  };

  const doSyncTransport = async () => {
    connectingCount++;
    try {
      const app = store.app();
      const active = !closed && secrets !== null && app !== null && app.enabled && !authFailed;
      if (!active) {
        await teardownTransport();
        return;
      }
      const currentSecrets = secrets!;
      const key = `${currentSecrets.brand}\n${currentSecrets.appId}\n${currentSecrets.appSecret}`;
      let createdHttp = false;
      if (transport === null || transportKey !== key) {
        await teardownTransport();
        const t = (await transportFactory())({
          brand: currentSecrets.brand,
          appId: currentSecrets.appId,
          appSecret: currentSecrets.appSecret,
          log: (line) => log(`飞书：${line}`),
        });
        transport = t;
        transportKey = key;
        files = createFeishuFileService({ transport: t, uploadsDir: options.uploadsDir, log: (line) => log(`飞书：${line}`) });
        createdHttp = true;
      }
      const wantWs = isCenter();
      if (wantWs && !wsStarted) {
        wsStarted = true;
        try {
          await transport!.start({
            onEvent: (raw) => {
              if (accountBot !== null) accountBot.onEvent(raw);
              else onRawEvent(raw, null);
            },
            onCardAction: (raw) => (accountBot !== null ? accountBot.onCardAction(raw) : onRawCardAction(raw)),
            onConnected,
            onDisconnected: (reason) => {
              if (downSince === null) {
                downSince = now();
                log(`飞书：长连接断了：${reason}`);
              }
              wsUp = false;
              lastError = disconnectError = reason;
              inboundEpoch++;
              inboundCatchUpTargetEpoch = 0;
              releaseAllInboundGates();
              contexts.clearAll();
            },
          });
        } catch (error) {
          wsStarted = false;
          handleError(error);
        }
      } else if (!wantWs && wsStarted) {
        wsStarted = false;
        wsUp = false;
        downSince = null;
        disconnectError = null;
        scopesChecked = false;
        approvalCards.clear();
        inboundEpoch++;
        inboundCatchUpTargetEpoch = 0;
        releaseAllInboundGates();
        ackAllRouterEvents();
        await transport!.stop().catch((error: unknown) => log(`飞书：断开时出错：${errorText(error)}`));
        pumpControl();
      } else if (!wantWs && createdHttp) {
        directory.markAllStale();
        requestControl("connection");
      }
    } finally {
      connectingCount--;
      settleIdle();
    }
  };

  const syncTransport = (): Promise<void> => {
    transportQueue = transportQueue.then(doSyncTransport, doSyncTransport);
    return transportQueue;
  };

  /** 凭证验过才算：换得到 tenant_access_token、拿得到机器人信息。 */
  const verify = async (s: FeishuSecrets): Promise<{ botOpenId: FeishuOpenId; botName: string }> => {
    const t = (await transportFactory())({ brand: s.brand, appId: s.appId, appSecret: s.appSecret, log: (line) => log(`飞书：${line}`) });
    try {
      const data = feishuDataOf("bot.info", await t.call("bot.info", {}));
      const bot = (data.bot ?? {}) as { open_id?: string; app_name?: string };
      const botOpenId = parseFeishuOpenId(bot.open_id);
      if (botOpenId === null) throw new FeishuSetupError("飞书没回机器人信息：应用要先开启机器人能力");
      return { botOpenId, botName: bot.app_name ?? "" };
    } catch (error) {
      if (error instanceof FeishuSetupError) throw error;
      log(`飞书：验凭证没过：${errorText(error)}`);
      throw new FeishuSetupError("凭证不对或应用不可用：核对 App ID 和 App Secret，确认应用已开启机器人能力");
    }
  };

  const connectWith = async (s: FeishuSecrets, ownerOpenId: FeishuOpenId | null) => {
    connectingCount++;
    try {
      const appId = parseFeishuAppId(s.appId);
      if (appId === null) throw new FeishuSetupError("App ID 要以 cli_ 开头");
      const bot = await verify(s);
      await writeFeishuSecrets(options.secretsFile, s);
      secrets = s;
      lastDisconnectedAt = null;
      const before = store.app();
      if (before !== null && before.appId !== appId) {
        directory.clear();
        contexts.clearAll();
        seenInboundMessages.clear();
        inboundCursorHold.clear();
        hadLiveSession = false;
        syncedRouterChatId = null;
      }
      store.saveApp({ appId, brand: s.brand, botOpenId: bot.botOpenId, botName: bot.botName, ownerOpenId }, now());
      store.setEnabled(true, now());
      lastError = null;
      authFailed = false;
      options.lease?.refresh();
      await syncTransport();
      broadcastPeerApp();
    } finally {
      connectingCount--;
      settleIdle();
    }
  };

  // ---- 建群、对齐 ----

  const uploadAvatar = async (look: SlimeLook): Promise<FeishuImageKey> => {
    if (transport === null) throw new Error("飞书没连上");
    const { png } = await renderFeishuAvatar(look);
    const { imageKey } = await transport.uploadImage({ imageType: "avatar", data: png });
    return imageKey as FeishuImageKey;
  };

  const markedChats = async (): Promise<Map<FeishuChatId, string>> => {
    const marked = new Map<FeishuChatId, string>();
    let pageToken: string | undefined;
    do {
      const data = await api("chat.list", { page_size: FEISHU_PAGE_SIZE, ...(pageToken ? { page_token: pageToken } : {}) });
      for (const item of (data.items as { chat_id?: string; description?: string }[] | undefined) ?? []) {
        const chatId = parseFeishuChatId(item.chat_id);
        const mark = FEISHU_CHAT_MARKER_PATTERN.exec(item.description ?? "")?.[0];
        if (chatId !== null && mark !== undefined) marked.set(chatId, mark);
      }
      pageToken = data.has_more === true ? (feishuStringField(data, "page_token") ?? undefined) : undefined;
    } while (pageToken !== undefined);
    return marked;
  };

  const isChatGone = (error: unknown) => error instanceof FeishuApiError && CHAT_GONE_CODES.has(error.code);

  /** 解散群；群已经没了不算错。 */
  const deleteChat = async (chatId: FeishuChatId) => {
    try {
      await api("chat.delete", { chat_id: chatId });
    } catch (error) {
      if (!isChatGone(error)) throw error;
    }
    clearChatRuntime(chatId);
  };

  /**
   * 改已有群的群名、头像。群已经没了返回 false。
   * 飞书拒收（比如群主不让机器人改群信息）记日志、当作改过了，不然每次对齐都再撞一次。
   */
  const updateChat = async (args: FeishuMethodArgs["chat.update"]): Promise<boolean> => {
    try {
      await api("chat.update", args);
    } catch (error) {
      if (isChatGone(error)) return false;
      if (!isFeishuRejection(error)) throw error;
      handleError(error);
    }
    return true;
  };

  /** 每个项目经理上次建群用的 generation：解散时间要比它大，同一毫秒里连着解散两次也不会撞上同一个建群 uuid。 */
  const lastGeneration = new LRUCache<PmId, number>({ max: FEISHU_CHAT_CACHE_MAX });
  const dissolvedAt = (pmId: PmId | null) => Math.max(now(), (pmId === null ? 0 : (lastGeneration.get(pmId) ?? 0)) + 1);

  /** avatarOf：这一次对齐里各形象的群头像（画好的 PNG 和它的哈希）。返回 false：这一步没落地，稍后再对齐。 */
  const applyChatOp = async (op: FeishuChatOp, appId: string, ownerId: FeishuOpenId, avatarOf: (look: SlimeLook) => Promise<FeishuAvatarImage>): Promise<boolean> => {
    const imageKeyOf = async (look: SlimeLook) => avatars.imageKeyOf(look, (await avatarOf(look)).sha256, uploadAvatar);
    switch (op.kind) {
      case "create": {
        const avatar = await imageKeyOf(op.spec.look);
        const data = await api("chat.create", {
          uuid: feishuChatCreateUuid(appId, options.device.id, op.spec.pmId, op.generation),
          name: op.spec.name,
          description: op.spec.description,
          avatar,
          owner_id: ownerId,
          user_id_list: [ownerId],
          chat_type: "private",
          group_message_type: "chat",
          set_bot_manager: true,
          edit_permission: "only_owner",
        });
        const chatId = parseFeishuChatId(feishuStringField(data, "chat_id"));
        if (chatId === null) throw new Error("飞书建群没回群编号");
        lastGeneration.set(op.spec.pmId, op.generation);
        const t = now();
        store.upsertChat({ chatId, target: { kind: "pm", pmId: op.spec.pmId }, name: op.spec.name, label: op.spec.label }, t);
        store.setChatAvatar(chatId, op.spec.look, t);
        store.saveInboundCursor(chatId, { lastInboundAt: t, lastMessageId: null }, t);
        // 新群只从现在往后投影，不把历史消息倒进来
        const conversationId = conversationOfPm(op.spec.pmId);
        store.advanceWatermark(chatId, { messageId: (conversationId === null ? null : latestMessageId(conversationId)) ?? 0 }, t);
        return true;
      }
      case "adopt": {
        const avatar = await imageKeyOf(op.spec.look);
        // 要认回的群刚没了：下一次对齐列群时就没有它了，改成新建
        if (!(await updateChat({ chat_id: op.chatId, name: op.spec.name, avatar }))) return false;
        const t = now();
        store.upsertChat({ chatId: op.chatId, target: { kind: "pm", pmId: op.spec.pmId }, name: op.spec.name, label: op.spec.label }, t);
        store.setChatAvatar(op.chatId, op.spec.look, t);
        store.saveInboundCursor(op.chatId, { lastInboundAt: t, lastMessageId: null }, t);
        const conversationId = conversationOfPm(op.spec.pmId);
        store.advanceWatermark(op.chatId, { messageId: (conversationId === null ? null : latestMessageId(conversationId)) ?? 0 }, t);
        return true;
      }
      // 群在离线期间被解散、机器人被移出：按收到解散事件处理，记成已解散，下一次对齐重建
      case "rename":
        if (await updateChat({ chat_id: op.chatId, name: op.name })) store.renameChat(op.chatId, op.name, op.label, now());
        else applyChatGone(op.chatId);
        return true;
      case "set_avatar":
        if (await updateChat({ chat_id: op.chatId, avatar: await imageKeyOf(op.look) })) store.setChatAvatar(op.chatId, op.look, now());
        else applyChatGone(op.chatId);
        return true;
      case "dissolve": {
        const chat = store.chatById(op.chatId);
        await deleteChat(op.chatId);
        store.setChatArchived(op.chatId, dissolvedAt(chat?.target.kind === "pm" ? chat.target.pmId : null), now());
        return true;
      }
      case "retire":
        if (!op.dissolved) await deleteChat(op.chatId);
        store.removeChat(op.chatId);
        return true;
    }
  };

  /**
   * 按账本对齐项目群。一个群出错不影响别的群：飞书拒收的那一步放弃（等下一次对齐），暂时性错误返回 false，稍后整体再对齐一次。
   */
  const syncChats = async (): Promise<boolean> => {
    const app = store.app();
    if (app === null || app.ownerOpenId === null) return true;
    if (transport === null || !isReady()) return false;
    const pms = ledger.snapshot().pms;
    const desired = desiredFeishuChats(pms, options.device);
    // 每次对齐按形象现画头像算哈希（avatars.ts 记着画过的，同一个形象只画一次）。画出来的图换了（feishu_avatars 里记的不是这张图）：
    // 把头像是这个形象的群改回“没设过”，下面照常出 set_avatar 原地换；中途断了，没换完的群还是“没设过”，下一次对齐接着换
    const looks = new Map(desired.filter((d) => !d.archived).map((d) => [lookKey(d.look), d.look] as const));
    for (const look of looks.values()) {
      if (store.avatarKey(look, (await renderFeishuAvatar(look)).sha256) === null) store.clearChatAvatars(look, now());
    }
    const bindings = store.chats().filter((c) => c.target.kind === "pm");
    const bound = new Set(bindings.flatMap((b) => (b.target.kind === "pm" && b.target.pmId !== null ? [b.target.pmId] : [])));
    const needsLookup = desired.some((d) => !d.archived && !bound.has(d.pmId));
    const marked = needsLookup ? await markedChats() : new Map<FeishuChatId, string>();
    let settled = true;
    for (const op of planFeishuChatSync(desired, bindings, marked, options.device.id)) {
      try {
        if (!(await applyChatOp(op, app.appId, app.ownerOpenId, renderFeishuAvatar))) settled = false;
      } catch (error) {
        if (error instanceof FeishuAuthError) throw error;
        handleError(error);
        if (!isFeishuRejection(error)) settled = false;
      }
    }
    notifyLocalChats();
    return settled;
  };

  const ensureRouterChat = async () => {
    if (!isCenter()) return;
    const o = owner();
    if (o === null || store.chatOfTarget({ kind: "router" }) !== null) return;
    if (syncedRouterChatId !== null) {
      const t = now();
      store.upsertChat({ chatId: syncedRouterChatId, target: { kind: "router" }, name: "总助", label: "总助" }, t);
      store.saveInboundCursor(syncedRouterChatId, { lastInboundAt: t, lastMessageId: null }, t);
      ackAllRouterEvents();
      return;
    }
    const sent = await sendMessage({ openId: o }, "text", { text: "已接上飞书。在这里和总助说话；每个项目经理有自己的项目群。" }, `fusa-hello-${store.app()!.appId}`);
    if (sent.chatId !== null) {
      const t = now();
      store.upsertChat({ chatId: sent.chatId, target: { kind: "router" }, name: "总助", label: "总助" }, t);
      store.saveInboundCursor(sent.chatId, { lastInboundAt: t, lastMessageId: null }, t);
      broadcastPeerApp();
    }
  };

  const syncApprovalCards = async () => {
    if (!isCenter() || !isReady() || options.mesh === undefined) return;
    const routerChat = projection.routerChat();
    if (routerChat === null) return;
    const snap = options.mesh.approvals();
    if (snap === null) return;
    for (const approval of snap.approvals) {
      if (!isCenter() || !isReady()) return;
      const tracked = approvalCards.get(approval.requestId);
      if (tracked === undefined || tracked.settled) {
        const posted = await postCardEntity(
          routerChat.chatId,
          renderMeshApprovalCard({ kind: "pending", approval }),
          `fusa-ma-${approval.requestId}-${approval.requestedAt}`,
        );
        approvalCards.set(approval.requestId, {
          ...posted,
          sequence: 0,
          sas: approval.sas,
          deviceName: approval.device.name,
          settled: false,
        });
      } else if (tracked.sas !== approval.sas) {
        const seq = tracked.sequence + 1;
        await unlessRejected(() => updateCard(tracked.cardId, seq, renderMeshApprovalCard({ kind: "pending", approval })));
        approvalCards.set(approval.requestId, { ...tracked, sequence: seq, sas: approval.sas });
      }
    }
    for (const [reqId, tracked] of approvalCards.entries()) {
      if (tracked.settled || snap.approvals.some((a) => a.requestId === reqId)) continue;
      const approved = snap.joinedIds.has(reqId);
      const seq = tracked.sequence + 1;
      await unlessRejected(() =>
        updateCard(tracked.cardId, seq, renderMeshApprovalCard({ kind: approved ? "approved" : "closed", deviceName: tracked.deviceName })),
      );
      approvalCards.set(reqId, { ...tracked, sequence: seq, settled: true });
    }
  };

  const scheduleApprovalCardsSync = () => {
    if (!isCenter() || !isReady() || options.mesh === undefined) return;
    const routerChat = projection.routerChat();
    if (routerChat === null) {
      if (owner() !== null) requestControl("sync");
      return;
    }
    enqueue(routerChat.chatId, () => syncApprovalCards(), { key: "mesh-approvals" });
  };

  // ---- 出站 ----

  const decisionOf = (ref: FeishuCardRef) => store.decision(ref);

  /** 一张提问卡现在该画成什么样。 */
  const askStateOf = (message: Message): FeishuCardState => {
    const ask = askOf(message);
    if (ask === null) return { kind: "closed" };
    return feishuCardStateOf(ask, decisionOf(feishuCardRefOf(message, ask))?.name ?? displayOwner());
  };

  const routerItemState = (item: RouterItem, ask: Message | null): FeishuCardState => {
    if (ask !== null) return askStateOf(ask);
    if (item.kind === "report" || item.status === "pending") return { kind: "pending" };
    if (item.status === "superseded") return { kind: "closed" };
    return {
      kind: "answered",
      chosenOption: item.resolution?.chosenOption ?? null,
      note: item.resolution?.note ? item.resolution.note : null,
      byName: decisionOf({ kind: "router_item", itemId: item.id })?.name ?? displayOwner(),
    };
  };

  // ---- 附件（docs/feishu-design.md「交付与附件」）----

  /**
   * 一条消息要带到飞书的文件：提问卡的交付物、项目经理发的文件、网页上用户的附件；找不到副本的跳过。
   * part 是它在消息附件列表里的下标，前面的副本事后没了也不变（feishu_posts 按它记）。
   */
  const outboundFilesOf = (message: Message): FeishuOutboundFile[] => {
    const user = message.sender === "user";
    const ask = askOf(message);
    const list: readonly { id: string | null }[] = user ? attachmentsOf(message) : ask !== null ? (ask.deliverables ?? []) : sentFilesOf(message);
    const dir = user ? options.uploadsDir : options.sentFilesDir;
    return list.flatMap((item, part) => {
      const copy = item.id === null ? null : resolveUpload(dir, item.id);
      return copy === null ? [] : [{ messageId: message.id, part, path: copy.path, name: copy.name, mime: copy.mime, bytes: copy.size }];
    });
  };
  const outboundFileOf = (message: Message | null, part: number) => message === null ? undefined : outboundFilesOf(message).find((f) => f.part === part);

  const fileRef = (file: Pick<FeishuOutboundFile, "messageId" | "part">, scope: AttachmentScope = "pm"): FeishuPostRef =>
    scope === "router" ? { kind: "router_file", messageId: file.messageId, part: file.part } : { kind: "file", messageId: file.messageId, part: file.part };
  const uploadKey = (file: Pick<FeishuOutboundFile, "messageId" | "part">) => `${file.messageId}:${file.part}`;
  const peerUploadedOf = (file: FeishuOutboundFile, scope: AttachmentScope): FeishuUploaded | undefined => {
    const peer = store.postOf(fileRef(file, scope === "router" ? "pm" : "router"));
    if (peer === null || peer.mediaKey === null) return undefined;
    const plan = planFeishuFile(file);
    if (plan.kind === "image") return { kind: "image", imageKey: peer.mediaKey };
    if (plan.kind === "file") return { kind: "file", fileKey: peer.mediaKey, msgType: plan.msgType };
    return undefined;
  };

  /** 传一个文件：暂时性错误退避重试 FEISHU_MEDIA_RETRY_MAX 次；飞书拒收、重试用尽返回 null；停机、断线打断返回 undefined。 */
  const uploadWithRetry = async (service: FeishuFileService, file: FeishuOutboundFile): Promise<FeishuUploaded | null | undefined> => {
    for (let attempt = 0; ; attempt++) {
      if (closed || !isReady()) return undefined;
      try {
        return await service.upload(file);
      } catch (error) {
        handleError(error);
        if (closed || !isReady()) return undefined;
        if (isFeishuRejection(error) || error instanceof FeishuAuthError || attempt >= FEISHU_MEDIA_RETRY_MAX) return null;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            uploadTimers.delete(timer);
            resolve();
          }, FEISHU_CONTROL_RETRY_MS * 2 ** attempt);
          timer.unref?.();
          uploadTimers.add(timer);
        });
      }
    }
  };

  /** 开始传（已经在传就返回那一份）；没连上、在途满了返回 null，卡上先写 Uploading，重连后按 uploading 记录再传。 */
  const startUpload = (file: FeishuOutboundFile): UploadJob | null => {
    const key = uploadKey(file);
    const existing = uploads.get(key);
    if (existing !== undefined) return existing;
    const service = files;
    if (service === null || closed || !isReady()) return null;
    if (uploadsInFlight >= FEISHU_MEDIA_QUEUE_MAX) {
      log(`飞书：在传的附件满了（${FEISHU_MEDIA_QUEUE_MAX} 个），「${file.name}」等一会儿再传`);
      return null;
    }
    const job: UploadJob = { startedAt: now(), done: Promise.resolve(), result: undefined, follows: new Set() };
    uploadsInFlight++;
    job.done = uploadLimit(() => uploadWithRetry(service, file)).then(
      (result) => {
        job.result = result;
        if (result === undefined && uploads.get(key) === job) uploads.delete(key);
      },
      (error: unknown) => {
        handleError(error);
        job.result = null;
      },
    ).finally(() => {
      uploadsInFlight--;
      settleIdle();
    });
    uploads.set(key, job);
    return job;
  };

  const startUploadsOf = (message: Message) => {
    for (const file of outboundFilesOf(message)) {
      if (store.postOf(fileRef(file, "pm"))?.mediaKey == null && store.postOf(fileRef(file, "router"))?.mediaKey == null) startUpload(file);
    }
  };

  /** 每个附件这一刻的样子。sending：要发卡了（没在传的也算在传，卡上写 Uploading）；否则是重画已经发出的卡。 */
  const attachmentSlots = (message: Message, sending = false, scope: AttachmentScope = "pm"): AttachmentSlot[] =>
    outboundFilesOf(message).map((file) => {
      const row = store.postOf(fileRef(file, scope));
      const job = row === null || row.state === "uploading" ? (uploads.get(uploadKey(file)) ?? null) : null;
      const result = job?.result !== undefined ? job.result : peerUploadedOf(file, scope);
      return { file, row, job, result, sending };
    });

  /** 发卡前等附件：最晚等到最后开始传的那个起算 attachWaitMs，传完就不等了；返回等完这一刻的样子。 */
  const prepareAttachments = async (message: Message, scope: AttachmentScope = "pm"): Promise<AttachmentSlot[]> => {
    const jobs = outboundFilesOf(message).flatMap((file) => {
      if (store.postOf(fileRef(file, scope)) !== null || peerUploadedOf(file, scope) !== undefined) return [];
      const job = startUpload(file);
      return job === null || job.result !== undefined ? [] : [job];
    });
    const left = jobs.length === 0 ? 0 : Math.max(...jobs.map((j) => j.startedAt)) + attachWaitMs - now();
    if (left > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.all(jobs.map((j) => j.done)), new Promise((resolve) => { timer = setTimeout(resolve, left); })]);
      clearTimeout(timer);
    }
    return attachmentSlots(message, true, scope);
  };

  /** 附件在卡上画成什么：图片嵌进卡，还在传的写 Uploading，补发过的写已送达，没传上、太大的写去网页看；紧跟卡发出去的文件不画。 */
  const attachmentView = ({ file, row, job, result, sending }: AttachmentSlot): FeishuAttachmentView | null => {
    const plan = planFeishuFile(file);
    const name = file.name;
    if (plan.kind === "too_large") return { kind: "too_large", name, bytes: file.bytes };
    // uploading 行带了编号是传完（文件也发了）、只差改卡；没带编号的看在途那一份传没传上
    if (row?.state === "uploading" && row.mediaKey === null) return result === null ? { kind: "failed", name } : { kind: "uploading", name };
    if (row !== null) {
      // 不挂在卡上的是单发的文件消息（含 0035 之前单发的图片）
      if (row.cardId === null) return null;
      if (row.mediaKey === null) return { kind: "failed", name };
      return plan.kind === "image" ? { kind: "image", name, imageKey: row.mediaKey } : { kind: "sent", name };
    }
    if (job === null && !sending) return null;
    if (result === undefined) return { kind: "uploading", name };
    if (result === null) return { kind: "failed", name };
    return result.kind === "image" ? { kind: "image", name, imageKey: result.imageKey } : null;
  };
  const attachmentViews = (slots: readonly AttachmentSlot[]) => slots.flatMap((slot) => attachmentView(slot) ?? []);

  /**
   * 卡发出去之后：已传好的文件紧跟着发出去；嵌进卡的图片、没传上、太大的记成 final；还在传的记成 uploading（挂在 host 上），
   * 传完再补发、改卡。已有记录的不动。紧跟着发的文件被飞书拒收时也记成 uploading，交给 completeUpload 把 host 改成写着没发出去。
   */
  const followUpAttachments = async (chatId: FeishuChatId, slots: readonly AttachmentSlot[], host: HostCard, scope: AttachmentScope = "pm") => {
    const rejected: FeishuOutboundFile[] = [];
    for (const { file, row, result } of slots) {
      if (row !== null) continue;
      const ref = fileRef(file, scope);
      const onHost = { ref, chatId, messageId: host.messageId, cardId: host.cardId, sequence: 0 };
      if (planFeishuFile(file).kind === "too_large" || result === null) {
        store.savePost({ ...onHost, state: "final", mediaKey: null }, now());
      } else if (result === undefined) {
        store.savePost({ ...onHost, state: "uploading" }, now());
        followUpload(chatId, file, scope);
        continue;
      } else if (result.kind === "image") {
        store.savePost({ ...onHost, state: "final", mediaKey: result.imageKey }, now());
      } else if (result.kind === "file") {
        const sent = await sendUploadedFile(chatId, file, result);
        if (sent === undefined) continue;
        if (sent === null) {
          const job = uploads.get(uploadKey(file));
          if (job !== undefined) job.result = null;
          store.savePost({ ...onHost, state: "uploading" }, now());
          rejected.push(file);
          continue;
        }
        store.savePost({ ref, chatId, messageId: sent, cardId: null, sequence: 0, state: "final", mediaKey: result.fileKey }, now());
      }
      if (store.postOf(fileRef(file, scope === "router" ? "pm" : "router"))?.state !== "uploading") {
        uploads.delete(uploadKey(file));
      }
    }
    for (const file of rejected) await completeUpload(chatId, file.messageId, file.part, scope);
  };

  /** 发一个传好的文件：返回消息编号；飞书拒收返回 null（卡上标没发出去）；没连上返回 undefined（留着下次补）。暂时性错误往外抛。 */
  const sendUploadedFile = async (chatId: FeishuChatId, file: FeishuOutboundFile, uploaded: Extract<FeishuUploaded, { kind: "file" }>): Promise<FeishuMessageId | null | undefined> => {
    if (files === null) return undefined;
    try {
      return await files.sendFile(chatId, file, uploaded);
    } catch (error) {
      if (!isFeishuRejection(error)) throw error;
      handleError(error);
      return null;
    }
  };

  /** 等这个在途附件传完，排一件 completeUpload；断线打断的不排，重连补发时按 uploading 记录再传。 */
  const followUpload = (chatId: FeishuChatId, file: FeishuOutboundFile, scope: AttachmentScope = "pm") => {
    const job = startUpload(file);
    const followKey = `${scope}:${chatId}`;
    if (job === null || job.follows.has(followKey)) return;
    job.follows.add(followKey);
    void job.done.then(() => {
      if (job.result !== undefined) enqueue(chatId, () => completeUpload(chatId, file.messageId, file.part, scope));
    });
  };

  /**
   * 在途附件传完了：图片记下编号、文件补发成文件消息，再把挂它的那张卡原地改掉（图嵌回去、文件标已送达、没传上的标没发出去），
   * 改成了才记 final。编号先记在 uploading 行上（行里的消息编号一直是 host 的）：改卡遇到暂时性错误、停机重启后，
   * 补发和 resumeUploads 按这一行重新改卡，不重传、不重发文件。
   */
  const completeUpload = async (chatId: FeishuChatId, messageId: MessageId, part: number, scope: AttachmentScope = "pm") => {
    const ref = fileRef({ messageId, part }, scope);
    const row = store.postOf(ref);
    if (row?.state !== "uploading" || row.chatId !== chatId) return;
    const message = ledger.getMessage(messageId);
    const file = outboundFileOf(message, part);
    const key = uploadKey({ messageId, part });
    if (file !== undefined && row.mediaKey === null) {
      const job = uploads.get(key);
      const resolved = job?.result !== undefined ? job.result : peerUploadedOf(file, scope);
      if (resolved === undefined) {
        followUpload(chatId, file, scope);
        return;
      }
      const result = resolved;
      let mediaKey: string | null = null;
      if (result?.kind === "image") mediaKey = result.imageKey;
      else if (result?.kind === "file") {
        const sent = await sendUploadedFile(chatId, file, result);
        if (sent === undefined) return;
        if (sent === null && job !== undefined) job.result = null;
        else mediaKey = result.fileKey;
      }
      if (mediaKey !== null) store.savePost({ ...row, mediaKey }, now());
    }
    if (message !== null) await refreshHostCard(message, row.messageId);
    const latest = store.postOf(ref);
    if (latest !== null && store.chatById(chatId) !== null) store.savePost({ ...latest, state: "final" }, now());
    if (store.postOf(fileRef({ messageId, part }, scope === "router" ? "pm" : "router"))?.state !== "uploading") {
      uploads.delete(key);
    }
  };

  /** 挂附件的卡按账本现状和附件现状重画一遍、原地改掉：提问卡照拍板状态画，回复卡和网页镜像卡用最后一段正文。 */
  const refreshHostCard = async (message: Message, hostMessageId: FeishuMessageId) => {
    const post = store.postByMessageId(hostMessageId);
    if (post === null || post.cardId === null) return;
    let card: FeishuCardJson | null = null;
    if (post.ref.kind === "message") {
      const views = attachmentViews(attachmentSlots(message, false, "pm"));
      const ask = message.sender === "agent" ? askOf(message) : null;
      const lastChunk = splitFeishuMarkdown(message.sender === "user" ? mirrorText(message) : message.text).at(-1) ?? "";
      card = ask !== null
        ? renderAskCard(message, ask, askStateOf(message), views)
        : message.sender === "user"
          ? renderTextCard({ title: MIRROR_TITLE, text: lastChunk, template: "grey", attachments: views })
          : renderReplyCard({ conversationId: message.conversationId, text: lastChunk, streaming: false, withStop: false, attachments: views });
    } else if (post.ref.kind === "router_ask") {
      const ask = askOf(message);
      if (ask === null) return;
      const pmId = pmOfConversation(message.conversationId);
      const pmChat = pmId === null ? null : liveChatOfPm(pmId);
      const views = attachmentViews(attachmentSlots(message, false, "router"));
      card = renderRouterAskCard(message, ask, askStateOf(message), pmChat?.chatId ?? null, views, pmNameOf(pmId));
    } else if (post.ref.kind === "router_item") {
      const item = ledger.getRouterItem(post.ref.itemId);
      const ask = askOf(message);
      if (item === null || ask === null) return;
      const pmChat = liveChatOfPm(item.pmId);
      const views = attachmentViews(attachmentSlots(message, false, "router"));
      card = renderRouterItem(item, { message, meta: ask }, routerItemState(item, message), pmChat?.chatId ?? null, views);
    }
    if (card === null) return;
    const cardId = post.cardId;
    await unlessRejected(() => updateCard(cardId, post.sequence + 1, card));
    if (store.chatById(post.chatId) !== null) store.savePost({ ...post, sequence: post.sequence + 1 }, now());
  };

  /** 重连、重启后接着做卡已发出、附件还没收尾的：传完（或只差改卡）的直接收尾，没传完的接着等。 */
  const resumeUploads = async (chat: FeishuChatBinding) => {
    for (const post of store.uploadingPosts(chat.chatId, FEISHU_PAGE_SIZE)) {
      if (post.ref.kind !== "file" && post.ref.kind !== "router_file") continue;
      const scope: AttachmentScope = post.ref.kind === "router_file" ? "router" : "pm";
      const { messageId, part } = post.ref;
      const candidate = outboundFileOf(ledger.getMessage(messageId), part);
      const needsUpload =
        post.mediaKey === null &&
        uploads.get(uploadKey({ messageId, part }))?.result === undefined &&
        (candidate === undefined || peerUploadedOf(candidate, scope) === undefined);
      if (!needsUpload || candidate === undefined) await completeUpload(chat.chatId, messageId, part, scope);
      else followUpload(chat.chatId, candidate, scope);
    }
  };

  /**
   * 把一张回复卡改成不再流式、没有停止按钮的样子，返回最后用的 sequence。
   * 正文被飞书拒收（内容不合规、超限）时换成 unrenderableReplyText 再改一次；这次也被拒（卡片过期、撤回）往外抛。
   */
  const closeReplyCard = async (
    conversationId: ConversationId,
    cardId: FeishuCardId,
    sequence: number,
    text: string,
    uuid?: string,
    attachments: readonly FeishuAttachmentView[] = [],
  ): Promise<number> => {
    try {
      await updateCard(cardId, sequence, renderReplyCard({ conversationId, text, streaming: false, withStop: false, attachments }), uuid);
      return sequence;
    } catch (error) {
      if (!(error instanceof FeishuApiError) || !isFeishuRejection(error)) throw error;
      handleError(error);
      await updateCard(cardId, sequence + 1, renderReplyCard({ conversationId, text: unrenderableReplyText(error.code), streaming: false, withStop: false, attachments }));
      return sequence + 1;
    }
  };

  /**
   * 发一张新的回复卡；正文被飞书拒收时换成 unrenderableReplyText 再发。挂着附件的建成卡片实体（附件传完要原地改它），
   * 返回的 cardId 不为 null。
   */
  const sendReplyCard = async (chatId: FeishuChatId, conversationId: ConversationId, text: string, uuid: string, attachments: readonly FeishuAttachmentView[] = [], entity = false): Promise<HostCard> => {
    const send = async (body: string, key: string): Promise<HostCard> => {
      const card = renderReplyCard({ conversationId, text: body, streaming: false, withStop: false, attachments });
      if (entity) return postCardEntity(chatId, card, key);
      return { messageId: (await sendMessage({ chatId }, "interactive", card, key)).messageId, cardId: null };
    };
    try {
      return await send(text, uuid);
    } catch (error) {
      if (!(error instanceof FeishuApiError) || !isFeishuRejection(error)) throw error;
      handleError(error);
      return send(unrenderableReplyText(error.code), `${uuid}-x`);
    }
  };

  /**
   * 一段文字定稿：流式那张卡换成账本正文（关流式、去停止按钮），超长的续到新卡；它带的附件挂在最后一张卡上：
   * 先按 prepareAttachments 等一小会儿，传好的图片嵌进卡、文件紧跟卡发，没传完的卡上写 Uploading、传完再补。
   * 卡片上次定稿没做完（停机、重启、暂时性错误）时换下一个 sequence 重做；改不上的卡也记成 final，不再重试。
   */
  const finalizeSegment = async (chatId: FeishuChatId, conversationId: ConversationId, effect: Extract<FeishuStreamEffect, { kind: "finalize" }>, posted: StreamSlot["posted"] = null) => {
    const message = ledger.getMessage(effect.messageId);
    const slots = message === null ? [] : await prepareAttachments(message);
    const views = attachmentViews(slots);
    const chunks = splitFeishuMarkdown(effect.text);
    if (chunks.length === 0 && slots.length > 0) chunks.push("");
    let host: HostCard | null = null;
    for (const [part, chunk] of chunks.entries()) {
      if (projection.chatOfConversation(conversationId)?.chatId !== chatId) return;
      const attachments = part === chunks.length - 1 ? views : [];
      const ref: FeishuPostRef = { kind: "message", messageId: effect.messageId, part };
      let post = store.postOf(ref);
      if (post?.state === "final") {
        host = { messageId: post.messageId, cardId: post.cardId };
        continue;
      }
      if (part === 0 && posted !== null && post === null) {
        store.savePost({ ref, chatId, messageId: posted.messageId, cardId: posted.cardId, sequence: effect.sequence, state: "streaming" }, now());
        post = store.postOf(ref);
      } else if (post?.cardId) {
        post = { ...post, sequence: post.sequence + 1 };
        store.savePost(post, now());
      }
      if (post?.cardId) {
        let sequence = post.sequence;
        try {
          sequence = await closeReplyCard(conversationId, post.cardId, post.sequence, chunk, `fusa-final-${effect.messageId}-${post.sequence}`, attachments);
        } catch (error) {
          if (!isFeishuRejection(error)) throw error;
          handleError(error);
        }
        if (projection.chatOfConversation(conversationId)?.chatId !== chatId) return;
        store.savePost({ ...post, sequence, state: "final" }, now());
        host = { messageId: post.messageId, cardId: post.cardId };
      } else {
        host = await sendReplyCard(chatId, conversationId, chunk, `fusa-m-${effect.messageId}-${part}`, attachments, part === chunks.length - 1 && slots.length > 0);
        if (projection.chatOfConversation(conversationId)?.chatId !== chatId) return;
        store.savePost({ ref, chatId, messageId: host.messageId, cardId: host.cardId, sequence: 0, state: "final" }, now());
      }
    }
    if (host !== null) await followUpAttachments(chatId, slots, host);
    store.advanceWatermark(chatId, { messageId: effect.messageId }, now());
  };

  const dropStream = (id: ConversationId, slot: StreamSlot) => {
    if (slot.timer !== null) clearTimeout(slot.timer);
    if (streams.get(id) === slot) streams.delete(id);
  };

  const clearChatRuntime = (chatId: FeishuChatId) => {
    directory.forget(chatId);
    contexts.clear(chatId);
    sendTimes.delete(chatId);
    inboundCursorHold.delete(chatId);
    releaseInboundGate(chatId);
    for (const [id, slot] of streams) if (slot.chatId === chatId) dropStream(id, slot);
  };

  const feedStream = async (id: ConversationId, event: FeishuStreamEvent, chatId: FeishuChatId, expected?: StreamSlot) => {
    let slot = streams.get(id);
    if (expected !== undefined && slot !== expected) return;
    if (projection.chatOfConversation(id)?.chatId !== chatId) {
      if (slot?.chatId === chatId) dropStream(id, slot);
      return;
    }
    if (slot?.chatId !== chatId) {
      if (slot !== undefined) dropStream(id, slot);
      if (event.kind !== "text" && event.kind !== "working" && event.kind !== "segment_done") return;
      slot = { state: { phase: "idle" }, chatId, timer: null, timerAt: null, posted: null };
      streams.set(id, slot);
    }
    const current = slot;
    const step = stepFeishuStream(current.state, event, { conversationId: id, chatId }, now(), budget);
    current.state = step.state;
    const posted = current.posted;
    if (current.state.phase === "idle") dropStream(id, current);
    if (current.state.phase === "idle" || current.state.phase === "quiet") {
      // 这张卡收完了：quiet 留着这个对话的记录（这一轮不再开状态卡），但不再续期、不再认它的停止按钮
      if (current.timer !== null) clearTimeout(current.timer);
      current.timer = current.timerAt = null;
      current.posted = null;
    }
    for (const effect of step.effects) {
      switch (effect.kind) {
        case "open": {
          const card = renderReplyCard({ conversationId: id, text: effect.text, streaming: true, withStop: true });
          let opened: Awaited<ReturnType<typeof postCardEntity>>;
          try {
            opened = await postCardEntity(chatId, card, `fusa-s-${randomUUID()}`);
          } catch (error) {
            handleError(error);
            await feedStream(id, { kind: "open_failed" }, chatId, current);
            break;
          }
          current.posted = { ...opened, text: effect.text };
          await feedStream(id, { kind: "opened", ...opened, sequence: 0 }, chatId, current);
          break;
        }
        case "push":
          await api("card.element.content", { card_id: effect.cardId, element_id: "reply", content: effect.text, sequence: effect.sequence, uuid: randomUUID() });
          if (current.posted !== null) current.posted.text = effect.text;
          break;
        case "renew":
          await api("card.settings", { card_id: effect.cardId, settings: JSON.stringify({ config: { streaming_mode: true } }), sequence: effect.sequence, uuid: randomUUID() });
          break;
        case "finalize":
          await finalizeSegment(chatId, id, effect, effect.cardId === null ? null : posted);
          break;
        case "abandon":
          await closeReplyCard(id, effect.cardId, effect.sequence, effect.text);
          break;
        case "discard":
          await discardStatusCard(id, effect);
          break;
        case "schedule_tick":
          scheduleTick(id, current, effect.at);
          break;
      }
    }
  };

  /** 整轮没写正文的状态卡：撤回；飞书不让撤（超过撤回时限、权限）时关流式、去停止按钮，收成一行说明。 */
  const discardStatusCard = async (id: ConversationId, effect: Extract<FeishuStreamEffect, { kind: "discard" }>) => {
    try {
      await api("message.delete", { message_id: effect.messageId });
    } catch (error) {
      if (!isFeishuRejection(error)) throw error;
      handleError(error);
      await closeReplyCard(id, effect.cardId, effect.sequence, NO_REPLY_TEXT);
    }
  };

  const scheduleTick = (id: ConversationId, slot: StreamSlot, at: number) => {
    if (slot.timerAt !== null && slot.timerAt <= at) return;
    if (slot.timer !== null) clearTimeout(slot.timer);
    slot.timerAt = at;
    slot.timer = setTimeout(() => {
      slot.timer = null;
      slot.timerAt = null;
      if (streams.get(id) === slot) enqueue(slot.chatId, () => feedStream(id, { kind: "tick" }, slot.chatId, slot), { key: `tick:${id}`, preview: true });
    }, Math.max(0, at - now()));
    slot.timer.unref?.();
  };

  /** 提问卡：交付物和文字、按钮同卡（图片嵌进卡，别的文件紧跟卡发，没传完的先写 Uploading）。 */
  const postAskCard = async (chatId: FeishuChatId, message: Message) => {
    if (projection.chatOfConversation(message.conversationId)?.chatId !== chatId) return;
    const ref: FeishuPostRef = { kind: "message", messageId: message.id, part: 0 };
    const existing = store.postOf(ref);
    let host: HostCard;
    let slots: AttachmentSlot[];
    if (existing === null) {
      const ask = askOf(message);
      if (ask === null) return;
      if (askStateOf(message).kind !== "pending") {
        store.advanceWatermark(chatId, { messageId: message.id }, now());
        return;
      }
      slots = await prepareAttachments(message);
      const posted = await postCardEntity(chatId, renderAskCard(message, ask, askStateOf(message), attachmentViews(slots)), `fusa-a-${message.id}`);
      if (projection.chatOfConversation(message.conversationId)?.chatId !== chatId) return;
      store.savePost({ ref, chatId, messageId: posted.messageId, cardId: posted.cardId, sequence: 0, state: "card_pending" }, now());
      host = posted;
    } else {
      slots = attachmentSlots(message);
      host = { messageId: existing.messageId, cardId: existing.cardId };
    }
    await followUpAttachments(chatId, slots, host);
    store.advanceWatermark(chatId, { messageId: message.id }, now());
  };

  const settleAskCard = async (messageId: MessageId) => {
    const post = store.postOf({ kind: "message", messageId, part: 0 });
    if (post?.state !== "card_pending" || post.cardId === null) return;
    const message = ledger.getMessage(messageId);
    if (message === null) return closeMissingCard(post);
    const ask = askOf(message);
    if (ask === null) return closeMissingCard(post);
    const state = askStateOf(message);
    if (state.kind === "pending") return;
    await settlePost(post, renderAskCard(message, ask, state, attachmentViews(attachmentSlots(message))));
  };

  const postRouterAskCard = async (message: Message) => {
    const chat = projection.routerChat();
    const pmId = pmOfConversation(message.conversationId);
    if (chat === null || pmId === null || !isActivePm(pmId)) return;
    const ask = askOf(message);
    if (ask === null) return;
    const ref: FeishuPostRef = { kind: "router_ask", messageId: message.id };
    const existing = store.postOf(ref);
    const pmChat = liveChatOfPm(pmId);
    const pmName = pmNameOf(pmId);
    if (existing === null) {
      if (askStateOf(message).kind !== "pending") return;
      const slots = await prepareAttachments(message, "router");
      const card = renderRouterAskCard(message, ask, askStateOf(message), pmChat?.chatId ?? null, attachmentViews(slots), pmName);
      const posted = await postCardEntity(chat.chatId, card, `fusa-ra-${message.id}`);
      if (projection.routerChat()?.chatId !== chat.chatId) return;
      store.savePost({ ref, chatId: chat.chatId, messageId: posted.messageId, cardId: posted.cardId, sequence: 0, state: "card_pending" }, now());
      await followUpAttachments(chat.chatId, slots, posted, "router");
      return;
    }
    if (existing.state === "card_pending" && askStateOf(message).kind !== "pending") {
      await settleRouterAskCard(message.id);
      return;
    }
    await followUpAttachments(chat.chatId, attachmentSlots(message, false, "router"), { messageId: existing.messageId, cardId: existing.cardId }, "router");
  };

  const settleRouterAskCard = async (messageId: MessageId) => {
    const post = store.postOf({ kind: "router_ask", messageId });
    if (post?.state !== "card_pending" || post.cardId === null) return;
    const message = ledger.getMessage(messageId);
    if (message === null) return closeMissingCard(post);
    const ask = askOf(message);
    if (ask === null) return closeMissingCard(post);
    const state = askStateOf(message);
    if (state.kind === "pending") return;
    const pmId = pmOfConversation(message.conversationId);
    const pmChat = pmId === null ? null : liveChatOfPm(pmId);
    const views = attachmentViews(attachmentSlots(message, false, "router"));
    await settlePost(post, renderRouterAskCard(message, ask, state, pmChat?.chatId ?? null, views, pmNameOf(pmId)));
  };

  const refreshPendingAskCard = async (messageId: MessageId, scope: AttachmentScope) => {
    const post = store.postOf(scope === "router" ? { kind: "router_ask", messageId } : { kind: "message", messageId, part: 0 });
    if (post?.state !== "card_pending" || post.cardId === null) return;
    const message = ledger.getMessage(messageId);
    const ask = message === null ? null : askOf(message);
    if (message === null || ask === null || askStateOf(message).kind !== "pending") return;
    const views = attachmentViews(attachmentSlots(message, false, scope));
    const pmId = pmOfConversation(message.conversationId);
    const pmChat = pmId === null ? null : liveChatOfPm(pmId);
    const card =
      scope === "router"
        ? renderRouterAskCard(message, ask, { kind: "pending" }, pmChat?.chatId ?? null, views, pmNameOf(pmId))
        : renderAskCard(message, ask, { kind: "pending" }, views);
    const nextSeq = post.sequence + 1;
    await unlessRejected(() => updateCard(post.cardId!, nextSeq, card));
    if (store.chatById(post.chatId) !== null) store.savePost({ ...post, sequence: nextSeq }, now());
  };

  /** 待拍板卡改成定案的样子；飞书不让再改（过期、撤回）时也记成已结算，不再重试。 */
  const settlePost = async (post: FeishuPostRecord, card: FeishuCardJson) => {
    if (post.cardId === null) return;
    await unlessRejected(() => updateCard(post.cardId!, post.sequence + 1, card));
    if (store.chatById(post.chatId) !== null) store.savePost({ ...post, sequence: post.sequence + 1, state: "card_settled" }, now());
  };

  const routerItemCard = (item: RouterItem, slots?: readonly AttachmentSlot[]) => {
    const askMessage = item.kind === "decision" && item.askMessageId !== null ? ledger.getMessage(item.askMessageId) : null;
    const meta = askMessage === null ? null : askOf(askMessage);
    const state = routerItemState(item, meta === null ? null : askMessage);
    const pmChat = liveChatOfPm(item.pmId);
    const views = askMessage !== null && meta !== null ? attachmentViews(slots ?? attachmentSlots(askMessage, false, "router")) : [];
    return {
      askMessage,
      card: renderRouterItem(item, askMessage !== null && meta !== null ? { message: askMessage, meta } : null, state, pmChat?.chatId ?? null, views),
      settled: state.kind !== "pending" || item.kind === "report",
    };
  };

  const postRouterItem = async (item: RouterItem) => {
    const chat = store.chatOfTarget({ kind: "router" });
    if (chat === null) return;
    const ref: FeishuPostRef = { kind: "router_item", itemId: item.id };
    const post = store.postOf(ref);
    const initialAsk = post === null && item.kind === "decision" && item.askMessageId !== null ? ledger.getMessage(item.askMessageId) : null;
    const slots = initialAsk !== null && askStateOf(initialAsk).kind === "pending" ? await prepareAttachments(initialAsk, "router") : undefined;
    const { askMessage, card, settled } = routerItemCard(item, slots);
    if (post === null) {
      if (item.kind === "decision" && settled) return;
      const posted = await postCardEntity(chat.chatId, card, `fusa-r-${item.id}`);
      if (store.chatById(chat.chatId) === null) return;
      store.savePost({ ref, chatId: chat.chatId, messageId: posted.messageId, cardId: posted.cardId, sequence: 0, state: item.kind === "report" ? "final" : "card_pending" }, now());
      if (askMessage !== null && slots !== undefined) await followUpAttachments(chat.chatId, slots, posted, "router");
      return;
    }
    if (post.state !== "card_pending" || !settled) return;
    await settlePost(post, card);
  };

  const routerReplyText = (command: RouterCommandRecord): string => {
    if (command.status === "failed") return `没办成：${command.error ?? "未知原因"}`;
    const reply = command.plan?.reply ?? "";
    if (reply !== "") return reply;
    const targets = (command.dispatched ?? []).map((d) => `${d.pmName ?? `项目经理 ${d.pmId}`}${d.ok ? "" : `（没送到：${d.error ?? "未知原因"}）`}`);
    return targets.length > 0 ? `已交给：${targets.join("、")}` : "好的。";
  };

  const postTextChunks = async (chatId: FeishuChatId, title: string, text: string, key: string, refForPart: (part: number) => FeishuPostRef, template?: string) => {
    for (const [part, chunk] of splitFeishuMarkdown(text).entries()) {
      if (activeTarget(store.chatById(chatId)) === null) return;
      const ref = refForPart(part);
      if (store.postOf(ref) !== null) continue;
      const { messageId } = await sendMessage({ chatId }, "interactive", renderTextCard({ title, text: chunk, ...(template ? { template } : {}) }), `${key}-${part}`);
      if (activeTarget(store.chatById(chatId)) === null) return;
      store.savePost({ ref, chatId, messageId, cardId: null, sequence: 0, state: "final" }, now());
    }
  };

  const postRouterCommand = async (command: RouterCommandRecord) => {
    const chat = store.chatOfTarget({ kind: "router" });
    if (chat === null) return;
    const fromFeishu = command.clientId.startsWith(FEISHU_CLIENT_PREFIX);
    const text = fromFeishu ? routerReplyText(command) : `**网页上说**：${command.inputText}\n\n${routerReplyText(command)}`;
    await postTextChunks(chat.chatId, "总助", text, `fusa-c-${command.id}`, (part) => ({ kind: "router_command", commandId: command.id, part }));
  };

  /** 网页上发的话：带的附件挂在最后一张卡上，和回复卡一样同发（图片嵌进卡，文件紧跟卡发）。 */
  const mirrorUser = async (chatId: FeishuChatId, message: Message) => {
    const slots = await prepareAttachments(message);
    const chunks = splitFeishuMarkdown(mirrorText(message));
    let host: HostCard | null = null;
    for (const [part, chunk] of chunks.entries()) {
      if (activeTarget(store.chatById(chatId)) === null) return;
      const ref: FeishuPostRef = { kind: "message", messageId: message.id, part };
      const existing = store.postOf(ref);
      if (existing !== null) {
        host = { messageId: existing.messageId, cardId: existing.cardId };
        continue;
      }
      const attachments = part === chunks.length - 1 ? attachmentViews(slots) : [];
      const card = renderTextCard({ title: MIRROR_TITLE, text: chunk, template: "grey", attachments });
      const uuid = `fusa-u-${message.id}-${part}`;
      host = slots.length > 0 && part === chunks.length - 1
        ? await postCardEntity(chatId, card, uuid)
        : { messageId: (await sendMessage({ chatId }, "interactive", card, uuid)).messageId, cardId: null };
      if (activeTarget(store.chatById(chatId)) === null) return;
      store.savePost({ ref, chatId, messageId: host.messageId, cardId: host.cardId, sequence: 0, state: "final" }, now());
    }
    if (host !== null) await followUpAttachments(chatId, slots, host);
    store.advanceWatermark(chatId, { messageId: message.id }, now());
  };

  const mirrorText = (message: Message) => (message.text.trim() === "" ? "（发了文件）" : message.text);

  /** 一段落库：这一轮还在跑就记 turnActive（定稿后这一轮不再开状态卡）。 */
  const segmentDone = (message: Message): FeishuStreamEvent => ({
    kind: "segment_done",
    messageId: message.id,
    text: message.text,
    turnActive: activeTurns.has(message.conversationId),
  });

  const runIntent = (intent: FeishuOutboundIntent) => {
    switch (intent.kind) {
      case "sync_chats":
        requestControl("sync");
        return;
      case "stream":
      case "working":
      case "agent_text":
      case "turn_end":
      case "mirror_user":
      case "ask_card": {
        const chat = projection.chatOfConversation(intent.conversationId);
        if (chat === null) return;
        const id = intent.conversationId;
        if (intent.kind === "stream") enqueue(chat.chatId, () => feedStream(id, { kind: "text", text: intent.text }, chat.chatId), { key: `stream:${id}`, preview: true });
        else if (intent.kind === "working") enqueue(chat.chatId, () => feedStream(id, { kind: "working", status: intent.status }, chat.chatId), { key: `working:${id}`, preview: true });
        else if (intent.kind === "agent_text") {
          startUploadsOf(intent.message);
          // 这一轮跑没跑完按落库的这一刻算，不按排到它时算（那时这一轮可能已经结束、下一轮已经开始）
          const done = segmentDone(intent.message);
          enqueue(chat.chatId, async () => {
            if ((store.chatById(chat.chatId)?.lastMessageId ?? 0) >= intent.message.id) return;
            await feedStream(id, done, chat.chatId);
          }, { mark: intent.message.id });
        } else if (intent.kind === "turn_end") enqueue(chat.chatId, () => feedStream(id, { kind: "turn_end" }, chat.chatId));
        else {
          startUploadsOf(intent.message);
          if (intent.kind === "mirror_user") enqueue(chat.chatId, () => mirrorUser(chat.chatId, intent.message), { mark: intent.message.id });
          else enqueue(chat.chatId, () => postAskCard(chat.chatId, intent.message), { mark: intent.message.id });
        }
        return;
      }
      case "ask_settled": {
        const chat = projection.chatOfConversation(intent.conversationId);
        if (chat !== null) enqueue(chat.chatId, () => settleAskCard(intent.message.id));
        const routerChat = projection.routerChat();
        if (routerChat !== null) enqueue(routerChat.chatId, async () => {
          await settleRouterAskCard(intent.message.id);
          const row = db.get<{ id: number }>("SELECT id FROM router_items WHERE ask_message_id = ? ORDER BY id DESC LIMIT 1", intent.message.id);
          if (row !== undefined) await settleRouterItem(row.id);
        });
        return;
      }
      case "ask_updated": {
        const chat = projection.chatOfConversation(intent.conversationId);
        if (chat !== null) enqueue(chat.chatId, () => refreshPendingAskCard(intent.message.id, "pm"));
        const routerChat = projection.routerChat();
        if (routerChat !== null) enqueue(routerChat.chatId, () => refreshPendingAskCard(intent.message.id, "router"));
        return;
      }
      case "router_ask": {
        startUploadsOf(intent.message);
        const chat = projection.routerChat();
        if (chat !== null) enqueue(chat.chatId, () => replayRouterEvents(chat, false), { key: "router-events" });
        else if (!isCenter()) ackAllRouterEvents();
        return;
      }
      case "router_item": {
        const chat = projection.routerChat();
        if (chat !== null) {
          enqueue(chat.chatId, () => replayRouterEvents(chat, false), { key: "router-events" });
          if (intent.item.kind === "decision" && intent.item.status !== "pending") {
            enqueue(chat.chatId, () => settleRouterItem(intent.item.id));
          }
        }
        return;
      }
      case "router_command": {
        const chat = projection.routerChat();
        if (chat !== null) enqueue(chat.chatId, () => replayRouterEvents(chat, false), { key: "router-events" });
        return;
      }
      case "refresh_policy_card": {
        const chat = liveChatOfPm(intent.pmId);
        if (chat !== null) schedulePolicyCardRefresh(chat.chatId, intent.pmId);
        return;
      }
      case "refresh_router_settings_card": {
        const chat = projection.routerChat();
        if (chat !== null) scheduleRouterSettingsCardRefresh(chat.chatId);
        return;
      }
    }
  };

  const onLedgerChange = (change: Change) => {
    // 断线时也记：重连补发要知道哪几轮在断线期间结束了
    if (change.type === "session.status") {
      const { conversationId, status, activity } = change.data.session;
      if (conversationId !== null) {
        if (status === "running" && activity !== "idle") activeTurns.add(conversationId);
        else activeTurns.delete(conversationId);
      }
    }
    if (!isCenter() && (change.type === "router.item.created" || change.type === "router.item.updated" || change.type === "router.command.updated")) {
      ackAllRouterEvents();
      return;
    }
    if (transport === null || !isReady() || owner() === null) return;
    try {
      for (const intent of projectFeishuChange(change, projection)) runIntent(intent);
    } catch (error) {
      log(`飞书：投影账本变化出错：${errorText(error)}`);
    }
  };

  // ---- 断线补发 ----

  const replayPmIntent = async (chatId: FeishuChatId, intent: FeishuOutboundIntent) => {
    if (intent.kind === "agent_text") {
      await feedStream(intent.conversationId, segmentDone(intent.message), chatId);
    } else if (intent.kind === "mirror_user") await mirrorUser(chatId, intent.message);
    else if (intent.kind === "ask_card") await postAskCard(chatId, intent.message);
  };

  /**
   * 补发。recent（刚连上）：每个群只补最后 FEISHU_CATCHUP_MAX_MESSAGES 条，前面的只计数；否则只补 replaying 里的群，从水位起逐页全补。
   * 一个群出错不影响别的群：飞书拒收的那一件放弃、水位推过去；暂时性错误的群返回出来，稍后再补。
   * 最后收尾断线期间已经结束的那几轮留下的流式卡，还在写的不动。
   */
  const catchUp = async (recent: boolean, replaying: ReadonlySet<string>): Promise<Set<FeishuChatId>> => {
    const failed = new Set<FeishuChatId>();
    const routerChat = projection.routerChat();
    for (const chat of store.chats()) {
      if (!recent && !replaying.has(chat.chatId)) continue;
      if (!isReady() || closed) {
        failed.add(chat.chatId);
        continue;
      }
      try {
        if (chat.target.kind === "pm") await replayPmChat(chat, recent);
        else if (chat.chatId === routerChat?.chatId) {
          await settleRouterCards(chat);
          await replayRouterEvents(chat, recent);
          await resumeUploads(chat);
          if (store.postOf({ kind: "router_settings" })?.cardId != null) {
            await unlessRejected(() => refreshRouterSettingsCard());
          }
        }
      } catch (error) {
        if (error instanceof FeishuAuthError) throw error;
        handleError(error);
        failed.add(chat.chatId);
      }
    }
    for (const [id, slot] of streams) {
      if (activeTurns.has(id) || failed.has(slot.chatId) || !(recent || replaying.has(slot.chatId))) continue;
      await unlessRejected(() => feedStream(id, { kind: "turn_end" }, slot.chatId, slot));
    }
    return failed;
  };

  const replayPmChat = async (chat: FeishuChatBinding, recent: boolean) => {
    if (chat.target.kind !== "pm" || chat.target.pmId === null || activeTarget(chat) === null) return;
    const pmId = chat.target.pmId;
    const conversationId = conversationOfPm(pmId);
    if (conversationId === null) return;
    // 离线期间在网页上定案、被关掉的卡先改：不排在补发后面，补发哪一件出错都不挡它去掉按钮
    for (const post of store.pendingCards(pmId)) {
      if (post.ref.kind === "message") await settleAskCard(post.ref.messageId);
    }
    if (chat.lastMessageId === null) store.advanceWatermark(chat.chatId, { messageId: latestMessageId(conversationId) ?? 0 }, now());
    let after: MessageId = chat.lastMessageId ?? latestMessageId(conversationId) ?? 0;
    let skipped = 0;
    let tail: FeishuOutboundIntent[] = [];
    let scanned = after;
    for (;;) {
      const page = ledger.messagesAfter(conversationId, after, FEISHU_PAGE_SIZE);
      if (page.length === 0) break;
      if (!isReady() || closed) throw new Error("飞书断开了，补发没做完");
      if (recent) {
        const batch = catchUpIntents(conversationId, page);
        const combined = [...tail, ...batch.intents];
        tail = combined.slice(-FEISHU_CATCHUP_MAX_MESSAGES);
        skipped += batch.omitted + combined.length - tail.length;
      } else {
        const batch = catchUpIntents(conversationId, page, FEISHU_PAGE_SIZE);
        for (const intent of batch.intents) await unlessRejected(() => replayPmIntent(chat.chatId, intent));
        if (batch.lastMessageId !== null) store.advanceWatermark(chat.chatId, { messageId: batch.lastMessageId }, now());
      }
      scanned = after = page.at(-1)!.id;
      if (page.length < FEISHU_PAGE_SIZE) break;
    }
    if (recent) {
      if (skipped > 0) await sendText({ chatId: chat.chatId }, `离线期间还有 ${skipped} 条，去网页看。`);
      for (const intent of tail) await unlessRejected(() => replayPmIntent(chat.chatId, intent));
      if (scanned > (chat.lastMessageId ?? 0)) store.advanceWatermark(chat.chatId, { messageId: scanned }, now());
    }
    for (const post of store.streamingPosts(chat.chatId, FEISHU_PAGE_SIZE)) {
      if (post.ref.kind !== "message" || post.cardId === null) continue;
      const message = ledger.getMessage(post.ref.messageId);
      const effect = { kind: "finalize", cardId: post.cardId, sequence: post.sequence, messageId: post.ref.messageId, text: message === null ? "（这段回复已经删了）" : message.text } as const;
      await unlessRejected(() => finalizeSegment(chat.chatId, conversationId, effect));
    }
    await resumeUploads(chat);
    if (store.postOf({ kind: "chat_policy", pmId })?.cardId != null) {
      await unlessRejected(() => refreshPolicyCard(pmId));
    }
  };

  /** 总助单聊按完成先后补发卡片和指令回复。recent（刚连上）时只补最后 FEISHU_CATCHUP_MAX_MESSAGES 条，更早的发一行提示后跳过。 */
  const replayRouterEvents = async (chat: FeishuChatBinding, recent: boolean) => {
    const current = store.chatOfTarget({ kind: "router" });
    if (current?.chatId !== chat.chatId) return;
    let after = current.lastRouterEventId ?? 0;
    if (recent) {
      const backlog = store.routerEventBacklog(after, FEISHU_CATCHUP_MAX_MESSAGES);
      if (backlog !== null) {
        await sendText({ chatId: chat.chatId }, `离线期间还有 ${backlog.skipped} 条，去网页看。`);
        store.ackRouterEvent(chat.chatId, backlog.lastSkippedId, now());
        after = backlog.lastSkippedId;
      }
    }
    for (;;) {
      if (!isReady() || closed || store.chatById(chat.chatId) === null) return;
      const page = store.routerEventsAfter(after, FEISHU_PAGE_SIZE);
      for (const event of page) {
        await unlessRejected(async () => {
          if (event.item_id !== null) {
            const item = ledger.getRouterItem(event.item_id);
            if (item !== null) await postRouterItem(item);
          } else if (event.ask_message_id !== null) {
            const message = ledger.getMessage(event.ask_message_id);
            if (message !== null) await postRouterAskCard(message);
          } else if (event.command_id !== null) {
            const command = ledger.getRouterCommand(event.command_id);
            if (command !== null && (command.status === "answered" || command.status === "dispatched" || command.status === "failed")) await postRouterCommand(command);
          }
        });
        after = event.id;
        store.ackRouterEvent(chat.chatId, after, now());
      }
      if (page.length < FEISHU_PAGE_SIZE) return;
    }
  };

  const settleRouterItem = async (itemId: number) => {
    const post = store.postOf({ kind: "router_item", itemId });
    if (post?.state !== "card_pending" || post.cardId === null) return;
    const item = ledger.getRouterItem(itemId);
    if (item !== null) await postRouterItem(item);
    else await closeMissingCard(post);
  };

  const closeMissingCard = (post: FeishuPostRecord) => settlePost(post, renderTextCard({ title: "已关闭", text: "这张拍板卡已关闭。" }));

  const settleRouterCards = async (chat: FeishuChatBinding) => {
    if (store.chatOfTarget({ kind: "router" })?.chatId !== chat.chatId) return;
    for (const post of store.pendingCards(null)) {
      if (post.ref.kind === "router_item") await settleRouterItem(post.ref.itemId);
      else if (post.ref.kind === "router_ask") await settleRouterAskCard(post.ref.messageId);
    }
  };

  /** 停机前排空：排着的出站发完，还在流式的卡收尾（关流式、去停止按钮）；最多等 FEISHU_CLOSE_DRAIN_MS，到点照样断开。 */
  const drainBeforeClose = async () => {
    if (!isReady()) return;
    const drained = (async () => {
      await whenIdle(false);
      for (const [id, slot] of streams) {
        admit(outbound, slot.chatId, { key: null, run: () => feedStream(id, { kind: "turn_end" }, slot.chatId, slot), mark: null }, Infinity);
      }
      await whenIdle(false);
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([drained, new Promise((resolve) => { timer = setTimeout(resolve, FEISHU_CLOSE_DRAIN_MS); })]);
    clearTimeout(timer);
  };

  // ---- 入站 ----

  const onRawEvent = (raw: FeishuRawEvent, queuedAt: number | null) => {
    const app = store.app();
    if (app === null) return;
    const event = parseFeishuEvent(raw, app.botOpenId);
    if (event === null) return;
    if (closed) return;
    if (event.kind === "chat_gone") {
      applyChatGone(event.chatId);
      return;
    }
    const limit = event.kind === "message" ? inbound.limit : Math.floor(inbound.limit / 2);
    if (!admit(inbound, event.chatId, inboundTask(() => handleInbound(event, queuedAt)), limit)) {
      if (isReady() && !closed && event.kind === "message") {
        if (event.at > 0) noteInboundQueueDrop(event.chatId, event.at);
        log(`飞书：实时入站队列已满 chatId=${event.chatId} dropped=1 limit=${limit} firstDroppedId=${event.messageId}`);
      }
      directory.markAllStale();
      lastError = "飞书入站队列已满，请重发未收到回复的消息";
    }
  };

  const isBindCode = (text: string) => bindCode !== null && bindCode.expiresAt > now() && text.trim() === bindCode.code;

  const bundledCatalogs = AGENT_VENDORS.map(bundledModelCatalog);
  const peekCatalogs = (): readonly ModelCatalog[] => {
    const m = options.models;
    if (!m?.current && !m?.availability) return bundledCatalogs;
    return AGENT_VENDORS.map((vendor) => m.current?.(vendor) ?? { ...bundledModelCatalog(vendor), availability: m.availability?.(vendor) ?? "unknown" });
  };
  const loadVendorCatalogs = async (vendor: AgentVendor): Promise<readonly ModelCatalog[]> => {
    if (!options.models) return bundledCatalogs;
    const listed = await options.models.list({ vendor });
    const byVendor = new Map(listed.map((c) => [c.vendor, c]));
    return peekCatalogs().map((c) => byVendor.get(c.vendor) ?? c);
  };
  const isCatalogWarm = (vendor: AgentVendor) =>
    options.models === undefined || options.models.current === undefined || options.models.current(vendor) !== null;
  const pmAgentView = (pmId: PmId): FeishuPmModelView => {
    const persona = ledger.getPersona(pmId);
    return { vendor: persona.vendor, model: persona.model, effort: persona.effort, switchingToVendor: persona.switchingToVendor };
  };
  const schedulePolicyCardRefresh = (chatId: FeishuChatId, pmId: PmId) => {
    if (store.postOf({ kind: "chat_policy", pmId })?.cardId != null) {
      enqueue(chatId, () => refreshPolicyCard(pmId), { key: `policy_card:${pmId}` });
    }
  };
  const scheduleRouterSettingsCardRefresh = (chatId: FeishuChatId) => {
    if (store.postOf({ kind: "router_settings" })?.cardId != null) {
      enqueue(chatId, () => refreshRouterSettingsCard(), { key: "router_settings_card" });
    }
  };
  let catalogRefreshInflight: Promise<void> | null = null;
  const pendingCatalogRefreshPms = new Set<PmId>();
  let pendingCatalogRefreshRouter = false;
  const refreshCatalogsInBackground = (target: FeishuChatTarget) => {
    if (!options.models || closed || closing !== null || !isReady()) return;
    if (target.kind === "pm") pendingCatalogRefreshPms.add(target.pmId);
    else pendingCatalogRefreshRouter = true;
    if (catalogRefreshInflight !== null) return;
    const before = peekCatalogs();
    catalogRefreshInflight = options.models
      .list({ refresh: "unusable" })
      .then(() => {
        if (closed || closing !== null || !isReady() || isDeepStrictEqual(peekCatalogs(), before)) return;
        for (const pmId of pendingCatalogRefreshPms) {
          const chat = liveChatOfPm(pmId);
          if (chat !== null) schedulePolicyCardRefresh(chat.chatId, pmId);
        }
        if (pendingCatalogRefreshRouter) {
          const chat = projection.routerChat();
          if (chat !== null) scheduleRouterSettingsCardRefresh(chat.chatId);
        }
      })
      .catch((error: unknown) => {
        if (!closed) log(`飞书：后台刷新模型目录出错：${errorText(error)}`);
      })
      .finally(() => {
        pendingCatalogRefreshPms.clear();
        pendingCatalogRefreshRouter = false;
        catalogRefreshInflight = null;
      });
  };

  const postPolicyCard = async (chat: FeishuChatBinding, uuid = `fusa-p-${randomUUID()}`) => {
    const target = activeTarget(chat);
    if (target?.kind !== "pm") return;
    const pmId = target.pmId;
    const ref: FeishuPostRef = { kind: "chat_policy", pmId };
    const previous = store.postOf(ref);
    directory.notePolicyCard(chat.chatId, now());
    const posted = await postCardEntity(
      chat.chatId,
      renderChatPolicyCard({
        pmId,
        agent: pmAgentView(pmId),
        catalogs: peekCatalogs(),
        triggerMode: chat.triggerMode,
        guestTier: chat.guestTier,
        mentionOnlyForced: mentionOnly,
      }),
      uuid,
    );
    if (activeTarget(store.chatById(chat.chatId)) === null) return;
    store.savePost({ ref, chatId: chat.chatId, messageId: posted.messageId, cardId: posted.cardId, sequence: previous?.sequence ?? 0, state: "final" }, now());
    await pinQuietly("pin.create", posted.messageId);
    if (previous !== null && previous.messageId !== posted.messageId) await pinQuietly("pin.delete", previous.messageId);
  };

  const refreshPolicyCard = async (pmId: PmId) => {
    const chat = liveChatOfPm(pmId);
    const post = store.postOf({ kind: "chat_policy", pmId });
    if (chat === null || post === null || post.cardId === null || transport === null) return;
    const nextSeq = post.sequence + 1;
    store.savePost({ ...post, sequence: nextSeq }, now());
    await updateCard(
      post.cardId,
      nextSeq,
      renderChatPolicyCard({
        pmId,
        agent: pmAgentView(pmId),
        catalogs: peekCatalogs(),
        triggerMode: chat.triggerMode,
        guestTier: chat.guestTier,
        mentionOnlyForced: mentionOnly,
      }),
    );
  };

  const postRouterSettingsCard = async (chat: FeishuChatBinding, uuid = `fusa-rs-${randomUUID()}`) => {
    if (activeTarget(chat)?.kind !== "router") return;
    const ref: FeishuPostRef = { kind: "router_settings" };
    const previous = store.postOf(ref);
    const posted = await postCardEntity(
      chat.chatId,
      renderRouterSettingsCard({ settings: ledger.getRouterSettings(), catalogs: peekCatalogs() }),
      uuid,
    );
    if (activeTarget(store.chatById(chat.chatId))?.kind !== "router") return;
    store.savePost({ ref, chatId: chat.chatId, messageId: posted.messageId, cardId: posted.cardId, sequence: previous?.sequence ?? 0, state: "final" }, now());
    await pinQuietly("pin.create", posted.messageId);
    if (previous !== null && previous.messageId !== posted.messageId) await pinQuietly("pin.delete", previous.messageId);
  };

  const refreshRouterSettingsCard = async () => {
    const chat = store.chatOfTarget({ kind: "router" });
    const post = store.postOf({ kind: "router_settings" });
    if (chat === null || post === null || post.cardId === null || transport === null) return;
    const nextSeq = post.sequence + 1;
    store.savePost({ ...post, sequence: nextSeq }, now());
    await updateCard(post.cardId, nextSeq, renderRouterSettingsCard({ settings: ledger.getRouterSettings(), catalogs: peekCatalogs() }));
  };

  const pinQuietly = async (method: "pin.create" | "pin.delete", messageId: FeishuMessageId) => {
    try {
      await api(method, { message_id: messageId });
    } catch (error) {
      log(`飞书：${method === "pin.create" ? "置顶" : "取消置顶"}设置卡没成，卡照常可用：${errorText(error)}`);
    }
  };

  const offerPolicyCard = async (chatId: FeishuChatId) => {
    const chat = store.chatById(chatId);
    if (chat === null || activeTarget(chat)?.kind !== "pm" || !directory.policyCardDue(chatId, now())) return;
    await postPolicyCard(chat);
  };

  const applyChatGone = (chatId: FeishuChatId) => {
    clearChatRuntime(chatId);
    const chat = store.chatById(chatId);
    if (chat === null || chat.archivedAt !== null) return;
    if (chat.target.kind === "router") {
      store.removeChat(chatId);
      return;
    }
    // 记成“已解散”而不是删掉：唤醒方式和访客档位留着，下一次对齐按这个时间当 generation 重建（建群 uuid 不会撞上 10 小时内的旧请求）
    store.setChatArchived(chatId, dissolvedAt(chat.target.pmId), now());
    requestControl("sync");
  };

  const handleInbound = async (event: Exclude<FeishuInbound, { kind: "chat_gone" }>, queuedAt: number | null) => {
    const o = owner();
    switch (event.kind) {
      case "members_added": {
        directory.applyJoined(event.chatId, event.openIds.map((openId) => ({ openId, name: "" })), now());
        const chat = store.chatById(event.chatId);
        const target = activeTarget(chat);
        const firstGuest = target?.kind === "pm" && o !== null && event.openIds.some((id) => id !== o) && store.postOf({ kind: "chat_policy", pmId: target.pmId }) === null;
        if (chat !== null && firstGuest) await postPolicyCard(chat, `fusa-p-${chat.chatId}`);
        return;
      }
      case "members_removed":
        directory.applyLeft(event.chatId, event.openIds, now());
        return;
      case "chat_renamed":
        if (store.chatById(event.chatId) !== null) store.renameChat(event.chatId, event.name, null, now());
        return;
      case "message":
        return handleMessage(event, queuedAt);
    }
  };

  const handleMessage = async (message: Extract<FeishuInbound, { kind: "message" }>, queuedAt: number | null) => {
    if (seenInboundMessages.has(message.messageId)) return;
    const recordSeen = () => {
      seenInboundMessages.set(message.messageId, true);
      const holdAt = inboundCursorHold.get(message.chatId);
      if (
        message.at > 0 &&
        !inboundGateEpochs.has(message.chatId) &&
        (holdAt === undefined || message.at < holdAt) &&
        store.chatById(message.chatId) !== null
      ) {
        store.saveInboundCursor(message.chatId, { lastInboundAt: message.at, lastMessageId: message.messageId }, now());
      }
    };
    const o = owner();
    const t = now();
    if (message.chatType === "p2p" && o !== null && message.senderOpenId === o && store.chatOfTarget({ kind: "router" }) === null) {
      store.upsertChat({ chatId: message.chatId, target: { kind: "router" }, name: "总助", label: "总助" }, t);
      store.saveInboundCursor(message.chatId, { lastInboundAt: t, lastMessageId: null }, t);
    }
    const chat = store.chatById(message.chatId);
    const target = activeTarget(chat);
    const group = message.chatType === "group" && target?.kind === "pm";
    const mode = group && o !== null ? await directory.modeOf(message.chatId, o, message.senderOpenId, t) : "solo";
    if (message.chatType === "p2p" && message.senderOpenId === o && target?.kind !== "router") {
      recordSeen();
      return;
    }
    const speakerName = group ? await directory.nameOf(message.chatId, message.senderOpenId, "", t) : message.senderOpenId === o ? displayOwner() : "";
    const route = routeFeishuMessage(message, {
      ownerOpenId: o,
      binding: group ? { target, archived: false } : null,
      mode,
      triggerMode: chat?.triggerMode ?? "auto",
      guestTier: chat?.guestTier ?? "chat_only",
      mentionOnlyForced: mentionOnly,
      speakerName: feishuDisplayName(speakerName),
      pendingContext: contexts.peek(message.chatId, t),
      pendingFiles: contexts.peekFiles(message.chatId, t),
      isBindCode,
    });
    switch (route.kind) {
      case "ignore":
        recordSeen();
        return;
      case "bind_owner":
        bindCode = null;
        store.bindOwner(route.openId, t);
        store.upsertChat({ chatId: message.chatId, target: { kind: "router" }, name: "总助", label: "总助" }, t);
        store.saveInboundCursor(message.chatId, { lastInboundAt: message.at > 0 ? message.at : t, lastMessageId: message.messageId }, t);
        seenInboundMessages.set(message.messageId, true);
        await sendText({ chatId: message.chatId }, "认好了：你是这个机器人的主人。在这里和总助说话；每个项目经理会有自己的项目群。");
        broadcastPeerApp();
        requestControl("sync");
        return;
      case "reject":
        await sendText({ chatId: message.chatId }, message.chatType === "p2p" ? route.reason : `<at user_id="${route.openId}"></at> ${route.reason}`);
        if (route.reason === GUEST_NO_FILES) contexts.dropFiles(message.chatId, (file) => file.speaker === route.openId);
        if (route.guestDenied === true) await offerPolicyCard(message.chatId);
        recordSeen();
        return;
      case "settings_card":
        if (chat !== null) {
          if (target?.kind === "pm") {
            await postPolicyCard(chat);
            refreshCatalogsInBackground(target);
          } else if (target?.kind === "router") {
            await postRouterSettingsCard(chat);
            refreshCatalogsInBackground(target);
          }
        }
        recordSeen();
        return;
      case "context":
        contexts.add(message.chatId, route.line, message.files.map((file) => ({ messageId: message.messageId, speaker: message.senderOpenId, file, at: message.at })));
        recordSeen();
        return;
      case "deliver": {
        const clientId = `${FEISHU_CLIENT_PREFIX}${message.messageId}`;
        if (route.target.kind === "router") {
          if (db.get("SELECT 1 FROM router_commands WHERE client_id = ?", clientId) !== undefined) {
            recordSeen();
            return;
          }
        } else {
          const existingConvId = conversationOfPm(route.target.pmId);
          if (existingConvId !== null && db.get("SELECT 1 FROM messages WHERE dedupe_key = ?", userMessageDedupeKey(existingConvId, clientId)) !== undefined) {
            recordSeen();
            return;
          }
        }
        // 超过上限、下载失败的文件回一句；收下的附件和正文都没有时不投递（账本、总助都不收空消息）
        const attachments = [];
        const missed: string[] = [];
        for (const { messageId, file } of route.files) {
          const saved = await files?.receive(messageId, file);
          if (saved) attachments.push(saved);
          else missed.push(file.fileName ?? (file.type === "image" ? "图片" : "文件"));
        }
        // 下载过的、被拒收的待收文件已经处置过，后面提前返回也不能留在近窗里让下一次 @ 再下一遍、再报一遍
        const handled = new Set(route.files.map(({ messageId }) => messageId));
        contexts.dropFiles(message.chatId, (file) => handled.has(file.messageId) || (route.droppedFiles > 0 && file.speaker === message.senderOpenId));
        const at = message.chatType === "group" && message.senderOpenId !== o ? `<at user_id="${message.senderOpenId}"></at> ` : "";
        if (missed.length > 0) await sendText({ chatId: message.chatId }, `${at}${missedFilesText(missed)}`);
        if (route.droppedFiles > 0) {
          await sendText({ chatId: message.chatId }, `${at}${GUEST_NO_FILES}`);
          await offerPolicyCard(message.chatId);
        }
        if (route.text === "" && attachments.length === 0) {
          recordSeen();
          return;
        }
        const deliveredText =
          queuedAt === null
            ? route.text
            : route.text === ""
              ? formatOfflineQueuedPrefix(queuedAt)
              : `${formatOfflineQueuedPrefix(queuedAt)}\n${route.text}`;
        if (route.target.kind === "router") {
          if (options.router === null) {
            await sendText({ chatId: message.chatId }, "总助没开：去网页的总助工作台选一家 agent。");
            recordSeen();
            return;
          }
          try {
            await options.router.submitCommand({ clientId, text: deliveredText, ...(attachments.length > 0 ? { attachmentIds: attachments.map((a) => a.id) } : {}) });
            recordSeen();
          } catch (error) {
            if (!(error instanceof LedgerRequestError)) throw error;
            await sendText({ chatId: message.chatId }, `没送到：${error.message}`);
            recordSeen();
          }
          return;
        }
        if (activeTarget(store.chatById(message.chatId))?.kind !== "pm") {
          recordSeen();
          return;
        }
        const conversationId = conversationOfPm(route.target.pmId);
        if (conversationId === null) {
          recordSeen();
          return;
        }
        try {
          ledger.postUserMessage({ conversationId, clientId, text: deliveredText, ...(attachments.length > 0 ? { attachments } : {}), origin: route.origin });
          contexts.clear(message.chatId);
          recordSeen();
        } catch (error) {
          if (error instanceof LedgerRequestError || error instanceof ConversationNotFoundError) {
            await sendText({ chatId: message.chatId }, `没送到：${error.message}`);
            recordSeen();
            return;
          }
          throw error;
        }
        return;
      }
    }
  };

  const postedCardRef = (post: NonNullable<ReturnType<typeof store.postByMessageId>>, target: FeishuChatTarget): FeishuCardRef | null => {
    const { ref } = post;
    if (post.state !== "card_pending" && post.state !== "card_settled") return null;
    if (ref.kind === "message" && ref.part === 0 && target.kind === "pm") {
      const message = ledger.getMessage(ref.messageId);
      if (message === null || pmOfConversation(message.conversationId) !== target.pmId) return null;
      const ask = askOf(message);
      return ask === null ? null : feishuCardRefOf(message, ask);
    }
    if (ref.kind === "router_ask" && target.kind === "router") {
      const message = ledger.getMessage(ref.messageId);
      const pmId = message === null ? null : pmOfConversation(message.conversationId);
      if (message === null || pmId === null || !isActivePm(pmId)) return null;
      const ask = askOf(message);
      return ask === null ? null : feishuCardRefOf(message, ask);
    }
    if (ref.kind !== "router_item" || target.kind !== "router") return null;
    const item = ledger.getRouterItem(ref.itemId);
    if (item?.kind !== "decision" || !isActivePm(item.pmId)) return null;
    if (item.askMessageId === null) return { kind: "router_item", itemId: item.id };
    const message = ledger.getMessage(item.askMessageId);
    if (message === null || pmOfConversation(message.conversationId) !== item.pmId) return null;
    const ask = askOf(message);
    return ask === null ? null : feishuCardRefOf(message, ask);
  };

  /** 点的是不是这个群自己发出、还归这个群的项目经理管的卡：只信本地发送记录和账本，不信按钮里带的编号。 */
  const ownsAction = (action: FeishuInboundAction, target: FeishuChatTarget): boolean => {
    const { value, chatId, messageId } = action;
    if (value.kind === "mesh_approval") {
      if (target.kind !== "router") return false;
      const tracked = approvalCards.get(value.requestId);
      return tracked !== undefined && !tracked.settled && tracked.messageId === messageId;
    }
    if (value.kind === "stop") {
      if (target.kind !== "pm" || pmOfConversation(value.conversationId) !== target.pmId) return false;
      const slot = streams.get(value.conversationId);
      return slot?.chatId === chatId && slot.state.phase === "live" && slot.posted?.messageId === messageId;
    }
    const post = store.postByMessageId(messageId);
    if (post === null || post.chatId !== chatId || post.cardId === null) return false;
    if (value.kind === "set_policy" || value.kind === "set_pm_model") {
      return target.kind === "pm" && post.ref.kind === "chat_policy" && post.ref.pmId === target.pmId && value.pmId === target.pmId;
    }
    if (value.kind === "set_router_model") {
      return target.kind === "router" && post.ref.kind === "router_settings";
    }
    const ref = postedCardRef(post, target);
    if (ref === null || !isDeepStrictEqual(ref, value.card)) return false;
    if (ref.kind === "gate") {
      return db.get(`SELECT 1 FROM task_graphs g JOIN projects p ON p.id = g.project_id
        JOIN messages m ON m.id = ? AND m.conversation_id = g.conversation_id
        WHERE g.id = ? AND p.status = 'active'`, ref.askMessageId, ref.graphId) !== undefined;
    }
    if (ref.kind === "blocker") {
      return value.kind === "blocker_done" && db.get("SELECT 1 FROM user_blocker_cards WHERE message_id = ? AND blocker_id = ?", ref.askMessageId, ref.blockerId) !== undefined;
    }
    if (ref.kind === "router_item" || ref.kind === "ask") {
      const row = ref.kind === "router_item"
        ? db.get<{ active: number }>(`SELECT r.project_id IS NULL OR p.status = 'active' AS active
            FROM router_items r LEFT JOIN projects p ON p.id = r.project_id WHERE r.id = ?`, ref.itemId)
        : db.get<{ active: number }>(`SELECT r.project_id IS NULL OR p.status = 'active' AS active
            FROM router_items r LEFT JOIN projects p ON p.id = r.project_id WHERE r.ask_message_id = ? ORDER BY r.id DESC LIMIT 1`, ref.askMessageId);
      return row?.active === 1;
    }
    return true;
  };

  const onRawCardAction = (raw: FeishuRawCardAction): FeishuCardActionResponse => {
    const started = now();
    const action = parseFeishuCardAction(raw);
    const chat = action === null ? null : store.chatById(action.chatId);
    const target = activeTarget(chat);
    if (action === null || target === null || chat === null) return toast("warning", "这张卡已过期，去网页看");
    const route = routeFeishuAction(action, {
      ownerOpenId: owner(),
      binding: { target, archived: false },
      guestTier: chat.guestTier,
    });
    if (route.kind !== "ignore" && route.kind !== "reject" && !ownsAction(action, target)) {
      const isSettings = action.value.kind === "set_policy" || action.value.kind === "set_pm_model" || action.value.kind === "set_router_model";
      const staleToast = action.value.kind === "set_router_model" ? STALE_ROUTER_SETTINGS_CARD : STALE_POLICY_CARD;
      return toast("warning", isSettings ? staleToast : "这张卡已过期，去网页看");
    }
    const response = applyAction(route, action.operatorOpenId, action.chatId);
    if (now() - started > FEISHU_CARD_ACTION_DEADLINE_MS) log(`飞书：卡片点击处理了 ${now() - started} 毫秒，超过 ${FEISHU_CARD_ACTION_DEADLINE_MS}`);
    return response;
  };

  const toast = (type: "success" | "info" | "warning" | "error", content: string): FeishuCardActionResponse => ({ toast: { type, content } });

  const applyAction = (route: FeishuActionRoute, operator: FeishuOpenId, chatId: FeishuChatId): FeishuCardActionResponse => {
    try {
      switch (route.kind) {
        case "ignore":
          return {};
        case "reject":
          if (route.guestDenied === true) admit(inbound, chatId, inboundTask(() => offerPolicyCard(chatId)));
          return toast("warning", route.toast);
        case "stop": {
          if (route.target.kind !== "pm") return {};
          const conversationId = conversationOfPm(route.target.pmId);
          if (conversationId !== null) ledger.requestStop(conversationId);
          return toast("info", "正在停");
        }
        case "mesh_approval": {
          const meshHooks = options.mesh;
          if (meshHooks === undefined) return toast("warning", "这张卡已过期，去网页看");
          const admitted = admit(
            inbound,
            chatId,
            inboundTask(async () => {
              try {
                if (route.step === "begin") await meshHooks.beginApproval(route.requestId);
                else await meshHooks.answerApproval(route.requestId, route.step === "match");
              } catch (error) {
                await sendText({ chatId }, `核对没成：${errorText(error)}`).catch(() => {});
              }
            }),
          );
          if (!admitted) return toast("warning", "飞书正忙，请再点一次");
          return toast("info", route.step === "begin" ? "正在生成核对码" : route.step === "match" ? "已确认一致" : "已拒绝");
        }
        case "set_policy": {
          const admitted = admit(inbound, chatId, inboundTask(async () => {
            if (activeTarget(store.chatById(chatId)) === null) return;
            await setup.setChatPolicy({ pmId: route.pmId, ...(route.triggerMode ? { triggerMode: route.triggerMode } : {}), ...(route.guestTier ? { guestTier: route.guestTier } : {}) });
          }));
          return admitted ? toast("success", "已改") : toast("warning", "飞书正忙，请再点一次");
        }
        case "set_pm_model": {
          const current = pmAgentView(route.pmId);
          const targetVendor = route.field === "vendor" && isAgentVendor(route.option) ? route.option : current.vendor;
          const switchingBlocked = route.field === "vendor" && current.switchingToVendor != null;
          if (!switchingBlocked && !isCatalogWarm(targetVendor)) {
            const admitted = admit(inbound, chatId, inboundTask(async () => {
              if (activeTarget(store.chatById(chatId))?.kind !== "pm") return;
              try {
                const catalogs = await loadVendorCatalogs(targetVendor);
                const resolved = resolvePmModelEdit(pmAgentView(route.pmId), catalogs, route.field, route.option);
                if (!resolved.ok) {
                  await sendText({ chatId }, resolved.toast);
                  schedulePolicyCardRefresh(chatId, route.pmId);
                  return;
                }
                const res = ledger.editPersona(route.pmId, resolved.next, { kind: "user" });
                if (res.change === null) schedulePolicyCardRefresh(chatId, route.pmId);
              } catch (error) {
                const message = error instanceof LedgerRequestError ? error.message : "修改模型设置出错了，去网页看看";
                if (!(error instanceof LedgerRequestError)) log(`飞书：异步改项目经理模型出错：${errorText(error)}`);
                await unlessRejected(() => sendText({ chatId }, message).then(() => undefined));
                schedulePolicyCardRefresh(chatId, route.pmId);
              }
            }));
            return admitted ? toast("info", "正在读取模型目录…") : toast("warning", "飞书正忙，请再点一次");
          }
          const resolved = resolvePmModelEdit(current, peekCatalogs(), route.field, route.option);
          if (!resolved.ok) {
            schedulePolicyCardRefresh(chatId, route.pmId);
            return toast("warning", resolved.toast);
          }
          let res;
          try {
            res = ledger.editPersona(route.pmId, resolved.next, { kind: "user" });
          } catch (error) {
            schedulePolicyCardRefresh(chatId, route.pmId);
            throw error;
          }
          if (res.change === null) {
            schedulePolicyCardRefresh(chatId, route.pmId);
          }
          return route.field === "vendor" && res.persona.switchingToVendor != null
            ? toast("info", `已设成 ${vendorLabel(res.persona.switchingToVendor)}，当前这一轮跑完切换`)
            : toast("success", "已改");
        }
        case "set_router_model": {
          const settings = ledger.getRouterSettings();
          const targetVendor = route.field === "vendor" ? (isAgentVendor(route.option) ? route.option : null) : settings.vendor;
          if (targetVendor !== null && !isCatalogWarm(targetVendor)) {
            const admitted = admit(inbound, chatId, inboundTask(async () => {
              if (activeTarget(store.chatById(chatId))?.kind !== "router") return;
              try {
                const catalogs = await loadVendorCatalogs(targetVendor);
                const resolved = resolveRouterModelEdit(ledger.getRouterSettings(), catalogs, route.field, route.option);
                if (!resolved.ok) {
                  await sendText({ chatId }, resolved.toast);
                  scheduleRouterSettingsCardRefresh(chatId);
                  return;
                }
                ledger.updateRouterSettings(resolved.next);
              } catch (error) {
                const message = error instanceof LedgerRequestError ? error.message : "修改模型设置出错了，去网页看看";
                if (!(error instanceof LedgerRequestError)) log(`飞书：异步改总助模型出错：${errorText(error)}`);
                await unlessRejected(() => sendText({ chatId }, message).then(() => undefined));
                scheduleRouterSettingsCardRefresh(chatId);
              }
            }));
            return admitted ? toast("info", "正在读取模型目录…") : toast("warning", "飞书正忙，请再点一次");
          }
          const resolved = resolveRouterModelEdit(settings, peekCatalogs(), route.field, route.option);
          if (!resolved.ok) {
            scheduleRouterSettingsCardRefresh(chatId);
            return toast("warning", resolved.toast);
          }
          try {
            ledger.updateRouterSettings(resolved.next);
          } catch (error) {
            scheduleRouterSettingsCardRefresh(chatId);
            throw error;
          }
          return toast("success", "已改");
        }
        case "blocker_done": {
          // 重问厂商要跑它的命令行，可能超过回调时限：先回 toast，排队去查；解开了账本推变化，这张卡跟着改
          const blockerId = route.card.blockerId;
          const askMsg = ledger.getMessage(route.card.askMessageId);
          if (ledger.userBlockerVendor(blockerId) === null || (askMsg !== null && askOf(askMsg)?.answered === true)) {
            return toast("info", ALREADY_DECIDED);
          }
          const admitted = admit(inbound, chatId, inboundTask(() => recheckBlocker(chatId, blockerId)));
          return admitted ? toast("info", "正在重查，能用了这张卡会自己改") : toast("warning", "飞书正忙，请再点一次");
        }
        case "answer": {
          const name = operator === owner() ? displayOwner() : (directory.peekMembers(chatId)?.find((m) => m.openId === operator)?.name || "访客");
          const previous = decisionOf(route.card);
          if (previous?.clientId === route.clientId) return toast("success", "已定案");
          answerCard(route, () => store.saveDecision(route.card, route.clientId, feishuDisplayName(name), now()));
          return toast("success", "已定案");
        }
      }
    } catch (error) {
      if (error instanceof LedgerRequestError && error.code === "conflict") return toast("info", ALREADY_DECIDED);
      if (error instanceof LedgerRequestError) return toast("warning", error.message);
      log(`飞书：处理卡片点击出错：${errorText(error)}`);
      return toast("error", "出错了，去网页看看");
    }
  };

  const recheckBlocker = async (chatId: FeishuChatId, blockerId: UserBlockerId) => {
    const vendor = ledger.userBlockerVendor(blockerId);
    if (vendor !== null && options.models !== undefined) await options.models.list({ vendor, refresh: true });
    if (ledger.recheckUserBlocker(blockerId).resolved) return;
    if (activeTarget(store.chatById(chatId)) !== null) await sendText({ chatId }, "还不能用，卡先留着：在电脑上处理好再点一次「已处理」。");
  };

  const answerCard = (route: Extract<FeishuActionRoute, { kind: "answer" }>, onDecisionWritten: () => void) => {
    const { card, optionIndex, note, clientId } = route;
    if (card.kind === "router_item") {
      ledger.resolveRouterItem(card.itemId, { clientId, ...(optionIndex !== null ? { optionIndex } : {}), ...(note !== null ? { note } : {}) }, onDecisionWritten);
      return;
    }
    const message = ledger.getMessage(card.askMessageId);
    const ask = message === null ? null : askOf(message);
    if (ask === null) throw new LedgerRequestError("not_found", "这张卡已经不在了");
    if (card.kind === "blocker") throw new LedgerRequestError("invalid", "这张卡只能标记已处理");
    const choice = optionIndex === null ? null : (feishuAskOptions(ask)[optionIndex] ?? null);
    if (optionIndex !== null && choice === null) throw new LedgerRequestError("invalid", "选项不在有效范围内");
    if (card.kind === "gate") {
      if (ask.answered === true || ask.closed === true) throw new LedgerRequestError("conflict", ALREADY_DECIDED);
      ledger.decideTaskNode(card.graphId, card.nodeKey, { clientId, choice, note }, onDecisionWritten);
      return;
    }
    ledger.answerAsk(card.askMessageId, { clientId, choice, ...(note !== null ? { note } : {}) }, onDecisionWritten);
  };

  // ---- 设置 ----

  const setup: FeishuSetupService = {
    status,
    async startRegistration() {
      registration?.abort.abort();
      registration = null;
      const abort = new AbortController();
      let resolveUrl!: () => void;
      const urlReady = new Promise<void>((resolve) => (resolveUrl = resolve));
      const register = await registerFn();
      const done = register({
        preset: feishuAppPreset(options.device.name),
        addons: FEISHU_APP_ADDONS,
        signal: abort.signal,
        handlers: {
          onUrl: (info) => {
            if (abort.signal.aborted) return;
            registration = { url: info.url, expiresAt: info.expiresAt, abort };
            resolveUrl();
          },
        },
      });
      void done.then(
        async (result) => {
          if (abort.signal.aborted) return;
          connectingCount++;
          registration = null;
          try {
            await connectWith({ brand: result.brand, appId: result.appId, appSecret: result.appSecret }, parseFeishuOpenId(result.scannerOpenId));
          } catch (error) {
            handleError(error);
          } finally {
            connectingCount--;
            settleIdle();
          }
        },
        (error: unknown) => {
          if (abort.signal.aborted) return;
          registration = null;
          const code = error instanceof FeishuRegistrationError ? error.code : "error";
          log(`飞书：扫码建应用没成：${errorText(error)}`);
          lastError = code === "access_denied" ? "扫码后点了拒绝" : code === "expired_token" ? "二维码过期了，重新扫一次" : "扫码建应用没成，重新扫一次；还不行看日志";
        },
      );
      await Promise.race([urlReady, done.then(() => undefined, () => undefined)]);
      return status();
    },
    cancelRegistration() {
      registration?.abort.abort();
      registration = null;
      return status();
    },
    async saveCredentials(input) {
      await connectWith({ brand: input.brand, appId: input.appId.trim(), appSecret: input.appSecret.trim() }, null);
      return status();
    },
    issueBindCode(): FeishuBindCodeResponse {
      const app = store.app();
      if (app === null) throw new FeishuSetupError("还没接飞书应用");
      if (app.ownerOpenId !== null) throw new FeishuSetupError("已经认过主人了；要换主人先断开");
      bindCode = { code: String(randomInt(0, 1_000_000)).padStart(6, "0"), expiresAt: now() + FEISHU_BIND_CODE_TTL_MS };
      return { ...bindCode };
    },
    consumeBindCode(text, at) {
      if (bindCode === null || bindCode.expiresAt <= at || text.trim() !== bindCode.code) return false;
      bindCode = null;
      return true;
    },
    async setChatPolicy(input) {
      let chat: FeishuChatBinding;
      try {
        chat = store.setChatPolicy(input.pmId, { ...(input.triggerMode ? { triggerMode: input.triggerMode } : {}), ...(input.guestTier ? { guestTier: input.guestTier } : {}) }, now());
      } catch {
        throw new FeishuSetupError("这个项目经理还没有飞书群");
      }
      await refreshPolicyCard(input.pmId);
      return chatView(chat)!;
    },
    async resync() {
      if (transport === null || !isReady()) throw new FeishuSetupError("飞书没连上");
      directory.markAllStale();
      await checkScopes();
      await ensureRouterChat();
      if (!(await syncChats())) retrySyncLater();
      return status();
    },
    async disconnect(input) {
      await disconnectLocal(input.dissolveChats);
      lastDisconnectedAt = now();
      lastDissolveChats = input.dissolveChats;
      broadcastPeerApp();
      return status();
    },
  };

  const disconnectLocal = async (dissolveChats: boolean) => {
    registration?.abort.abort();
    registration = null;
    if (dissolveChats && transport !== null) {
      for (const chat of store.chats()) {
        if (chat.target.kind === "pm" && chat.archivedAt === null) await deleteChat(chat.chatId).catch((error: unknown) => log(`飞书：解散群出错：${errorText(error)}`));
      }
    }
    secrets = null;
    bindCode = null;
    lastError = null;
    authFailed = false;
    missing = [];
    mentionOnly = false;
    ownerName = null;
    syncedRouterChatId = null;
    hadLiveSession = false;
    seenInboundMessages.clear();
    inboundCursorHold.clear();
    options.lease?.refresh();
    await syncTransport();
    await removeFeishuSecrets(options.secretsFile);
    store.clear();
    directory.clear();
    contexts.clearAll();
    pendingCatalogRefreshPms.clear();
    pendingCatalogRefreshRouter = false;
  };

  return {
    setup,
    useAccountBot(bot) {
      accountBot = bot;
      bot.learnChats(options.device.id, localPmChats());
    },
    eligibleForLease: () => !closed && secrets !== null && store.app()?.enabled === true && !authFailed,
    syncLeaseConnection: () => syncTransport(),
    exportPeerApp,
    async applyPeerApp(sync) {
      if (sync.kind === "disconnected") {
        const cur = store.app();
        if (cur !== null && sync.updatedAt < cur.updatedAt) return;
        lastDisconnectedAt = Math.max(lastDisconnectedAt ?? 0, sync.updatedAt);
        lastDissolveChats = sync.dissolveChats;
        if (cur === null && secrets === null) return;
        await disconnectLocal(sync.dissolveChats);
        broadcastPeerApp();
        return;
      }
      if (lastDisconnectedAt !== null && sync.updatedAt < lastDisconnectedAt) return;
      const cur = store.app();
      if (
        cur !== null &&
        secrets !== null &&
        cur.enabled &&
        cur.appId === sync.appId &&
        cur.brand === sync.brand &&
        secrets.appSecret === sync.appSecret &&
        cur.botOpenId === sync.botOpenId &&
        cur.botName === sync.botName &&
        cur.ownerOpenId === sync.ownerOpenId
      ) {
        if (sync.routerChatId !== null && store.chatOfTarget({ kind: "router" }) === null) {
          const t = now();
          syncedRouterChatId = sync.routerChatId;
          store.upsertChat({ chatId: sync.routerChatId, target: { kind: "router" }, name: "总助", label: "总助" }, t);
          store.saveInboundCursor(sync.routerChatId, { lastInboundAt: t, lastMessageId: null }, t);
          ackAllRouterEvents();
        }
        return;
      }
      lastDisconnectedAt = null;
      const nextSecrets: FeishuSecrets = { brand: sync.brand, appId: sync.appId, appSecret: sync.appSecret };
      await writeFeishuSecrets(options.secretsFile, nextSecrets);
      secrets = nextSecrets;
      if (cur !== null && cur.appId !== sync.appId) {
        directory.clear();
        contexts.clearAll();
        seenInboundMessages.clear();
        inboundCursorHold.clear();
        hadLiveSession = false;
        syncedRouterChatId = null;
      }
      const stamp = Math.max(now(), sync.updatedAt);
      store.saveApp(
        { appId: sync.appId, brand: sync.brand, botOpenId: sync.botOpenId, botName: sync.botName, ownerOpenId: sync.ownerOpenId },
        stamp,
      );
      store.setEnabled(true, stamp);
      if (sync.routerChatId !== null && store.chatOfTarget({ kind: "router" }) === null) {
        const t = now();
        syncedRouterChatId = sync.routerChatId;
        store.upsertChat({ chatId: sync.routerChatId, target: { kind: "router" }, name: "总助", label: "总助" }, t);
        store.saveInboundCursor(sync.routerChatId, { lastInboundAt: t, lastMessageId: null }, t);
        ackAllRouterEvents();
      }
      lastError = null;
      authFailed = false;
      options.lease?.refresh();
      await syncTransport();
      broadcastPeerApp();
    },
    localPmChats,
    handleEvent(raw, queuedAt) {
      onRawEvent(raw, queuedAt);
    },
    async handleCardAction(raw) {
      return onRawCardAction(raw);
    },
    async say(chatId, text) {
      await sendText({ chatId }, text);
    },
    async chatDescription(chatId) {
      const local = store.chatById(chatId);
      if (local !== null && local.archivedAt === null) {
        if (local.target.kind === "pm" && local.target.pmId !== null) {
          return feishuChatMarker(options.device.id, local.target.pmId);
        }
        if (local.target.kind === "router") {
          return "";
        }
      }
      try {
        const data = await api("chat.get", { chat_id: chatId });
        return typeof data.description === "string" ? data.description : "";
      } catch (error) {
        if (isChatGone(error)) return null;
        throw error;
      }
    },
    async start() {
      unsubscribe ??= ledger.onChange(onLedgerChange);
      if (options.lease !== undefined && offLease === null) {
        offLease = options.lease.onChange(() => {
          void syncTransport();
        });
      }
      if (options.mesh !== undefined && offMesh === null) {
        offMesh = options.mesh.onChange(() => {
          scheduleApprovalCardsSync();
        });
      }
      try {
        secrets = await readFeishuSecrets(options.secretsFile);
      } catch (error) {
        handleError(error);
        return;
      }
      const app = store.app();
      if (secrets === null || app === null || !app.enabled) return;
      options.lease?.refresh();
      // 不等长连接连上：网络慢、飞书挂了都不拖守护进程启动
      void syncTransport();
    },
    idle: () => whenIdle(true),
    close() {
      closing ??= (async () => {
        unsubscribe?.();
        unsubscribe = null;
        offLease?.();
        offLease = null;
        offMesh?.();
        offMesh = null;
        registration?.abort.abort();
        registration = null;
        await drainBeforeClose();
        closed = true;
        await syncTransport();
        for (const timer of uploadTimers) clearTimeout(timer);
        uploadTimers.clear();
        uploads.clear();
        uploadLimit.clearQueue();
        for (const queue of [inbound, outbound]) {
          for (const lane of queue.lanes.values()) {
            queue.count -= lane.tasks.length;
            lane.tasks.length = 0;
          }
        }
        dirtyChats.clear();
        inboundEpoch++;
        inboundCatchUpTargetEpoch = 0;
        releaseAllInboundGates();
        seenInboundMessages.clear();
        inboundCursorHold.clear();
        activeTurns.clear();
        directory.clear();
        contexts.clearAll();
        pendingCatalogRefreshPms.clear();
        pendingCatalogRefreshRouter = false;
        settleIdle();
      })();
      return closing;
    },
  };
}
