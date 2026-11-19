// 用官方 @larksuiteoapi/node-sdk（>= 1.61.1，有 registerApp）实现 transport.ts 的接口，整个仓库只有这个文件引这个包。
// 这个包加载后守护进程多占约 40 MB：service.ts 只在配了飞书（有凭证或开始扫码）时才动态加载本文件。
// 消息正文用 SDK 导出的 normalize 转成 markdown；开放接口统一走 Client.request（SDK 自己换取、续期 tenant_access_token），
// 上传、下载走 SDK 的 im.v1.image / file / messageResource；长连接是 WSClient + EventDispatcher（卡片回调 card.action.trigger 同一条连接）。
// 官方 HTTP 实例（defaultHttpInstance）不设超时，这里包一层按请求补上（withTimeouts）。
// WSClient 默认不查心跳、握手不限时，半开的连接会一直假活：这里开官方的心跳看门狗（wsConfig.pingTimeout）和握手超时。
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import * as lark from "@larksuiteoapi/node-sdk";
import type { FeishuBrandName } from "../../shared/feishu.ts";
import { FEISHU_HTTP_TIMEOUT_MS, FEISHU_TRANSFER_TIMEOUT_MS, FEISHU_WS_HANDSHAKE_TIMEOUT_MS, FEISHU_WS_PING_TIMEOUT_S } from "../../shared/limits.ts";
import type { FeishuAppAddons, FeishuAppPreset } from "./scopes.ts";
import {
  FEISHU_RATE_LIMIT_CODES,
  FeishuAuthError,
  FeishuRegistrationError,
  type FeishuApiResult,
  type FeishuCardActionResponse,
  type FeishuMethod,
  type FeishuMethodArgs,
  type FeishuRawEvent,
  type FeishuTransport,
} from "./transport.ts";

export interface FeishuSdkOptions {
  brand: FeishuBrandName;
  appId: string;
  appSecret: string;
  log: (line: string) => void;
  /** 开放接口和长连接的地址；不给时按 brand 用官方域名（测试指向本地假服务）。 */
  domain?: string;
}

/** 限流（FEISHU_RATE_LIMIT_CODES 或 HTTP 429）退避后重试，最多 RATE_LIMIT_RETRIES 次。 */
const RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_BACKOFF_MS = 500;
/** 凭证失效、应用停用：不重试，状态改 auth_failed。 */
const AUTH_CODES = new Set([99991661, 99991663, 99991664, 99991665, 99991668, 10003, 10014, 10015]);

type Route = { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; params?: Record<string, unknown>; data?: Record<string, unknown> };

/** 每个用到的开放接口怎么拼请求（路径、查询参数、请求体）。 */
function routeOf<M extends FeishuMethod>(method: M, args: FeishuMethodArgs[M]): Route {
  const a = args as Record<string, unknown> & FeishuMethodArgs[FeishuMethod];
  const enc = (v: unknown) => encodeURIComponent(String(v));
  switch (method) {
    case "bot.info":
      return { method: "GET", url: "/open-apis/bot/v3/info" };
    case "application.scopes":
      return { method: "GET", url: "/open-apis/application/v6/scopes" };
    case "chat.create": {
      const { uuid, set_bot_manager, ...data } = a as FeishuMethodArgs["chat.create"];
      return { method: "POST", url: "/open-apis/im/v1/chats", params: { user_id_type: "open_id", set_bot_manager, uuid }, data };
    }
    case "chat.update": {
      const { chat_id, ...data } = a as FeishuMethodArgs["chat.update"];
      return { method: "PUT", url: `/open-apis/im/v1/chats/${enc(chat_id)}`, params: { user_id_type: "open_id" }, data };
    }
    case "chat.get":
      return { method: "GET", url: `/open-apis/im/v1/chats/${enc(a.chat_id)}`, params: { user_id_type: "open_id" } };
    case "chat.list":
      return { method: "GET", url: "/open-apis/im/v1/chats", params: { user_id_type: "open_id", page_size: a.page_size, page_token: a.page_token } };
    case "chat.members":
      return {
        method: "GET",
        url: `/open-apis/im/v1/chats/${enc(a.chat_id)}/members`,
        params: { member_id_type: "open_id", page_size: a.page_size, page_token: a.page_token },
      };
    case "chat.delete":
      return { method: "DELETE", url: `/open-apis/im/v1/chats/${enc(a.chat_id)}` };
    case "message.create": {
      const { receive_id_type, ...data } = a as FeishuMethodArgs["message.create"];
      return { method: "POST", url: "/open-apis/im/v1/messages", params: { receive_id_type }, data };
    }
    case "message.delete":
      return { method: "DELETE", url: `/open-apis/im/v1/messages/${enc(a.message_id)}` };
    case "pin.create":
      return { method: "POST", url: "/open-apis/im/v1/pins", data: { message_id: a.message_id } };
    case "pin.delete":
      return { method: "DELETE", url: `/open-apis/im/v1/pins/${enc(a.message_id)}` };
    case "card.create":
      return { method: "POST", url: "/open-apis/cardkit/v1/cards", data: a };
    case "card.update": {
      const { card_id, ...data } = a as FeishuMethodArgs["card.update"];
      return { method: "PUT", url: `/open-apis/cardkit/v1/cards/${enc(card_id)}`, data };
    }
    case "card.settings": {
      const { card_id, ...data } = a as FeishuMethodArgs["card.settings"];
      return { method: "PATCH", url: `/open-apis/cardkit/v1/cards/${enc(card_id)}/settings`, data };
    }
    case "card.element.content": {
      const { card_id, element_id, ...data } = a as FeishuMethodArgs["card.element.content"];
      return { method: "PUT", url: `/open-apis/cardkit/v1/cards/${enc(card_id)}/elements/${enc(element_id)}/content`, data };
    }
  }
  throw new Error(`unknown feishu method ${String(method)}`);
}

/** 飞书回包统一成 { code, msg, data }：多数接口 data 包一层，bot/v3/info 这类直接放顶层。 */
function toResult(body: unknown): FeishuApiResult {
  if (typeof body !== "object" || body === null) return { code: -1, msg: "飞书回包不是 JSON" };
  const { code, msg, data, ...rest } = body as { code?: unknown; msg?: unknown; data?: unknown };
  return {
    code: typeof code === "number" ? code : -1,
    ...(typeof msg === "string" ? { msg } : {}),
    data: typeof data === "object" && data !== null ? (data as Record<string, unknown>) : rest,
  };
}

/** axios 的错误里飞书照样回 { code, msg }；网络错误没有回包。 */
function resultOfError(error: unknown): { result: FeishuApiResult | null; status: number | null } {
  const response = (error as { response?: { status?: number; data?: unknown } } | null)?.response;
  if (response === undefined) return { result: null, status: null };
  return { result: response.data === undefined ? null : toResult(response.data), status: response.status ?? null };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 上传图片、文件和下载消息里的资源：按 FEISHU_TRANSFER_TIMEOUT_MS 算超时，别的请求按 FEISHU_HTTP_TIMEOUT_MS。 */
const TRANSFER_URL = /\/open-apis\/im\/v1\/(images|files)(\/|$)|\/open-apis\/im\/v1\/messages\/[^/]+\/resources\//;

/** 官方的 HTTP 实例默认不设超时（慢网时一次上传能挂几分钟）：在它外面给每个请求补上超时，调用方自己给了的照用。 */
function withTimeouts(http: lark.HttpInstance): lark.HttpInstance {
  const timed = <D>(url: string | undefined, opts: lark.HttpRequestOptions<D> = {}): lark.HttpRequestOptions<D> => ({
    ...opts,
    timeout: opts.timeout ?? (url !== undefined && TRANSFER_URL.test(url) ? FEISHU_TRANSFER_TIMEOUT_MS : FEISHU_HTTP_TIMEOUT_MS),
  });
  return {
    request: (opts) => http.request(timed(opts.url, opts)),
    get: (url, opts) => http.get(url, timed(url, opts)),
    delete: (url, opts) => http.delete(url, timed(url, opts)),
    head: (url, opts) => http.head(url, timed(url, opts)),
    options: (url, opts) => http.options(url, timed(url, opts)),
    post: (url, data, opts) => http.post(url, data, timed(url, opts)),
    put: (url, data, opts) => http.put(url, data, timed(url, opts)),
    patch: (url, data, opts) => http.patch(url, data, timed(url, opts)),
  };
}

function checkAuth(result: FeishuApiResult): void {
  if (AUTH_CODES.has(result.code)) throw new FeishuAuthError(result.code, result.msg ?? "");
}

/**
 * 前置：appId、appSecret 是同一个应用的。
 * 后置：返回的传输层还没连长连接（start 时才连）；call 用 tenant_access_token，SDK 自己换取和续期。
 */
export function createFeishuSdkTransport(options: FeishuSdkOptions): FeishuTransport {
  const domain = options.domain ?? (options.brand === "lark" ? lark.Domain.Lark : lark.Domain.Feishu);
  const logger = {
    error: (...msg: unknown[]) => options.log(`飞书 SDK：${msg.map(String).join(" ")}`),
    warn: (...msg: unknown[]) => options.log(`飞书 SDK：${msg.map(String).join(" ")}`),
    info: () => {},
    debug: () => {},
    trace: () => {},
  };
  // 官方实例的响应拦截器已把回包拆成 data（SDK 不传 httpInstance 时用的就是它），只是类型上还标成 AxiosInstance
  const httpInstance = withTimeouts(lark.defaultHttpInstance as unknown as lark.HttpInstance);
  const client = new lark.Client({ appId: options.appId, appSecret: options.appSecret, domain, logger, loggerLevel: lark.LoggerLevel.warn, httpInstance });
  let ws: lark.WSClient | null = null;

  const call = async <M extends FeishuMethod>(method: M, args: FeishuMethodArgs[M]): Promise<FeishuApiResult> => {
    const route = routeOf(method, args);
    for (let attempt = 0; ; attempt++) {
      let result: FeishuApiResult;
      let status: number | null = 200;
      try {
        result = toResult(await client.request({ method: route.method, url: route.url, params: route.params, data: route.data }));
      } catch (error) {
        const failed = resultOfError(error);
        if (failed.result === null) {
          const message = error instanceof Error ? error.message : String(error);
          // 换不到 tenant_access_token 时 SDK 抛的错里带着飞书的 code
          const code = Number(/code[^\d]*(\d{5,})/.exec(message)?.[1] ?? NaN);
          if (AUTH_CODES.has(code)) throw new FeishuAuthError(code, message);
          throw error;
        }
        result = failed.result;
        status = failed.status;
      }
      checkAuth(result);
      const limited = status === 429 || FEISHU_RATE_LIMIT_CODES.has(result.code);
      if (!limited || attempt >= RATE_LIMIT_RETRIES) return status !== null && (status < 200 || status >= 300) ? { ...result, httpStatus: status } : result;
      await sleep(RATE_LIMIT_BACKOFF_MS * 2 ** attempt);
    }
  };

  const unwrap = <T>(value: T | null | undefined, what: string): T => {
    if (value === null || value === undefined) throw new Error(`飞书${what}没回结果`);
    return value;
  };

  return {
    call,
    async uploadImage(input) {
      const image = "data" in input ? input.data : createReadStream(input.path);
      const res = await client.im.v1.image.create({ data: { image_type: input.imageType, image } });
      return { imageKey: unwrap(res?.image_key, "上传图片") };
    },
    async uploadFile(input) {
      const res = await client.im.v1.file.create({ data: { file_type: input.fileType, file_name: input.fileName, file: createReadStream(input.path) } });
      return { fileKey: unwrap(res?.file_key, "上传文件") };
    },
    async downloadResource(messageId, fileKey, type, maxBytes) {
      const res = await client.im.v1.messageResource.get({ path: { message_id: messageId, file_key: fileKey }, params: { type } });
      const stream: Readable = res.getReadableStream();
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        size += (chunk as Buffer).length;
        if (size > maxBytes) {
          stream.destroy();
          throw new Error(`飞书文件超过 ${maxBytes} 字节`);
        }
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks);
    },
    async start(handlers) {
      const bot = toResult(await client.request({ method: "GET", url: "/open-apis/bot/v3/info" }));
      checkAuth(bot);
      const info = (bot.data?.bot ?? {}) as { open_id?: string; app_name?: string };
      const botIdentity = { openId: info.open_id ?? "", name: info.app_name ?? "" };
      const safe = (fn: () => void) => {
        try {
          fn();
        } catch (error) {
          options.log(`飞书事件处理出错：${error instanceof Error ? error.message : String(error)}`);
        }
      };
      const members = (data: { chat_id?: string; users?: { user_id?: { open_id?: string } }[] }) => ({
        chatId: data.chat_id ?? "",
        openIds: (data.users ?? []).map((u) => u.user_id?.open_id ?? "").filter((id) => id !== ""),
      });
      const dispatcher = new lark.EventDispatcher({ logger, loggerLevel: lark.LoggerLevel.warn }).register({
        "im.message.receive_v1": async (data: lark.RawMessageEvent) => {
          const message = await lark.normalize(data, { botIdentity, stripBotMentions: true });
          const event: FeishuRawEvent = {
            type: "im.message.receive_v1",
            messageId: message.messageId,
            chatId: message.chatId,
            chatType: message.chatType,
            senderOpenId: message.senderId,
            senderType: data.sender.sender_type === "user" ? "user" : "app",
            content: message.content,
            mentionedBot: message.mentionedBot,
            threadId: message.threadId ?? null,
            resources: message.resources.map((r) => ({ type: r.type, fileKey: r.fileKey, fileName: r.fileName ?? null })),
            createTime: message.createTime,
          };
          safe(() => handlers.onEvent(event));
        },
        "im.chat.member.user.added_v1": async (data: Parameters<typeof members>[0]) => safe(() => handlers.onEvent({ type: "im.chat.member.user.added_v1", ...members(data) })),
        "im.chat.member.user.deleted_v1": async (data: Parameters<typeof members>[0]) =>
          safe(() => handlers.onEvent({ type: "im.chat.member.user.deleted_v1", ...members(data) })),
        "im.chat.member.bot.deleted_v1": async (data: { chat_id?: string }) =>
          safe(() => handlers.onEvent({ type: "im.chat.member.bot.deleted_v1", chatId: data.chat_id ?? "" })),
        "im.chat.disbanded_v1": async (data: { chat_id?: string }) => safe(() => handlers.onEvent({ type: "im.chat.disbanded_v1", chatId: data.chat_id ?? "" })),
        "im.chat.updated_v1": async (data: { chat_id?: string; after_change?: { name?: string } }) =>
          safe(() => handlers.onEvent({ type: "im.chat.updated_v1", chatId: data.chat_id ?? "", name: data.after_change?.name ?? null })),
        "card.action.trigger": async (data: lark.RawCardActionEvent): Promise<FeishuCardActionResponse> => {
          const action = (data.action ?? {}) as { value?: unknown; option?: unknown; form_value?: Record<string, unknown> };
          try {
            return handlers.onCardAction({
              ...(data.token ? { token: data.token } : {}),
              messageId: data.context?.open_message_id ?? data.open_message_id ?? "",
              chatId: data.context?.open_chat_id ?? data.open_chat_id ?? "",
              operatorOpenId: data.operator?.open_id ?? "",
              value: action.value,
              ...(typeof action.option === "string" ? { option: action.option } : {}),
              formValue: action.form_value ?? null,
            });
          } catch (error) {
            options.log(`飞书卡片点击处理出错：${error instanceof Error ? error.message : String(error)}`);
            return { toast: { type: "error", content: "出错了，去网页看看" } };
          }
        },
      } as never);
      ws = new lark.WSClient({
        appId: options.appId,
        appSecret: options.appSecret,
        domain,
        logger,
        loggerLevel: lark.LoggerLevel.warn,
        autoReconnect: true,
        handshakeTimeoutMs: FEISHU_WS_HANDSHAKE_TIMEOUT_MS,
        wsConfig: { pingTimeout: FEISHU_WS_PING_TIMEOUT_S },
        onReady: () => handlers.onConnected(),
        onReconnected: () => handlers.onConnected(),
        onReconnecting: () => handlers.onDisconnected("长连接断了，正在重连"),
        onError: (error) => handlers.onDisconnected(error.message),
      });
      await ws.start({ eventDispatcher: dispatcher });
    },
    async stop() {
      ws?.close({ force: true });
      ws = null;
    },
  };
}

export interface FeishuRegistrationHandlers {
  /** 飞书给出确认页链接（十分钟内有效，只能一个人扫）。 */
  onUrl(info: { url: string; expiresAt: number }): void;
}

export interface FeishuRegistrationResult {
  brand: FeishuBrandName;
  appId: string;
  appSecret: string;
  /** 扫码确认的那个人；飞书没给时是 null（这时走绑定码认主人）。 */
  scannerOpenId: string | null;
}

/**
 * registerApp：Device Authorization Grant（RFC 8628）扫码一键建应用。
 * 前置：addons 只放平台默认模板之外的增量（scopes.ts 的 FEISHU_APP_ADDONS）。
 * 后置：用户扫码确认后返回凭证；拒绝、过期、被 signal 取消时抛 FeishuRegistrationError。createOnly 为 true，确认页不给选已有应用。
 */
export async function registerFeishuApp(input: {
  preset: FeishuAppPreset;
  addons: FeishuAppAddons;
  handlers: FeishuRegistrationHandlers;
  signal: AbortSignal;
}): Promise<FeishuRegistrationResult> {
  try {
    const result = await lark.registerApp({
      signal: input.signal,
      createOnly: true,
      appPreset: { name: input.preset.name, desc: input.preset.desc },
      addons: {
        preset: input.addons.preset,
        scopes: { tenant: [...input.addons.scopes.tenant] },
        events: { items: { tenant: [...input.addons.events.items.tenant] } },
      },
      onQRCodeReady: ({ url, expireIn }) => input.handlers.onUrl({ url, expiresAt: Date.now() + expireIn * 1000 }),
    });
    return {
      brand: result.user_info?.tenant_brand ?? "feishu",
      appId: result.client_id,
      appSecret: result.client_secret,
      scannerOpenId: result.user_info?.open_id ?? null,
    };
  } catch (error) {
    if (error instanceof Error) throw new FeishuRegistrationError(input.signal.aborted ? "abort" : "error", error.message);
    const { code, description } = (error ?? {}) as { code?: unknown; description?: unknown };
    throw new FeishuRegistrationError(typeof code === "string" ? code : "error", typeof description === "string" ? description : String(error));
  }
}
