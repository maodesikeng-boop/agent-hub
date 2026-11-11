// 同源待决拍板投影（PendingDecision）：统一汇聚活跃任务图中的 waiting_user 门禁节点与 Router 独立待决项，
// 不造割裂双轨；按输入快照对象做 WeakMap 引用缓存，保证前端 selector 输入未变时返回同一引用。

import type { StateSnapshot } from "./api.ts";
import {
  askOf,
  type ConversationId,
  type MessageId,
  type PmId,
  type ProjectId,
  type RouterItemId,
  type TaskGraph,
  type TaskGraphId,
  type TaskNode,
  type TaskNodeKey,
} from "./domain.ts";

export type PendingDecisionSource =
  | {
      kind: "gate";
      graphId: TaskGraphId;
      graphTitle: string;
      nodeKey: TaskNodeKey;
      nodeTitle: string;
      blockedNodeCount: number;
      nextNodeTitles: string[];
      recommended: string | null;
    }
  | {
      kind: "router_item";
      itemId: RouterItemId;
    };

export interface PendingDecision {
  /** 全局稳定键：`gate:${deviceId}:${graphId}:${nodeKey}` 或 `item:${deviceId}:${itemId}`。 */
  key: string;
  deviceId: string;
  pmId: PmId;
  pmName: string;
  projectId: ProjectId | null;
  projectName: string | null;
  conversationId: ConversationId;
  question: string;
  context: string;
  options: string[];
  askMessageId: MessageId | null;
  createdAt: number;
  updatedAt: number;
  source: PendingDecisionSource;
}

export type DecisionSnapshotInput = Pick<
  StateSnapshot,
  "pms" | "projects" | "conversations" | "router" | "activeTaskGraphs"
>;

/** 计算一个门禁节点当前阻塞的下游节点总数与直接下游节点标题预览（最多 3 个）。 */
export function computeGateImpact(
  graph: Pick<TaskGraph, "nodes" | "edges">,
  nodeKey: TaskNodeKey,
): { blockedNodeCount: number; nextNodeTitles: string[] } {
  const nodeByKey = new Map<TaskNodeKey, TaskNode>();
  for (const node of graph.nodes) nodeByKey.set(node.key, node);

  const outgoing = new Map<TaskNodeKey, TaskNodeKey[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.fromKey);
    if (list) list.push(edge.toKey);
    else outgoing.set(edge.fromKey, [edge.toKey]);
  }

  const directKeys = outgoing.get(nodeKey) ?? [];
  const directNodes = directKeys
    .map((k) => nodeByKey.get(k))
    .filter((n): n is TaskNode => n !== undefined && n.status !== "done" && n.status !== "skipped")
    .toSorted((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key));
  const nextNodeTitles = directNodes.slice(0, 3).map((n) => n.title);

  const visited = new Set<TaskNodeKey>();
  const queue: TaskNodeKey[] = [...directKeys];
  let blockedNodeCount = 0;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const target = nodeByKey.get(cur);
    if (!target) continue;
    if (target.status !== "done" && target.status !== "skipped") {
      blockedNodeCount++;
    }
    for (const next of outgoing.get(cur) ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
  }

  return { blockedNodeCount, nextNodeTitles };
}

const decisionsCache = new WeakMap<DecisionSnapshotInput, Map<string, PendingDecision[]>>();

/**
 * 从单机快照纯投影出当前全部待用户拍板项（门禁节点 + 无 gateRef 的独立 Router 待决项）。
 * 同一份 snapshot 引用与 deviceId 重复调用时返回完全相同的数组引用（===）。
 */
export function pendingDecisionsOf(snapshot: DecisionSnapshotInput, deviceId = "local"): PendingDecision[] {
  let byDevice = decisionsCache.get(snapshot);
  if (byDevice !== undefined) {
    const cached = byDevice.get(deviceId);
    if (cached !== undefined) return cached;
  } else {
    byDevice = new Map();
    decisionsCache.set(snapshot, byDevice);
  }

  const pmNameById = new Map<PmId, string>();
  for (const pm of snapshot.pms) pmNameById.set(pm.id, pm.name);

  const projectNameById = new Map<ProjectId, string>();
  for (const proj of snapshot.projects) projectNameById.set(proj.id, proj.name);

  // 汇总所有带 gateRef 的消息 ID 与所有任务图门禁绑定的消息 ID，防止任何情况下出现同源双卡
  const gateMessageIds = new Set<MessageId>();
  for (const conv of snapshot.conversations) {
    for (const msg of conv.messages) {
      if (askOf(msg)?.gateRef !== undefined) gateMessageIds.add(msg.id);
    }
  }

  const result: PendingDecision[] = [];

  for (const graph of snapshot.activeTaskGraphs) {
    if (graph.status !== "active") continue;
    for (const node of graph.nodes) {
      if (node.gateAskMessageId !== null) gateMessageIds.add(node.gateAskMessageId);
      if (node.kind !== "gate" || node.status !== "waiting_user") continue;
      const { blockedNodeCount, nextNodeTitles } = computeGateImpact(graph, node.key);
      result.push({
        key: `gate:${deviceId}:${graph.id}:${node.key}`,
        deviceId,
        pmId: graph.pmId,
        pmName: pmNameById.get(graph.pmId) ?? `#${graph.pmId}`,
        projectId: graph.projectId,
        projectName: projectNameById.get(graph.projectId) ?? null,
        conversationId: graph.conversationId,
        question: node.gateQuestion ?? node.title,
        context: node.gateSummaryMd ?? "",
        options: node.gateOptions,
        askMessageId: node.gateAskMessageId,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        source: {
          kind: "gate",
          graphId: graph.id,
          graphTitle: graph.title,
          nodeKey: node.key,
          nodeTitle: node.title,
          blockedNodeCount,
          nextNodeTitles,
          recommended: node.gateRecommended,
        },
      });
    }
  }

  for (const item of snapshot.router.items) {
    if (item.kind !== "decision" || item.status !== "pending") continue;
    if (item.askMessageId !== null && gateMessageIds.has(item.askMessageId)) continue;
    result.push({
      key: `item:${deviceId}:${item.id}`,
      deviceId,
      pmId: item.pmId,
      pmName: pmNameById.get(item.pmId) ?? `#${item.pmId}`,
      projectId: item.projectId,
      projectName: item.projectId === null ? null : (projectNameById.get(item.projectId) ?? null),
      conversationId: item.conversationId,
      question: item.question,
      context: item.context,
      options: item.options,
      askMessageId: item.askMessageId,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      source: {
        kind: "router_item",
        itemId: item.id,
      },
    });
  }

  result.sort((a, b) => b.createdAt - a.createdAt || a.key.localeCompare(b.key));
  byDevice.set(deviceId, result);
  return result;
}
