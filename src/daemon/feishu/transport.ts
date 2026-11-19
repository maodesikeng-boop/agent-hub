// 飞书的外部边界（docs/feishu-design.md「做法比较」）：Fusa 用到的开放接口和长连接送来的事件。
// 只有 sdk.ts 引官方包 @larksuiteoapi/node-sdk（Client、WSClient、EventDispatcher、registerApp、normalize），
// 别的文件只认这里的接口，测试用假的实现。
// 不变量：
// - 入参出参是飞书原样的形状（蛇形命名、裸字符串编号）；进领域前一律过 inbound.ts；
// - 所有发送都在主聊天流里：不传 reply_in_thread，不建话题群（group_message_type 固定 chat）；
// - 长连接收到的每个事件 3 秒内必须处理完，否则飞书重推：onEvent 只做解析和入队，重活在队列里做。

/** 用到的开放接口和参数（只列 Fusa 传的字段）。路径见 docs/feishu-design.md「飞书官方接口」。 */
export interface FeishuMethodArgs {
  /** GET /open-apis/bot/v3/info：机器人自己的 open_id 和名字。 */
  "bot.info": Record<string, never>;
  /** GET /open-apis/application/v6/scopes：租户对这个应用各项权限的授予状态（needs_permission 用，不需要额外权限）。 */
  "application.scopes": Record<string, never>;
  /** POST /open-apis/im/v1/chats：建私有对话群。uuid 让同一请求 10 小时内只建一个群。 */
  "chat.create": {
    uuid: string;
    name: string;
    description: string;
    avatar?: string;
    owner_id: string;
    user_id_list: string[];
    chat_type: "private";
    group_message_type: "chat";
    set_bot_manager: true;
    edit_permission: "only_owner";
  };
  /** PUT /open-apis/im/v1/chats/:chat_id：改群名、群头像、群说明。 */
  "chat.update": { chat_id: string; name?: string; avatar?: string; description?: string };
  /** GET /open-apis/im/v1/chats/:chat_id：群名、群主、人数。 */
  "chat.get": { chat_id: string };
  /** GET /open-apis/im/v1/chats：机器人所在的群（重启后按群说明里的标记认回自己建的群）。 */
  "chat.list": { page_token?: string; page_size: number };
  /** GET /open-apis/im/v1/chats/:chat_id/members：群成员和显示名（对账人数、署名用，不需要通讯录权限）。 */
  "chat.members": { chat_id: string; page_token?: string; page_size: number };
  /** DELETE /open-apis/im/v1/chats/:chat_id：解散群（项目经理归档、删掉，或断开时用户选了解散）。 */
  "chat.delete": { chat_id: string };
  /** POST /open-apis/im/v1/messages：发消息。receive_id_type 为 chat_id 或 open_id（总助单聊按主人 open_id 发）。 */
  "message.create": {
    receive_id_type: "chat_id" | "open_id";
    receive_id: string;
    msg_type: "interactive" | "text" | "image" | "file" | "media" | "audio";
    content: string;
    uuid: string;
  };
  /** DELETE /open-apis/im/v1/messages/:message_id：撤回机器人自己发的消息（整轮没写正文的状态卡）；受管理员设的撤回时限约束。 */
  "message.delete": { message_id: string };
  /** POST /open-apis/cardkit/v1/cards：建卡片实体（卡片 JSON 2.0）。 */
  "card.create": { type: "card_json"; data: string };
  /** PUT /open-apis/cardkit/v1/cards/:card_id：整张卡换掉（定稿、改成已定案）。 */
  "card.update": { card_id: string; card: { type: "card_json"; data: string }; sequence: number; uuid: string };
  /** PATCH /open-apis/cardkit/v1/cards/:card_id/settings：开关流式模式（streaming_mode）。 */
  "card.settings": { card_id: string; settings: string; sequence: number; uuid: string };
  /** PUT /open-apis/cardkit/v1/cards/:card_id/elements/:element_id/content：流式更新文本（全量，平台算增量打字机）。 */
  "card.element.content": { card_id: string; element_id: string; content: string; sequence: number; uuid: string };
  /** POST /open-apis/im/v1/pins：把一条消息置顶到群顶（Pin），已 Pin 的照样回成功。需可选权限 im:message.pins:write_only；未授予或群只许群主 Pin（230046）时降级。 */
  "pin.create": { message_id: string };
  /** DELETE /open-apis/im/v1/pins/:message_id：取消置顶，没 Pin 过、已撤回的照样回成功。 */
  "pin.delete": { message_id: string };
}

export type FeishuMethod = keyof FeishuMethodArgs;

/** 开放接口的回包：code 为 0 是成功；不是 0 时 msg 是飞书给的原因。 */
export interface FeishuApiResult {
  code: number;
  msg?: string;
  data?: Record<string, unknown>;
  /** 不是 2xx 时的 HTTP 状态码（飞书在 4xx、5xx 里照样回 code）。 */
  httpStatus?: number;
}

/** 上传给发消息用的图片（≤ 10 MB）或设群头像（image_type avatar）。 */
/** 本机文件（path，绝对路径），或内存里画好的图（data，群头像）。 */
export type FeishuImageUpload = { imageType: "message" | "avatar"; path: string } | { imageType: "avatar"; data: Buffer };

/** 上传文件（≤ 30 MB）。fileType 照飞书：pdf、doc、xls、ppt、mp4、opus，其余是 stream；发消息时 mp4 配 media、opus 配 audio、其余配 file。 */
export interface FeishuFileUpload {
  path: string;
  fileName: string;
  fileType: "pdf" | "doc" | "xls" | "ppt" | "mp4" | "opus" | "stream";
}

/** 长连接送来的一个事件，sdk.ts 已用官方 normalize 把消息正文转成 markdown，编号还是裸字符串。 */
export type FeishuRawEvent =
  | {
      type: "im.message.receive_v1";
      messageId: string;
      chatId: string;
      chatType: "p2p" | "group";
      senderOpenId: string;
      senderType: "user" | "app";
      /** 已去掉 @机器人 占位的 markdown 正文。 */
      content: string;
      mentionedBot: boolean;
      /** 发在话题里时有值（Fusa 建的是对话群，正常不会有）。 */
      threadId: string | null;
      resources: { type: "image" | "file" | "audio" | "video" | "sticker"; fileKey: string; fileName: string | null }[];
      createTime: number;
    }
  | { type: "im.chat.member.user.added_v1" | "im.chat.member.user.deleted_v1"; chatId: string; openIds: string[] }
  | { type: "im.chat.member.bot.deleted_v1" | "im.chat.disbanded_v1"; chatId: string }
  | { type: "im.chat.updated_v1"; chatId: string; name: string | null };

/** 卡片回传交互（card.action.trigger），也走同一条长连接。 */
export interface FeishuRawCardAction {
  token?: string;
  messageId: string;
  chatId: string;
  operatorOpenId: string;
  /** 按钮 behaviors.callback 里放的值。 */
  value: unknown;
  /** select_static 下拉回传的选项值（options[].value）。 */
  option?: string | null;
  /** 表单里填的（补充说明输入框）；没有表单是 null。 */
  formValue: Record<string, unknown> | null;
}

/** 回给卡片交互的响应：3 秒内必须回。流式模式下的卡片不能靠响应更新，只能 toast。 */
export interface FeishuCardActionResponse {
  toast?: { type: "success" | "info" | "warning" | "error"; content: string };
}

export interface FeishuConnectionHandlers {
  /** 每个事件调一次；必须同步返回（只解析、入队），出错不影响回执。 */
  onEvent(event: FeishuRawEvent): void;
  /** 卡片按钮点击；返回的 toast 显示给点的人。必须在 FEISHU_CARD_ACTION_DEADLINE_MS 内返回。 */
  onCardAction(action: FeishuRawCardAction): FeishuCardActionResponse;
  /** 连上（含重连成功）时调：服务据此对账群成员、补发离线期间的消息。 */
  onConnected(): void;
  /** 断开时调；传输层自己重连。 */
  onDisconnected(reason: string): void;
}

/**
 * 守护进程看到的飞书。sdk.ts 用官方包实现；测试用假的。
 * 不变量：call 遇到限流（HTTP 429、错误码 230020、99991400）由实现退避重试，调用方只看到最终结果；
 * 每次 HTTP 请求有超时（FEISHU_HTTP_TIMEOUT_MS，上传下载 FEISHU_TRANSFER_TIMEOUT_MS），超时按网络错误抛；
 * 凭证失效（tenant_access_token 拿不到、99991663 等）抛 FeishuAuthError，不重试。
 */
export interface FeishuTransport {
  call<M extends FeishuMethod>(method: M, args: FeishuMethodArgs[M]): Promise<FeishuApiResult>;
  uploadImage(input: FeishuImageUpload): Promise<{ imageKey: string }>;
  uploadFile(input: FeishuFileUpload): Promise<{ fileKey: string }>;
  /** GET /open-apis/im/v1/messages/:message_id/resources/:file_key。超过 maxBytes 中止并抛错，不返回半截内容。 */
  downloadResource(messageId: string, fileKey: string, type: "image" | "file", maxBytes: number): Promise<Buffer>;
  /** 开长连接（WSClient），断了自己重连，直到 stop。 */
  start(handlers: FeishuConnectionHandlers): Promise<void>;
  stop(): Promise<void>;
}

/** 凭证失效或应用被停用：服务把状态改成 auth_failed，等用户重新扫码或重填。 */
export class FeishuAuthError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(`feishu auth failed: ${code} ${message}`);
    this.code = code;
  }
}

/** 开放接口回了非 0 的 code（凭证失效除外，那是 FeishuAuthError）。 */
export class FeishuApiError extends Error {
  readonly code: number;
  readonly httpStatus: number | null;
  constructor(method: string, code: number, message: string, httpStatus: number | null = null) {
    super(`feishu ${method} failed: ${code} ${message}`);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** 限流：HTTP 429、230020（发消息太快）、99991400（接口频率）。 */
export const FEISHU_RATE_LIMIT_CODES: ReadonlySet<number> = new Set([230020, 99991400]);
/** 卡片超过 30 KB 时飞书回的错误码；发送前本地核出超限也按它抛。 */
export const FEISHU_CARD_TOO_LARGE_CODE = 230025;
/** 上传图片时飞书认不出图片格式回的错误码；本地核出转不成飞书收的图（avif、超过 10 MB）时也按它抛。 */
export const FEISHU_IMAGE_REJECTED_CODE = 234011;

/**
 * 飞书明确拒收了这一次请求（卡片过期、消息撤回、群没了、内容超限）：同样的请求再发还是被拒，调用方放弃这一件、不重试。
 * 限流（重试用尽）、飞书服务端 5xx、回包坏了（code -1）、网络错误不算，那些稍后再试。
 */
export function isFeishuRejection(error: unknown): boolean {
  return error instanceof FeishuApiError && error.code > 0 && !FEISHU_RATE_LIMIT_CODES.has(error.code) && (error.httpStatus === null || error.httpStatus < 500);
}

/** 后置：code 为 0 返回 data（没有是空对象），否则抛 FeishuApiError。 */
export function feishuDataOf(method: FeishuMethod, result: FeishuApiResult): Record<string, unknown> {
  if (result.code !== 0) throw new FeishuApiError(method, result.code, result.msg ?? "", result.httpStatus ?? null);
  return result.data ?? {};
}

/** 后置：回包 data 里的字符串字段；没有或不是字符串返回 null。 */
export function feishuStringField(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** 扫码建应用失败：access_denied（用户拒绝）、expired_token（过期）、abort（取消）或别的错误码。 */
export class FeishuRegistrationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
