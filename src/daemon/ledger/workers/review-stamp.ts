// Invariant: a review stamp never changes a step's status, wakes the Project Manager, or fails the Task Graph.
import type { AnyActionRow, ReviewStampParams } from "../../../shared/actions.ts";
import type { ReviewStampTask } from "../../../shared/ledger.ts";
import type { ReviewStampOutcome, ReviewStampRequest } from "../../../shared/review.ts";
import type { Pending } from "../context.ts";
import type { WorkerDbRow } from "../rows.ts";
import type { WorkersCtx } from "./types.ts";

/**
 * Enqueues one `review.stamp` action for a review Worker whose report just became final.
 * Postcondition: at most one action per (worker, sha), deduplicated by `actionDedupeKey`; no-op when `request` is null.
 */
export function enqueueReviewStampIn(w: WorkersCtx, p: Pending, worker: WorkerDbRow, request: ReviewStampRequest | null): void {
  throw new Error("Not implemented");
}

/**
 * Returns the main folder, the PR recorded in the review snapshot, and the project's stamp account.
 * Works after the Worker has ended, because a completed step ends its Worker before the action runs.
 * Returns null when the Worker is gone, is not a review Worker, or its snapshot no longer names `params.sha`.
 */
export function getReviewStampTask(w: WorkersCtx, params: ReviewStampParams): ReviewStampTask | null {
  throw new Error("Not implemented");
}

/**
 * Records the outcome on the review step's artifact so the graph view, `hub graph show`, and the delivery note show it.
 * Postcondition: no write when the Worker is no longer the step's latest Worker, so a takeover's newer review is never overwritten.
 */
export function onReviewStamped(w: WorkersCtx, params: ReviewStampParams, outcome: ReviewStampOutcome): void {
  throw new Error("Not implemented");
}

/** Records a `skipped` outcome with the executor's final error after the last retry; never rethrows. */
export function reviewStampFailedIn(w: WorkersCtx, p: Pending, action: Extract<AnyActionRow, { type: "review.stamp" }>, error: string): void {
  throw new Error("Not implemented");
}
