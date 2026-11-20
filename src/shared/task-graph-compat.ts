import {
  TASK_NODE_STATUSES,
  taskNodeStateFromLegacy,
  type TaskGraph,
  type TaskNode,
  type TaskNodeState,
} from "./domain.ts";

const NEW_STATUSES: ReadonlySet<string> = new Set(TASK_NODE_STATUSES);

function isCurrentNode(node: TaskNode): boolean {
  if ("kind" in node || !NEW_STATUSES.has(node.status) || typeof node.skipped !== "boolean") return false;
  if (node.status === "waiting") return (node.waitingFor === "user" || node.waitingFor === "pm") && node.skipped === false;
  return node.waitingFor === null && (node.status === "done" || node.skipped === false);
}

function normalizeNode(node: TaskNode): TaskNode {
  if (isCurrentNode(node)) return node;
  const { kind: _kind, ...rest } = node as TaskNode & { kind?: unknown };
  let state: TaskNodeState;
  if (node.status === "waiting") {
    state = { status: "waiting", waitingFor: node.waitingFor === "user" ? "user" : "pm", skipped: false };
  } else if (NEW_STATUSES.has(node.status)) {
    state = { status: node.status, waitingFor: null, skipped: node.status === "done" && node.skipped === true };
  } else {
    state = taskNodeStateFromLegacy(node.status);
  }
  return { ...rest, ...state };
}

const graphCache = new WeakMap<TaskGraph, TaskGraph>();

export function normalizeTaskGraph(graph: TaskGraph): TaskGraph {
  if (graph.nodes.every(isCurrentNode)) return graph;
  const cached = graphCache.get(graph);
  if (cached !== undefined) return cached;
  const next: TaskGraph = { ...graph, nodes: graph.nodes.map(normalizeNode) };
  graphCache.set(graph, next);
  return next;
}

const listCache = new WeakMap<readonly TaskGraph[], TaskGraph[]>();

export function normalizeTaskGraphs<T extends readonly TaskGraph[]>(graphs: T): T {
  if (graphs.every((g) => g.nodes.every(isCurrentNode))) return graphs;
  const cached = listCache.get(graphs);
  if (cached !== undefined) return cached as unknown as T;
  const next = graphs.map(normalizeTaskGraph);
  listCache.set(graphs, next);
  return next as unknown as T;
}
