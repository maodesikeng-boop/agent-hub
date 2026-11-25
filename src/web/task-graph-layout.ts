import type { TaskGraph, TaskNode } from "../shared/index.ts";

export type GraphShape = Pick<TaskGraph, "nodes" | "edges">;

const compareNodeOrder = (a: TaskNode, b: TaskNode) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key);

export function computeGraphLayers(graph: GraphShape): TaskNode[][] {
  if (graph.nodes.length === 0) return [];
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const rank = new Map<string, number>();

  for (const node of graph.nodes) {
    inDegree.set(node.key, 0);
    adj.set(node.key, []);
    rank.set(node.key, 0);
  }
  for (const edge of graph.edges) {
    if (edge.fromKey === edge.toKey || !inDegree.has(edge.fromKey) || !inDegree.has(edge.toKey)) continue;
    adj.get(edge.fromKey)!.push(edge.toKey);
    inDegree.set(edge.toKey, (inDegree.get(edge.toKey) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const node of graph.nodes) {
    if ((inDegree.get(node.key) ?? 0) === 0) queue.push(node.key);
  }
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++]!;
    const uRank = rank.get(u) ?? 0;
    for (const v of adj.get(u) ?? []) {
      const nextRank = uRank + 1;
      if (nextRank > (rank.get(v) ?? 0)) rank.set(v, nextRank);
      const deg = (inDegree.get(v) ?? 1) - 1;
      inDegree.set(v, deg);
      if (deg === 0) queue.push(v);
    }
  }

  const byRank = new Map<number, TaskNode[]>();
  for (const node of graph.nodes) {
    const r = rank.get(node.key) ?? 0;
    const list = byRank.get(r);
    if (list) list.push(node);
    else byRank.set(r, [node]);
  }

  return [...byRank.entries()]
    .toSorted(([a], [b]) => a - b)
    .map(([, list]) => list.toSorted(compareNodeOrder));
}
