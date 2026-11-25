import {
  TASK_GRAPH_SELECTOR_CACHE_MAX,
  askOf,
  isTaskNodeAwaitingUserAction,
  isTaskNodeWaitingDecision,
  isTaskNodeWaitingPm,
  type ConversationId,
  type Message,
  type MessageId,
  type PendingDecision,
  type PmId,
  type ProjectId,
  type TaskGraph,
  type WorkerId,
} from "../shared/index.ts";
import { computeGateImpact } from "../shared/decisions.ts";
import { workersOf, type WorkerEntry } from "./selectors.ts";
import type { HubState } from "./state.ts";

const NO_TASK_GRAPHS: TaskGraph[] = [];
const NO_WORKERS: WorkerEntry[] = [];
const NO_DECISIONS: PendingDecision[] = [];
const NO_CONV_MESSAGES: readonly Message[] = [];

function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number): void {
  if (!map.has(key) && map.size >= maxSize) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

export function taskGraphPriority(graph: TaskGraph): number {
  let hasWaitingPm = false;
  for (const node of graph.nodes) {
    if (isTaskNodeAwaitingUserAction(node)) return 0;
    if (isTaskNodeWaitingPm(node)) hasWaitingPm = true;
  }
  return hasWaitingPm ? 1 : 2;
}

export function sortActiveGraphs(graphs: readonly TaskGraph[]): TaskGraph[] {
  if (graphs.length === 0) return NO_TASK_GRAPHS;
  return graphs.toSorted((a, b) => {
    const pa = taskGraphPriority(a);
    const pb = taskGraphPriority(b);
    if (pa !== pb) return pa - pb;
    return b.updatedAt - a.updatedAt || b.id - a.id;
  });
}

const activeGraphsCache = new WeakMap<HubState["activeTaskGraphs"], Map<ProjectId, TaskGraph[]>>();
const lastActiveGraphsByProject = new Map<ProjectId, TaskGraph[]>();

export function activeGraphsOf(state: HubState, projectId: ProjectId | null): TaskGraph[] {
  if (projectId === null) return NO_TASK_GRAPHS;
  let byProject = activeGraphsCache.get(state.activeTaskGraphs);
  if (byProject === undefined) {
    byProject = new Map();
    activeGraphsCache.set(state.activeTaskGraphs, byProject);
  }
  const hit = byProject.get(projectId);
  if (hit !== undefined) return hit;

  const filtered = state.activeTaskGraphs.filter((g) => g.projectId === projectId && g.status === "active");
  if (filtered.length === 0) {
    byProject.set(projectId, NO_TASK_GRAPHS);
    return NO_TASK_GRAPHS;
  }
  const sorted = sortActiveGraphs(filtered);
  const prev = lastActiveGraphsByProject.get(projectId);
  const resolved =
    prev !== undefined && prev.length === sorted.length && sorted.every((g, i) => g === prev[i]) ? prev : sorted;
  if (resolved !== prev) setBoundedMap(lastActiveGraphsByProject, projectId, resolved, TASK_GRAPH_SELECTOR_CACHE_MAX);
  byProject.set(projectId, resolved);
  return resolved;
}

const boundWorkerIdsCache = new WeakMap<readonly TaskGraph[], ReadonlySet<WorkerId>>();

export function isWorkerBound(worker: WorkerEntry, boundIds: ReadonlySet<WorkerId>): boolean {
  return worker.workerId !== undefined && boundIds.has(worker.workerId);
}

export function workersByWorkerId(workers: readonly WorkerEntry[]): ReadonlyMap<WorkerId, WorkerEntry> {
  const map = new Map<WorkerId, WorkerEntry>();
  for (const w of workers) {
    if (w.workerId !== undefined) map.set(w.workerId, w);
  }
  return map;
}

export function boundWorkerIdsOf(graphs: readonly TaskGraph[]): ReadonlySet<WorkerId> {
  const hit = boundWorkerIdsCache.get(graphs);
  if (hit !== undefined) return hit;
  const ids = new Set<WorkerId>();
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      if (node.activeWorkerId !== null) ids.add(node.activeWorkerId);
      for (const wid of node.workerIds) ids.add(wid);
    }
  }
  boundWorkerIdsCache.set(graphs, ids);
  return ids;
}

const unboundWorkersCache = new WeakMap<readonly WorkerEntry[], WeakMap<readonly TaskGraph[], WorkerEntry[]>>();
const lastUnboundByProject = new Map<ProjectId, WorkerEntry[]>();

export function unboundWorkersOf(state: HubState, projectId: ProjectId | null): WorkerEntry[] {
  if (projectId === null) return NO_WORKERS;
  const project = state.projects.find((p) => p.id === projectId);
  if (project === undefined) return NO_WORKERS;
  const allWorkers = workersOf(state, project.pmId);
  const graphs = activeGraphsOf(state, projectId);
  if (graphs.length === 0 || allWorkers.length === 0) return allWorkers;

  let byGraphs = unboundWorkersCache.get(allWorkers);
  if (byGraphs === undefined) {
    byGraphs = new WeakMap();
    unboundWorkersCache.set(allWorkers, byGraphs);
  }
  const hit = byGraphs.get(graphs);
  if (hit !== undefined) return hit;

  const boundIds = boundWorkerIdsOf(graphs);
  if (boundIds.size === 0) {
    byGraphs.set(graphs, allWorkers);
    return allWorkers;
  }
  const filtered = allWorkers.filter((w) => !isWorkerBound(w, boundIds));
  if (filtered.length === 0) {
    byGraphs.set(graphs, NO_WORKERS);
    return NO_WORKERS;
  }
  const prev = lastUnboundByProject.get(projectId);
  const resolved =
    prev !== undefined && prev.length === filtered.length && filtered.every((w, i) => w === prev[i]) ? prev : filtered;
  if (resolved !== prev) setBoundedMap(lastUnboundByProject, projectId, resolved, TASK_GRAPH_SELECTOR_CACHE_MAX);
  byGraphs.set(graphs, resolved);
  return resolved;
}

const gateMessageIdsByMessages = new WeakMap<readonly Message[], ReadonlySet<MessageId>>();

function gateMessageIdsIn(messages: readonly Message[]): ReadonlySet<MessageId> {
  const hit = gateMessageIdsByMessages.get(messages);
  if (hit !== undefined) return hit;
  const set = new Set<MessageId>();
  for (const msg of messages) {
    if (askOf(msg)?.gateRef !== undefined) set.add(msg.id);
  }
  gateMessageIdsByMessages.set(messages, set);
  return set;
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function samePendingDecision(a: PendingDecision, b: PendingDecision): boolean {
  if (
    a.key !== b.key ||
    a.pmId !== b.pmId ||
    a.pmName !== b.pmName ||
    a.projectId !== b.projectId ||
    a.projectName !== b.projectName ||
    a.conversationId !== b.conversationId ||
    a.question !== b.question ||
    a.context !== b.context ||
    a.askMessageId !== b.askMessageId ||
    a.createdAt !== b.createdAt ||
    a.updatedAt !== b.updatedAt ||
    !sameStringList(a.options, b.options) ||
    a.source.kind !== b.source.kind
  ) {
    return false;
  }
  if (a.source.kind === "gate" && b.source.kind === "gate") {
    return (
      a.source.graphId === b.source.graphId &&
      a.source.graphTitle === b.source.graphTitle &&
      a.source.nodeKey === b.source.nodeKey &&
      a.source.nodeTitle === b.source.nodeTitle &&
      a.source.blockedNodeCount === b.source.blockedNodeCount &&
      a.source.recommended === b.source.recommended &&
      Boolean(a.source.checkpoint) === Boolean(b.source.checkpoint) &&
      sameStringList(a.source.nextNodeTitles, b.source.nextNodeTitles)
    );
  }
  return (
    a.source.kind === "router_item" &&
    b.source.kind === "router_item" &&
    a.source.itemId === b.source.itemId &&
    (a.source.recommended ?? null) === (b.source.recommended ?? null)
  );
}

interface DecisionCacheValue {
  messages: readonly Message[];
  pms: HubState["pms"];
  projects: HubState["projects"];
  list: PendingDecision[];
}

const convDecisionsCache = new WeakMap<
  HubState["activeTaskGraphs"],
  WeakMap<HubState["router"]["items"], Map<string, DecisionCacheValue>>
>();
const lastDecisionsByScope = new Map<string, PendingDecision[]>();

function decisionScopeCache(state: HubState): Map<string, DecisionCacheValue> {
  let byRouterItems = convDecisionsCache.get(state.activeTaskGraphs);
  if (byRouterItems === undefined) {
    byRouterItems = new WeakMap();
    convDecisionsCache.set(state.activeTaskGraphs, byRouterItems);
  }
  let byScope = byRouterItems.get(state.router.items);
  if (byScope === undefined) {
    byScope = new Map();
    byRouterItems.set(state.router.items, byScope);
  }
  return byScope;
}

function decisionNames(state: HubState) {
  return {
    pm: (pmId: PmId) => state.pms.find((p) => p.id === pmId)?.name ?? `#${pmId}`,
    project: (projectId: ProjectId | null) =>
      projectId === null ? null : (state.projects.find((p) => p.id === projectId)?.name ?? null),
  };
}

function gateDecisionsOf(state: HubState, conversationId: ConversationId, deviceId: string, names: ReturnType<typeof decisionNames>) {
  const graphGateIds = new Set<MessageId>();
  const decisions: PendingDecision[] = [];
  for (const graph of state.activeTaskGraphs) {
    if (graph.status !== "active" || graph.conversationId !== conversationId) continue;
    for (const node of graph.nodes) {
      if (node.gateAskMessageId !== null) graphGateIds.add(node.gateAskMessageId);
      if (!isTaskNodeWaitingDecision(node)) continue;
      const { blockedNodeCount, nextNodeTitles } = computeGateImpact(graph, node.key);
      decisions.push({
        key: `gate:${deviceId}:${graph.id}:${node.key}`,
        deviceId,
        pmId: graph.pmId,
        pmName: names.pm(graph.pmId),
        projectId: graph.projectId,
        projectName: names.project(graph.projectId),
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
          ...(node.gateCheckpoint ? { checkpoint: true } : {}),
        },
      });
    }
  }
  return { decisions, graphGateIds };
}

function routerItemDecisionsOf(
  state: HubState,
  conversationId: ConversationId,
  deviceId: string,
  convMessages: readonly Message[],
  coveredAskIds: (id: MessageId) => boolean,
  names: ReturnType<typeof decisionNames>,
): PendingDecision[] {
  const decisions: PendingDecision[] = [];
  for (const item of state.router.items) {
    if (item.conversationId !== conversationId || item.kind !== "decision" || item.status !== "pending") continue;
    if (item.askMessageId !== null && coveredAskIds(item.askMessageId)) continue;
    const targetMsg = item.askMessageId !== null ? convMessages.find((m) => m.id === item.askMessageId) : undefined;
    const recommended = targetMsg !== undefined ? askOf(targetMsg)?.recommended : undefined;
    decisions.push({
      key: `item:${deviceId}:${item.id}`,
      deviceId,
      pmId: item.pmId,
      pmName: names.pm(item.pmId),
      projectId: item.projectId,
      projectName: names.project(item.projectId),
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
        ...(recommended !== undefined ? { recommended } : {}),
      },
    });
  }
  return decisions;
}

function stableDecisionList(scopeKey: string, result: PendingDecision[]): PendingDecision[] {
  if (result.length === 0) return NO_DECISIONS;
  result.sort((a, b) => b.createdAt - a.createdAt || a.key.localeCompare(b.key));
  const prev = lastDecisionsByScope.get(scopeKey);
  const resolved =
    prev !== undefined && prev.length === result.length && result.every((d, i) => samePendingDecision(d, prev[i]!))
      ? prev
      : result;
  if (resolved !== prev) setBoundedMap(lastDecisionsByScope, scopeKey, resolved, TASK_GRAPH_SELECTOR_CACHE_MAX);
  return resolved;
}

export function pendingDecisionsOf(
  state: HubState,
  conversationId: ConversationId,
  deviceId = "local",
): PendingDecision[] {
  const scopeKey = `${deviceId}:${conversationId}`;
  const convMessages = state.conversations[conversationId]?.messages ?? NO_CONV_MESSAGES;
  const byScope = decisionScopeCache(state);
  const hit = byScope.get(scopeKey);
  if (hit !== undefined && hit.messages === convMessages && hit.pms === state.pms && hit.projects === state.projects) {
    return hit.list;
  }

  const names = decisionNames(state);
  const msgGateIds = gateMessageIdsIn(convMessages);
  const gates = gateDecisionsOf(state, conversationId, deviceId, names);
  const covered = (id: MessageId) => msgGateIds.has(id) || gates.graphGateIds.has(id);
  const items = routerItemDecisionsOf(state, conversationId, deviceId, convMessages, covered, names);
  const list = stableDecisionList(scopeKey, [...gates.decisions, ...items]);
  byScope.set(scopeKey, { messages: convMessages, pms: state.pms, projects: state.projects, list });
  return list;
}
