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
import { randomInt, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Change } from "../../shared/api.ts";
import { askOf, type ConversationId, type Message, type MessageId, type PmId } from "../../shared/domain.ts";
import type { Deliverable } from "../../shared/deliverables.ts";
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
  FEISHU_CONTROL_RETRY_MS,
  FEISHU_CATCHUP_MAX_MESSAGES,
  FEISHU_INBOUND_QUEUE_MAX,
  FEISHU_OUTBOUND_QUEUE_MAX,
  FEISHU_PAGE_SIZE,
} from "../../shared/limits.ts";
import { LRUCache } from "lru-cache";
import type { RouterCommandRecord, RouterItem } from "../../shared/router.ts";
import { sentFilesOf, type SentFile } from "../../shared/sent-files.ts";
import type { RouterDispatcher } from "../router/dispatcher.ts";
import type { Db } from "../store/index.ts";
import { resolveUpload } from "../uploads.ts";
import { createFeishuAvatarCache, pmFruitImagePath } from "./avatars.ts";
import {
  feishuAskOptions,
  feishuCardRefOf,
  feishuCardStateOf,
  renderAskCard,
  renderChatPolicyCard,
  renderReplyCard,
  renderRouterItem,
  renderTextCard,
  type FeishuCardJson,
  type FeishuCardRef,
  type FeishuCardState,
} from "./cards.ts";
import { desiredFeishuChats, FEISHU_CHAT_MARKER_PATTERN, feishuChatCreateUuid, planFeishuChatSync, type FeishuChatOp } from "./chats.ts";
import { createFeishuContextWindows, createFeishuDirectory, type FeishuMember } from "./directory.ts";
import { createFeishuFileService, type FeishuFileService, type FeishuOutboundFile } from "./files.ts";
import { parseFeishuCardAction, parseFeishuEvent, type FeishuInbound, type FeishuInboundAction } from "./inbound.ts";
import { catchUpIntents, projectFeishuChange, splitFeishuMarkdown, type FeishuOutboundIntent, type FeishuProjectionContext } from "./outbound.ts";
import { routeFeishuAction, routeFeishuMessage, type FeishuActionRoute } from "./routing.ts";
import { checkFeishuScopes, FEISHU_APP_ADDONS, feishuAppPreset } from "./scopes.ts";
import type { FeishuSdkOptions, registerFeishuApp } from "./sdk.ts";
import { readFeishuSecrets, removeFeishuSecrets, writeFeishuSecrets, type FeishuSecrets } from "./secrets.ts";
import { FeishuSetupError, type FeishuSetupService } from "./setup.ts";
import { createFeishuStore, type FeishuChatBinding, type FeishuPostRef } from "./store.ts";
import { createFeishuCardkitBudget, stepFeishuStream, type FeishuStreamEffect, type FeishuStreamEvent, type FeishuStreamState } from "./stream.ts";
import {
  FeishuAuthError,
  FeishuRegistrationError,
  feishuDataOf,
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
  | "messagesAfter"
  | "getRouterItem"
  | "getRouterCommand"
>;

export interface FeishuServiceOptions {
  db: Db;
  ledger: FeishuLedgerPort;
  /** 总助：主人在单聊里的话交给它；没开总助分派引擎时是 null，单聊回“总助没开”。 */
  router: Pick<RouterDispatcher, "submitCommand"> | null;
  secretsFile: string;
  uploadsDir: string;
  sentFilesDir: string;
  /** 水果头像图片所在目录（avatars.ts 的 pmFruitImagePath）。 */
  avatarsDir: string;
  device: { id: string; name: string };
  log: (line: string) => void;
  /** 测试里换成假的传输层和假的扫码。 */
  createTransport?: (options: FeishuSdkOptions) => FeishuTransport;
  register?: typeof registerFeishuApp;
  now?: () => number;
}

export interface FeishuService {
  setup: FeishuSetupService;
  /** 后置：有凭证且没暂停就连长连接、订阅账本变化；没配过只订阅不连。连不上不抛错，状态里写原因。 */
  start(): Promise<void>;
  /** 后置：排着的进出事件都处理完（测试和关机前用）。 */
  idle(): Promise<void>;
  /** 后置：退订账本、关连接、取消扫码、清掉计时器和内存缓存。可以重复调。 */
  close(): Promise<void>;
}

/** 飞书来的消息和总助指令的 clientId 前缀：feishu:<message_id>，飞书重推同一条消息天然幂等。 */
const FEISHU_CLIENT_PREFIX = "feishu:";
/** 解散群时群已经没了（被别人解散、机器人被移出）：不算错。 */
const CHAT_GONE_CODES = new Set([232011, 232006, 232010]);
const isCardJson = (value: unknown): value is FeishuCardJson => typeof value === "object" && value !== null && "schema" in value && value.schema === "2.0";
const ALREADY_DECIDED = "已经定过了";
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 一条串行的工作线（一个群一条）：保证同一个群里的发送有先后，各群之间并行。 */
interface Lane {
  tasks: { key: string | null; run: () => Promise<void> }[];
}

/** 一个项目经理对话的流式卡片：状态机现状、计时器、已推上去的正文（abandon 时留着它）。 */
interface StreamSlot {
  state: FeishuStreamState;
  chatId: FeishuChatId;
  timer: ReturnType<typeof setTimeout> | null;
  timerAt: number | null;
  posted: { cardId: FeishuCardId; messageId: FeishuMessageId; text: string } | null;
}

/** 前置：迁移 0034 已跑。后置：返回的服务还没 start。 */
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
  let authFailed = false;
  let lastError: string | null = null;
  let missing: string[] = [];
  let mentionOnly = false;
  let ownerName: string | null = null;
  let registration: { url: string; expiresAt: number; abort: AbortController } | null = null;
  let bindCode: { code: string; expiresAt: number } | null = null;
  let unsubscribe: (() => void) | null = null;
  let closed = false;

  const directory = createFeishuDirectory(async (chatId) => fetchMembers(chatId));
  const contexts = createFeishuContextWindows();
  const avatars = createFeishuAvatarCache(store, now);
  const budget = createFeishuCardkitBudget(FEISHU_CARDKIT_BUDGET_PER_SECOND);
  const streams = new Map<ConversationId, StreamSlot>();
  /** 每个群最近几次发消息的时间（同一个群每秒不超过 FEISHU_CHAT_SENDS_PER_SECOND 条）。 */
  const sendTimes = new LRUCache<string, number[]>({ max: FEISHU_CHAT_CACHE_MAX });

  // ---- 排队 ----

  const inbound = { lanes: new Map<string, Lane>(), count: 0, limit: FEISHU_INBOUND_QUEUE_MAX };
  const outbound = { lanes: new Map<string, Lane>(), count: 0, limit: FEISHU_OUTBOUND_QUEUE_MAX };
  let syncRequested = false;
  let replayRequested = false;
  let replayAllRequested = false;
  let connectionRequested = false;
  let controlling = false;
  let retryControl: ReturnType<typeof setTimeout> | null = null;
  const idleWaiters: (() => void)[] = [];
  const busy = () => inbound.count > 0 || outbound.count > 0 || controlling ||
    (linkUp && retryControl === null && (syncRequested || replayRequested || connectionRequested));
  const settleIdle = () => {
    if (busy()) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  };

  // 建群对齐和断线补发不进队列，只记一个“要做”的标记：满载时不会被丢，出站队列排空后合并成一次执行，失败隔 FEISHU_CONTROL_RETRY_MS 再试。
  const requestControl = (kind: "sync" | "replay" | "connection") => {
    if (kind === "sync") syncRequested = true;
    else if (kind === "replay") {
      replayRequested = true;
      replayAllRequested = true;
    }
    else connectionRequested = true;
    pumpControl();
  };

  const pumpControl = () => {
    if (closed || !linkUp || controlling || retryControl !== null || outbound.count > 0) return;
    const connection = connectionRequested;
    const sync = syncRequested || connection;
    const replay = replayRequested || connection;
    if (!sync && !replay) return;
    const replayAll = replayAllRequested;
    connectionRequested = syncRequested = replayRequested = replayAllRequested = false;
    controlling = true;
    void Promise.resolve().then(async () => {
      if (connection) await checkScopes();
      if (owner() === null) return;
      if (sync) {
        await ensureRouterChat();
        await syncChats();
      }
      if (replay) await catchUp(replayAll);
    }).catch((error: unknown) => {
      handleError(error);
      if (!linkUp || closed) return;
      connectionRequested ||= connection;
      syncRequested ||= sync;
      replayRequested ||= replay;
      replayAllRequested ||= replayAll;
      retryControl = setTimeout(() => {
        retryControl = null;
        pumpControl();
      }, FEISHU_CONTROL_RETRY_MS);
      retryControl.unref?.();
    }).finally(() => {
      controlling = false;
      pumpControl();
      settleIdle();
    });
  };

  const drain = async (queue: typeof outbound, name: string, lane: Lane) => {
    for (let task = lane.tasks.shift(); task !== undefined; task = lane.tasks.shift()) {
      try {
        if (!closed && linkUp) await task.run();
      } catch (error) {
        handleError(error);
        if (queue === outbound) {
          queue.count -= lane.tasks.length;
          lane.tasks.length = 0;
          requestControl("replay");
        }
      } finally {
        queue.count--;
      }
    }
    queue.lanes.delete(name);
    pumpControl();
    settleIdle();
  };

  const admit = (queue: typeof outbound, name: string, run: () => Promise<void>, key: string | null, limit = queue.limit): boolean => {
    if (closed || !linkUp) return false;
    let lane = queue.lanes.get(name);
    const last = lane?.tasks.at(-1);
    if (key !== null && last?.key === key) {
      last.run = run;
      return true;
    }
    if (queue.count >= limit) return false;
    const start = lane === undefined;
    if (lane === undefined) {
      lane = { tasks: [] };
      queue.lanes.set(name, lane);
    }
    lane.tasks.push({ key, run });
    queue.count++;
    if (start) {
      const created = lane;
      queueMicrotask(() => { void drain(queue, name, created); });
    }
    return true;
  };

  /** 出站任务排不进（满了，或补发正要跑）就不排了，改成从账本整段补发：账本是准的，队列只是加速。 */
  const enqueue = (name: string, run: () => Promise<void>, key: string | null = null) => {
    if (controlling || replayRequested || connectionRequested) {
      requestControl("replay");
    } else if (!admit(outbound, name, run, key)) {
      if (linkUp && !closed) lastError = "飞书出站队列已满，正在从账本补发";
      requestControl("replay");
    }
  };

  const handleError = (error: unknown) => {
    if (error instanceof FeishuAuthError) {
      authFailed = true;
      linkUp = false;
      lastError = `飞书凭证失效（${error.code}），请重新扫码或重填 App Secret`;
      void stopTransport();
    } else {
      lastError = errorText(error);
    }
    log(`飞书：${errorText(error)}`);
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
    if (Buffer.byteLength(json) > FEISHU_CARD_MAX_BYTES) throw new Error("飞书卡片超过体积上限");
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
    files = createFeishuFileService({ transport: t, store, uploadsDir: options.uploadsDir, now });
    try {
      await t.start({
        onEvent: (raw) => onRawEvent(raw),
        onCardAction: (raw) => onRawCardAction(raw),
        onConnected,
        onDisconnected: (reason) => {
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
      throw new FeishuSetupError(`凭证不对或应用不可用：${errorText(error)}`);
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

  const uploadAvatar = async (fruit: Parameters<typeof pmFruitImagePath>[1]): Promise<FeishuImageKey> => {
    if (transport === null) throw new Error("飞书没连上");
    const { imageKey } = await transport.uploadImage({ imageType: "avatar", path: pmFruitImagePath(options.avatarsDir, fruit) });
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

  /** 解散群；群已经没了不算错。 */
  const deleteChat = async (chatId: FeishuChatId) => {
    try {
      await api("chat.delete", { chat_id: chatId });
    } catch (error) {
      if (!CHAT_GONE_CODES.has((error as { code?: number }).code ?? 0)) throw error;
    }
    clearChatRuntime(chatId);
  };

  /** 每个项目经理上次建群用的 generation：解散时间要比它大，同一毫秒里连着解散两次也不会撞上同一个建群 uuid。 */
  const lastGeneration = new LRUCache<PmId, number>({ max: FEISHU_CHAT_CACHE_MAX });
  const dissolvedAt = (pmId: PmId | null) => Math.max(now(), (pmId === null ? 0 : (lastGeneration.get(pmId) ?? 0)) + 1);

  const applyChatOp = async (op: FeishuChatOp, appId: string, ownerId: FeishuOpenId) => {
    switch (op.kind) {
      case "create": {
        const avatar = await avatars.imageKeyOf(op.spec.fruit, uploadAvatar);
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
        store.setChatAvatar(chatId, op.spec.fruit, now());
        // 新群只从现在往后投影，不把历史消息倒进来
        const conversationId = conversationOfPm(op.spec.pmId);
        store.advanceWatermark(chatId, { messageId: (conversationId === null ? null : latestMessageId(conversationId)) ?? 0 }, now());
        return;
      }
      case "adopt": {
        const avatar = await avatars.imageKeyOf(op.spec.fruit, uploadAvatar);
        await api("chat.update", { chat_id: op.chatId, name: op.spec.name, avatar });
        store.upsertChat({ chatId: op.chatId, target: { kind: "pm", pmId: op.spec.pmId }, name: op.spec.name, label: op.spec.label }, now());
        store.setChatAvatar(op.chatId, op.spec.fruit, now());
        const conversationId = conversationOfPm(op.spec.pmId);
        store.advanceWatermark(op.chatId, { messageId: (conversationId === null ? null : latestMessageId(conversationId)) ?? 0 }, now());
        return;
      }
      case "rename":
        await api("chat.update", { chat_id: op.chatId, name: op.name });
        store.renameChat(op.chatId, op.name, op.label, now());
        return;
      case "set_avatar":
        await api("chat.update", { chat_id: op.chatId, avatar: await avatars.imageKeyOf(op.fruit, uploadAvatar) });
        store.setChatAvatar(op.chatId, op.fruit, now());
        return;
      case "dissolve": {
        const chat = store.chatById(op.chatId);
        await deleteChat(op.chatId);
        store.setChatArchived(op.chatId, dissolvedAt(chat?.target.kind === "pm" ? chat.target.pmId : null), now());
        return;
      }
      case "retire":
        if (!op.dissolved) await deleteChat(op.chatId);
        store.removeChat(op.chatId);
        return;
    }
  };

  const syncChats = async () => {
    const app = store.app();
    if (transport === null || !linkUp || app === null || app.ownerOpenId === null) return;
    const pms = ledger.snapshot().pms;
    const desired = desiredFeishuChats(pms, options.device);
    const bindings = store.chats().filter((c) => c.target.kind === "pm");
    const bound = new Set(bindings.flatMap((b) => (b.target.kind === "pm" && b.target.pmId !== null ? [b.target.pmId] : [])));
    const needsLookup = desired.some((d) => !d.archived && !bound.has(d.pmId));
    const marked = needsLookup ? await markedChats() : new Map<FeishuChatId, string>();
    for (const op of planFeishuChatSync(desired, bindings, marked, options.device.id)) {
      await applyChatOp(op, app.appId, app.ownerOpenId);
    }
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

  const sendDeliverables = async (chatId: FeishuChatId, messageId: MessageId, list: readonly (SentFile | Deliverable)[]) => {
    if (files === null) return;
    let part = 0;
    for (const file of list) {
      if (file.id === null) continue;
      const copy = resolveUpload(options.sentFilesDir, file.id);
      if (copy === null) continue;
      const out: FeishuOutboundFile = { messageId, part: part++, path: copy.path, name: copy.name, mime: copy.mime, bytes: copy.size };
      await files.send(chatId, out);
    }
  };

  /** 一段文字定稿：流式那张卡换成账本正文（关流式、去停止按钮），超长的续到新卡；再发它带的文件。 */
  const finalizeSegment = async (chatId: FeishuChatId, conversationId: ConversationId, effect: Extract<FeishuStreamEffect, { kind: "finalize" }>, posted: StreamSlot["posted"] = null) => {
    const message = ledger.getMessage(effect.messageId);
    const chunks = splitFeishuMarkdown(effect.text);
    for (const [part, chunk] of chunks.entries()) {
      if (projection.chatOfConversation(conversationId)?.chatId !== chatId) return;
      const ref: FeishuPostRef = { kind: "message", messageId: effect.messageId, part };
      let post = store.postOf(ref);
      if (post?.state === "final") continue;
      const card = renderReplyCard({ conversationId, text: chunk, streaming: false, withStop: false });
      if (part === 0 && posted !== null && post === null) {
        store.savePost({ ref, chatId, messageId: posted.messageId, cardId: posted.cardId, sequence: effect.sequence, state: "streaming" }, now());
        post = store.postOf(ref);
      }
      if (post?.cardId) {
        await updateCard(post.cardId, post.sequence, card, `fusa-final-${effect.messageId}`);
        if (projection.chatOfConversation(conversationId)?.chatId !== chatId) return;
        store.savePost({ ...post, state: "final" }, now());
      } else {
        const { messageId } = await sendMessage({ chatId }, "interactive", card, `fusa-m-${effect.messageId}-${part}`);
        if (projection.chatOfConversation(conversationId)?.chatId !== chatId) return;
        store.savePost({ ref, chatId, messageId, cardId: null, sequence: 0, state: "final" }, now());
      }
    }
    if (message !== null) await sendDeliverables(chatId, message.id, sentFilesOf(message));
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
      if (event.kind !== "text" && event.kind !== "segment_done") return;
      slot = { state: { phase: "idle" }, chatId, timer: null, timerAt: null, posted: null };
      streams.set(id, slot);
    }
    const current = slot;
    const step = stepFeishuStream(current.state, event, { conversationId: id, chatId }, now(), budget);
    current.state = step.state;
    if (current.state.phase === "idle") dropStream(id, current);
    for (const effect of step.effects) {
      switch (effect.kind) {
        case "open": {
          const card = renderReplyCard({ conversationId: id, text: effect.text, streaming: true, withStop: true });
          let posted: Awaited<ReturnType<typeof postCardEntity>>;
          try {
            posted = await postCardEntity(chatId, card, `fusa-s-${randomUUID()}`);
          } catch (error) {
            handleError(error);
            await feedStream(id, { kind: "open_failed" }, chatId, current);
            break;
          }
          current.posted = { ...posted, text: effect.text };
          await feedStream(id, { kind: "opened", ...posted, sequence: 0 }, chatId, current);
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
          await finalizeSegment(chatId, id, effect, current.posted);
          break;
        case "abandon": {
          const text = current.posted?.text || "（这一轮停下了）";
          await updateCard(effect.cardId, effect.sequence, renderReplyCard({ conversationId: id, text, streaming: false, withStop: false }));
          break;
        }
        case "schedule_tick":
          scheduleTick(id, current, effect.at);
          break;
      }
    }
  };

  const scheduleTick = (id: ConversationId, slot: StreamSlot, at: number) => {
    if (slot.timerAt !== null && slot.timerAt <= at) return;
    if (slot.timer !== null) clearTimeout(slot.timer);
    slot.timerAt = at;
    slot.timer = setTimeout(() => {
      slot.timer = null;
      slot.timerAt = null;
      if (streams.get(id) === slot) enqueue(slot.chatId, () => feedStream(id, { kind: "tick" }, slot.chatId, slot), `tick:${id}`);
    }, Math.max(0, at - now()));
    slot.timer.unref?.();
  };

  const postAskCard = async (chatId: FeishuChatId, message: Message, deliverables: readonly Deliverable[]) => {
    if (projection.chatOfConversation(message.conversationId)?.chatId !== chatId) return;
    const ref: FeishuPostRef = { kind: "message", messageId: message.id, part: 0 };
    if (store.postOf(ref) === null) {
      const ask = askOf(message);
      if (ask === null) return;
      const state = askStateOf(message);
      if (state.kind !== "pending") {
        store.advanceWatermark(chatId, { messageId: message.id }, now());
        return;
      }
      const posted = await postCardEntity(chatId, renderAskCard(message, ask, state), `fusa-a-${message.id}`);
      if (projection.chatOfConversation(message.conversationId)?.chatId !== chatId) return;
      store.savePost({ ref, chatId, messageId: posted.messageId, cardId: posted.cardId, sequence: 0, state: "card_pending" }, now());
    }
    await sendDeliverables(chatId, message.id, deliverables);
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
    await updateCard(post.cardId, post.sequence + 1, renderAskCard(message, ask, state));
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
    if (post.state !== "card_pending" || !settled || post.cardId === null) return;
    await updateCard(post.cardId, post.sequence + 1, card);
    if (store.chatById(post.chatId) !== null) store.savePost({ ...post, sequence: post.sequence + 1, state: "card_settled" }, now());
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

  const mirrorUser = async (chatId: FeishuChatId, message: Message) => {
    const text = message.text.trim() === "" ? "（发了文件）" : message.text;
    await postTextChunks(chatId, "网页上说", text, `fusa-u-${message.id}`, (part) => ({ kind: "message", messageId: message.id, part }), "grey");
    store.advanceWatermark(chatId, { messageId: message.id }, now());
  };

  const runIntent = (intent: FeishuOutboundIntent) => {
    switch (intent.kind) {
      case "sync_chats":
        requestControl("sync");
        return;
      case "stream":
      case "agent_text":
      case "turn_end":
      case "mirror_user":
      case "ask_card": {
        const chat = projection.chatOfConversation(intent.conversationId);
        if (chat === null) return;
        const id = intent.conversationId;
        if (intent.kind === "stream") enqueue(chat.chatId, () => feedStream(id, { kind: "text", text: intent.text }, chat.chatId), `stream:${id}`);
        else if (intent.kind === "agent_text")
          enqueue(chat.chatId, async () => {
            if ((store.chatById(chat.chatId)?.lastMessageId ?? 0) >= intent.message.id) return;
            await feedStream(id, { kind: "segment_done", messageId: intent.message.id, text: intent.message.text }, chat.chatId);
          });
        else if (intent.kind === "turn_end") enqueue(chat.chatId, () => feedStream(id, { kind: "turn_end" }, chat.chatId));
        else if (intent.kind === "mirror_user") enqueue(chat.chatId, () => mirrorUser(chat.chatId, intent.message));
        else enqueue(chat.chatId, () => postAskCard(chat.chatId, intent.message, intent.deliverables));
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
          enqueue(chat.chatId, () => replayRouterEvents(chat), "router-events");
          if (intent.item.kind === "decision" && intent.item.status !== "pending") {
            enqueue(chat.chatId, () => settleRouterItem(intent.item.id));
          }
        }
        return;
      }
      case "router_command": {
        const chat = store.chatOfTarget({ kind: "router" });
        if (chat !== null) enqueue(chat.chatId, () => replayRouterEvents(chat), "router-events");
        return;
      }
    }
  };

  const onLedgerChange = (change: Change) => {
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
      await feedStream(intent.conversationId, { kind: "segment_done", messageId: intent.message.id, text: intent.message.text }, chatId);
    } else if (intent.kind === "mirror_user") await mirrorUser(chatId, intent.message);
    else if (intent.kind === "ask_card") await postAskCard(chatId, intent.message, intent.deliverables);
  };

  /** all 为 false（刚连上）：每个项目群只补最后 FEISHU_CATCHUP_MAX_MESSAGES 条，前面的只计数；为 true（出站满载后）：从水位起逐页全补。 */
  const catchUp = async (all: boolean) => {
    for (const chat of store.chats()) {
      if (!linkUp || closed) return;
      if (chat.target.kind !== "pm" || chat.target.pmId === null || activeTarget(chat) === null) continue;
      const conversationId = conversationOfPm(chat.target.pmId);
      if (conversationId === null) continue;
      if (chat.lastMessageId === null) {
        const latest = latestMessageId(conversationId);
        store.advanceWatermark(chat.chatId, { messageId: latest ?? 0 }, now());
      }
      let after: MessageId = chat.lastMessageId ?? latestMessageId(conversationId) ?? 0;
      let skipped = 0;
      let tail: FeishuOutboundIntent[] = [];
      let scanned = after;
      for (;;) {
        const page = ledger.messagesAfter(conversationId, after, FEISHU_PAGE_SIZE);
        if (page.length === 0) break;
        if (!linkUp || closed) return;
        if (all) {
          const batch = catchUpIntents(conversationId, page, FEISHU_PAGE_SIZE);
          for (const intent of batch.intents) await replayPmIntent(chat.chatId, intent);
          if (batch.lastMessageId !== null) store.advanceWatermark(chat.chatId, { messageId: batch.lastMessageId }, now());
        } else {
          const batch = catchUpIntents(conversationId, page);
          const combined = [...tail, ...batch.intents];
          tail = combined.slice(-FEISHU_CATCHUP_MAX_MESSAGES);
          skipped += batch.omitted + combined.length - tail.length;
        }
        scanned = after = page.at(-1)!.id;
        if (page.length < FEISHU_PAGE_SIZE) break;
      }
      if (!all) {
        if (skipped > 0) await sendText({ chatId: chat.chatId }, `离线期间还有 ${skipped} 条，去网页看。`);
        for (const intent of tail) await replayPmIntent(chat.chatId, intent);
        if (scanned > (chat.lastMessageId ?? 0)) store.advanceWatermark(chat.chatId, { messageId: scanned }, now());
      }
      // 离线期间在网页上定案的卡
      for (const post of store.pendingCards(chat.target.pmId)) {
        if (post.ref.kind !== "message") continue;
        await settleAskCard(post.ref.messageId);
      }
    }
    const routerChat = projection.routerChat();
    if (routerChat !== null) {
      await replayRouterEvents(routerChat);
      await settleRouterCards(routerChat);
    }
    for (const [id, slot] of streams) await feedStream(id, { kind: "turn_end" }, slot.chatId, slot);
  };

  const replayRouterEvents = async (chat: FeishuChatBinding) => {
    const current = store.chatOfTarget({ kind: "router" });
    if (current?.chatId !== chat.chatId) return;
    let after = current.lastRouterEventId ?? 0;
    for (;;) {
      if (!linkUp || closed || store.chatById(chat.chatId) === null) return;
      const page = store.routerEventsAfter(after, FEISHU_PAGE_SIZE);
      for (const event of page) {
        if (event.item_id !== null) {
          const item = ledger.getRouterItem(event.item_id);
          if (item !== null) await postRouterItem(item);
        } else if (event.command_id !== null) {
          const command = ledger.getRouterCommand(event.command_id);
          if (command !== null && (command.status === "answered" || command.status === "dispatched" || command.status === "failed")) await postRouterCommand(command);
        }
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

  const closeMissingCard = async (post: NonNullable<ReturnType<typeof store.postOf>>) => {
    if (post.cardId === null) return;
    await updateCard(post.cardId, post.sequence + 1, renderTextCard({ title: "已关闭", text: "这张拍板卡已关闭。" }));
    if (store.chatById(post.chatId) !== null) store.savePost({ ...post, sequence: post.sequence + 1, state: "card_settled" }, now());
  };

  const settleRouterCards = async (chat: FeishuChatBinding) => {
    if (store.chatOfTarget({ kind: "router" })?.chatId !== chat.chatId) return;
    for (const post of store.pendingCards(null)) if (post.ref.kind === "router_item") await settleRouterItem(post.ref.itemId);
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
    if (!admit(inbound, event.chatId, () => handleInbound(event), null, limit)) {
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
        return;
      case "context":
        contexts.add(message.chatId, route.line);
        return;
      case "deliver": {
        const attachments = [];
        for (const file of route.files) {
          const saved = await files?.receive(message.messageId, file);
          if (saved) attachments.push(saved);
        }
        const clientId = `${FEISHU_CLIENT_PREFIX}${message.messageId}`;
        if (route.target.kind === "router") {
          if (options.router === null) {
            await sendText({ chatId: message.chatId }, "总助没开：去网页的总助工作台选一家 agent。");
            return;
          }
          await options.router.submitCommand({ clientId, text: route.text, ...(attachments.length > 0 ? { attachmentIds: attachments.map((a) => a.id) } : {}) });
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
          const admitted = admit(inbound, chatId, async () => {
            if (activeTarget(store.chatById(chatId)) === null) return;
            await setup.setChatPolicy({ pmId: route.pmId, ...(route.triggerMode ? { triggerMode: route.triggerMode } : {}), ...(route.guestTier ? { guestTier: route.guestTier } : {}) });
          }, null);
          return admitted ? toast("success", "已改") : toast("warning", "飞书正忙，请再点一次");
        }
        case "blocker_done": {
          const result = ledger.recheckUserBlocker(route.card.blockerId);
          return result.resolved ? toast("success", "已解开，接着派") : toast("warning", "还不能用，卡先留着");
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
            lastError = errorText(error);
          }
        },
        (error: unknown) => {
          if (abort.signal.aborted) return;
          registration = null;
          const code = error instanceof FeishuRegistrationError ? error.code : "error";
          lastError = code === "access_denied" ? "扫码后点了拒绝" : code === "expired_token" ? "二维码过期了，重新扫一次" : `扫码建应用没成：${errorText(error)}`;
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
      await syncChats();
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
        lastError = errorText(error);
        return;
      }
      const app = store.app();
      if (secrets === null || app === null || !app.enabled) return;
      // 不等长连接连上：网络慢、飞书挂了都不拖守护进程启动
      void startTransport(secrets);
    },
    idle() {
      if (!busy()) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    async close() {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      unsubscribe = null;
      registration?.abort.abort();
      registration = null;
      await stopTransport();
      for (const queue of [inbound, outbound]) {
        for (const lane of queue.lanes.values()) {
          queue.count -= lane.tasks.length;
          lane.tasks.length = 0;
        }
      }
      directory.clear();
      contexts.clearAll();
      settleIdle();
    },
  };
}
