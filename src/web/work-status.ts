import type { CompletedWorkItem, TaskGraph, TaskNode } from "../shared/index.ts";
import type { WorkerEntry } from "./selectors.ts";

// Invariant: every status icon in the work panel comes from one of these five values; nothing else picks icon colors.

export type WorkStatus = "done" | "running" | "waiting" | "pending" | "cancelled";

export interface GraphProgress {
  done: number;
  total: number;
}

/**
 * Postcondition: done (skipped included) gives "done", running gives "running", waiting on the user gives "waiting",
 * waiting on the PM gives "running" because the PM is still working on it, and pending gives "pending".
 */
export function nodeWorkStatusOf(_node: Pick<TaskNode, "status" | "waitingFor">): WorkStatus {
  throw new Error("Not implemented");
}

/**
 * Postcondition: an ended Worker gives "done"; a live Worker that is idle after a report with status problem gives
 * "waiting"; any other live Worker gives "running".
 */
export function workerWorkStatusOf(_worker: Pick<WorkerEntry, "ended" | "tone" | "activity">): WorkStatus {
  throw new Error("Not implemented");
}

/** Postcondition: a cancelled outcome gives "cancelled" and a done outcome gives "done". */
export function completedWorkStatusOf(_item: Pick<CompletedWorkItem, "outcome">): WorkStatus {
  throw new Error("Not implemented");
}

/** Postcondition: total is the node count and done counts done nodes, skipped ones included; 0/0 for an empty graph. */
export function graphProgressOf(_graph: Pick<TaskGraph, "nodes">): GraphProgress {
  throw new Error("Not implemented");
}
