// 前后端、各块共用的数据形状。字段名和 migrations/ 里的列一一对应（驼峰 ↔ 下划线），例外在字段注释里写明。
// 不用 enum（erasableSyntaxOnly）：取值用 `as const` 数组，类型从数组推出来。

import {
  ASK_MAX_OPTION_CHARS,
  ASK_MAX_OPTIONS,
  ASK_MIN_OPTIONS,
  MAX_NAME_CHARS,
  MAX_PM_MEMORY_FILE_NAME_CHARS,
  MAX_WORKER_TITLE_CHARS,
  PM_MEMORY_INDEX_FILE,
} from "./limits.ts";
import type { ScheduleId } from "./schedule.ts";
import type { AgentVendor } from "./vendors.ts";
import type { WorkerReportStatus } from "./worker.ts";

export type PmId = number;
export type ConversationId = number;
export type MessageId = number;
/** agent_sessions 的行号；Claude 那边的会话 ID 是 AgentSessionRow.vendorSessionId。 */
export type SessionId = number;
export type ActionId = number;
export type ProjectId = number;
type ProjectFolderId = number;
export type PersonaChangeId = number;
export type WorkerId = number;
export type RouterItemId = number;
export type RouterCommandId = number;
export type TaskGraphId = number;
export type TaskNodeKey = string;

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
 * 排队中 / 已送达 / 处理中 / 已回复 / 已停止 / 失败 / 已取消。用户发的消息、要发给 agent 的系统消息（M2）有状态，
 * agent 的消息和只给人看的系统消息是 null。网页只给用户的消息显示投递状态。
 * 排队中只指还在我们自己（驱动层）的待发队列里；一轮中途写给 agent、它还没取走的是已送达（docs/mid-turn-messages.md）。
 */
export const MESSAGE_STATUSES = ["queued", "delivered", "processing", "replied", "stopped", "failed", "cancelled"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/**
 * 合法的状态转换：queued → delivered → processing → replied / stopped / failed。
 * - 还没到 processing 也可能直接 failed（起不来、写入校验没过）或 stopped（写进去了、还没回显就被打断）；
 * - replied、stopped 是终点；只有 failed 能往回走：
 *   - failed → queued：用户点“重试”（ledger.retryMessage，M2）。账本在同一个事务里把状态改回 queued、清空 failureReason、
 *     重新登记 session.send，推一条 message.updated；之后照 queued → delivered → … 正常走；
 *   - failed → delivered：重启后重发、或执行器自己重试时写进去了（M1 就有）。
 * - queued → stopped（M3）：Worker 收工时还没发给它的话（比如 worktree 还没建好就收工了的任务说明），不会再发了。
 * - queued、delivered → cancelled：用户点了停止时 agent 还没看到的用户消息（还在排队的，或一轮中途写给 agent、它还没取走的，
 *   driver.ts 的 message.cancelled）。agent 没看到过，不自动重发；cancelled 是终点。
 * - delivered → queued：一轮中途写给 agent、它还没取走，进程就没了或这一轮没读它就结束了（driver.ts 的 message.requeued）：
 *   账本放回排队中、重新登记 session.send。
 * 账本只按这张表改状态；不合法的转换（包括同状态）一律忽略，不报错——
 * 比如重启后重发一条 processing 的消息，驱动层再出 message.delivered，它仍然是 processing。
 */
const MESSAGE_STATUS_TRANSITIONS: Readonly<Record<MessageStatus, readonly MessageStatus[]>> = {
  queued: ["delivered", "failed", "stopped", "cancelled"],
  delivered: ["processing", "stopped", "failed", "cancelled", "queued"],
  processing: ["replied", "stopped", "failed"],
  replied: [],
  stopped: [],
  failed: ["queued", "delivered"],
  cancelled: [],
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

const AGENT_ROLES = ["assistant", "pm", "worker"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];
/** 能起会话的两种角色（daemon/launch.ts 按它生成启动文件）。 */
export type SessionRole = Extract<AgentRole, "pm" | "worker">;

/** 空闲 / 运行中 / 已结束 / 坏了。 */
const SESSION_STATUSES = ["idle", "running", "ended", "broken"] as const;
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
  /** 归档时间（毫秒时间戳）；未归档是 null。归档满 7 天后守护进程自动删除该 PM 全部数据。 */
  archivedAt?: number | null;
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
  /** Worker 的对话：收工满 WORKER_RETENTION_DAYS 天后消息和步骤日志被清掉的时间；没清过没有这一项。 */
  purgedAt?: number;
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
  /** --readonly：Worker 只看不改（统一定义在 readonly-policy.ts，经 LaunchFiles.readonly 交给各家驱动）。打回、重启都沿用。 */
  readonly: boolean;
  workspace: WorkerWorkspace;
  /** worktree：hub/<编号>-<短名>（worker.ts 的 workerBranchName），派活时就定好；main：null。 */
  branch: string | null;
  /** worktree：<数据目录>/worktrees/<项目编号>/<编号>（paths.ts 的 workerWorktreePath），派活时就定好；main：null。 */
  worktreePath: string | null;
  /** worktree：建 worktree 时 HEAD 的提交，建好之前是 null；main：null。 */
  baseCommit: string | null;
  /**
   * 换人接手同一步（hub worker start --node）时接着用的是哪个前任的 worktree 和分支：这时 branch、worktreePath、baseCommit 都是前任的，
   * 目录名是前任的编号。自己新建 worktree 或在主文件夹里干的没有这一项。
   */
  takeoverOf?: WorkerId;
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
 * folder.attached / detached → folderId；persona.changed → personaChangeId；schedule.created / removed → scheduleId；
 * schedule.run → <scheduleId>:<原定时间>；schedule.failed → 失败的那条消息的编号；context.compacted → <会话>:<事件 uuid>。
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
        return meta.handoverId !== undefined ? `h${meta.handoverId}` : `${meta.messageId}.${meta.attempt}`;
      case "schedule.created":
      case "schedule.removed":
        return meta.scheduleId;
      case "schedule.run":
        return `${meta.scheduleId}:${meta.scheduledAt}`;
      case "schedule.failed":
        return meta.messageId;
      case "driver.warning":
      case "context.compacted":
        return `${meta.sessionId}:${meta.uuid}`;
      case "worker.max_time_exceeded":
        return `${meta.workerId}:${meta.maxTimeMs}`;
      case "task_graph.ready_to_finish":
        return `${meta.graphId}:${meta.seq}`;
    }
  })();
  return `system:${conversationId}:${meta.event}:${ref}`;
}

/**
 * 系统消息的事件（Message.meta.event）。会扩展。
 * 11-03 拿掉了 project.reassigned（交接）：老数据里还有，systemEventOf 认不出就当普通系统消息，照样居中显示文字。
 */
export const SYSTEM_EVENTS = [
  "project.created",
  "folder.attached",
  "folder.detached",
  "persona.changed",
  "schedule.created",
  "schedule.removed",
  "schedule.run",
  "schedule.failed",
  "handover.requested",
  "session.renewed",
  "handover.failed",
  "context.compacted",
  "driver.warning",
  "worker.max_time_exceeded",
  "task_graph.ready_to_finish",
] as const;

/**
 * 系统消息的 meta（sender 是 system、kind 是 text）。都发在项目经理的那个对话里，只给人看（status null，文字不带前缀）：
 * - project.created：“项目已建好”；
 * - folder.attached / folder.detached：挂上、移除了文件夹。下一条消息前自动重启生效；不单独给 agent 发【系统】消息
 *   （hub 是它自己调的，白白多跑一轮），重启后驱动层在下一条写进去的消息前面拼 RELAUNCH_NOTE（见 driver.ts）；
 * - persona.changed：改了性格设定（项目经理自己、用户在界面改、撤销、启动时发现文件被手改）。界面上带“撤销”按钮
 *   （personaChangeId；只有最近一条能撤销）。
 * - schedule.created / removed（M6）：项目经理用 hub schedule add / remove 建了、删了定时任务，只给人看；
 * - schedule.run：到点了，这一条要交给项目经理（status 从 queued 起，登记 session.send，source system），text 以
 *   “【定时任务：名字（原定 09:00）】”开头，后面是任务说明；catchUp 是补跑（睡眠、守护进程没开错过的，只补一次）；
 * - schedule.failed：这一轮失败或会话起不来，“定时任务没跑成：名字：原因”，只给人看；messageId 是失败的那条 schedule.run 消息；rawReason 是失败原因原文（正文是人话）。
 * 网页显示时一律过一遍 stripSystemPrefix（老数据里发给过 agent 的带【系统】），不显示投递状态。
 *
 * 开新会话（资料页的按钮，或对话太长时自动换，见 ledger/handover.ts、docs/background-handover-design.md）。用户看来是同一个对话，
 * 聊天里只多一条很淡的分隔线。平常是复制一份项目经理的会话在后台写交接（不发消息）；厂商复制不了时才退回本会话写交接（H）：
 * - handover.requested：本会话写交接时发给旧会话（sessionId，status 从 queued 起照常走，source system），text 是发给 agent 的全文，
 *   让项目经理把交接写成这一轮的回复。网页不显示它，这一轮 agent 的文字、工具调用（meta.handover，见 isHandoverTraffic）也不显示；
 *   auto：系统因为对话太长自动换的（不是用户点的）；
 * - session.renewed：换代那一刻记的一行（sessionId 是新一代，status null，不单独发给 agent），text 是交接全文，handoverId 是 handovers 那一行。
 *   网页显示成分隔线，点开看交接。新会话不另开一轮：换代时定稿的开场说明（交接 + 原话）由驱动层拼在下一条真正写给它的消息前面
 *   （DriverOptions.sessionPreamble）；turnStartId 只有本会话写交接才有：交接那一轮开始时库里最大的消息编号（之后来的消息排在分隔线下面）；
 * - handover.failed：只给人看。用户点的开新会话没写成（没换代）。rawReason 是厂商原文（正文只写人话，原文留着排查）。handoverId 是那一行（老数据是 messageId：那条 H，attempt 是它第几次没成）。
 *   自动换的没写成不提示，按退避再试。
 * - context.compacted：agent 压缩了上下文（用户发了 /compact，或者自动压缩；驱动层的 context.compacted），“已压缩上下文”，
 *   只给人看。发在这个会话所在的对话里（项目经理、Worker 的都有）；uuid 是 claude 那一行事件的，重放不会记两条。
 * H、R 的 meta 里账本还会记几个内部字段（requestedAt、settled、seen 等，见 handover.ts），网页不用。
 */
export type SystemMessageMeta =
  | { event: "driver.warning"; sessionId: SessionId; uuid: string }
  | { event: "project.created"; projectId: ProjectId }
  | { event: "folder.attached"; projectId: ProjectId; folderId: ProjectFolderId; path: string }
  | { event: "folder.detached"; projectId: ProjectId; folderId: ProjectFolderId; path: string }
  | { event: "persona.changed"; pmId: PmId; personaChangeId: PersonaChangeId; revertOf: PersonaChangeId | null }
  | { event: "handover.requested"; sessionId: SessionId; auto?: boolean }
  | { event: "session.renewed"; sessionId: SessionId; fromSessionId: SessionId; turnStartId?: MessageId; auto?: boolean; handoverId?: number }
  | { event: "handover.failed"; messageId?: MessageId; handoverId?: number; attempt: number; rawReason?: string }
  | { event: "schedule.created"; scheduleId: ScheduleId; name: string }
  | { event: "schedule.removed"; scheduleId: ScheduleId; name: string }
  | { event: "schedule.run"; scheduleId: ScheduleId; name: string; scheduledAt: number; catchUp: boolean }
  | { event: "schedule.failed"; scheduleId: ScheduleId; name: string; messageId: MessageId; rawReason?: string }
  | { event: "context.compacted"; sessionId: SessionId; uuid: string; trigger: string | null }
  | { event: "worker.max_time_exceeded"; workerId: WorkerId; workerConversationId: ConversationId; maxTimeMs: number }
  | { event: "task_graph.ready_to_finish"; graphId: TaskGraphId; seq: number; diffProbed?: boolean };

export interface GateRef {
  graphId: TaskGraphId;
  nodeKey: TaskNodeKey;
  /** 标了 `confirm: true` 的步骤在 Worker 汇报“做完了”后由后台自动挂出的检查点拍板卡（「通过 / 打回」）。 */
  checkpoint?: true;
}

export const CONFIRM_PASS_OPTION = "通过";
export const CONFIRM_REJECT_OPTION = "打回";
export const CONFIRM_CHECKPOINT_OPTIONS = [CONFIRM_PASS_OPTION, CONFIRM_REJECT_OPTION] as const;

/**
 * `hub ask`（普通提问、操作提醒、`--node` 步骤拍板卡与 `confirm` 检查点卡）发的那条项目经理消息的 meta：
 * needsUser 是“等你确定”的标记；answered 是用户回答了——普通提问在对话里收到用户消息或 Router 拍板时标上；
 * 带 gateRef 的门禁消息在用户对话闲聊时不会被误标已回答，须经门禁 decide 解锁才标上。
 */
export type AskMeta = {
  needsUser: true;
  answered?: true;
  options?: string[];
  recommended?: string;
  gateRef?: GateRef;
  chosenOption?: string;
};

/** 是 hub ask 发的消息就返回它的 meta，否则 null。 */
export function askOf(message: Pick<Message, "sender" | "meta">): AskMeta | null {
  if (message.sender !== "agent" || message.meta?.needsUser !== true) return null;
  const rawOptions = message.meta.options;
  const options =
    Array.isArray(rawOptions) && rawOptions.length > 0 && rawOptions.every((o): o is string => typeof o === "string")
      ? rawOptions
      : undefined;
  const recommended =
    typeof message.meta.recommended === "string" && message.meta.recommended.trim() !== ""
      ? message.meta.recommended.trim()
      : undefined;
  const answered = message.meta.answered === true || message.meta.dismissed === true;
  const rawGateRef = message.meta.gateRef as Record<string, unknown> | null | undefined;
  const gateRef =
    rawGateRef !== null &&
    typeof rawGateRef === "object" &&
    typeof rawGateRef.graphId === "number" &&
    typeof rawGateRef.nodeKey === "string"
      ? {
          graphId: rawGateRef.graphId,
          nodeKey: rawGateRef.nodeKey,
          ...(rawGateRef.checkpoint === true ? { checkpoint: true as const } : {}),
        }
      : undefined;
  const chosenOption = typeof message.meta.chosenOption === "string" ? message.meta.chosenOption : undefined;
  return {
    needsUser: true,
    ...(answered ? { answered: true } : {}),
    ...(options !== undefined ? { options } : {}),
    ...(recommended !== undefined ? { recommended } : {}),
    ...(gateRef !== undefined ? { gateRef } : {}),
    ...(chosenOption !== undefined ? { chosenOption } : {}),
  };
}

export type AskOptionsValidation = { ok: true; options: string[] } | { ok: false; error: string };

/**
 * 校验并规整 hub ask 的 --option 列表：
 * 至少 ASK_MIN_OPTIONS（2）个、最多 ASK_MAX_OPTIONS（10）个；
 * 每项去首尾空白后非空、不含换行与控制字符、不超过 ASK_MAX_OPTION_CHARS（200）个字符。
 */
export function validateAskOptions(raw: readonly string[]): AskOptionsValidation {
  if (raw.length < ASK_MIN_OPTIONS) {
    return { ok: false, error: `选项至少要给 ${ASK_MIN_OPTIONS} 个` };
  }
  if (raw.length > ASK_MAX_OPTIONS) {
    return { ok: false, error: `选项最多 ${ASK_MAX_OPTIONS} 个` };
  }
  const options: string[] = [];
  for (const item of raw) {
    const normalized = normalizeName(item, ASK_MAX_OPTION_CHARS);
    if (normalized === null) {
      return {
        ok: false,
        error: `选项不能为空、不能含换行或控制字符，且不超过 ${ASK_MAX_OPTION_CHARS} 个字符`,
      };
    }
    options.push(normalized);
  }
  return { ok: true, options };
}

const ASK_LIST_ITEM_RE = /^(?:(?:[-*]|\d+\.)\s+)?([A-Z](?:\.\s+|：|:\s).*)$/;

/** 每项都以顺序字母 A/B/C... 开头才去掉前缀返回选项，否则 null（普通列表不当单选题）。 */
function stripSequentialLetterPrefixes(items: readonly string[]): string[] | null {
  const stripped: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const letter = String.fromCharCode(65 + i);
    const match = new RegExp(`^${letter}(?:\\.\\s+|：\\s*|: \\s*)(.+)$`).exec(items[i]!);
    const rest = match?.[1]?.trim();
    if (!rest) return null;
    stripped.push(rest);
  }
  return stripped;
}

/**
 * 提取 `hub ask` 可点击选项卡片的数据：
 * 1. 先调 `askOf(message)`，若为 null 则返回 null；
 * 2. 若 `ask.options` 存在且长度 ≥ 2：返回 `{ question: message.text.trim(), options: ask.options, answered: ask.answered === true }`；
 * 3. 若未显式传 `options`：开头一段非空问题文本 + 紧接着的 2～10 行单行选项，每行都必须显式以顺序字母
 *    `A. `/`A：`/`A: ` 开头（可带 `- `/`1. ` 列表前缀），后面没有其他正文段落，去掉字母前缀作为选项；
 *    普通 `- xxx`/`1. xxx` 列表（如列出几项配置请用户确认）不是单选题，返回 null，走普通 Markdown 渲染；
 * 4. 其他纯文本提问返回 null。
 */
export interface ExtractedAskCard {
  question: string;
  options: string[];
  answered: boolean;
  recommended?: string;
  chosenOption?: string;
  gateRef?: GateRef;
}

export function extractAskCard(
  message: Pick<Message, "sender" | "meta" | "text">,
): ExtractedAskCard | null {
  const ask = askOf(message);
  if (ask === null) return null;
  const answered = ask.answered === true;
  const extras = {
    ...(ask.recommended !== undefined ? { recommended: ask.recommended } : {}),
    ...(ask.chosenOption !== undefined ? { chosenOption: ask.chosenOption } : {}),
    ...(ask.gateRef !== undefined ? { gateRef: ask.gateRef } : {}),
  };
  if (ask.options !== undefined && ask.options.length >= ASK_MIN_OPTIONS) {
    return { question: message.text.trim(), options: ask.options, answered, ...extras };
  }
  const trimmed = message.text.trim();
  if (trimmed === "") return null;
  const lines = trimmed.split(/\r?\n/);
  const firstListIdx = lines.findIndex((line) => ASK_LIST_ITEM_RE.test(line.trim()));
  if (firstListIdx <= 0) return null;

  let qEnd = firstListIdx;
  while (qEnd > 0 && lines[qEnd - 1]!.trim() === "") {
    qEnd--;
  }
  if (qEnd === 0) return null;
  const questionLines = lines.slice(0, qEnd);
  if (questionLines.some((line) => line.trim() === "")) return null;
  const question = questionLines.join("\n").trim();
  if (question === "") return null;

  const listLines = lines.slice(firstListIdx);
  if (listLines.length < ASK_MIN_OPTIONS || listLines.length > ASK_MAX_OPTIONS) return null;
  const rawItems: string[] = [];
  for (const line of listLines) {
    const match = ASK_LIST_ITEM_RE.exec(line.trim());
    const item = match?.[1]?.trim();
    if (!item || [...item].length > ASK_MAX_OPTION_CHARS) return null;
    rawItems.push(item);
  }
  const options = stripSequentialLetterPrefixes(rawItems);
  if (options === null) return null;
  return { question, options, answered, ...extras };
}

/** 发给 agent 的系统消息的开头（设计第 7.3 节的来源标签）。 */
export const SYSTEM_MESSAGE_PREFIX = "【系统】";

/** 是系统消息、meta.event 认识就返回 meta（不逐个字段校验，账本写的就是这个形状），否则 null。 */
export function systemEventOf(message: Pick<Message, "sender" | "meta">): SystemMessageMeta | null {
  if (message.sender !== "system" || message.meta === null) return null;
  return isOneOf(SYSTEM_EVENTS, message.meta.event) ? (message.meta as SystemMessageMeta) : null;
}

/** 换新会话那条分隔线上的字（状态词用英文，docs/ui-standard.md 第 3、17 条）。 */
export const SESSION_RENEWED_NOTICE = "Handed off to a new session";

/** 网页上系统消息显示的那一句：换新会话显示固定的一句（text 是交接全文、发给 agent 的全文），别的去掉开头的【系统】。 */
export function systemNoticeText(message: Pick<Message, "sender" | "meta" | "text">): string {
  switch (systemEventOf(message)?.event) {
    case "handover.requested":
    case "session.renewed":
      return SESSION_RENEWED_NOTICE;
    default:
      return stripSystemPrefix(message.text);
  }
}

/**
 * 写交接的来往（不给用户看）：交接请求（handover.requested），和写交接那一轮 agent 的文字、工具调用（账本入库时在 meta 里记
 * handover: true，见 ledger/messages.ts）。网页不显示、不算未读、不进左栏预览；交接全文在换代那条分隔线里点开看。
 */
export function isHandoverTraffic(message: Pick<Message, "sender" | "meta">): boolean {
  if (message.sender === "agent") return message.meta?.handover === true;
  return systemEventOf(message)?.event === "handover.requested";
}

/**
 * 静默唤醒项目经理的内部触发消息本身（网页聊天流里只隐藏这条触发消息本身，不隐藏项目经理随后的正常回复！）：
 * - worker.max_time_exceeded：Worker 这一轮超过最大时间仍未结束时发给项目经理的静默唤醒消息；
 * - task_graph.ready_to_finish：任务图全部节点到达终态时发给项目经理的交付单通知。
 */
export function isSilentTriggerMessage(message: Pick<Message, "sender" | "meta">): boolean {
  const ev = systemEventOf(message)?.event;
  return ev === "worker.max_time_exceeded" || ev === "task_graph.ready_to_finish";
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
 * 网页用 worker.ts 的 workerLineText 显示成“Worker「标题」状态：摘要”，点开 workerConversationId。
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
 *   claude 自己开的一轮没有处理的消息，编号用这一轮最后一条 agent 消息的。
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

/**
 * agent 这一刻在做什么：照 claude assistant 消息里 content 块的样子（type、name、input），只留显示要用的几个参数。
 * 只在内存里，不入库；工具结果回来、一轮结束、进程退出时更新或清掉。文案映射在 shared/step-labels.ts。
 */
export type AgentStep =
  | { type: "thinking" }
  | { type: "text" }
  | { type: "tool_use"; name: string; input: AgentStepInput };

/** tool_use 的 input 里状态要用的字段（Skill 的 skill、读写文件的路径、连接器的服务名与动作名等），别的不带。 */
export interface AgentStepInput {
  skill?: string;
  /** 连接器（MCP）服务名：codex mcpToolCall 的 server、agy call_mcp_tool / list_resources 的 ServerName。 */
  server?: string;
  ServerName?: string;
  /** 连接器（MCP）动作名：codex mcpToolCall 的 tool、agy call_mcp_tool 的 ToolName。 */
  tool?: string;
  ToolName?: string;
  file_path?: string;
  notebook_path?: string;
  AbsolutePath?: string;
  TargetFile?: string;
  Path?: string;
  path?: string;
  CommandLine?: string;
  command?: string;
  query?: string;
  SearchPath?: string;
}

/** 额度用完了。Claude 的 status 有 "allowed"、"allowed_warning"（快到了，照常干活）、"rejected"。 */
const RATE_LIMIT_REJECTED = "rejected";

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
 * 标记额度已耗尽（如 Codex 一轮中途最后一次成功响应报 99%，紧接着下一条请求因 usage_limit_exceeded 失败、未再带 100% 响应头）：
 * - 若已有窗口为 rejected 或 utilization >= 1，将其规整为 utilization >= 1 且 status="rejected"；
 * - 否则将当前 utilization 最高（并列时取最早重置）的窗口置为 utilization=1、status="rejected"；
 * - 顶层 status 置为 "rejected"，resetsAt 取所有 rejected 窗口里最晚恢复的时间。
 */
export function exhaustRateLimitInfo(info: RateLimitInfo | null | undefined): RateLimitInfo {
  if (!info) return { status: RATE_LIMIT_REJECTED, resetsAt: null, windows: {} };
  const windows: Record<string, RateLimitWindow> = {};
  for (const [k, w] of Object.entries(info.windows)) {
    if (w && Number.isFinite(w.utilization)) windows[k] = { ...w };
  }
  const entries = Object.entries(windows);
  if (entries.length === 0) {
    return { status: RATE_LIMIT_REJECTED, resetsAt: info.resetsAt, windows: {} };
  }
  const alreadyExhausted = entries.filter(([, w]) => w.status === RATE_LIMIT_REJECTED || w.utilization >= 1);
  if (alreadyExhausted.length > 0) {
    for (const [k, w] of alreadyExhausted) {
      windows[k] = { ...w, utilization: Math.max(1, w.utilization), status: RATE_LIMIT_REJECTED };
    }
  } else {
    let bestKey = entries[0]![0];
    let bestWin = entries[0]![1];
    for (const [k, w] of entries.slice(1)) {
      if (w.utilization > bestWin.utilization || (w.utilization === bestWin.utilization && w.resetsAt < bestWin.resetsAt)) {
        bestKey = k;
        bestWin = w;
      }
    }
    windows[bestKey] = { ...bestWin, utilization: 1, status: RATE_LIMIT_REJECTED };
  }
  const rejected = Object.values(windows).filter((w) => w.status === RATE_LIMIT_REJECTED);
  return {
    status: RATE_LIMIT_REJECTED,
    resetsAt: rejected.length > 0 ? Math.max(...rejected.map((w) => w.resetsAt)) : info.resetsAt,
    windows,
  };
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
 * 一个会话累计用了多少 token（驱动层每条 assistant 消息（按 message.id 去重）实时累加、最多每秒推一次，一轮结束用 result.usage 校正；老数据没有就是全 0），加上当前上下文的大小。
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
  /**
   * agent 已经看到的性格设定、模式是哪一版（persona_changes 的编号，驱动层写，见 driver.ts 的“两轮之间自动重启”）。
   * null / 不给：没记过（Worker、还没起过进程、0012 之前的老会话）。
   */
  personaRevision?: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * 空闲 / 在干活 / 正在停 / 准备中（Worker 的会话还没起，系统在它的 worktree 里跑项目的准备命令，跑完才开工；
 * 能停，停了只停准备命令，Worker 照常开工）/ 在等后台命令（Worker 一轮结束时还有放到后台的命令在跑，这一轮先不汇报，
 * 命令跑完它被叫醒接着做；能停，停了后台命令一起停；用户、项目经理的话照常能发，见 ledger/workers.ts）。
 */
export type SessionActivity = "idle" | "working" | "stopping" | "preparing" | "background";

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
  /** 在做什么（思考、写回复、哪个工具）；没有（空闲，或老服务端没带这个字段）就是 null / undefined，网页只显示“在处理”。 */
  step?: AgentStep | null;
  /** 当前正在流式生成、尚未落库的这一段文字（内存态，上限 MAX_STREAMING_TEXT_CHARS）；不在流式生成文字时不传或为 null。 */
  streamingText?: string | null;
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

// ---- 持久化任务图（Task DAG，docs/task-graph-design.md §3.1）----

export const TASK_GRAPH_STATUSES = ["active", "completed", "cancelled"] as const;
export type TaskGraphStatus = (typeof TASK_GRAPH_STATUSES)[number];

/**
 * 步骤的四个状态（docs/orchestration-simplify-design.md 第 3.1 节）：没轮到、在干、等人、完了。
 * “等谁”（waitingFor）和“是不是跳过的”（skipped）是状态上的附带信息，不是新状态。节点类型只剩一种（步骤）。
 */
export const TASK_NODE_STATUSES = ["pending", "running", "waiting", "done"] as const;
export type TaskNodeStatus = (typeof TASK_NODE_STATUSES)[number];

/** 等人的步骤在等谁：user 有拍板卡等用户点，pm 等项目经理处理（派人、换人、放行、改图）。 */
export const TASK_NODE_WAITING_FOR = ["user", "pm"] as const;
export type TaskNodeWaitingFor = (typeof TASK_NODE_WAITING_FOR)[number];

/** 一个步骤的完整状态：status 加两项附带信息。 */
export interface TaskNodeState {
  status: TaskNodeStatus;
  /** 只在 status 是 waiting 时有，其余是 null。 */
  waitingFor: TaskNodeWaitingFor | null;
  /** 只在 status 是 done 时可能为真。 */
  skipped: boolean;
}

/**
 * 旧的 7 个状态到新状态（第 3.4 节那张表，全量）。迁移 0025 用 SQL 写了同一张表（测试逐行对照）；
 * 多台设备版本不一致时网页可能收到旧值，网页读入时也用它（web/task-graph-compat.ts）。认不出的值当等项目经理。
 */
export function taskNodeStateFromLegacy(status: string): TaskNodeState {
  switch (status) {
    case "pending":
      return { status: "pending", waitingFor: null, skipped: false };
    case "running":
      return { status: "running", waitingFor: null, skipped: false };
    case "done":
      return { status: "done", waitingFor: null, skipped: false };
    case "skipped":
      return { status: "done", waitingFor: null, skipped: true };
    case "waiting_user":
      return { status: "waiting", waitingFor: "user", skipped: false };
    default:
      // ready、attention，以及认不出的值
      return { status: "waiting", waitingFor: "pm", skipped: false };
  }
}

/**
 * 步骤状态的中文说法：hub graph show 等给项目经理看的文字用 viewer = "pm"，网页给用户看的用 viewer = "user"
 * （等人时说清等谁：给项目经理看是“等你处理”，给用户看是“等你拍板”）。
 */
export function taskNodeStatusText(node: Pick<TaskNode, "status" | "waitingFor" | "skipped">, viewer: "pm" | "user"): string {
  switch (node.status) {
    case "pending":
      return "没轮到";
    case "running":
      return "在干";
    case "waiting":
      if (node.waitingFor === "user") return viewer === "user" ? "等你拍板" : "等用户拍板";
      return viewer === "user" ? "等项目经理" : "等你处理";
    case "done":
      return node.skipped ? "跳过" : "完了";
  }
}

/** 等用户拍板的步骤（挂着拍板卡）。 */
export function isTaskNodeWaitingUser(node: Pick<TaskNode, "status" | "waitingFor">): boolean {
  return node.status === "waiting" && node.waitingFor === "user";
}

/** 等项目经理处理的步骤。 */
export function isTaskNodeWaitingPm(node: Pick<TaskNode, "status" | "waitingFor">): boolean {
  return node.status === "waiting" && node.waitingFor === "pm";
}

export interface TaskArtifact {
  prUrl?: string;
  commit?: string;
  branch?: string;
  summary?: string;
}

export interface TaskDecision {
  choice: string | null;
  note: string | null;
  decidedBy: "user" | "pm";
  decidedAt: number;
  clientId?: string;
}

export interface TaskEdge {
  fromKey: TaskNodeKey;
  toKey: TaskNodeKey;
}

export interface TaskNode {
  key: TaskNodeKey;
  title: string;
  /** 步骤职责（仅单图详情按需带出，全量快照不带正文以控体积）。 */
  brief?: string | null;
  vendor?: string | null;
  model?: string | null;
  effort?: string | null;
  readonly?: boolean;
  maxTimeMs?: number | null;
  confirm?: boolean;
  review?: boolean;
  base?: "main" | null;
  status: TaskNodeStatus;
  /** 等谁：只在 status 是 waiting 时有。 */
  waitingFor: TaskNodeWaitingFor | null;
  /** 是不是跳过的：只在 status 是 done 时可能为真。 */
  skipped: boolean;
  sortOrder: number;
  activeWorkerId: WorkerId | null;
  workerIds: WorkerId[];
  artifact: TaskArtifact | null;
  gateQuestion: string | null;
  gateOptions: string[];
  gateSummaryMd: string | null;
  gateRecommended: string | null;
  gateAskMessageId: MessageId | null;
  /** 当前挂着等用户拍板的卡是否是 `confirm: true` 步骤自动生成的检查点卡（「通过 / 打回」）。 */
  gateCheckpoint?: boolean;
  decision: TaskDecision | null;
  createdAt: number;
  updatedAt: number;
}

export interface TaskGraph {
  id: TaskGraphId;
  projectId: ProjectId;
  pmId: PmId;
  conversationId: ConversationId;
  title: string;
  /** 整张图目标（仅单图详情按需带出，全量快照不带正文以控体积）。 */
  goal?: string | null;
  status: TaskGraphStatus;
  originMsgId: MessageId | null;
  nodes: TaskNode[];
  edges: TaskEdge[];
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

/** 图仍为 active 且所有步骤都完了（跳过也算完了）：派生为“待交付（Ready to finish）”，不入库。 */
export function isTaskGraphReadyToFinish(graph: Pick<TaskGraph, "status" | "nodes">): boolean {
  return graph.status === "active" && graph.nodes.length > 0 && graph.nodes.every((n) => n.status === "done");
}

// ---- 项目经理专属记忆目录子文件（state/pm-memory/<pmId>/<topic>.md）----

export interface PmMemoryFileSummary {
  name: string;
  bytes: number;
  updatedAt: number;
}

export interface PmMemoryFileDetail extends PmMemoryFileSummary {
  content: string;
}

export interface PmMemoryFilesList {
  files: PmMemoryFileSummary[];
  totalBytes: number;
}

/**
 * MEMORY.md 按“行”计数（自动加载的 200 行上限用）：末尾单个换行不算多出一行空行，
 * 免得恰好 200 行、按惯例以换行结尾的文件被误判超限。空串是 0 行。
 */
export function pmMemoryLineCount(text: string): number {
  if (text === "") return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

/**
 * 校验项目经理按需参考子文件名（仅放行扁平 `<topic>.md`，拦截路径穿越、点文件、非小写 `.md` 与主索引 `MEMORY.md`）。
 * 合法返回 null，不合法返回可直接展示的原因文案。
 */
export function checkPmMemoryFileName(raw: string): string | null {
  if (raw.trim() === "") return "Enter a file name ending in .md";
  if (raw !== raw.trim()) return "File name can't start or end with spaces";
  if ([...raw].length > MAX_PM_MEMORY_FILE_NAME_CHARS) {
    return `File name must be ${MAX_PM_MEMORY_FILE_NAME_CHARS} characters or fewer`;
  }
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029/\\:]/.test(raw)) {
    return "Use a flat file name without slashes or control characters";
  }
  if (raw.includes("..")) return "File name can't contain ..";
  if (raw.startsWith(".")) return "File name can't start with a dot";
  if (!raw.endsWith(".md") || raw.length <= 3) return "File name must end in .md";
  if (raw.toLowerCase() === PM_MEMORY_INDEX_FILE.toLowerCase()) {
    return `${PM_MEMORY_INDEX_FILE} is managed in Persona above`;
  }
  return null;
}
