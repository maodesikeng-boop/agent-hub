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
import type { Ledger } from "../../shared/ledger.ts";
import { ConversationNotFoundError, LedgerRequestError } from "../../shared/ledger.ts";
import {
  FEISHU_BIND_CODE_TTL_MS,
  FEISHU_CARD_ACTION_DEADLINE_MS,
  FEISHU_CARDKIT_BUDGET_PER_SECOND,
  FEISHU_CHAT_CACHE_MAX,
  FEISHU_CHAT_SENDS_PER_SECOND,
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
import { parseFeishuCardAction, parseFeishuEvent, type FeishuInbound } from "./inbound.ts";
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
  Ledger,
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
const ALREADY_DECIDED = "已经定过了";
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 一条串行的工作线（一个群一条）：保证同一个群里的发送有先后，各群之间并行。 */
interface Lane {
  tasks: { key: string | null; run: () => Promise<void> }[];
  running: boolean;
}

/** 一个项目经理对话的流式卡片：状态机现状、计时器、已推上去的正文（abandon 时留着它）。 */
interface StreamSlot {
  state: FeishuStreamState;
  chatId: FeishuChatId;
  timer: ReturnType<typeof setTimeout> | null;
  timerAt: number | null;
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
  /** 谁在飞书里点的定案（卡片改成“已定案”时写名字）；网页上点的是主人。 */
  const deciders = new LRUCache<string, string>({ max: FEISHU_CHAT_CACHE_MAX });
  /** 每个群最近几次发消息的时间（同一个群每秒不超过 FEISHU_CHAT_SENDS_PER_SECOND 条）。 */
  const sendTimes = new LRUCache<string, number[]>({ max: FEISHU_CHAT_CACHE_MAX });

  // ---- 排队 ----

  const lanes = new Map<string, Lane>();
  let queued = 0;
  let inboundQueued = 0;
  const idleWaiters: (() => void)[] = [];
  const settleIdle = () => {
    if (queued > 0 || [...lanes.values()].some((l) => l.running)) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  };
  const drain = async (name: string, lane: Lane) => {
    if (lane.running) return;
    lane.running = true;
    while (lane.tasks.length > 0) {
      const task = lane.tasks.shift()!;
      queued--;
      try {
        await task.run();
      } catch (error) {
        handleError(error);
      }
    }
    lane.running = false;
    lanes.delete(name);
    settleIdle();
  };
  /** key 相同、还没开始的任务直接换成新的（流式推送只要最新的全文）。 */
  const enqueue = (name: string, run: () => Promise<void>, key: string | null = null) => {
    if (closed) return;
    let lane = lanes.get(name);
    if (lane === undefined) {
      lane = { tasks: [], running: false };
      lanes.set(name, lane);
    }
    if (key !== null) {
      const pending = lane.tasks.find((t) => t.key === key);
      if (pending !== undefined) {
        pending.run = run;
        return;
      }
      if (queued >= FEISHU_OUTBOUND_QUEUE_MAX) return;
    }
    lane.tasks.push({ key, run });
    queued++;
    void drain(name, lane);
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
    const times = (sendTimes.get(chatId) ?? []).filter((t) => now() - t < 1000);
    if (times.length >= FEISHU_CHAT_SENDS_PER_SECOND) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 1000 - (now() - times[0]!))));
    }
    sendTimes.set(chatId, [...times.filter((t) => now() - t < 1000), now()]);
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
      content: JSON.stringify(content),
      uuid: uuid.slice(0, 50),
    });
    const messageId = parseFeishuMessageId(feishuStringField(data, "message_id"));
    if (messageId === null) throw new Error("飞书发消息没回消息编号");
    return { messageId, chatId: parseFeishuChatId(feishuStringField(data, "chat_id")) };
  };

  /** 卡片实体（以后要改的卡）：先建实体再按 card_id 发。 */
  const postCardEntity = async (chatId: FeishuChatId, card: FeishuCardJson, uuid: string) => {
    const data = await api("card.create", { type: "card_json", data: JSON.stringify(card) });
    const cardId = parseFeishuCardId(feishuStringField(data, "card_id"));
    if (cardId === null) throw new Error("飞书建卡片没回卡片编号");
    const { messageId } = await sendMessage({ chatId }, "interactive", { type: "card", data: { card_id: cardId } }, uuid);
    return { cardId, messageId };
  };

  const updateCard = async (cardId: FeishuCardId, sequence: number, card: FeishuCardJson) => {
    await api("card.update", { card_id: cardId, card: { type: "card_json", data: JSON.stringify(card) }, sequence, uuid: randomUUID() });
  };

  const sendText = (to: { chatId: FeishuChatId } | { openId: FeishuOpenId }, text: string) => sendMessage(to, "text", { text }, `fusa-t-${randomUUID()}`);

  // ---- 账本这边的查询 ----

  const pmOfConversation = (conversationId: ConversationId): PmId | null =>
    db.get<{ pm_id: number | null }>("SELECT pm_id FROM conversations WHERE id = ? AND kind = 'pm'", conversationId)?.pm_id ?? null;
  const conversationOfPm = (pmId: PmId): ConversationId | null =>
    db.get<{ id: number }>("SELECT id FROM conversations WHERE kind = 'pm' AND pm_id = ? ORDER BY id LIMIT 1", pmId)?.id ?? null;
  const latestMessageId = (conversationId: ConversationId): MessageId | null =>
    db.get<{ id: number | null }>("SELECT max(id) AS id FROM messages WHERE conversation_id = ?", conversationId)?.id ?? null;
  const liveChatOfPm = (pmId: PmId): FeishuChatBinding | null => {
    const chat = store.chatOfTarget({ kind: "pm", pmId });
    return chat !== null && chat.archivedAt === null ? chat : null;
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
    for (const slot of streams.values()) if (slot.timer !== null) clearTimeout(slot.timer);
    streams.clear();
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
    enqueue("control", async () => {
      await checkScopes();
      if (owner() !== null) {
        await ensureRouterChat();
        await syncChats();
        await catchUp();
      }
    });
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
    directory.forget(chatId);
    contexts.clear(chatId);
  };

  /** 每个项目经理上次建群用的 generation：解散时间要比它大，同一毫秒里连着解散两次也不会撞上同一个建群 uuid。 */
  const lastGeneration = new Map<PmId, number>();
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

  const deciderKey = (ref: FeishuCardRef) => JSON.stringify(ref);

  /** 一张提问卡现在该画成什么样。 */
  const askStateOf = (message: Message): FeishuCardState => {
    const ask = askOf(message);
    if (ask === null) return { kind: "closed" };
    return feishuCardStateOf(ask, deciders.get(deciderKey(feishuCardRefOf(message, ask))) ?? displayOwner());
  };

  const routerItemState = (item: RouterItem, ask: Message | null): FeishuCardState => {
    if (ask !== null) return askStateOf(ask);
    if (item.kind === "report" || item.status === "pending") return { kind: "pending" };
    if (item.status === "superseded") return { kind: "closed" };
    return {
      kind: "answered",
      chosenOption: item.resolution?.chosenOption ?? null,
      note: item.resolution?.note ? item.resolution.note : null,
      byName: deciders.get(deciderKey({ kind: "router_item", itemId: item.id })) ?? displayOwner(),
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

  // 流式卡片：每个项目经理对话最多一张在流式，所以这两张表跟着 streams 一样有上限，定稿或收尾就删
  /** 流式卡片实体 → 发出去的那条飞书消息（定稿时记 feishu_posts）。 */
  const openedMessage = new Map<FeishuCardId, FeishuMessageId>();
  /** abandon 时卡上留下的正文。 */
  const sentTextOf = new Map<FeishuCardId, string>();

  /** 一段文字定稿：流式那张卡换成账本正文（关流式、去停止按钮），超长的续到新卡；再发它带的文件。 */
  const finalizeSegment = async (chatId: FeishuChatId, conversationId: ConversationId, effect: Extract<FeishuStreamEffect, { kind: "finalize" }>) => {
    const message = ledger.getMessage(effect.messageId);
    const chunks = splitFeishuMarkdown(effect.text);
    for (const [part, chunk] of chunks.entries()) {
      const ref: FeishuPostRef = { kind: "message", messageId: effect.messageId, part };
      if (store.postOf(ref) !== null) continue;
      const card = renderReplyCard({ conversationId, text: chunk, streaming: false, withStop: false });
      if (part === 0 && effect.cardId !== null) {
        await updateCard(effect.cardId, effect.sequence, card);
        const feishuMessageId = openedMessage.get(effect.cardId);
        openedMessage.delete(effect.cardId);
        if (feishuMessageId !== undefined) store.savePost({ ref, chatId, messageId: feishuMessageId, cardId: effect.cardId, sequence: effect.sequence, state: "final" }, now());
      } else {
        const { messageId } = await sendMessage({ chatId }, "interactive", card, `fusa-m-${effect.messageId}-${part}`);
        store.savePost({ ref, chatId, messageId, cardId: null, sequence: 0, state: "final" }, now());
      }
    }
    if (message !== null) await sendDeliverables(chatId, message.id, sentFilesOf(message));
    store.advanceWatermark(chatId, { messageId: effect.messageId }, now());
  };

  const runStreamEffects = async (conversationId: ConversationId, slot: StreamSlot, effects: FeishuStreamEffect[]) => {
    for (const effect of effects) {
      switch (effect.kind) {
        case "open": {
          const card = renderReplyCard({ conversationId, text: effect.text, streaming: true, withStop: true });
          const opened = await postCardEntity(slot.chatId, card, `fusa-s-${conversationId}-${randomUUID()}`);
          openedMessage.set(opened.cardId, opened.messageId);
          sentTextOf.set(opened.cardId, effect.text);
          await feedStream(conversationId, { kind: "opened", cardId: opened.cardId, messageId: opened.messageId, sequence: 0 });
          break;
        }
        case "push":
          await api("card.element.content", { card_id: effect.cardId, element_id: "reply", content: effect.text, sequence: effect.sequence, uuid: randomUUID() });
          sentTextOf.set(effect.cardId, effect.text);
          break;
        case "renew":
          await api("card.settings", { card_id: effect.cardId, settings: JSON.stringify({ config: { streaming_mode: true } }), sequence: effect.sequence, uuid: randomUUID() });
          break;
        case "finalize":
          await finalizeSegment(slot.chatId, conversationId, effect);
          if (effect.cardId !== null) sentTextOf.delete(effect.cardId);
          break;
        case "abandon": {
          const text = sentTextOf.get(effect.cardId) ?? "";
          await updateCard(effect.cardId, effect.sequence, renderReplyCard({ conversationId, text: text === "" ? "（这一轮停下了）" : text, streaming: false, withStop: false }));
          sentTextOf.delete(effect.cardId);
          openedMessage.delete(effect.cardId);
          break;
        }
        case "schedule_tick":
          scheduleTick(conversationId, slot, effect.at);
          break;
      }
    }
  };

  const scheduleTick = (conversationId: ConversationId, slot: StreamSlot, at: number) => {
    if (slot.timer !== null && slot.timerAt !== null && slot.timerAt <= at) return;
    if (slot.timer !== null) clearTimeout(slot.timer);
    slot.timerAt = at;
    slot.timer = setTimeout(() => {
      slot.timer = null;
      slot.timerAt = null;
      enqueue(slot.chatId, () => feedStream(conversationId, { kind: "tick" }), `tick:${conversationId}`);
    }, Math.max(0, at - now()));
    slot.timer.unref?.();
  };

  const feedStream = async (conversationId: ConversationId, event: FeishuStreamEvent) => {
    const binding = projection.chatOfConversation(conversationId);
    let slot = streams.get(conversationId);
    if (slot === undefined) {
      if (binding === null) return;
      slot = { state: { phase: "idle" }, chatId: binding.chatId, timer: null, timerAt: null };
      streams.set(conversationId, slot);
    }
    const step = stepFeishuStream(slot.state, event, { conversationId, chatId: slot.chatId }, now(), budget);
    slot.state = step.state;
    await runStreamEffects(conversationId, slot, step.effects);
    if (slot.state.phase === "idle" && slot.timer === null) streams.delete(conversationId);
  };

  const postAskCard = async (chatId: FeishuChatId, message: Message, deliverables: readonly Deliverable[]) => {
    const ref: FeishuPostRef = { kind: "message", messageId: message.id, part: 0 };
    if (store.postOf(ref) === null) {
      const ask = askOf(message);
      if (ask === null) return;
      const state = askStateOf(message);
      if (state.kind !== "pending") return;
      const posted = await postCardEntity(chatId, renderAskCard(message, ask, state), `fusa-a-${message.id}`);
      store.savePost({ ref, chatId, messageId: posted.messageId, cardId: posted.cardId, sequence: 0, state: "card_pending" }, now());
    }
    await sendDeliverables(chatId, message.id, deliverables);
    store.advanceWatermark(chatId, { messageId: message.id }, now());
  };

  const settleAskCard = async (message: Message) => {
    const post = store.postOf({ kind: "message", messageId: message.id, part: 0 });
    const ask = askOf(message);
    if (post === null || post.state !== "card_pending" || post.cardId === null || ask === null) return;
    const state = askStateOf(message);
    if (state.kind === "pending") return;
    await updateCard(post.cardId, post.sequence + 1, renderAskCard(message, ask, state));
    store.savePost({ ...post, sequence: post.sequence + 1, state: "card_settled" }, now());
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
      store.savePost({ ref, chatId: chat.chatId, messageId: posted.messageId, cardId: posted.cardId, sequence: 0, state: item.kind === "report" ? "final" : "card_pending" }, now());
      store.advanceWatermark(chat.chatId, { routerItemId: item.id }, now());
      return;
    }
    if (post.state !== "card_pending" || !settled || post.cardId === null) return;
    await updateCard(post.cardId, post.sequence + 1, card);
    store.savePost({ ...post, sequence: post.sequence + 1, state: "card_settled" }, now());
  };

  const routerReplyText = (command: RouterCommandRecord): string => {
    if (command.status === "failed") return `没办成：${command.error ?? "未知原因"}`;
    const reply = command.plan?.reply ?? "";
    if (reply !== "") return reply;
    const targets = (command.dispatched ?? []).map((d) => `${d.pmName ?? `项目经理 ${d.pmId}`}${d.ok ? "" : `（没送到：${d.error ?? "未知原因"}）`}`);
    return targets.length > 0 ? `已交给：${targets.join("、")}` : "好的。";
  };

  const postRouterCommand = async (command: RouterCommandRecord) => {
    const chat = store.chatOfTarget({ kind: "router" });
    if (chat === null) return;
    const ref: FeishuPostRef = { kind: "router_command", commandId: command.id };
    if (store.postOf(ref) !== null) return;
    const fromFeishu = command.clientId.startsWith(FEISHU_CLIENT_PREFIX);
    const text = fromFeishu ? routerReplyText(command) : `**网页上说**：${command.inputText}\n\n${routerReplyText(command)}`;
    const { messageId } = await sendMessage({ chatId: chat.chatId }, "interactive", renderTextCard({ title: "总助", text }), `fusa-c-${command.id}`);
    store.savePost({ ref, chatId: chat.chatId, messageId, cardId: null, sequence: 0, state: "final" }, now());
    store.advanceWatermark(chat.chatId, { routerCommandId: command.id }, now());
  };

  const mirrorUser = async (chatId: FeishuChatId, message: Message) => {
    const ref: FeishuPostRef = { kind: "message", messageId: message.id, part: 0 };
    if (store.postOf(ref) !== null) return;
    const text = message.text.trim() === "" ? "（发了文件）" : message.text;
    const { messageId } = await sendMessage({ chatId }, "interactive", renderTextCard({ title: "网页上说", text, template: "grey" }), `fusa-u-${message.id}`);
    store.savePost({ ref, chatId, messageId, cardId: null, sequence: 0, state: "final" }, now());
    store.advanceWatermark(chatId, { messageId: message.id }, now());
  };

  const runIntent = (intent: FeishuOutboundIntent) => {
    switch (intent.kind) {
      case "sync_chats":
        enqueue("control", syncChats, "sync");
        return;
      case "stream":
      case "agent_text":
      case "turn_end":
      case "mirror_user":
      case "ask_card": {
        const chat = projection.chatOfConversation(intent.conversationId);
        if (chat === null) return;
        const id = intent.conversationId;
        if (intent.kind === "stream") enqueue(chat.chatId, () => feedStream(id, { kind: "text", text: intent.text }), `stream:${id}`);
        else if (intent.kind === "agent_text")
          enqueue(chat.chatId, async () => {
            if (store.postOf({ kind: "message", messageId: intent.message.id, part: 0 }) !== null) return;
            await feedStream(id, { kind: "segment_done", messageId: intent.message.id, text: intent.message.text });
          });
        else if (intent.kind === "turn_end") enqueue(chat.chatId, () => feedStream(id, { kind: "turn_end" }));
        else if (intent.kind === "mirror_user") enqueue(chat.chatId, () => mirrorUser(chat.chatId, intent.message));
        else enqueue(chat.chatId, () => postAskCard(chat.chatId, intent.message, intent.deliverables));
        return;
      }
      case "ask_settled": {
        const chat = projection.chatOfConversation(intent.conversationId);
        enqueue(chat?.chatId ?? "control", () => settleAskCard(intent.message));
        return;
      }
      case "router_item": {
        const chat = store.chatOfTarget({ kind: "router" });
        if (chat !== null) enqueue(chat.chatId, () => postRouterItem(intent.item));
        return;
      }
      case "router_command": {
        const chat = store.chatOfTarget({ kind: "router" });
        if (chat !== null) enqueue(chat.chatId, () => postRouterCommand(intent.command));
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

  const catchUp = async () => {
    for (const chat of store.chats()) {
      if (chat.target.kind !== "pm" || chat.target.pmId === null || chat.archivedAt !== null) continue;
      const conversationId = conversationOfPm(chat.target.pmId);
      if (conversationId === null) continue;
      if (chat.lastMessageId === null) {
        const latest = latestMessageId(conversationId);
        if (latest !== null) store.advanceWatermark(chat.chatId, { messageId: latest }, now());
        continue;
      }
      // 只留最后一页，前面的只计数：内存不随离线时长变大
      let after: MessageId = chat.lastMessageId;
      let skipped = 0;
      let tail: Message[] = [];
      for (;;) {
        const page = ledger.messagesAfter(conversationId, after, FEISHU_PAGE_SIZE);
        if (page.length === 0) break;
        skipped += catchUpIntents(conversationId, tail).intents.length;
        tail = page;
        after = page.at(-1)!.id;
        if (page.length < FEISHU_PAGE_SIZE) break;
      }
      const { intents, omitted, lastMessageId } = catchUpIntents(conversationId, tail);
      const hidden = skipped + omitted;
      if (hidden > 0) await sendText({ chatId: chat.chatId }, `离线期间还有 ${hidden} 条，去网页看。`);
      for (const intent of intents) {
        if (intent.kind === "agent_text") await finalizeSegment(chat.chatId, conversationId, { kind: "finalize", cardId: null, sequence: 0, messageId: intent.message.id, text: intent.message.text });
        else if (intent.kind === "mirror_user") await mirrorUser(chat.chatId, intent.message);
        else if (intent.kind === "ask_card") await postAskCard(chat.chatId, intent.message, intent.deliverables);
      }
      if (lastMessageId !== null) store.advanceWatermark(chat.chatId, { messageId: lastMessageId }, now());
      // 离线期间在网页上定案的卡
      for (const post of store.pendingCards(chat.target.pmId)) {
        if (post.ref.kind !== "message") continue;
        const message = ledger.getMessage(post.ref.messageId);
        if (message !== null) await settleAskCard(message);
      }
    }
    const pendingRouter = store.pendingCards(null);
    if (pendingRouter.length > 0) {
      const items = new Map(ledger.snapshot().router.items.map((i) => [i.id, i]));
      for (const post of pendingRouter) {
        if (post.ref.kind !== "router_item") continue;
        const item = items.get(post.ref.itemId);
        if (item !== undefined) await postRouterItem(item);
      }
    }
  };

  // ---- 入站 ----

  const onRawEvent = (raw: FeishuRawEvent) => {
    const app = store.app();
    if (app === null) return;
    const event = parseFeishuEvent(raw, app.botOpenId);
    if (event === null) return;
    // 进的满了先丢成员和改名事件（重连对账会补回）
    if (inboundQueued >= FEISHU_INBOUND_QUEUE_MAX && event.kind !== "message") return;
    inboundQueued++;
    enqueue(`in:${event.chatId}`, async () => {
      inboundQueued--;
      await handleInbound(event);
    });
  };

  const isBindCode = (text: string) => bindCode !== null && bindCode.expiresAt > now() && text.trim() === bindCode.code;

  const policyCardFor = async (chat: FeishuChatBinding) => {
    if (chat.target.kind !== "pm" || chat.target.pmId === null) return;
    const pmId = chat.target.pmId;
    const ref: FeishuPostRef = { kind: "chat_policy", pmId };
    if (store.postOf(ref) !== null) return;
    const posted = await postCardEntity(chat.chatId, renderChatPolicyCard({ pmId, triggerMode: chat.triggerMode, guestTier: chat.guestTier, mentionOnlyForced: mentionOnly }), `fusa-p-${chat.chatId}`);
    store.savePost({ ref, chatId: chat.chatId, messageId: posted.messageId, cardId: posted.cardId, sequence: 0, state: "final" }, now());
  };

  const handleInbound = async (event: FeishuInbound) => {
    const o = owner();
    switch (event.kind) {
      case "members_added": {
        directory.applyJoined(event.chatId, event.openIds.map((openId) => ({ openId, name: "" })), now());
        const chat = store.chatById(event.chatId);
        if (chat !== null && o !== null && event.openIds.some((id) => id !== o)) await policyCardFor(chat);
        return;
      }
      case "members_removed":
        directory.applyLeft(event.chatId, event.openIds, now());
        return;
      case "chat_gone": {
        directory.forget(event.chatId);
        contexts.clear(event.chatId);
        const chat = store.chatById(event.chatId);
        if (chat === null || chat.archivedAt !== null) return;
        if (chat.target.kind === "router") {
          store.removeChat(event.chatId);
          return;
        }
        // 记成“已解散”而不是删掉：唤醒方式和访客档位留着，下一次对齐按这个时间当 generation 重建（建群 uuid 不会撞上 10 小时内的旧请求）
        store.setChatArchived(event.chatId, dissolvedAt(chat.target.pmId), now());
        enqueue("control", syncChats, "sync");
        return;
      }
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
    const chat = message.chatType === "p2p" ? store.chatOfTarget({ kind: "router" }) : store.chatById(message.chatId);
    const group = message.chatType === "group" && chat !== null && chat.target.kind === "pm";
    const mode = group && o !== null ? await directory.modeOf(message.chatId, o, message.senderOpenId, t) : "solo";
    const speakerName = group ? await directory.nameOf(message.chatId, message.senderOpenId, "", t) : message.senderOpenId === o ? displayOwner() : "";
    const route = routeFeishuMessage(message, {
      ownerOpenId: o,
      binding: chat === null || (message.chatType === "group" && chat.target.kind !== "pm") ? null : { target: chat.target as FeishuChatTarget, archived: chat.archivedAt !== null },
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
        enqueue("control", async () => {
          await syncChats();
        });
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

  /** 卡片点击：账本接口都是同步的，在回调里直接调，结果转成 toast。 */
  const onRawCardAction = (raw: FeishuRawCardAction): FeishuCardActionResponse => {
    const started = now();
    const action = parseFeishuCardAction(raw);
    if (action === null) return { toast: { type: "warning", content: "这张卡已过期，去网页看" } };
    const app = store.app();
    const chat = store.chatById(action.chatId);
    const route = routeFeishuAction(action, {
      ownerOpenId: app?.ownerOpenId ?? null,
      binding: chat === null ? null : { target: chat.target as FeishuChatTarget, archived: chat.archivedAt !== null },
      guestTier: chat?.guestTier ?? "chat_only",
    });
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
        case "set_policy":
          void setup.setChatPolicy({ pmId: route.pmId, ...(route.triggerMode ? { triggerMode: route.triggerMode } : {}), ...(route.guestTier ? { guestTier: route.guestTier } : {}) }).catch(handleError);
          return toast("success", "已改");
        case "blocker_done": {
          const result = ledger.recheckUserBlocker(route.card.blockerId);
          return result.resolved ? toast("success", "已解开，接着派") : toast("warning", "还不能用，卡先留着");
        }
        case "answer": {
          const name = operator === owner() ? displayOwner() : (directory.peekMembers(chatId)?.find((m) => m.openId === operator)?.name || "访客");
          deciders.set(deciderKey(route.card), name);
          answerCard(route);
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

  const answerCard = (route: Extract<FeishuActionRoute, { kind: "answer" }>) => {
    const { card, optionIndex, note, clientId } = route;
    if (card.kind === "router_item") {
      ledger.resolveRouterItem(card.itemId, { clientId, ...(optionIndex !== null ? { optionIndex } : {}), ...(note !== null ? { note } : {}) });
      return;
    }
    const message = ledger.getMessage(card.askMessageId);
    const ask = message === null ? null : askOf(message);
    if (ask === null) throw new LedgerRequestError("not_found", "这张卡已经不在了");
    if (ask.answered === true || ask.closed === true) throw new LedgerRequestError("conflict", ALREADY_DECIDED);
    const choice = optionIndex === null ? null : (feishuAskOptions(ask)[optionIndex] ?? null);
    if (card.kind === "gate") {
      ledger.decideTaskNode(card.graphId, card.nodeKey, { clientId, choice, note });
      return;
    }
    ledger.answerAsk(card.askMessageId, { clientId, choice, ...(note !== null ? { note } : {}) });
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
      if (queued === 0 && ![...lanes.values()].some((l) => l.running)) return Promise.resolve();
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
      lanes.clear();
      queued = 0;
      directory.clear();
      contexts.clearAll();
      settleIdle();
    },
  };
}
