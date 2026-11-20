import { DEVICE_PROXY_PREFIX, type Change, type DeviceId, type LedgerSnapshot, type PushPayload } from "./api.ts";
import { attachmentsOf } from "./attachments.ts";
import { pendingDecisionsOf, type PendingDecision } from "./decisions.ts";
import {
  askOf,
  isHandoverTraffic,
  isSilentTriggerMessage,
  systemEventOf,
  type Conversation,
  type ConversationId,
  type Message,
  type MessageId,
  type Pm,
  type PmId,
  type Project,
  type SessionId,
  type SessionState,
  type TaskGraph,
} from "./domain.ts";
import { ROUTER_ACTIVE_ITEMS_SNAPSHOT_MAX, ROUTER_RECENT_COMMANDS_SNAPSHOT_MAX } from "./limits.ts";
import { isRewoundMessage } from "./rewind.ts";
import { emptyRouterSlice, type RouterItem, type RouterReportItem, type RouterSlice } from "./router.ts";
import { normalizeTaskGraph, normalizeTaskGraphs } from "./task-graph-compat.ts";

export const WAITING_SETTLE_MS = 3_000;

const MIRROR_MESSAGES_PER_CONVERSATION = 200;

export interface ReminderState {
  seq: number;
  pms: Pm[];
  projects?: Project[];
  conversations: Record<ConversationId, { conversation: Conversation; messages: Message[] }>;
  sessions: SessionState[];
  router?: RouterSlice;
  activeTaskGraphs?: TaskGraph[];
  pending: readonly { conversationId: ConversationId; phase: "sending" | "failed" }[];
}

export type LastSeen = Record<ConversationId, number | undefined>;

const IN_FLIGHT = new Set(["queued", "delivered", "processing"]);

export function isInFlight(message: Pick<Message, "status">): boolean {
  return message.status !== null && IN_FLIGHT.has(message.status);
}

export function isQuietMessage(message: Message): boolean {
  if (isRewoundMessage(message) && attachmentsOf(message).length === 0) return true;
  return isHandoverTraffic(message) || isSilentTriggerMessage(message) || systemEventOf(message)?.event === "session.renewed";
}

const sessionByConversationCache = new WeakMap<
  readonly SessionState[],
  { length: number; map: Map<ConversationId, SessionState> }
>();

export function sessionOf(state: Pick<ReminderState, "sessions">, conversationId: ConversationId): SessionState | null {
  let cached = sessionByConversationCache.get(state.sessions);
  if (!cached || cached.length !== state.sessions.length) {
    const map = new Map<ConversationId, SessionState>();
    for (const s of state.sessions) {
      if (s.conversationId === null) continue;
      const prev = map.get(s.conversationId);
      if (prev === undefined || s.generation > prev.generation) map.set(s.conversationId, s);
    }
    cached = { length: state.sessions.length, map };
    sessionByConversationCache.set(state.sessions, cached);
  }
  return cached.map.get(conversationId) ?? null;
}

const runningWorkersCache = new WeakMap<ReminderState["conversations"], WeakMap<readonly SessionState[], ReadonlyMap<PmId | null, number>>>();

function runningWorkersByPm(state: Pick<ReminderState, "sessions" | "conversations">): ReadonlyMap<PmId | null, number> {
  let bySessions = runningWorkersCache.get(state.conversations);
  if (bySessions === undefined) {
    bySessions = new WeakMap();
    runningWorkersCache.set(state.conversations, bySessions);
  }
  const hit = bySessions.get(state.sessions);
  if (hit !== undefined) return hit;
  const counts = new Map<PmId | null, number>();
  for (const { conversation } of Object.values(state.conversations)) {
    if (conversation.kind !== "worker") continue;
    if ((sessionOf(state, conversation.id)?.activity ?? "idle") === "idle") continue;
    counts.set(conversation.pmId, (counts.get(conversation.pmId) ?? 0) + 1);
  }
  bySessions.set(state.sessions, counts);
  return counts;
}

export function runningWorkerCount(state: Pick<ReminderState, "sessions" | "conversations">, pmId: PmId): number {
  return runningWorkersByPm(state).get(pmId) ?? 0;
}

export function totalRunningWorkers(state: Pick<ReminderState, "sessions" | "conversations">): number {
  let total = 0;
  for (const n of runningWorkersByPm(state).values()) total += n;
  return total;
}

function pendingIn(state: Pick<ReminderState, "pending">, conversationId: ConversationId) {
  return state.pending.filter((p) => p.conversationId === conversationId);
}

function isPmArchived(state: Pick<ReminderState, "pms">, pmId: PmId | null): boolean {
  if (pmId === null) return false;
  const pm = state.pms.find((p) => p.id === pmId);
  return pm?.archivedAt != null;
}

export function waitingConversations(state: ReminderState, lastSeen: LastSeen): ConversationId[] {
  return Object.values(state.conversations)
    .filter(({ conversation, messages }) => {
      if (conversation.kind === "worker") return false;
      if (isPmArchived(state, conversation.pmId)) return false;
      const last = messages.findLast((m) => !isQuietMessage(m));
      if (!last || last.sender === "user" || last.createdAt <= (lastSeen[conversation.id] ?? 0)) return false;
      if (messages.some((m) => isInFlight(m) && !isHandoverTraffic(m))) return false;
      if (pendingIn(state, conversation.id).some((p) => p.phase === "sending")) return false;
      if ((visibleSessionOf(state, conversation.id)?.activity ?? "idle") !== "idle") return false;
      return conversation.pmId === null || runningWorkerCount(state, conversation.pmId) === 0;
    })
    .map(({ conversation }) => conversation.id);
}

const unansweredAsksCache = new WeakMap<readonly Message[], Message[]>();
const NO_MESSAGES: Message[] = [];

export function isUnansweredAsk(message: Pick<Message, "sender" | "meta">): boolean {
  const meta = askOf(message);
  return meta !== null && meta.answered !== true;
}

function unansweredAsksIn(messages: readonly Message[]): Message[] {
  let cached = unansweredAsksCache.get(messages);
  if (cached !== undefined) return cached;
  const found = messages.filter(isUnansweredAsk);
  cached = found.length === 0 ? NO_MESSAGES : found;
  unansweredAsksCache.set(messages, cached);
  return cached;
}

export function pendingAsks(state: ReminderState, conversationId: ConversationId): Message[] {
  const view = state.conversations[conversationId];
  if (
    !view ||
    view.conversation.kind === "worker" ||
    isPmArchived(state, view.conversation.pmId)
  ) {
    return NO_MESSAGES;
  }
  const all = unansweredAsksIn(view.messages);
  return all.length === 0 ? NO_MESSAGES : all;
}

export function allPendingAsks(state: ReminderState): { conversationId: ConversationId; message: Message }[] {
  const out: { conversationId: ConversationId; message: Message }[] = [];
  for (const { conversation } of Object.values(state.conversations)) {
    if (conversation.kind === "worker") continue;
    for (const message of pendingAsks(state, conversation.id)) {
      out.push({ conversationId: conversation.id, message });
    }
  }
  return out;
}

const unreadReportsCache = new WeakMap<readonly RouterItem[], WeakMap<readonly Pm[], RouterReportItem[]>>();
const NO_REPORTS: RouterReportItem[] = [];

export function unreadRouterReports(state: Pick<ReminderState, "pms" | "router">): RouterReportItem[] {
  const items = state.router?.items;
  if (!items || items.length === 0) return NO_REPORTS;
  let byPms = unreadReportsCache.get(items);
  if (!byPms) {
    byPms = new WeakMap();
    unreadReportsCache.set(items, byPms);
  }
  const cached = byPms.get(state.pms);
  if (cached !== undefined) return cached;

  const archivedPms = new Set<PmId>();
  for (const pm of state.pms) {
    if (pm.archivedAt != null) archivedPms.add(pm.id);
  }
  const found = items
    .filter((item): item is RouterReportItem => item.kind === "report" && item.status === "unread" && !archivedPms.has(item.pmId))
    .toSorted((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  const res = found.length === 0 ? NO_REPORTS : found;
  byPms.set(state.pms, res);
  return res;
}

export function askingConversations(state: ReminderState, deviceId = "local"): Set<ConversationId> {
  const set = new Set<ConversationId>();
  for (const { conversationId } of allPendingAsks(state)) {
    set.add(conversationId);
  }
  for (const decision of pendingDecisionsOf(state, deviceId)) {
    set.add(decision.conversationId);
  }
  return set;
}

export interface RouterReminderSummary {
  pendingCount: number;
  unreadReportCount: number;
  subtitle: string;
}

export function routerReminderSummary(
  devices: readonly { deviceId: string; state: ReminderState }[],
): RouterReminderSummary {
  let pendingCount = 0;
  let unreadReportCount = 0;
  let topDecision: PendingDecision | null = null;
  let topReport: RouterReportItem | null = null;

  for (const { deviceId, state } of devices) {
    const decisions = pendingDecisionsOf(state, deviceId);
    pendingCount += decisions.length;
    const firstDec = decisions[0];
    if (
      firstDec !== undefined &&
      (topDecision === null ||
        firstDec.createdAt > topDecision.createdAt ||
        (firstDec.createdAt === topDecision.createdAt && firstDec.key.localeCompare(topDecision.key) < 0))
    ) {
      topDecision = firstDec;
    }

    const reports = unreadRouterReports(state);
    unreadReportCount += reports.length;
    const firstRep = reports[0];
    if (
      firstRep !== undefined &&
      (topReport === null ||
        firstRep.createdAt > topReport.createdAt ||
        (firstRep.createdAt === topReport.createdAt && firstRep.id > topReport.id))
    ) {
      topReport = firstRep;
    }
  }

  const subtitle = topDecision?.question ?? topReport?.summary ?? "All clear";
  return { pendingCount, unreadReportCount, subtitle };
}

export function renewingIn(messages: Message[]): boolean {
  return messages.some((m) => systemEventOf(m)?.event === "handover.requested" && isInFlight(m));
}

export function visibleSessionOf(state: Pick<ReminderState, "sessions" | "conversations" | "pending">, conversationId: ConversationId): SessionState | null {
  const session = sessionOf(state, conversationId);
  const messages = state.conversations[conversationId]?.messages ?? [];
  if (session === null || !inHandoverTurn(messages, session.sessionId)) return session;
  const waiting = messages.some((m) => m.status === "queued" && !isHandoverTraffic(m)) || pendingIn(state, conversationId).some((p) => p.phase === "sending");
  const quiet = { currentTool: null, apiRetry: null, streamingText: undefined };
  return waiting ? { ...session, ...quiet, activity: "working", step: { type: "thinking" } } : { ...session, ...quiet, activity: "idle", step: null };
}

function inHandoverTurn(messages: Message[], sessionId: SessionId): boolean {
  if (renewingIn(messages)) return true;
  const last = messages.findLast((m) => m.sessionId === sessionId && m.status !== null);
  return last !== undefined && systemEventOf(last)?.event === "handover.requested";
}

export function notificationTag(pmId: PmId | null, conversationId: ConversationId): string {
  return pmId === null ? `conversation-${conversationId}` : `pm-${pmId}`;
}

export interface Reminder<K> {
  kind: "waiting" | "ask";
  conversationId: K;
}

export class ReminderTracker<K> {
  #started = false;
  #settled = new Set<K>();
  #since = new Map<K, number>();
  #knownAsks = new Set<MessageId>();

  update(now: number, waiting: readonly K[], asks: readonly { conversationId: K; messageId: MessageId }[]): { fire: Reminder<K>[]; nextCheckAt: number | null } {
    const fire: Reminder<K>[] = [];
    const candidates = new Set(waiting);
    for (const key of this.#settled) if (!candidates.has(key)) this.#settled.delete(key);
    for (const key of this.#since.keys()) if (!candidates.has(key)) this.#since.delete(key);
    if (!this.#started) {
      this.#started = true;
      for (const key of candidates) this.#settled.add(key);
      for (const a of asks) this.#knownAsks.add(a.messageId);
      return { fire, nextCheckAt: null };
    }
    let nextCheckAt: number | null = null;
    for (const key of candidates) {
      if (this.#settled.has(key)) continue;
      const since = this.#since.get(key) ?? now;
      this.#since.set(key, since);
      if (now - since >= WAITING_SETTLE_MS) {
        this.#since.delete(key);
        this.#settled.add(key);
        fire.push({ kind: "waiting", conversationId: key });
      } else {
        nextCheckAt = Math.min(nextCheckAt ?? Infinity, since + WAITING_SETTLE_MS);
      }
    }
    for (const a of asks) {
      if (this.#knownAsks.has(a.messageId)) continue;
      this.#knownAsks.add(a.messageId);
      fire.push({ kind: "ask", conversationId: a.conversationId });
    }
    return { fire, nextCheckAt };
  }

  waiting(): ReadonlySet<K> {
    return this.#settled;
  }
}

export function reminderStateFrom(
  snapshot: Pick<LedgerSnapshot, "seq" | "pms" | "conversations" | "sessions"> &
    Partial<Pick<LedgerSnapshot, "projects" | "router" | "activeTaskGraphs">>,
): ReminderState {
  return {
    seq: snapshot.seq,
    pms: snapshot.pms,
    projects: snapshot.projects ?? [],
    conversations: Object.fromEntries(
      snapshot.conversations.map(({ conversation, messages }) => [
        conversation.id,
        { conversation, messages: conversation.kind === "worker" ? [] : messages },
      ]),
    ),
    sessions: snapshot.sessions.map(({ streamingText: _, ...s }) => s),
    router: snapshot.router ?? emptyRouterSlice(),
    activeTaskGraphs: snapshot.activeTaskGraphs === undefined ? [] : normalizeTaskGraphs(snapshot.activeTaskGraphs),
    pending: [],
  };
}

function upsertBy<T>(list: T[], item: T, same: (a: T, b: T) => boolean): T[] {
  const index = list.findIndex((x) => same(x, item));
  return index === -1 ? [...list, item] : list.with(index, item);
}

function upsertRecent(messages: Message[], message: Message): Message[] {
  const last = messages.at(-1);
  let next: Message[];
  if (last === undefined || message.id > last.id) next = [...messages, message];
  else if (message.id === last.id) next = messages.with(messages.length - 1, message);
  else {
    const index = messages.findIndex((m) => m.id >= message.id);
    next = messages[index]?.id === message.id ? messages.with(index, message) : messages.toSpliced(index, 0, message);
  }
  return next.length > MIRROR_MESSAGES_PER_CONVERSATION ? next.slice(-MIRROR_MESSAGES_PER_CONVERSATION) : next;
}

export function applyReminderChange(state: ReminderState, change: Change): ReminderState {
  if (change.seq <= state.seq) return state;
  const next = { ...state, seq: change.seq };
  const curRouter = state.router ?? emptyRouterSlice();
  const curGraphs = state.activeTaskGraphs ?? [];
  const curProjects = state.projects ?? [];
  switch (change.type) {
    case "message.created":
    case "message.updated": {
      const { message } = change.data;
      const view = state.conversations[message.conversationId];
      if (!view || view.conversation.kind === "worker") return next;
      return { ...next, conversations: { ...state.conversations, [message.conversationId]: { ...view, messages: upsertRecent(view.messages, message) } } };
    }
    case "session.status":
    case "session.created": {
      const { streamingText: _, ...incoming } = change.data.session;
      const index = state.sessions.findIndex((x) => x.sessionId === incoming.sessionId);
      if (index !== -1) {
        const prev = state.sessions[index]!;
        if (
          prev.conversationId === incoming.conversationId &&
          prev.pmId === incoming.pmId &&
          prev.generation === incoming.generation &&
          prev.status === incoming.status &&
          prev.activity === incoming.activity
        ) {
          return next;
        }
        return { ...next, sessions: state.sessions.with(index, incoming) };
      }
      return { ...next, sessions: [...state.sessions, incoming] };
    }
    case "pm.created":
    case "pm.updated":
      return { ...next, pms: upsertBy(state.pms, change.data.pm, (a, b) => a.id === b.id) };
    case "pm.removed": {
      const { pmId } = change.data;
      const conversations = Object.fromEntries(
        Object.entries(state.conversations).filter(([, view]) => view.conversation.pmId !== pmId),
      );
      const routerItems = curRouter.items.filter((i) => i.pmId !== pmId);
      const router = routerItems.length === curRouter.items.length ? curRouter : { ...curRouter, items: routerItems };
      const activeTaskGraphs = curGraphs.filter((g) => g.pmId !== pmId);
      return {
        ...next,
        pms: state.pms.filter((p) => p.id !== pmId),
        projects: curProjects.filter((p) => p.pmId !== pmId),
        conversations,
        router,
        activeTaskGraphs: activeTaskGraphs.length === curGraphs.length ? curGraphs : activeTaskGraphs,
      };
    }
    case "project.created":
      return { ...next, projects: upsertBy(curProjects, change.data.project, (a, b) => a.id === b.id) };
    case "conversation.created": {
      const { conversation } = change.data;
      if (state.conversations[conversation.id]) return next;
      return { ...next, conversations: { ...state.conversations, [conversation.id]: { conversation, messages: [] } } };
    }
    case "router.settings.updated":
      return { ...next, router: { ...curRouter, settings: change.data.settings } };
    case "router.item.created":
    case "router.item.updated": {
      const { item } = change.data;
      const isActive = item.status === "pending" || item.status === "unread";
      const existingIndex = curRouter.items.findIndex((x) => x.id === item.id);
      if (!isActive) {
        if (existingIndex === -1) return next;
        return { ...next, router: { ...curRouter, items: curRouter.items.filter((x) => x.id !== item.id) } };
      }
      const items =
        existingIndex === -1
          ? [item, ...curRouter.items].slice(0, ROUTER_ACTIVE_ITEMS_SNAPSHOT_MAX)
          : curRouter.items.with(existingIndex, item);
      return { ...next, router: { ...curRouter, items } };
    }
    case "router.reports.archived_all": {
      const archived = new Set(change.data.archivedIds);
      const items = curRouter.items.filter((x) => !archived.has(x.id));
      return items.length === curRouter.items.length ? next : { ...next, router: { ...curRouter, items } };
    }
    case "router.command.created":
    case "router.command.updated": {
      const { command } = change.data;
      const existingIndex = curRouter.commands.findIndex((c) => c.id === command.id);
      const commands =
        existingIndex === -1
          ? [command, ...curRouter.commands].slice(0, ROUTER_RECENT_COMMANDS_SNAPSHOT_MAX)
          : curRouter.commands.with(existingIndex, command);
      return { ...next, router: { ...curRouter, commands } };
    }
    case "task_graph.created":
    case "task_graph.updated": {
      const graph = normalizeTaskGraph(change.data.graph);
      const existingIndex = curGraphs.findIndex((g) => g.id === graph.id);
      if (graph.status !== "active") {
        if (existingIndex === -1) return next;
        return { ...next, activeTaskGraphs: curGraphs.filter((g) => g.id !== graph.id) };
      }
      const activeTaskGraphs =
        existingIndex === -1 ? [graph, ...curGraphs] : curGraphs.with(existingIndex, graph);
      return { ...next, activeTaskGraphs };
    }
    default:
      return next;
  }
}

export interface ReminderDevice {
  id: DeviceId;
  name: string;
  self: boolean;
}

export function reminderPayload(state: ReminderState, reminder: Reminder<ConversationId>, device: ReminderDevice): PushPayload | null {
  const view = state.conversations[reminder.conversationId];
  if (!view) return null;
  const { conversation } = view;
  const pm = conversation.pmId === null ? undefined : state.pms.find((p) => p.id === conversation.pmId);
  const name = pm?.name ?? conversation.title;
  const tag = notificationTag(conversation.pmId, conversation.id);
  const route = `#/c/${conversation.id}`;
  return {
    title: `${device.name} · ${name}：${reminder.kind === "ask" ? "等你确定" : "等你"}`,
    url: device.self ? `/${route}` : `/#${DEVICE_PROXY_PREFIX}/${device.id}/${route.slice(2)}`,
    tag: `${device.id}:${reminder.kind === "ask" ? `ask-${tag}` : tag}`,
  };
}
