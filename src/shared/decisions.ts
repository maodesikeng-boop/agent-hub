// 同源待决拍板投影（PendingDecision）：统一汇聚活跃任务图中的 waiting_user 门禁节点与 Router 独立待决项，
// 不造割裂双轨；按底层数据切片引用做多级 WeakMap 缓存，保证 StateSnapshot 与 HubState（含流式更新）均能返回同一数组引用。

import {
  askOf,
  type Conversation,
  type ConversationId,
  type Message,
  type MessageId,
  type Pm,
  type PmId,
  type Project,
  type ProjectId,
  type RouterItemId,
  type TaskGraph,
  type TaskGraphId,
  type TaskNode,
  type TaskNodeKey,
} from "./domain.ts";
import type { ConversationSnapshot } from "./api.ts";
import type { RouterItem, RouterSlice } from "./router.ts";

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

export type DecisionConversationsInput =
  | readonly (ConversationSnapshot | { conversation?: Conversation; messages: readonly Message[] })[]
  | Readonly<Record<ConversationId, { conversation: Conversation; messages: readonly Message[] }>>;

export interface DecisionSnapshotInput {
  pms: readonly Pm[];
  projects?: readonly Project[];
  conversations: DecisionConversationsInput;
  router?: Pick<RouterSlice, "items">;
  activeTaskGraphs?: readonly TaskGraph[];
}

const EMPTY_ROUTER_ITEMS: readonly RouterItem[] = [];
const EMPTY_TASK_GRAPHS: readonly TaskGraph[] = [];
const EMPTY_PROJECTS: readonly Project[] = [];

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

function messagesOfConversation(
  conversations: DecisionConversationsInput,
  conversationId: ConversationId,
): readonly Message[] {
  if (Array.isArray(conversations)) {
    const found = conversations.find((c) => c.conversation?.id === conversationId);
    if (found) return found.messages;
    // 兼容未传 conversation 字段的单测简化数组：退回扫一遍
    const fallback: Message[] = [];
    for (const c of conversations) {
      if (c.conversation === undefined) fallback.push(...c.messages);
    }
    return fallback;
  }
  const record = conversations as Readonly<Record<ConversationId, { conversation: Conversation; messages: readonly Message[] }>>;
  return record[conversationId]?.messages ?? [];
}

type CacheByProjects = WeakMap<readonly Project[], Map<string, { askMessagesSig: string; list: PendingDecision[] }>>;
type CacheByPms = WeakMap<readonly Pm[], CacheByProjects>;
type CacheByGraphs = WeakMap<readonly TaskGraph[], CacheByPms>;
const decisionsCache = new WeakMap<readonly RouterItem[], CacheByGraphs>();

/**
 * 从单机快照纯投影出当前全部待用户拍板项（门禁节点 + 无 gateRef 的独立 Router 待决项）。
 * 归档 PM 的项自动跳过；同一份底层数据引用与 deviceId 重复调用时返回完全相同的数组引用（===），且不扫 3 万条 Worker 历史消息。
 */
export function pendingDecisionsOf(snapshot: DecisionSnapshotInput, deviceId = "local"): PendingDecision[] {
  const routerItems = snapshot.router?.items ?? EMPTY_ROUTER_ITEMS;
  const graphs = snapshot.activeTaskGraphs ?? EMPTY_TASK_GRAPHS;
  const pms = snapshot.pms;
  const projects = snapshot.projects ?? EMPTY_PROJECTS;

  // 只在存在带 askMessageId 的 pending router_item 时才针对目标 PM 对话检查是否有 gateRef，避免遍历全量对话
  let askMessagesSig = "";
  for (const item of routerItems) {
    if (item.kind === "decision" && item.status === "pending" && item.askMessageId !== null) {
      const msgs = messagesOfConversation(snapshot.conversations, item.conversationId);
      const targetMsg = msgs.find((m) => m.id === item.askMessageId);
      const hasGateRef = targetMsg !== undefined && askOf(targetMsg)?.gateRef !== undefined ? "1" : "0";
      askMessagesSig += `${item.id}:${hasGateRef};`;
    }
  }

  let byGraphs = decisionsCache.get(routerItems);
  if (!byGraphs) {
    byGraphs = new WeakMap();
    decisionsCache.set(routerItems, byGraphs);
  }
  let byPms = byGraphs.get(graphs);
  if (!byPms) {
    byPms = new WeakMap();
    byGraphs.set(graphs, byPms);
  }
  let byProjects = byPms.get(pms);
  if (!byProjects) {
    byProjects = new WeakMap();
    byPms.set(pms, byProjects);
  }
  let byDevice = byProjects.get(projects);
  if (!byDevice) {
    byDevice = new Map();
    byProjects.set(projects, byDevice);
  }
  const cached = byDevice.get(deviceId);
  if (cached !== undefined && cached.askMessagesSig === askMessagesSig) {
    return cached.list;
  }

  const pmById = new Map<PmId, Pm>();
  for (const pm of pms) pmById.set(pm.id, pm);

  const projectNameById = new Map<ProjectId, string>();
  for (const proj of projects) projectNameById.set(proj.id, proj.name);

  const gateMessageIds = new Set<MessageId>();
  const result: PendingDecision[] = [];

  for (const graph of graphs) {
    if (graph.status !== "active") continue;
    const pm = pmById.get(graph.pmId);
    const archived = pm?.archivedAt != null;
    for (const node of graph.nodes) {
      if (node.gateAskMessageId !== null) gateMessageIds.add(node.gateAskMessageId);
      if (archived || node.kind !== "gate" || node.status !== "waiting_user") continue;
      const { blockedNodeCount, nextNodeTitles } = computeGateImpact(graph, node.key);
      result.push({
        key: `gate:${deviceId}:${graph.id}:${node.key}`,
        deviceId,
        pmId: graph.pmId,
        pmName: pm?.name ?? `#${graph.pmId}`,
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

  for (const item of routerItems) {
    if (item.kind !== "decision" || item.status !== "pending") continue;
    const pm = pmById.get(item.pmId);
    if (pm?.archivedAt != null) continue;
    if (item.askMessageId !== null) {
      if (gateMessageIds.has(item.askMessageId)) continue;
      const msgs = messagesOfConversation(snapshot.conversations, item.conversationId);
      const targetMsg = msgs.find((m) => m.id === item.askMessageId);
      if (targetMsg !== undefined && askOf(targetMsg)?.gateRef !== undefined) continue;
    }
    result.push({
      key: `item:${deviceId}:${item.id}`,
      deviceId,
      pmId: item.pmId,
      pmName: pm?.name ?? `#${item.pmId}`,
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
  byDevice.set(deviceId, { askMessagesSig, list: result });
  return result;
}
