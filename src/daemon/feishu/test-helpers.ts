// 测试用的假飞书：记下每次调用，按飞书的回包形状回编号；长连接的回调存下来，测试直接喂事件和点击。
import {
  feishuDataOf,
  feishuStringField,
  type FeishuApiResult,
  type FeishuConnectionHandlers,
  type FeishuFileUpload,
  type FeishuImageUpload,
  type FeishuListMessagesInput,
  type FeishuListMessagesPage,
  type FeishuMethod,
  type FeishuMethodArgs,
  type FeishuRawCardAction,
  type FeishuRawEvent,
  type FeishuRawMessageEvent,
  type FeishuTransport,
} from "./transport.ts";

export interface FakeCall {
  method: FeishuMethod | "uploadImage" | "uploadFile" | "downloadResource";
  args: Record<string, unknown>;
  at: number;
}

export interface FakeChat {
  chatId: string;
  name: string;
  description: string;
  avatar: string | null;
  members: { member_id: string; name: string }[];
}

export interface FakeFeishu extends FeishuTransport {
  calls: FakeCall[];
  chats: Map<string, FakeChat>;
  sent: { chatId: string; messageId: string; content: string }[];
  /** 飞书服务端存下的各会话历史消息（含机器人自己发的 app 消息与用户发的 user 消息）。 */
  history: Map<string, FeishuRawMessageEvent[]>;
  /** 建过的卡片实体：卡片编号 → 建卡时的卡片 JSON。 */
  cards: Map<string, string>;
  /** 授予的权限（application.scopes 回它）。 */
  granted: string[];
  handlers: FeishuConnectionHandlers | null;
  /** 某个方法下一次调用回这个结果（用完即删）。 */
  failNext: Partial<Record<FeishuMethod, FeishuApiResult | Error>>;
  /** 某个会话拉历史消息时固定或单次回这个结果（测试单群缺权限、单群报错隔离）。 */
  failListForChat: Map<string, FeishuApiResult | Error>;
  /** 每次拉历史消息前可选钩子（测试模拟慢请求与并发闪断重连合并）。 */
  beforeListMessages: ((args: FeishuMethodArgs["message.list"]) => Promise<void>) | null;
  /** 下载资源时回的内容；没有就抛错。 */
  resources: Map<string, Buffer>;
  /** 调用记录用的时钟。 */
  clock: () => number;
  /** 每次上传图片、文件前先等它（测试用来模拟慢网、上传失败）；抛错就当这次上传失败。 */
  beforeUpload: ((input: FeishuImageUpload | FeishuFileUpload) => Promise<void>) | null;
  callsOf<M extends FeishuMethod>(method: M): FeishuMethodArgs[M][];
  /** 模拟消息已落入飞书服务端会话历史，但未通过 WebSocket 推给客户端（断线窗口漏消息）。 */
  recordMessage(event: FeishuRawMessageEvent): void;
  event(event: FeishuRawEvent): void;
  click(action: FeishuRawCardAction): ReturnType<FeishuConnectionHandlers["onCardAction"]>;
}

export function createFakeFeishu(options: { clock?: () => number; botOpenId?: string } = {}): FakeFeishu {
  let seq = 0;
  const next = (prefix: string) => `${prefix}${++seq}`;
  const uploadedTypes = new Map<string, FeishuFileUpload["fileType"]>();
  /** 照飞书的规矩：mp4 上传的只能发 media，opus 上传的只能发 audio，别的只能发 file，不配对回 230055。 */
  const uploadMismatch = (msgType: string, content: string): FeishuApiResult | null => {
    const fileKey = (JSON.parse(content) as { file_key?: unknown }).file_key;
    if (typeof fileKey !== "string") return null;
    const fileType = uploadedTypes.get(fileKey);
    const expected = fileType === "mp4" ? "media" : fileType === "opus" ? "audio" : "file";
    if (fileType === undefined || msgType === expected) return null;
    return { code: 230055, msg: "The type of file upload does not match the type of message being sent.", httpStatus: 400 };
  };
  const botOpenId = options.botOpenId ?? "ou_bot";
  const appendHistory = (event: FeishuRawMessageEvent) => {
    const list = fake.history.get(event.chatId) ?? [];
    if (!list.some((m) => m.messageId === event.messageId)) {
      list.push(event);
      fake.history.set(event.chatId, list);
    }
  };
  const fake: FakeFeishu = {
    calls: [],
    chats: new Map(),
    sent: [],
    history: new Map(),
    cards: new Map(),
    granted: [],
    handlers: null,
    failNext: {},
    failListForChat: new Map(),
    beforeListMessages: null,
    resources: new Map(),
    clock: options.clock ?? (() => 0),
    beforeUpload: null,
    callsOf<M extends FeishuMethod>(method: M) {
      return fake.calls.filter((c) => c.method === method).map((c) => c.args as unknown as FeishuMethodArgs[M]);
    },
    async call(method, args) {
      fake.calls.push({ method, args: args as unknown as Record<string, unknown>, at: fake.clock() });
      const injected = fake.failNext[method];
      if (injected !== undefined) {
        delete fake.failNext[method];
        if (injected instanceof Error) throw injected;
        return injected;
      }
      const a = args as unknown as Record<string, unknown>;
      switch (method) {
        case "bot.info":
          return { code: 0, data: { bot: { open_id: botOpenId, app_name: "Fusa 机器人" } } };
        case "application.scopes":
          return { code: 0, data: { scopes: fake.granted.map((scope_name) => ({ scope_name, grant_status: 1 })) } };
        case "chat.create": {
          const chatId = next("oc_fake");
          fake.chats.set(chatId, {
            chatId,
            name: String(a.name),
            description: String(a.description),
            avatar: (a.avatar as string | undefined) ?? null,
            members: (a.user_id_list as string[]).map((member_id) => ({ member_id, name: "主人" })),
          });
          return { code: 0, data: { chat_id: chatId } };
        }
        case "chat.update": {
          const chat = fake.chats.get(String(a.chat_id));
          if (chat === undefined) return { code: 232011, msg: "chat not found" };
          if (typeof a.name === "string") chat.name = a.name;
          if (typeof a.avatar === "string") chat.avatar = a.avatar;
          if (typeof a.description === "string") chat.description = a.description;
          return { code: 0, data: {} };
        }
        case "chat.get": {
          const chat = fake.chats.get(String(a.chat_id));
          return chat === undefined ? { code: 232011, msg: "chat not found" } : { code: 0, data: { name: chat.name, description: chat.description } };
        }
        case "chat.list":
          return { code: 0, data: { items: [...fake.chats.values()].map((c) => ({ chat_id: c.chatId, name: c.name, description: c.description })), has_more: false } };
        case "chat.members": {
          const chat = fake.chats.get(String(a.chat_id));
          return chat === undefined ? { code: 232011, msg: "chat not found" } : { code: 0, data: { items: chat.members, has_more: false } };
        }
        case "chat.delete":
          fake.chats.delete(String(a.chat_id));
          return { code: 0, data: {} };
        case "message.create": {
          const mismatch = uploadMismatch(String(a.msg_type), String(a.content));
          if (mismatch !== null) return mismatch;
          const messageId = next("om_fake");
          const chatId = a.receive_id_type === "chat_id" ? String(a.receive_id) : "oc_p2p";
          fake.sent.push({ chatId, messageId, content: String(a.content) });
          appendHistory({
            type: "im.message.receive_v1",
            messageId,
            chatId,
            chatType: a.receive_id_type === "open_id" || chatId === "oc_p2p" ? "p2p" : "group",
            senderOpenId: botOpenId,
            senderType: "app",
            content: String(a.content),
            mentionedBot: false,
            threadId: null,
            resources: [],
            createTime: fake.clock() || Date.now(),
          });
          return { code: 0, data: { message_id: messageId, chat_id: chatId } };
        }
        case "message.list": {
          const listArgs = a as unknown as FeishuMethodArgs["message.list"];
          await fake.beforeListMessages?.(listArgs);
          const chatErr = fake.failListForChat.get(listArgs.container_id);
          if (chatErr !== undefined) {
            if (chatErr instanceof Error) throw chatErr;
            return chatErr;
          }
          if (listArgs.page_size < 1 || listArgs.page_size > 50) {
            return { code: 230001, msg: "Your request contains an invalid request parameter: page_size", httpStatus: 400 };
          }
          const hasStart = listArgs.start_time !== undefined && listArgs.start_time !== "";
          const hasEnd = listArgs.end_time !== undefined && listArgs.end_time !== "";
          if (hasStart && (!hasEnd || Number(listArgs.end_time) < Number(listArgs.start_time))) {
            return { code: 230001, msg: "end_time earlier than start_time", httpStatus: 400 };
          }
          const startMs = hasStart ? Number(listArgs.start_time) * 1000 : 0;
          const endMs = hasEnd ? Number(listArgs.end_time) * 1000 + 999 : Number.MAX_SAFE_INTEGER;
          const filtered = (fake.history.get(listArgs.container_id) ?? []).filter(
            (m) => m.createTime >= startMs && m.createTime <= endMs,
          );
          const ordered = listArgs.sort_type === "ByCreateTimeDesc" ? [...filtered].reverse() : [...filtered];
          const offset = listArgs.page_token ? Number(listArgs.page_token) : 0;
          const slice = ordered.slice(offset, offset + listArgs.page_size);
          const nextOffset = offset + slice.length;
          const hasMore = nextOffset < ordered.length;
          return {
            code: 0,
            data: {
              items: slice,
              has_more: hasMore,
              ...(hasMore ? { page_token: String(nextOffset) } : {}),
            },
          };
        }
        case "card.create": {
          const cardId = next("card");
          fake.cards.set(cardId, String(a.data));
          return { code: 0, data: { card_id: cardId } };
        }
        case "message.delete":
        case "card.update":
        case "card.settings":
        case "card.element.content":
          return { code: 0, data: {} };
      }
      return { code: 0, data: {} };
    },
    async listMessages(input: FeishuListMessagesInput): Promise<FeishuListMessagesPage> {
      const data = feishuDataOf(
        "message.list",
        await fake.call("message.list", {
          container_id_type: "chat",
          container_id: input.chatId,
          start_time: input.startTimeSec,
          end_time: input.endTimeSec,
          sort_type: input.sortType ?? "ByCreateTimeAsc",
          page_size: input.pageSize,
          ...(input.pageToken ? { page_token: input.pageToken } : {}),
        }),
      );
      const items = ((data.items as FeishuRawMessageEvent[] | undefined) ?? []).map((m) => ({
        ...m,
        chatType: input.chatType,
      }));
      const pageToken = data.has_more === true ? feishuStringField(data, "page_token") : null;
      return { items, pageToken, hasMore: data.has_more === true && pageToken !== null };
    },
    async uploadImage(input: FeishuImageUpload) {
      fake.calls.push({ method: "uploadImage", args: { ...input }, at: fake.clock() });
      await fake.beforeUpload?.(input);
      return { imageKey: next("img_") };
    },
    async uploadFile(input: FeishuFileUpload) {
      fake.calls.push({ method: "uploadFile", args: { ...input }, at: fake.clock() });
      await fake.beforeUpload?.(input);
      const fileKey = next("file_");
      uploadedTypes.set(fileKey, input.fileType);
      return { fileKey };
    },
    async downloadResource(messageId, fileKey, type, maxBytes) {
      fake.calls.push({ method: "downloadResource", args: { messageId, fileKey, type, maxBytes }, at: fake.clock() });
      const data = fake.resources.get(fileKey);
      if (data === undefined) throw new Error("no such resource");
      if (data.length > maxBytes) throw new Error("too large");
      return data;
    },
    async start(handlers) {
      fake.handlers = handlers;
      handlers.onConnected();
    },
    async stop() {
      fake.handlers = null;
    },
    recordMessage(event) {
      appendHistory(event);
    },
    event(event) {
      if (event.type === "im.message.receive_v1") appendHistory(event);
      fake.handlers!.onEvent(event);
    },
    click(action) {
      return fake.handlers!.onCardAction(action);
    },
  };
  return fake;
}
