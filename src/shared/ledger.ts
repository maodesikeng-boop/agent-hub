// 账本（W1 实现）对界面服务、agent 接口、执行器、驱动层和组装代码开放的接口。
// 数据库是同步接口，账本方法也都是同步的；调用方想 await 也行。
// 这里只从 hub.ts 引类型（hub.ts 从这里引常量），没有运行时的循环引用。
import type { Change, MessagesPage, StateSnapshot } from "./api.ts";
import type { DriverEvent } from "./driver.ts";
import type { AnyActionRow } from "./actions.ts";
import type {
  AgentRole,
  Conversation,
  ConversationId,
  ConversationKind,
  HandoffId,
  HealthModule,
  Message,
  MessageId,
  PersonaChange,
  PersonaChangeId,
  Pm,
  PmId,
  PmMode,
  Project,
  ProjectFolder,
  SessionId,
  Unsubscribe,
} from "./domain.ts";
import type { HubArgs, HubCommand, HubResult, ProjectCard } from "./hub.ts";

/**
 * 账本拒绝一个请求的原因（M2 起的新方法都用它）：
 * - invalid：参数不对（名字空、文件夹不存在、主文件夹不能移除、交给自己……）；
 * - not_found：要找的东西没有（项目、项目经理、消息、修改记录）；
 * - forbidden：管不着（不是自己管的项目）；
 * - conflict：和现在的状态冲突（重名、路径已经是别的项目的主文件夹、不是最近一次修改、消息不是失败状态）。
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

export interface PostUserMessageInput {
  conversationId: ConversationId;
  /** 网页生成；同一个对话里同一个 clientId 只会有一条消息、一个动作（去重键见 userMessageDedupeKey）。 */
  clientId: string;
  text: string;
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
 * name 用 normalizeName 规整；persona 不超过 MAX_PERSONA_BYTES；defaultModel 不超过 MAX_MODEL_CHARS，空串当没给。
 */
export interface CreatePmInput {
  name: string;
  mode: PmMode;
  defaultModel?: string | null;
  persona: string;
}

/**
 * 同一个事务里：pms 一行（persona 存正文）、私聊、私聊的会话（pm_id 是它，cwd 是 pm-home/<编号>/，账本负责建这个目录）。
 * 提交后写 personas/pm-<编号>.md，推 pm.created、conversation.created、session.created。不记 persona_changes（建的时候不算修改）。
 * 错误：名字不对、正文太长 → invalid；同名 → conflict。
 */
export interface CreatePmResult {
  pm: Pm;
  conversation: Conversation;
  sessionId: SessionId;
}

/** 新建项目（界面的表单；hub project create 也走同一套逻辑，pmId 是这个会话的项目经理）。 */
export interface CreateProjectInput {
  name: string;
  /** 用户填的路径，可以带 ~；账本用 resolveFolder 变成真实路径。 */
  folder: string;
  pmId: PmId;
  description?: string;
}

/**
 * 同一个事务里：项目、主文件夹、群（title 是项目名）、群会话（第 1 代，属于 pmId，cwd 是主文件夹真实路径，addDirs 空）、
 * 群里一条 project.created 系统消息（“项目已建好”）。不登记 session.start：第一条消息来了再起。
 * 推 project.created、conversation.created、session.created、folders.updated、message.created。
 * 错误：名字、说明不对 → invalid；项目经理不存在 → not_found；文件夹不对（不存在、不是目录、在数据目录里）→ invalid，
 * message 写清楚原因，不存在时是“文件夹不存在，请先建好：<路径>”（m2-plan 第 6 节第 1 条：M2 不替用户建）；
 * 重名、路径已经是别的项目的主文件夹 → conflict。任何错误都什么也不写。
 */
export interface CreateProjectResult {
  project: Project;
  mainFolder: ProjectFolder;
  conversation: Conversation;
  sessionId: SessionId;
}

/**
 * 把用户或 agent 给的路径变成真实路径：展开开头的 ~、realpath、必须是已有目录、不能在数据目录（~/.agent-hub）里面。
 * 不对就抛 LedgerRequestError("invalid", 原因)。W1 给默认实现（用 node:fs），作为账本的构造参数注入，测试换假的。
 */
export type ResolveFolder = (path: string) => string;

/** 资料页、hub persona show 看到的性格设定。 */
export interface PersonaView {
  pmId: PmId;
  /** 正文，以数据库 pms.persona 为准。 */
  text: string;
  mode: PmMode;
  /** 修改记录，新的在前，最多 PERSONA_CHANGES_LIMIT 条。 */
  changes: PersonaChange[];
  /** 能撤销的那一条（最近一条）的编号；没有修改记录是 null。 */
  revertableChangeId: PersonaChangeId | null;
}

/** text、mode 至少给一个；text 是新的完整正文，不超过 MAX_PERSONA_BYTES；reason 不超过 MAX_REASON_CHARS。 */
export interface EditPersonaInput {
  text?: string;
  mode?: PmMode;
  reason?: string;
}

/**
 * 改性格设定、撤销的结果。change 为 null：正文和模式都和现在一样，什么也没写、没推。
 * 改了的话，同一个事务里：pms.persona、pms.mode、persona_changes 一行、一条 persona.changed 系统消息（发在哪见 domain.ts 的
 * SystemMessageMeta）；推 pm.updated、message.created。提交后写 personas/pm-<编号>.md（临时文件 + 改名）；
 * 写文件失败不影响结果（数据库已提交），下次启动 syncPersonaFiles 按数据库重写。
 * 这个项目经理的所有会话在下一条消息前自动重启（驱动层比 fingerprint，账本不用管）。
 */
export interface EditPersonaResult {
  change: PersonaChange | null;
  persona: PersonaView;
}

/** 启动时 syncPersonaFiles 的结果。 */
export interface SyncPersonaFilesResult {
  /** 文件和数据库不一样、按文件记了一条 actor: "file" 修改的项目经理。 */
  recordedPmIds: PmId[];
  /** 文件不存在或读不了、按数据库重写了文件的项目经理。 */
  rewrittenPmIds: PmId[];
}

/**
 * 给 W3 生成提示词用（驱动层的 prepareLaunch 里调）。只读。
 * - 私聊会话：project、handoff 是 null；managedProjects 是它现在管的进行中项目的名片。
 * - 群会话：project 是这个群的项目（文件夹按现在的，不按会话那一行）；handoff 是这个项目最近一份交接
 *   （没有就是 null）；managedProjects 同样给（提示词里可以不用）。
 * pm 是这个会话所属的项目经理（AgentSessionRow.pmId），不是项目现在的项目经理：换人后旧一代会话还在回最后一轮时，
 * 提示词仍是原项目经理的。
 * 错误：会话不存在、不是项目经理的会话 → not_found。
 */
export interface LaunchContext {
  sessionId: SessionId;
  role: AgentRole;
  conversation: { id: ConversationId; kind: ConversationKind };
  pm: { id: PmId; name: string; mode: PmMode; persona: string };
  managedProjects: ProjectCard[];
  project: ProjectCard | null;
  handoff: { id: HandoffId; fromPmName: string; text: string; createdAt: number } | null;
}

export interface Ledger {
  // ---- 界面服务用 ----
  /**
   * 同一个事务里：写一条“排队中”的用户消息 + 登记一个 session.send 动作。clientId 重复时返回已有的编号。
   * 对话不存在抛 ConversationNotFoundError。对话存在但没有会话（数据不一致）抛普通 Error，界面服务按 500 处理。
   */
  postUserMessage(input: PostUserMessageInput): PostUserMessageResult;
  /**
   * 用户点“停止”。账本记下，并通知 onStopRequested 的监听者；对话没有在跑的会话时什么也不做。
   * 对话不存在抛 ConversationNotFoundError。
   */
  requestStop(conversationId: ConversationId): void;
  snapshot(): StateSnapshot;
  /** 更早的 100 条（before 之前，从小到大）。 */
  messagesBefore(conversationId: ConversationId, before: MessageId): MessagesPage;
  changesSince(seq: number): ChangesSince;
  /** 每产生一条变化调用一次监听者。 */
  onChange(listener: (change: Change) => void): Unsubscribe;

  // ---- 界面服务用（M2）----
  /** 见 CreateProjectResult。界面传 { kind: "user" }；actor 是会话时 input.pmId 必须是这个会话的项目经理，否则 forbidden。 */
  createProject(input: CreateProjectInput, actor: LedgerActor): CreateProjectResult;
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
   * 重试一条失败的用户消息（m2-plan 第 6 节第 5 条，POST /api/messages/:id/retry）：重新登记它的 session.send
   * （同一个去重键，已结束的那一行重置成 pending；sessionId 换成这个对话现在最新一代的会话），消息状态不动，
   * 驱动层写进去之后照“failed → delivered”走，不新增消息。
   * 错误：没有这条消息 → not_found；不是用户发的、不是 failed → conflict。
   */
  retryMessage(messageId: MessageId): { messageId: MessageId };

  // ---- agent 接口用（M2）----
  /**
   * agent 敲的 hub 命令。sessionId 是 agent 接口按令牌认出来的会话（请求体里自称是谁不算数）；args 已经按形状和长度校验过。
   * 账本按会话认人：这个会话属于哪个项目经理（AgentSessionRow.pmId）、在哪个对话；只能动这个项目经理现在管的项目，否则 forbidden。
   * - project.create：同 createProject，pmId 是这个会话的项目经理；
   * - project.attach / detach：同一个事务里改 project_folders、改这个群最新一代会话的 addDirs、发一条系统消息并登记给 agent 的
   *   session.send、推 folders.updated、message.created。detach 主文件夹 → invalid；没挂着 → not_found；已经挂着 → conflict；
   * - project.assign：见 m2-plan 第 3 节“交接怎么走”。交给自己、正文空白或太长 → invalid；没有这个项目经理 → not_found；
   *   同一个事务里：交接文件（提交前写好）和 handoffs 一行；projects.pm_id；群的下一代会话（属于接手的人，cwd、addDirs 照旧，
   *   新的 vendorSessionId）；旧会话的 session.end；把这个群里还是 queued 的消息的 session.send 改指新一代；两条
   *   project.reassigned 系统消息（见 SystemMessageMeta）；推 project.updated、session.created、message.created；
   * - persona.show / edit：同 getPersona / editPersona（actor 是这个会话）。
   * 每次调用都记一行 hub_calls（成功的在同一个事务里，失败的回滚后另记）。成功返回 { text, data }，失败抛 LedgerRequestError。
   * 会话不存在或不是项目经理的会话 → forbidden。
   */
  hubCall<C extends HubCommand>(sessionId: SessionId, command: C, args: HubArgs<C>): HubResult<C>;
  /** 见 LaunchContext。 */
  getLaunchContext(sessionId: SessionId): LaunchContext;

  // ---- 组装代码用（W5 接线）----
  /**
   * 守护进程启动时调一次（M2，在 recoverAfterRestart 之后）：对每个项目经理比较 personas/pm-<编号>.md 和数据库的正文：
   * - 文件和数据库不一样（用户手改过）→ 按文件记一条 actor: "file" 的修改（同 editPersona，模式不变）；
   * - 数据库里正文还是 null（M1 升上来的）→ 文件在就直接用文件内容填上，不记修改；文件也没有就用 PM_PERSONA_TEMPLATE；
   * - 文件不存在或读不了 → 按数据库重写文件。
   */
  syncPersonaFiles(): SyncPersonaFilesResult;
  /** W5 把它接到 driver.interrupt。 */
  onStopRequested(listener: (event: { conversationId: ConversationId; sessionId: SessionId }) => void): Unsubscribe;
  /**
   * 有新动作登记（包括重复登记把已结束的动作重置成 pending）时调用，在事务提交之后。
   * W5 把它接到 executor.wake()。
   */
  onActionEnqueued(listener: (action: AnyActionRow) => void): Unsubscribe;
  /**
   * 驱动层 → 账本：W5 把 driver.onEvent 接到这里。agent 输出按 agentMessageDedupeKey 去重；
   * 消息状态只按 MESSAGE_STATUS_TRANSITIONS 改，不合法的忽略。各事件怎么标见 driver.ts 的注释。
   */
  applyDriverEvent(sessionId: SessionId, event: DriverEvent): void;
  /**
   * 守护进程启动时调一次，在 executor.start() 之前（设计第 5.4 节第 3、4 步的账本部分）。
   * 重新登记这些消息的 session.send：
   * - delivered、processing 的：不管有没有 pending、running 的动作都登记，带 resend: true
   *   （已有活动动作时 UPSERT 只把参数改成 resend: true，不重置、不通知）；
   * - queued 的：只在没有 pending、running 的 session.send 动作时登记，不带 resend。
   * 有 delivered、processing 消息的会话（上次一轮被打断了），再登记一个 session.start（当前这一代，recovery: true）。
   * 重复登记按 NewAction 的规则重置已结束的动作。返回登记了什么，方便日志和测试。
   */
  recoverAfterRestart(): { resentMessageIds: MessageId[]; requeuedMessageIds: MessageId[]; recoveredSessionIds: SessionId[] };
  /** 新建项目经理（界面；第一次启动没有项目经理时组装代码也调它）。见 CreatePmResult。 */
  createPm(input: CreatePmInput): CreatePmResult;
  /** 给执行器处理函数用：读动作要发的消息。找不到返回 null。 */
  getMessage(id: MessageId): Message | null;
  /**
   * 执行器：动作彻底失败（次数用完）或被放弃（坏行、没有处理函数，error 以“放弃：”开头）时调用。
   * session.send → 那条消息标 failed，failureReason = error；
   * session.start、session.end → 什么也不做：不碰消息（每条消息由它自己的 session.send 失败时标），
   * 也不记 health（执行器每次失败都已经记过）。
   */
  onActionFailed(action: AnyActionRow, error: string): void;
  /**
   * 各模块报健康状态：error 为 null 表示成功一次（连续失败次数清零），否则次数加一、记下错误。
   * 有变化就推一条 health.updated。执行器每次处理函数抛错都调它（模块按错误来源：DriverError → "driver"）。
   * 清零规则：任何一个动作成功，执行器都对 "driver" 和 "actions" 各调一次 reportHealth(m, null)，
   * 不管错误是谁记的（执行器自己、driver.error 事件、上次运行留下的），所以这两个模块的错误总能被后面的成功清掉。
   * 执行器改动作状态写库失败时记 "store"。
   */
  reportHealth(module: HealthModule, error: string | null): void;
}
