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
import type { ScheduleId, ScheduleRecord } from "./schedule.ts";
import type { AgentVendor, ModelCatalog } from "./vendors.ts";
import type { FileAction } from "./preview.ts";

export const API_PATHS = {
  /** GET ?token=<界面用户令牌>：设 cookie，跳到 /。令牌存在 state/ui-token，守护进程重启后不变，旧 cookie 仍然有效。 */
  auth: "/auth",
  state: "/api/state",
  messages: (conversationId: ConversationId) => `/api/conversations/${conversationId}/messages`,
  stop: (conversationId: ConversationId) => `/api/conversations/${conversationId}/stop`,
  /** POST：新建项目经理（CreatePmRequest → 201 CreatePmResponse）。没有单独建项目的入口：建项目经理时选主文件夹，或者在会话里说。 */
  pms: "/api/pms",
  /** GET → PersonaView；PUT（EditPersonaRequest）→ EditPersonaResponse。 */
  persona: (pmId: PmId) => `/api/pms/${pmId}/persona`,
  /** POST，没有请求体 → EditPersonaResponse。 */
  revertPersonaChange: (changeId: PersonaChangeId) => `/api/persona-changes/${changeId}/revert`,
  /** POST，没有请求体 → 202 RenewSessionResponse：开新会话（先让项目经理写交接，回完换代，见 ledger/handover.ts）。 */
  renewSession: (pmId: PmId) => `/api/pms/${pmId}/renew-session`,
  /** POST，没有请求体 → 202 RetryMessageResponse。 */
  retryMessage: (messageId: MessageId) => `/api/messages/${messageId}/retry`,
  /** POST，没有请求体 → 204。用户点“知道了”，清掉一条 hub ask 的提醒（Ledger.dismissAsk）。 */
  dismissAsk: (messageId: MessageId) => `/api/messages/${messageId}/dismiss-ask`,
  /**
   * POST ?name=<文件名>：请求体就是文件原样的字节（不是 JSON，不绑定接收方），最多 MAX_UPLOAD_BYTES，不动别的接口 1 MB 的上限。
   * 200 → Attachment；空文件、太大（413）、文件名不合法 → 中文原因。之后发消息时在 PostMessageRequest.attachmentIds 里带上它的 id。
   */
  uploads: "/api/uploads",
  /** GET：按上传编号取文件。图片内联显示（缩略图），别的当下载。 */
  upload: (id: string, name: string) => `/api/uploads/${id}/${encodeURIComponent(name)}`,
  /** GET：按副本编号取 agent 发出的文件（shared/sent-files.ts）。图片（含 svg）内联，别的当下载；支持 Range。 */
  sentFile: (id: string, name: string) => `/api/sent-files/${id}/${encodeURIComponent(name)}`,
  /** GET → ModelsResponse；?refresh=1 先重新问一次厂商再回。 */
  models: "/api/models",
  /**
   * POST（PickFolderRequest → PickFolderResponse）：守护进程在这台 Mac 上弹原生的“选择文件夹”，等用户选完才回。
   * 取消、超时回 path null（不是错误）；同时已经有一个对话框 409；起不来 osascript 回中文原因。
   */
  pickFolder: "/api/pick-folder",
  /**
   * POST，没有请求体 → FileActionResponse：用 macOS 的 open 在 Finder 中显示（reveal）/ 用默认程序打开（open）agent 发来的文件。
   * 按消息编号 + meta.files 的下标找文件（不收路径）；原文件还在、还在这个会话允许的文件夹里用原文件，否则用副本。
   * 带可执行权限的、扩展名不在白名单（OPEN_ALLOWED_EXTENSIONS，文档、图片、音视频、纯文本）里的 open 回 403，reveal 照常。
   */
  sentFileAction: (messageId: MessageId, index: number, action: FileAction) => `/api/messages/${messageId}/files/${index}/${action}`,
  /** POST，同上，对象是聊天框上传的附件（按上传编号，只有数据目录里的那一份）。 */
  attachmentAction: (id: string, action: FileAction) => `/api/attachments/${id}/${action}`,
  /** POST（AddScheduleRequest → 201 ScheduleRecord）：用户给这个项目经理建定时任务，校验同 hub schedule add，失败回中文原因。 */
  pmSchedules: (pmId: PmId) => `/api/pms/${pmId}/schedules`,
  /** PUT（SetScheduleEnabledRequest → ScheduleRecord）暂停 / 恢复；DELETE → 204。 */
  schedule: (scheduleId: ScheduleId) => `/api/schedules/${scheduleId}`,
  /**
   * GET → CommandsResponse：输入框“/”列表。后台按对话找到它的会话和厂商去问，已经去掉隐藏的命令；问不到给空列表，不报错。
   * 对话不存在 → 404。用户手打了隐藏的命令（/clear、/model……），发消息时 400（code invalid），error 是拦下的原因。
   */
  commands: (conversationId: ConversationId) => `/api/conversations/${conversationId}/commands`,
  /** GET ?q=<搜索词> → FilesResponse：输入框“@”列表，只在这个对话的工作文件夹里搜文件（不含文件夹）。对话不存在 → 404。 */
  files: (conversationId: ConversationId, q: string) => `/api/conversations/${conversationId}/files?q=${encodeURIComponent(q)}`,
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

/**
 * GET /api/state。seq 是拍照那一刻的事件序号，WebSocket 从它之后接着推。
 * 不含老的项目群和归档的项目（11-03 拿掉了项目群，见 CONVERSATION_KINDS）。
 * M3：conversations、sessions 里含 Worker 的（kind worker），左栏不显示；“N 个 Worker 在跑”按 Conversation.pmId 是这个项目经理、
 * kind worker 的对话里最新一代会话 activity 不是 idle 的数。项目经理对话里那一行汇报是 kind worker 的消息（WorkerMessageMeta）。
 */
export interface StateSnapshot {
  seq: number;
  pms: Pm[];
  /** 进行中的项目（每个项目经理最多一个，Project.conversationId 是它的对话），按编号从小到大。 */
  projects: Project[];
  /** 这些项目没移除的文件夹，按编号从小到大。 */
  folders: ProjectFolder[];
  conversations: ConversationSnapshot[];
  sessions: SessionState[];
  health: HealthEntry[];
  /** 所有项目经理的定时任务（M6），按编号从小到大；ScheduleRecord.pmId 认是谁的。 */
  schedules: ScheduleRecord[];
}

/** GET /api/conversations/:id/messages?before=<消息编号>：更早的 100 条，从小到大。 */
export interface MessagesPage {
  messages: Message[];
  hasMore: boolean;
}

/**
 * POST /api/conversations/:id/messages。clientId 由网页生成，重发用同一个。
 * attachmentIds：先用 API_PATHS.uploads 上传拿到的上传编号；有附件时 text 可以是空的（只发文件）。服务端按编号找到磁盘上的文件，
 * 找不到（没传过、被清理了）→ 400；消息里存的附件信息和正文里的路径都是服务端从文件算出来的。
 */
export interface PostMessageRequest {
  clientId: string;
  text: string;
  attachmentIds?: string[];
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

// ---- M2：项目经理、性格设定、重试 ----
// 请求体由界面服务按 JSON Schema 校验（多余字段拒绝），长度上限见 limits.ts；业务校验在账本。

/**
 * POST /api/pms。name 按 normalizeName；persona 不超过 MAX_PERSONA_BYTES；defaultModel 空串或不给 = 用 claude 自己的默认。
 * vendor、defaultModel、effort 的取值见厂商清单 vendors.ts，不对 → 400 带原因。
 * folder：主文件夹（用户填的路径，可以带 ~，服务端解析成真实路径），可选；给了就同时建好项目，不存在等不对 → 400 带原因。
 */
export interface CreatePmRequest {
  name: string;
  mode: PmMode;
  vendor?: AgentVendor;
  defaultModel?: string | null;
  effort?: string | null;
  persona: string;
  folder?: string;
}

export interface CreatePmResponse {
  pmId: PmId;
  /** 它的对话，网页建好后跳过去。 */
  conversationId: ConversationId;
}

/** GET /api/pms/:id/persona 的响应就是账本的 PersonaView。 */
export type PersonaResponse = PersonaView;

/** PUT /api/pms/:id/persona。至少给一个字段（reason 不算）；model、effort 给 null 是改回默认。 */
export interface EditPersonaRequest {
  text?: string;
  mode?: PmMode;
  vendor?: AgentVendor;
  model?: string | null;
  effort?: string | null;
  reason?: string;
}

/** PUT persona、POST revert 的响应：改完之后的样子（没改动时 changed 为 false）。 */
export interface EditPersonaResponse {
  changed: boolean;
  persona: PersonaView;
}

/** POST /api/pms/:id/schedules：daily（"HH:MM"）和 everyMinutes 二选一。 */
export interface AddScheduleRequest {
  name: string;
  prompt: string;
  daily?: string;
  everyMinutes?: number;
}

/** PUT /api/schedules/:id。 */
export interface SetScheduleEnabledRequest {
  enabled: boolean;
}

/** GET /api/models：每家厂商一份模型名单（按 AGENT_VENDORS 的顺序）。问不到厂商时是打包的名单，不报错。 */
export interface ModelsResponse {
  catalogs: ModelCatalog[];
}

/** 输入框“/”列表里的一项。name 不带开头的 /；argumentHint 没有就不给。 */
export interface ComposerCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

/** GET /api/conversations/:id/commands。 */
export interface CommandsResponse {
  commands: ComposerCommand[];
}

/**
 * 输入框“@”列表里的一项：
 * - path：在 root 下的相对路径（显示用：文件名 + 父目录）；
 * - root：它在哪个工作文件夹（绝对路径）；
 * - insert：选中后插进输入框的文字（不含末尾空格），由厂商实现生成（claude 是 `@path`，带空格的 `@"a b.md"`），网页原样插入。
 *   主文件夹（agent 的工作目录）里的用相对路径，别的文件夹里的用绝对路径。
 */
export interface FileEntry {
  path: string;
  root: string;
  insert: string;
}

/** GET /api/conversations/:id/files?q=。最多 MAX_FILE_RESULTS 条，按匹配程度排好；truncated：有文件夹文件太多，没列全。 */
export interface FilesResponse {
  entries: FileEntry[];
  truncated: boolean;
}

/** POST /api/pms/:id/renew-session → 202：交接请求那条系统消息的编号（连点返回同一条）。之后照常从 WebSocket 推。 */
export interface RenewSessionResponse {
  messageId: MessageId;
}

/** POST /api/messages/:id/retry → 202。之后状态变化照常从 WebSocket 推（message.updated）。 */
export interface RetryMessageResponse {
  messageId: MessageId;
}

/** POST /api/pick-folder 的请求体：对话框从哪个文件夹开始（输入框里已有的路径）；没给、不存在或不是文件夹就从家目录开始。 */
export interface PickFolderRequest {
  startDir?: string;
}

/** POST /api/pick-folder 的响应：选中的文件夹的绝对路径；用户点了取消（或超时）是 null。 */
export interface PickFolderResponse {
  path: string | null;
}

// ---- WebSocket：服务端 → 网页 ----

/**
 * 同一个事务里推出的几条变化按这个顺序：pm.* → project.* → conversation.created → session.created → folders.updated →
 * message.* → session.status → health.updated → schedule.*。所以网页收到某个对话的 message.created 时，那个对话一定已经有了。
 */
export const CHANGE_TYPES = [
  "message.created",
  "message.updated",
  "session.status",
  "health.updated",
  "pm.created",
  "pm.updated",
  "project.created",
  "folders.updated",
  "conversation.created",
  "session.created",
  "schedule.updated",
  "schedule.removed",
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
  /** 某个项目没移除的文件夹整个换成这一份（挂、移除、建项目时）。 */
  "folders.updated": { projectId: ProjectId; folders: ProjectFolder[] };
  /** 新对话（新项目经理的那个对话；M3 起还有派活时 Worker 的对话），消息是空的。 */
  "conversation.created": { conversation: Conversation };
  /** 新会话（建项目经理时；M3 起还有派活时 Worker 的会话）。 */
  "session.created": { session: SessionState };
  /** 定时任务建了、暂停、恢复、跑过一次（M6），整行换成这一份。 */
  "schedule.updated": { schedule: ScheduleRecord };
  "schedule.removed": { scheduleId: ScheduleId };
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
