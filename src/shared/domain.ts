// 前后端、各块共用的数据形状。字段名和 migrations/0001_init.sql 的列一一对应（驼峰 ↔ 下划线）。
// 不用 enum（erasableSyntaxOnly）：取值用 `as const` 数组，类型从数组推出来。

export type PmId = number;
export type ConversationId = number;
export type MessageId = number;
/** agent_sessions 的行号；Claude 那边的会话 ID 是 AgentSessionRow.vendorSessionId。 */
export type SessionId = number;
export type ActionId = number;

export type Unsubscribe = () => void;

/**
 * 校验一个值是不是 `as const` 数组里的某一个。会扩展的枚举（消息的 kind、sender，动作的 type）
 * 数据库里不加 CHECK，读写时用它在代码里校验。
 */
export function isOneOf<const T extends readonly unknown[]>(values: T, value: unknown): value is T[number] {
  return values.includes(value);
}

export const CONVERSATION_KINDS = ["assistant", "pm", "project_group"] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

/** 排队中 / 已送达 / 处理中 / 已回复 / 已停止 / 失败。只有用户发的消息有状态，agent 的消息是 null。 */
export const MESSAGE_STATUSES = ["queued", "delivered", "processing", "replied", "stopped", "failed"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/**
 * 合法的状态转换：queued → delivered → processing → replied / stopped / failed。
 * - 还没到 processing 也可能直接 failed（起不来、写入校验没过）或 stopped（写进去了、还没回显就被打断）；
 * - replied、stopped 是终点；只有 failed 能回到 delivered（重试写进去了）。
 * 账本只按这张表改状态；不合法的转换（包括同状态）一律忽略，不报错——
 * 比如重启后重发一条 processing 的消息，驱动层再出 message.delivered，它仍然是 processing。
 */
export const MESSAGE_STATUS_TRANSITIONS: Readonly<Record<MessageStatus, readonly MessageStatus[]>> = {
  queued: ["delivered", "failed"],
  delivered: ["processing", "stopped", "failed"],
  processing: ["replied", "stopped", "failed"],
  replied: [],
  stopped: [],
  failed: ["delivered"],
};

export function canTransitionMessage(from: MessageStatus, to: MessageStatus): boolean {
  return MESSAGE_STATUS_TRANSITIONS[from].includes(to);
}

/** 会扩展（M3 起有 Worker 汇报等），数据库不加 CHECK，用 isOneOf 校验。 */
export const MESSAGE_SENDERS = ["user", "agent", "system"] as const;
export type MessageSender = (typeof MESSAGE_SENDERS)[number];

/**
 * text：正常的文字；tool：一次工具调用（collapsed 为 true，界面折叠成“执行了 N 个操作”）。
 * 会扩展（M3 起有工单卡片等），数据库不加 CHECK，用 isOneOf 校验。
 */
export const MESSAGE_KINDS = ["text", "tool"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const AGENT_ROLES = ["assistant", "pm", "worker"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** 空闲 / 运行中 / 已结束 / 坏了。 */
export const SESSION_STATUSES = ["idle", "running", "ended", "broken"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export interface Pm {
  id: PmId;
  name: string;
  avatarFile: string | null;
  mode: string;
  defaultModel: string | null;
  personaFile: string | null;
  createdAt: number;
}

export interface Conversation {
  id: ConversationId;
  kind: ConversationKind;
  pmId: PmId | null;
  projectId: number | null;
  title: string;
  createdAt: number;
}

export interface Message {
  /** 自增，单调递增；“更早的消息”用它翻页。 */
  id: MessageId;
  conversationId: ConversationId;
  sessionId: SessionId | null;
  ticketId: number | null;
  sender: MessageSender;
  kind: MessageKind;
  /**
   * text 消息：原文。
   * tool 消息：账本生成的一行摘要（工具名 + 最要紧的参数，如 `Bash: pnpm test`、`Read: src/a.ts`），
   * 不超过 200 个字符、不含换行；完整参数在 meta.input。网页直接显示它，不自己拼。
   */
  text: string;
  /** 工具调用：{ toolUseId, name, input }；其他消息是 null。 */
  meta: Record<string, unknown> | null;
  collapsed: boolean;
  /** 见 userMessageDedupeKey / agentMessageDedupeKey。数据库里唯一。 */
  dedupeKey: string;
  status: MessageStatus | null;
  /**
   * status 是 failed 时的原因，界面直接显示（如“claude_not_found: …”）；其他时候 null。
   * failed 回到 delivered 时清空。
   */
  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 用户消息的去重键：同一个对话里同一个 clientId 只有一条。 */
export function userMessageDedupeKey(conversationId: ConversationId, clientId: string): string {
  return `client:${conversationId}:${clientId}`;
}

/**
 * agent 输出的去重键：`session:<会话>:<uuid>`；工具调用再带上 toolUseId
 * （同一个 assistant 事件里可能有好几个工具调用，uuid 相同）。
 * uuid 由驱动层保证总有，见 driver.ts 的 AgentTextEvent。
 */
export function agentMessageDedupeKey(sessionId: SessionId, uuid: string, toolUseId?: string): string {
  return toolUseId === undefined ? `session:${sessionId}:${uuid}` : `session:${sessionId}:${uuid}:${toolUseId}`;
}

/** 一个额度窗口。resetsAt 是 Unix 秒（照抄 Claude 的 rate_limit_event）。 */
export interface RateLimitWindow {
  utilization: number;
  resetsAt: number;
  status: string;
}

/** 照抄 Claude 的 rate_limit_event.rate_limit_info：status 不是 "allowed" 就是“等额度”。 */
export interface RateLimitInfo {
  status: string;
  resetsAt: number | null;
  /** 键如 "five_hour"、"seven_day"。 */
  windows: Record<string, RateLimitWindow>;
}

export const RATE_LIMIT_ALLOWED = "allowed";

export interface AgentSessionRow {
  id: SessionId;
  role: AgentRole;
  conversationId: ConversationId | null;
  ticketId: number | null;
  vendor: string;
  /** 我们预先生成的 UUID，第一次用 --session-id，之后一律 --resume。 */
  vendorSessionId: string;
  cwd: string;
  addDirs: string[];
  /** 开新会话加一；和会话 ID 一起做“启动或恢复会话”动作的去重键。 */
  generation: number;
  model: string | null;
  pid: number | null;
  status: SessionStatus;
  /** 是否跑完过一轮：决定下次用 --session-id 还是 --resume。 */
  hasCompletedTurn: boolean;
  lastEventAt: number | null;
  rateLimit: RateLimitInfo | null;
  createdAt: number;
  updatedAt: number;
}

/** 空闲 / 在干活 / 正在停。 */
export type SessionActivity = "idle" | "working" | "stopping";

/** 网页要显示的会话状态（状态行、停止按钮、等额度）。WebSocket 的 session.status 推的就是它。 */
export interface SessionState {
  sessionId: SessionId;
  conversationId: ConversationId | null;
  status: SessionStatus;
  activity: SessionActivity;
  /** 正在用的工具名，状态行显示“正在做什么”；没有就是 null。 */
  currentTool: string | null;
  rateLimit: RateLimitInfo | null;
  lastEventAt: number | null;
}

/** 各模块各写自己那一行；连续失败 3 次在界面标红。每次改动推一条 health.updated。 */
export const HEALTH_MODULES = ["store", "actions", "driver", "ui-server"] as const;
export type HealthModule = (typeof HEALTH_MODULES)[number];

export interface HealthEntry {
  module: HealthModule;
  consecutiveFailures: number;
  /** 最近一次的错误，界面直接显示；驱动层的错误以错误码开头（如“claude_not_found: …”）。成功一次就清空。 */
  lastError: string | null;
  updatedAt: number;
}
