// Invariant: a review stamp never changes a step's status, wakes the Project Manager, or fails the Task Graph.
import { actionDedupeKey, type AnyActionRow, type NewAction, type ReviewStampParams } from "../../../shared/actions.ts";
import { truncateChars, type MessageId } from "../../../shared/domain.ts";
import type { ReviewStampTask } from "../../../shared/ledger.ts";
import { MAX_REVIEW_STAMP_REASON_CHARS } from "../../../shared/limits.ts";
import { parseReviewTarget, type ReviewStampOutcome, type ReviewStampRequest } from "../../../shared/review.ts";
import type { Pending } from "../context.ts";
import { reviewStatusAccountOf } from "../projects.ts";
import type { WorkerDbRow } from "../rows.ts";
import { mainFolderOf, workerRow } from "./ctx.ts";
import type { WorkersCtx } from "./types.ts";

/**
 * Enqueues one `review.stamp` action for a review Worker whose report just became final.
 * Postcondition: at most one action per (worker, report message), even after the first one finished; no-op when `request` is null.
 */
export function enqueueReviewStampIn(w: WorkersCtx, p: Pending, worker: WorkerDbRow, reportMessageId: MessageId, request: ReviewStampRequest | null): void {
  if (request === null) return;
  const action: NewAction = { type: "review.stamp", params: { workerId: worker.id, reportMessageId, sha: request.sha, verdict: request.verdict } };
  // The executor re-runs a finished action enqueued under the same key, so a replayed report must not reach enqueue at all.
  if (w.db.get("SELECT 1 AS x FROM actions WHERE type = 'review.stamp' AND dedupe_key = ?", actionDedupeKey(action)) !== undefined) return;
  w.enqueue(p, action);
}

/**
 * A stamp is current while its Worker is still its step's latest Worker and its report is that Worker's latest reply.
 * A takeover, a follow-up turn, or a new verdict makes older stamps stale, so a late retry never overwrites the newer verdict.
 */
function isCurrentStamp(w: WorkersCtx, worker: WorkerDbRow, params: ReviewStampParams): boolean {
  if (w.options.taskGraphs?.isLatestStepWorker(worker.id) !== true) return false;
  return (
    w.db.get(
      "SELECT 1 AS x FROM messages WHERE conversation_id = ? AND sender = 'agent' AND kind = 'text' AND id > ? LIMIT 1",
      worker.worker_conversation_id,
      params.reportMessageId,
    ) === undefined
  );
}

function currentStampWorker(w: WorkersCtx, params: ReviewStampParams): WorkerDbRow | null {
  const worker = workerRow(w, params.workerId);
  return worker !== null && isCurrentStamp(w, worker, params) ? worker : null;
}

/**
 * Returns the main folder, the PR recorded in the review snapshot, and the project's stamp account.
 * Works after the Worker has ended, because a completed step ends its Worker before the action runs.
 * Returns null when the Worker is gone, is not a review Worker, its snapshot no longer names `params.sha`, or the stamp is stale.
 */
export function getReviewStampTask(w: WorkersCtx, params: ReviewStampParams): ReviewStampTask | null {
  const worker = currentStampWorker(w, params);
  const review = worker === null ? null : parseReviewTarget(worker.review_json);
  if (review === null || review.snapshot === null || review.snapshot.sha !== params.sha) return null;
  return { repo: mainFolderOf(w, worker!.project_id), pr: review.snapshot.pr, account: reviewStatusAccountOf(w.db, worker!.project_id) };
}

/**
 * Records the outcome on the review step's artifact so the graph view, `hub graph show`, and the delivery note show it.
 * Postcondition: no write when the stamp went stale while it ran, so a takeover's or a later turn's verdict is never overwritten.
 */
export function onReviewStamped(w: WorkersCtx, params: ReviewStampParams, outcome: ReviewStampOutcome): void {
  w.write((p) => {
    if (currentStampWorker(w, params) !== null) w.options.taskGraphs?.recordReviewStampIn(p, params.workerId, outcome);
  });
}

/** Records a `skipped` outcome with the executor's final error after the last retry, unless the stamp is stale; never rethrows. */
export function reviewStampFailedIn(w: WorkersCtx, p: Pending, action: Extract<AnyActionRow, { type: "review.stamp" }>, error: string): void {
  if (currentStampWorker(w, action.params) === null) return;
  const reason = truncateChars(`重试用完也没挂上：${error}`, MAX_REVIEW_STAMP_REASON_CHARS);
  w.options.taskGraphs?.recordReviewStampIn(p, action.params.workerId, { kind: "skipped", sha: action.params.sha, reason, at: w.now() });
}
