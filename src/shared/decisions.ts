import {
  askOf,
  isTaskNodeWaitingDecision,
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
import type { Deliverable } from "./deliverables.ts";
import { DELIVERABLES_PER_CARD_MAX } from "./limits.ts";
import type { RouterItem, RouterSlice } from "./router.ts";
import { normalizeTaskGraphs } from "./task-graph-compat.ts";

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
      checkpoint?: boolean;
    }
  | {
      kind: "router_item";
      itemId: RouterItemId;
      recommended?: string | null;
    };

export interface PendingDecision {
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
  deliverables?: Deliverable[];
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

function cardDeliverables(list: Deliverable[] | undefined): { deliverables?: Deliverable[] } {
  if (list === undefined || list.length === 0) return {};
  return { deliverables: list.length > DELIVERABLES_PER_CARD_MAX ? list.slice(0, DELIVERABLES_PER_CARD_MAX) : list };
}

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
    .filter((n): n is TaskNode => n !== undefined && n.status !== "done")
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
    if (target.status !== "done") {
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

function askMessagesSigOf(routerItems: readonly RouterItem[], conversations: DecisionConversationsInput): string {
  let sig = "";
  for (const item of routerItems) {
    if (item.kind === "decision" && item.status === "pending" && item.askMessageId !== null) {
      const msgs = messagesOfConversation(conversations, item.conversationId);
      const targetMsg = msgs.find((m) => m.id === item.askMessageId);
      const targetAsk = targetMsg !== undefined ? askOf(targetMsg) : null;
      const hasGateRef = targetAsk?.gateRef !== undefined ? "1" : "0";
      sig += `${item.id}:${hasGateRef}:${targetAsk?.recommended ?? ""};`;
    }
  }
  return sig;
}

function decisionsCacheSlot(
  routerItems: readonly RouterItem[],
  graphs: readonly TaskGraph[],
  pms: readonly Pm[],
  projects: readonly Project[],
): Map<string, { askMessagesSig: string; list: PendingDecision[] }> {
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
  return byDevice;
}

interface DecisionLookups {
  deviceId: string;
  pmById: Map<PmId, Pm>;
  projectNameById: Map<ProjectId, string>;
}

function gateDecisionsOf(graphs: readonly TaskGraph[], lookups: DecisionLookups, gateMessageIds: Set<MessageId>): PendingDecision[] {
  const { deviceId, pmById, projectNameById } = lookups;
  const result: PendingDecision[] = [];
  for (const graph of graphs) {
    if (graph.status !== "active") continue;
    const pm = pmById.get(graph.pmId);
    const archived = pm?.archivedAt != null;
    for (const node of graph.nodes) {
      if (node.gateAskMessageId !== null) gateMessageIds.add(node.gateAskMessageId);
      if (archived || !isTaskNodeWaitingDecision(node)) continue;
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
        ...cardDeliverables(node.artifact?.deliverables),
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
          ...(node.gateCheckpoint ? { checkpoint: true } : {}),
        },
      });
    }
  }
  return result;
}

function routerItemDecisionsOf(
  routerItems: readonly RouterItem[],
  conversations: DecisionConversationsInput,
  lookups: DecisionLookups,
  gateMessageIds: ReadonlySet<MessageId>,
): PendingDecision[] {
  const { deviceId, pmById, projectNameById } = lookups;
  const result: PendingDecision[] = [];
  for (const item of routerItems) {
    if (item.kind !== "decision" || item.status !== "pending") continue;
    const pm = pmById.get(item.pmId);
    if (pm?.archivedAt != null) continue;
    let recommended: string | undefined;
    if (item.askMessageId !== null) {
      if (gateMessageIds.has(item.askMessageId)) continue;
      const msgs = messagesOfConversation(conversations, item.conversationId);
      const targetMsg = msgs.find((m) => m.id === item.askMessageId);
      const targetAsk = targetMsg !== undefined ? askOf(targetMsg) : null;
      if (targetAsk?.gateRef !== undefined) continue;
      recommended = targetAsk?.recommended;
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
      ...cardDeliverables(item.deliverables),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      source: {
        kind: "router_item",
        itemId: item.id,
        ...(recommended !== undefined ? { recommended } : {}),
      },
    });
  }
  return result;
}

export function pendingDecisionsOf(snapshot: DecisionSnapshotInput, deviceId = "local"): PendingDecision[] {
  const routerItems = snapshot.router?.items ?? EMPTY_ROUTER_ITEMS;
  const graphs = normalizeTaskGraphs(snapshot.activeTaskGraphs ?? EMPTY_TASK_GRAPHS);
  const pms = snapshot.pms;
  const projects = snapshot.projects ?? EMPTY_PROJECTS;

  const askMessagesSig = askMessagesSigOf(routerItems, snapshot.conversations);
  const byDevice = decisionsCacheSlot(routerItems, graphs, pms, projects);
  const cached = byDevice.get(deviceId);
  if (cached !== undefined && cached.askMessagesSig === askMessagesSig) {
    return cached.list;
  }

  const pmById = new Map<PmId, Pm>();
  for (const pm of pms) pmById.set(pm.id, pm);
  const projectNameById = new Map<ProjectId, string>();
  for (const proj of projects) projectNameById.set(proj.id, proj.name);
  const lookups: DecisionLookups = { deviceId, pmById, projectNameById };

  const gateMessageIds = new Set<MessageId>();
  const result = [
    ...gateDecisionsOf(graphs, lookups, gateMessageIds),
    ...routerItemDecisionsOf(routerItems, snapshot.conversations, lookups, gateMessageIds),
  ];
  result.sort((a, b) => b.createdAt - a.createdAt || a.key.localeCompare(b.key));
  byDevice.set(deviceId, { askMessagesSig, list: result });
  return result;
}
