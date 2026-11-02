// 前后端、各块共用的数据形状。字段名和 migrations/0001_init.sql 的列一一对应（驼峰 ↔ 下划线）。
// 不用 enum（erasableSyntaxOnly）：取值用 `as const` 数组，类型从数组推出来。

export type PmId = number;
export type ConversationId = number;
export type MessageId = number;
/** agent_sessions 的行号；Claude 那边的会话 ID 是 AgentSessionRow.vendorSessionId。 */
export type SessionId = number;
export type ActionId = number;

export type Unsubscribe = () => void;

export const CONVERSATION_KINDS = ["assistant", "pm", "project_group"] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

/** 排队中 / 已送达 / 处理中 / 已回复 / 已停止 / 失败。只有用户发的消息有状态，agent 的消息是 null。 */
export const MESSAGE_STATUSES = ["queued", "delivered", "processing", "replied", "stopped", "failed"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const MESSAGE_SENDERS = ["user", "agent", "system"] as const;
export type MessageSender = (typeof MESSAGE_SENDERS)[number];

/** text：正常的文字；tool：一次工具调用（collapsed 为 true，界面折叠成“执行了 N 个操作”）。 */
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
  text: string;
  /** 工具调用：{ toolUseId, name, input }；其他消息是 null。 */
  meta: Record<string, unknown> | null;
  collapsed: boolean;
  /** 用户消息 `client:<clientId>`；agent 输出 `session:<sessionId>:<uuid>`。数据库里唯一。 */
  dedupeKey: string;
  status: MessageStatus | null;
  createdAt: number;
  updatedAt: number;
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

/** 各模块各写自己那一行；连续失败 3 次在界面标红。 */
export const HEALTH_MODULES = ["store", "actions", "driver", "ui-server"] as const;
export type HealthModule = (typeof HEALTH_MODULES)[number];

export interface HealthEntry {
  module: HealthModule;
  consecutiveFailures: number;
  lastError: string | null;
  updatedAt: number;
}
