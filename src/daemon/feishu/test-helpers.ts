// 测试用的假飞书：记下每次调用，按飞书的回包形状回编号；长连接的回调存下来，测试直接喂事件和点击。
import type {
  FeishuApiResult,
  FeishuConnectionHandlers,
  FeishuFileUpload,
  FeishuImageUpload,
  FeishuMethod,
  FeishuMethodArgs,
  FeishuRawCardAction,
  FeishuRawEvent,
  FeishuTransport,
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
  /** 授予的权限（application.scopes 回它）。 */
  granted: string[];
  handlers: FeishuConnectionHandlers | null;
  /** 某个方法下一次调用回这个结果（用完即删）。 */
  failNext: Partial<Record<FeishuMethod, FeishuApiResult | Error>>;
  /** 下载资源时回的内容；没有就抛错。 */
  resources: Map<string, Buffer>;
  /** 调用记录用的时钟。 */
  clock: () => number;
  callsOf<M extends FeishuMethod>(method: M): FeishuMethodArgs[M][];
  event(event: FeishuRawEvent): void;
  click(action: FeishuRawCardAction): ReturnType<FeishuConnectionHandlers["onCardAction"]>;
}

export function createFakeFeishu(options: { clock?: () => number; botOpenId?: string } = {}): FakeFeishu {
  let seq = 0;
  const next = (prefix: string) => `${prefix}${++seq}`;
  const botOpenId = options.botOpenId ?? "ou_bot";
  const fake: FakeFeishu = {
    calls: [],
    chats: new Map(),
    sent: [],
    granted: [],
    handlers: null,
    failNext: {},
    resources: new Map(),
    clock: options.clock ?? (() => 0),
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
          const messageId = next("om_fake");
          const chatId = a.receive_id_type === "chat_id" ? String(a.receive_id) : "oc_p2p";
          fake.sent.push({ chatId, messageId, content: String(a.content) });
          return { code: 0, data: { message_id: messageId, chat_id: chatId } };
        }
        case "card.create":
          return { code: 0, data: { card_id: next("card") } };
        case "card.update":
        case "card.settings":
        case "card.element.content":
          return { code: 0, data: {} };
      }
      return { code: 0, data: {} };
    },
    async uploadImage(input: FeishuImageUpload) {
      fake.calls.push({ method: "uploadImage", args: { ...input }, at: fake.clock() });
      return { imageKey: next("img_") };
    },
    async uploadFile(input: FeishuFileUpload) {
      fake.calls.push({ method: "uploadFile", args: { ...input }, at: fake.clock() });
      return { fileKey: next("file_") };
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
    event(event) {
      fake.handlers!.onEvent(event);
    },
    click(action) {
      return fake.handlers!.onCardAction(action);
    },
  };
  return fake;
}
