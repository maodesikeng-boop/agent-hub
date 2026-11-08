// 账本里的 Worker（M3，m3-plan 第 2、3 节）：Worker 的账本逻辑都在这里。
// - hub worker start / send / end / list，Worker 调 hub status；
// - 在哪干活：主文件夹是有提交的 git 仓库、又没给 --no-worktree → worktree（登记 worktree.create，建好了再起会话），
//   否则直接在主文件夹里干（直接登记 session.start 和第一条 session.send）。git 由 agent 接口在调 hubCall 之前异步探好
//   （HubCallContext.workspace），这里不做 I/O；git 没跑成就拒绝派活，不默默改成主文件夹；
// - Worker 的会话每一轮结束，在同一个事务里给项目经理的对话发那一行（kind worker），并把全文交给项目经理（session.send）；
//   一轮结束时还有后台命令在跑的不算（awaitingBackground）：等命令跑完、它真结束一轮再发；
// - Worker 的消息发不出去（session.send 次数用完）也发一行 turn_failed 交给项目经理；
// - 用户在网页上直接对 Worker 说的话：Worker 收到时（message.delivered）发一行 user_message 交给项目经理；
//   Worker 收工、还没开工时不收（assertWorkerOpenForUser，messages.ts 的 postUserMessage、retryMessage 调）；
// - 建 worktree 的回调（getWorktreeTask、onSetupStarted、onWorktreeCreated）和彻底失败（worktree_failed）；
//   配了准备命令的，跑的时候 Worker 会话显示“准备中”，跑完的结果加在任务说明前面，重启后没开工的重新登记建 worktree；
// - Worker 会话的启动上下文。
// 汇报格式、解析、那一行的写法、分支名在 shared/worker.ts；按角色放行的表在 shared/hub.ts；git 在 daemon/git/。
import { randomUUID } from "node:crypto";
import type { AnyActionRow } from "../../shared/actions.ts";
import { agentTextOf } from "../../shared/attachments.ts";
import { normalizeWorkerTitle, utf8Bytes, workerMessageDedupeKey } from "../../shared/domain.ts";
import type {
  AgentSessionRow,
  ConversationId,
  MessageId,
  PmId,
  PmMode,
  SessionId,
  WorkerEvent,
  WorkerId,
  WorkerLineStatus,
  WorkerMessageMeta,
  WorkerRecord,
} from "../../shared/domain.ts";
import { turnFailureReason, type DriverEvent } from "../../shared/driver.ts";
import type { HubArgs, HubResult, WorkerHubStatus } from "../../shared/hub.ts";
import type { HubCallContext, LaunchContext, SetupOutcome, WorktreeTask } from "../../shared/ledger.ts";
import { GIT_REASON_MAX_CHARS, MAX_TASK_BYTES, WORKER_BACKGROUND_HOLD_MAX_MS } from "../../shared/limits.ts";
import { AGENT_VENDORS, checkEffort, checkModel, checkModelEffort, isAgentVendor, splitModelEffort, vendorUnavailableMessage } from "../../shared/vendors.ts";
import type { AgentVendor } from "../../shared/vendors.ts";
import { HUB_COMMAND } from "../../shared/names.ts";
import { workerWorktreePath } from "../../shared/paths.ts";
import { parseWorkerReport, userToWorkerHeader, workerBranchName, workerLineText, workerReportHeader } from "../../shared/worker.ts";
import { SETUP_RECEIPT_NOTE, setupNote } from "../prompt.ts";
import { composerBaseOf } from "../vendors/index.ts";
import { WORKER_NEEDS_OS_SANDBOX_MESSAGE } from "../driver/write-scope.ts";
import { fail } from "./context.ts";
import type { LedgerContext, Pending } from "./context.ts";
import type { Db } from "../store/index.ts";
import { exitFailureReason } from "./messages.ts";
import type { LedgerMessages } from "./messages.ts";
import type { LedgerPersona } from "./persona.ts";
import type { LedgerProjects } from "./projects.ts";
import { agentSettingOf } from "./worker-view.ts";
import { toConversation, toMessage, toWorkerRecord } from "./rows.ts";
import type { ConversationDbRow, MessageDbRow, ProjectDbRow, WorkerDbRow } from "./rows.ts";
import { idle } from "./sessions.ts";
import type { LedgerSessions } from "./sessions.ts";

/** 主文件夹有没提交的改动、又用 worktree 时，start 返回的话里的提醒（m3-plan 第 2.6 节）。 */
export const WORKTREE_DIRTY_NOTE = "注意：主文件夹里有没提交的改动，Worker 是从最后一次提交开始的，看不到这些改动。";
/** 这一轮被用户停止时那一行的原因。 */
export const TURN_STOPPED = "被停止了";
/** 这一轮出错、又没有错误信息时的原因。 */
const TURN_FAILED = "这一轮出错了";
/** 用户的话算 Worker 已收到的状态（user_message 那一行只给这些发）。 */
const RECEIVED_STATUSES: ReadonlySet<string> = new Set(["delivered", "processing", "replied"]);
/**
 * Worker 在等后台命令时进程被关了、后台命令跟着停了（workers.ts 的 flushAwaiting）：照常汇报，正文前面加这一句。
 * idle：后台命令超过 WORKER_BACKGROUND_HOLD_MAX_MS 没结束，驱动层到点关的；shutdown：守护进程关了；
 * restart：守护进程没走关机就没了（被杀、崩溃），重启后补发（recoverBackgroundWaits）。
 */
export function backgroundKilledNote(reason: "idle" | "shutdown" | "restart"): string {
  const resend = `要它重跑或接着做用 ${HUB_COMMAND} worker send。`;
  if (reason === "restart") {
    return `【系统】这个 Worker 在等放到后台的命令时守护进程重启了，命令随旧进程中断（跑没跑完、结果它都没看到）；下面是它中断前最后一轮的回复。${resend}`;
  }
  const why = reason === "idle" ? `超过 ${WORKER_BACKGROUND_HOLD_MAX_MS / 60_000} 分钟还没结束（可能卡住了）` : "还没结束，守护进程就关了";
  return `【系统】这个 Worker 放到后台的命令${why}，已经连同它的进程一起停掉；下面是它停之前最后一轮的回复。${resend}`;
}
/** 这一轮正常结束、却一段文字都没有时，交给项目经理的正文。 */
const NO_REPLY_TEXT = "（这一轮没有文字回复）";

/** Worker 对话里项目经理的话的去重键：任务说明一个 Worker 一条；打回、回答每次一条（hub 没有 clientId，用随机数）。 */
const taskDedupeKey = (workerId: WorkerId) => `pm:worker:${workerId}:task`;
const sendDedupeKey = (workerId: WorkerId) => `pm:worker:${workerId}:${randomUUID()}`;

/** 在等后台命令的那一轮（worker_background_waits 一行）。 */
type BackgroundWait = { turnStart: MessageId; background: boolean };

/** Worker 会话这一轮的结局：report 带这一轮最后一段文字，turn_failed 带原因。 */
type TurnOutcome =
  | { event: "report"; turnMessageId: MessageId | null }
  | { event: "turn_failed"; turnMessageId: MessageId | null; messageIds: MessageId[]; reason: string };

/**
 * 驱动层事件里“这一轮结束了”的那几种（见 shared/ledger.ts 的 applyDriverEvent）；别的事件、关机、空闲退出是 null。
 * driver.error 带消息编号（写入前校验没过，这些消息不会再发）也算这一轮没做完。
 */
function turnOutcome(event: DriverEvent): TurnOutcome | null {
  if (event.type === "driver.error") {
    const ids = event.messageIds ?? [];
    return ids.length === 0 ? null : { event: "turn_failed", turnMessageId: Math.max(...ids), messageIds: ids, reason: event.message };
  }
  if (event.type !== "turn.ended" && event.type !== "session.exited") return null;
  const { messageIds } = event;
  // claude 自己开的一轮（后台任务完成等，turn.ended 没有消息）：没有消息编号，由 afterDriverEvent 拿这一轮最后一条 agent 消息的编号顶上
  const selfStarted = event.type === "turn.ended" && messageIds.length === 0;
  if (messageIds.length === 0 && !selfStarted) return null;
  const turnMessageId = selfStarted ? null : Math.max(...messageIds);
  if (event.type === "turn.ended") {
    // 关机时 SIGINT 结束的一轮：重启后接着做完再汇报（messages.ts 的 resumesAfterShutdown）
    if (event.shutdown === true) return null;
    if (event.interrupted) return { event: "turn_failed", turnMessageId, messageIds, reason: TURN_STOPPED };
    if (!event.ok) {
      const reason = event.error === undefined ? TURN_FAILED : turnFailureReason(event.error);
      return { event: "turn_failed", turnMessageId, messageIds, reason };
    }
    return { event: "report", turnMessageId };
  }
  // 有 result 的那一轮已经按 turn.ended 发过了；关机打断的重启后接着做完再汇报；空闲退出没有在途的消息
  if (event.hadResult) return null;
  if (event.reason === "interrupt") return { event: "turn_failed", turnMessageId, messageIds, reason: TURN_STOPPED };
  if (event.reason === "crash" || event.reason === "startup_failed") {
    return { event: "turn_failed", turnMessageId, messageIds, reason: exitFailureReason(event) };
  }
  return null;
}

/** 在 worktree 里干、还没开工（base_commit 要等 worktree 建好、准备命令跑完才写）。 */
export const notStarted = (worker: Pick<WorkerDbRow, "workspace" | "base_commit">) => worker.workspace === "worktree" && worker.base_commit === null;

/**
 * 用户往对话里发消息、重试之前（messages.ts 的 postUserMessage、retryMessage，在事务里）。不是 Worker 的对话什么也不做。
 * 和 hub worker send 的口径一样：已收工拒收；还没开工（notStarted）也拒收，不然用户的话会赶在任务说明前面。
 * 网页用同样的意思判断输入框能不能用（web/selectors.ts 的 workerPhaseOf）。
 */
export function assertWorkerOpenForUser(db: Db, conversationId: ConversationId): void {
  const worker = db.get<Pick<WorkerDbRow, "id" | "status" | "workspace" | "base_commit">>(
    "SELECT id, status, workspace, base_commit FROM workers WHERE worker_conversation_id = ?",
    conversationId,
  );
  if (worker === undefined) return;
  if (worker.status === "ended") throw fail("conflict", `Worker #${worker.id} 已经收工了，不能再给它发消息`);
  if (notStarted(worker)) throw fail("conflict", `Worker 还在准备，等它开工后再发（Worker #${worker.id} 在建 worktree 或跑项目的准备命令）`);
}

/** git 的输出里挑出原因：第一条 fatal: / error: 开头的行，没有就取最后一个非空行，截到 GIT_REASON_MAX_CHARS 字。 */
function gitReasonLine(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const reason = lines.find((l) => /^(fatal|error):/.test(l)) ?? lines.at(-1) ?? "没有给出原因";
  return [...reason.replace(/。$/, "")].slice(0, GIT_REASON_MAX_CHARS).join("");
}

/** 给 agent 看的一句“在哪干活”。 */
function describeWorkspace(worker: WorkerDbRow, mainFolder: string): string {
  return worker.workspace === "worktree"
    ? `在 worktree ${worker.worktree_path}（分支 ${worker.branch}）里干活`
    : `直接在项目的主文件夹 ${mainFolder} 里干活`;
}

export type LedgerWorkers = ReturnType<typeof createLedgerWorkers>;

export function createLedgerWorkers(
  ctx: LedgerContext,
  sessions: LedgerSessions,
  messages: LedgerMessages,
  persona: LedgerPersona,
  projects: LedgerProjects,
  options: { worktreesDir: string },
) {
  const { db, now, write, enqueue } = ctx;
  const { currentSession, insertSession, liveOf, updateLive } = sessions;
  const { transition, stopIn } = messages;
  const { pmRow } = persona;
  const { activeProjectOf, projectCard, syncSessionFolders } = projects;
  const { worktreesDir } = options;
  /**
   * 每个 Worker 会话这一轮开始（message.delivered）时库里最大的消息编号，只在内存里。取这一轮最后一段文字时只看它之后的，
   * 不会拿到上一轮的旧文字（上一轮还在跑时项目经理又发了一句，那一句的编号比上一轮的文字小）。重启后没有，就退回只按
   * 这一轮的消息编号算。
   */
  const turnStarts = new Map<SessionId, MessageId>();
  /**
   * 一轮中途送达（message.delivered midTurn）、Worker 还没读到的消息编号，只在内存里。读到（message.processing）时：
   * 用户直接说的话这时才交给项目经理（读到之前点停止会被取消）；没赶上上一轮、claude 为它另起一轮的，这一轮从这里开始算。
   */
  const midTurnWaiting = new Set<MessageId>();
  /**
   * 收工时打断了正在跑的一轮（endIn）的 Worker 会话，只在内存里。这一轮被停止的结局不再汇报给项目经理（它自己叫停的），
   * 下一次一轮结束时清掉。
   */
  const endInterrupted = new Set<SessionId>();
  /**
   * 一轮正常结束时还有后台命令在跑（驱动层的 background.changed 记在 live.backgroundTasks，只有 claude 有）的 Worker 会话，
   * 记在 worker_background_waits（0014）。这一轮不算汇报（不然项目经理会先收到一份“做完了”），会话显示在等后台命令；
   * 命令跑完 claude 自己开一轮叫醒它，那一轮（或中间用户、项目经理的话开的轮）结束、而且没有后台命令了才汇报，
   * 正文是从 turnStart 起最后一段文字。进程先没了（兜底上限到点被关、停止、崩溃、关机）就在 session.exited 时照常交代
   * （flushAwaiting）；守护进程被杀、session.exited 没来的，重启后补发（recoverBackgroundWaits）。
   * background：现在还有没有后台命令（被关进程时说明“被停了”用）。不轮询：只看已有的驱动层事件。
   */
  const awaitingBackground = {
    get: (sessionId: SessionId): BackgroundWait | undefined => {
      const row = db.get<{ turn_start: number; background: number }>("SELECT turn_start, background FROM worker_background_waits WHERE session_id = ?", sessionId);
      return row === undefined ? undefined : { turnStart: row.turn_start, background: row.background === 1 };
    },
    set: (sessionId: SessionId, turnStart: MessageId) =>
      db.run(
        "INSERT OR REPLACE INTO worker_background_waits (session_id, turn_start, background, created_at) VALUES (?, ?, 1, ?)",
        sessionId,
        turnStart,
        now(),
      ),
    setBackground: (sessionId: SessionId, background: boolean) =>
      db.run("UPDATE worker_background_waits SET background = ? WHERE session_id = ?", background ? 1 : 0, sessionId),
    /** 取出并删掉。 */
    take: (sessionId: SessionId): BackgroundWait | undefined => {
      const wait = awaitingBackground.get(sessionId);
      if (wait !== undefined) db.run("DELETE FROM worker_background_waits WHERE session_id = ?", sessionId);
      return wait;
    },
  };

  const workerRow = (id: WorkerId): WorkerDbRow | null => db.get<WorkerDbRow>("SELECT * FROM workers WHERE id = ?", id) ?? null;
  const projectRow = (id: number): ProjectDbRow => db.get<ProjectDbRow>("SELECT * FROM projects WHERE id = ?", id)!;
  /** Worker 的会话（一个 Worker 一个）。 */
  const workerSession = (workerId: WorkerId): AgentSessionRow => currentSession(workerRow(workerId)!.worker_conversation_id)!;
  const mainFolderOf = (projectId: number): string => projectCard(projectRow(projectId)).mainFolder;

  /** 项目经理管着的 Worker：不存在 → not_found；不是它派的 → forbidden。 */
  const ownWorker = (pmId: PmId, workerId: WorkerId): WorkerDbRow => {
    const row = workerRow(workerId);
    if (row === null) throw fail("not_found", `没有编号 ${workerId} 的 Worker`);
    if (row.pm_id !== pmId) throw fail("forbidden", `Worker #${workerId} 不是你派的，管不着`);
    return row;
  };

  const validTask = (raw: unknown, what: string): string => {
    if (typeof raw !== "string" || raw.trim() === "") throw fail("invalid", `${what}不能是空的`);
    if (utf8Bytes(raw) > MAX_TASK_BYTES) throw fail("invalid", `${what}不能超过 ${MAX_TASK_BYTES} 字节`);
    return raw;
  };

  /**
   * 项目经理对话里那一行（WorkerMessageMeta）。deliver：要交给项目经理（report、turn_failed、worktree_failed、user_message），
   * 消息从 queued 起照常走，登记 session.send（source system）；否则只给人看（started、ended）。
   * 去重键带事件类型（workerMessageDedupeKey），重复调用只有一行、只登记一次。
   */
  const insertLine = (
    p: Pending,
    worker: WorkerDbRow,
    line: { event: WorkerEvent; status: WorkerLineStatus | null; summary: string | null; turnMessageId: MessageId | null; deliver: string | null },
  ) => {
    const header = line.event === "user_message" ? userToWorkerHeader(worker.id, worker.title) : workerReportHeader(worker.id, worker.title);
    const meta: WorkerMessageMeta = {
      workerId: worker.id,
      workerConversationId: worker.worker_conversation_id,
      title: worker.title,
      readonly: worker.readonly === 1,
      event: line.event,
      status: line.status,
      summary: line.summary,
    };
    const pmSession = line.deliver === null ? null : currentSession(worker.pm_conversation_id);
    if (line.deliver !== null && pmSession === null) throw new Error(`conversation ${worker.pm_conversation_id} has no agent session`);
    const text = line.deliver === null ? workerLineText(meta) : `${header}\n\n${line.deliver}`;
    const t = now();
    const row = db.get<MessageDbRow>(
      `INSERT INTO messages (conversation_id, session_id, worker_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, ?, 'system', 'worker', ?, ?, ?, ?, ?, ?)
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
      worker.pm_conversation_id,
      pmSession?.id ?? null,
      worker.id,
      text,
      JSON.stringify(meta),
      workerMessageDedupeKey(worker.id, line.event, line.turnMessageId),
      pmSession === null ? null : "queued",
      t,
      t,
    );
    if (row === undefined) return;
    p.changes.push({ type: "message.created", data: { message: toMessage(row) } });
    if (pmSession !== null) enqueue(p, { type: "session.send", params: { sessionId: pmSession.id, messageId: row.id, source: "system" } });
  };

  /** Worker 对话里一条项目经理的话（任务说明、打回），和用户消息一样从 queued 起走。 */
  const insertPmMessage = (p: Pending, worker: WorkerDbRow, session: AgentSessionRow, text: string, dedupeKey: string) => {
    const t = now();
    const row = db.get<MessageDbRow>(
      `INSERT INTO messages (conversation_id, session_id, worker_id, sender, kind, text, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, ?, 'pm', 'text', ?, ?, 'queued', ?, ?) RETURNING *`,
      worker.worker_conversation_id,
      session.id,
      worker.id,
      text,
      dedupeKey,
      t,
      t,
    )!;
    p.changes.push({ type: "message.created", data: { message: toMessage(row) } });
    return row;
  };

  /**
   * 收工了：Worker 对话里还在排队、没发给它的话标已停止，不会再发（比如 worktree 还没建好就收工了的任务说明）。
   * 正在跑的那一轮在这之前已经按网页“停止”的路径打断了（endIn）。
   */
  const stopQueued = (p: Pending, worker: WorkerDbRow) => {
    for (const row of db.all<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? AND status = 'queued'", worker.worker_conversation_id)) {
      transition(p, row.id, "stopped");
    }
  };

  /** 起 Worker 的会话、把任务说明发给它（主文件夹里干的派活时就做，worktree 的建好了再做）。 */
  const enqueueFirstTurn = (p: Pending, worker: WorkerDbRow) => {
    const session = workerSession(worker.id);
    const task = db.get<{ id: number }>("SELECT id FROM messages WHERE dedupe_key = ?", taskDedupeKey(worker.id))!;
    enqueue(p, { type: "session.start", params: { sessionId: session.id, generation: session.generation } });
    enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId: task.id, source: "user" } });
  };

  // ---- hub worker …（只给项目经理，见 shared/hub.ts 的 HUB_COMMAND_ROLES）----

  /**
   * git 没跑成时拒绝派活的话（m3-plan 第 2.6 节：不默默改成在主文件夹里干）。409 git_failed，不算接口故障。
   * 原因取输出里第一条 fatal: 或 error: 开头的行，没有就取最后一个非空行（第一行常是 “Preparing worktree…” 这类进度），截到 GIT_REASON_MAX_CHARS 字。
   */
  const gitFailed = (output: string) =>
    fail("git_failed", `git 没跑成：${gitReasonLine(output)}。可以重试；或者加 --no-worktree，明确让 Worker 在主文件夹里干。`);

  const startIn = (
    p: Pending,
    caller: AgentSessionRow & { pmId: PmId },
    args: HubArgs<"worker.start">,
    context: HubCallContext,
  ): HubResult<"worker.start"> => {
    const project = activeProjectOf(caller.pmId);
    if (project === null) throw fail("invalid", `你还没有项目，没法派 Worker：先用 ${HUB_COMMAND} project create --folder <主文件夹> 建一个`);
    const title = typeof args.title === "string" ? normalizeWorkerTitle(args.title) : null;
    if (title === null) throw fail("invalid", "Worker 的标题不能是空的，也不能带换行等控制字符");
    const task = validTask(args.task, "任务说明");
    // 模型、思考程度按目标厂商清单查；同厂商不给就用项目经理会话现在的，换厂商不给就用 null
    let vendor = caller.vendor as AgentVendor;
    if (args.vendor !== undefined) {
      if (!isAgentVendor(args.vendor)) throw fail("invalid", `厂商只能是 ${AGENT_VENDORS.join("、")}`);
      vendor = args.vendor;
      // 这台设备上没装、没登录（agent 接口查过，没登录的先重问过一次）：不派，说清楚是哪台、怎么登录
      const status = context.vendorStatus;
      const unusable = status?.vendor === vendor ? vendorUnavailableMessage(vendor, status.availability, status.device) : null;
      if (unusable !== null) throw fail("invalid", unusable);
    }
    const givenModel = typeof args.model === "string" ? args.model.trim() || null : null;
    const givenEffort = typeof args.effort === "string" ? args.effort.trim() || null : null;
    const badSetting = checkModel(vendor, givenModel) ?? checkEffort(vendor, givenEffort) ?? checkModelEffort(vendor, givenModel, givenEffort);
    if (badSetting !== null) throw fail("invalid", badSetting);
    // 思考程度写在模型 ID 里的厂商（agy）：--model gemini-4-argon-high 和 --model gemini-4-argon --effort high 存成一样的 模型 + 思考程度
    const { model, effort } = splitModelEffort(vendor, givenModel, givenEffort);
    const readonly = args.readonly === true;
    // Worker（不论普通还是只读、不论哪家厂商）一律要求 OS 沙箱就绪；起不来直接报错拒绝派活，不退回规则兜底（docs/linux-sandbox-design.md 第 3.2 节）
    if (!ctx.osSandboxed()) throw fail("invalid", WORKER_NEEDS_OS_SANDBOX_MESSAGE);
    const card = projectCard(project);
    let probe = { isRepoWithCommit: false, hasUncommittedChanges: false };
    if (args.noWorktree !== true) {
      const workspaceProbe = context.workspace;
      if (workspaceProbe === undefined) throw new Error("worker.start without noWorktree needs context.workspace (probe the main folder first)");
      if (workspaceProbe.kind === "failed") throw gitFailed(workspaceProbe.error);
      probe = workspaceProbe;
    }
    const workspace = probe.isRepoWithCommit ? "worktree" : "main";
    const t = now();

    const conversation = toConversation(
      db.get<ConversationDbRow>(
        "INSERT INTO conversations (kind, pm_id, project_id, title, created_at) VALUES ('worker', ?, ?, ?, ?) RETURNING *",
        caller.pmId,
        project.id,
        title,
        t,
      )!,
    );
    p.changes.push({ type: "conversation.created", data: { conversation } });
    // 编号要先有才能定分支和目录：worktree 的先占个空串（满足 CHECK），马上改成真的
    const id = db.run(
      `INSERT INTO workers (project_id, pm_id, pm_conversation_id, worker_conversation_id, title, task, model, effort, readonly, workspace,
                            branch, worktree_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      project.id,
      caller.pmId,
      project.conversation_id,
      conversation.id,
      title,
      task,
      model,
      effort,
      readonly ? 1 : 0,
      workspace,
      workspace === "worktree" ? "" : null,
      workspace === "worktree" ? "" : null,
      t,
      t,
    ).lastInsertRowid;
    if (workspace === "worktree") {
      db.run(
        "UPDATE workers SET branch = ?, worktree_path = ? WHERE id = ?",
        workerBranchName(id, title),
        workerWorktreePath(worktreesDir, project.id, id),
        id,
      );
    }
    const worker = workerRow(id)!;
    const sameVendor = vendor === caller.vendor;
    // 没给的沿用项目经理现在的（也按 模型 + 思考程度 拆开：老数据里存的可能是带档位的完整 ID）
    const inherited = sameVendor ? splitModelEffort(vendor, caller.model, caller.effort) : { model: null, effort: null };
    const session = insertSession(p, {
      role: "worker",
      conversationId: conversation.id,
      pmId: null,
      workerId: id,
      cwd: worker.worktree_path ?? card.mainFolder,
      addDirs: workspace === "worktree" ? [] : card.otherFolders,
      generation: 1,
      vendor,
      model: model ?? inherited.model,
      effort: effort ?? inherited.effort,
    });
    insertPmMessage(p, worker, session, task, taskDedupeKey(id));
    insertLine(p, worker, { event: "started", status: null, summary: null, turnMessageId: null, deliver: null });
    if (workspace === "worktree") {
      enqueue(p, { type: "worktree.create", params: { workerId: id } });
      // 项目经理的会话带上 worktrees/<项目编号>/，验收时能看 Worker 的改动（下一条消息前自动重启生效）
      syncSessionFolders(project);
    } else {
      enqueueFirstTurn(p, worker);
    }

    const notes = [`已派出 Worker #${id}“${title}”，${describeWorkspace(worker, card.mainFolder)}`];
    if (workspace === "main" && args.noWorktree !== true) notes.push("（主文件夹不是有提交的 git 仓库，所以没建 worktree）");
    if (readonly) notes.push("。它是只读的，只看不改");
    notes.push(`。它每做完一轮，汇报会自动发给你；打回用 ${HUB_COMMAND} worker send ${id} --stdin，收工用 ${HUB_COMMAND} worker end ${id}。`);
    if (workspace === "worktree" && project.setup_command !== null) notes.push(SETUP_RECEIPT_NOTE);
    if (workspace === "worktree" && probe.hasUncommittedChanges) notes.push(WORKTREE_DIRTY_NOTE);
    return { text: notes.join(""), data: { worker: toWorkerRecord(worker) } };
  };

  const sendIn = (p: Pending, caller: AgentSessionRow & { pmId: PmId }, args: HubArgs<"worker.send">): HubResult<"worker.send"> => {
    const worker = ownWorker(caller.pmId, args.workerId);
    if (worker.status === "ended") throw fail("conflict", `Worker #${worker.id} 已经收工了，要接着做请重新派一个`);
    // 还没开工（在建 worktree、跑准备命令）：第一轮必须是任务说明，现在发的话会让会话提前起来
    if (notStarted(worker)) throw fail("conflict", `Worker 还在准备，等它开工后再发（Worker #${worker.id} 在建 worktree 或跑项目的准备命令）`);
    const text = validTask(args.text, "要发给 Worker 的话");
    const session = workerSession(worker.id);
    // 和用户在网页上手打一样：隐藏的命令（/clear 会换会话 ID，之后接回的是旧对话）不发，hub 退出码 1 打印原因（原因由厂商实现给）
    const blocked = ctx.commandBlockReason(session, text);
    if (blocked !== null) throw fail("invalid", blocked);
    const message = insertPmMessage(p, worker, session, text, sendDedupeKey(worker.id));
    enqueue(p, { type: "session.send", params: { sessionId: message.session_id!, messageId: message.id, source: "user" } });
    // /compact 这一轮只压缩上下文、没有汇报（afterDriverEvent）：别让项目经理干等
    const compactOnly = composerBaseOf(session.vendor)?.isCompactCommand(text) === true;
    return {
      text: compactOnly
        ? `已发给 Worker #${worker.id}“${worker.title}”：这一轮只压缩上下文，不会有汇报，压缩完它就空闲了，不用等。`
        : `已发给 Worker #${worker.id}“${worker.title}”，它会接着做，做完一轮汇报会自动发给你。`,
      data: { worker: toWorkerRecord(worker), messageId: message.id },
    };
  };

  const endIn = (p: Pending, caller: AgentSessionRow & { pmId: PmId }, args: HubArgs<"worker.end">): HubResult<"worker.end"> => {
    const worker = ownWorker(caller.pmId, args.workerId);
    if (worker.status === "ended") {
      return { text: `Worker #${worker.id}“${worker.title}”已经收工了，什么也没做。`, data: { worker: toWorkerRecord(worker) } };
    }
    const session = workerSession(worker.id);
    // 正在跑（一轮没结束、或有排队待送的消息）：先走和网页“停止”同一条打断路径（messages.ts 的 stopIn）。还没开工的在准备中，没有这一轮
    const interrupted = !notStarted(worker) && stopIn(p, { ...session, conversationId: worker.worker_conversation_id });
    if (interrupted) endInterrupted.add(session.id);
    db.run("UPDATE workers SET status = 'ended', updated_at = ? WHERE id = ?", now(), worker.id);
    const ended = workerRow(worker.id)!;
    // 正在跑就等这一轮回完再关，然后作废令牌（session.end 的处理函数）
    enqueue(p, { type: "session.end", params: { sessionId: session.id, generation: session.generation } });
    stopQueued(p, ended);
    insertLine(p, ended, { event: "ended", status: null, summary: null, turnMessageId: null, deliver: null });
    const cleanup =
      ended.workspace === "worktree"
        ? ` worktree ${ended.worktree_path} 和分支 ${ended.branch} 还在：合并完用 git worktree remove ${ended.worktree_path} 删掉 worktree。`
        : "";
    const interruptNote = interrupted ? "已打断正在跑的那一轮。" : "";
    return { text: `Worker #${ended.id}“${ended.title}”已收工。${interruptNote}${cleanup}`, data: { worker: toWorkerRecord(ended) } };
  };

  const list = (caller: AgentSessionRow & { pmId: PmId }): HubResult<"worker.list"> => {
    const rows = db.all<WorkerDbRow>("SELECT * FROM workers WHERE pm_id = ? ORDER BY id", caller.pmId);
    if (rows.length === 0) return { text: "你还没有派过 Worker。", data: { workers: [] } };
    const lines = rows.map((w) => {
      const where = w.workspace === "worktree" ? `worktree ${w.worktree_path}（分支 ${w.branch}）` : "主文件夹";
      const state = w.status === "ended" ? "已收工" : liveOf(workerSession(w.id).id).activity === "preparing" ? "准备中" : "进行中";
      // 实际用的：会话那一行（--model、--effort 没给时是派活时项目经理的）
      const session = workerSession(w.id);
      const shown = agentSettingOf(ctx, session);
      const setting = `模型 ${shown.model} · 思考程度 ${shown.effort}`;
      return `#${w.id} ${w.title} · ${state} · ${where} · ${setting}${w.readonly === 1 ? " · 只读" : ""}`;
    });
    return { text: `你派出的 Worker：\n${lines.join("\n")}`, data: { workers: rows.map(toWorkerRecord) } };
  };

  /** Worker 调 hub status：我是哪个 Worker、任务是什么、在哪干活。 */
  const status = (caller: AgentSessionRow): HubResult<"status"> => {
    const worker = workerRow(caller.workerId!)!;
    const pm = pmRow(worker.pm_id)!;
    const card = projectCard(projectRow(worker.project_id));
    const data: WorkerHubStatus = {
      role: "worker",
      pm: { id: pm.id, name: pm.name },
      sessionId: caller.id,
      conversationId: worker.worker_conversation_id,
      worker: toWorkerRecord(worker),
      project: card,
    };
    const readonly = worker.readonly === 1 ? "只读（只看不改），" : "";
    const text =
      `你是 Worker #${worker.id}“${worker.title}”，项目经理“${pm.name}”派的，${readonly}${describeWorkspace(worker, card.mainFolder)}。` +
      `\n\n任务说明：\n${worker.task}`;
    return { text, data };
  };

  // ---- 驱动层事件：Worker 这一轮结束 ----

  /** 在 applyDriverEvent 的同一个事务里、消息状态改完之后调。不是 Worker 的会话、不是一轮结束，什么也不做。 */
  /**
   * 这一轮没做完：一行 turn_failed，原因交给项目经理。去重键是这一轮（或发不出去的那条）消息的编号。
   * 这一轮里有用户直接对 Worker 说的话：带上原文；标了失败的写明用户那边可以自己点重试（不用项目经理转告）。
   */
  const insertTurnFailed = (p: Pending, worker: WorkerDbRow, turnMessageId: MessageId, messageIds: MessageId[], reason: string) => {
    const lines = [`这一轮没做完：${reason}。要它接着做用 ${HUB_COMMAND} worker send ${worker.id} --stdin，不要了用 ${HUB_COMMAND} worker end ${worker.id}。`];
    for (const id of messageIds) {
      const message = db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", id);
      if (message === undefined || message.sender !== "user" || message.worker_id !== worker.id) continue;
      const retry = message.status === "failed" ? "用户那边会看到发送失败，可以自己点重试。" : "";
      lines.push(`这一轮里有用户直接对它说的话：「${message.text}」。${retry}`);
    }
    insertLine(p, worker, { event: "turn_failed", status: null, summary: reason, turnMessageId, deliver: lines.join("\n") });
  };

  /**
   * Worker 收到了用户直接对它说的话（message.delivered；一轮中途送达的等 message.processing，读到之前可能被停止取消）：
   * 每条一行 user_message，原文交给项目经理（不打断它，系统消息等它空闲再发）。只认 Worker 对话里带 Worker 编号的用户消息，而且真的写进去了（已送达、处理中、已回复；已停止、失败的
   * 不算）；重启后重发再送达，去重键挡住，不会出两行。
   */
  const insertUserMessageLines = (p: Pending, workerId: WorkerId, messageIds: MessageId[]) => {
    const worker = workerRow(workerId);
    if (worker === null) return;
    for (const id of messageIds) {
      const message = db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", id);
      if (message === undefined || message.sender !== "user" || message.worker_id !== workerId) continue;
      if (!RECEIVED_STATUSES.has(message.status ?? "")) continue;
      // 交给项目经理的带上附件的完整路径（和写给 Worker 的一样，见 shared/attachments.ts 的 agentTextOf）
      const deliver = agentTextOf(toMessage(message));
      insertLine(p, worker, { event: "user_message", status: null, summary: message.text, turnMessageId: id, deliver });
    }
  };

  /**
   * 这一轮（turnStart 之后）只是用户发的 /compact：手动压缩过（context.compacted 的 trigger 是 manual，messages.ts 记的系统消息），
   * 而且这个会话在这一轮里没有任何 agent 消息（文字、工具调用都算）。自动压缩（trigger 不是 manual）不算：
   * 那是 Worker 做长任务时顺带压的，这一轮照常要汇报，否则项目经理会一直干等。
   */
  const onlyManualCompact = (session: AgentSessionRow, turnStart: number): boolean =>
    session.conversationId !== null &&
    db.get(
      `SELECT 1 AS x FROM messages WHERE conversation_id = ? AND sender = 'system' AND id > ?
       AND json_extract(meta, '$.event') = 'context.compacted' AND json_extract(meta, '$.sessionId') = ?
       AND json_extract(meta, '$.trigger') = 'manual' LIMIT 1`,
      session.conversationId,
      turnStart,
      session.id,
    ) !== undefined &&
    db.get(`SELECT 1 AS x FROM messages WHERE session_id = ? AND sender = 'agent' AND id > ? LIMIT 1`, session.id, turnStart) === undefined;

  const maxMessageId = () => db.get<{ id: number | null }>("SELECT max(id) AS id FROM messages")!.id ?? 0;

  /** 这一轮从 turnStart 起最后一条 agent 消息的编号（汇报的去重键）；什么都没有是 null。 */
  const lastAgentMessageId = (sessionId: SessionId, turnStart: number): MessageId | null =>
    db.get<{ id: number | null }>(`SELECT max(id) AS id FROM messages WHERE session_id = ? AND sender = 'agent' AND id > ?`, sessionId, turnStart)!.id;

  /** 从 turnStart 起这个会话最后一段 agent 文字；没有是空串。 */
  const lastAgentText = (sessionId: SessionId, turnStart: number): string =>
    db.get<{ text: string }>(
      `SELECT text FROM messages WHERE session_id = ? AND sender = 'agent' AND kind = 'text' AND id > ? ORDER BY id DESC LIMIT 1`,
      sessionId,
      turnStart,
    )?.text ?? "";

  /** 按格式解析这一轮最后的文字，一行 report 交给项目经理；note 不是 null 就加在交给它的正文前面。 */
  const insertReport = (p: Pending, worker: WorkerDbRow, turnMessageId: MessageId, text: string, note: string | null = null) => {
    const parsed = parseWorkerReport(text);
    const body = text.trim() === "" ? NO_REPLY_TEXT : text;
    insertLine(p, worker, {
      event: "report",
      status: parsed.kind === "ok" ? parsed.report.status : "unformatted",
      summary: parsed.kind === "ok" ? parsed.report.summary : parsed.summary,
      turnMessageId,
      deliver: note === null ? body : `${note}\n\n${body}`,
    });
  };

  /**
   * 在等后台命令时进程没了（awaitingBackground，session.exited 不带在途消息）：不再有人叫醒它，把等着的这一轮交代给项目经理。
   * 停止 → 被停止了；崩溃 → 出错；空闲关闭（后台命令还在就是到了兜底上限被关）、关机 → 照常汇报，后台命令被停了的在正文前说明。
   * 已收工的不发（项目经理自己收的工）。
   */
  const flushAwaiting = (p: Pending, session: AgentSessionRow, event: Extract<DriverEvent, { type: "session.exited" }>, awaiting: BackgroundWait) => {
    endInterrupted.delete(session.id);
    const worker = workerRow(session.workerId!);
    if (worker === null || worker.status === "ended") return;
    const turnMessageId = lastAgentMessageId(session.id, awaiting.turnStart);
    if (turnMessageId === null) return;
    if (event.reason === "interrupt") return insertTurnFailed(p, worker, turnMessageId, [], TURN_STOPPED);
    if (event.reason === "crash" || event.reason === "startup_failed") return insertTurnFailed(p, worker, turnMessageId, [], exitFailureReason(event));
    insertReport(p, worker, turnMessageId, lastAgentText(session.id, awaiting.turnStart), awaiting.background ? backgroundKilledNote(event.reason) : null);
  };

  const afterDriverEvent = (p: Pending, session: AgentSessionRow, event: DriverEvent) => {
    if (session.role !== "worker" || session.workerId === null) return;
    if (event.type === "background.changed") {
      awaitingBackground.setBackground(session.id, event.count > 0);
      return;
    }
    if (event.type === "session.exited") {
      const awaiting = awaitingBackground.take(session.id);
      // 有在途消息的（一轮跑到一半进程没了）照下面的老路交代那一轮
      if (awaiting !== undefined && event.messageIds.length === 0) return flushAwaiting(p, session, event, awaiting);
    }
    if (event.type === "message.delivered") {
      // 一轮中途交给它的不算这一轮的开头（这一轮前面的文字还要算进汇报），用户的话也等它读到再告诉项目经理
      if (event.midTurn === true) {
        for (const id of event.messageIds) midTurnWaiting.add(id);
        return;
      }
      turnStarts.set(session.id, maxMessageId());
      insertUserMessageLines(p, session.workerId, event.messageIds);
      return;
    }
    if (event.type === "message.processing") {
      const taken = event.messageIds.filter((id) => midTurnWaiting.delete(id));
      if (taken.length === 0) return;
      // 没赶上上一轮（上一轮已经结束、turnStarts 删了）：claude 为它另起的这一轮从这里开始，不会再拿到上一轮的文字
      if (!turnStarts.has(session.id)) turnStarts.set(session.id, maxMessageId());
      insertUserMessageLines(p, session.workerId, taken);
      return;
    }
    if (event.type === "message.cancelled" || event.type === "message.requeued") {
      for (const id of event.messageIds) midTurnWaiting.delete(id);
      return;
    }
    if (event.type === "turn.started") {
      turnStarts.set(session.id, maxMessageId());
      return;
    }
    const outcome = turnOutcome(event);
    if (outcome === null) return;
    const worker = workerRow(session.workerId);
    if (worker === null) return;
    // 自己开的一轮（没有消息编号）只认 turn.started 开的头；游离的 turn.ended 不处理
    if (outcome.turnMessageId === null && !turnStarts.has(session.id)) return;
    // 有这一轮开头的记录就用它；没有（重启后）退回这一轮最大的消息编号。不取两者大的那个：一轮中途送达的消息编号
    // 比这一轮前面的文字大，取它会漏掉前面的汇报。之前有一轮在等后台命令没汇报：从那一轮的开头算
    const awaiting = awaitingBackground.take(session.id);
    const turnStart = awaiting?.turnStart ?? turnStarts.get(session.id) ?? outcome.turnMessageId ?? 0;
    turnStarts.delete(session.id);
    // 收工时打断的这一轮：被停止了不再汇报（项目经理自己叫停的）
    if (endInterrupted.delete(session.id) && outcome.event === "turn_failed" && outcome.reason === TURN_STOPPED) return;
    // 正常结束、还有后台命令在跑：先不汇报，等命令跑完叫醒它、它再结束一轮（见 awaitingBackground）
    if (outcome.event === "report" && event.type === "turn.ended" && (liveOf(session.id).backgroundTasks ?? 0) > 0) {
      awaitingBackground.set(session.id, turnStart);
      updateLive(p, session.id, (l) => {
        l.activity = "background";
      });
      return;
    }
    // 自己开的一轮没有用户消息的编号：用这一轮最后一条 agent 消息的编号做键（重放的 agent 消息按 uuid 去重，编号不变）；这一轮什么都没做就不汇报
    const turnMessageId = outcome.turnMessageId ?? lastAgentMessageId(session.id, turnStart);
    if (turnMessageId === null) return;
    if (outcome.event === "turn_failed") {
      insertTurnFailed(p, worker, turnMessageId, outcome.messageIds, outcome.reason);
      return;
    }
    // 这一轮最后一段文字：这一轮开始之后、这个会话的 agent 文字里最新的一条；没有就是“没有文字回复”
    const text = lastAgentText(session.id, turnStart);
    // 自己开的一轮只有工具调用、没有文字：没什么可汇报的
    if (outcome.turnMessageId === null && text.trim() === "") return;
    // 只压缩了上下文（用户发的 /compact）、没有任何 agent 消息的一轮：不汇报，对话里那行“已压缩上下文”照留
    if (onlyManualCompact(session, turnStart)) return;
    insertReport(p, worker, turnMessageId, text);
  };

  /**
   * 重启恢复（在 recoverAfterRestart 里调）：上次运行没交代完的“在等后台命令”（守护进程被杀、session.exited 没来）。
   * 后台命令随旧进程没了，不会再有人叫醒它：每个照常补发一次汇报（它中断前最后一轮的文字），正文前说明因重启中断；
   * 不恢复会话让它接着干（后台命令的结果已经没了，接着干也得重跑，交给项目经理定）。已收工的只删记录。
   * 去重键同那一轮的汇报，重复调用只有一行。
   */
  const recoverBackgroundWaits = () =>
    write((p) => {
      const waits = db.all<{ session_id: number; turn_start: number; worker_id: number | null }>(
        `SELECT b.session_id, b.turn_start, s.worker_id FROM worker_background_waits b
         JOIN agent_sessions s ON s.id = b.session_id ORDER BY b.session_id`,
      );
      db.run("DELETE FROM worker_background_waits");
      for (const wait of waits) {
        const worker = wait.worker_id === null ? null : workerRow(wait.worker_id);
        if (worker === null || worker.status === "ended") continue;
        const turnMessageId = lastAgentMessageId(wait.session_id, wait.turn_start);
        if (turnMessageId === null) continue;
        insertReport(p, worker, turnMessageId, lastAgentText(wait.session_id, wait.turn_start), backgroundKilledNote("restart"));
      }
    });

  // ---- 建 worktree（worktree.create 处理函数用）----

  const getWorktreeTask = (workerId: WorkerId): WorktreeTask | null => {
    const worker = workerRow(workerId);
    if (worker === null || worker.workspace !== "worktree") return null;
    return {
      workerId,
      sessionId: workerSession(workerId).id,
      repo: mainFolderOf(worker.project_id),
      branch: worker.branch!,
      worktreePath: worker.worktree_path!,
      status: worker.status as WorktreeTask["status"],
      setupCommand: projectRow(worker.project_id).setup_command,
    };
  };

  /**
   * 准备命令开始跑：Worker 的会话显示“准备中”（网页的状态行、hub worker list）。返回真的进了准备中没有：
   * Worker 不在了、已收工（比如建 worktree 的时候收工了）、已经开工的不改，返回 false，调用方就不跑准备命令。
   */
  const onSetupStarted = (workerId: WorkerId): boolean =>
    write((p) => {
      const worker = workerRow(workerId);
      if (worker === null || worker.workspace !== "worktree" || worker.status === "ended" || worker.base_commit !== null) return false;
      updateLive(p, workerSession(workerId).id, (l) => {
        l.activity = "preparing";
        l.currentTool = null;
        l.step = null;
      });
      return true;
    });

  /**
   * session.send 处理函数问（兜底，不管消息从哪来）：这条消息要不要先等着，免得 Worker 的会话被它提前拉起来、第一轮不是任务说明。
   * Worker 的会话、Worker 还开着时：还没开工（worktree 没建好、准备命令在跑）→ 什么都等；开工了、任务说明还在排队 → 除了任务说明都等。
   */
  const waitsForFirstTurn = (sessionId: SessionId, messageId: MessageId): boolean => {
    const workerId = db.get<{ worker_id: number | null }>("SELECT worker_id FROM agent_sessions WHERE id = ?", sessionId)?.worker_id ?? null;
    const worker = workerId === null ? null : workerRow(workerId);
    if (worker === null || worker.status === "ended") return false;
    if (notStarted(worker)) return true;
    const task = db.get<{ id: number; status: string }>("SELECT id, status FROM messages WHERE dedupe_key = ?", taskDedupeKey(worker.id));
    return task !== undefined && task.status === "queued" && task.id !== messageId;
  };

  /**
   * base_commit 和第一轮的两个动作在同一个事务里写，所以 base_commit 已经有了就说明做过了，重复调用什么也不做。
   * setup：准备命令跑完的结果，加在任务说明（Worker 对话里第一条消息）前面，推 message.updated；workers.task 留原文。
   * 准备中、正在停（网页上点了停止）的状态先回到空闲，收工了也一样。
   */
  const onWorktreeCreated = (workerId: WorkerId, baseCommit: string, setup?: SetupOutcome) => {
    write((p) => {
      const worker = workerRow(workerId);
      if (worker === null || worker.workspace !== "worktree" || worker.base_commit !== null) return;
      // 还没开工，会话没起过：准备中、正在停只可能是准备命令那段留下的
      const sessionId = workerSession(workerId).id;
      const activity = liveOf(sessionId).activity;
      if (activity === "preparing" || activity === "stopping") updateLive(p, sessionId, idle);
      if (worker.status === "ended") return;
      db.run("UPDATE workers SET base_commit = ?, updated_at = ? WHERE id = ?", baseCommit, now(), workerId);
      if (setup !== undefined) {
        const task = db.get<MessageDbRow>("SELECT * FROM messages WHERE dedupe_key = ?", taskDedupeKey(workerId))!;
        const row = db.get<MessageDbRow>(
          "UPDATE messages SET text = ?, updated_at = ? WHERE id = ? RETURNING *",
          `${setupNote(setup)}\n\n${task.text}`,
          now(),
          task.id,
        )!;
        p.changes.push({ type: "message.updated", data: { message: toMessage(row) } });
      }
      enqueueFirstTurn(p, worker);
    });
  };

  /**
   * 重启恢复（在 recoverAfterRestart 里调）：还没开工的 worktree Worker（open、base_commit 还是 NULL：worktree 没建完，
   * 或者准备命令被关机打断了）重新登记 worktree.create。done 的那一行按 NewAction 的规则重置成 pending；
   * addWorktree 重复执行算成功，准备命令从头再跑。返回登记了哪些 Worker。
   */
  const recoverWorktrees = (): WorkerId[] =>
    write((p) => {
      const ids = db
        .all<{ id: number }>("SELECT id FROM workers WHERE status = 'open' AND workspace = 'worktree' AND base_commit IS NULL ORDER BY id")
        .map((r) => r.id);
      for (const id of ids) enqueue(p, { type: "worktree.create", params: { workerId: id } });
      return ids;
    });

  /**
   * 动作彻底失败（ledger.onActionFailed，在同一个事务里、messages.ts 改完消息状态之后调）：
   * - worktree.create：Worker 标 ended、登记它会话的 session.end（同 endIn），项目经理对话里一行 worktree_failed 并交给它，
   *   任务说明标 failed；
   * - session.send 发的是 Worker 对话里项目经理或用户的话（Worker 起不来、消息写不进去）：一行 turn_failed 交给项目经理。
   *   Worker 已经收工的不发（收工后发不出去是意料之中的）。
   */
  const actionFailedIn = (p: Pending, action: AnyActionRow, error: string) => {
    if (action.type === "worktree.create") {
      const worker = workerRow(action.params.workerId);
      if (worker === null) return;
      if (worker.status !== "ended") {
        db.run("UPDATE workers SET status = 'ended', updated_at = ? WHERE id = ?", now(), worker.id);
        const session = workerSession(worker.id);
        enqueue(p, { type: "session.end", params: { sessionId: session.id, generation: session.generation } });
      }
      const deliver = `建 worktree 失败，这个 Worker 没能开工，已经收工：${error}。要的话修好问题后重新派一个。`;
      insertLine(p, workerRow(worker.id)!, { event: "worktree_failed", status: null, summary: error, turnMessageId: null, deliver });
      const task = db.get<{ id: number }>("SELECT id FROM messages WHERE dedupe_key = ?", taskDedupeKey(worker.id));
      if (task !== undefined) transition(p, task.id, "failed", error);
      return;
    }
    if (action.type !== "session.send") return;
    const message = db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", action.params.messageId);
    if (message === undefined || (message.sender !== "pm" && message.sender !== "user") || message.worker_id === null) return;
    const worker = workerRow(message.worker_id);
    if (worker === null || worker.status === "ended") return;
    insertTurnFailed(p, worker, message.id, [message.id], error);
  };

  /** agent 接口在 worker.show 之前查 PR 用：这个项目经理派的、在 worktree 里干活的 Worker 的 worktree 目录和分支；别的 null。 */
  const workerPrTarget = (session: AgentSessionRow | null, workerId: WorkerId): { cwd: string; branch: string } | null => {
    if (session === null || session.role !== "pm" || session.pmId === null) return null;
    const worker = workerRow(workerId);
    if (worker === null || worker.pm_id !== session.pmId || worker.workspace !== "worktree") return null;
    if (worker.worktree_path === null || worker.branch === null || worker.base_commit === null) return null;
    return { cwd: worker.worktree_path, branch: worker.branch };
  };

  /**
   * agent 接口在 worker.show 之前找“原始记录”用：这个 Worker 当前会话在厂商那边的三样索引（agent_sessions 的 vendor、vendor_session_id、cwd）。
   * 不是项目经理的会话、不是它派的 → null。
   */
  const workerTranscriptTarget = (session: AgentSessionRow | null, workerId: WorkerId): { vendor: string; vendorSessionId: string; cwd: string } | null => {
    if (session === null || session.role !== "pm" || session.pmId === null) return null;
    const worker = workerRow(workerId);
    if (worker === null || worker.pm_id !== session.pmId) return null;
    const target = workerSession(workerId);
    return { vendor: target.vendor, vendorSessionId: target.vendorSessionId, cwd: target.cwd };
  };

  /** agent 接口在 worker.start 之前探 git 用：这个会话所属项目经理的项目主文件夹；不是项目经理的会话、还没有项目 → null。 */
  const workerStartFolder = (session: AgentSessionRow | null): string | null => {
    if (session === null || session.role !== "pm" || session.pmId === null) return null;
    const project = activeProjectOf(session.pmId);
    return project === null ? null : projectCard(project).mainFolder;
  };

  // ---- 启动上下文 ----

  /** Worker 会话的 LaunchContext（见 shared/ledger.ts）；不是 Worker 的会话返回 null。 */
  const launchContextFor = (session: AgentSessionRow): LaunchContext | null => {
    if (session.role !== "worker" || session.workerId === null) return null;
    const worker = workerRow(session.workerId);
    if (worker === null) return null;
    const pm = pmRow(worker.pm_id)!;
    return {
      sessionId: session.id,
      role: "worker",
      conversationId: worker.worker_conversation_id,
      pm: { id: pm.id, name: pm.name, mode: pm.mode as PmMode, persona: pm.persona ?? "" },
      project: projectCard(projectRow(worker.project_id)),
      worker: toWorkerRecord(worker),
      ...(isAgentVendor(session.vendor) ? { vendor: session.vendor } : {}),
    };
  };

  return {
    startIn,
    sendIn,
    endIn,
    list,
    status,
    afterDriverEvent,
    getWorktreeTask,
    onSetupStarted,
    waitsForFirstTurn,
    onWorktreeCreated,
    recoverWorktrees,
    recoverBackgroundWaits,
    actionFailedIn,
    workerStartFolder,
    workerPrTarget,
    workerTranscriptTarget,
    ownWorker,
    workerSession,
    launchContextFor,
  };
}
