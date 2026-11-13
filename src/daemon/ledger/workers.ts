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
// - 换人接手同一步（hub worker start --node 给已有前任的节点派人，docs/orchestration-simplify-design.md 第 4.4、5.2 节）：
//   先把节点上还挂着的旧 Worker 按“没做完”收工，新 Worker 接着用最近一个 worktree 还在的前任的目录和分支（不建 worktree、不跑准备命令，
//   旧会话结束前不开工：waitsForFirstTurn），第一条消息是“【系统 · 接手】”带前任的记录（takeover.ts 现取现拼）；
// - 单轮超时计时落盘（worker_turn_timeouts，迁移 0024），重启后按库里的截止时刻重新挂（recoverTurnTimeouts）；
// - worktree 自动清理前按目录判断还有没有人在用、所属任务图结束没有（isWorkerCleanable）。
// 汇报格式、解析、那一行的写法、分支名在 shared/worker.ts；按角色放行的表在 shared/hub.ts；git 在 daemon/git/。
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { AnyActionRow } from "../../shared/actions.ts";
import { agentTextOf } from "../../shared/attachments.ts";
import { normalizeWorkerTitle, systemMessageDedupeKey, utf8Bytes, workerMessageDedupeKey } from "../../shared/domain.ts";
import type {
  AgentSessionRow,
  ConversationId,
  MessageId,
  PmId,
  PmMode,
  SessionId,
  SystemMessageMeta,
  WorkerEvent,
  WorkerId,
  WorkerLineStatus,
  WorkerMessageMeta,
  WorkerRecord,
} from "../../shared/domain.ts";
import { turnFailureReason, type DriverEvent } from "../../shared/driver.ts";
import type { HubArgs, HubResult, WorkerHubStatus } from "../../shared/hub.ts";
import type { HubCallContext, LaunchContext, SetupOutcome, WorktreeTask } from "../../shared/ledger.ts";
import {
  DEFAULT_WORKER_MAX_TIME_MS,
  GIT_REASON_MAX_CHARS,
  MAX_TASK_BYTES,
  TAKEOVER_PREDECESSORS_MAX,
  WORKER_BACKGROUND_HOLD_MAX_MS,
  WORKER_LIST_RECENT_ENDED,
  WORKTREE_RETENTION_DAYS,
} from "../../shared/limits.ts";
import { checkWorkerMaxTimeMs, formatDurationShort } from "../../shared/schedule.ts";
import { AGENT_VENDORS, checkEffort, checkModel, checkModelEffort, isAgentVendor, splitModelEffort, vendorUnavailableMessage } from "../../shared/vendors.ts";
import type { AgentVendor } from "../../shared/vendors.ts";
import { HUB_COMMAND } from "../../shared/names.ts";
import { workerWorktreePath } from "../../shared/paths.ts";
import {
  parseWorkerReport,
  userToWorkerHeader,
  workerBranchName,
  workerLineText,
  workerReportHeader,
  type ParsedWorkerReport,
} from "../../shared/worker.ts";
import { SETUP_RECEIPT_NOTE, WORKER_READONLY_NOTE, buildWorkerFirstMessage, setupNote } from "../prompt.ts";
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
import { hasGitCommitSync, renderGraphStepTask } from "./task-graph-handoff.ts";
import type { StepWorkspacePlan, TaskGraphWorkersBridge, WorkerBindTarget } from "./task-graphs.ts";
import { newestFirst } from "./takeover.ts";
import type { LedgerTakeover, TakeoverPredecessor } from "./takeover.ts";

/** 主文件夹有没提交的改动、又用 worktree 时，start 返回的话里的提醒（m3-plan 第 2.6 节）。 */
const WORKTREE_DIRTY_NOTE = "注意：主文件夹里有没提交的改动，Worker 是从最后一次提交开始的，看不到这些改动。";
/** 这一轮被用户停止时那一行的原因。 */
const TURN_STOPPED = "被停止了";
/** 这一轮出错、又没有错误信息时的原因。 */
const TURN_FAILED = "这一轮出错了";
/** 用户的话算 Worker 已收到的状态（user_message 那一行只给这些发）。 */
const RECEIVED_STATUSES: ReadonlySet<string> = new Set(["delivered", "processing", "replied"]);
/**
 * Worker 在等后台命令时进程被关了、后台命令跟着停了（workers.ts 的 flushAwaiting）：照常汇报，正文前面加这一句。
 * idle：后台命令超过 WORKER_BACKGROUND_HOLD_MAX_MS 没结束，驱动层到点关的；shutdown：守护进程关了；
 * restart：守护进程没走关机就没了（被杀、崩溃），重启后补发（recoverBackgroundWaits）。
 */
function backgroundKilledNote(reason: "idle" | "shutdown" | "restart"): string {
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

/** 已收工、用 worktree 的 Worker，供后台 worktree 自动清理筛选候选。 */
export interface EndedWorktreeCandidate {
  workerId: WorkerId;
  projectId: number;
  repoFolder: string;
  branch: string;
  worktreePath: string;
  baseCommit: string | null;
  endedAt: number;
}

export type LedgerWorkers = ReturnType<typeof createLedgerWorkers>;

export interface LedgerWorkersTaskGraphHooks {
  prepareWorkerBind: (pmId: PmId, nodeKey: string, graphId?: number) => WorkerBindTarget;
  bindWorkerStartedIn: (
    p: Pending,
    target: WorkerBindTarget,
    workerId: WorkerId,
    agent?: { vendor: string; model: string | null; effort: string | null },
  ) => void;
  onWorkerTurnReportIn: (
    p: Pending,
    worker: { id: WorkerId; branch: string | null },
    parsed: ParsedWorkerReport,
    rawBody: string,
    forcedNote: string | null,
  ) =>
    | { handled: false }
    | { handled: true; outcome: "completed"; wakePmWithReport: boolean; completeStep: () => void }
    | { handled: true; outcome: "waiting_pm"; pmDeliverBody: string };
  onWorkerFailedIn: (
    p: Pending,
    workerId: WorkerId,
    opts: { clearActiveWorker: boolean; reasonLabel: string; detailBody: string; stoppedByUser?: boolean },
  ) => string | null;
  onWorkerResumedIn: (p: Pending, workerId: WorkerId) => void;
  onWorkerEndedIn: (p: Pending, workerId: WorkerId) => string | null;
  workerGraphForkBase: (workerId: WorkerId) => string | undefined;
  workerGraphStatus: (workerId: WorkerId, sessionId: SessionId) => WorkerHubStatus["taskGraph"] | undefined;
}

export function createLedgerWorkers(
  ctx: LedgerContext,
  sessions: LedgerSessions,
  messages: LedgerMessages,
  persona: LedgerPersona,
  projects: LedgerProjects,
  options: { worktreesDir: string; taskGraphs?: LedgerWorkersTaskGraphHooks; takeover?: LedgerTakeover },
) {
  const { db, now, write, enqueue } = ctx;
  const { currentSession, insertSession, liveOf, updateLive } = sessions;
  const { transition, stopIn } = messages;
  const { pmRow, assertPmNotArchived } = persona;
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
   * 每个 Worker 当前轮次的超时定时器（只有定时器本身在内存里；时长、截止时刻、提醒发过没有落在 worker_turn_timeouts，迁移 0024）。
   * - 启动/重置：`hub worker start` 派活、`hub worker send` 发起新一轮、`hub worker max-time` 续期、或排队消息开始执行新一轮时
   *   按指定的 `maxTimeMs`（默认 `DEFAULT_WORKER_MAX_TIME_MS`）从现在起算，同时写库；
   * - 立即销毁：这一轮结束（`report`、`turn_failed`）、被 `hub worker end` / 归档停止时 `clearTimeout`、从 Map 移除、库里清空；
   *   守护进程 `close()` 只停定时器，不动库（重启后 recoverTurnTimeouts 按库里的截止时刻重新挂，已过期的马上提醒一次）；
   * - 超时触发：到点若该 Worker 仍处于运行中（in-flight），向所属项目经理对话发送一条静默唤醒消息（`worker.max_time_exceeded`），
   *   库里记下这一轮已提醒过（重启后也不再提醒），不打断 Worker。
   */
  const maxTimeTimers = new Map<ConversationId, { timer: ReturnType<typeof setTimeout>; maxTimeMs: number; startedAt: number }>();

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
  /** Worker 的会话（一个 Worker 一个）。已有行直接传，省一次查 workers 表。 */
  const workerSession = (worker: WorkerId | WorkerDbRow): AgentSessionRow =>
    currentSession((typeof worker === "number" ? workerRow(worker)! : worker).worker_conversation_id)!;
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

  const validMaxTimeMs = (raw: unknown): number => {
    if (raw === undefined) return DEFAULT_WORKER_MAX_TIME_MS;
    const bad = checkWorkerMaxTimeMs(raw);
    if (bad !== null) throw fail("invalid", bad);
    return raw as number;
  };

  const stopTimer = (workerConversationId: ConversationId) => {
    const existing = maxTimeTimers.get(workerConversationId);
    if (existing !== undefined) {
      clearTimeout(existing.timer);
      maxTimeTimers.delete(workerConversationId);
    }
  };

  /** 这一轮结束、收工：停定时器，库里的计时清空。 */
  const clearMaxTime = (workerConversationId: ConversationId) => {
    stopTimer(workerConversationId);
    db.run("DELETE FROM worker_turn_timeouts WHERE worker_id = (SELECT id FROM workers WHERE worker_conversation_id = ?)", workerConversationId);
  };

  /** 守护进程关：只停定时器，库里的计时留着给重启后恢复。 */
  const clearAllMaxTime = () => {
    for (const entry of maxTimeTimers.values()) clearTimeout(entry.timer);
    maxTimeTimers.clear();
  };

  const isWorkerInFlight = (worker: WorkerDbRow): boolean => {
    const session = currentSession(worker.worker_conversation_id);
    if (session !== null) {
      const activity = liveOf(session.id).activity;
      if (activity === "working" || activity === "background" || activity === "preparing") return true;
      if (turnStarts.has(session.id) || awaitingBackground.get(session.id) !== undefined) return true;
    }
    return (
      db.get(
        "SELECT 1 AS x FROM messages WHERE conversation_id = ? AND status IN ('queued', 'delivered', 'processing') LIMIT 1",
        worker.worker_conversation_id,
      ) !== undefined
    );
  };

  const onMaxTimeExceeded = (
    workerId: WorkerId,
    workerConversationId: ConversationId,
    timer: ReturnType<typeof setTimeout>,
    maxTimeMs: number,
    startedAt: number,
  ) => {
    const current = maxTimeTimers.get(workerConversationId);
    if (current?.timer !== timer) return;
    stopTimer(workerConversationId);
    try {
      write((p) => {
        const worker = workerRow(workerId);
        if (worker === null) return;
        if (worker.status !== "open" || !isWorkerInFlight(worker)) {
          clearMaxTime(workerConversationId);
          return;
        }
        // 同一轮只提醒一次（重启前已经提醒过的，恢复时就不会再挂定时器；这里再挡一次）
        if (turnTimeoutOf(worker.id)?.notified === 1) return;
        const pmSession = currentSession(worker.pm_conversation_id);
        if (pmSession === null) return;
        const t = now();
        const label = formatDurationShort(maxTimeMs);
        const text =
          `【Worker #${worker.id} · ${worker.title} 已超过最大时间（${label}）】` +
          `该 Worker 当前一轮已运行 ${label} 仍未结束（仍在运行中，未被停止）。` +
          `请用 ${HUB_COMMAND} worker show ${worker.id} 和 ${HUB_COMMAND} worker log ${worker.id} --last 15 检查它是否在正常推进，并视情况告知用户、继续等待或停止换人。`;
        const meta: SystemMessageMeta = {
          event: "worker.max_time_exceeded",
          workerId: worker.id,
          workerConversationId: worker.worker_conversation_id,
          maxTimeMs,
        };
        const row = db.get<MessageDbRow>(
          `INSERT INTO messages (conversation_id, session_id, worker_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
           VALUES (?, ?, ?, 'system', 'text', ?, ?, ?, 'queued', ?, ?)
           ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
          worker.pm_conversation_id,
          pmSession.id,
          worker.id,
          text,
          JSON.stringify(meta),
          `${systemMessageDedupeKey(worker.pm_conversation_id, meta)}:${startedAt}:${randomUUID()}`,
          t,
          t,
        );
        db.run("UPDATE worker_turn_timeouts SET notified = 1 WHERE worker_id = ?", worker.id);
        if (row === undefined) return;
        p.changes.push({ type: "message.created", data: { message: toMessage(row) } });
        enqueue(p, { type: "session.send", params: { sessionId: pmSession.id, messageId: row.id, source: "system" } });
      });
    } catch {
      // 库写不进去（关机中等）：不再重试，重启后按库里还没提醒的状态重新挂
    }
  };

  /** 挂定时器：到 deadline 触发（已过的马上触发）。 */
  const armTimer = (worker: Pick<WorkerDbRow, "id" | "worker_conversation_id">, maxTimeMs: number, deadline: number) => {
    stopTimer(worker.worker_conversation_id);
    const startedAt = deadline - maxTimeMs;
    const timer = setTimeout(() => {
      onMaxTimeExceeded(worker.id, worker.worker_conversation_id, timer, maxTimeMs, startedAt);
    }, Math.max(0, deadline - now()));
    timer.unref?.();
    maxTimeTimers.set(worker.worker_conversation_id, { timer, maxTimeMs, startedAt });
  };

  /** 这一轮从现在起计时：写库（时长、截止时刻、还没提醒），挂定时器。 */
  const startMaxTime = (worker: Pick<WorkerDbRow, "id" | "worker_conversation_id">, maxTimeMs: number = DEFAULT_WORKER_MAX_TIME_MS) => {
    const deadline = now() + maxTimeMs;
    db.run(
      `INSERT INTO worker_turn_timeouts (worker_id, max_time_ms, deadline_at, notified) VALUES (?, ?, ?, 0)
       ON CONFLICT (worker_id) DO UPDATE SET max_time_ms = excluded.max_time_ms, deadline_at = excluded.deadline_at, notified = 0`,
      worker.id,
      maxTimeMs,
      deadline,
    );
    armTimer(worker, maxTimeMs, deadline);
  };

  /** 这个 Worker 这一轮在库里的计时；没在计时是 null。 */
  const turnTimeoutOf = (workerId: WorkerId) =>
    db.get<{ max_time_ms: number; deadline_at: number; notified: number }>(
      "SELECT max_time_ms, deadline_at, notified FROM worker_turn_timeouts WHERE worker_id = ?",
      workerId,
    ) ?? null;

  /** 当前这一轮的最大时间和开始计时的时刻（hub worker show 用，从库里读）；没有在计时的是 null。 */
  const turnMaxTimeOf = (workerConversationId: ConversationId): { maxTimeMs: number; startedAt: number } | null => {
    const row = db.get<{ max_time_ms: number; deadline_at: number }>(
      `SELECT t.max_time_ms, t.deadline_at FROM worker_turn_timeouts t JOIN workers w ON w.id = t.worker_id
        WHERE w.worker_conversation_id = ?`,
      workerConversationId,
    );
    return row === undefined ? null : { maxTimeMs: row.max_time_ms, startedAt: row.deadline_at - row.max_time_ms };
  };

  /**
   * 重启恢复（在 recoverAfterRestart 里调）：还开着、在计时、这一轮还没提醒过的 Worker 按库里的截止时刻重新挂定时器，
   * 已经过了的马上触发一次（触发时还在跑才提醒）。已收工或重启后已无在途轮次的残留计时清掉（避免空闲残留 notified=1 导致下一轮漏挂计时）。返回重新挂了哪些 Worker。
   */
  const recoverTurnTimeouts = (): WorkerId[] => {
    db.run("DELETE FROM worker_turn_timeouts WHERE worker_id IN (SELECT id FROM workers WHERE status = 'ended')");
    const rows = db.all<{ id: number; worker_conversation_id: number; max_time_ms: number; deadline_at: number; notified: number }>(
      `SELECT w.id, w.worker_conversation_id, t.max_time_ms, t.deadline_at, t.notified FROM worker_turn_timeouts t JOIN workers w ON w.id = t.worker_id
        WHERE w.status = 'open' ORDER BY w.id`,
    );
    const armed: WorkerId[] = [];
    for (const row of rows) {
      const worker = workerRow(row.id);
      if (worker === null || (!notStarted(worker) && !isWorkerInFlight(worker))) {
        clearMaxTime(row.worker_conversation_id);
        continue;
      }
      if (row.notified === 0) {
        armTimer(row, row.max_time_ms, row.deadline_at);
        armed.push(row.id);
      }
    }
    return armed;
  };

  /**
   * 项目经理对话里那一行（WorkerMessageMeta）。deliver：要交给项目经理（report、turn_failed、worktree_failed、user_message），
   * 消息从 queued 起照常走，登记 session.send（source system）；否则只给人看（started、ended）。
   * 去重键带事件类型（workerMessageDedupeKey），重复调用只有一行、只登记一次。
   */
  const insertLine = (
    p: Pending,
    worker: WorkerDbRow,
    line: {
      event: WorkerEvent;
      status: WorkerLineStatus | null;
      summary: string | null;
      turnMessageId: MessageId | null;
      deliver: string | null;
      wakePm?: boolean;
    },
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
    const shouldWakePm = line.wakePm ?? (line.deliver !== null);
    const pmSession = shouldWakePm ? currentSession(worker.pm_conversation_id) : null;
    if (shouldWakePm && pmSession === null) throw new Error(`conversation ${worker.pm_conversation_id} has no agent session`);
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
    const session = workerSession(worker);
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

  /** 这个 worktree 目录还能接着用：是建好了的 worktree（有起点提交），目录还在，同一个项目。 */
  const reusableWorktree = (w: WorkerDbRow, projectId: number): boolean =>
    w.workspace === "worktree" && w.project_id === projectId && w.base_commit !== null && w.worktree_path !== null && w.worktree_path !== "" && w.branch !== null && existsSync(w.worktree_path);

  const probeWorkspaceForStep = (
    projectId: number,
    mainFolder: string,
    context: HubCallContext | undefined,
    allowSyncFallback: boolean,
  ): { isRepoWithCommit: boolean; hasUncommittedChanges: boolean } => {
    if (context?.workspace !== undefined) {
      if (context.workspace.kind === "failed") throw gitFailed(context.workspace.error);
      return context.workspace;
    }
    if (!allowSyncFallback) {
      throw new Error("worker.start without noWorktree needs context.workspace (probe the main folder first)");
    }
    const hadWorktree =
      db.get(
        "SELECT 1 AS x FROM workers WHERE project_id = ? AND workspace = 'worktree' AND base_commit IS NOT NULL LIMIT 1",
        projectId,
      ) !== undefined;
    return {
      isRepoWithCommit: hadWorktree || hasGitCommitSync(mainFolder),
      hasUncommittedChanges: false,
    };
  };

  const checkTargetVendorUsable = (vendor: AgentVendor, context: HubCallContext | undefined): void => {
    const fromSingle = context?.vendorStatus?.vendor === vendor ? context.vendorStatus : undefined;
    const availability =
      fromSingle?.availability ??
      context?.vendorStatuses?.[vendor] ??
      ctx.modelCatalog(vendor)?.availability ??
      "unknown";
    const device = fromSingle?.device ?? context?.deviceName ?? "";
    const unusable = vendorUnavailableMessage(vendor, availability, device);
    if (unusable !== null) throw fail("invalid", unusable);
  };

  /** 供 task-graphs.ts 在步骤解锁时后台自动拉起 Worker。 */
  const dispatchStepWorkerIn: TaskGraphWorkersBridge["dispatchStepWorkerIn"] = (p, input) => {
    assertPmNotArchived(input.pmId);
    const project = activeProjectOf(input.pmId);
    if (project === null) {
      throw fail("invalid", `项目经理还没有项目，无法自动开工`);
    }
    const title = normalizeWorkerTitle(input.title);
    if (title === null) throw fail("invalid", "步骤标题不能为空或含控制字符");
    const task = validTask(input.task, "步骤任务说明");
    const maxTimeMs = validMaxTimeMs(input.maxTimeMs ?? undefined);

    const vendor: AgentVendor = input.vendor ?? input.pmVendor;
    if (!isAgentVendor(vendor)) throw fail("invalid", `厂商只能是 ${AGENT_VENDORS.join("、")}`);
    checkTargetVendorUsable(vendor, input.context);

    const catalog = ctx.modelCatalog(vendor);
    const badSetting =
      checkModel(vendor, input.model) ??
      checkEffort(vendor, input.effort, catalog) ??
      checkModelEffort(vendor, input.model, input.effort, catalog);
    if (badSetting !== null) throw fail("invalid", badSetting);
    const { model, effort } = splitModelEffort(vendor, input.model, input.effort, catalog);

    if (!ctx.osSandboxed()) throw fail("invalid", WORKER_NEEDS_OS_SANDBOX_MESSAGE);

    const card = projectCard(project);
    const inheritedPlan = input.workspacePlan.kind === "inherit" ? input.workspacePlan : null;
    if (inheritedPlan !== null) {
      // 若上游是通过 graph done 手动放行的、其挂着的旧 Worker 仍处于 open，接手目录前自动将其收工
      const openSharing = db.all<WorkerDbRow>(
        "SELECT * FROM workers WHERE worktree_path = ? AND status = 'open' ORDER BY id",
        inheritedPlan.worktreePath,
      );
      for (const prevWorker of openSharing) {
        endWorkerIn(p, prevWorker, { notifyGraph: false });
      }
    }
    const probe =
      inheritedPlan !== null
        ? { isRepoWithCommit: true, hasUncommittedChanges: false }
        : probeWorkspaceForStep(project.id, card.mainFolder, input.context, true);
    const workspace = inheritedPlan !== null || probe.isRepoWithCommit ? "worktree" : "main";

    const t = now();
    const conversation = toConversation(
      db.get<ConversationDbRow>(
        "INSERT INTO conversations (kind, pm_id, project_id, title, created_at) VALUES ('worker', ?, ?, ?, ?) RETURNING *",
        input.pmId,
        project.id,
        title,
        t,
      )!,
    );
    p.changes.push({ type: "conversation.created", data: { conversation } });

    const id = db.run(
      `INSERT INTO workers (project_id, pm_id, pm_conversation_id, worker_conversation_id, title, task, model, effort, readonly, workspace,
                            branch, worktree_path, base_commit, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      project.id,
      input.pmId,
      project.conversation_id,
      conversation.id,
      title,
      task,
      model,
      effort,
      input.readonly ? 1 : 0,
      workspace,
      inheritedPlan !== null ? inheritedPlan.branch : workspace === "worktree" ? "" : null,
      inheritedPlan !== null ? inheritedPlan.worktreePath : workspace === "worktree" ? "" : null,
      inheritedPlan !== null ? inheritedPlan.baseCommit : null,
      t,
      t,
    ).lastInsertRowid;

    if (workspace === "worktree" && inheritedPlan === null) {
      db.run(
        "UPDATE workers SET branch = ?, worktree_path = ? WHERE id = ?",
        workerBranchName(id, title),
        workerWorktreePath(worktreesDir, project.id, id),
        id,
      );
    }
    const worker = workerRow(id)!;
    const sameVendor = vendor === input.pmVendor;
    const inheritedSetting = sameVendor
      ? splitModelEffort(vendor, input.pmModel, input.pmEffort)
      : { model: null, effort: null };

    const session = insertSession(p, {
      role: "worker",
      conversationId: conversation.id,
      pmId: null,
      workerId: id,
      cwd: worker.worktree_path ?? card.mainFolder,
      addDirs: workspace === "worktree" ? [] : card.otherFolders,
      generation: 1,
      vendor,
      model: model ?? inheritedSetting.model,
      effort: effort ?? inheritedSetting.effort,
    });

    const workerRecord = toWorkerRecord(worker);
    const firstMessageText = input.buildFirstMessage(session.id, inheritedPlan?.fromWorkerId ?? null, workerRecord, card);
    insertPmMessage(p, worker, session, firstMessageText, taskDedupeKey(id));
    insertLine(p, worker, { event: "started", status: null, summary: null, turnMessageId: null, deliver: null });

    if (inheritedPlan !== null) {
      const first = db.get<{ id: number }>("SELECT id FROM messages WHERE dedupe_key = ?", taskDedupeKey(id))!;
      enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId: first.id, source: "user" } });
    } else if (workspace === "worktree") {
      enqueue(p, { type: "worktree.create", params: { workerId: id } });
      syncSessionFolders(project);
    } else {
      enqueueFirstTurn(p, worker);
    }
    startMaxTime(worker, maxTimeMs);
    return workerRecord;
  };

  /**
   * 换人接手同一步（hub worker start --node，节点上已经有经手过的 Worker；docs/orchestration-simplify-design.md 第 4.4、5.2 节）要的东西：
   * - predecessors：最近 TAKEOVER_PREDECESSORS_MAX 个前任，从新到旧；
   * - inherit：最近一个 worktree 还在的前任（没给 --no-worktree 时），新 Worker 接着用它的目录和分支，不新建、不重跑准备命令；
   * - originalTask：这一步第一个 Worker 收到的任务说明（第 5 步把职责存到节点上之前，靠它不丢原始任务）；
   * - active：节点上还挂着、没收工的旧 Worker（派新的之前先按“没做完”把它收工）。
   */
  const planTakeover = (target: WorkerBindTarget, projectId: number, noWorktree: boolean) => {
    const allNewestFirst = newestFirst(target.workerIds, target.workerIds.length)
      .map((id) => workerRow(id))
      .filter((w): w is WorkerDbRow => w !== null);
    const predecessors = allNewestFirst.slice(0, TAKEOVER_PREDECESSORS_MAX);
    const inherit = noWorktree ? null : (allNewestFirst.find((w) => reusableWorktree(w, projectId)) ?? null);
    const first = allNewestFirst.at(-1) ?? null;
    const openById = new Map<WorkerId, WorkerDbRow>();
    if (target.activeWorkerId !== null) {
      const active = workerRow(target.activeWorkerId);
      if (active !== null && active.status === "open") openById.set(active.id, active);
    }
    for (const w of allNewestFirst) {
      if (w.status === "open") openById.set(w.id, w);
    }
    return { predecessors, inherit, originalTask: first?.task ?? null, openOld: [...openById.values()] };
  };

  const startIn = (
    p: Pending,
    caller: AgentSessionRow & { pmId: PmId },
    args: HubArgs<"worker.start">,
    context: HubCallContext,
  ): HubResult<"worker.start"> => {
    assertPmNotArchived(caller.pmId);
    const project = activeProjectOf(caller.pmId);
    if (project === null) throw fail("invalid", `你还没有项目，没法派 Worker：先用 ${HUB_COMMAND} project create --folder <主文件夹> 建一个`);
    const bindTarget =
      args.node !== undefined && args.node.trim() !== ""
        ? options.taskGraphs?.prepareWorkerBind(caller.pmId, args.node, args.graphId)
        : undefined;
    // 节点上已经有经手过的 Worker：换人接手。标题、正文可以不给（正文给了就是项目经理的补充）
    const takeover = bindTarget !== undefined && bindTarget.workerIds.length > 0 ? planTakeover(bindTarget, project.id, args.noWorktree === true) : null;
    const latest = takeover?.predecessors[0] ?? null;
    const stepHasBrief = bindTarget !== undefined && bindTarget.brief !== null && bindTarget.brief.trim() !== "";
    const rawTitle =
      typeof args.title === "string" && args.title.trim() !== ""
        ? args.title
        : (latest?.title ?? bindTarget?.nodeTitle ?? args.title);
    const title = typeof rawTitle === "string" ? normalizeWorkerTitle(rawTitle) : null;
    if (title === null) throw fail("invalid", "Worker 的标题不能是空的，也不能带换行等控制字符");
    let task: string;
    let pmNote: string | null = null;
    if (takeover !== null && takeover.originalTask !== null) {
      pmNote = typeof args.task === "string" && args.task.trim() !== "" ? validTask(args.task, "项目经理的补充") : null;
      task = pmNote === null ? takeover.originalTask : `${takeover.originalTask.trimEnd()}\n\n## 项目经理的补充（换人接手时）\n\n${pmNote.trim()}`;
      if (utf8Bytes(task) > MAX_TASK_BYTES) {
        throw fail("invalid", `原始任务说明加上补充超过 ${MAX_TASK_BYTES} 字节：补充写短一点，长材料存成文件给路径`);
      }
    } else if (stepHasBrief && bindTarget !== undefined) {
      pmNote = typeof args.task === "string" && args.task.trim() !== "" ? validTask(args.task, "项目经理的补充") : null;
      task = renderGraphStepTask({
        goal: bindTarget.graphGoal,
        stepTitle: bindTarget.nodeTitle,
        index: bindTarget.index,
        total: bindTarget.total,
        brief: bindTarget.brief!,
        review: bindTarget.review,
        pmNote,
      });
      if (utf8Bytes(task) > MAX_TASK_BYTES) {
        throw fail("invalid", `步骤任务说明加上补充超过 ${MAX_TASK_BYTES} 字节`);
      }
    } else {
      task = validTask(args.task, "任务说明");
    }
    const maxTimeMs = validMaxTimeMs(args.maxTimeMs ?? bindTarget?.maxTimeMs ?? undefined);
    // 模型、思考程度按目标厂商清单查；同厂商不给就用项目经理会话现在的，换厂商不给就用 null
    let vendor = (bindTarget?.vendor ?? caller.vendor) as AgentVendor;
    if (args.vendor !== undefined) {
      if (!isAgentVendor(args.vendor)) throw fail("invalid", `厂商只能是 ${AGENT_VENDORS.join("、")}`);
      vendor = args.vendor;
      checkTargetVendorUsable(vendor, context);
    } else if (bindTarget?.vendor !== null && bindTarget?.vendor !== undefined) {
      if (!isAgentVendor(bindTarget.vendor)) throw fail("invalid", `厂商只能是 ${AGENT_VENDORS.join("、")}`);
      checkTargetVendorUsable(vendor, context);
    }
    const reuseStepModel = bindTarget !== undefined && args.vendor === undefined && bindTarget.vendor === vendor;
    const givenModel =
      typeof args.model === "string" ? args.model.trim() || null : reuseStepModel ? bindTarget.model : null;
    const givenEffort =
      typeof args.effort === "string" ? args.effort.trim() || null : reuseStepModel ? bindTarget.effort : null;
    const catalog = ctx.modelCatalog(vendor);
    const badSetting = checkModel(vendor, givenModel) ?? checkEffort(vendor, givenEffort, catalog) ?? checkModelEffort(vendor, givenModel, givenEffort, catalog);
    if (badSetting !== null) throw fail("invalid", badSetting);
    // 思考程度写在模型 ID 里的厂商（agy）：--model gemini-4-argon-high 和 --model gemini-4-argon --effort high 存成一样的 模型 + 思考程度
    const { model, effort } = splitModelEffort(vendor, givenModel, givenEffort, catalog);
    const readonly = args.readonly !== undefined ? args.readonly === true : (bindTarget?.readonly ?? false);
    // Worker（不论普通还是只读、不论哪家厂商）一律要求 OS 沙箱就绪；起不来直接报错拒绝派活，不退回规则兜底（docs/linux-sandbox-design.md 第 3.2 节）
    if (!ctx.osSandboxed()) throw fail("invalid", WORKER_NEEDS_OS_SANDBOX_MESSAGE);
    const card = projectCard(project);
    const inherit = takeover?.inherit ?? null;
    const upstreamInherit: Extract<StepWorkspacePlan, { kind: "inherit" }> | null =
      args.noWorktree !== true && inherit === null && bindTarget?.workspacePlan.kind === "inherit"
        ? bindTarget.workspacePlan
        : null;
    const effectiveInherit =
      inherit !== null
        ? {
            fromWorkerId: inherit.id,
            worktreePath: inherit.worktree_path!,
            branch: inherit.branch!,
            baseCommit: inherit.base_commit!,
          }
        : upstreamInherit;
    let probe = { isRepoWithCommit: false, hasUncommittedChanges: false };
    if (args.noWorktree !== true && effectiveInherit === null) {
      probe = probeWorkspaceForStep(project.id, card.mainFolder, context, bindTarget !== undefined);
    }
    const workspace = effectiveInherit !== null || probe.isRepoWithCommit ? "worktree" : "main";

    // 换人：前任的记录先按现在的样子取出来（还挂着的旧 Worker 收工前），再把旧 Worker 按“没做完”收工（同 --incomplete，节点不标完成）
    let takeoverPredecessors: TakeoverPredecessor[] | null = null;
    const endedOldList: Array<{ ended: WorkerDbRow; interrupted: boolean }> = [];
    if (takeover !== null && bindTarget !== undefined) {
      const openIds = new Set(takeover.openOld.map((w) => w.id));
      const inFlightIds = new Set(takeover.openOld.filter((w) => !notStarted(w) && isWorkerInFlight(w)).map((w) => w.id));
      takeoverPredecessors = takeover.predecessors.map((w) => ({
        worker: w,
        session: workerSession(w),
        endedNote:
          openIds.has(w.id)
            ? inFlightIds.has(w.id)
              ? "换人时它还在跑这一轮，后台已打断它，并按“没做完”把它收工（节点不标完成）。"
              : "换人时它还开着（没在跑），后台已按“没做完”把它收工（节点不标完成）。"
            : "它已经收工了。",
      }));
      for (const old of takeover.openOld) {
        endedOldList.push(endWorkerIn(p, old, { notifyGraph: false }));
      }
    }
    if (effectiveInherit !== null) {
      // 若继承的同线目录上还有通过 graph done 放行遗留的 open Worker，接手前自动将其收工，避免死锁在 waitsForFirstTurn
      const openSharing = db.all<WorkerDbRow>(
        "SELECT * FROM workers WHERE worktree_path = ? AND status = 'open' ORDER BY id",
        effectiveInherit.worktreePath,
      );
      for (const prevWorker of openSharing) {
        endWorkerIn(p, prevWorker, { notifyGraph: false });
      }
    }
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
    // 编号要先有才能定分支和目录：新建 worktree 的先占个空串（满足 CHECK），马上改成真的；接手前任的直接用前任的目录、分支和起点提交
    const id = db.run(
      `INSERT INTO workers (project_id, pm_id, pm_conversation_id, worker_conversation_id, title, task, model, effort, readonly, workspace,
                            branch, worktree_path, base_commit, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      effectiveInherit !== null ? effectiveInherit.branch : workspace === "worktree" ? "" : null,
      effectiveInherit !== null ? effectiveInherit.worktreePath : workspace === "worktree" ? "" : null,
      effectiveInherit !== null ? effectiveInherit.baseCommit : null,
      t,
      t,
    ).lastInsertRowid;
    if (workspace === "worktree" && effectiveInherit === null) {
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
    // 会话的工作目录就是要干活的目录（接手的是前任的 worktree）：可写范围按它放行（launch.ts 的 workerWriteScope 用 session.cwd）
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
    const workerRecord = toWorkerRecord(worker);
    let takeoverText: string | null = null;
    if (takeover !== null && bindTarget !== undefined && takeoverPredecessors !== null) {
      const branches = [...new Set(takeover.predecessors.map((w) => w.branch).filter((b): b is string => b !== null && b !== ""))];
      const branchNote = branches.length === 0 ? "" : `前任的分支 ${branches.join("、")} 还在，要的话自己合进来。`;
      const baseWorkspaceNote =
        inherit !== null
          ? `你就在前任 Worker #${inherit.id} 的工作目录 ${inherit.worktree_path} 和分支 ${inherit.branch} 上，没提交的改动都还在，先看 git status 和 git log。`
          : upstreamInherit !== null
            ? `前任没有建成工作目录，你接着用上一步（Worker #${upstreamInherit.fromWorkerId}）的工作目录 ${upstreamInherit.worktreePath} 和分支 ${upstreamInherit.branch}：它的提交、没提交的文件和装好的依赖都在，不要另开分支。${branchNote}`
            : args.noWorktree === true
              ? `这次按项目经理的要求直接在项目主文件夹 ${card.mainFolder} 里干（--no-worktree），没有接手前任的工作目录。${branchNote}`
              : workspace === "main"
                ? `你在项目主文件夹 ${card.mainFolder} 里干活，和前任是同一个目录，前任没提交的改动也都还在，先看 git status。`
                : bindTarget.workspacePlan.kind === "fork"
                  ? `前任没有还能接手的工作目录（已清理或没建成），你在新开的 worktree ${worker.worktree_path}（分支 ${worker.branch}）里，从上游分支 ${bindTarget.workspacePlan.baseBranch} 最新提交开始。${branchNote}`
                  : `前任没有还能接手的工作目录（已清理或没建成），你在新开的 worktree ${worker.worktree_path}（分支 ${worker.branch}）里，从主文件夹最后一次提交开始。${branchNote}`;
      const workspaceNote = readonly ? `${baseWorkspaceNote}\n${WORKER_READONLY_NOTE}` : baseWorkspaceNote;
      const baseTaskForTakeover = stepHasBrief
        ? renderGraphStepTask({
            goal: bindTarget.graphGoal,
            stepTitle: bindTarget.nodeTitle,
            index: bindTarget.index,
            total: bindTarget.total,
            brief: bindTarget.brief!,
            review: bindTarget.review,
          })
        : takeover.originalTask !== null && !takeover.originalTask.includes("## 你这一步：")
          ? renderGraphStepTask({
              goal: bindTarget.graphGoal,
              stepTitle: bindTarget.nodeTitle,
              index: bindTarget.index,
              total: bindTarget.total,
              brief: takeover.originalTask,
              review: bindTarget.review,
            })
          : (takeover.originalTask ?? task);
      const upstreamHandoff = bindTarget.buildUpstreamHandoff(session.id, effectiveInherit?.fromWorkerId ?? null);
      takeoverText =
        options.takeover?.takeoverMessage({
          graph: { id: bindTarget.graphId, title: bindTarget.graphTitle },
          node: { key: bindTarget.nodeKey, title: bindTarget.nodeTitle, index: bindTarget.index, total: bindTarget.total },
          worker: { id: worker.id, title: worker.title },
          predecessors: takeoverPredecessors,
          workspaceNote,
          task: baseTaskForTakeover,
          upstreamHandoff,
          pmNote,
        }) ?? null;
    }
    const firstMessageText =
      takeoverText ??
      (bindTarget !== undefined
        ? bindTarget.buildFirstMessage(session.id, {
            inheritedFromWorkerId: effectiveInherit?.fromWorkerId ?? null,
            worker: workerRecord,
            project: card,
            task: stepHasBrief
              ? task
              : renderGraphStepTask({
                  goal: bindTarget.graphGoal,
                  stepTitle: bindTarget.nodeTitle,
                  index: bindTarget.index,
                  total: bindTarget.total,
                  brief: task,
                  review: bindTarget.review,
                }),
          })
        : buildWorkerFirstMessage({
            project: card,
            worker: workerRecord,
            task,
          }));
    insertPmMessage(p, worker, session, firstMessageText, taskDedupeKey(id));
    insertLine(p, worker, { event: "started", status: null, summary: null, turnMessageId: null, deliver: null });
    if (bindTarget !== undefined) {
      options.taskGraphs?.bindWorkerStartedIn(p, bindTarget, id, {
        vendor,
        model: session.model,
        effort: session.effort,
      });
    }
    if (effectiveInherit !== null) {
      // 不建 worktree、不跑准备命令；只登记第一条消息，送之前等用这个目录的旧会话都结束（waitsForFirstTurn），会话由这条消息拉起
      const first = db.get<{ id: number }>("SELECT id FROM messages WHERE dedupe_key = ?", taskDedupeKey(id))!;
      enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId: first.id, source: "user" } });
    } else if (workspace === "worktree") {
      enqueue(p, { type: "worktree.create", params: { workerId: id } });
      // 项目经理的会话带上 worktrees/<项目编号>/，验收时能看 Worker 的改动（下一条消息前自动重启生效）
      syncSessionFolders(project);
    } else {
      enqueueFirstTurn(p, worker);
    }
    startMaxTime(worker, maxTimeMs);

    const notes: string[] = [];
    if (takeover !== null && bindTarget !== undefined) {
      const old =
        endedOldList.length === 0
          ? ""
          : `已先把节点上还挂着的 ${endedOldList.map((e) => `Worker #${e.ended.id}${e.interrupted ? "（打断了它正在跑的那一轮）" : ""}`).join("、")} 收工，节点不标完成；`;
      notes.push(
        `${old}已派出 Worker #${id}“${title}”接手任务图 #${bindTarget.graphId} 的节点「${bindTarget.nodeKey}」，${describeWorkspace(worker, card.mainFolder)}` +
          `。前任（最近 ${takeover.predecessors.length} 个）的汇报、最后的文字、最后几步操作和原始记录路径已自动放进它的第一条消息${pmNote === null ? "" : "，你的正文作为补充放在最后"}`,
      );
      if (inherit !== null) notes.push(`；它接着用前任 Worker #${inherit.id} 的工作目录和分支，前任会话结束后它才开工`);
    } else {
      notes.push(`已派出 Worker #${id}“${title}”，${describeWorkspace(worker, card.mainFolder)}`);
    }
    if (workspace === "main" && args.noWorktree !== true) notes.push("（主文件夹不是有提交的 git 仓库，所以没建 worktree）");
    if (readonly) notes.push("。它是只读的，只看不改");
    notes.push(`。它每做完一轮，汇报会自动发给你；打回用 ${HUB_COMMAND} worker send ${id} --stdin，收工用 ${HUB_COMMAND} worker end ${id}。`);
    if (workspace === "worktree" && effectiveInherit === null && project.setup_command !== null) notes.push(SETUP_RECEIPT_NOTE);
    if (workspace === "worktree" && effectiveInherit === null && probe.hasUncommittedChanges) notes.push(WORKTREE_DIRTY_NOTE);
    return { text: notes.join(""), data: { worker: toWorkerRecord(worker) } };
  };

  const sendIn = (p: Pending, caller: AgentSessionRow & { pmId: PmId }, args: HubArgs<"worker.send">): HubResult<"worker.send"> => {
    assertPmNotArchived(caller.pmId);
    const maxTimeMs = validMaxTimeMs(args.maxTimeMs);
    const worker = ownWorker(caller.pmId, args.workerId);
    if (worker.status === "ended") throw fail("conflict", `Worker #${worker.id} 已经收工了，要接着做请重新派一个`);
    // 还没开工（在建 worktree、跑准备命令）：第一轮必须是任务说明，现在发的话会让会话提前起来
    if (notStarted(worker)) throw fail("conflict", `Worker 还在准备，等它开工后再发（Worker #${worker.id} 在建 worktree 或跑项目的准备命令）`);
    const text = validTask(args.text, "要发给 Worker 的话");
    const session = workerSession(worker);
    // 和用户在网页上手打一样：隐藏的命令（/clear 会换会话 ID，之后接回的是旧对话）不发，hub 退出码 1 打印原因（原因由厂商实现给）
    const blocked = ctx.commandBlockReason(session, text);
    if (blocked !== null) throw fail("invalid", blocked);
    options.taskGraphs?.onWorkerResumedIn(p, worker.id);
    const message = insertPmMessage(p, worker, session, text, sendDedupeKey(worker.id));
    enqueue(p, { type: "session.send", params: { sessionId: message.session_id!, messageId: message.id, source: "user" } });
    // /compact 这一轮只压缩上下文、没有汇报（afterDriverEvent）：别让项目经理干等
    const compactOnly = composerBaseOf(session.vendor)?.isCompactCommand(text) === true;
    startMaxTime(worker, maxTimeMs);
    return {
      text: compactOnly
        ? `已发给 Worker #${worker.id}“${worker.title}”：这一轮只压缩上下文，不会有汇报，压缩完它就空闲了，不用等。`
        : `已发给 Worker #${worker.id}“${worker.title}”，它会接着做，做完一轮汇报会自动发给你。`,
      data: { worker: toWorkerRecord(worker), messageId: message.id },
    };
  };

  const maxTimeIn = (_p: Pending, caller: AgentSessionRow & { pmId: PmId }, args: HubArgs<"worker.max-time">): HubResult<"worker.max-time"> => {
    assertPmNotArchived(caller.pmId);
    const maxTimeMs = validMaxTimeMs(args.maxTimeMs);
    const worker = ownWorker(caller.pmId, args.workerId);
    if (worker.status === "ended") throw fail("conflict", `Worker #${worker.id} 已经收工了，不能再改最大时间`);
    if (!notStarted(worker) && !isWorkerInFlight(worker)) {
      throw fail("conflict", `Worker #${worker.id} 当前没有正在运行的一轮，发下一条时用 --max-time 指定即可`);
    }
    startMaxTime(worker, maxTimeMs);
    const label = formatDurationShort(maxTimeMs);
    return {
      text: `已将 Worker #${worker.id}“${worker.title}”本轮最大时间设为 ${label}（从现在重新计时）。`,
      data: { worker: toWorkerRecord(worker), maxTimeMs },
    };
  };

  /**
   * 收工一个还开着的 Worker（hub worker end；换人时 startIn 收工节点上还挂着的旧 Worker，incomplete 恒为 true）：
   * 正在跑就先打断，标 ended，登记 session.end（这一轮回完、进程退了才算结束，接手的新 Worker 等它结束才开工，见 waitsForFirstTurn），
   * 排队的话标停止，项目经理对话里一行“已收工”，绑定的图节点按 incomplete 标完成或等人接手。返回打断了没有、节点那句回执。
   */
  const endWorkerIn = (
    p: Pending,
    worker: WorkerDbRow,
    opts: { notifyGraph?: boolean } = {},
  ): { ended: WorkerDbRow; interrupted: boolean; nodeNote: string | null } => {
    clearMaxTime(worker.worker_conversation_id);
    const session = workerSession(worker);
    // 正在跑（一轮没结束、或有排队待送的消息）：先走和网页“停止”同一条打断路径（messages.ts 的 stopIn）。还没开工的在准备中，没有这一轮
    const interrupted = !notStarted(worker) && stopIn(p, { ...session, conversationId: worker.worker_conversation_id });
    if (interrupted) endInterrupted.add(session.id);
    awaitingBackground.take(session.id);
    db.run("UPDATE workers SET status = 'ended', updated_at = ? WHERE id = ?", now(), worker.id);
    const ended = workerRow(worker.id)!;
    // 正在跑就等这一轮回完再关，然后作废令牌（session.end 的处理函数）
    enqueue(p, { type: "session.end", params: { sessionId: session.id, generation: session.generation } });
    stopQueued(p, ended);
    insertLine(p, ended, { event: "ended", status: null, summary: null, turnMessageId: null, deliver: null });
    const nodeNote =
      opts.notifyGraph === false ? null : (options.taskGraphs?.onWorkerEndedIn(p, ended.id) ?? null);
    return { ended, interrupted, nodeNote };
  };

  /** 供取消整张图或放行步骤时停掉关联的在跑 Worker（不回写已取消/已放行的步骤状态）。 */
  const stopWorkersIn: TaskGraphWorkersBridge["stopWorkersIn"] = (p, workerIds) => {
    const stopped: WorkerId[] = [];
    for (const wid of workerIds) {
      const w = workerRow(wid);
      if (w === null || w.status === "ended") continue;
      endWorkerIn(p, w, { notifyGraph: false });
      stopped.push(wid);
    }
    return stopped;
  };

  const endIn = (p: Pending, caller: AgentSessionRow & { pmId: PmId }, args: HubArgs<"worker.end">): HubResult<"worker.end"> => {
    assertPmNotArchived(caller.pmId);
    const worker = ownWorker(caller.pmId, args.workerId);
    if (worker.status === "ended") {
      clearMaxTime(worker.worker_conversation_id);
      return { text: `Worker #${worker.id}“${worker.title}”已经收工了，什么也没做。`, data: { worker: toWorkerRecord(worker) } };
    }
    const { ended, interrupted, nodeNote } = endWorkerIn(p, worker, { notifyGraph: true });
    const cleanup =
      ended.workspace === "worktree"
        ? ` worktree ${ended.worktree_path} 和分支 ${ended.branch} 还在：PR 合并后或收工满 ${WORKTREE_RETENTION_DAYS} 天且没有未提交改动时会自动清理 worktree（分支保留；还有 Worker 接着用这个目录、或它经手的任务图还没结束时不清）。`
        : "";
    const interruptNote = interrupted ? "已打断正在跑的那一轮。" : "";
    return {
      text: `Worker #${ended.id}“${ended.title}”已收工。${interruptNote}${nodeNote === null ? "" : ` ${nodeNote}`}${cleanup}`,
      data: { worker: toWorkerRecord(ended) },
    };
  };

  /** 归档项目经理时结束它下面所有 status = 'open' 的 Worker。 */
  const endOpenWorkersIn = (p: Pending, pmId: PmId) => {
    const openWorkers = db.all<WorkerDbRow>("SELECT * FROM workers WHERE pm_id = ? AND status = 'open' ORDER BY id", pmId);
    const t = now();
    for (const w of openWorkers) {
      clearMaxTime(w.worker_conversation_id);
      const session = workerSession(w);
      const queued = db.all<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? AND status = 'queued' ORDER BY id", w.worker_conversation_id);
      for (const { id } of queued) transition(p, id, "stopped");
      const interrupted = !notStarted(w) && stopIn(p, { ...session, conversationId: w.worker_conversation_id });
      if (interrupted) endInterrupted.add(session.id);
      if (!interrupted && !notStarted(w) && (queued.length > 0 || session.status === "running")) {
        p.stops.push({ conversationId: w.worker_conversation_id, sessionId: session.id });
      }
      awaitingBackground.take(session.id);
      db.run("UPDATE workers SET status = 'ended', updated_at = ? WHERE id = ?", t, w.id);
      db.run("UPDATE agent_sessions SET status = 'ended', updated_at = ? WHERE id = ? AND status != 'ended'", t, session.id);
      const ended = workerRow(w.id)!;
      enqueue(p, { type: "session.end", params: { sessionId: session.id, generation: session.generation } });
      updateLive(p, session.id, idle);
      insertLine(p, ended, { event: "ended", status: null, summary: null, turnMessageId: null, deliver: null });
      options.taskGraphs?.onWorkerEndedIn(p, ended.id);
    }
  };

  /**
   * 进行中的全列；已收工的只列最近收工的 WORKER_LIST_RECENT_ENDED 个（派了几百个以后全列会把几十 KB 塞进项目经理的上下文），更早的写一句怎么查。
   * “最近收工”按收工时间（workers.updated_at：收工时写，收工后不再改），同一时刻编号大的算后收工；不按编号，长任务的小编号刚收工也要列出来。
   * 选出来以后和进行中的一起按编号排。
   */
  const list = (caller: AgentSessionRow & { pmId: PmId }): HubResult<"worker.list"> => {
    const all = db.all<WorkerDbRow>("SELECT * FROM workers WHERE pm_id = ? ORDER BY id", caller.pmId);
    if (all.length === 0) return { text: "你还没有派过 Worker。", data: { workers: [] } };
    const endedLatestFirst = all.filter((w) => w.status === "ended").sort((a, b) => b.updated_at - a.updated_at || b.id - a.id);
    const hidden = new Set(endedLatestFirst.slice(WORKER_LIST_RECENT_ENDED));
    const rows = hidden.size === 0 ? all : all.filter((w) => !hidden.has(w));
    const lines = rows.map((w) => {
      // 实际用的：会话那一行（--model、--effort 没给时是派活时项目经理的）
      const session = workerSession(w);
      const where = w.workspace === "worktree" ? `worktree ${w.worktree_path}（分支 ${w.branch}）` : "主文件夹";
      const state = w.status === "ended" ? "已收工" : liveOf(session.id).activity === "preparing" ? "准备中" : "进行中";
      const shown = agentSettingOf(ctx, session);
      const setting = `模型 ${shown.model} · 思考程度 ${shown.effort}`;
      return `#${w.id} ${w.title} · ${state} · ${where} · ${setting}${w.readonly === 1 ? " · 只读" : ""}`;
    });
    if (hidden.size > 0) {
      lines.push(`（另有 ${hidden.size} 个更早收工的 Worker 没列出：用 \`${HUB_COMMAND} worker search <关键词>\` 搜，或 \`${HUB_COMMAND} worker show <编号>\` 看）`);
    }
    return { text: `你派出的 Worker：\n${lines.join("\n")}`, data: { workers: rows.map(toWorkerRecord) } };
  };

  /** Worker 调 hub status：我是哪个 Worker、任务是什么、在哪干活。 */
  const status = (caller: AgentSessionRow): HubResult<"status"> => {
    const worker = workerRow(caller.workerId!)!;
    const pm = pmRow(worker.pm_id)!;
    const card = projectCard(projectRow(worker.project_id));
    const graphInfo = options.taskGraphs?.workerGraphStatus(worker.id, caller.id);
    const data: WorkerHubStatus = {
      role: "worker",
      pm: { id: pm.id, name: pm.name },
      sessionId: caller.id,
      conversationId: worker.worker_conversation_id,
      worker: toWorkerRecord(worker),
      project: card,
      ...(graphInfo !== undefined ? { taskGraph: graphInfo } : {}),
    };
    const readonly = worker.readonly === 1 ? "只读（只看不改），" : "";
    const head = `你是 Worker #${worker.id}“${worker.title}”，项目经理“${pm.name}”派的，${readonly}${describeWorkspace(worker, card.mainFolder)}。`;
    if (graphInfo === undefined) {
      return { text: `${head}\n\n任务说明：\n${worker.task}`, data };
    }
    const sections = [
      head,
      `所属任务图：#${graphInfo.id}「${graphInfo.title}」· 第 ${graphInfo.stepIndex}/${graphInfo.totalSteps} 步「${graphInfo.stepTitle}」（${graphInfo.stepKey}）`,
    ];
    if (graphInfo.goal) sections.push(`图目标：\n${graphInfo.goal}`);
    sections.push(`本步职责：\n${graphInfo.brief ?? worker.task}`);
    if (graphInfo.upstream.length > 0) {
      const upLines = graphInfo.upstream.map((u) => {
        if (u.skipped) return `- ${u.key}（${u.title}）：${u.summary ?? "已跳过"}`;
        const parts = [`- ${u.key}（${u.title}）`];
        if (u.summary) parts.push(`摘要：${u.summary}`);
        if (u.branch) parts.push(`分支：${u.branch}`);
        if (u.prUrl) parts.push(`PR：${u.prUrl}`);
        if (u.reportFile) parts.push(`完整汇报：${u.reportFile}`);
        return parts.join(" · ");
      });
      sections.push(`上游交棒：\n${upLines.join("\n")}`);
    }
    const text = sections.join("\n\n");
    return { text, data };
  };

  // ---- 驱动层事件：Worker 这一轮结束 ----

  /** 在 applyDriverEvent 的同一个事务里、消息状态改完之后调。不是 Worker 的会话、不是一轮结束，什么也不做。 */
  /**
   * 这一轮没做完：一行 turn_failed，原因交给项目经理。去重键是这一轮（或发不出去的那条）消息的编号。
   * 这一轮里有用户直接对 Worker 说的话：带上原文；标了失败的写明用户那边可以自己点重试（不用项目经理转告）。
   */
  const insertTurnFailed = (p: Pending, worker: WorkerDbRow, turnMessageId: MessageId, messageIds: MessageId[], reason: string) => {
    const lines = [
      reason === TURN_STOPPED
        ? `用户亲手停了这一轮，它现在是停着的。用户没有明确说继续之前，不要用 ${HUB_COMMAND} worker send 叫醒它；先告诉用户它停了、现在是什么状态，由用户决定继续还是 ${HUB_COMMAND} worker end。`
        : `这一轮没做完：${reason}。要它接着做用 ${HUB_COMMAND} worker send ${worker.id} --stdin，不要了用 ${HUB_COMMAND} worker end ${worker.id}。`,
    ];
    for (const id of messageIds) {
      const message = db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", id);
      if (message === undefined || message.sender !== "user" || message.worker_id !== worker.id) continue;
      const retry = message.status === "failed" ? "用户那边会看到发送失败，可以自己点重试。" : "";
      lines.push(`这一轮里有用户直接对它说的话：「${message.text}」。${retry}`);
    }
    const detailBody = lines.join("\n");
    const graphDeliver =
      options.taskGraphs?.onWorkerFailedIn(p, worker.id, {
        clearActiveWorker: false,
        reasonLabel: reason === TURN_STOPPED ? "用户亲手停了它" : `这一轮没做完（${reason}）`,
        detailBody,
        stoppedByUser: reason === TURN_STOPPED,
      }) ?? null;
    insertLine(p, worker, {
      event: "turn_failed",
      status: null,
      summary: reason,
      turnMessageId,
      deliver: graphDeliver ?? detailBody,
    });
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
    const status: WorkerLineStatus = parsed.kind === "ok" ? parsed.report.status : "unformatted";
    const summary = parsed.kind === "ok" ? parsed.report.summary : parsed.summary;
    const graphHandling = options.taskGraphs?.onWorkerTurnReportIn(
      p,
      { id: worker.id, branch: worker.branch },
      parsed,
      body,
      note,
    );
    if (graphHandling?.handled === true) {
      if (graphHandling.outcome === "completed") {
        // ① 先写本步汇报行（有遗留问题才抄送唤醒 PM，否则静默存档供交棒/交付单/检索读取）
        insertLine(p, worker, {
          event: "report",
          status,
          summary,
          turnMessageId,
          deliver: body,
          wakePm: graphHandling.wakePmWithReport,
        });
        // ② 自动收工本步 Worker（入队 session.end，排在下游 session.send 之前）
        endWorkerIn(p, worker, { notifyGraph: false });
        // ③ 标步骤 done，自动拉起就绪下游或发交付单
        graphHandling.completeStep();
        return;
      }
      // 偏离 / 有问题 / 放弃了 / 没按格式 / confirm：Worker 不收工，按第 9.4 节格式唤醒 PM
      insertLine(p, worker, {
        event: "report",
        status,
        summary,
        turnMessageId,
        deliver: graphHandling.pmDeliverBody,
        wakePm: true,
      });
      return;
    }
    insertLine(p, worker, {
      event: "report",
      status,
      summary,
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
    if (worker === null) return;
    clearMaxTime(worker.worker_conversation_id);
    if (worker.status === "ended") return;
    const turnMessageId = lastAgentMessageId(session.id, awaiting.turnStart);
    if (turnMessageId === null) return;
    if (event.reason === "interrupt") return insertTurnFailed(p, worker, turnMessageId, [], TURN_STOPPED);
    if (event.reason === "crash" || event.reason === "startup_failed") return insertTurnFailed(p, worker, turnMessageId, [], exitFailureReason(event));
    insertReport(p, worker, turnMessageId, lastAgentText(session.id, awaiting.turnStart), awaiting.background ? backgroundKilledNote(event.reason) : null);
  };

  /** 一轮开始了却没在计时（用户直接发的话、claude 自己开的一轮）：按默认时长计时。已经在计时的（含重启后恢复的）不动。 */
  const ensureTurnMaxTime = (workerId: WorkerId) => {
    const worker = workerRow(workerId);
    if (worker === null || worker.status !== "open") return;
    if (turnTimeoutOf(worker.id) === null) startMaxTime(worker, DEFAULT_WORKER_MAX_TIME_MS);
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
      ensureTurnMaxTime(session.workerId);
      insertUserMessageLines(p, session.workerId, event.messageIds);
      return;
    }
    if (event.type === "message.processing") {
      const taken = event.messageIds.filter((id) => midTurnWaiting.delete(id));
      if (taken.length === 0) return;
      // 没赶上上一轮（上一轮已经结束、turnStarts 删了）：claude 为它另起的这一轮从这里开始，不会再拿到上一轮的文字
      if (!turnStarts.has(session.id)) {
        turnStarts.set(session.id, maxMessageId());
        ensureTurnMaxTime(session.workerId);
      }
      insertUserMessageLines(p, session.workerId, taken);
      return;
    }
    if (event.type === "message.cancelled" || event.type === "message.requeued") {
      for (const id of event.messageIds) midTurnWaiting.delete(id);
      if (event.type === "message.cancelled") {
        const worker = workerRow(session.workerId);
        if (worker !== null && !notStarted(worker) && !isWorkerInFlight(worker)) clearMaxTime(worker.worker_conversation_id);
      }
      return;
    }
    if (event.type === "turn.started") {
      turnStarts.set(session.id, maxMessageId());
      ensureTurnMaxTime(session.workerId);
      return;
    }
    const outcome = turnOutcome(event);
    if (outcome === null) {
      if (event.type === "session.exited" && event.reason !== "shutdown") {
        turnStarts.delete(session.id);
        const worker = workerRow(session.workerId);
        if (worker !== null && !notStarted(worker) && !isWorkerInFlight(worker)) clearMaxTime(worker.worker_conversation_id);
      }
      return;
    }
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
    if (endInterrupted.delete(session.id) && outcome.event === "turn_failed" && outcome.reason === TURN_STOPPED) {
      clearMaxTime(worker.worker_conversation_id);
      return;
    }
    // 正常结束、还有后台命令在跑：先不汇报，等命令跑完叫醒它、它再结束一轮（见 awaitingBackground）
    if (outcome.event === "report" && event.type === "turn.ended" && (liveOf(session.id).backgroundTasks ?? 0) > 0) {
      awaitingBackground.set(session.id, turnStart);
      updateLive(p, session.id, (l) => {
        l.activity = "background";
      });
      return;
    }
    clearMaxTime(worker.worker_conversation_id);
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
        if (worker !== null) clearMaxTime(worker.worker_conversation_id);
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
    const base = options.taskGraphs?.workerGraphForkBase(workerId);
    return {
      workerId,
      sessionId: workerSession(workerId).id,
      repo: mainFolderOf(worker.project_id),
      branch: worker.branch!,
      worktreePath: worker.worktree_path!,
      ...(base !== undefined ? { base } : {}),
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
   * 同一个 worktree 目录还有别的 Worker 或它的会话没彻底结束（换人接手时前任刚被收工、session.end 还没跑完或进程还没退）：
   * 别的 Worker 还开着、会话状态还不是 ended、或 pid 还在，接手的新 Worker 都等它们彻底结束才开工，绝不双写同一个目录。
   */
  const worktreeBusyByOthers = (worker: WorkerDbRow): boolean =>
    worker.workspace === "worktree" &&
    worker.worktree_path !== null &&
    worker.worktree_path !== "" &&
    db.get(
      `SELECT 1 AS x FROM workers o JOIN agent_sessions s ON s.worker_id = o.id
        WHERE o.worktree_path = ? AND o.id != ?
          AND (o.status != 'ended' OR s.status != 'ended' OR s.pid IS NOT NULL)
        LIMIT 1`,
      worker.worktree_path,
      worker.id,
    ) !== undefined;

  /**
   * session.send 处理函数问（兜底，不管消息从哪来）：这条消息要不要先等着，免得 Worker 的会话被它提前拉起来、第一轮不是任务说明。
   * Worker 的会话、Worker 还开着时：还没开工（worktree 没建好、准备命令在跑）→ 什么都等；开工了、任务说明还在排队 → 除了任务说明都等。
   */
  const waitsForFirstTurn = (sessionId: SessionId, messageId: MessageId): boolean => {
    const workerId = db.get<{ worker_id: number | null }>("SELECT worker_id FROM agent_sessions WHERE id = ?", sessionId)?.worker_id ?? null;
    const worker = workerId === null ? null : workerRow(workerId);
    if (worker === null || worker.status === "ended") return false;
    if (notStarted(worker)) return true;
    if (worktreeBusyByOthers(worker)) return true;
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
      const maxTimeMs = turnTimeoutOf(worker.id)?.max_time_ms ?? DEFAULT_WORKER_MAX_TIME_MS;
      startMaxTime(worker, maxTimeMs);
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
      clearMaxTime(worker.worker_conversation_id);
      if (worker.status !== "ended") {
        db.run("UPDATE workers SET status = 'ended', updated_at = ? WHERE id = ?", now(), worker.id);
        const session = workerSession(worker.id);
        enqueue(p, { type: "session.end", params: { sessionId: session.id, generation: session.generation } });
      }
      const deliver = `建 worktree 失败，这个 Worker 没能开工，已经收工：${error}。要的话修好问题后重新派一个。`;
      const graphDeliver =
        options.taskGraphs?.onWorkerFailedIn(p, worker.id, {
          clearActiveWorker: true,
          reasonLabel: `建 worktree 失败（${error}）`,
          detailBody: deliver,
        }) ?? null;
      insertLine(p, workerRow(worker.id)!, {
        event: "worktree_failed",
        status: null,
        summary: error,
        turnMessageId: null,
        deliver: graphDeliver ?? deliver,
      });
      const task = db.get<{ id: number }>("SELECT id FROM messages WHERE dedupe_key = ?", taskDedupeKey(worker.id));
      if (task !== undefined) transition(p, task.id, "failed", error);
      return;
    }
    if (action.type !== "session.send") return;
    const message = db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", action.params.messageId);
    if (message === undefined || (message.sender !== "pm" && message.sender !== "user") || message.worker_id === null) return;
    const worker = workerRow(message.worker_id);
    if (worker === null) return;
    clearMaxTime(worker.worker_conversation_id);
    if (worker.status === "ended") return;
    insertTurnFailed(p, worker, message.id, [message.id], error);
  };

  /** 已收工、建过 worktree 的 Worker 的 worktree 目录是否已被清理掉。 */
  const isWorktreeCleaned = (worker: WorkerDbRow): boolean =>
    worker.workspace === "worktree" &&
    worker.status === "ended" &&
    worker.base_commit !== null &&
    worker.worktree_path !== null &&
    existsSync(worktreesDir) &&
    !existsSync(worker.worktree_path);

  /** agent 接口在 worker.show 之前查 PR 用：这个项目经理派的、在 worktree 里干活的 Worker 的 worktree 目录（已清理则退回主文件夹）和分支；别的 null。 */
  const workerPrTarget = (session: AgentSessionRow | null, workerId: WorkerId): { cwd: string; branch: string } | null => {
    if (session === null || session.role !== "pm" || session.pmId === null) return null;
    const worker = workerRow(workerId);
    if (worker === null || worker.pm_id !== session.pmId || worker.workspace !== "worktree") return null;
    if (worker.worktree_path === null || worker.branch === null || worker.base_commit === null) return null;
    const cwd = isWorktreeCleaned(worker) ? mainFolderOf(worker.project_id) : worker.worktree_path;
    return cwd === "" ? null : { cwd, branch: worker.branch };
  };

  /** 已收工、用 worktree 的 Worker 列表（供后台自动清理扫描候选）。 */
  const listEndedWorktreeWorkers = (): EndedWorktreeCandidate[] =>
    db
      .all<{
        id: number;
        project_id: number;
        branch: string;
        worktree_path: string;
        base_commit: string | null;
        ended_at: number;
        repo_folder: string;
      }>(
        `SELECT w.id, w.project_id, w.branch, w.worktree_path, w.base_commit,
                (SELECT max(o.updated_at) FROM workers o WHERE o.worktree_path = w.worktree_path) AS ended_at,
                f.path AS repo_folder
         FROM workers w
         JOIN project_folders f ON f.project_id = w.project_id AND f.is_main = 1 AND f.removed_at IS NULL
         WHERE w.status = 'ended' AND w.workspace = 'worktree'
           AND w.worktree_path IS NOT NULL AND w.worktree_path != '' AND w.branch IS NOT NULL
           AND w.id = (SELECT min(o.id) FROM workers o WHERE o.worktree_path = w.worktree_path AND o.status = 'ended')
         ORDER BY w.id`,
      )
      .map((r) => ({
        workerId: r.id,
        projectId: r.project_id,
        repoFolder: r.repo_folder,
        branch: r.branch,
        worktreePath: r.worktree_path,
        baseCommit: r.base_commit,
        endedAt: r.ended_at,
      }));

  /**
   * 清理前再次确认能删这个 Worker 的 worktree 目录（docs/orchestration-simplify-design.md 第 4.4 节）：
   * - 它仍已收工、没有正在跑的一轮；
   * - 同一个目录（换人接手时前后几个 Worker 共用）没有还开着的 Worker，也没有哪个的一轮还在跑或进程未退；
   * - 共用这个目录的 Worker 经手过的任务图都已经结束（图还 active 时随时可能换人接着用这个目录）。
   */
  const isWorkerCleanable = (workerId: WorkerId): boolean => {
    const worker = workerRow(workerId);
    if (
      worker === null ||
      worker.status !== "ended" ||
      worker.workspace !== "worktree" ||
      worker.worktree_path === null ||
      worker.worktree_path === ""
    ) {
      return false;
    }
    const sharing = db.all<WorkerDbRow>("SELECT * FROM workers WHERE worktree_path = ?", worker.worktree_path);
    if (
      sharing.some((w) => {
        if (w.status !== "ended" || isWorkerInFlight(w)) return true;
        const s = currentSession(w.worker_conversation_id);
        return s !== null && (s.pid !== null || liveOf(s.id).activity === "stopping");
      })
    ) {
      return false;
    }
    return !inActiveGraph(sharing.map((w) => w.id));
  };

  /** 这些 Worker 里有没有经手过还 active 的任务图节点的（节点的 worker_ids_json 里有它）。 */
  const inActiveGraph = (workerIds: readonly WorkerId[]): boolean =>
    workerIds.length > 0 &&
    db.get(
      `SELECT 1 AS x FROM task_graphs g JOIN task_graph_steps n ON n.graph_id = g.id, json_each(n.worker_ids_json) j
        WHERE g.status = 'active' AND j.value IN (${workerIds.map(() => "?").join(", ")})
        LIMIT 1`,
      ...workerIds,
    ) !== undefined;

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

  /**
   * WorkerRecord 加上 takeoverOf：换人接手时接着用的是哪个前任的 worktree。目录按 Worker 编号建（paths.ts 的 workerWorktreePath），
   * 所以就是同一个目录里最早的那个 Worker；自己建的（最早的就是自己）、在主文件夹里干的没有。
   */
  const withTakeoverOf = (worker: WorkerDbRow): WorkerRecord => {
    const record = toWorkerRecord(worker);
    if (worker.workspace !== "worktree" || worker.worktree_path === null || worker.worktree_path === "") return record;
    const owner = db.get<{ id: number }>("SELECT min(id) AS id FROM workers WHERE worktree_path = ?", worker.worktree_path)?.id ?? worker.id;
    return owner === worker.id ? record : { ...record, takeoverOf: owner };
  };

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
      worker: withTakeoverOf(worker),
      ...(isAgentVendor(session.vendor) ? { vendor: session.vendor } : {}),
    };
  };

  return {
    startIn,
    dispatchStepWorkerIn,
    sendIn,
    maxTimeIn,
    endIn,
    stopWorkersIn,
    endOpenWorkersIn,
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
    clearMaxTime,
    clearAllMaxTime,
    turnMaxTimeOf,
    recoverTurnTimeouts,
    maxTimeTimers,
    isWorktreeCleaned,
    listEndedWorktreeWorkers,
    isWorkerCleanable,
  };
}
