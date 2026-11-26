import type { CompletedWorkItem, TaskGraph, TaskNode } from "../shared/index.ts";
import type { WorkerEntry } from "./selectors.ts";

// Invariant: every status icon in the work panel comes from one of these five values; nothing else picks icon colors.

export type WorkStatus = "done" | "running" | "waiting" | "pending" | "cancelled";

export const WORK_STATUS_LABEL: Readonly<Record<WorkStatus, string>> = {
  done: "done",
  running: "running",
  waiting: "waiting on you",
  pending: "not started",
  cancelled: "cancelled",
};

export interface GraphProgress {
  done: number;
  total: number;
}

export function nodeWorkStatusOf(
  node: Pick<TaskNode, "status" | "waitingFor"> & { gateAskPending?: boolean },
  graphStatus: TaskGraph["status"] = "active",
): WorkStatus {
  if (node.status === "cancelled" || graphStatus === "cancelled") return node.status === "done" ? "done" : "cancelled";
  if (node.gateAskPending === true) return "waiting";
  switch (node.status) {
    case "done":
      return "done";
    case "running":
      return "running";
    case "waiting":
      return node.waitingFor === "user" ? "waiting" : "running";
    case "pending":
      return "pending";
  }
}

export function workerWorkStatusOf(worker: Pick<WorkerEntry, "ended" | "tone" | "activity">): WorkStatus {
  if (worker.ended) return "done";
  if (worker.activity === "idle" && worker.tone === "warn") return "waiting";
  return "running";
}

export function completedWorkStatusOf(item: Pick<CompletedWorkItem, "outcome">): WorkStatus {
  return item.outcome === "cancelled" ? "cancelled" : "done";
}

export function graphProgressOf(graph: Pick<TaskGraph, "nodes">): GraphProgress {
  let done = 0;
  for (const node of graph.nodes) {
    if (node.status === "done") done += 1;
  }
  return { done, total: graph.nodes.length };
}

export type GraphDeliveryWait = { kind: "pm" } | { kind: "watch"; watchId: number; body: string };

export interface GraphDelivery {
  /** Step-count header for the panel and dialog, for example `2/2 steps · awaiting delivery`. */
  header: string;
  /** The last row under the steps while the graph waits for delivery; null otherwise. The leaf renders its age from `since`. */
  row: { wait: GraphDeliveryWait; since: number } | null;
}

/**
 * Postcondition: for an active graph whose every step is done, `header` is `<done>/<total> steps · awaiting delivery`
 * and `row` waits for the PM, or for `watch` when one is linked; `since` is the latest `updatedAt` among its steps.
 * Otherwise `header` is `<done>/<total> steps` and `row` is null.
 */
export function graphDeliveryOf(
  _graph: Pick<TaskGraph, "status" | "nodes">,
  _watch: { watchId: number; body: string } | null = null,
): GraphDelivery {
  throw new Error("Not implemented");
}
