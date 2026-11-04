// 前后端、各块共用的数据形状。字段名和 migrations/ 里的列一一对应（驼峰 ↔ 下划线），例外在字段注释里写明。
// 不用 enum（erasableSyntaxOnly）：取值用 `as const` 数组，类型从数组推出来。

import { MAX_NAME_CHARS, MAX_WORKER_TITLE_CHARS } from "./limits.ts";
import type { AgentVendor } from "./vendors.ts";
import type { WorkerReportStatus } from "./worker.ts";

export type PmId = number;
export type ConversationId = number;
export type MessageId = number;
/** agent_sessions 的行号；Claude 那边的会话 ID 是 AgentSessionRow.vendorSessionId。 */
export type SessionId = number;
export type ActionId = number;
export type ProjectId = number;
export type ProjectFolderId = number;
export type PersonaChangeId = number;
export type HubCallId = number;
export type WorkerId = number;

export type Unsubscribe = () => void;

/**
 * 校验一个值是不是 `as const` 数组里的某一个。会扩展的枚举（消息的 kind、sender，动作的 type）
 * 数据库里不加 CHECK，读写时用它在代码里校验。
 */
export function isOneOf<const T extends readonly unknown[]>(values: T, value: unknown): value is T[number] {
  return values.includes(value);
}

/**
 * project_group：项目群，2026-11-03 拿掉了（一个项目经理就是一个会话）。只剩 M2 开发时留下的老数据：
 * 迁移 0003 把它们的项目标归档、会话标已结束，账本不再建，快照里不给，网页上看不到。数据库的 CHECK 里还有它。
 * worker（M3）：一个 Worker 自己的对话，见 Conversation。数据库有 CHECK。
 */
export const CONVERSATION_KINDS = ["assistant", "pm", "project_group", "worker"] as const;
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
 * - replied、stopped 是终点；只有 failed 能往回走：
 *   - failed → queued：用户点“重试”（ledger.retryMessage，M2）。账本在同一个事务里把状态改回 queued、清空 failureReason、
 *     重新登记 session.send，推一条 message.updated；之后照 queued → delivered → … 正常走；
 *   - failed → delivered：重启后重发、或执行器自己重试时写进去了（M1 就有）。
 * - queued → stopped（M3）：Worker 收工时还没发给它的话（比如 worktree 还没建好就收工了的任务说明），不会再发了。
 * 账本只按这张表改状态；不合法的转换（包括同状态）一律忽略，不报错——
 * 比如重启后重发一条 processing 的消息，驱动层再出 message.delivered，它仍然是 processing。
 */
export const MESSAGE_STATUS_TRANSITIONS: Readonly<Record<MessageStatus, readonly MessageStatus[]>> = {
  queued: ["delivered", "failed", "stopped"],
  delivered: ["processing", "stopped", "failed"],
  processing: ["replied", "stopped", "failed"],
  replied: [],
  stopped: [],
  failed: ["queued", "delivered"],
};

export function canTransitionMessage(from: MessageStatus, to: MessageStatus): boolean {
  return MESSAGE_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * 会扩展，数据库不加 CHECK，用 isOneOf 校验。
 * system：系统消息（M2 起），kind 是 text 时 meta 是 SystemMessageMeta，网页居中显示；
 * kind 是 worker 时是项目经理对话里那一行 Worker 汇报（M3，见 WorkerMessageMeta）。
 * pm（M3）：Worker 对话里项目经理的话：派活时的任务说明、hub worker send 打回或回答。和用户消息一样有投递状态，
 * 登记 session.send 时 source 是 "user"（对 Worker 来说项目经理就是“用户”，忙时连发的会拼成一条）。
 * user 在 Worker 对话里：用户在网页的 Worker 页面直接说的话，workerId 是这个 Worker；写给 Worker 时带 USER_TO_WORKER_TAG
 * 和项目经理的话区分开（worker.ts 的 deliveryText）。
 */
export const MESSAGE_SENDERS = ["user", "agent", "system", "pm"] as const;
export type MessageSender = (typeof MESSAGE_SENDERS)[number];

/**
 * text：正常的文字；tool：一次工具调用（collapsed 为 true，界面折叠成“执行了 N 个操作”）；
 * worker（M3）：项目经理对话里那一行 Worker 汇报，见 WorkerMessageMeta。
 * 会扩展，数据库不加 CHECK，用 isOneOf 校验。
 */
export const MESSAGE_KINDS = ["text", "tool", "worker"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export const WORKER_MESSAGE_KIND = "worker" satisfies MessageKind;

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
 * 新建项目经理时性格设定的模板（界面预填，用户可改）。第一次启动建的项目经理也用这一份；
 * 只有这一份，daemon/prompt.ts 引用它，不另写。安全红线不在这里（设计第 11 章），项目经理改不了。
 */
export const PM_PERSONA_TEMPLATE = `# 性格设定

- 像一个靠谱的同事：先弄清楚用户要什么，再按你的默认做法往下推进。
- 有推荐就直说推荐哪个、为什么，不罗列一堆选项让用户自己挑。
- 说大白话，少用术语；不确定的事直说不确定，不编。
- 用户让你自己动手就动手；改动大、拿不准的，先问一句。
`;

/**
 * 读性格设定正文的兜底：pms.persona 是 NULL（M1 升上来、syncPersonaFiles 还没填）时用 PM_PERSONA_TEMPLATE。
 * 空串是用户自己清空的，原样返回。getLaunchContext、getPersona 都用它。
 */
export function personaOrTemplate(persona: string | null): string {
  return persona ?? PM_PERSONA_TEMPLATE;
}

/**
 * 项目经理。性格设定的正文不在这里（可能有几十 KB），用 GET /api/pms/:id/persona 读。
 * 名字唯一（数据库 UNIQUE），用 normalizeName 规整过。
 */
export interface Pm {
  id: PmId;
  name: string;
  avatarFile: string | null;
  mode: PmMode;
  /** 用哪家的 agent（厂商清单 vendors.ts）。 */
  vendor: AgentVendor;
  /** 项目经理的模型，null = 默认（不传 --model）。Worker 不给 --model 时也用它。 */
  defaultModel: string | null;
  /** 思考程度，null = 默认（不传 --effort）。Worker 不给 --effort 时也用它。 */
  effort: string | null;
  /**
   * 性格设定文件 personas/pm-<编号>.md（位置一律用 paths.ts 的 personaFilePath 算）。只是给人看、给人手改的副本：
   * 正文以数据库 pms.persona 为准（见 ledger.ts 的 getPersona）。同步规则见 Ledger.syncPersonaFiles。
   * 数据库里还有一列 pms.persona_file_hash（上次成功写入文件的内容哈希），只有账本用，不在这个形状里。
   */
  personaFile: string | null;
  createdAt: number;
}

/**
 * kind 是 pm：项目经理唯一的那个对话（左栏一行），pmId 是它，title 是建的时候的名字。它的项目（如果有）是
 * Project.conversationId 指向它的那个，projectId 一直是 null。
 * kind 是 project_group：老的项目群（见 CONVERSATION_KINDS），projectId 是老项目。
 * kind 是 worker（M3）：一个 Worker 自己的对话（WorkerRecord.workerConversationId），pmId 是派它的项目经理，
 * projectId 是 Worker 所在的项目，title 是 Worker 的标题。左栏不显示，点项目经理对话里那一行打开。
 */
export interface Conversation {
  id: ConversationId;
  kind: ConversationKind;
  pmId: PmId | null;
  projectId: ProjectId | null;
  title: string;
  createdAt: number;
}

/**
 * 进行中 / 已归档 / 已删除。数据库里有 CHECK。账本只建 active 的；archived 现在只有迁移 0003 归档的老项目群
 * （归档、删除要审批，M4）。快照里只给 active 的。
 */
export const PROJECT_STATUSES = ["active", "archived", "deleted"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/**
 * 项目（设计第 9 章，11-03 改过）：一个项目经理管的那一套文件夹（一个主文件夹 + 可选的附加文件夹）。
 * 每个项目经理同时只有一个进行中的项目（数据库部分唯一索引），挂在它唯一的那个对话上：
 * 那个对话的会话在主文件夹里跑，附加文件夹用 --add-dir 带进去。不能交给别的项目经理。
 * 名字只给人看（不唯一），用 normalizeName 规整过，默认是主文件夹的名字。
 */
export interface Project {
  id: ProjectId;
  name: string;
  /** 一句话说明，没有就是 null。不超过 MAX_DESCRIPTION_CHARS 个字符。 */
  description: string | null;
  status: ProjectStatus;
  /** 管这个项目的项目经理，建好后不变。 */
  pmId: PmId;
  /** 这个项目经理的对话（kind pm）；老项目群的项目是那个群。 */
  conversationId: ConversationId;
  createdAt: number;
  updatedAt: number;
}

/**
 * 项目挂的文件夹。path 是 resolveFolder 之后的真实路径（展开 ~、realpathSync.native）。
 * - 一个项目同一时间只有一个主文件夹，主文件夹不能标移除（数据库有约束；换主文件夹 M2 不做）；
 * - 同一个真实路径只能当一个进行中项目的主文件夹（removedAt 为空的那些里；账本查，数据库不限），当别的项目的附加文件夹可以；
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

/** Worker 的状态（数据库有 CHECK，workers.status）：open 派出去了（Worker 在干活或者等项目经理的话）；ended 收工了，或者建 worktree 彻底失败。 */
export const WORKER_STATUSES = ["open", "ended"] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

/**
 * Worker 在哪干活（数据库有 CHECK，m3-plan 第 2.6 节）：
 * - worktree：守护进程用 git worktree 给它建的单独目录和分支（主文件夹是有提交的 git 仓库时默认这个）；
 * - main：直接在项目的主文件夹里干（不是 git 仓库、还没有提交，或者项目经理派活时给了 --no-worktree）。
 */
export const WORKER_WORKSPACES = ["worktree", "main"] as const;
export type WorkerWorkspace = (typeof WORKER_WORKSPACES)[number];

/**
 * 一个 Worker 的记录（m3-plan 第 2 节；设计里叫“工单”，M3 不另立这个叫法，工单卡片也不做）：项目经理 hub worker start
 * 派一次活就是一个。字段和 workers 表的列一一对应。类型不叫 Worker：网页的 DOM 库里有全局的 Worker（Web Worker）。
 * 它的对话是 workerConversationId（kind worker），会话的 agent_sessions.worker_id 指向这里。
 */
export interface WorkerRecord {
  id: WorkerId;
  projectId: ProjectId;
  /** 派活的项目经理。只有它能 send、end 这个 Worker。 */
  pmId: PmId;
  /** 项目经理的对话：那一行汇报发在这里，汇报原文也从这里交给项目经理。 */
  pmConversationId: ConversationId;
  workerConversationId: ConversationId;
  /** normalizeWorkerTitle 规整过。 */
  title: string;
  /** 任务说明（hub worker start --stdin 读的），就是 Worker 对话里的第一条消息。不超过 MAX_TASK_BYTES。 */
  task: string;
  /** --model 给的；null = 用项目经理自己的模型。 */
  model: string | null;
  /** --effort 给的；null = 用项目经理自己的思考程度。 */
  effort: string | null;
  /** --readonly：Worker 只看不改（policy.ts 的 READONLY_PERMISSION_MODE）。打回、重启都沿用。 */
  readonly: boolean;
  workspace: WorkerWorkspace;
  /** worktree：hub/<编号>-<短名>（worker.ts 的 workerBranchName），派活时就定好；main：null。 */
  branch: string | null;
  /** worktree：<数据目录>/worktrees/<项目编号>/<编号>（paths.ts 的 workerWorktreePath），派活时就定好；main：null。 */
  worktreePath: string | null;
  /** worktree：建 worktree 时 HEAD 的提交，建好之前是 null；main：null。 */
  baseCommit: string | null;
  status: WorkerStatus;
  createdAt: number;
  updatedAt: number;
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
  /** 厂商、模型、思考程度的前后两份（资料页的 Agent 一栏；撤销时一起改回去）。0006 之前的老记录前后都是升级时的值。 */
  vendorBefore: AgentVendor;
  vendorAfter: AgentVendor;
  modelBefore: string | null;
  modelAfter: string | null;
  effortBefore: string | null;
  effortAfter: string | null;
  /** 改的理由（hub persona edit --reason、界面的说明），没有就是 null。 */
  reason: string | null;
  /** 这一条是撤销哪一条；不是撤销就是 null。 */
  revertOf: PersonaChangeId | null;
  createdAt: number;
}

/**
 * 一次 hub 调用的记录（m2-plan 第 7 节第 9 条）。令牌不对、参数校验没过的请求到不了账本，不记。
 * 成功的和业务改动在同一个事务里写；失败的在回滚之后另起一个事务写。
 * 这里只是审计用的摘要：args 里每个字符串字段、以及 result，超过 HUB_CALL_FIELD_MAX_BYTES 就截断
 * （按 UTF-8 字节截在字符边界上，末尾加“…（截断，原长 N 字节）”）。性格设定的完整正文以 persona_changes 为准。
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
  /** Worker 对话里的消息、项目经理对话里那一行汇报：Worker 编号；其他 null。 */
  workerId: WorkerId | null;
  sender: MessageSender;
  kind: MessageKind;
  /**
   * text 消息：原文。
   * tool 消息：账本生成的一行摘要（工具名 + 最要紧的参数，如 `Bash: pnpm test`、`Read: src/a.ts`），
   * 不超过 200 个字符、不含换行；完整参数在 meta.input。网页直接显示它，不自己拼。
   */
  text: string;
  /**
   * 工具调用：{ toolUseId, name, input }；系统消息：SystemMessageMeta（用 systemEventOf 读）；
   * Worker 汇报那一行（kind worker）：WorkerMessageMeta（用 workerEventOf 读）；其他消息是 null。
   */
  meta: Record<string, unknown> | null;
  collapsed: boolean;
  /** 见 userMessageDedupeKey / agentMessageDedupeKey。数据库里唯一。 */
  dedupeKey: string;
  status: MessageStatus | null;
  /**
   * status 是 failed 时的原因，界面直接显示（如“claude_not_found: …”）；其他时候 null。
   * failed 回到 queued（重试）或 delivered 时清空。
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

/**
 * 系统消息的去重键：`system:<对话>:<事件>:<相关编号>`。相关编号：project.created → projectId；
 * folder.attached / detached → folderId；persona.changed → personaChangeId。
 */
export function systemMessageDedupeKey(conversationId: ConversationId, meta: SystemMessageMeta): string {
  const ref = ((): number | string => {
    switch (meta.event) {
      case "project.created":
        return meta.projectId;
      case "folder.attached":
      case "folder.detached":
        return meta.folderId;
      case "persona.changed":
        return meta.personaChangeId;
      case "handover.requested":
      case "session.renewed":
        return meta.sessionId;
      case "handover.failed":
        return `${meta.messageId}.${meta.attempt}`;
    }
  })();
  return `system:${conversationId}:${meta.event}:${ref}`;
}

/**
 * 系统消息的事件（Message.meta.event）。会扩展。
 * 11-03 拿掉了 project.reassigned（交接）：老数据里还有，systemEventOf 认不出就当普通系统消息，照样居中显示文字。
 */
export const SYSTEM_EVENTS = ["project.created", "folder.attached", "folder.detached", "persona.changed", "handover.requested", "session.renewed", "handover.failed"] as const;
export type SystemEvent = (typeof SYSTEM_EVENTS)[number];

/**
 * 系统消息的 meta（sender 是 system、kind 是 text）。都发在项目经理的那个对话里，只给人看（status null，文字不带前缀）：
 * - project.created：“项目已建好”；
 * - folder.attached / folder.detached：挂上、移除了文件夹。下一条消息前自动重启生效；不单独给 agent 发【系统】消息
 *   （hub 是它自己调的，白白多跑一轮），重启后驱动层在下一条写进去的消息前面拼 RELAUNCH_NOTE（见 driver.ts）；
 * - persona.changed：改了性格设定（项目经理自己、用户在界面改、撤销、启动时发现文件被手改）。界面上带“撤销”按钮
 *   （personaChangeId；只有最近一条能撤销）。
 * 网页显示时一律过一遍 stripSystemPrefix（老数据里发给过 agent 的带【系统】），不显示投递状态。
 *
 * 开新会话（资料页的按钮，见 ledger/handover.ts）的两条要发给 agent（status 从 queued 起照常走，source system），
 * text 是发给 agent 的全文，网页只显示 systemNoticeText 给的一句：
 * - handover.requested：发给旧会话（sessionId），让项目经理把交接写成这一轮的回复；
 * - session.renewed：发给新一代会话（sessionId），带上交接和最近几条原话；网页显示“项目经理开了新会话（交接见上一条）”。
 *   失败、被停止了原地重新排队（attempts 记重排了几次），最多 HANDOVER_RENEW_RETRIES 次；
 * - handover.failed：只给人看。交接那一轮没写成（没换代），或者新会话一直没接上交接（不再重排）。messageId 是那条 H / R，
 *   attempt 是它第几次没成（同一条重新排队后又没成，再发一条）。
 * H、R 的 meta 里账本还会记几个内部字段（turnStartId、attempts、settled，见 handover.ts），网页不用。
 */
export type SystemMessageMeta =
  | { event: "project.created"; projectId: ProjectId }
  | { event: "folder.attached"; projectId: ProjectId; folderId: ProjectFolderId; path: string }
  | { event: "folder.detached"; projectId: ProjectId; folderId: ProjectFolderId; path: string }
  | { event: "persona.changed"; pmId: PmId; personaChangeId: PersonaChangeId; revertOf: PersonaChangeId | null }
  | { event: "handover.requested"; sessionId: SessionId }
  | { event: "session.renewed"; sessionId: SessionId; fromSessionId: SessionId }
  | { event: "handover.failed"; messageId: MessageId; attempt: number };

/** 发给 agent 的系统消息的开头（设计第 7.3 节的来源标签）。 */
export const SYSTEM_MESSAGE_PREFIX = "【系统】";

/** 是系统消息、meta.event 认识就返回 meta（不逐个字段校验，账本写的就是这个形状），否则 null。 */
export function systemEventOf(message: Pick<Message, "sender" | "meta">): SystemMessageMeta | null {
  if (message.sender !== "system" || message.meta === null) return null;
  return isOneOf(SYSTEM_EVENTS, message.meta.event) ? (message.meta as SystemMessageMeta) : null;
}

/** 网页上系统消息显示的那一句：开新会话的两条显示固定的一句（text 是发给 agent 的全文），别的去掉开头的【系统】。 */
export function systemNoticeText(message: Pick<Message, "sender" | "meta" | "text">): string {
  switch (systemEventOf(message)?.event) {
    case "handover.requested":
      return "已请项目经理写交接，写完换新会话";
    case "session.renewed":
      return "项目经理开了新会话（交接见上一条）";
    default:
      return stripSystemPrefix(message.text);
  }
}

/** 网页显示系统消息时去掉开头的【系统】。 */
export function stripSystemPrefix(text: string): string {
  return text.startsWith(SYSTEM_MESSAGE_PREFIX) ? text.slice(SYSTEM_MESSAGE_PREFIX.length) : text;
}

/**
 * 项目经理对话里那一行 Worker 汇报的事件（m3-plan 第 1 节“回到项目经理”）：
 * - started：派出去了（hub worker start）；
 * - report：Worker 这一轮正常结束（result），按 worker.ts 的 parseWorkerReport 取状态和摘要；
 * - turn_failed：这一轮出错、崩溃、被停止；
 * - worktree_failed：建 worktree 重试完了还是失败，Worker 标 ended；
 * - ended：收工了（hub worker end）；
 * - user_message：用户在网页的 Worker 页面直接对它说了一句，Worker 已经收到（message.delivered），告诉项目经理。
 */
export const WORKER_EVENTS = ["started", "report", "turn_failed", "worktree_failed", "ended", "user_message"] as const;
export type WorkerEvent = (typeof WORKER_EVENTS)[number];

/** 那一行的状态：report 时是 Worker 汇报里写的状态，没按格式是 "unformatted"；别的事件是 null。 */
export type WorkerLineStatus = WorkerReportStatus | "unformatted";

/**
 * 项目经理对话里那一行 Worker 汇报（sender system、kind worker、workerId 是 Worker 编号）的 meta。
 * 网页用 worker.ts 的 workerLineText 显示成“Worker · 标题 · 状态：摘要”，点开 workerConversationId。
 * 消息的 text 是交给项目经理的全文：
 * - report、turn_failed、worktree_failed：要交给项目经理，text 以 workerReportHeader（“【Worker #3 · 修 X 的汇报】”）开头，
 *   后面是汇报原文或原因；status 从 queued 起照常走，登记 session.send（source system）发给项目经理；
 * - user_message：同样交给项目经理，text 以 userToWorkerHeader（“【用户直接对 Worker #3 · 修 X 说的话（Worker 已收到）】”）开头，
 *   后面是用户的原文；
 * - started、ended：项目经理自己敲的 hub，只给人看，status 是 null，不发给它。
 * title、readonly、workerConversationId 抄自 WorkerRecord，网页不用另查。
 */
export type WorkerMessageMeta = {
  workerId: WorkerId;
  workerConversationId: ConversationId;
  title: string;
  readonly: boolean;
  event: WorkerEvent;
  status: WorkerLineStatus | null;
  /**
   * report：解析出的摘要；没按格式是原文第一行（parseWorkerReport 给的，已截断）；turn_failed、worktree_failed：原因；
   * user_message：用户的原文；started、ended：null。存完整的，显示时 workerLineText 压空白、按 WORKER_LINE_SUMMARY_CHARS 截断。
   */
  summary: string | null;
};

/** kind 是 worker、meta.event 认识就返回 meta（不逐个字段校验，账本写的就是这个形状），否则 null。 */
export function workerEventOf(message: Pick<Message, "kind" | "meta">): WorkerMessageMeta | null {
  if (message.kind !== WORKER_MESSAGE_KIND || message.meta === null) return null;
  return isOneOf(WORKER_EVENTS, message.meta.event) ? (message.meta as WorkerMessageMeta) : null;
}

/**
 * 那一行的去重键：
 * - started、ended、worktree_failed：每个 Worker 一条，`worker:<Worker 编号>:<事件>`，turnMessageId 给 null；
 * - report、turn_failed：`worker:<Worker 编号>:<事件>:<这一轮处理的消息里编号最大的那条>`。重放同一个 result（或同一次退出）不会出两行。
 * - user_message：`worker:<Worker 编号>:user_message:<用户那条消息的编号>`（turnMessageId 传那条消息），重启后重发再送达不会出两行。
 *   事件类型在键里：同一条消息这一轮失败了（turn_failed），之后被重发又跑出结果（report），两行都有，后来的汇报不会被吞掉。
 * 什么时候发哪一行见 ledger.ts 的 applyDriverEvent。
 */
export function workerMessageDedupeKey(workerId: WorkerId, event: WorkerEvent, turnMessageId: MessageId | null): string {
  if (event === "report" || event === "turn_failed" || event === "user_message") {
    if (turnMessageId === null) throw new Error(`workerMessageDedupeKey: ${event} needs the turn's message id`);
    return `worker:${workerId}:${event}:${turnMessageId}`;
  }
  return `worker:${workerId}:${event}`;
}

/**
 * 规整项目名、项目经理名：去掉首尾空白；空的、超过 MAX_NAME_CHARS 个字符的返回 null；
 * 带控制字符的也返回 null：C0（含换行）、DEL、C1（U+0080～U+009F，含 U+0085 换行）、行分隔符 U+2028、段分隔符 U+2029
 * （名字会进提示词、日志、hub 的输出，这些字符会把一行拆开）。
 * 界面服务、agent 接口校验请求体用它判断，账本存之前再用它规整一遍（存的是规整后的）。
 */
export function normalizeName(raw: string, maxChars: number = MAX_NAME_CHARS): string | null {
  const name = raw.trim();
  if (name === "" || [...name].length > maxChars) return null;
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)) return null;
  return name;
}

/**
 * Worker 的标题（hub worker start --title）：去首尾空白；空的、带控制字符（同 normalizeName）的返回 null；
 * 超过 MAX_WORKER_TITLE_CHARS 个字符不报错，用 truncateChars 截断。
 */
export function normalizeWorkerTitle(raw: string): string | null {
  const title = raw.trim();
  if (title === "") return null;
  return normalizeName(truncateChars(title, MAX_WORKER_TITLE_CHARS), MAX_WORKER_TITLE_CHARS);
}

/** 按 Unicode 字符截断：超过 maxChars 个字符就留前 maxChars - 1 个，末尾加“…”（结果正好 maxChars 个字符）。 */
export function truncateChars(text: string, maxChars: number): string {
  const chars = [...text];
  return chars.length <= maxChars ? text : `${chars.slice(0, maxChars - 1).join("")}…`;
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

/**
 * 照抄 Claude 的 rate_limit_event.rate_limit_info。是不是“等额度”一律用 isQuotaExhausted 判断：
 * 只有 status 是 "rejected" 算；"allowed_warning" 只是快到了，照常干活，不算等额度。
 */
export interface RateLimitInfo {
  status: string;
  resetsAt: number | null;
  /** 键如 "five_hour"、"seven_day"。 */
  windows: Record<string, RateLimitWindow>;
}

/**
 * 照抄 Claude 的 system/api_retry（断网、服务过载时它自己在重试）：attempt、max_retries、error_status、error 原样，
 * retry_delay_ms 驱动层按收到的时间换成 retryAt（Unix 毫秒），网页好直接倒计时。
 * errorStatus 是 HTTP 状态码，断网时没有（null）；error 是 Claude 给的错误类别，如 "unknown"、"overloaded"。
 * 只在内存里，不入库；收到下一个正常事件（agent 输出、工具调用、一轮结束）就清掉。
 */
export interface ApiRetryInfo {
  attempt: number;
  maxRetries: number;
  retryAt: number | null;
  errorStatus: number | null;
  error: string;
}

export const RATE_LIMIT_ALLOWED = "allowed";
/** 额度用完了。Claude 的 status 有 "allowed"、"allowed_warning"（快到了，照常干活）、"rejected"。 */
export const RATE_LIMIT_REJECTED = "rejected";

/**
 * 额度是不是用完了：只有 rejected 算。发消息的处理函数（等额度）和网页（状态行显示“等额度”）都用它，
 * 免得两边判断不一样（m2-plan 第 7 节第 2 条）。
 * 传了 nowMs（毫秒）的，info.resetsAt 已经到了或过了就不算：rejected 是重置前记下的，Claude 要等下一条事件才会改它。
 */
export function isQuotaExhausted(info: RateLimitInfo | null | undefined, nowMs?: number): boolean {
  if (info?.status !== RATE_LIMIT_REJECTED) return false;
  return nowMs === undefined || info.resetsAt === null || info.resetsAt * 1000 > nowMs;
}

/**
 * 会话。项目经理的会话（role = pm）：conversationId 是项目经理的那个对话。
 * Worker 的会话（role = worker，M3）：conversationId 是 Worker 的对话，workerId 是它的 WorkerRecord，pmId 是 null；
 * cwd 是 worktree（不带附加文件夹）或主文件夹（addDirs 和项目经理的一样）。
 * - 还没有项目：cwd 是 pm-home/<编号>/（它自己的空目录），addDirs 空；
 * - 有项目：cwd 是主文件夹的真实路径，addDirs 是其他没移除的文件夹。建项目、挂和移除文件夹时账本改这两列，
 *   驱动层在下一条消息前按新的值 --resume 重启（--resume 换了工作目录也接得上，m0-report 实验 2）。
 * 发消息一律找这个对话 generation 最大的那个会话。项目经理在资料页点“开新会话”时加一（见 ledger/handover.ts）。
 */
/**
 * 一个会话累计用了多少 token（驱动层从 claude 每轮的 result.usage 累加，老数据没有就是全 0），加上当前上下文的大小。
 * context：最近一次请求的 input + 缓存读 + 缓存写（取最近一条 assistant 消息的 usage，子 agent 的不算）。
 */
export interface TokenUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  context: number;
}

export const EMPTY_TOKEN_USAGE: Readonly<TokenUsage> = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, context: 0 };

export interface AgentSessionRow {
  id: SessionId;
  role: AgentRole;
  conversationId: ConversationId | null;
  /**
   * 这个会话属于哪个项目经理（M2 起）。项目经理的会话一定有，提示词、hub 认人都按它。
   * 总助、Worker 的会话是 null。M1 留下的会话迁移时按对话补上。
   */
  pmId: PmId | null;
  /** Worker 的会话：Worker 编号；其他 null。 */
  workerId: WorkerId | null;
  vendor: string;
  /** 我们预先生成的 UUID，第一次用 --session-id，之后一律 --resume。 */
  vendorSessionId: string;
  cwd: string;
  addDirs: string[];
  /** 开新会话加一；和会话 ID 一起做“启动或恢复会话”动作的去重键。 */
  generation: number;
  /** 模型、思考程度：null = 默认（不传参数）。项目经理的会话跟着资料页改，变了下一条消息前 --resume 重启。 */
  model: string | null;
  effort: string | null;
  pid: number | null;
  status: SessionStatus;
  /** 是否跑完过一轮：决定下次用 --session-id 还是 --resume。 */
  hasCompletedTurn: boolean;
  lastEventAt: number | null;
  rateLimit: RateLimitInfo | null;
  usage: TokenUsage;
  createdAt: number;
  updatedAt: number;
}

/**
 * 空闲 / 在干活 / 正在停 / 准备中（Worker 的会话还没起，系统在它的 worktree 里跑项目的准备命令，跑完才开工；
 * 能停，停了只停准备命令，Worker 照常开工）。
 */
export type SessionActivity = "idle" | "working" | "stopping" | "preparing";

/**
 * 网页要显示的会话状态（状态行、停止按钮、等额度）。WebSocket 的 session.status、session.created 推的就是它。
 * 网页和账本凡是要“这个对话的当前会话”的地方（状态行、停止按钮、等额度、发消息、requestStop），一律取这个对话里
 * generation 最大的那一个，不按 sessionId 大小、不按推送先后。
 */
export interface SessionState {
  sessionId: SessionId;
  conversationId: ConversationId | null;
  /** 同 AgentSessionRow.pmId。总助、Worker 的会话是 null。 */
  pmId: PmId | null;
  /** 同 AgentSessionRow.generation。 */
  generation: number;
  status: SessionStatus;
  activity: SessionActivity;
  /** 正在用的工具名，状态行显示“正在做什么”；没有就是 null。 */
  currentTool: string | null;
  rateLimit: RateLimitInfo | null;
  /** 正在因为网络出错重试；没有（或老服务端没带这个字段）就是 null / undefined，网页照常显示。 */
  apiRetry?: ApiRetryInfo | null;
  /** 累计用量；老服务端没带这个字段就是 undefined，网页当 0。 */
  usage?: TokenUsage;
  /** 这个会话的厂商、模型、思考程度（同 AgentSessionRow，model、effort 是 null = 默认）；老服务端没带就是 undefined。Worker 面板显示。 */
  vendor?: string;
  model?: string | null;
  effort?: string | null;
  lastEventAt: number | null;
}

/** 各模块各写自己那一行；连续失败 3 次在界面标红。每次改动推一条 health.updated。 */
export const HEALTH_MODULES = ["store", "actions", "driver", "ui-server", "agent-api"] as const;
export type HealthModule = (typeof HEALTH_MODULES)[number];

export interface HealthEntry {
  module: HealthModule;
  consecutiveFailures: number;
  /** 最近一次的错误，界面直接显示；驱动层的错误以错误码开头（如“claude_not_found: …”）。成功一次就清空。 */
  lastError: string | null;
  updatedAt: number;
}
