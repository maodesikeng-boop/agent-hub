// 前后端、各块共用的数据形状。字段名和 migrations/ 里的列一一对应（驼峰 ↔ 下划线），例外在字段注释里写明。
// 不用 enum（erasableSyntaxOnly）：取值用 `as const` 数组，类型从数组推出来。

import { MAX_NAME_CHARS } from "./limits.ts";

export type PmId = number;
export type ConversationId = number;
export type MessageId = number;
/** agent_sessions 的行号；Claude 那边的会话 ID 是 AgentSessionRow.vendorSessionId。 */
export type SessionId = number;
export type ActionId = number;
export type ProjectId = number;
export type ProjectFolderId = number;
export type PersonaChangeId = number;
export type HandoffId = number;
export type HubCallId = number;

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

/**
 * 排队中 / 已送达 / 处理中 / 已回复 / 已停止 / 失败。用户发的消息、要发给 agent 的系统消息（M2）有状态，
 * agent 的消息和只给人看的系统消息是 null。网页只给用户的消息显示投递状态。
 */
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

/**
 * 会扩展（M3 起有 Worker 汇报等），数据库不加 CHECK，用 isOneOf 校验。
 * system：系统消息（M2 起），kind 一律是 text，meta 是 SystemMessageMeta，网页居中显示。
 */
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

/**
 * 项目经理的两种模式（设计第 2.2 节）：只是提示词里的默认做法，程序不硬拦。数据库里有 CHECK。
 * - manage_only：只管理（推荐用于复杂项目）。M2 还没有 Worker，提示词写成“只讨论、拆步骤，要动手先问用户，用户让它做就自己做”；
 * - hands_on：自己也干活，直接在项目文件夹里改。
 */
export const PM_MODES = ["manage_only", "hands_on"] as const;
export type PmMode = (typeof PM_MODES)[number];
export const DEFAULT_PM_MODE: PmMode = "manage_only";

/** 界面上的叫法（新建项目经理的单选、资料页）。 */
export const PM_MODE_LABELS: Readonly<Record<PmMode, string>> = {
  manage_only: "只管理",
  hands_on: "自己也干活",
};

/** 单选下面的一句说明。 */
export const PM_MODE_DESCRIPTIONS: Readonly<Record<PmMode, string>> = {
  manage_only: "推荐用于复杂项目：只讨论、拆任务，要动手先问你",
  hands_on: "适合不复杂的项目：自己直接在项目文件夹里改",
};

/**
 * 新建项目经理时性格设定的模板（界面预填，用户可改）。M1 第一次启动建的项目经理也用这一份。
 * 安全红线不在这里（设计第 11 章），项目经理改不了。
 */
export const PM_PERSONA_TEMPLATE = `# 性格设定

- 像一个靠谱的同事：先弄清楚用户要什么，再动手或给建议。
- 有推荐就直说推荐哪个、为什么，不罗列一堆选项让用户自己挑。
- 说大白话，少用术语；不确定的事直说不确定，不编。
- 用户让你自己动手就动手；改动大、拿不准的，先问一句。
`;

/**
 * 项目经理。性格设定的正文不在这里（可能有几十 KB），用 GET /api/pms/:id/persona 读。
 * 名字唯一（数据库 UNIQUE），用 normalizeName 规整过。
 */
export interface Pm {
  id: PmId;
  name: string;
  avatarFile: string | null;
  mode: PmMode;
  defaultModel: string | null;
  /**
   * 性格设定文件 personas/pm-<编号>.md（见 paths.ts 的 personaFilePath）。只是给人看、给人手改的副本：
   * 正文以数据库 pms.persona 为准（见 ledger.ts 的 getPersona）。
   */
  personaFile: string | null;
  createdAt: number;
}

/**
 * kind 是 project_group 时：projectId 一定有（数据库里按 project_id 唯一，一个项目一个群），
 * pmId 是建群时的项目经理，之后换人不改（现在归谁管看 Project.pmId）；title 是建群时的项目名。
 */
export interface Conversation {
  id: ConversationId;
  kind: ConversationKind;
  pmId: PmId | null;
  projectId: ProjectId | null;
  title: string;
  createdAt: number;
}

/** 进行中 / 已归档 / 已删除。M2 只用 active（归档、删除要审批，M4）。数据库里有 CHECK。 */
export const PROJECT_STATUSES = ["active", "archived", "deleted"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/**
 * 项目（设计第 9 章）。进行中的项目名字唯一（数据库部分唯一索引），用 normalizeName 规整过。
 * conversationId 是它的群，建项目时在同一个事务里建好，之后不变。
 */
export interface Project {
  id: ProjectId;
  name: string;
  /** 一句话说明，没有就是 null。不超过 MAX_DESCRIPTION_CHARS 个字符。 */
  description: string | null;
  status: ProjectStatus;
  /** 现在归谁管；换项目经理时改。 */
  pmId: PmId;
  conversationId: ConversationId;
  createdAt: number;
  updatedAt: number;
}

/**
 * 项目挂的文件夹。path 是 resolveFolder 之后的真实路径（展开 ~、realpath）。
 * - 一个项目同一时间只有一个主文件夹，主文件夹不能标移除（数据库有约束；换主文件夹 M2 不做）；
 * - 同一个真实路径只能当一个项目的主文件夹（removedAt 为空的那些里），当别的项目的附加文件夹可以；
 * - 同一个项目同一个路径同一时间只挂一次；移除只标 removedAt，不删行、不碰磁盘，之后可以再挂（新的一行）。
 */
export interface ProjectFolder {
  id: ProjectFolderId;
  projectId: ProjectId;
  path: string;
  isMain: boolean;
  addedAt: number;
  removedAt: number | null;
}

/** 谁改的性格设定：用户（界面）/ 项目经理自己（hub persona edit）/ 启动时发现文件被手改过。会扩展，数据库不加 CHECK。 */
export const PERSONA_ACTORS = ["user", "pm", "file"] as const;
export type PersonaActor = (typeof PERSONA_ACTORS)[number];

/**
 * 性格设定的一次修改（设计第 2.2 节）。正文和模式一起记前后两份，撤销就是按 textBefore、modeBefore 改回去，
 * 再记一条 revertOf 指向被撤销那条的新修改。
 * 和计划的出入：正文前后叫 textBefore、textAfter（列名 text_before、text_after），因为 BEFORE、AFTER 是 SQL 关键字。
 */
export interface PersonaChange {
  id: PersonaChangeId;
  pmId: PmId;
  actor: PersonaActor;
  /** actor 是 pm 时是发起的会话；其他是 null。 */
  sessionId: SessionId | null;
  textBefore: string;
  textAfter: string;
  modeBefore: PmMode;
  modeAfter: PmMode;
  /** 改的理由（hub persona edit --reason、界面的说明），没有就是 null。 */
  reason: string | null;
  /** 这一条是撤销哪一条；不是撤销就是 null。 */
  revertOf: PersonaChangeId | null;
  createdAt: number;
}

/** 交接原因。M2 只有换项目经理；以后有“会话太长”“换主文件夹”。会扩展，数据库不加 CHECK。 */
export const HANDOFF_REASONS = ["reassign"] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

/**
 * 一份交接（设计第 9 章）。正文在 file（state/handoffs/<项目编号>/<时间>.md，见 paths.ts 的 handoffFilePath），
 * 账本在事务提交前写好（临时文件 + 改名），写不了整个命令失败。
 */
export interface Handoff {
  id: HandoffId;
  projectId: ProjectId;
  fromSessionId: SessionId;
  toSessionId: SessionId;
  fromPmId: PmId;
  toPmId: PmId;
  file: string;
  reason: HandoffReason;
  createdAt: number;
}

/**
 * 一次 hub 调用的记录（m2-plan 第 7 节第 9 条）。令牌不对、参数校验没过的请求到不了账本，不记。
 * 成功的和业务改动在同一个事务里写；失败的在回滚之后另起一个事务写。
 */
export interface HubCall {
  id: HubCallId;
  sessionId: SessionId;
  /** HubCommand，如 "project.create"。 */
  command: string;
  /** 请求体参数（JSON）。 */
  args: Record<string, unknown>;
  ok: boolean;
  /** 失败时的 LedgerErrorCode；成功是 null。 */
  errorCode: string | null;
  /** 成功时是返回的 text，失败时是 message。 */
  result: string;
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
  /** 工具调用：{ toolUseId, name, input }；系统消息：SystemMessageMeta（用 systemEventOf 读）；其他消息是 null。 */
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

/** 系统消息的事件（Message.meta.event）。会扩展。 */
export const SYSTEM_EVENTS = ["project.created", "folder.attached", "folder.detached", "project.reassigned", "persona.changed"] as const;
export type SystemEvent = (typeof SYSTEM_EVENTS)[number];

/**
 * 系统消息的 meta（sender 是 system、kind 是 text）。哪条发在哪个对话、要不要也发给 agent：
 * - project.created：发在新项目的群（“项目已建好”）。只给人看。
 * - folder.attached / folder.detached：发在项目的群，同时发给 agent（下一条消息前自动重启生效）。
 * - project.reassigned：发在项目的群（“项目经理由小林换成阿周，交接在这里”，只给人看，新一代会话的提示词里已经有交接）；
 *   在接手的项目经理的私聊再发一条（“小林把 foo 交给了你”），同时发给 agent。两条 meta 一样。
 * - persona.changed：发在发起修改的对话（项目经理自己改的：那个会话的对话；用户在界面改、撤销的，以及启动时发现文件被手改的：
 *   这个项目经理的私聊）。只给人看，界面上带“撤销”按钮（personaChangeId；只有最近一条能撤销）。
 *
 * “同时发给 agent”的：账本在同一个事务里写这条消息（status = queued）并登记 session.send（source: "system"），
 * 文字以 SYSTEM_MESSAGE_PREFIX 开头，原样写给 agent。只给人看的 status 是 null，文字不带前缀。
 * 网页显示时一律过一遍 stripSystemPrefix，不显示投递状态。
 */
export type SystemMessageMeta =
  | { event: "project.created"; projectId: ProjectId }
  | { event: "folder.attached"; projectId: ProjectId; folderId: ProjectFolderId; path: string }
  | { event: "folder.detached"; projectId: ProjectId; folderId: ProjectFolderId; path: string }
  | { event: "project.reassigned"; projectId: ProjectId; handoffId: HandoffId; fromPmId: PmId; toPmId: PmId }
  | { event: "persona.changed"; pmId: PmId; personaChangeId: PersonaChangeId; revertOf: PersonaChangeId | null };

/** 发给 agent 的系统消息的开头（设计第 7.3 节的来源标签）。 */
export const SYSTEM_MESSAGE_PREFIX = "【系统】";

/** 是系统消息、meta.event 认识就返回 meta（不逐个字段校验，账本写的就是这个形状），否则 null。 */
export function systemEventOf(message: Pick<Message, "sender" | "meta">): SystemMessageMeta | null {
  if (message.sender !== "system" || message.meta === null) return null;
  return isOneOf(SYSTEM_EVENTS, message.meta.event) ? (message.meta as SystemMessageMeta) : null;
}

/** 网页显示系统消息时去掉开头的【系统】。 */
export function stripSystemPrefix(text: string): string {
  return text.startsWith(SYSTEM_MESSAGE_PREFIX) ? text.slice(SYSTEM_MESSAGE_PREFIX.length) : text;
}

/**
 * 规整项目名、项目经理名：去掉首尾空白；空的、超过 MAX_NAME_CHARS 个字符的、带换行等控制字符的返回 null。
 * 界面服务、agent 接口校验请求体用它判断，账本存之前再用它规整一遍（存的是规整后的）。
 */
export function normalizeName(raw: string): string | null {
  const name = raw.trim();
  if (name === "" || [...name].length > MAX_NAME_CHARS) return null;
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

/** UTF-8 字节数（各种“不超过多少 KB”的限制都按它算）。 */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
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
/** 额度用完了。Claude 的 status 有 "allowed"、"allowed_warning"（快到了，照常干活）、"rejected"。 */
export const RATE_LIMIT_REJECTED = "rejected";

/**
 * 额度是不是用完了：只有 rejected 算。发消息的处理函数（等额度）和网页（状态行显示“等额度”）都用它，
 * 免得两边判断不一样（m2-plan 第 7 节第 2 条）。
 */
export function isQuotaExhausted(info: RateLimitInfo | null | undefined): boolean {
  return info?.status === RATE_LIMIT_REJECTED;
}

/**
 * 会话。项目经理的会话（role = pm）：
 * - 私聊：conversationId 是它的私聊，cwd 是 pm-home/<编号>/，addDirs 空；
 * - 项目群：conversationId 是群，cwd 是项目主文件夹的真实路径，addDirs 是其他没移除的文件夹（挂、移除时账本改这一列）。
 *   换项目经理时开下一代（generation + 1，属于新项目经理）；发消息一律找这个对话 generation 最大的那个会话。
 */
export interface AgentSessionRow {
  id: SessionId;
  role: AgentRole;
  conversationId: ConversationId | null;
  /**
   * 这个会话属于哪个项目经理（M2 起）。项目经理的会话一定有：同一个群换人后，旧一代仍属于原项目经理，
   * 提示词、hub 认人都按它。总助、Worker 的会话是 null。M1 留下的会话迁移时按对话补上。
   */
  pmId: PmId | null;
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
