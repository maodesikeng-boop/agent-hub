import type { AnyActionRow, ReviewVerifyParams } from "../../../shared/actions.ts";
import type { MessageId, SessionId, WorkerId } from "../../../shared/domain.ts";
import type { SetupOutcome, WorktreeTask } from "../../../shared/ledger.ts";
import { DEFAULT_WORKER_MAX_TIME_MS } from "../../../shared/limits.ts";
import { parseReviewTarget, reviewTakeoverWorkspaceNote, reviewVerifyErrorProblem, reviewWorkspaceLines, type ReviewSnapshot, type ReviewTarget, type ReviewVerifyResult } from "../../../shared/review.ts";
import { setupNote } from "../../prompt.ts";
import type { Pending } from "../context.ts";
import { recordWorkerEnded } from "../completed-work.ts";
import { toMessage } from "../rows.ts";
import type { MessageDbRow, WorkerDbRow } from "../rows.ts";
import { idle } from "../sessions.ts";
import { refreshHandoffBranch } from "../task-graph-handoff.ts";
import { mainFolderOf, projectRow, workerRow, workerSession } from "./ctx.ts";
import { enqueueFirstTurn, insertLine } from "./lines.ts";
import { insertReport, insertTurnFailed } from "./reports.ts";
import { cancelQueuedWorkerPmNoticesIn } from "./stale-notices.ts";
import { notStarted, taskDedupeKey, toReportMessage } from "./text.ts";
import { clearMaxTime, startMaxTime, turnTimeoutOf } from "./timers.ts";
import type { ReportMessageRow, WorkersCtx } from "./types.ts";

function refreshPendingReviewBranch(w: WorkersCtx, workerId: WorkerId, path: string, previous: string, branch: string): void {
  w.write((p) => {
    w.db.run(
      "UPDATE workers SET review_json = json_set(review_json, '$.branch', ?), updated_at = ? WHERE id = ?",
      branch, w.now(), workerId,
    );
    const task = w.db.get<MessageDbRow>(
      "SELECT * FROM messages WHERE dedupe_key = ? AND status = 'queued'",
      taskDedupeKey(workerId),
    );
    if (task === undefined) return;
    const workspace = task.text
      .replace(reviewWorkspaceLines(path, previous).join("\n"), () => reviewWorkspaceLines(path, branch).join("\n"))
      .replace(reviewTakeoverWorkspaceNote(path, previous), () => reviewTakeoverWorkspaceNote(path, branch));
    const text = refreshHandoffBranch(workspace, previous, branch);
    if (text === task.text) return;
    const updated = w.db.get<MessageDbRow>(
      "UPDATE messages SET text = ?, updated_at = ? WHERE id = ? RETURNING *",
      text, w.now(), task.id,
    )!;
    p.changes.push({ type: "message.updated", data: { message: toMessage(updated) } });
  });
}

export function getWorktreeTask(w: WorkersCtx, workerId: WorkerId): WorktreeTask | null {
  const worker = workerRow(w, workerId);
  if (worker === null || worker.workspace !== "worktree") return null;
  const review = parseReviewTarget(worker.review_json);
  const plan = worker.status !== "ended" && (review === null || review.snapshot === null)
    ? w.options.taskGraphs?.workerGraphWorkspacePlan(workerId)
    : undefined;
  const worktreePath = worker.worktree_path!;
  let reviewBranch = review?.branch;
  if (review?.snapshot === null && plan?.kind === "review" && review.branch !== plan.branch) {
    refreshPendingReviewBranch(w, workerId, worktreePath, review.branch, plan.branch);
    reviewBranch = plan.branch;
  }
  return {
    workerId,
    sessionId: workerSession(w, workerId).id,
    repo: mainFolderOf(w, worker.project_id),
    worktreePath,
    checkout: reviewBranch !== undefined
      ? { kind: "review", branch: reviewBranch }
      : { kind: "branch", branch: worker.branch!, ...(plan?.kind === "fork" ? { base: plan.baseBranch } : {}) },
    status: worker.status as WorktreeTask["status"],
    setupCommand: projectRow(w, worker.project_id).setup_command,
  };
}

export const onSetupStarted = (w: WorkersCtx, workerId: WorkerId): boolean =>
  w.write((p) => {
    const worker = workerRow(w, workerId);
    if (worker === null || worker.workspace !== "worktree" || worker.status === "ended" || worker.base_commit !== null) return false;
    w.sessions.updateLive(p, workerSession(w, workerId).id, (l) => {
      l.activity = "preparing";
      l.currentTool = null;
      l.step = null;
    });
    return true;
  });

/** Wait until every other Worker and session on this worktree has fully exited so two Workers never write the same directory. */
const worktreeBusyByOthers = (w: WorkersCtx, worker: WorkerDbRow): boolean =>
  worker.workspace === "worktree" &&
  worker.worktree_path !== null &&
  worker.worktree_path !== "" &&
  w.db.get(
    `SELECT 1 AS x FROM workers o JOIN agent_sessions s ON s.worker_id = o.id
      WHERE o.worktree_path = ? AND o.id != ?
        AND (o.status != 'ended' OR s.status != 'ended' OR s.pid IS NOT NULL)
      LIMIT 1`,
    worker.worktree_path,
    worker.id,
  ) !== undefined;

/** Hold messages so a Worker session never starts with anything other than its task brief. */
export function waitsForFirstTurn(w: WorkersCtx, sessionId: SessionId, messageId: MessageId): boolean {
  const workerId = w.db.get<{ worker_id: number | null }>("SELECT worker_id FROM agent_sessions WHERE id = ?", sessionId)?.worker_id ?? null;
  const worker = workerId === null ? null : workerRow(w, workerId);
  if (worker === null || worker.status === "ended") return false;
  if (notStarted(worker)) return true;
  if (worktreeBusyByOthers(w, worker)) return true;
  const task = w.db.get<{ id: number; status: string }>("SELECT id, status FROM messages WHERE dedupe_key = ?", taskDedupeKey(worker.id));
  return task !== undefined && task.status === "queued" && task.id !== messageId;
}

/** base_commit and the first-turn actions are written in one transaction, so a set base_commit means this already ran. */
export function onWorktreeCreated(w: WorkersCtx, workerId: WorkerId, baseCommit: string, setup?: SetupOutcome): void {
  w.write((p) => {
    const worker = workerRow(w, workerId);
    if (worker === null || worker.workspace !== "worktree" || worker.base_commit !== null) return;
    const sessionId = workerSession(w, workerId).id;
    const activity = w.sessions.liveOf(sessionId).activity;
    if (activity === "preparing" || activity === "stopping") w.sessions.updateLive(p, sessionId, idle);
    if (worker.status === "ended") return;
    w.db.run("UPDATE workers SET base_commit = ?, updated_at = ? WHERE id = ?", baseCommit, w.now(), workerId);
    if (setup !== undefined) {
      const task = w.db.get<MessageDbRow>("SELECT * FROM messages WHERE dedupe_key = ?", taskDedupeKey(workerId))!;
      const row = w.db.get<MessageDbRow>("UPDATE messages SET text = ?, updated_at = ? WHERE id = ? RETURNING *", `${setupNote(setup)}\n\n${task.text}`, w.now(), task.id)!;
      p.changes.push({ type: "message.updated", data: { message: toMessage(row) } });
    }
    enqueueFirstTurn(w, p, worker);
    const maxTimeMs = turnTimeoutOf(w, worker.id)?.max_time_ms ?? DEFAULT_WORKER_MAX_TIME_MS;
    startMaxTime(w, worker, maxTimeMs);
  });
}

export const recoverWorktrees = (w: WorkersCtx): WorkerId[] =>
  w.write((p) => {
    const ids = w.db
      .all<{ id: number }>("SELECT id FROM workers WHERE status = 'open' AND workspace = 'worktree' AND base_commit IS NULL ORDER BY id")
      .map((r) => r.id);
    for (const id of ids) w.enqueue(p, { type: "worktree.create", params: { workerId: id } });
    return ids;
  });

export const recordReviewSnapshot = (w: WorkersCtx, workerId: WorkerId, snapshot: ReviewSnapshot): void =>
  w.write(() => {
    const worker = workerRow(w, workerId);
    const review = worker === null ? null : parseReviewTarget(worker.review_json);
    if (review === null) return;
    w.db.run(
      "UPDATE workers SET review_json = ?, updated_at = ? WHERE id = ?",
      JSON.stringify({ branch: review.branch, snapshot } satisfies ReviewTarget),
      w.now(),
      workerId,
    );
  });

export function getReviewVerifyTask(w: WorkersCtx, workerId: WorkerId): { repo: string; branch: string; snapshot: ReviewSnapshot } | null {
  const worker = workerRow(w, workerId);
  const review = worker === null || worker.status === "ended" ? null : parseReviewTarget(worker.review_json);
  if (review === null || review.snapshot === null) return null;
  return { repo: mainFolderOf(w, worker!.project_id), branch: review.branch, snapshot: review.snapshot };
}

function reviewVerifiedIn(w: WorkersCtx, p: Pending, params: ReviewVerifyParams, result: ReviewVerifyResult): void {
  const worker = workerRow(w, params.workerId);
  if (worker === null || worker.status === "ended") return;
  const supersedingReportOrInput = w.db.get(
    `SELECT 1 FROM messages WHERE worker_id = ? AND id > ?
      AND (sender = 'pm' OR (kind = 'worker' AND json_extract(meta, '$.event') = 'report'))
     UNION ALL
     SELECT 1 FROM actions WHERE type = 'review.verify' AND json_extract(params, '$.workerId') = ?
      AND json_extract(params, '$.reportMessageId') > ?
     LIMIT 1`,
    worker.id,
    params.reportMessageId,
    worker.id,
    params.reportMessageId,
  );
  if (supersedingReportOrInput !== undefined) return;
  const reportMessage = toReportMessage(w.db.get<ReportMessageRow>("SELECT id, text, meta FROM messages WHERE id = ?", params.reportMessageId));
  insertReport(w, p, worker, params.turnMessageId, reportMessage, null, { reviewVerified: result });
}

export const onReviewVerified = (w: WorkersCtx, params: ReviewVerifyParams, result: ReviewVerifyResult): void =>
  w.write((p) => reviewVerifiedIn(w, p, params, result));

function worktreeCreateFailedIn(w: WorkersCtx, p: Pending, workerId: WorkerId, error: string): void {
  const worker = workerRow(w, workerId);
  if (worker === null || worker.status === "ended") return;
  clearMaxTime(w, worker.worker_conversation_id);
  const t = w.now();
  w.db.run("UPDATE workers SET status = 'ended', updated_at = ? WHERE id = ?", t, worker.id);
  recordWorkerEnded(w.db, { id: worker.id, pmId: worker.pm_id }, t);
  const session = workerSession(w, worker.id);
  w.enqueue(p, { type: "session.end", params: { sessionId: session.id, generation: session.generation } });
  cancelQueuedWorkerPmNoticesIn(w, p, worker);
  const deliver = `建 worktree 失败，这个 Worker 没能开工，已经收工：${error}。要的话修好问题后重新派一个。`;
  const graphDeliver =
    w.options.taskGraphs?.onWorkerFailedIn(p, worker.id, {
      clearActiveWorker: true,
      reasonLabel: `建 worktree 失败（${error}）`,
      detailBody: deliver,
    }) ?? null;
  insertLine(w, p, workerRow(w, worker.id)!, {
    event: "worktree_failed",
    status: null,
    summary: error,
    turnMessageId: null,
    deliver: graphDeliver ?? deliver,
  });
  const task = w.db.get<{ id: number }>("SELECT id FROM messages WHERE dedupe_key = ?", taskDedupeKey(worker.id));
  if (task !== undefined) w.messages.transition(p, task.id, "failed", error);
}

export function actionFailedIn(w: WorkersCtx, p: Pending, action: AnyActionRow, error: string): void {
  if (action.type === "review.verify") {
    reviewVerifiedIn(w, p, action.params, { problems: [reviewVerifyErrorProblem(error)] });
    return;
  }
  if (action.type === "worktree.create") {
    worktreeCreateFailedIn(w, p, action.params.workerId, error);
    return;
  }
  if (action.type !== "session.send") return;
  const message = w.db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", action.params.messageId);
  if (message === undefined || message.session_id !== action.params.sessionId || message.sender !== "pm" || message.worker_id === null) return;
  const worker = workerRow(w, message.worker_id);
  if (worker === null) return;
  clearMaxTime(w, worker.worker_conversation_id);
  if (worker.status === "ended") return;
  insertTurnFailed(w, p, worker, message.id, [message.id], error);
}
