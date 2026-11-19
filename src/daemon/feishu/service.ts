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
import { askOf, type ConversationId, type Message, type MessageId, type PmId } from "../../shared/domain.ts";
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
  FEISHU_INBOUND_QUEUE_MAX,
  FEISHU_MEDIA_QUEUE_MAX,
  FEISHU_MEDIA_RETRY_MAX,
  FEISHU_OUTBOUND_QUEUE_MAX,
  FEISHU_PAGE_SIZE,
  FEISHU_UPLOAD_CONCURRENCY,
  MAX_UPLOAD_BYTES,
} from "../../shared/limits.ts";
import { LRUCache } from "lru-cache";
import pLimit from "p-limit";
import { attachmentsOf, isLedgerWakeup } from "../../shared/attachments.ts";
import type { RouterCommandRecord, RouterItem } from "../../shared/router.ts";
import type { UserBlockerId } from "../../shared/user-blockers.ts";
import { sentFilesOf } from "../../shared/sent-files.ts";
import type { RouterDispatcher } from "../router/dispatcher.ts";
import type { ModelCatalogs } from "../driver/model-catalog.ts";
import type { Db } from "../store/index.ts";
import { resolveUpload } from "../uploads.ts";
import { createFeishuAvatarCache, renderFeishuAvatar, type FeishuAvatarImage } from "./avatars.ts";
import {
  feishuAskOptions,
  feishuCardRefOf,
  feishuCardStateOf,
  renderAskCard,
  renderChatPolicyCard,
  renderReplyCard,
  renderRouterItem,
  renderTextCard,
  unrenderableReplyText,
  type FeishuAttachmentView,
  type FeishuCardJson,
  type FeishuCardRef,
  type FeishuCardState,
} from "./cards.ts";
import { desiredFeishuChats, FEISHU_CHAT_MARKER_PATTERN, feishuChatCreateUuid, planFeishuChatSync, type FeishuChatOp } from "./chats.ts";
import { createFeishuContextWindows, createFeishuDirectory, type FeishuMember } from "./directory.ts";
import { createFeishuFileService, planFeishuFile, type FeishuFileService, type FeishuOutboundFile, type FeishuUploaded } from "./files.ts";
import { parseFeishuCardAction, parseFeishuEvent, type FeishuInbound, type FeishuInboundAction } from "./inbound.ts";
import { catchUpIntents, projectFeishuChange, splitFeishuMarkdown, type FeishuOutboundIntent, type FeishuProjectionContext } from "./outbound.ts";
import { GUEST_NO_FILES, routeFeishuAction, routeFeishuMessage, type FeishuActionRoute } from "./routing.ts";
import { checkFeishuScopes, FEISHU_APP_ADDONS, feishuAppPreset } from "./scopes.ts";
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
  type FeishuTransport,
} from "./transport.ts";

/** 通道用到的账本接口。 */
export type FeishuLedgerPort = Pick<
  SqliteLedger,
  | "snapshot"
  | "onChange"
  | "getMessage"
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
  /** 提醒卡点“已处理”时先重问被卡的那家厂商（同界面服务的 /api/user-blockers/:id/recheck）；没给就只按缓存的状态重查。 */
  models?: Pick<ModelCatalogs, "list">;
  secretsFile: string;
  uploadsDir: string;
  sentFilesDir: string;
  device: { id: string; name: string };
  log: (line: string) => void;
  /** 测试里换成假的传输层和假的扫码。 */
  createTransport?: (options: FeishuSdkOptions) => FeishuTransport;
  register?: typeof registerFeishuApp;
  now?: () => number;
  /** 发卡前等附件的窗口，默认 FEISHU_ATTACH_WAIT_MS；测试里调短。 */
  attachWaitMs?: number;
}

export interface FeishuService {
  setup: FeishuSetupService;
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
/** 用户消息还没回完的状态：排着、送达、在处理。 */
const AWAITING_REPLY: ReadonlySet<string> = new Set(["queued", "delivered", "processing"]);
/** 网页上发的话镜像到群里时卡片的标题。 */
const MIRROR_TITLE = "网页上说";
/** 整轮没写正文、状态卡又撤不回时，卡上留的一行。 */
const NO_REPLY_TEXT = "（这一轮没有文字回复）";
/** 飞书里发的文件没收下（超过 MAX_UPLOAD_BYTES、下载失败）时回的一句。 */
const missedFilesText = (names: readonly string[]) =>
  `没收下：${names.map((n) => `「${n}」`).join("、")}（超过 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB 或下载失败），去网页上传。`;
/** 原文只进日志。 */
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
  /** 卡已发出、等它传完补发和改卡的群（只排一次）。 */
  follow: FeishuChatId | null;
}

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
  let files: FeishuFileService | null = null;
  let secrets: FeishuSecrets | null = null;
  let linkUp = false;
  /** 长连接上次断开的时刻；连上后清空，重连时据此记断了多久。 */
  let downSince: number | null = null;
  let authFailed = false;
  let lastError: string | null = null;
  let missing: string[] = [];
  let mentionOnly = false;
  let ownerName: string | null = null;
  let registration: { url: string; expiresAt: number; abort: AbortController } | null = null;
  let bindCode: { code: string; expiresAt: number } | null = null;
  let unsubscribe: (() => void) | null = null;
  let closed = false;
  let closing: Promise<void> | null = null;

  const directory = createFeishuDirectory(async (chatId) => fetchMembers(chatId));
  const contexts = createFeishuContextWindows();
  const avatars = createFeishuAvatarCache(store, now);
  const budget = createFeishuCardkitBudget(FEISHU_CARDKIT_BUDGET_PER_SECOND);
  const streams = new Map<ConversationId, StreamSlot>();
  /** 每个群最近几次发消息的时间（同一个群每秒不超过 FEISHU_CHAT_SENDS_PER_SECOND 条）。 */
  const sendTimes = new LRUCache<string, number[]>({ max: FEISHU_CHAT_CACHE_MAX });

  // ---- 排队 ----

  const inbound = { lanes: new Map<FeishuChatId, Lane>(), count: 0, limit: FEISHU_INBOUND_QUEUE_MAX, paused: () => false };
  // 建群对齐、补发时出站任务先排着不发（两边会改同一批群和水位），做完再接着发
  const outbound = { lanes: new Map<FeishuChatId, Lane>(), count: 0, limit: FEISHU_OUTBOUND_QUEUE_MAX, paused: () => control !== null };
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
  const busy = () => inbound.count > 0 || outbound.count > 0 || control !== null ||
    (linkUp && retryControl === null && (syncRequested || connectionRequested || dirtyChats.size > 0));
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
    if (!linkUp || closed || retryControl !== null) return;
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
    if (closed || !linkUp || control !== null || retryControl !== null || outbound.count > 0) return;
    const connection = connectionRequested;
    const sync = syncRequested || connection;
    const replaying = new Set(dirtyChats);
    if (!sync && replaying.size === 0) return;
    connectionRequested = syncRequested = false;
    dirtyChats.clear();
    control = { connection, replaying };
    void Promise.resolve().then(async () => {
      if (connection) await checkScopes();
      if (owner() === null) return;
      // 对齐出错不挡补发：补发只管已经建好的群，没对齐完的稍后再对齐
      let syncSettled = true;
      if (sync) {
        try {
          await ensureRouterChat();
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
    for (let task = lane.tasks.shift(); task !== undefined; task = lane.tasks.shift()) {
      try {
        if (!closed && linkUp) await task.run();
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
    pumpControl();
    settleIdle();
  };

  const startLane = (queue: Queue, name: FeishuChatId, lane: Lane) => {
    if (lane.running || lane.tasks.length === 0 || queue.paused()) return;
    lane.running = true;
    queueMicrotask(() => { void drain(queue, name, lane); });
  };

  const admit = (queue: Queue, name: FeishuChatId, task: LaneTask, limit = queue.limit): boolean => {
    if (closed || !linkUp) return false;
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
    if (linkUp && !closed) lastError = "飞书出站队列已满，正在从账本补发";
    markDirty(chatId);
  };

  const handleError = (error: unknown) => {
    if (error instanceof FeishuAuthError) {
      authFailed = true;
      linkUp = false;
      void stopTransport();
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
    routerChat: () => (store.app()?.ownerOpenId ? store.chatOfTarget({ kind: "router" }) : null),
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
    if (!linkUp) return "connecting";
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
      chats: store.chats().flatMap((c) => chatView(c) ?? []),
    };
  };

  // ---- 连接 ----

  const stopTransport = async () => {
    const old = transport;
    transport = null;
    files = null;
    linkUp = false;
    downSince = null;
    if (retryControl !== null) clearTimeout(retryControl);
    retryControl = null;
    for (const [id, slot] of streams) dropStream(id, slot);
    if (old !== null) await old.stop().catch((error: unknown) => log(`飞书：断开时出错：${errorText(error)}`));
  };

  const checkScopes = async () => {
    const data = await api("application.scopes", {});
    const granted = ((data.scopes as { scope_name?: string; grant_status?: number }[] | undefined) ?? [])
      .filter((s) => s.grant_status === 1 && typeof s.scope_name === "string")
      .map((s) => s.scope_name!);
    const check = checkFeishuScopes(granted);
    missing = check.missing;
    mentionOnly = check.mentionOnly;
  };

  const onConnected = () => {
    if (downSince !== null) log(`飞书：长连接已重连，断了 ${Math.round((now() - downSince) / 1000)} 秒`);
    downSince = null;
    linkUp = true;
    directory.markAllStale();
    if (retryControl !== null) clearTimeout(retryControl);
    retryControl = null;
    requestControl("connection");
  };

  const startTransport = async (s: FeishuSecrets) => {
    await stopTransport();
    authFailed = false;
    const t = (await transportFactory())({ brand: s.brand, appId: s.appId, appSecret: s.appSecret, log: (line) => log(`飞书：${line}`) });
    transport = t;
    files = createFeishuFileService({ transport: t, uploadsDir: options.uploadsDir, log: (line) => log(`飞书：${line}`) });
    try {
      await t.start({
        onEvent: (raw) => onRawEvent(raw),
        onCardAction: (raw) => onRawCardAction(raw),
        onConnected,
        onDisconnected: (reason) => {
          if (downSince === null) {
            downSince = now();
            log(`飞书：长连接断了：${reason}`);
          }
          linkUp = false;
          lastError = reason;
          contexts.clearAll();
        },
      });
    } catch (error) {
      handleError(error);
    }
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
    const appId = parseFeishuAppId(s.appId);
    if (appId === null) throw new FeishuSetupError("App ID 要以 cli_ 开头");
    const bot = await verify(s);
    await writeFeishuSecrets(options.secretsFile, s);
    secrets = s;
    const before = store.app();
    if (before !== null && before.appId !== appId) {
      directory.clear();
      contexts.clearAll();
    }
    store.saveApp({ appId, brand: s.brand, botOpenId: bot.botOpenId, botName: bot.botName, ownerOpenId }, now());
    store.setEnabled(true, now());
    lastError = null;
    await startTransport(s);
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
        store.upsertChat({ chatId, target: { kind: "pm", pmId: op.spec.pmId }, name: op.spec.name, label: op.spec.label }, now());
        store.setChatAvatar(chatId, op.spec.look, now());
        // 新群只从现在往后投影，不把历史消息倒进来
        const conversationId = conversationOfPm(op.spec.pmId);
        store.advanceWatermark(chatId, { messageId: (conversationId === null ? null : latestMessageId(conversationId)) ?? 0 }, now());
        return true;
      }
      case "adopt": {
        const avatar = await imageKeyOf(op.spec.look);
        // 要认回的群刚没了：下一次对齐列群时就没有它了，改成新建
        if (!(await updateChat({ chat_id: op.chatId, name: op.spec.name, avatar }))) return false;
        store.upsertChat({ chatId: op.chatId, target: { kind: "pm", pmId: op.spec.pmId }, name: op.spec.name, label: op.spec.label }, now());
        store.setChatAvatar(op.chatId, op.spec.look, now());
        const conversationId = conversationOfPm(op.spec.pmId);
        store.advanceWatermark(op.chatId, { messageId: (conversationId === null ? null : latestMessageId(conversationId)) ?? 0 }, now());
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
    if (transport === null || !linkUp || app === null || app.ownerOpenId === null) return true;
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
    return settled;
  };

  const ensureRouterChat = async () => {
    const o = owner();
    if (o === null || store.chatOfTarget({ kind: "router" }) !== null) return;
    const sent = await sendMessage({ openId: o }, "text", { text: "已接上飞书。在这里和总助说话；每个项目经理有自己的项目群。" }, `fusa-hello-${store.app()!.appId}`);
    if (sent.chatId !== null) store.upsertChat({ chatId: sent.chatId, target: { kind: "router" }, name: "总助", label: "总助" }, now());
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

  const fileRef = (file: Pick<FeishuOutboundFile, "messageId" | "part">): FeishuPostRef => ({ kind: "file", messageId: file.messageId, part: file.part });
  const uploadKey = (file: Pick<FeishuOutboundFile, "messageId" | "part">) => `${file.messageId}:${file.part}`;

  /** 传一个文件：暂时性错误退避重试 FEISHU_MEDIA_RETRY_MAX 次；飞书拒收、重试用尽返回 null；停机、断线打断返回 undefined。 */
  const uploadWithRetry = async (service: FeishuFileService, file: FeishuOutboundFile): Promise<FeishuUploaded | null | undefined> => {
    for (let attempt = 0; ; attempt++) {
      if (closed || !linkUp) return undefined;
      try {
        return await service.upload(file);
      } catch (error) {
        handleError(error);
        if (closed || !linkUp) return undefined;
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
    if (service === null || closed || !linkUp) return null;
    if (uploadsInFlight >= FEISHU_MEDIA_QUEUE_MAX) {
      log(`飞书：在传的附件满了（${FEISHU_MEDIA_QUEUE_MAX} 个），「${file.name}」等一会儿再传`);
      return null;
    }
    const job: UploadJob = { startedAt: now(), done: Promise.resolve(), result: undefined, follow: null };
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
      if (store.postOf(fileRef(file)) === null) startUpload(file);
    }
  };

  /** 每个附件这一刻的样子。sending：要发卡了（没在传的也算在传，卡上写 Uploading）；否则是重画已经发出的卡。 */
  const attachmentSlots = (message: Message, sending = false): AttachmentSlot[] =>
    outboundFilesOf(message).map((file) => {
      const row = store.postOf(fileRef(file));
      const job = row === null || row.state === "uploading" ? (uploads.get(uploadKey(file)) ?? null) : null;
      return { file, row, job, result: job?.result, sending };
    });

  /** 发卡前等附件：最晚等到最后开始传的那个起算 attachWaitMs，传完就不等了；返回等完这一刻的样子。 */
  const prepareAttachments = async (message: Message): Promise<AttachmentSlot[]> => {
    const jobs = outboundFilesOf(message).flatMap((file) => {
      if (store.postOf(fileRef(file)) !== null) return [];
      const job = startUpload(file);
      return job === null || job.result !== undefined ? [] : [job];
    });
    const left = jobs.length === 0 ? 0 : Math.max(...jobs.map((j) => j.startedAt)) + attachWaitMs - now();
    if (left > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.all(jobs.map((j) => j.done)), new Promise((resolve) => { timer = setTimeout(resolve, left); })]);
      clearTimeout(timer);
    }
    return attachmentSlots(message, true);
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
  const followUpAttachments = async (chatId: FeishuChatId, slots: readonly AttachmentSlot[], host: HostCard) => {
    const rejected: FeishuOutboundFile[] = [];
    for (const { file, row, result } of slots) {
      if (row !== null) continue;
      const ref = fileRef(file);
      const onHost = { ref, chatId, messageId: host.messageId, cardId: host.cardId, sequence: 0 };
      if (planFeishuFile(file).kind === "too_large" || result === null) {
        store.savePost({ ...onHost, state: "final", mediaKey: null }, now());
      } else if (result === undefined) {
        store.savePost({ ...onHost, state: "uploading" }, now());
        followUpload(chatId, file);
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
      uploads.delete(uploadKey(file));
    }
    for (const file of rejected) await completeUpload(chatId, file.messageId, file.part);
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
  const followUpload = (chatId: FeishuChatId, file: FeishuOutboundFile) => {
    const job = startUpload(file);
    if (job === null || job.follow !== null) return;
    job.follow = chatId;
    void job.done.then(() => {
      if (job.result !== undefined) enqueue(chatId, () => completeUpload(chatId, file.messageId, file.part));
    });
  };

  /**
   * 在途附件传完了：图片记下编号、文件补发成文件消息，再把挂它的那张卡原地改掉（图嵌回去、文件标已送达、没传上的标没发出去），
   * 改成了才记 final。编号先记在 uploading 行上（行里的消息编号一直是 host 的）：改卡遇到暂时性错误、停机重启后，
   * 补发和 resumeUploads 按这一行重新改卡，不重传、不重发文件。
   */
  const completeUpload = async (chatId: FeishuChatId, messageId: MessageId, part: number) => {
    const ref = fileRef({ messageId, part });
    const row = store.postOf(ref);
    if (row?.state !== "uploading" || row.chatId !== chatId) return;
    const message = ledger.getMessage(messageId);
    const file = outboundFileOf(message, part);
    const key = uploadKey({ messageId, part });
    if (file !== undefined && row.mediaKey === null) {
      const job = uploads.get(key);
      if (job?.result === undefined) {
        followUpload(chatId, file);
        return;
      }
      const result = job.result;
      let mediaKey: string | null = null;
      if (result?.kind === "image") mediaKey = result.imageKey;
      else if (result?.kind === "file") {
        const sent = await sendUploadedFile(chatId, file, result);
        if (sent === undefined) return;
        if (sent === null) job.result = null;
        else mediaKey = result.fileKey;
      }
      if (mediaKey !== null) store.savePost({ ...row, mediaKey }, now());
    }
    if (message !== null) await refreshHostCard(message, row.messageId);
    const latest = store.postOf(ref);
    if (latest !== null && store.chatById(chatId) !== null) store.savePost({ ...latest, state: "final" }, now());
    uploads.delete(key);
  };

  /** 挂附件的卡按账本现状和附件现状重画一遍、原地改掉：提问卡照拍板状态画，回复卡和网页镜像卡用最后一段正文。 */
  const refreshHostCard = async (message: Message, hostMessageId: FeishuMessageId) => {
    const post = store.postByMessageId(hostMessageId);
    if (post === null || post.cardId === null || post.ref.kind !== "message") return;
    const views = attachmentViews(attachmentSlots(message));
    const ask = message.sender === "agent" ? askOf(message) : null;
    const lastChunk = splitFeishuMarkdown(message.sender === "user" ? mirrorText(message) : message.text).at(-1) ?? "";
    const card = ask !== null
      ? renderAskCard(message, ask, askStateOf(message), views)
      : message.sender === "user"
        ? renderTextCard({ title: MIRROR_TITLE, text: lastChunk, template: "grey", attachments: views })
        : renderReplyCard({ conversationId: message.conversationId, text: lastChunk, streaming: false, withStop: false, attachments: views });
    const cardId = post.cardId;
    await unlessRejected(() => updateCard(cardId, post.sequence + 1, card));
    if (store.chatById(post.chatId) !== null) store.savePost({ ...post, sequence: post.sequence + 1 }, now());
  };

  /** 重连、重启后接着做卡已发出、附件还没收尾的：传完（或只差改卡）的直接收尾，没传完的接着等。 */
  const resumeUploads = async (chat: FeishuChatBinding) => {
    for (const post of store.uploadingPosts(chat.chatId, FEISHU_PAGE_SIZE)) {
      if (post.ref.kind !== "file") continue;
      const { messageId, part } = post.ref;
      const file = post.mediaKey === null && uploads.get(uploadKey({ messageId, part }))?.result === undefined
        ? outboundFileOf(ledger.getMessage(messageId), part)
        : undefined;
      if (file === undefined) await completeUpload(chat.chatId, messageId, part);
      else followUpload(chat.chatId, file);
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

  /** 待拍板卡改成定案的样子；飞书不让再改（过期、撤回）时也记成已结算，不再重试。 */
  const settlePost = async (post: FeishuPostRecord, card: FeishuCardJson) => {
    if (post.cardId === null) return;
    await unlessRejected(() => updateCard(post.cardId!, post.sequence + 1, card));
    if (store.chatById(post.chatId) !== null) store.savePost({ ...post, sequence: post.sequence + 1, state: "card_settled" }, now());
  };

  const routerItemCard = (item: RouterItem) => {
    const askMessage = item.kind === "decision" && item.askMessageId !== null ? ledger.getMessage(item.askMessageId) : null;
    const meta = askMessage === null ? null : askOf(askMessage);
    const state = routerItemState(item, meta === null ? null : askMessage);
    const pmChat = liveChatOfPm(item.pmId);
    return {
      card: renderRouterItem(item, askMessage !== null && meta !== null ? { message: askMessage, meta } : null, state, pmChat?.chatId ?? null),
      settled: state.kind !== "pending" || item.kind === "report",
    };
  };

  const postRouterItem = async (item: RouterItem) => {
    const chat = store.chatOfTarget({ kind: "router" });
    if (chat === null) return;
    const ref: FeishuPostRef = { kind: "router_item", itemId: item.id };
    const post = store.postOf(ref);
    const { card, settled } = routerItemCard(item);
    if (post === null) {
      if (item.kind === "decision" && settled) return;
      const posted = await postCardEntity(chat.chatId, card, `fusa-r-${item.id}`);
      if (store.chatById(chat.chatId) === null) return;
      store.savePost({ ref, chatId: chat.chatId, messageId: posted.messageId, cardId: posted.cardId, sequence: 0, state: item.kind === "report" ? "final" : "card_pending" }, now());
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
          const row = db.get<{ id: number }>("SELECT id FROM router_items WHERE ask_message_id = ? ORDER BY id DESC LIMIT 1", intent.message.id);
          if (row !== undefined) await settleRouterItem(row.id);
        });
        return;
      }
      case "router_item": {
        const chat = store.chatOfTarget({ kind: "router" });
        if (chat !== null) {
          enqueue(chat.chatId, () => replayRouterEvents(chat, false), { key: "router-events" });
          if (intent.item.kind === "decision" && intent.item.status !== "pending") {
            enqueue(chat.chatId, () => settleRouterItem(intent.item.id));
          }
        }
        return;
      }
      case "router_command": {
        const chat = store.chatOfTarget({ kind: "router" });
        if (chat !== null) enqueue(chat.chatId, () => replayRouterEvents(chat, false), { key: "router-events" });
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
    if (transport === null || !linkUp || owner() === null) return;
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
      if (!linkUp || closed) {
        failed.add(chat.chatId);
        continue;
      }
      try {
        if (chat.target.kind === "pm") await replayPmChat(chat, recent);
        else if (chat.chatId === routerChat?.chatId) {
          await settleRouterCards(chat);
          await replayRouterEvents(chat, recent);
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
    const conversationId = conversationOfPm(chat.target.pmId);
    if (conversationId === null) return;
    // 离线期间在网页上定案、被关掉的卡先改：不排在补发后面，补发哪一件出错都不挡它去掉按钮
    for (const post of store.pendingCards(chat.target.pmId)) {
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
      if (!linkUp || closed) throw new Error("飞书断开了，补发没做完");
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
      if (!linkUp || closed || store.chatById(chat.chatId) === null) return;
      const page = store.routerEventsAfter(after, FEISHU_PAGE_SIZE);
      for (const event of page) {
        await unlessRejected(async () => {
          if (event.item_id !== null) {
            const item = ledger.getRouterItem(event.item_id);
            if (item !== null) await postRouterItem(item);
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
    for (const post of store.pendingCards(null)) if (post.ref.kind === "router_item") await settleRouterItem(post.ref.itemId);
  };

  /** 停机前排空：排着的出站发完，还在流式的卡收尾（关流式、去停止按钮）；最多等 FEISHU_CLOSE_DRAIN_MS，到点照样断开。 */
  const drainBeforeClose = async () => {
    if (!linkUp) return;
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

  const onRawEvent = (raw: FeishuRawEvent) => {
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
    if (!admit(inbound, event.chatId, inboundTask(() => handleInbound(event)), limit)) {
      directory.markAllStale();
      lastError = "飞书入站队列已满，请重发未收到回复的消息";
    }
  };

  const isBindCode = (text: string) => bindCode !== null && bindCode.expiresAt > now() && text.trim() === bindCode.code;

  const policyCardFor = async (chat: FeishuChatBinding) => {
    if (chat.target.kind !== "pm" || chat.target.pmId === null) return;
    const pmId = chat.target.pmId;
    const ref: FeishuPostRef = { kind: "chat_policy", pmId };
    if (store.postOf(ref) !== null) return;
    const posted = await postCardEntity(chat.chatId, renderChatPolicyCard({ pmId, triggerMode: chat.triggerMode, guestTier: chat.guestTier, mentionOnlyForced: mentionOnly }), `fusa-p-${chat.chatId}`);
    if (activeTarget(store.chatById(chat.chatId)) !== null) store.savePost({ ref, chatId: chat.chatId, messageId: posted.messageId, cardId: posted.cardId, sequence: 0, state: "final" }, now());
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

  const handleInbound = async (event: Exclude<FeishuInbound, { kind: "chat_gone" }>) => {
    const o = owner();
    switch (event.kind) {
      case "members_added": {
        directory.applyJoined(event.chatId, event.openIds.map((openId) => ({ openId, name: "" })), now());
        const chat = store.chatById(event.chatId);
        if (chat !== null && activeTarget(chat)?.kind === "pm" && o !== null && event.openIds.some((id) => id !== o)) await policyCardFor(chat);
        return;
      }
      case "members_removed":
        directory.applyLeft(event.chatId, event.openIds, now());
        return;
      case "chat_renamed":
        if (store.chatById(event.chatId) !== null) store.renameChat(event.chatId, event.name, null, now());
        return;
      case "message":
        return handleMessage(event);
    }
  };

  const handleMessage = async (message: Extract<FeishuInbound, { kind: "message" }>) => {
    const o = owner();
    const t = now();
    if (message.chatType === "p2p" && o !== null && message.senderOpenId === o && store.chatOfTarget({ kind: "router" }) === null) {
      store.upsertChat({ chatId: message.chatId, target: { kind: "router" }, name: "总助", label: "总助" }, t);
    }
    const chat = store.chatById(message.chatId);
    const target = activeTarget(chat);
    const group = message.chatType === "group" && target?.kind === "pm";
    const mode = group && o !== null ? await directory.modeOf(message.chatId, o, message.senderOpenId, t) : "solo";
    if (message.chatType === "p2p" && message.senderOpenId === o && target?.kind !== "router") return;
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
        return;
      case "bind_owner":
        bindCode = null;
        store.bindOwner(route.openId, t);
        store.upsertChat({ chatId: message.chatId, target: { kind: "router" }, name: "总助", label: "总助" }, t);
        await sendText({ chatId: message.chatId }, "认好了：你是这个机器人的主人。在这里和总助说话；每个项目经理会有自己的项目群。");
        requestControl("sync");
        return;
      case "reject":
        await sendText({ chatId: message.chatId }, message.chatType === "p2p" ? route.reason : `<at user_id="${route.openId}"></at> ${route.reason}`);
        if (route.reason === GUEST_NO_FILES) contexts.dropFiles(message.chatId, (file) => file.speaker === route.openId);
        return;
      case "context":
        contexts.add(message.chatId, route.line, message.files.map((file) => ({ messageId: message.messageId, speaker: message.senderOpenId, file, at: message.at })));
        return;
      case "deliver": {
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
        if (route.droppedFiles > 0) await sendText({ chatId: message.chatId }, `${at}${GUEST_NO_FILES}`);
        if (route.text === "" && attachments.length === 0) return;
        const clientId = `${FEISHU_CLIENT_PREFIX}${message.messageId}`;
        if (route.target.kind === "router") {
          if (options.router === null) {
            await sendText({ chatId: message.chatId }, "总助没开：去网页的总助工作台选一家 agent。");
            return;
          }
          try {
            await options.router.submitCommand({ clientId, text: route.text, ...(attachments.length > 0 ? { attachmentIds: attachments.map((a) => a.id) } : {}) });
          } catch (error) {
            if (!(error instanceof LedgerRequestError)) throw error;
            await sendText({ chatId: message.chatId }, `没送到：${error.message}`);
          }
          return;
        }
        if (activeTarget(store.chatById(message.chatId))?.kind !== "pm") return;
        const conversationId = conversationOfPm(route.target.pmId);
        if (conversationId === null) return;
        try {
          ledger.postUserMessage({ conversationId, clientId, text: route.text, ...(attachments.length > 0 ? { attachments } : {}), origin: route.origin });
          contexts.clear(message.chatId);
        } catch (error) {
          if (error instanceof LedgerRequestError || error instanceof ConversationNotFoundError) {
            await sendText({ chatId: message.chatId }, `没送到：${error.message}`);
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
    if (value.kind === "stop") {
      if (target.kind !== "pm" || pmOfConversation(value.conversationId) !== target.pmId) return false;
      const slot = streams.get(value.conversationId);
      return slot?.chatId === chatId && slot.state.phase === "live" && slot.posted?.messageId === messageId;
    }
    const post = store.postByMessageId(messageId);
    if (post === null || post.chatId !== chatId || post.cardId === null) return false;
    if (value.kind === "set_policy") {
      return target.kind === "pm" && post.ref.kind === "chat_policy" && post.ref.pmId === target.pmId && value.pmId === target.pmId;
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
    if (route.kind !== "ignore" && route.kind !== "reject" && !ownsAction(action, target)) return toast("warning", "这张卡已过期，去网页看");
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
          return toast("warning", route.toast);
        case "stop": {
          if (route.target.kind !== "pm") return {};
          const conversationId = conversationOfPm(route.target.pmId);
          if (conversationId !== null) ledger.requestStop(conversationId);
          return toast("info", "正在停");
        }
        case "set_policy": {
          const admitted = admit(inbound, chatId, inboundTask(async () => {
            if (activeTarget(store.chatById(chatId)) === null) return;
            await setup.setChatPolicy({ pmId: route.pmId, ...(route.triggerMode ? { triggerMode: route.triggerMode } : {}), ...(route.guestTier ? { guestTier: route.guestTier } : {}) });
          }));
          return admitted ? toast("success", "已改") : toast("warning", "飞书正忙，请再点一次");
        }
        case "blocker_done": {
          // 重问厂商要跑它的命令行，可能超过回调时限：先回 toast，排队去查；解开了账本推变化，这张卡跟着改
          const blockerId = route.card.blockerId;
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
          registration = null;
          try {
            await connectWith({ brand: result.brand, appId: result.appId, appSecret: result.appSecret }, parseFeishuOpenId(result.scannerOpenId));
          } catch (error) {
            handleError(error);
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
      const post = store.postOf({ kind: "chat_policy", pmId: input.pmId });
      if (post !== null && post.cardId !== null && transport !== null) {
        await updateCard(post.cardId, post.sequence + 1, renderChatPolicyCard({ pmId: input.pmId, triggerMode: chat.triggerMode, guestTier: chat.guestTier, mentionOnlyForced: mentionOnly }));
        store.savePost({ ...post, sequence: post.sequence + 1 }, now());
      }
      return chatView(chat)!;
    },
    async resync() {
      if (transport === null || !linkUp) throw new FeishuSetupError("飞书没连上");
      directory.markAllStale();
      await checkScopes();
      await ensureRouterChat();
      if (!(await syncChats())) retrySyncLater();
      return status();
    },
    async disconnect(input) {
      registration?.abort.abort();
      registration = null;
      if (input.dissolveChats && transport !== null) {
        for (const chat of store.chats()) {
          if (chat.target.kind === "pm" && chat.archivedAt === null) await deleteChat(chat.chatId).catch((error: unknown) => log(`飞书：解散群出错：${errorText(error)}`));
        }
      }
      await stopTransport();
      await removeFeishuSecrets(options.secretsFile);
      store.clear();
      secrets = null;
      bindCode = null;
      lastError = null;
      missing = [];
      mentionOnly = false;
      ownerName = null;
      directory.clear();
      contexts.clearAll();
      return status();
    },
  };

  return {
    setup,
    async start() {
      unsubscribe ??= ledger.onChange(onLedgerChange);
      try {
        secrets = await readFeishuSecrets(options.secretsFile);
      } catch (error) {
        handleError(error);
        return;
      }
      const app = store.app();
      if (secrets === null || app === null || !app.enabled) return;
      // 不等长连接连上：网络慢、飞书挂了都不拖守护进程启动
      void startTransport(secrets);
    },
    idle: () => whenIdle(true),
    close() {
      closing ??= (async () => {
        unsubscribe?.();
        unsubscribe = null;
        registration?.abort.abort();
        registration = null;
        await drainBeforeClose();
        closed = true;
        await stopTransport();
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
        activeTurns.clear();
        directory.clear();
        contexts.clearAll();
        settleIdle();
      })();
      return closing;
    },
  };
}
