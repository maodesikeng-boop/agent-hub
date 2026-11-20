import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { AnyActionRow, ReviewVerifyParams } from "../../shared/actions.ts";
import { agentTextOf } from "../../shared/attachments.ts";
import { normalizeWorkerTitle, systemMessageDedupeKey, utf8Bytes, workerMessageDedupeKey } from "../../shared/domain.ts";
import type {
  AgentSessionRow,
  ConversationId,
  Message,
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
import {
  parseReviewTarget,
  reviewVerifyErrorProblem,
  type ReviewSnapshot,
  type ReviewTarget,
  type ReviewVerifyResult,
} from "../../shared/review.ts";
import { checkWorkerMaxTimeMs, formatDurationShort } from "../../shared/schedule.ts";
import { AGENT_VENDORS, checkEffort, checkModel, checkModelEffort, isAgentVendor, splitModelEffort } from "../../shared/vendors.ts";
import { UserBlockedError, userBlockerKindOf, userBlockerKindOfFailure, userBlockerResumeText, type UserBlocker } from "../../shared/user-blockers.ts";
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
import { isPathStrictlyInside } from "../platform/index.ts";
import { agentSettingOf } from "./worker-view.ts";
import { toConversation, toMessage, toWorkerRecord } from "./rows.ts";
import type { ConversationDbRow, MessageDbRow, ProjectDbRow, WorkerDbRow } from "./rows.ts";
import { idle } from "./sessions.ts";
import type { LedgerSessions } from "./sessions.ts";
import { hasGitCommitSync, renderGraphStepTask } from "./task-graph-handoff.ts";
import type { StepWorkspacePlan, TaskGraphWorkersBridge, WorkerBindTarget } from "./task-graphs.ts";
import { newestFirst } from "./takeover.ts";
import type { LedgerTakeover, TakeoverPredecessor } from "./takeover.ts";
import { userBlockedPmNote, type LedgerUserBlockers } from "./user-blockers.ts";

const WORKTREE_DIRTY_NOTE = "注意：主文件夹里有没提交的改动，Worker 是从最后一次提交开始的，看不到这些改动。";
const TURN_STOPPED = "被停止了";
const TURN_FAILED = "这一轮出错了";
const RECEIVED_STATUSES: ReadonlySet<string> = new Set(["delivered", "processing", "replied"]);
function backgroundKilledNote(reason: "idle" | "shutdown" | "restart"): string {
  const resend = `要它重跑或接着做用 ${HUB_COMMAND} worker send。`;
  if (reason === "restart") {
    return `【系统】这个 Worker 在等放到后台的命令时守护进程重启了，命令随旧进程中断（跑没跑完、结果它都没看到）；下面是它中断前最后一轮的回复。${resend}`;
  }
  const why = reason === "idle" ? `超过 ${WORKER_BACKGROUND_HOLD_MAX_MS / 60_000} 分钟还没结束（可能卡住了）` : "还没结束，守护进程就关了";
  return `【系统】这个 Worker 放到后台的命令${why}，已经连同它的进程一起停掉；下面是它停之前最后一轮的回复。${resend}`;
}
const NO_REPLY_TEXT = "（这一轮没有文字回复）";

const taskDedupeKey = (workerId: WorkerId) => `pm:worker:${workerId}:task`;
const sendDedupeKey = (workerId: WorkerId) => `pm:worker:${workerId}:${randomUUID()}`;

type BackgroundWait = { turnStart: MessageId; background: boolean };

type TurnOutcome =
  | { event: "report"; turnMessageId: MessageId | null }
  | { event: "turn_failed"; turnMessageId: MessageId | null; messageIds: MessageId[]; reason: string };

function turnOutcome(event: DriverEvent): TurnOutcome | null {
  if (event.type === "driver.error") {
    const ids = event.messageIds ?? [];
    return ids.length === 0 ? null : { event: "turn_failed", turnMessageId: Math.max(...ids), messageIds: ids, reason: event.message };
  }
  if (event.type !== "turn.ended" && event.type !== "session.exited") return null;
  const { messageIds } = event;
  const selfStarted = event.type === "turn.ended" && messageIds.length === 0;
  if (messageIds.length === 0 && !selfStarted) return null;
  const turnMessageId = selfStarted ? null : Math.max(...messageIds);
  if (event.type === "turn.ended") {
    if (event.shutdown === true) return null;
    if (event.interrupted) return { event: "turn_failed", turnMessageId, messageIds, reason: TURN_STOPPED };
    if (!event.ok) {
      const reason = event.error === undefined ? TURN_FAILED : turnFailureReason(event.error);
      return { event: "turn_failed", turnMessageId, messageIds, reason };
    }
    return { event: "report", turnMessageId };
  }
  if (event.hadResult) return null;
  if (event.reason === "interrupt") return { event: "turn_failed", turnMessageId, messageIds, reason: TURN_STOPPED };
  if (event.reason === "crash" || event.reason === "startup_failed") {
    return { event: "turn_failed", turnMessageId, messageIds, reason: exitFailureReason(event) };
  }
  return null;
}

export const notStarted = (worker: Pick<WorkerDbRow, "workspace" | "base_commit">) => worker.workspace === "worktree" && worker.base_commit === null;

export function assertWorkerOpenForUser(db: Db, conversationId: ConversationId): void {
  const worker = db.get<Pick<WorkerDbRow, "id" | "status" | "workspace" | "base_commit">>(
    "SELECT id, status, workspace, base_commit FROM workers WHERE worker_conversation_id = ?",
    conversationId,
  );
  if (worker === undefined) return;
  if (worker.status === "ended") throw fail("conflict", `Worker #${worker.id} 已经收工了，不能再给它发消息`);
  if (notStarted(worker)) throw fail("conflict", `Worker 还在准备，等它开工后再发（Worker #${worker.id} 在建 worktree 或跑项目的准备命令）`);
}

function gitReasonLine(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const reason = lines.find((l) => /^(fatal|error):/.test(l)) ?? lines.at(-1) ?? "没有给出原因";
  return [...reason.replace(/。$/, "")].slice(0, GIT_REASON_MAX_CHARS).join("");
}

function worktreeLabel(worker: WorkerDbRow): string {
  const review = parseReviewTarget(worker.review_json);
  return review !== null
    ? `审查目录 ${worker.worktree_path}（detached 在被审分支 ${review.branch} 上）`
    : `worktree ${worker.worktree_path}（分支 ${worker.branch}）`;
}

function describeWorkspace(worker: WorkerDbRow, mainFolder: string): string {
  return worker.workspace === "worktree" ? `在${worktreeLabel(worker)}里干活` : `直接在项目的主文件夹 ${mainFolder} 里干活`;
}

const newReviewJson = (plan: StepWorkspacePlan): string | null =>
  plan.kind === "review" ? JSON.stringify({ branch: plan.branch, snapshot: null } satisfies ReviewTarget) : null;

export type EndedWorktreeCandidate = {
  workerId: WorkerId;
  projectId: number;
  repoFolder: string;
  worktreePath: string;
  baseCommit: string | null;
  endedAt: number;
} & ({ review: false; branch: string } | { review: true; branch: null });

export type LedgerWorkers = ReturnType<typeof createLedgerWorkers>;

export type ReportMessage = Pick<Message, "id" | "text" | "meta">;
type ReportMessageRow = { id: number; text: string; meta: string | null };
const toReportMessage = (row: ReportMessageRow | undefined): ReportMessage | null =>
  row === undefined ? null : { id: row.id, text: row.text, meta: row.meta === null ? null : (JSON.parse(row.meta) as Record<string, unknown>) };

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
    worker: { id: WorkerId; branch: string | null; review: ReviewTarget | null },
    parsed: ParsedWorkerReport,
    rawBody: string,
    forcedNote: string | null,
    opts?: { hasPendingFollowup?: boolean; reviewVerified?: ReviewVerifyResult; reportMessage?: ReportMessage | null },
  ) =>
    | { handled: false }
    | { handled: true; outcome: "verify" }
    | { handled: true; outcome: "completed"; wakePmWithReport: boolean; completeStep: () => void }
    | { handled: true; outcome: "waiting_user" }
    | { handled: true; outcome: "waiting_pm"; pmDeliverBody: string };
  onWorkerFailedIn: (
    p: Pending,
    workerId: WorkerId,
    opts: { clearActiveWorker: boolean; reasonLabel: string; detailBody: string; stoppedByUser?: boolean },
  ) => string | null;
  onWorkerUserBlockedIn: (p: Pending, workerId: WorkerId, blocker: UserBlocker) => string | null;
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
  options: {
    worktreesDir: string;
    extraWorktreeRoots?: () => readonly string[];
    taskGraphs?: LedgerWorkersTaskGraphHooks;
    userBlockers?: Pick<LedgerUserBlockers, "raiseIn" | "attachWorkerIn">;
    takeover?: LedgerTakeover;
  },
) {
  const { db, now, write, enqueue } = ctx;
  const { currentSession, dropRateLimitRejection, insertSession, liveOf, updateLive } = sessions;
  const { transition, stopIn } = messages;
  const { pmRow, assertPmNotArchived } = persona;
  const { activeProjectOf, projectCard, syncSessionFolders } = projects;
  const { worktreesDir } = options;
  /** Max message id at turn start, in memory only, so a PM message sent mid-turn cannot make the last reply look older than the previous turn's text. */
  const turnStarts = new Map<SessionId, MessageId>();
  /** Mid-turn deliveries count only once the Worker reads them, because a stop before that cancels them. */
  const midTurnWaiting = new Set<MessageId>();
  /** Turns interrupted by endIn are not reported back because the PM stopped them itself. */
  const endInterrupted = new Set<SessionId>();
  /** Only the timers live in memory; duration, deadline and reminder state persist in worker_turn_timeouts for restart recovery. */
  const maxTimeTimers = new Map<ConversationId, { timer: ReturnType<typeof setTimeout>; maxTimeMs: number; startedAt: number }>();

  /** A turn that ends with background commands still running is not reported yet, otherwise the PM would get a premature "done". */
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
    take: (sessionId: SessionId): BackgroundWait | undefined => {
      const wait = awaitingBackground.get(sessionId);
      if (wait !== undefined) db.run("DELETE FROM worker_background_waits WHERE session_id = ?", sessionId);
      return wait;
    },
  };

  const workerRow = (id: WorkerId): WorkerDbRow | null => db.get<WorkerDbRow>("SELECT * FROM workers WHERE id = ?", id) ?? null;
  const projectRow = (id: number): ProjectDbRow => db.get<ProjectDbRow>("SELECT * FROM projects WHERE id = ?", id)!;
  const workerSession = (worker: WorkerId | WorkerDbRow): AgentSessionRow =>
    currentSession((typeof worker === "number" ? workerRow(worker)! : worker).worker_conversation_id)!;
  const mainFolderOf = (projectId: number): string => projectCard(projectRow(projectId)).mainFolder;

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

  const clearMaxTime = (workerConversationId: ConversationId) => {
    stopTimer(workerConversationId);
    db.run("DELETE FROM worker_turn_timeouts WHERE worker_id = (SELECT id FROM workers WHERE worker_conversation_id = ?)", workerConversationId);
  };

  /** On daemon stop keep the stored timers so restart recovery can re-arm them. */
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
      // Writes fail during shutdown; do not retry, restart recovery re-arms timers from stored state.
    }
  };

  const armTimer = (worker: Pick<WorkerDbRow, "id" | "worker_conversation_id">, maxTimeMs: number, deadline: number) => {
    stopTimer(worker.worker_conversation_id);
    const startedAt = deadline - maxTimeMs;
    const timer = setTimeout(() => {
      onMaxTimeExceeded(worker.id, worker.worker_conversation_id, timer, maxTimeMs, startedAt);
    }, Math.max(0, deadline - now()));
    timer.unref?.();
    maxTimeTimers.set(worker.worker_conversation_id, { timer, maxTimeMs, startedAt });
  };

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

  const turnTimeoutOf = (workerId: WorkerId) =>
    db.get<{ max_time_ms: number; deadline_at: number; notified: number }>(
      "SELECT max_time_ms, deadline_at, notified FROM worker_turn_timeouts WHERE worker_id = ?",
      workerId,
    ) ?? null;

  const turnMaxTimeOf = (workerConversationId: ConversationId): { maxTimeMs: number; startedAt: number } | null => {
    const row = db.get<{ max_time_ms: number; deadline_at: number }>(
      `SELECT t.max_time_ms, t.deadline_at FROM worker_turn_timeouts t JOIN workers w ON w.id = t.worker_id
        WHERE w.worker_conversation_id = ?`,
      workerConversationId,
    );
    return row === undefined ? null : { maxTimeMs: row.max_time_ms, startedAt: row.deadline_at - row.max_time_ms };
  };

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

  const stopQueued = (p: Pending, worker: WorkerDbRow) => {
    for (const row of db.all<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? AND status = 'queued'", worker.worker_conversation_id)) {
      transition(p, row.id, "stopped");
    }
  };

  const enqueueFirstTurn = (p: Pending, worker: WorkerDbRow) => {
    const session = workerSession(worker);
    const queued = db.all<{ id: number }>(
      "SELECT id FROM messages WHERE conversation_id = ? AND sender = 'pm' AND status = 'queued' ORDER BY id ASC",
      worker.worker_conversation_id,
    );
    enqueue(p, { type: "session.start", params: { sessionId: session.id, generation: session.generation } });
    for (const row of queued) {
      enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId: row.id, source: "user" } });
    }
  };

  /** When git fails the start is refused instead of silently running in the main folder. */
  const gitFailed = (output: string) =>
    fail("git_failed", `git 没跑成：${gitReasonLine(output)}。可以重试；或者加 --no-worktree，明确让 Worker 在主文件夹里干。`);

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

  const checkTargetVendorUsable = (vendor: AgentVendor): void => {
    const kind = userBlockerKindOf(ctx.vendorAvailability(vendor));
    if (kind !== null) throw new UserBlockedError({ kind, vendor, device: ctx.deviceName() });
  };

  const endOpenUpstreamIn = (p: Pending, plan: StepWorkspacePlan): void => {
    const path = plan.kind === "inherit" ? plan.worktreePath : plan.kind === "review" ? plan.implWorktreePath : null;
    if (path === null) return;
    for (const prevWorker of db.all<WorkerDbRow>("SELECT * FROM workers WHERE worktree_path = ? AND status = 'open' ORDER BY id", path)) {
      endWorkerIn(p, prevWorker, { notifyGraph: false });
    }
  };

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
    checkTargetVendorUsable(vendor);

    const catalog = ctx.modelCatalog(vendor);
    const badSetting =
      checkModel(vendor, input.model) ??
      checkEffort(vendor, input.effort, catalog) ??
      checkModelEffort(vendor, input.model, input.effort, catalog);
    if (badSetting !== null) throw fail("invalid", badSetting);
    const { model, effort } = splitModelEffort(vendor, input.model, input.effort, catalog);

    if (!ctx.osSandboxed()) throw fail("invalid", WORKER_NEEDS_OS_SANDBOX_MESSAGE);

    const card = projectCard(project);
    const plan = input.workspacePlan;
    const inheritedPlan = plan.kind === "inherit" ? plan : null;
    endOpenUpstreamIn(p, plan);
    const probe =
      plan.kind === "inherit" || plan.kind === "review"
        ? { isRepoWithCommit: true, hasUncommittedChanges: false }
        : probeWorkspaceForStep(project.id, card.mainFolder, input.context, true);
    const workspace = probe.isRepoWithCommit ? "worktree" : "main";

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
                            branch, worktree_path, base_commit, review_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      newReviewJson(plan),
      t,
      t,
    ).lastInsertRowid;

    if (workspace === "worktree" && inheritedPlan === null) {
      db.run(
        "UPDATE workers SET branch = ?, worktree_path = ? WHERE id = ?",
        plan.kind === "review" ? null : workerBranchName(id, title),
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
    let vendor = (bindTarget?.vendor ?? caller.vendor) as AgentVendor;
    if (args.vendor !== undefined) {
      if (!isAgentVendor(args.vendor)) throw fail("invalid", `厂商只能是 ${AGENT_VENDORS.join("、")}`);
      vendor = args.vendor;
      checkTargetVendorUsable(vendor);
    } else if (bindTarget?.vendor !== null && bindTarget?.vendor !== undefined) {
      if (!isAgentVendor(bindTarget.vendor)) throw fail("invalid", `厂商只能是 ${AGENT_VENDORS.join("、")}`);
      checkTargetVendorUsable(vendor);
    }
    const reuseStepModel = bindTarget !== undefined && args.vendor === undefined && bindTarget.vendor === vendor;
    const givenModel =
      typeof args.model === "string" ? args.model.trim() || null : reuseStepModel ? bindTarget.model : null;
    const givenEffort =
      typeof args.effort === "string" ? args.effort.trim() || null : reuseStepModel ? bindTarget.effort : null;
    const catalog = ctx.modelCatalog(vendor);
    const badSetting = checkModel(vendor, givenModel) ?? checkEffort(vendor, givenEffort, catalog) ?? checkModelEffort(vendor, givenModel, givenEffort, catalog);
    if (badSetting !== null) throw fail("invalid", badSetting);
    // agy encodes effort in the model id, so both spellings are normalized to model plus effort.
    const { model, effort } = splitModelEffort(vendor, givenModel, givenEffort, catalog);
    const readonly = args.readonly !== undefined ? args.readonly === true : (bindTarget?.readonly ?? false);
    // Every Worker requires a working OS sandbox; there is no rule-based fallback.
    if (!ctx.osSandboxed()) throw fail("invalid", WORKER_NEEDS_OS_SANDBOX_MESSAGE);
    const card = projectCard(project);
    const reviewPlan: Extract<StepWorkspacePlan, { kind: "review" }> | null =
      bindTarget?.workspacePlan.kind === "review" ? bindTarget.workspacePlan : null;
    if (reviewPlan !== null && args.noWorktree === true) {
      throw fail("invalid", `审查步骤只能在 detached 检出被审分支 ${reviewPlan.branch} 的独立审查目录里干活，不能用 --no-worktree`);
    }
    const inherit = reviewPlan === null ? (takeover?.inherit ?? null) : null;
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
    if (args.noWorktree !== true && effectiveInherit === null && reviewPlan === null) {
      probe = probeWorkspaceForStep(project.id, card.mainFolder, context, bindTarget !== undefined);
    }
    const workspace = effectiveInherit !== null || reviewPlan !== null || probe.isRepoWithCommit ? "worktree" : "main";

    // Read the predecessor records before closing the old Worker, which is ended as incomplete.
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
      // Close leftover open Workers on the taken-over directory first, otherwise waitsForFirstTurn deadlocks.
      endOpenUpstreamIn(p, { kind: "inherit", ...effectiveInherit });
    } else if (reviewPlan !== null) {
      endOpenUpstreamIn(p, reviewPlan);
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
    // The id is needed to derive branch and directory, so insert a placeholder that satisfies the CHECK and update it right away.
    const id = db.run(
      `INSERT INTO workers (project_id, pm_id, pm_conversation_id, worker_conversation_id, title, task, model, effort, readonly, workspace,
                            branch, worktree_path, base_commit, review_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      reviewPlan === null ? null : newReviewJson(reviewPlan),
      t,
      t,
    ).lastInsertRowid;
    if (workspace === "worktree" && effectiveInherit === null) {
      db.run(
        "UPDATE workers SET branch = ?, worktree_path = ? WHERE id = ?",
        reviewPlan === null ? workerBranchName(id, title) : null,
        workerWorktreePath(worktreesDir, project.id, id),
        id,
      );
    }
    const worker = workerRow(id)!;
    const sameVendor = vendor === caller.vendor;
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
    const workerRecord = toWorkerRecord(worker);
    let takeoverText: string | null = null;
    if (takeover !== null && bindTarget !== undefined && takeoverPredecessors !== null) {
      const branches = [...new Set(takeover.predecessors.map((w) => w.branch).filter((b): b is string => b !== null && b !== ""))];
      const branchNote = branches.length === 0 ? "" : `前任的分支 ${branches.join("、")} 还在，要的话自己合进来。`;
      const baseWorkspaceNote =
        reviewPlan !== null
          ? `你在新开的审查目录 ${worker.worktree_path} 里，detached 在被审分支 ${reviewPlan.branch} 上；前任的审查目录不接手，它的结论和复现看下面的记录。`
          : inherit !== null
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
      const first = db.get<{ id: number }>("SELECT id FROM messages WHERE dedupe_key = ?", taskDedupeKey(id))!;
      enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId: first.id, source: "user" } });
    } else if (workspace === "worktree") {
      enqueue(p, { type: "worktree.create", params: { workerId: id } });
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
    // Before work starts the first turn must be the task brief; sending now would start the session early.
    if (notStarted(worker)) throw fail("conflict", `Worker 还在准备，等它开工后再发（Worker #${worker.id} 在建 worktree 或跑项目的准备命令）`);
    const text = validTask(args.text, "要发给 Worker 的话");
    const session = workerSession(worker);
    // Hidden commands like /clear would swap the session id and later resumes would reattach the old conversation.
    const blocked = ctx.commandBlockReason(session, text);
    if (blocked !== null) throw fail("invalid", blocked);
    options.taskGraphs?.onWorkerResumedIn(p, worker.id);
    dropRateLimitRejection(p, session.id);
    const message = insertPmMessage(p, worker, session, text, sendDedupeKey(worker.id));
    enqueue(p, { type: "session.send", params: { sessionId: message.session_id!, messageId: message.id, source: "user" } });
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

  const endWorkerIn = (
    p: Pending,
    worker: WorkerDbRow,
    opts: { notifyGraph?: boolean } = {},
  ): { ended: WorkerDbRow; interrupted: boolean; nodeNote: string | null } => {
    clearMaxTime(worker.worker_conversation_id);
    const session = workerSession(worker);
    const interrupted = !notStarted(worker) && stopIn(p, { ...session, conversationId: worker.worker_conversation_id });
    if (interrupted) endInterrupted.add(session.id);
    awaitingBackground.take(session.id);
    db.run("UPDATE workers SET status = 'ended', updated_at = ? WHERE id = ?", now(), worker.id);
    const ended = workerRow(worker.id)!;
    enqueue(p, { type: "session.end", params: { sessionId: session.id, generation: session.generation } });
    stopQueued(p, ended);
    insertLine(p, ended, { event: "ended", status: null, summary: null, turnMessageId: null, deliver: null });
    const nodeNote =
      opts.notifyGraph === false ? null : (options.taskGraphs?.onWorkerEndedIn(p, ended.id) ?? null);
    return { ended, interrupted, nodeNote };
  };

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

  const deliverToWorkerIn: TaskGraphWorkersBridge["deliverToWorkerIn"] = (p, input) => {
    const existing = db.get<{ id: number }>("SELECT id FROM messages WHERE dedupe_key = ?", input.dedupeKey);
    if (existing !== undefined) return existing.id;
    const w = workerRow(input.workerId);
    if (w === null || w.status === "ended") return null;
    const session = workerSession(w);
    const message = insertPmMessage(p, w, session, input.text, input.dedupeKey);
    if (!notStarted(w)) {
      enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId: message.id, source: "user" } });
      startMaxTime(w, input.maxTimeMs ?? DEFAULT_WORKER_MAX_TIME_MS);
    }
    return message.id;
  };

  const resumeUserBlockedWorkerIn = (p: Pending, workerId: WorkerId, messageIds: readonly MessageId[], blocker: UserBlocker) => {
    const worker = workerRow(workerId);
    if (worker === null || worker.status === "ended") return;
    const session = workerSession(worker);
    const failed = messageIds.filter((id) => db.get<{ status: string | null }>("SELECT status FROM messages WHERE id = ?", id)?.status === "failed");
    if (failed.length === 0) {
      const inFlight = db.get(
        "SELECT 1 AS x FROM messages WHERE conversation_id = ? AND sender IN ('pm', 'user') AND status IN ('queued', 'delivered', 'processing') LIMIT 1",
        worker.worker_conversation_id,
      );
      if (inFlight === undefined) {
        deliverToWorkerIn(p, { workerId, text: userBlockerResumeText(blocker), dedupeKey: `user-blocker-resumed:${blocker.id}:${workerId}` });
      }
      return;
    }
    const t = now();
    for (const id of failed) {
      db.run(
        "UPDATE messages SET status = 'queued', failure_reason = NULL, meta = json_remove(meta, '$.deliveryConfirmed'), session_id = ?, updated_at = ? WHERE id = ?",
        session.id,
        t,
        id,
      );
      enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId: id, source: "user" } });
      const message = messages.getMessage(id);
      if (message !== null) p.changes.push({ type: "message.updated", data: { message } });
    }
    startMaxTime(worker);
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
      ended.workspace === "worktree" && ended.review_json !== null
        ? ` ${worktreeLabel(ended)}会自动删掉。`
        : ended.workspace === "worktree"
        ? ` worktree ${ended.worktree_path} 和分支 ${ended.branch} 还在：PR 合并后或收工满 ${WORKTREE_RETENTION_DAYS} 天且没有未提交改动时会自动清理 worktree（分支保留；还有 Worker 接着用这个目录、或它经手的任务图还没结束时不清）。`
        : "";
    const interruptNote = interrupted ? "已打断正在跑的那一轮。" : "";
    return {
      text: `Worker #${ended.id}“${ended.title}”已收工。${interruptNote}${nodeNote === null ? "" : ` ${nodeNote}`}${cleanup}`,
      data: { worker: toWorkerRecord(ended) },
    };
  };

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

  /** Ended Workers are capped at WORKER_LIST_RECENT_ENDED so hundreds of entries do not flood the PM context; recency uses updated_at, not id. */
  const list = (caller: AgentSessionRow & { pmId: PmId }): HubResult<"worker.list"> => {
    const all = db.all<WorkerDbRow>("SELECT * FROM workers WHERE pm_id = ? ORDER BY id", caller.pmId);
    if (all.length === 0) return { text: "你还没有派过 Worker。", data: { workers: [] } };
    const endedLatestFirst = all.filter((w) => w.status === "ended").sort((a, b) => b.updated_at - a.updated_at || b.id - a.id);
    const hidden = new Set(endedLatestFirst.slice(WORKER_LIST_RECENT_ENDED));
    const rows = hidden.size === 0 ? all : all.filter((w) => !hidden.has(w));
    const lines = rows.map((w) => {
      const session = workerSession(w);
      const where = w.workspace === "worktree" ? worktreeLabel(w) : "主文件夹";
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
    const vendor = workerSession(worker).vendor;
    const blockedKind = reason === TURN_STOPPED || !isAgentVendor(vendor) ? null : userBlockerKindOfFailure(reason, vendor);
    if (blockedKind !== null && options.userBlockers !== undefined && isAgentVendor(vendor)) {
      const blocker = options.userBlockers.raiseIn(p, blockedKind, vendor, worker.pm_conversation_id);
      options.userBlockers.attachWorkerIn(blocker.id, worker.id, messageIds);
      const graphNote = options.taskGraphs?.onWorkerUserBlockedIn(p, worker.id, blocker) ?? null;
      insertLine(p, worker, {
        event: "turn_failed",
        status: null,
        summary: reason,
        turnMessageId,
        deliver: [graphNote ?? `Worker #${worker.id} 起不来：${userBlockedPmNote(blocker)}。`, ...lines.slice(1)].join("\n"),
      });
      return;
    }
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

  const insertUserMessageLines = (p: Pending, workerId: WorkerId, messageIds: MessageId[]) => {
    const worker = workerRow(workerId);
    if (worker === null) return;
    for (const id of messageIds) {
      const message = db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", id);
      if (message === undefined || message.sender !== "user" || message.worker_id !== workerId) continue;
      if (!RECEIVED_STATUSES.has(message.status ?? "")) continue;
      const deliver = agentTextOf(toMessage(message));
      insertLine(p, worker, { event: "user_message", status: null, summary: message.text, turnMessageId: id, deliver });
    }
  };

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

  const lastAgentMessageId = (sessionId: SessionId, turnStart: number): MessageId | null =>
    db.get<{ id: number | null }>(`SELECT max(id) AS id FROM messages WHERE session_id = ? AND sender = 'agent' AND id > ?`, sessionId, turnStart)!.id;

  const lastAgentTextMessage = (sessionId: SessionId, turnStart: number): ReportMessage | null =>
    toReportMessage(
      db.get<ReportMessageRow>(
        `SELECT id, text, meta FROM messages WHERE session_id = ? AND sender = 'agent' AND kind = 'text' AND id > ? ORDER BY id DESC LIMIT 1`,
        sessionId,
        turnStart,
      ),
    );

  const insertReport = (
    p: Pending,
    worker: WorkerDbRow,
    turnMessageId: MessageId,
    reportMessage: ReportMessage | null,
    note: string | null = null,
    opts?: { hasPendingFollowup?: boolean; reviewVerified?: ReviewVerifyResult },
  ) => {
    const text = reportMessage?.text ?? "";
    const parsed = parseWorkerReport(text);
    const body = text.trim() === "" ? NO_REPLY_TEXT : text;
    const status: WorkerLineStatus = parsed.kind === "ok" ? parsed.report.status : "unformatted";
    const summary = parsed.kind === "ok" ? parsed.report.summary : parsed.summary;
    const graphHandling = options.taskGraphs?.onWorkerTurnReportIn(
      p,
      { id: worker.id, branch: worker.branch, review: parseReviewTarget(worker.review_json) },
      parsed,
      body,
      note,
      { ...opts, reportMessage },
    );
    if (graphHandling?.handled === true) {
      if (graphHandling.outcome === "verify") {
        enqueue(p, { type: "review.verify", params: { workerId: worker.id, turnMessageId, reportMessageId: reportMessage!.id } });
        return;
      }
      if (graphHandling.outcome === "completed") {
        insertLine(p, worker, {
          event: "report",
          status,
          summary,
          turnMessageId,
          deliver: body,
          wakePm: graphHandling.wakePmWithReport,
        });
        endWorkerIn(p, worker, { notifyGraph: false });
        graphHandling.completeStep();
        return;
      }
      if (graphHandling.outcome === "waiting_user") {
        insertLine(p, worker, {
          event: "report",
          status,
          summary,
          turnMessageId,
          deliver: body,
          wakePm: false,
        });
        return;
      }
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
    insertReport(p, worker, turnMessageId, lastAgentTextMessage(session.id, awaiting.turnStart), awaiting.background ? backgroundKilledNote(event.reason) : null);
  };

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
      if (awaiting !== undefined && event.messageIds.length === 0) return flushAwaiting(p, session, event, awaiting);
    }
    if (event.type === "message.delivered") {
      // Messages delivered mid-turn do not start a new turn, because earlier text in this turn still belongs to the report.
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
      // claude started a separate turn for a message that missed the previous one, so the turn starts here.
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
    if (outcome.turnMessageId === null && !turnStarts.has(session.id)) return;
    // Do not take the max of the two ids; a mid-turn delivery id is larger than earlier text and would drop it from the report.
    const awaiting = awaitingBackground.take(session.id);
    const turnStart = awaiting?.turnStart ?? turnStarts.get(session.id) ?? outcome.turnMessageId ?? 0;
    turnStarts.delete(session.id);
    if (endInterrupted.delete(session.id) && outcome.event === "turn_failed" && outcome.reason === TURN_STOPPED) {
      clearMaxTime(worker.worker_conversation_id);
      return;
    }
    // Background commands are still running, so wait for claude to wake the session and report then.
    if (outcome.event === "report" && event.type === "turn.ended" && (liveOf(session.id).backgroundTasks ?? 0) > 0) {
      awaitingBackground.set(session.id, turnStart);
      updateLive(p, session.id, (l) => {
        l.activity = "background";
      });
      return;
    }
    const completedUpToId =
      event.type === "turn.ended" && event.messageIds.length > 0 ? Math.max(...event.messageIds) : outcome.turnMessageId;
    const hasPendingFollowup =
      event.type === "turn.ended" &&
      completedUpToId !== null &&
      db.get(
        `SELECT 1 AS x FROM messages
          WHERE conversation_id = ? AND id > ? AND sender IN ('pm', 'user')
            AND status IN ('queued', 'delivered', 'processing')
          LIMIT 1`,
        worker.worker_conversation_id,
        completedUpToId,
      ) !== undefined;
    if (!hasPendingFollowup) {
      clearMaxTime(worker.worker_conversation_id);
    }
    const turnMessageId = outcome.turnMessageId ?? lastAgentMessageId(session.id, turnStart);
    if (turnMessageId === null) return;
    if (outcome.event === "turn_failed") {
      insertTurnFailed(p, worker, turnMessageId, outcome.messageIds, outcome.reason);
      return;
    }
    const reportMessage = lastAgentTextMessage(session.id, turnStart);
    if (outcome.turnMessageId === null && (reportMessage?.text ?? "").trim() === "") return;
    if (onlyManualCompact(session, turnStart)) return;
    insertReport(p, worker, turnMessageId, reportMessage, null, { hasPendingFollowup });
  };

  /** Background commands died with the old process, so recovery reports the last turn instead of resuming the session. */
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
        insertReport(p, worker, turnMessageId, lastAgentTextMessage(wait.session_id, wait.turn_start), backgroundKilledNote("restart"));
      }
    });

  const getWorktreeTask = (workerId: WorkerId): WorktreeTask | null => {
    const worker = workerRow(workerId);
    if (worker === null || worker.workspace !== "worktree") return null;
    const review = parseReviewTarget(worker.review_json);
    const base = review === null ? options.taskGraphs?.workerGraphForkBase(workerId) : undefined;
    return {
      workerId,
      sessionId: workerSession(workerId).id,
      repo: mainFolderOf(worker.project_id),
      worktreePath: worker.worktree_path!,
      checkout:
        review !== null
          ? { kind: "review", branch: review.branch }
          : { kind: "branch", branch: worker.branch!, ...(base !== undefined ? { base } : {}) },
      status: worker.status as WorktreeTask["status"],
      setupCommand: projectRow(worker.project_id).setup_command,
    };
  };

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

  /** Wait until every other Worker and session on this worktree has fully exited so two Workers never write the same directory. */
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

  /** Hold messages so a Worker session never starts with anything other than its task brief. */
  const waitsForFirstTurn = (sessionId: SessionId, messageId: MessageId): boolean => {
    const workerId = db.get<{ worker_id: number | null }>("SELECT worker_id FROM agent_sessions WHERE id = ?", sessionId)?.worker_id ?? null;
    const worker = workerId === null ? null : workerRow(workerId);
    if (worker === null || worker.status === "ended") return false;
    if (notStarted(worker)) return true;
    if (worktreeBusyByOthers(worker)) return true;
    const task = db.get<{ id: number; status: string }>("SELECT id, status FROM messages WHERE dedupe_key = ?", taskDedupeKey(worker.id));
    return task !== undefined && task.status === "queued" && task.id !== messageId;
  };

  /** base_commit and the first-turn actions are written in one transaction, so a set base_commit means this already ran. */
  const onWorktreeCreated = (workerId: WorkerId, baseCommit: string, setup?: SetupOutcome) => {
    write((p) => {
      const worker = workerRow(workerId);
      if (worker === null || worker.workspace !== "worktree" || worker.base_commit !== null) return;
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

  const recoverWorktrees = (): WorkerId[] =>
    write((p) => {
      const ids = db
        .all<{ id: number }>("SELECT id FROM workers WHERE status = 'open' AND workspace = 'worktree' AND base_commit IS NULL ORDER BY id")
        .map((r) => r.id);
      for (const id of ids) enqueue(p, { type: "worktree.create", params: { workerId: id } });
      return ids;
    });

  const recordReviewSnapshot = (workerId: WorkerId, snapshot: ReviewSnapshot): void =>
    write(() => {
      const worker = workerRow(workerId);
      const review = worker === null ? null : parseReviewTarget(worker.review_json);
      if (review === null) return;
      db.run(
        "UPDATE workers SET review_json = ?, updated_at = ? WHERE id = ?",
        JSON.stringify({ branch: review.branch, snapshot } satisfies ReviewTarget),
        now(),
        workerId,
      );
    });

  const getReviewVerifyTask = (workerId: WorkerId): { repo: string; branch: string; snapshot: ReviewSnapshot } | null => {
    const worker = workerRow(workerId);
    const review = worker === null || worker.status === "ended" ? null : parseReviewTarget(worker.review_json);
    if (review === null || review.snapshot === null) return null;
    return { repo: mainFolderOf(worker!.project_id), branch: review.branch, snapshot: review.snapshot };
  };

  const reviewVerifiedIn = (p: Pending, params: ReviewVerifyParams, result: ReviewVerifyResult): void => {
    const worker = workerRow(params.workerId);
    if (worker === null || worker.status === "ended") return;
    const newerInput = db.get(
      "SELECT 1 AS x FROM messages WHERE conversation_id = ? AND sender IN ('pm', 'user') AND id > ? LIMIT 1",
      worker.worker_conversation_id,
      params.reportMessageId,
    );
    if (newerInput !== undefined) return;
    const reportMessage = toReportMessage(db.get<ReportMessageRow>("SELECT id, text, meta FROM messages WHERE id = ?", params.reportMessageId));
    insertReport(p, worker, params.turnMessageId, reportMessage, null, { reviewVerified: result });
  };

  const onReviewVerified = (params: ReviewVerifyParams, result: ReviewVerifyResult): void =>
    write((p) => reviewVerifiedIn(p, params, result));

  const actionFailedIn = (p: Pending, action: AnyActionRow, error: string) => {
    if (action.type === "review.verify") {
      reviewVerifiedIn(p, action.params, { problems: [reviewVerifyErrorProblem(error)] });
      return;
    }
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

  const isWorktreeCleaned = (worker: WorkerDbRow): boolean => {
    if (
      worker.workspace !== "worktree" ||
      worker.status !== "ended" ||
      worker.base_commit === null ||
      worker.worktree_path === null
    ) {
      return false;
    }
    if (existsSync(worker.worktree_path)) return false;
    const allRoots = [worktreesDir, ...(options.extraWorktreeRoots?.() ?? [])];
    const owningRoot = allRoots.find((r) => isPathStrictlyInside(r, worker.worktree_path!));
    return existsSync(owningRoot ?? worktreesDir);
  };

  const workerPrTarget = (session: AgentSessionRow | null, workerId: WorkerId): { cwd: string; branch: string } | null => {
    if (session === null || session.role !== "pm" || session.pmId === null) return null;
    const worker = workerRow(workerId);
    if (worker === null || worker.pm_id !== session.pmId || worker.workspace !== "worktree") return null;
    if (worker.worktree_path === null || worker.branch === null || worker.base_commit === null) return null;
    const cwd = isWorktreeCleaned(worker) ? mainFolderOf(worker.project_id) : worker.worktree_path;
    return cwd === "" ? null : { cwd, branch: worker.branch };
  };

  const listEndedWorktreeWorkers = (): EndedWorktreeCandidate[] =>
    db
      .all<{
        id: number;
        project_id: number;
        branch: string | null;
        review_json: string | null;
        worktree_path: string;
        base_commit: string | null;
        ended_at: number;
        repo_folder: string;
      }>(
        `SELECT w.id, w.project_id, w.branch, w.review_json, w.worktree_path, w.base_commit,
                (SELECT max(o.updated_at) FROM workers o WHERE o.worktree_path = w.worktree_path) AS ended_at,
                f.path AS repo_folder
         FROM workers w
         JOIN project_folders f ON f.project_id = w.project_id AND f.is_main = 1 AND f.removed_at IS NULL
         WHERE w.status = 'ended' AND w.workspace = 'worktree'
           AND w.worktree_path IS NOT NULL AND w.worktree_path != '' 
           AND w.id = (SELECT min(o.id) FROM workers o WHERE o.worktree_path = w.worktree_path AND o.status = 'ended')
         ORDER BY w.id`,
      )
      .map((r): EndedWorktreeCandidate => ({
        workerId: r.id,
        projectId: r.project_id,
        repoFolder: r.repo_folder,
        ...(r.review_json !== null || r.branch === null ? { review: true, branch: null } : { review: false, branch: r.branch }),
        worktreePath: r.worktree_path,
        baseCommit: r.base_commit,
        endedAt: r.ended_at,
      }));

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
    // Review directories are single-use, so they do not wait for the task graph to finish.
    return worker.review_json !== null || !inActiveGraph(sharing.map((w) => w.id));
  };

  const inActiveGraph = (workerIds: readonly WorkerId[]): boolean =>
    workerIds.length > 0 &&
    db.get(
      `SELECT 1 AS x FROM task_graphs g JOIN task_graph_steps n ON n.graph_id = g.id, json_each(n.worker_ids_json) j
        WHERE g.status = 'active' AND j.value IN (${workerIds.map(() => "?").join(", ")})
        LIMIT 1`,
      ...workerIds,
    ) !== undefined;

  const workerTranscriptTarget = (session: AgentSessionRow | null, workerId: WorkerId): { vendor: string; vendorSessionId: string; cwd: string } | null => {
    if (session === null || session.role !== "pm" || session.pmId === null) return null;
    const worker = workerRow(workerId);
    if (worker === null || worker.pm_id !== session.pmId) return null;
    const target = workerSession(workerId);
    return { vendor: target.vendor, vendorSessionId: target.vendorSessionId, cwd: target.cwd };
  };

  const workerStartFolder = (session: AgentSessionRow | null): string | null => {
    if (session === null || session.role !== "pm" || session.pmId === null) return null;
    const project = activeProjectOf(session.pmId);
    return project === null ? null : projectCard(project).mainFolder;
  };

  const withTakeoverOf = (worker: WorkerDbRow): WorkerRecord => {
    const record = toWorkerRecord(worker);
    if (worker.workspace !== "worktree" || worker.worktree_path === null || worker.worktree_path === "") return record;
    const owner = db.get<{ id: number }>("SELECT min(id) AS id FROM workers WHERE worktree_path = ?", worker.worktree_path)?.id ?? worker.id;
    return owner === worker.id ? record : { ...record, takeoverOf: owner };
  };

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
    deliverToWorkerIn,
    resumeUserBlockedWorkerIn,
    endOpenWorkersIn,
    list,
    status,
    afterDriverEvent,
    getWorktreeTask,
    onSetupStarted,
    waitsForFirstTurn,
    onWorktreeCreated,
    recordReviewSnapshot,
    getReviewVerifyTask,
    onReviewVerified,
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
