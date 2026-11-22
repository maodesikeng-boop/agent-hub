import type { WorkerId } from "../../../shared/domain.ts";
import type { ReviewStampOutcome } from "../../../shared/review.ts";
import type { Pending } from "../context.ts";
import type { TaskGraphCtx } from "./types.ts";

/**
 * Writes `outcome` to `reviewStamp` on the artifact of the step whose latest Worker is `workerId`, then pushes the slim graph.
 * Postcondition: step status, waiting state, and active Worker stay unchanged; no-op when no step's latest Worker is `workerId`.
 */
export function recordReviewStampIn(g: TaskGraphCtx, p: Pending, workerId: WorkerId, outcome: ReviewStampOutcome): void {
  throw new Error("Not implemented");
}
