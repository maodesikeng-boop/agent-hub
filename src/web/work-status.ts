import type { CompletedWorkItem, TaskGraph, TaskNode } from "../shared/index.ts";
import type { WorkerEntry } from "./selectors.ts";

// Invariant: every status icon in the work panel comes from one of these five values; nothing else picks icon colors.

export type WorkStatus = "done" | "running" | "waiting" | "pending" | "cancelled";

export interface GraphProgress {
  done: number;
  total: number;
}

export function nodeWorkStatusOf(node: Pick<TaskNode, "status" | "waitingFor">): WorkStatus {
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
