// 网页 ↔ 界面服务（设计第 3 章、m1-plan 第 3 节第 1 条）。
import type {
  Conversation,
  ConversationId,
  HealthEntry,
  Message,
  MessageId,
  Pm,
  SessionState,
} from "./domain.ts";

export const API_PATHS = {
  /** GET ?token=<界面用户令牌>：设 cookie，跳到 /。令牌存在 state/ui-token，守护进程重启后不变，旧 cookie 仍然有效。 */
  auth: "/auth",
  state: "/api/state",
  messages: (conversationId: ConversationId) => `/api/conversations/${conversationId}/messages`,
  stop: (conversationId: ConversationId) => `/api/conversations/${conversationId}/stop`,
  /** WebSocket，?since=<seq>。 */
  ws: "/api/ws",
} as const;

export interface ConversationSnapshot {
  conversation: Conversation;
  /** 最近 100 条，按编号从小到大。 */
  messages: Message[];
  /** 比 messages 里最早一条更早的还有没有。 */
  hasMore: boolean;
}

/** GET /api/state。seq 是拍照那一刻的事件序号，WebSocket 从它之后接着推。 */
export interface StateSnapshot {
  seq: number;
  pms: Pm[];
  conversations: ConversationSnapshot[];
  sessions: SessionState[];
  health: HealthEntry[];
}

/** GET /api/conversations/:id/messages?before=<消息编号>：更早的 100 条，从小到大。 */
export interface MessagesPage {
  messages: Message[];
  hasMore: boolean;
}

/** POST /api/conversations/:id/messages。clientId 由网页生成，重发用同一个。 */
export interface PostMessageRequest {
  clientId: string;
  text: string;
}

export interface PostMessageResponse {
  messageId: MessageId;
}

/** 4xx / 5xx 的响应体。对话不存在（账本抛 ConversationNotFoundError）→ 404。 */
export interface ApiErrorBody {
  error: string;
}

// ---- WebSocket：服务端 → 网页 ----

export const CHANGE_TYPES = ["message.created", "message.updated", "session.status", "health.updated"] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export interface ChangeDataMap {
  "message.created": { message: Message };
  "message.updated": { message: Message };
  "session.status": { session: SessionState };
  /** 某个模块的健康状态变了（比如“找不到 claude”），界面实时显示。 */
  "health.updated": { health: HealthEntry };
}

/** 服务端推的一条变化：{ seq, type, data }。 */
export type Change = {
  [T in ChangeType]: { seq: number; type: T; data: ChangeDataMap[T] };
}[ChangeType];

/** since 太旧补不齐（或比当前还大，比如守护进程重启过）时推它，网页重新拉 /api/state。 */
export interface ResyncMessage {
  type: "resync";
}

export type WsServerMessage = Change | ResyncMessage;
