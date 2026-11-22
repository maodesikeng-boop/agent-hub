import type { WorkerId } from "../../../shared/domain.ts";
import type { ReviewStampOutcome } from "../../../shared/review.ts";
import type { Pending } from "../context.ts";
import { lastWorkerIdOf, readStoredArtifact, serializeArtifact } from "./rows.ts";
import { pushSlimGraphIn, touchGraph } from "./store.ts";
import type { TaskGraphCtx, TaskNodeDbRow } from "./types.ts";

function stepLedByWorker(g: TaskGraphCtx, workerId: WorkerId): TaskNodeDbRow | null {
  const node = g.db.get<TaskNodeDbRow>(
    `SELECT n.* FROM task_graph_steps n, json_each(n.worker_ids_json) j WHERE j.value = ? ORDER BY n.id DESC LIMIT 1`,
    workerId,
  );
  return node !== undefined && lastWorkerIdOf(node) === workerId ? node : null;
}

/** True while `workerId` is the latest Worker of its step; false after a takeover or when it belongs to no step. */
export function isLatestStepWorker(g: TaskGraphCtx, workerId: WorkerId): boolean {
  return stepLedByWorker(g, workerId) !== null;
}

/**
 * Writes `outcome` to `reviewStamp` on the artifact of the step whose latest Worker is `workerId`, then pushes the slim graph.
 * Postcondition: step status, waiting state, and active Worker stay unchanged; no-op when no step's latest Worker is `workerId`.
 */
export function recordReviewStampIn(g: TaskGraphCtx, p: Pending, workerId: WorkerId, outcome: ReviewStampOutcome): void {
  const node = stepLedByWorker(g, workerId);
  if (node === null) return;
  const stored = readStoredArtifact(node.artifact_json);
  const t = g.now();
  g.db.run(
    "UPDATE task_graph_steps SET artifact_json = ?, updated_at = ? WHERE id = ?",
    serializeArtifact({ ...stored.artifact, reviewStamp: outcome }, stored.checkpointPending),
    t,
    node.id,
  );
  touchGraph(g.db, node.graph_id, t);
  pushSlimGraphIn(g, p, node.graph_id);
}
