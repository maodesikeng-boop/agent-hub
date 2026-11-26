import type { HubArgs, WorkerStartQueuedResult } from "../../../shared/hub.ts";
import { fail, type Pending } from "../context.ts";
import { recomputeGraphProgressIn, wakePmForTurnedIn } from "./progress.ts";
import { readyOutcomeOf, workerIdsOf } from "./rows.ts";
import { admitStep, freeSlotsWithWaiters, queueStep, slotConflictOf, slotHolderOf, slotWaitersOf } from "./slots.ts";
import { getGraphRow, getStepRow, isUserBlocked, pushSlimGraphIn, touchGraph } from "./store.ts";
import { slotHeldText } from "./text.ts";
import type { TaskGraphCtx, TaskNodeDbRow, WorkerBindTarget } from "./types.ts";

type StartArgs = HubArgs<"worker.start">;

const START_OVERRIDES: ReadonlyArray<[keyof StartArgs, string]> = [
  ["title", "--title"],
  ["task", "补充的任务说明"],
  ["vendor", "--vendor"],
  ["model", "--model"],
  ["effort", "--effort"],
  ["maxTimeMs", "--max-time"],
  ["readonly", "--readonly"],
  ["caps", "--caps"],
  ["allow", "--allow"],
  ["noWorktree", "--no-worktree"],
  ["noOuterSandbox", "--no-outer-sandbox"],
];

/**
 * Precondition: called in the write that follows any committed change, since HOLDS_SLOT_SQL reads steps, Workers, turns, background counts, and messages.
 * Postcondition: starts the oldest waiting step of each free slot; leaves every held slot alone.
 */
export function drainSlotsIn(g: TaskGraphCtx, p: Pending): void {
  for (const slot of freeSlotsWithWaiters(g.db)) {
    for (const waiter of slotWaitersOf(g.db, slot)) {
      const graphRow = getGraphRow(g.db, waiter.graph_id);
      if (graphRow === undefined) continue;
      const t = g.now();
      const progress = recomputeGraphProgressIn(g, p, graphRow, undefined, undefined, { retractBlockedWaiting: false });
      wakePmForTurnedIn(g, p, graphRow, progress.turned, `名额「${slot}」空出来了，`, `slot-free:${slot}:${waiter.step_id}:${t}`);
      if (slotHolderOf(g.db, slot) !== null) break;
    }
  }
}

/** One line per slot with a queue: its holder and its waiters in order, so any change in either shows up as a new line. */
export function slotQueueLinesOf(g: TaskGraphCtx): Map<string, string> {
  const lines = new Map<string, string>();
  const slots = g.db.all<{ slot: string }>("SELECT DISTINCT slot FROM task_graph_step_slots WHERE queued_at IS NOT NULL ORDER BY slot");
  for (const { slot } of slots) {
    const waiters = slotWaitersOf(g.db, slot);
    if (waiters.length === 0) continue;
    const holder = slotHolderOf(g.db, slot);
    lines.set(slot, `${holder === null ? "-" : `${holder.graphId}:${holder.nodeKey}:${holder.workerId ?? "-"}`}|${waiters.map((w) => w.step_id).join(",")}`);
  }
  return lines;
}

/** Graphs still queued on any of `slots`; their position or holder text changes whenever the slot's line does. */
export function graphsQueuedOn(g: TaskGraphCtx, slots: readonly string[]): number[] {
  const graphIds = new Set<number>();
  for (const slot of slots) for (const waiter of slotWaitersOf(g.db, slot)) graphIds.add(waiter.graph_id);
  return [...graphIds];
}

/** Every path that hands a step back to its attached Worker refuses here while another step holds the slot. */
export function assertSlotFreeForWorkerIn(g: TaskGraphCtx, node: Pick<TaskNodeDbRow, "id" | "node_key">, workerId: number): void {
  const conflict = slotConflictOf(g.db, node.id);
  if (conflict !== null) throw fail("conflict", slotHeldText(node.node_key, conflict, { kind: "resume", workerId }));
}

function notQueueableReasons(g: TaskGraphCtx, node: TaskNodeDbRow, args: StartArgs): string[] {
  if (node.status === "done") return ["重开已完成的步骤"];
  if (node.status === "waiting" && isUserBlocked(g.db, node.id)) return ["换掉等用户处理的步骤"];
  const outcome = readyOutcomeOf(node);
  // Asking the PM again carries nothing given now, so nothing is lost by queueing.
  if (outcome === "pm") return [];
  if (outcome === "settle") return ["给已拍板的步骤派 Worker（出队时会按定案直接放行）"];
  const reasons = START_OVERRIDES.filter(([key]) => args[key] !== undefined).map(([, label]) => label);
  if (workerIdsOf(node).length > 0) reasons.unshift("接手前任 Worker 的目录和记录");
  return reasons;
}

/**
 * Manual start goes through the same admission as automatic dispatch.
 * Postcondition: null when the step may start now. Otherwise the step is pending in its slot's queue and will start exactly
 * as automatic dispatch would; a start whose Worker is attached, or whose settings automatic dispatch would drop, is refused.
 */
export function queueWorkerStartIn(g: TaskGraphCtx, p: Pending, target: WorkerBindTarget, args: StartArgs): WorkerStartQueuedResult | null {
  const admission = admitStep(g.db, target.graphId, target.nodeKey);
  if (admission.kind === "admitted") return null;
  const node = getStepRow(g.db, target.graphId, target.nodeKey)!;
  if (node.active_worker_id !== null) throw fail("conflict", slotHeldText(target.nodeKey, admission, { kind: "attached" }));
  const reasons = notQueueableReasons(g, node, args);
  if (reasons.length > 0) throw fail("conflict", slotHeldText(target.nodeKey, admission, { kind: "not_queued", reasons }));
  const t = g.now();
  if (node.status !== "pending") {
    g.db.run("UPDATE task_graph_steps SET status = 'pending', waiting_for = NULL, updated_at = ? WHERE id = ?", t, node.id);
  }
  queueStep(g.db, node.id, t);
  touchGraph(g.db, target.graphId, t);
  pushSlimGraphIn(g, p, target.graphId);
  const { slot, position, holder } = admission;
  return {
    text: slotHeldText(target.nodeKey, admission, { kind: readyOutcomeOf(node) === "start" ? "start" : "pm" }),
    data: { worker: null, slotQueue: { graphId: target.graphId, nodeKey: target.nodeKey, slot, position, holder } },
  };
}
