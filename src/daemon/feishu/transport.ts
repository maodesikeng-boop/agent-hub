import type { Readable } from "node:stream";

export interface FeishuMethodArgs {
  "bot.info": Record<string, never>;
  "application.scopes": Record<string, never>;
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
  "chat.update": { chat_id: string; name?: string; avatar?: string; description?: string };
  "chat.get": { chat_id: string };
  "chat.list": { page_token?: string; page_size: number };
  "chat.members": { chat_id: string; page_token?: string; page_size: number };
  "chat.delete": { chat_id: string };
  "message.create": {
    receive_id_type: "chat_id" | "open_id";
    receive_id: string;
    msg_type: "interactive" | "text" | "image" | "file" | "media" | "audio";
    content: string;
    uuid: string;
  };
  "message.delete": { message_id: string };
  "message.list": {
    container_id_type: "chat";
    container_id: string;
    start_time?: string;
    end_time?: string;
    sort_type?: "ByCreateTimeAsc" | "ByCreateTimeDesc";
    page_size: number;
    page_token?: string;
  };
  "card.create": { type: "card_json"; data: string };
  "card.update": { card_id: string; card: { type: "card_json"; data: string }; sequence: number; uuid: string };
  "card.settings": { card_id: string; settings: string; sequence: number; uuid: string };
  "card.element.content": { card_id: string; element_id: string; content: string; sequence: number; uuid: string };
  "pin.create": { message_id: string };
  "pin.delete": { message_id: string };
}

export type FeishuMethod = keyof FeishuMethodArgs;

export interface FeishuApiResult {
  code: number;
  msg?: string;
  data?: Record<string, unknown>;
  httpStatus?: number;
}

export type FeishuImageUpload = { imageType: "message" | "avatar"; path: string } | { imageType: "avatar"; data: Buffer };

export interface FeishuFileUpload {
  path: string;
  fileName: string;
  fileType: "pdf" | "doc" | "xls" | "ppt" | "mp4" | "opus" | "stream";
}

export type FeishuRawEvent =
  | {
      type: "im.message.receive_v1";
      messageId: string;
      chatId: string;
      chatType: "p2p" | "group";
      senderOpenId: string;
      senderType: "user" | "app";
      content: string;
      mentionedBot: boolean;
      threadId: string | null;
      resources: { type: "image" | "file" | "audio" | "video" | "sticker"; fileKey: string; fileName: string | null }[];
      createTime: number;
    }
  | { type: "im.chat.member.user.added_v1" | "im.chat.member.user.deleted_v1"; chatId: string; openIds: string[] }
  | { type: "im.chat.member.bot.deleted_v1" | "im.chat.disbanded_v1"; chatId: string }
  | { type: "im.chat.updated_v1"; chatId: string; name: string | null };

export type FeishuRawMessageEvent = Extract<FeishuRawEvent, { type: "im.message.receive_v1" }>;

export interface FeishuListMessagesInput {
  chatId: string;
  chatType: "p2p" | "group";
  botOpenId: string;
  startTimeSec: string;
  endTimeSec: string;
  sortType?: "ByCreateTimeAsc" | "ByCreateTimeDesc";
  pageSize: number;
  pageToken?: string;
}

export interface FeishuListMessagesPage {
  items: FeishuRawMessageEvent[];
  pageToken: string | null;
  hasMore: boolean;
}

export interface FeishuRawCardAction {
  token?: string;
  messageId: string;
  chatId: string;
  operatorOpenId: string;
  value: unknown;
  option?: string | null;
  formValue: Record<string, unknown> | null;
}

// Feishu needs this within 3 seconds, and a response cannot update a card in streaming mode, so only the toast applies there.
export interface FeishuCardActionResponse {
  toast?: { type: "success" | "info" | "warning" | "error"; content: string };
}

export interface FeishuConnectionHandlers {
  // Feishu redelivers any event not acknowledged within 3 seconds, so this must only parse and enqueue.
  onEvent(event: FeishuRawEvent): void;
  onCardAction(action: FeishuRawCardAction): FeishuCardActionResponse | Promise<FeishuCardActionResponse>;
  onConnected(): void;
  onDisconnected(reason: string): void;
}

export interface FeishuTransport {
  call<M extends FeishuMethod>(method: M, args: FeishuMethodArgs[M]): Promise<FeishuApiResult>;
  listMessages(input: FeishuListMessagesInput): Promise<FeishuListMessagesPage>;
  uploadImage(input: FeishuImageUpload): Promise<{ imageKey: string }>;
  uploadFile(input: FeishuFileUpload): Promise<{ fileKey: string }>;
  downloadResource(messageId: string, fileKey: string, type: "image" | "file"): Promise<Readable>;
  start(handlers: FeishuConnectionHandlers): Promise<void>;
  stop(): Promise<void>;
}

export class FeishuAuthError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(`feishu auth failed: ${code} ${message}`);
    this.code = code;
  }
}

export class FeishuApiError extends Error {
  readonly code: number;
  readonly httpStatus: number | null;
  constructor(method: string, code: number, message: string, httpStatus: number | null = null) {
    super(`feishu ${method} failed: ${code} ${message}`);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export const FEISHU_RATE_LIMIT_CODES: ReadonlySet<number> = new Set([230020, 99991400]);
export const FEISHU_CARD_TOO_LARGE_CODE = 230025;
export const FEISHU_IMAGE_REJECTED_CODE = 234011;

export function isFeishuRejection(error: unknown): boolean {
  return error instanceof FeishuApiError && error.code > 0 && !FEISHU_RATE_LIMIT_CODES.has(error.code) && (error.httpStatus === null || error.httpStatus < 500);
}

export function feishuDataOf(method: FeishuMethod, result: FeishuApiResult): Record<string, unknown> {
  if (result.code !== 0) throw new FeishuApiError(method, result.code, result.msg ?? "", result.httpStatus ?? null);
  return result.data ?? {};
}

export function feishuStringField(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value !== "" ? value : null;
}

export class FeishuRegistrationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
