// 网页 ↔ 界面服务（设计第 3 章、m1-plan 第 3 节第 1 条）。
import type {
  Conversation,
  ConversationId,
  HealthEntry,
  Message,
  MessageId,
  PersonaChangeId,
  Pm,
  PmId,
  PmMode,
  Project,
  ProjectFolder,
  ProjectId,
  SessionState,
} from "./domain.ts";
import type { LedgerErrorCode, PersonaView } from "./ledger.ts";

export const API_PATHS = {
  /** GET ?token=<界面用户令牌>：设 cookie，跳到 /。令牌存在 state/ui-token，守护进程重启后不变，旧 cookie 仍然有效。 */
  auth: "/auth",
  state: "/api/state",
  messages: (conversationId: ConversationId) => `/api/conversations/${conversationId}/messages`,
  stop: (conversationId: ConversationId) => `/api/conversations/${conversationId}/stop`,
  /** POST：新建项目经理（CreatePmRequest → 201 CreatePmResponse）。 */
  pms: "/api/pms",
  /** POST：新建项目（CreateProjectRequest → 201 CreateProjectResponse）。 */
  projects: "/api/projects",
  /** GET → PersonaView；PUT（EditPersonaRequest）→ EditPersonaResponse。 */
  persona: (pmId: PmId) => `/api/pms/${pmId}/persona`,
  /** POST，没有请求体 → EditPersonaResponse。 */
  revertPersonaChange: (changeId: PersonaChangeId) => `/api/persona-changes/${changeId}/revert`,
  /** POST，没有请求体 → 202 RetryMessageResponse。 */
  retryMessage: (messageId: MessageId) => `/api/messages/${messageId}/retry`,
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
  /** 没删除的项目（M2 只有进行中的），按编号从小到大。 */
  projects: Project[];
  /** 这些项目没移除的文件夹，按编号从小到大。 */
  folders: ProjectFolder[];
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

/**
 * 4xx / 5xx 的响应体。对话不存在（账本抛 ConversationNotFoundError）→ 404。
 * 账本抛 LedgerRequestError 时按 LEDGER_ERROR_HTTP_STATUS 映射，error 是它的 message（原样显示给用户），code 是它的 code。
 * 请求体校验没过（界面服务自己查的）→ 400，code 是 "invalid"。
 */
export interface ApiErrorBody {
  error: string;
  code?: LedgerErrorCode;
}

// ---- M2：项目经理、项目、性格设定、重试 ----
// 请求体由界面服务按 JSON Schema 校验（多余字段拒绝），长度上限见 limits.ts；业务校验在账本。

/** POST /api/pms。name 按 normalizeName；persona 不超过 MAX_PERSONA_BYTES；defaultModel 空串或不给 = 用 claude 自己的默认。 */
export interface CreatePmRequest {
  name: string;
  mode: PmMode;
  defaultModel?: string | null;
  persona: string;
}

export interface CreatePmResponse {
  pmId: PmId;
  /** 它的私聊，网页建好后跳过去。 */
  conversationId: ConversationId;
}

/** POST /api/projects。folder 是用户填的路径（可以带 ~），服务端解析成真实路径。 */
export interface CreateProjectRequest {
  name: string;
  folder: string;
  pmId: PmId;
  description?: string;
}

export interface CreateProjectResponse {
  projectId: ProjectId;
  /** 它的群，网页建好后跳过去。 */
  conversationId: ConversationId;
}

/** GET /api/pms/:id/persona 的响应就是账本的 PersonaView。 */
export type PersonaResponse = PersonaView;

/** PUT /api/pms/:id/persona。text、mode 至少给一个。 */
export interface EditPersonaRequest {
  text?: string;
  mode?: PmMode;
  reason?: string;
}

/** PUT persona、POST revert 的响应：改完之后的样子（没改动时 changed 为 false）。 */
export interface EditPersonaResponse {
  changed: boolean;
  persona: PersonaView;
}

/** POST /api/messages/:id/retry → 202。之后状态变化照常从 WebSocket 推（message.updated）。 */
export interface RetryMessageResponse {
  messageId: MessageId;
}

// ---- WebSocket：服务端 → 网页 ----

/**
 * 同一个事务里推出的几条变化按这个顺序：pm.* → project.* → conversation.created → session.created → folders.updated →
 * message.* → session.status → health.updated。所以网页收到某个对话的 message.created 时，那个对话一定已经有了。
 */
export const CHANGE_TYPES = [
  "message.created",
  "message.updated",
  "session.status",
  "health.updated",
  "pm.created",
  "pm.updated",
  "project.created",
  "project.updated",
  "folders.updated",
  "conversation.created",
  "session.created",
] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export interface ChangeDataMap {
  "message.created": { message: Message };
  "message.updated": { message: Message };
  "session.status": { session: SessionState };
  /** 某个模块的健康状态变了（比如“找不到 claude”），界面实时显示。 */
  "health.updated": { health: HealthEntry };
  "pm.created": { pm: Pm };
  /** 模式、名字等变了（改性格设定只改了正文也推，资料页据此重新拉 persona）。 */
  "pm.updated": { pm: Pm };
  "project.created": { project: Project };
  /** 换项目经理等。 */
  "project.updated": { project: Project };
  /** 某个项目没移除的文件夹整个换成这一份（挂、移除、建项目时）。 */
  "folders.updated": { projectId: ProjectId; folders: ProjectFolder[] };
  /** 新对话（新项目经理的私聊、新项目的群），消息是空的。 */
  "conversation.created": { conversation: Conversation };
  /** 新会话（建项目经理、建项目、换项目经理开的下一代）。 */
  "session.created": { session: SessionState };
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
