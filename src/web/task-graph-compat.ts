// 任务图读入处的新旧状态映射（docs/orchestration-simplify-design.md 第 3.4 节最后一条）：
// 多台设备版本不一致的那段时间，网页可能从老守护进程收到旧的 7 个状态、带 kind 的节点。读入快照、变化推送、历史分页时过一遍，
// 换成新的 4 个状态（映射表和迁移 0025 是同一张，在 shared/domain.ts 的 taskNodeStateFromLegacy）。
// 引用稳定（AGENTS.md 缓存四要素第 3 条）：已是新形状的图原样返回同一个对象；旧形状按输入的图对象用 WeakMap 缓存转换结果，
// 同一份输入反复读返回同一个引用，下游 memo 的组件不重画。WeakMap 随输入对象回收，没有上限问题。
import { TASK_NODE_STATUSES, taskNodeStateFromLegacy, type TaskGraph, type TaskNode } from "../shared/index.ts";

const NEW_STATUSES: ReadonlySet<string> = new Set(TASK_NODE_STATUSES);

/** 已是新形状：状态是四个之一，带着 waitingFor 和 skipped 两项。 */
function isCurrentNode(node: TaskNode): boolean {
  return NEW_STATUSES.has(node.status) && node.waitingFor !== undefined && typeof node.skipped === "boolean";
}

function normalizeNode(node: TaskNode): TaskNode {
  if (isCurrentNode(node)) return node;
  const { kind: _kind, ...rest } = node as TaskNode & { kind?: unknown };
  // 新状态但缺附带信息（不该有，防御）：按状态补默认值；旧状态按第 3.4 节映射
  const state = NEW_STATUSES.has(node.status) && node.status !== "waiting"
    ? { status: node.status, waitingFor: null, skipped: node.status === "done" && node.skipped === true }
    : taskNodeStateFromLegacy(node.status);
  return { ...rest, ...state };
}

const graphCache = new WeakMap<TaskGraph, TaskGraph>();

/** 一张图：已是新形状原样返回；否则返回换好状态的新对象（同一输入缓存同一个结果）。 */
export function normalizeTaskGraph(graph: TaskGraph): TaskGraph {
  if (graph.nodes.every(isCurrentNode)) return graph;
  const cached = graphCache.get(graph);
  if (cached !== undefined) return cached;
  const next: TaskGraph = { ...graph, nodes: graph.nodes.map(normalizeNode) };
  graphCache.set(graph, next);
  return next;
}

const listCache = new WeakMap<readonly TaskGraph[], TaskGraph[]>();

/** 一组图：每张都已是新形状就原样返回同一个数组；否则返回换好的新数组（同一输入缓存同一个结果）。 */
export function normalizeTaskGraphs<T extends readonly TaskGraph[]>(graphs: T): T {
  if (graphs.every((g) => g.nodes.every(isCurrentNode))) return graphs;
  const cached = listCache.get(graphs);
  if (cached !== undefined) return cached as unknown as T;
  const next = graphs.map(normalizeTaskGraph);
  listCache.set(graphs, next);
  return next as unknown as T;
}
