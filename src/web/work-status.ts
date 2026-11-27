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

type DeliveryGraph = Pick<TaskGraph, "status" | "nodes">;
type DeliveryWatch = { watchId: number; body: string };
const deliveryByGraph = new WeakMap<DeliveryGraph, { watch: DeliveryWatch | null; delivery: GraphDelivery }>();

export function graphDeliveryOf(graph: DeliveryGraph, watch: DeliveryWatch | null = null): GraphDelivery {
  const cached = deliveryByGraph.get(graph);
  if (cached !== undefined && cached.watch?.watchId === watch?.watchId && cached.watch?.body === watch?.body) return cached.delivery;
  const { done, total } = graphProgressOf(graph);
  const ready = graph.status === "active" && total > 0 && done === total;
  const header = `${done}/${total} steps${ready ? " · awaiting delivery" : ""}`;
  const delivery: GraphDelivery = {
    header,
    row: ready ? {
      wait: watch === null ? { kind: "pm" } : { kind: "watch", watchId: watch.watchId, body: watch.body },
      since: graph.nodes.reduce((latest, node) => Math.max(latest, node.updatedAt), 0),
    } : null,
  };
  deliveryByGraph.set(graph, { watch, delivery });
  return delivery;
}

export interface SlotQueueRow {
  key: TaskNode["key"];
  title: string;
  /** For example `Queued for real-env · behind #86 review-real`. */
  text: string;
}

type SlotQueueGraph = Pick<TaskGraph, "status" | "nodes">;
const NO_SLOT_QUEUE: readonly SlotQueueRow[] = [];
const slotQueueByGraph = new WeakMap<SlotQueueGraph, readonly SlotQueueRow[]>();

export function slotQueueTextOf(node: Pick<TaskNode, "slot" | "slotQueue">): string | null {
  if (node.slotQueue === undefined || node.slot == null) return null;
  const { position, holder } = node.slotQueue;
  const more = position > 1 ? ` and ${position - 1} more` : "";
  return `Queued for ${node.slot} · behind #${holder.graphId} ${holder.nodeKey}${more}`;
}

/** Steps of an active graph that wait for a slot held elsewhere, in step order. */
export function graphSlotQueueOf(graph: SlotQueueGraph): readonly SlotQueueRow[] {
  const cached = slotQueueByGraph.get(graph);
  if (cached !== undefined) return cached;
  const rows: SlotQueueRow[] = [];
  if (graph.status === "active") {
    for (const node of graph.nodes) {
      const text = node.status === "pending" ? slotQueueTextOf(node) : null;
      if (text !== null) rows.push({ key: node.key, title: node.title, text });
    }
  }
  const result = rows.length === 0 ? NO_SLOT_QUEUE : rows;
  slotQueueByGraph.set(graph, result);
  return result;
}
