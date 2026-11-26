import type { WorkerStartQueuedResult } from "../../../shared/hub.ts";
import { fail, type Pending } from "../context.ts";
import { recomputeGraphProgressIn, wakePmForTurnedIn } from "./progress.ts";
import { hasText } from "./rows.ts";
import { admitStep, freeSlotsWithWaiters, queueStep, slotHolderOf, slotWaitersOf } from "./slots.ts";
import { getGraphRow, getStepRow, pushSlimGraphIn, touchGraph } from "./store.ts";
import { slotHeldText } from "./text.ts";
import type { TaskGraphCtx, WorkerBindTarget } from "./types.ts";

/**
 * Precondition: called in the write that follows any committed change to a graph step or a Worker's background count.
 * Postcondition: starts the oldest waiting step of each free slot; leaves every held slot alone.
 */
export function drainSlotsIn(g: TaskGraphCtx, p: Pending): void {
  for (const slot of freeSlotsWithWaiters(g.db)) {
    const waiters = slotWaitersOf(g.db, slot);
    for (const waiter of waiters) {
      const graphRow = getGraphRow(g.db, waiter.graph_id);
      if (graphRow === undefined) continue;
      const t = g.now();
      const progress = recomputeGraphProgressIn(g, p, graphRow, undefined, undefined, { retractBlockedWaiting: false });
      wakePmForTurnedIn(g, p, graphRow, progress.turned, `名额「${slot}」空出来了，`, `slot-free:${slot}:${waiter.step_id}:${t}`);
      if (slotHolderOf(g.db, slot) !== null) break;
    }
    // Every waiter's position and holder changed, so each of their graphs republishes.
    for (const graphId of new Set(waiters.map((w) => w.graph_id))) pushSlimGraphIn(g, p, graphId);
  }
}

/**
 * Manual start goes through the same admission as automatic dispatch.
 * Postcondition: null when the step may start now; otherwise the step is pending in its slot's queue and the receipt
 * names the holder and position. A step whose Worker is still attached cannot be queued, so that start is refused.
 */
export function queueWorkerStartIn(g: TaskGraphCtx, p: Pending, target: WorkerBindTarget): WorkerStartQueuedResult | null {
  const admission = admitStep(g.db, target.graphId, target.nodeKey);
  if (admission.kind === "admitted") return null;
  const node = getStepRow(g.db, target.graphId, target.nodeKey)!;
  if (node.active_worker_id !== null) throw fail("conflict", slotHeldText(target.nodeKey, admission, "attached"));
  const t = g.now();
  if (node.status !== "pending") {
    g.db.run("UPDATE task_graph_steps SET status = 'pending', waiting_for = NULL, updated_at = ? WHERE id = ?", t, node.id);
  }
  queueStep(g.db, node.id, t);
  touchGraph(g.db, target.graphId, t);
  pushSlimGraphIn(g, p, target.graphId);
  const { slot, position, holder } = admission;
  return {
    text: slotHeldText(target.nodeKey, admission, hasText(node.brief) ? "start" : "pm"),
    data: { worker: null, slotQueue: { graphId: target.graphId, nodeKey: target.nodeKey, slot, position, holder } },
  };
}
