// 账本（W1 实现）对界面服务、agent 接口、执行器、驱动层和组装代码开放的接口。
// 数据库是同步接口，账本方法也都是同步的；调用方想 await 也行。
// 这里只从 hub.ts 引类型（hub.ts 从这里引常量），没有运行时的循环引用。
import type { Change, MessagesPage, StateSnapshot } from "./api.ts";
import type { Attachment } from "./attachments.ts";
import type { DriverEvent } from "./driver.ts";
import type { AnyActionRow } from "./actions.ts";
import type {
  AgentRole,
  Conversation,
  ConversationId,
  HealthModule,
  Message,
  MessageId,
  PersonaChange,
  PersonaChangeId,
  Pm,
  PmId,
  PmMode,
  Project,
  SessionId,
  WorkerRecord,
  WorkerId,
  WorkerStatus,
  Unsubscribe,
} from "./domain.ts";
import type { HubArgs, HubCommand, HubResult, ProjectCard, WorkerPr } from "./hub.ts";
import type { ScheduleId, ScheduleRecord } from "./schedule.ts";
import type { AgentVendor } from "./vendors.ts";

/**
 * 账本拒绝一个请求的原因（M2 起的新方法都用它）：
 * - invalid：参数不对（名字空、文件夹不存在、主文件夹不能移除……）；
 * - not_found：要找的东西没有（项目、项目经理、消息、修改记录）；
 * - forbidden：管不着（不是项目经理的会话、改别人的性格设定）；
 * - conflict：和现在的状态冲突（重名、已经有项目了、不是最近一次修改、消息不是失败状态）。
 * message 是给人看的一句中文，agent 也看得懂，界面和 hub 原样显示。
 */
export const LEDGER_ERROR_CODES = ["invalid", "not_found", "forbidden", "conflict"] as const;
export type LedgerErrorCode = (typeof LEDGER_ERROR_CODES)[number];

/** 界面服务和 agent 接口都这样映射。 */
export const LEDGER_ERROR_HTTP_STATUS: Readonly<Record<LedgerErrorCode, number>> = {
  invalid: 400,
  not_found: 404,
  forbidden: 403,
  conflict: 409,
};

export class LedgerRequestError extends Error {
  readonly code: LedgerErrorCode;
  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = "LedgerRequestError";
    this.code = code;
  }
}

/** postUserMessage、requestStop 遇到对话不存在时抛它；界面服务映射成 404。M2 的新方法改用 LedgerRequestError("not_found")。 */
export class ConversationNotFoundError extends Error {
  readonly code = "conversation_not_found";
  readonly conversationId: ConversationId;
  constructor(conversationId: ConversationId) {
    super(`conversation ${conversationId} not found`);
    this.name = "ConversationNotFoundError";
    this.conversationId = conversationId;
  }
}

/** Ledger.composerTarget 的结果。 */
export interface ComposerTarget {
  sessionId: SessionId;
  /** 会话那一行的 vendor（shared/vendors.ts 的厂商编号）。 */
  vendor: string;
  cwd: string;
  addDirs: string[];
  /** “@”在哪些文件夹里搜，第一个是工作目录（插相对路径），别的插绝对路径。不含项目经理带着的 worktrees 目录。 */
  fileRoots: string[];
}

export interface PostUserMessageInput {
  conversationId: ConversationId;
  /** 网页生成；同一个对话里同一个 clientId 只会有一条消息、一个动作（去重键见 userMessageDedupeKey）。 */
  clientId: string;
  /** 用户写的原文；有附件时可以是空的。 */
  text: string;
  /** 已经验过、磁盘上确实有的附件（界面服务查的）；写进消息的 meta（UserMessageMeta），发给 agent 时拼进正文（agentTextOf）。 */
  attachments?: Attachment[];
}

export interface PostUserMessageResult {
  messageId: MessageId;
}

/**
 * 补齐结果。since 就是网页最后收到的 seq（拿的是 /api/state 的 seq 或最后一条变化的 seq）。
 * 下面任何一条成立就 resync，否则返回 since 之后的全部变化（可能是空的）：
 * - since 小于本次启动的初始 seq（上次运行留下的，或者乱填的）；
 * - since 大于当前 seq；
 * - since 小于缓冲区里最早一条的 seq 减 1（中间有变化已经被挤出缓冲区，补不齐）。
 * 本次启动的初始 seq 要比上次运行用过的都大（比如取启动时刻的毫秒时间戳），
 * 这样带着旧 seq 重连的网页一定走第一条。
 */
export type ChangesSince = { kind: "ok"; changes: Change[] } | { kind: "resync" };

/**
 * 谁发起的：界面上的用户，或者某个会话（hub）。hubCall 内部按 session 走；界面服务一律传 { kind: "user" }。
 */
export type LedgerActor = { kind: "user" } | { kind: "session"; sessionId: SessionId };

/**
 * 新建项目经理（界面的表单、第一次启动）。pm-home/、personas/ 的位置是账本的构造参数，不在这里。
 * name 用 normalizeName 规整；persona 不超过 MAX_PERSONA_BYTES；defaultModel 空串当没给。
 * vendor、defaultModel、effort 按厂商清单（vendors.ts 的 checkAgentSetting）校验，不给 = Claude Code、默认、默认。
 * folder：主文件夹（用户填的路径，可以带 ~），给了就在同一个事务里给它建项目（同 hub project create），不给就没有项目。
 */
export interface CreatePmInput {
  name: string;
  mode: PmMode;
  vendor?: AgentVendor;
  defaultModel?: string | null;
  effort?: string | null;
  persona: string;
  folder?: string;
}

/**
 * 同一个事务里：pms 一行（persona 存正文）、它唯一的对话（kind pm）、对话的会话（pm_id 是它，cwd 是 pm-home/<编号>/，
 * 账本负责建这个目录）；给了 folder 的再建项目（见 hub project create：会话的 cwd 换成主文件夹，对话里一条“项目已建好”）。
 * 提交后写 personas/pm-<编号>.md，推 pm.created、conversation.created、session.created（有项目再加 project.created、
 * folders.updated、message.created）。不记 persona_changes（建的时候不算修改）。
 * 错误：名字不对、正文太长、文件夹不对 → invalid；项目经理同名 → conflict。
 * 文件夹已是别的项目经理的主文件夹也照样建（同一个文件夹可以有多个项目经理，各管各的项目）。任何错误都什么也不写。
 */
export interface CreatePmResult {
  pm: Pm;
  conversation: Conversation;
  sessionId: SessionId;
  /** 给了 folder 才有。 */
  project: Project | null;
}

/**
 * 把用户或 agent 给的路径变成真实路径：展开开头的 ~、realpath、必须是已有目录、不能在数据目录（~/.agent-hub）里面。
 * 不对就抛 LedgerRequestError("invalid", 原因)。W1 给默认实现，作为账本的构造参数注入，测试换假的。
 * 默认实现用 fs.realpathSync.native（走系统的 realpath(3)：macOS 上大小写不敏感的盘会给出磁盘上真实的大小写，
 * /tmp、/var 解析成 /private/...），数据目录也按同样的方法 realpath 之后再比。
 */
export type ResolveFolder = (path: string) => string;

/** 资料页、hub persona show 看到的性格设定。 */
export interface PersonaView {
  pmId: PmId;
  /** 正文，以数据库 pms.persona 为准；是 NULL 时当空串。 */
  text: string;
  mode: PmMode;
  /** 厂商、模型、思考程度（资料页的 Agent 一栏），同 Pm 的 vendor、defaultModel、effort。 */
  vendor: AgentVendor;
  model: string | null;
  effort: string | null;
  /** 修改记录，新的在前，最多 PERSONA_CHANGES_LIMIT 条。 */
  changes: PersonaChange[];
  /** 能撤销的那一条（最近一条）的编号；没有修改记录是 null。 */
  revertableChangeId: PersonaChangeId | null;
}

/**
 * text、mode、vendor、model、effort 至少给一个；text 是新的完整正文，不超过 MAX_PERSONA_BYTES；reason 不超过 MAX_REASON_CHARS。
 * vendor、model、effort（资料页的 Agent 一栏）按厂商清单校验，model、effort 给 null 是改回默认；只有界面上的用户能改
 * （项目经理用 hub persona edit 带这几样 → forbidden）。改了之后这个项目经理的会话（agent_sessions.model、effort）跟着改，
 * 驱动层在下一条消息前按新参数 --resume 重启。换厂商要开新会话，现在只有一家，不会发生。
 */
export interface EditPersonaInput {
  text?: string;
  mode?: PmMode;
  vendor?: AgentVendor;
  model?: string | null;
  effort?: string | null;
  reason?: string;
}

/**
 * 改性格设定、撤销的结果。change 为 null：正文和模式都和现在一样，什么也没写、没推。
 * 改了的话，同一个事务里：pms.persona、pms.mode、persona_changes 一行、一条 persona.changed 系统消息（发在哪见 domain.ts 的
 * SystemMessageMeta）；推 pm.updated、message.created。
 * 提交后写 personas/pm-<编号>.md（临时文件 + 改名），写成功了再把 pms.persona_file_hash 设成这份内容的哈希。
 * 写文件失败不影响结果（数据库已提交），persona_file_hash 不更新；下次启动 syncPersonaFiles 看到文件哈希仍等于
 * persona_file_hash，知道文件没人动过、只是没写成，按数据库重写（不会误记成用户手改，见 syncPersonaFiles 第 3 条）。
 * 这个项目经理的所有会话在下一条消息前自动重启（驱动层比 fingerprint，账本不用管）。
 */
export interface EditPersonaResult {
  change: PersonaChange | null;
  persona: PersonaView;
}

/** 启动时 syncPersonaFiles 的结果。 */
export interface SyncPersonaFilesResult {
  /** 用户手改过文件、按文件记了一条 actor: "file" 修改的项目经理。 */
  recordedPmIds: PmId[];
  /** 按数据库重写了文件的项目经理（文件不存在、读不了，或上次写文件失败了）。 */
  rewrittenPmIds: PmId[];
}

/**
 * 给生成提示词和设置文件用（驱动层的 prepareLaunch 里调）。只读。
 * - 项目经理的会话（role pm）：pm 是这个会话所属的项目经理（AgentSessionRow.pmId）；pm.persona 是 pms.persona（NULL 时当空串）。
 *   project 是它的项目（文件夹按现在的），还没有是 null。worker 是 null；
 * - Worker 的会话（role worker，M3）：worker 是它的记录（标题、任务、只读、在哪干活、分支）；pm 是派它的项目经理
 *   （Worker 的提示词不放性格设定，W3 只用名字）；project 是 Worker 所在的项目，不会是 null；conversationId 是 Worker 自己的对话。
 * 错误：会话不存在、不是项目经理或 Worker 的会话 → not_found。
 *
 * worktree 目录（M3）：有项目的项目经理，会话的 addDirs 里有 <数据目录>/worktrees/<项目编号>/（paths.ts 的 projectWorktreesDir，
 * 根目录是账本的构造参数 LedgerOptions.worktreesDir），验收时能看 Worker 的改动。这一层目录由 W3 的启动准备（launch.ts）
 * 在启动前 mkdir -p（还没派过 Worker 时它不存在，claude 的 --add-dir 要求目录在）；账本、驱动层都不建。
 * 每个 Worker 自己那一层由 git worktree add 建（worktree.create）。
 */
export interface LaunchContext {
  sessionId: SessionId;
  role: AgentRole;
  conversationId: ConversationId;
  pm: { id: PmId; name: string; mode: PmMode; vendor?: AgentVendor; persona: string };
  project: ProjectCard | null;
  worker: WorkerRecord | null;
}

/**
 * worktree.create 处理函数要建什么（见 actions.ts 的 WorktreeCreateParams）。
 * repo 是项目主文件夹的真实路径；branch、worktreePath 抄自 WorkerRecord。
 * setupCommand：项目现在的准备命令（hub project setup），没配是 null；建好 worktree 后在里面跑完它 Worker 再开工。
 */
export interface WorktreeTask {
  workerId: WorkerId;
  /** Worker 的会话：网页、hub worker list 上的“准备中”挂在它上面，停止也按它认。 */
  sessionId: SessionId;
  repo: string;
  branch: string;
  worktreePath: string;
  status: WorkerStatus;
  setupCommand: string | null;
}

/**
 * 准备命令跑完的结果（daemon/setup/setup.ts 的 runSetupCommand），交给 onWorktreeCreated 写进任务说明前面。
 * - ok：退出码 0；failed：退出码非 0、被信号杀了，或者起不来（error 写原因）；
 * - timeout：超过 SETUP_TIMEOUT_MS 被强制结束；stopped：用户在网页上点了停止。
 * 守护进程关机打断的不交给账本（重启后重跑）。
 */
export interface SetupOutcome {
  kind: "ok" | "failed" | "timeout" | "stopped";
  command: string;
  /** 正常退出时的退出码；被信号杀了、起不来是 null。 */
  exitCode: number | null;
  /** 被信号杀了时的信号名。 */
  signal: string | null;
  /** 起不来（找不到 shell、worktree 目录不在）、意外出错（“准备命令出错：…”）时的原因；其他是 null。 */
  error: string | null;
  /** 这次用的超时（runner 的 timeoutMs，默认 SETUP_TIMEOUT_MS）；附注里“超过 N 分钟”按它写。 */
  timeoutMs: number;
  durationMs: number;
  /** 输出（标准输出和标准错误合在一起）的最后 SETUP_OUTPUT_TAIL_LINES 行、最多 SETUP_OUTPUT_TAIL_BYTES 字节。 */
  tail: string;
  logPath: string;
  /** 日志写不了时的原因；写成了是 null。 */
  logError: string | null;
}

/**
 * hub worker start 之前，agent 接口异步探好的主文件夹 git 状态（m3-plan 第 2.6 节）。探 git 不放进 hubCall：hubCall 同步、
 * 在数据库事务里，git 一卡住整个守护进程就停住。
 * - ok：git 正常跑完了。isRepoWithCommit 为 false 只表示 git 明确答了“不是仓库”或“还没有提交”；
 * - failed：git 没跑成（超时、找不到 git、别的非零退出，比如 Xcode 许可证没同意）。error 是给人看的原因。
 *   账本据此拒绝这次派活，不会默默改成在主文件夹里干。
 */
export type WorkspaceProbe =
  | { kind: "ok"; isRepoWithCommit: boolean; hasUncommittedChanges: boolean }
  | { kind: "failed"; error: string };

/** hubCall 的第 4 个参数：agent 接口在调 hubCall 之前异步准备好的东西（事务里不做 I/O）。 */
export interface HubCallContext {
  /** worker.start 没带 noWorktree 时必须有（主文件夹是 workerStartFolder 给的那个），否则不用。 */
  workspace?: WorkspaceProbe;
  /** worker.show：这个 Worker 分支上的 PR；查不到或没有就没有这一项。 */
  pr?: WorkerPr;
}

export interface Ledger {
  // ---- 界面服务用 ----
  /**
   * 同一个事务里：写一条“排队中”的用户消息 + 登记一个 session.send 动作。clientId 重复时返回已有的编号。
   * 对话不存在抛 ConversationNotFoundError。对话存在但没有会话（数据不一致）抛普通 Error，界面服务按 500 处理。
   * Worker 的对话也走这里（用户在网页的 Worker 页面直接对它说）：消息带 workerId；Worker 已收工抛 LedgerRequestError("conflict")
   * （clientId 重复的照样返回已有的编号）。Worker 收到后项目经理对话里多一行 user_message（见 applyDriverEvent）。
   * 隐藏的命令（厂商实现的 blockReason：/clear、/model……）不存、不发，抛 LedgerRequestError("invalid")，message 是给用户看的原因。
   */
  postUserMessage(input: PostUserMessageInput): PostUserMessageResult;
  /**
   * 输入框“/”命令和“@”文件用（界面服务的 commands、files 接口，daemon/composer.ts）：这个对话最新一代的会话、厂商和目录。
   * 对话不存在（包括老的项目群）抛 ConversationNotFoundError。
   */
  composerTarget(conversationId: ConversationId): ComposerTarget;
  /**
   * 用户点“停止”。只停这个对话最新的一代（generation 最大的那个会话）：通知 onStopRequested 的监听者；
   * 最新一代没在跑时什么也不做。对话不存在抛 ConversationNotFoundError。
   * 老的项目群（kind project_group）当作不存在：postUserMessage、requestStop、messagesBefore 都抛 ConversationNotFoundError，
   * retryMessage 群里的消息 → not_found。
   */
  requestStop(conversationId: ConversationId): void;
  /**
   * 网页看得到的东西：不含老的项目群（对话、它们的会话）和归档的项目（见 CONVERSATION_KINDS）。
   * 含 Worker 的对话（kind worker）和会话：网页左栏不显示，点项目经理对话里那一行打开。
   */
  snapshot(): StateSnapshot;
  /** 更早的 100 条（before 之前，从小到大）。对话不存在（包括老的项目群）抛 ConversationNotFoundError。 */
  messagesBefore(conversationId: ConversationId, before: MessageId): MessagesPage;
  changesSince(seq: number): ChangesSince;
  /** 每产生一条变化调用一次监听者。 */
  onChange(listener: (change: Change) => void): Unsubscribe;

  // ---- 界面服务用（M2）----
  /** 项目经理不存在 → not_found。 */
  getPersona(pmId: PmId): PersonaView;
  /**
   * 见 EditPersonaResult。actor 是会话时只能改这个会话所属的项目经理，否则 forbidden。
   * 错误：项目经理不存在 → not_found；text、mode 都没给、太长 → invalid。
   */
  editPersona(pmId: PmId, input: EditPersonaInput, actor: LedgerActor): EditPersonaResult;
  /**
   * 撤销一次修改（只有界面上的用户能撤销，actor 记 user）：按那一条的 textBefore、modeBefore 改回去，
   * 记一条 revertOf 指向它的新修改，其他同 editPersona。只能撤销这个项目经理最近的一条（撤销本身也是一条，可以再撤销）。
   * 错误：没有这一条 → not_found；不是最近一条 → conflict（界面提示“只能撤销最近一次”）。
   */
  revertPersonaChange(changeId: PersonaChangeId): EditPersonaResult;
  /**
   * 重试一条失败的用户消息（m2-plan 第 6 节第 5 条，POST /api/messages/:id/retry）。同一个事务里：
   * 消息状态 failed → queued（MESSAGE_STATUS_TRANSITIONS 里的那一条）、failureReason 清空；重新登记它的 session.send
   * （同一个去重键，已结束的那一行重置成 pending；sessionId 换成这个对话现在最新一代的会话）；推一条 message.updated。
   * 之后照 queued → delivered → … 正常走，不新增消息。
   * 错误：没有这条消息（包括老项目群里的）→ not_found；不是用户发的、不是 failed → conflict。
   */
  retryMessage(messageId: MessageId): { messageId: MessageId };
  /**
   * 资料页的“开新会话”（POST /api/pms/:id/renew-session，见 ledger/handover.ts）：给项目经理现在的会话发一条 handover.requested，
   * 让它把交接写成这一轮的回复；那一轮正常结束时（applyDriverEvent）同一个事务里换代：旧会话登记 session.end，
   * 建 generation + 1 的新会话，发 session.renewed（交接 + 最近几条原话），换代期间压着的消息改发给新会话。
   * 已经有一条在等（排队、已送达、处理中）就返回它，不再发；上一次失败、被停止的重新排队。新会话的第一条还没结果时返回它；
   * 它重排次数用完了，把它重新排队（次数清零）。没有这个项目经理 → not_found。
   */
  renewSession(pmId: PmId): { messageId: MessageId };
  /**
   * session.send 处理函数用：这条消息要不要先压着。同一个对话里、和它同一代或更早的 handover.requested（项目经理在写交接）
   * 或 session.renewed（新会话的第一条）还没结果（排队、已送达、处理中）时都等，换代后发给新会话。session.renewed 自己不等。
   */
  waitsForHandover(messageId: MessageId): boolean;

  // ---- agent 接口用（M2）----
  /**
   * agent 敲的 hub 命令。sessionId 是 agent 接口按令牌认出来的会话（请求体里自称是谁不算数）；args 已经按形状和长度校验过。
   * 账本按会话认人：这个会话属于哪个项目经理（AgentSessionRow.pmId）；项目就是这个项目经理的那一个，不用点名。
   * - status：只读。这个会话的项目经理、会话编号、对话、它的项目的名片（没有是 null）；text 是一两句“你是谁、项目和文件夹”；
   * - project.create：给这个项目经理建项目。同一个事务里：项目（挂在它的对话上，name 不给就用主文件夹的名字）、主文件夹、
   *   会话的 cwd 换成主文件夹的真实路径（addDirs 清空）、对话里一条 project.created 系统消息（“项目已建好”）；
   *   推 project.created、folders.updated、message.created。不登记 session.start：下一条消息前驱动层按新的 cwd 自动重启。
   *   已经有进行中的项目 → conflict（“一个项目经理只管一个项目，请新建一个项目经理”）；文件夹不对（不存在、不是目录、
   *   在数据目录里）→ invalid，不存在时是“文件夹不存在，请先建好：<路径>”（m2-plan 第 6 节第 1 条：不替用户建）；
   *   名字、说明不对 → invalid。路径已经是别的项目的主文件夹也照样建（同一个文件夹可以有多个项目经理），项目名也不要求唯一；
   * - project.attach / detach：同一个事务里改 project_folders、改会话的 addDirs、发一条系统消息（只给人看）、推 folders.updated、
   *   message.created。还没有项目 → not_found；detach 主文件夹 → invalid；没挂着 → not_found；已经挂着 → conflict。
   *   detach 找“哪一行”：先 realpath 传进来的路径；realpath 失败（目录已经被删了、改名了）就用 path.resolve 之后的字面路径；
   *   拿结果和库里没移除的 project_folders.path 逐字比。所以磁盘上已经没了的文件夹也能移除。attach 不这样，目录必须在；
   * - persona.show / edit：同 getPersona / editPersona（actor 是这个会话）。
   * M3：先按会话的 role 查 HUB_COMMAND_ROLES（hubCommandAllowed），不放行 → forbidden（Worker 只能用 status）。
   *   这一步接进 hubCall 归 W2（W0 时 hubCall 还是“不是项目经理的会话 → forbidden”）。
   * - status（Worker）：WorkerHubStatus，text 是一两句“你是哪个 Worker、在做什么、在哪干活”；
   * - worker.start：还没有项目 → invalid；title、task 不对 → invalid；没带 noWorktree 时按 context.workspace 定在哪干活，
   *   它是 failed → 抛普通 Error（agent 接口回 internal，message 说清楚 git 怎么了、可以加 --no-worktree）。同一个事务里：workers 一行、Worker 的对话（kind worker）和会话
   *   （role worker，worker_id、model = args.model ?? 项目经理的模型；cwd 是 worktree 目录，或者主文件夹 + 和项目经理一样的 addDirs）、
   *   Worker 对话里第一条消息（sender pm，任务说明，queued）、项目经理对话里一行 started（WorkerMessageMeta）；
   *   worktree → 登记 worktree.create；main → 直接登记 Worker 的 session.start 和这条消息的 session.send。
   *   推 conversation.created、session.created、message.created。数量不限；
   * - worker.send：Worker 不存在 → not_found；不是这个项目经理派的 → forbidden；已经 ended → conflict。
   *   同一个事务里在 Worker 对话里写一条 sender pm 的消息、登记 session.send（同一个 Worker 会话，--resume 接着做）；
   * - worker.end：同上的检查；登记 session.end、Worker 标 ended、项目经理对话里一行 ended。再调一次什么也不做；
   * - worker.list：这个项目经理派的 Worker。
   * 每次调用都记一行 hub_calls（成功的在同一个事务里，失败的回滚后另记）。args 和 result 里的长字段按 HUB_CALL_FIELD_MAX_BYTES
   * 截断（见 domain.ts 的 HubCall），完整正文以 persona_changes 为准。成功返回 { text, data }，失败抛 LedgerRequestError。
   * 会话不存在或不是项目经理的会话 → forbidden。
   */
  hubCall<C extends HubCommand>(sessionId: SessionId, command: C, args: HubArgs<C>, context?: HubCallContext): HubResult<C>;
  /**
   * agent 接口在 worker.start 之前调（只读）：要探 git 的那个文件夹，就是这个会话所属项目经理的项目主文件夹。
   * 不是项目经理的会话、还没有项目 → null（不用探，hubCall 自己会报 forbidden、invalid）。
   */
  workerStartFolder(sessionId: SessionId): string | null;
  /**
   * agent 接口在 worker.show 之前调（只读）：要查 PR 的 Worker 的分支和 worktree 目录。
   * 不是项目经理的会话、不是它派的、不在 worktree 里干活 → null（不用查，hubCall 自己会报错或不写 PR）。
   */
  workerPrTarget(sessionId: SessionId, workerId: WorkerId): { cwd: string; branch: string } | null;
  /** 见 LaunchContext。 */
  getLaunchContext(sessionId: SessionId): LaunchContext;

  // ---- worktree.create 处理函数用（M3）----
  /** Worker 不存在、不在 worktree 里干活 → null。 */
  getWorktreeTask(workerId: WorkerId): WorktreeTask | null;
  /**
   * 项目配了准备命令、建好 worktree 后开始跑它（M3 之后加的）：Worker 会话的 activity 设成 preparing，推 session.status；
   * hub worker list 显示“准备中”。返回真的进了准备中没有：Worker 不存在、已经 ended（比如建 worktree 时收工了）、
   * 已经开工（base_commit 有了）什么也不做，返回 false，处理函数就不跑准备命令。
   * preparing 不会被驱动层的事件盖成 working（sessions.ts 的 working）。
   */
  onSetupStarted(workerId: WorkerId): boolean;
  /**
   * session.send 处理函数用（兜底：不管消息是项目经理、用户还是系统发的）：这条消息要不要先等等再发。
   * Worker 的会话、Worker 没收工时：还没开工（在 worktree 里干、base_commit 还是 NULL）→ 都等；开工了但任务说明还在排队 →
   * 除任务说明外都等。这样会话不会被别的消息提前拉起来，第一轮一定是任务说明。别的会话一律 false。
   */
  waitsForFirstTurn(sessionId: SessionId, messageId: MessageId): boolean;
  /**
   * worktree 建好了（或者早就建好了），配了准备命令的是准备命令也跑完了：同一个事务里记下 base_commit（已经有就不改），
   * 登记 Worker 的 session.start 和它对话里第一条消息的 session.send（按去重键，重复调用无害）。Worker 已经 ended 什么也不做。
   * setup（跑了准备命令才有）：结果（prompt.ts 的 setupNote）加在那条任务说明前面，推 message.updated；
   * 会话的 preparing、stopping 回到 idle（ended 的也回）。
   * 重启恢复（recoverAfterRestart）会给 open、在 worktree 里、base_commit 还是 NULL 的 Worker 重新登记 worktree.create。
   */
  onWorktreeCreated(workerId: WorkerId, baseCommit: string, setup?: SetupOutcome): void;

  // ---- 组装代码用（M1 W5 接线，M2 起归 W6）----
  /**
   * 守护进程启动时调一次（M2，在 recoverAfterRestart 之后）。对每个项目经理读 personas/pm-<编号>.md（路径用 paths.ts 的
   * personaFilePath），算文件内容的哈希（sha256 十六进制），和 pms.persona_file_hash（上次成功写入文件的内容哈希）比：
   * 1. 数据库正文是 NULL（M1 升上来的）：文件在就用文件内容填上，没有就填成空串并写文件；不记修改。
   * 2. 文件不存在或读不了：按数据库重写文件。
   * 3. 文件哈希等于 persona_file_hash：没人动过文件。文件内容和数据库正文一样就什么也不做；不一样说明上次写文件失败了
   *    （数据库已经改了），按数据库重写文件。不记修改。
   * 4. 文件哈希不等于 persona_file_hash：才算用户手改过。文件内容和数据库正文一样就不记修改；不一样就按文件记一条
   *    actor: "file" 的修改（同 editPersona，模式不变）。例外：persona_file_hash 是 NULL（从来没写成功过，分不清是谁改的）
   *    时按数据库重写文件，不记修改。
   * 写文件一律临时文件 + 改名；写成功（或确认文件内容就是要的那份）之后才把 persona_file_hash 更新成那份内容的哈希，
   * 写失败不更新，下次启动按第 3 条重写。
   */
  syncPersonaFiles(): SyncPersonaFilesResult;
  /** 组装代码（M2 W6）把它接到 driver.interrupt。 */
  onStopRequested(listener: (event: { conversationId: ConversationId; sessionId: SessionId }) => void): Unsubscribe;
  /**
   * 有新动作登记（包括重复登记把已结束的动作重置成 pending）时调用，在事务提交之后。
   * 组装代码（M2 W6）把它接到 executor.wake()。
   */
  onActionEnqueued(listener: (action: AnyActionRow) => void): Unsubscribe;
  /**
   * 驱动层 → 账本：组装代码（M2 W6）把 driver.onEvent 接到这里。agent 输出按 agentMessageDedupeKey 去重；
   * 消息状态只按 MESSAGE_STATUS_TRANSITIONS 改，不合法的忽略。各事件怎么标见 driver.ts 的注释。
   *
   * M3：Worker 的会话这一轮结束时，在同一个事务里给项目经理的对话发那一行（kind worker），并登记 session.send
   * （source system）把全文交给项目经理（见 WorkerMessageMeta）。“这一轮”用它处理的消息里编号最大的那条认，去重键见
   * workerMessageDedupeKey：
   * - turn.ended 且 ok、不是打断 → report：按 worker.ts 的 parseWorkerReport 解析这一轮最后一段 agent 文字；
   * - turn.ended 且打断（用户点停止）或 ok=false → turn_failed，summary 写原因（“被停止了”、错误信息）；
   * - session.exited 且这一轮没有 result：reason 是 interrupt、crash、startup_failed → turn_failed（原因写退出码或信号）；
   *   reason 是 shutdown（守护进程关机）→ 不发这一行，也不交给项目经理：重启后 recoverAfterRestart 照 M2 重发这条消息、
   *   --resume 接着做（m3-plan 验收第 11 条），做完的那一轮照常出 report；idle 没有在途的消息，什么也不发；
   * - claude 自己开的一轮（后台任务完成等，turn.started 开头、turn.ended 没有消息编号）照样汇报：这一轮最后一段 agent 文字，
   *   去重键里的编号用这一轮最后一条 agent 消息的编号；这一轮没有文字（一条消息都没有、只有工具调用）就不汇报；没有 turn.started 的游离 turn.ended 不处理；
   * - 同一条消息先 turn_failed、之后又被重发并跑出结果：两行都有（事件类型在去重键里），后来的 report 不会被吞掉；
   *   同一个事件重放（同一个 result 再来一遍）只有一行。
   * - Worker 会话的 message.delivered 里有用户直接对它说的话（Worker 对话里 sender user、带 workerId）→ 每条一行 user_message，
   *   原文交给项目经理；重启后重发再送达不会多一行。
   */
  applyDriverEvent(sessionId: SessionId, event: DriverEvent): void;
  /**
   * 驱动层不经事件直接改了会话那一行（M2：end 把 status 写成 ended）之后，组装代码（session.end 处理函数）调：
   * 按那一行重算网页看到的会话状态（activity 当作空闲），和上次推的不一样就推一条 session.status。会话不存在什么也不做。
   */
  refreshSessionState(sessionId: SessionId): void;
  /**
   * 守护进程启动时调一次，在 executor.start() 之前（设计第 5.4 节第 3、4 步的账本部分）。
   * 重新登记这些消息的 session.send：
   * - delivered、processing 的：不管有没有 pending、running 的动作都登记，带 resend: true
   *   （已有活动动作时 UPSERT 只把参数改成 resend: true，不重置、不通知）；
   * - queued 的：只在没有 pending、running 的 session.send 动作时登记，不带 resend。
   * 有 delivered、processing 消息的会话（上次一轮被打断了），它第一条重发的消息再带 recovery: true：驱动层把恢复说明
   * 和这条写在同一行。不单独登记 session.start 去写恢复说明（单独一行会自己占一轮，那一轮的回复对不上任何消息）。
   * 重复登记按 NewAction 的规则重置已结束的动作。返回登记了什么，方便日志和测试。
   */
  recoverAfterRestart(): { resentMessageIds: MessageId[]; requeuedMessageIds: MessageId[]; recoveredSessionIds: SessionId[] };
  /** 新建项目经理（界面；第一次启动没有项目经理时组装代码也调它）。见 CreatePmResult。 */
  createPm(input: CreatePmInput): CreatePmResult;
  /**
   * 调度器（M6，组装代码每 SCHEDULER_TICK_MS 调一次，启动时也调一次）：在一个事务里，对每个 next_run_at <= nowMs 的、没暂停的定时任务：
   * 上一条定时消息（last_message_id）还在排队、已送达、处理中 → 记 skipped，不发；否则往项目经理的对话写一条 schedule.run 消息
   * （status queued，标题“定时任务：名字（原定 09:00）”，晚了 SCHEDULE_LATE_MS 以上标“补跑”，错过几个周期都只补这一次）、
   * 登记 session.send（source system）；然后 next_run_at 从 nowMs 重算（不是从原定时间往后推），推 schedule.updated。
   * 这一轮失败（turn.ended 不成功等）或 session.send 彻底失败时（applyDriverEvent、onActionFailed 里）：记 failed，
   * 对话里写一条 schedule.failed“定时任务没跑成：名字：原因”。
   */
  runDueSchedules(nowMs: number): void;
  /**
   * 界面的定时任务卡片（M6）：和 hub schedule add / pause / resume / remove 同一套校验和写库（schedules.ts），只是不看是谁的会话。
   * addSchedule：项目经理不存在 → not_found；参数不合规 → invalid（中文原因）；超过 MAX_SCHEDULES_PER_PM → conflict。
   * setScheduleEnabled：true = 恢复（下一次从现在算），false = 暂停；removeSchedule 在对话里留一条“已删除”。不存在 → not_found。
   */
  addSchedule(pmId: PmId, args: HubArgs<"schedule.add">): ScheduleRecord;
  setScheduleEnabled(scheduleId: ScheduleId, enabled: boolean): ScheduleRecord;
  removeSchedule(scheduleId: ScheduleId): void;
  /** 给执行器处理函数用：读动作要发的消息。找不到返回 null。 */
  getMessage(id: MessageId): Message | null;
  /**
   * 这个会话现在能不能分享这个文件（realPath 已 realpath）：不在敏感路径、.git/ 里，在这个会话所属项目的文件夹、worktrees 目录、
   * 会话自己的 cwd 和附加文件夹、uploads、临时目录之内（和存副本时同一套规则，daemon/sent-files.ts 的 isShareable）。
   * 界面服务“用 Finder / 默认程序打开”发出去的原文件前用它再查一次（项目文件夹后来可能改了）。会话不存在 false。
   */
  sentFileAllows(sessionId: SessionId, realPath: string): boolean;
  /**
   * 执行器：动作彻底失败（次数用完）或被放弃（坏行、没有处理函数，error 以“放弃：”开头）时调用。
   * session.send → 那条消息标 failed，failureReason = error；
   * session.start、session.end → 什么也不做：不碰消息（每条消息由它自己的 session.send 失败时标），
   * 也不记 health（执行器每次失败都已经记过）。
   * worktree.create（M3）→ Worker 标 ended；项目经理对话里一行 worktree_failed（summary 是 error），原因交给项目经理（session.send）；
   * Worker 对话里那条没发出去的任务说明标 failed。
   */
  onActionFailed(action: AnyActionRow, error: string): void;
  /**
   * 处理函数：这条消息所在的一轮被打断了，而且不会再发（重启恢复时它的会话已经结束，见 handlers.ts）：
   * delivered、processing → stopped（和关机打断一轮一样），推 message.updated。别的状态（包括已经有结果的）什么也不做。
   */
  stopMessage(messageId: MessageId): void;
  /**
   * 各模块报健康状态：error 为 null 表示成功一次（连续失败次数清零），否则次数加一、记下错误。
   * 有变化就推一条 health.updated。执行器每次处理函数抛错都调它（模块按错误来源：DriverError → "driver"）。
   * 清零规则：任何一个动作成功，执行器都对 "driver" 和 "actions" 各调一次 reportHealth(m, null)，
   * 不管错误是谁记的（执行器自己、driver.error 事件、上次运行留下的），所以这两个模块的错误总能被后面的成功清掉。
   * 执行器改动作状态写库失败时记 "store"。
   */
  reportHealth(module: HealthModule, error: string | null): void;
}
