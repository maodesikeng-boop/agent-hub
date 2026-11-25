import {
  MAX_CONVERSATION_LOOKUP_STATES,
  MAX_REWOUND_PENDING_KEYS,
  ROUTER_ACTIVE_ITEMS_SNAPSHOT_MAX,
  ROUTER_STREAM_LIVE_MAX,
  clearRateLimitRejection,
  emptyRouterSlice,
  isLedgerWakeup,
  isQuotaExhausted,
  isRewoundMessage,
  isWorkerEndLine,
  serverInfoFor,
  sessionOf,
  userMessageDedupeKey,
  workerEventOf,
  type Attachment,
  type Change,
  type ConversationId,
  type ConversationSnapshot,
  type ConversationsLookup,
  type HealthEntry,
  type Message,
  type MessageId,
  type Pm,
  type PmId,
  type Project,
  type ProjectFolder,
  type RouterItem,
  type RouterSlice,
  type ScheduleRecord,
  type ServerInfo,
  type SessionState,
  type StateSnapshot,
  type TaskGraph,
  type WorkerPick,
} from "../shared/index.ts";
import type { ErrorInfo } from "./format.ts";
import { normalizeTaskGraph, normalizeTaskGraphs } from "./task-graph-compat.ts";
import type { ConnectionStatus } from "./connection.ts";

export interface PendingMessage {
  clientId: string;
  conversationId: ConversationId;
  text: string;
  attachments: Attachment[];
  workerPick?: WorkerPick;
  phase: "sending" | "failed";
  failure?: "attachments_missing" | "rejected";
  reason?: ErrorInfo;
  createdAt: number;
}

export type OlderState = "loading" | "error";

export type RetryPhase = "retrying" | "error";

export interface ConversationView {
  conversation: ConversationSnapshot["conversation"];
  messages: Message[];
  hasMore: boolean;
  workerLine?: ConversationSnapshot["workerLine"];
  workerBranch?: string | null;
  outsideRev?: number;
}

type Phase = "loading" | "ready" | "error" | "unauthorized";

export interface HubState {
  phase: Phase;
  loadError?: ErrorInfo;
  connection: ConnectionStatus;
  seq: number;
  pms: Pm[];
  projects: Project[];
  folders: ProjectFolder[];
  personaRev: Record<PmId, number | undefined>;
  snapshotRev: number;
  conversations: Record<ConversationId, ConversationView>;
  sessions: SessionState[];
  health: HealthEntry[];
  schedules: ScheduleRecord[];
  router: RouterSlice;
  activeTaskGraphs: TaskGraph[];
  lookups: Record<ConversationId, "loading" | "missing" | undefined>;
  server: ServerInfo;
  pending: PendingMessage[];
  older: Record<ConversationId, OlderState | undefined>;
  olderLoaded?: Record<ConversationId, boolean | undefined>;
  retry: Record<MessageId, RetryPhase | undefined>;
  rewoundKeys?: readonly string[];
}

export const MAX_LIVE_MESSAGES = 200;

export const initialState: HubState = {
  phase: "loading",
  connection: "connecting",
  seq: 0,
  pms: [],
  projects: [],
  folders: [],
  personaRev: {},
  snapshotRev: 0,
  conversations: {},
  sessions: [],
  health: [],
  schedules: [],
  router: emptyRouterSlice(),
  activeTaskGraphs: [],
  lookups: {},
  server: serverInfoFor("darwin"),
  pending: [],
  older: {},
  retry: {},
};

export type HubAction =
  | { type: "loading" }
  | { type: "loaded"; snapshot: StateSnapshot }
  | { type: "loadFailed"; unauthorized: boolean; error?: ErrorInfo }
  | { type: "change"; change: Change }
  | { type: "connection"; status: ConnectionStatus }
  | { type: "olderStart"; conversationId: ConversationId }
  | { type: "olderDone"; conversationId: ConversationId; messages: Message[]; hasMore: boolean }
  | { type: "olderFailed"; conversationId: ConversationId }
  | { type: "pendingAdd"; pending: PendingMessage }
  | { type: "pendingPhase"; clientId: string; phase: PendingMessage["phase"]; failure?: PendingMessage["failure"]; reason?: ErrorInfo }
  | { type: "pendingRewind"; clientId: string }
  | { type: "messageRewind"; conversationId: ConversationId; messageId: MessageId }
  | { type: "lookupStart"; ids: readonly ConversationId[] }
  | { type: "lookupDone"; ids: readonly ConversationId[]; lookup: ConversationsLookup }
  | { type: "lookupFailed"; ids: readonly ConversationId[] }
  | { type: "retryStart"; messageId: MessageId }
  | { type: "retryFailed"; messageId: MessageId };

function withRewoundMeta(message: Message): Message {
  if (isRewoundMessage(message)) return message;
  return { ...message, meta: { ...(message.meta ?? {}), rewound: true } };
}

export function upsertMessage(messages: Message[], message: Message): Message[] {
  const last = messages.at(-1);
  if (last === undefined || message.id > last.id) return [...messages, message];
  if (message.id === last.id) return messages.with(messages.length - 1, isRewoundMessage(last) ? withRewoundMeta(message) : message);
  const index = messages.findIndex((m) => m.id >= message.id);
  const existing = messages[index];
  if (existing?.id === message.id) return messages.with(index, isRewoundMessage(existing) ? withRewoundMeta(message) : message);
  return messages.toSpliced(index, 0, message);
}

function dropConfirmed(pending: PendingMessage[], messages: Message[]): PendingMessage[] {
  if (pending.length === 0) return pending;
  const keys = new Set(messages.filter((m) => m.sender === "user").map((m) => m.dedupeKey));
  const rest = pending.filter((p) => !keys.has(userMessageDedupeKey(p.conversationId, p.clientId)));
  return rest.length === pending.length ? pending : rest;
}

function upsertBy<T>(list: T[], item: T, same: (a: T, b: T) => boolean): T[] {
  const index = list.findIndex((x) => same(x, item));
  return index === -1 ? [...list, item] : list.with(index, item);
}

function dropSessionQuotaRejection(
  sessions: SessionState[],
  conversationId: ConversationId,
  sessionId?: number | null,
): SessionState[] {
  const current = sessionOf({ sessions }, conversationId);
  const targetId = sessionId ?? current?.sessionId;
  if (targetId == null) return sessions;
  if (current?.sessionId === targetId && !isQuotaExhausted(current.rateLimit)) return sessions;
  if (!sessions.some((s) => s.sessionId === targetId && isQuotaExhausted(s.rateLimit))) return sessions;
  return sessions.map((s) =>
    s.sessionId === targetId && s.rateLimit !== null && isQuotaExhausted(s.rateLimit)
      ? { ...s, rateLimit: clearRateLimitRejection(s.rateLimit) }
      : s,
  );
}

function capRouterItems(items: RouterItem[]): { items: RouterItem[]; reportsTrimmed: boolean } {
  let decisions = 0;
  let reports = 0;
  let decisionsTrimmed = false;
  let reportsTrimmed = false;
  for (const x of items) {
    if (x.kind === "decision") {
      if (++decisions > ROUTER_ACTIVE_ITEMS_SNAPSHOT_MAX) decisionsTrimmed = true;
    } else if (++reports > ROUTER_STREAM_LIVE_MAX) {
      reportsTrimmed = true;
    }
  }
  if (!decisionsTrimmed && !reportsTrimmed) return { items, reportsTrimmed: false };
  decisions = 0;
  reports = 0;
  return {
    items: items.filter((x) =>
      x.kind === "decision" ? ++decisions <= ROUTER_ACTIVE_ITEMS_SNAPSHOT_MAX : ++reports <= ROUTER_STREAM_LIVE_MAX,
    ),
    reportsTrimmed,
  };
}

function dropRetryIfSettled(retry: HubState["retry"], message: Message): HubState["retry"] {
  if (message.status === "failed" || retry[message.id] === undefined) return retry;
  const { [message.id]: _settled, ...rest } = retry;
  return rest;
}

function advanceWorkerLine(
  conversations: Record<ConversationId, ConversationView>,
  message: Message,
): Record<ConversationId, ConversationView> {
  const line = workerEventOf(message);
  if (line === null) return conversations;
  const target = conversations[line.workerConversationId];
  if (!target) return conversations;
  const prev = target.workerLine;
  const endedAt = isWorkerEndLine(line) ? Math.max(prev?.endedAt ?? 0, message.createdAt) : (prev?.endedAt ?? null);
  const workerLine =
    prev === undefined || message.id >= prev.messageId
      ? { messageId: message.id, at: message.createdAt, line, endedAt }
      : { ...prev, endedAt };
  return { ...conversations, [line.workerConversationId]: { ...target, workerLine } };
}

function clearConversationStreaming(sessions: SessionState[], conversationId: ConversationId): SessionState[] {
  if (!sessions.some((s) => s.conversationId === conversationId && s.streamingText !== undefined)) return sessions;
  return sessions.map((s) => {
    if (s.conversationId !== conversationId || s.streamingText === undefined) return s;
    const { streamingText: _, ...clean } = s;
    return clean;
  });
}

export function applyChange(state: HubState, change: Change): HubState {
  if (change.seq <= state.seq) return state;
  const next = { ...state, seq: change.seq };
  switch (change.type) {
    case "message.created":
    case "message.updated": {
      const raw = change.data.message;
      const wasRewoundPending = state.rewoundKeys?.includes(raw.dedupeKey) === true;
      const message = wasRewoundPending ? withRewoundMeta(raw) : raw;
      const nextBase = wasRewoundPending ? { ...next, rewoundKeys: state.rewoundKeys!.filter((k) => k !== raw.dedupeKey) } : next;
      const afterStreaming =
        change.type === "message.created" &&
        message.sender === "agent" &&
        message.sessionId !== null &&
        state.sessions.some((s) => s.sessionId === message.sessionId && s.streamingText !== undefined)
          ? state.sessions.map((s) => {
              if (s.sessionId !== message.sessionId || s.streamingText === undefined) return s;
              const { streamingText: _, ...clean } = s;
              return clean;
            })
          : state.sessions;
      const sessions =
        change.type === "message.created" &&
        message.status === "queued" &&
        ((message.sender === "user" && !isLedgerWakeup(message)) || message.sender === "pm")
          ? dropSessionQuotaRejection(afterStreaming, message.conversationId, message.sessionId)
          : afterStreaming;
      const view = state.conversations[message.conversationId];
      if (!view) return { ...nextBase, sessions };
      if (
        view.conversation.kind === "worker" &&
        view.messages.length === 0 &&
        view.hasMore &&
        state.older[message.conversationId] !== "loading"
      ) {
        return {
          ...nextBase,
          sessions,
          pending: dropConfirmed(state.pending, [message]),
          retry: dropRetryIfSettled(state.retry, message),
        };
      }
      if (view.hasMore && view.messages.length > 0 && message.id < view.messages[0]!.id) {
        const advanced = advanceWorkerLine(state.conversations, message);
        const conversations = { ...advanced, [message.conversationId]: { ...view, outsideRev: (view.outsideRev ?? 0) + 1 } };
        return { ...nextBase, sessions, conversations, pending: dropConfirmed(state.pending, [message]), retry: dropRetryIfSettled(state.retry, message) };
      }
      const updated = upsertMessage(view.messages, message);
      const trim =
        !state.olderLoaded?.[message.conversationId] &&
        state.older[message.conversationId] !== "loading" &&
        updated.length > MAX_LIVE_MESSAGES;
      const messages = trim ? updated.slice(-MAX_LIVE_MESSAGES) : updated;
      const conversations = advanceWorkerLine(
        {
          ...state.conversations,
          [message.conversationId]: { ...view, messages, hasMore: view.hasMore || trim },
        },
        message,
      );
      return {
        ...nextBase,
        sessions,
        conversations,
        pending: dropConfirmed(state.pending, [message]),
        retry: dropRetryIfSettled(state.retry, message),
      };
    }
    case "session.status":
      return { ...next, sessions: upsertBy(state.sessions, change.data.session, (a, b) => a.sessionId === b.sessionId) };
    case "health.updated":
      return { ...next, health: upsertBy(state.health, change.data.health, (a, b) => a.module === b.module) };
    case "schedule.updated":
      return { ...next, schedules: upsertBy(state.schedules, change.data.schedule, (a, b) => a.id === b.id) };
    case "schedule.removed":
      return { ...next, schedules: state.schedules.filter((x) => x.id !== change.data.scheduleId) };
    case "pm.created":
      return { ...next, pms: upsertBy(state.pms, change.data.pm, (a, b) => a.id === b.id) };
    case "pm.updated": {
      const { pm } = change.data;
      return {
        ...next,
        pms: upsertBy(state.pms, pm, (a, b) => a.id === b.id),
        personaRev: { ...state.personaRev, [pm.id]: (state.personaRev[pm.id] ?? 0) + 1 },
      };
    }
    case "pm.removed": {
      const { pmId } = change.data;
      const removedProjectIds = new Set(state.projects.filter((p) => p.pmId === pmId).map((p) => p.id));
      const conversations = Object.fromEntries(
        Object.entries(state.conversations).filter(([, view]) => view.conversation.pmId !== pmId),
      );
      const routerItems = state.router.items.filter((i) => i.pmId !== pmId);
      const router = routerItems.length === state.router.items.length ? state.router : { ...state.router, items: routerItems };
      const activeTaskGraphs = state.activeTaskGraphs.filter((g) => g.pmId !== pmId);
      return {
        ...next,
        pms: state.pms.filter((p) => p.id !== pmId),
        projects: state.projects.filter((p) => p.pmId !== pmId),
        folders: state.folders.filter((f) => !removedProjectIds.has(f.projectId)),
        conversations,
        schedules: state.schedules.filter((s) => s.pmId !== pmId),
        router,
        activeTaskGraphs: activeTaskGraphs.length === state.activeTaskGraphs.length ? state.activeTaskGraphs : activeTaskGraphs,
      };
    }
    case "project.created":
    case "project.updated":
      return { ...next, projects: upsertBy(state.projects, change.data.project, (a, b) => a.id === b.id) };
    case "folders.updated": {
      const { projectId, folders } = change.data;
      return { ...next, folders: [...state.folders.filter((f) => f.projectId !== projectId), ...folders] };
    }
    case "conversation.created": {
      const { conversation } = change.data;
      if (state.conversations[conversation.id]) return next;
      return {
        ...next,
        conversations: { ...state.conversations, [conversation.id]: { conversation, messages: [], hasMore: false } },
      };
    }
    case "conversation.purged": {
      const { conversationId, purgedAt } = change.data;
      const view = state.conversations[conversationId];
      if (!view) return next;
      const { [conversationId]: _older, ...older } = state.older;
      return {
        ...next,
        conversations: {
          ...state.conversations,
          [conversationId]: { ...view, conversation: { ...view.conversation, purgedAt }, messages: [], hasMore: false },
        },
        ...(state.older[conversationId] !== undefined ? { older } : {}),
      };
    }
    case "session.created":
      return { ...next, sessions: upsertBy(state.sessions, change.data.session, (a, b) => a.sessionId === b.sessionId) };
    case "router.settings.updated":
      return { ...next, router: { ...state.router, settings: change.data.settings } };
    case "router.item.created":
    case "router.item.updated": {
      const { item } = change.data;
      const existingIndex = state.router.items.findIndex((x) => x.id === item.id);
      if (item.kind === "decision") {
        if (item.status !== "pending") {
          if (existingIndex === -1) return next;
          return {
            ...next,
            router: { ...state.router, items: state.router.items.filter((x) => x.id !== item.id) },
          };
        }
        const items =
          existingIndex === -1
            ? capRouterItems([item, ...state.router.items]).items
            : state.router.items.with(existingIndex, item);
        return { ...next, router: { ...state.router, items } };
      }
      if (change.type === "router.item.updated") {
        if (existingIndex === -1) return next;
        return { ...next, router: { ...state.router, items: state.router.items.with(existingIndex, item) } };
      }
      if (existingIndex !== -1) {
        return { ...next, router: { ...state.router, items: state.router.items.with(existingIndex, item) } };
      }
      const capped = capRouterItems([item, ...state.router.items]);
      return {
        ...next,
        router: {
          ...state.router,
          items: capped.items,
          briefingsHasMore: state.router.briefingsHasMore || capped.reportsTrimmed,
        },
      };
    }
    case "router.reports.archived_all": {
      const archived = new Set(change.data.archivedIds);
      let changed = false;
      const items = state.router.items.map((x) => {
        if (x.kind === "report" && archived.has(x.id) && x.status !== "archived") {
          changed = true;
          return { ...x, status: "archived" as const, updatedAt: change.data.updatedAt };
        }
        return x;
      });
      return changed ? { ...next, router: { ...state.router, items } } : next;
    }
    case "router.command.created": {
      const { command } = change.data;
      const existingIndex = state.router.commands.findIndex((c) => c.id === command.id);
      if (existingIndex !== -1) {
        return { ...next, router: { ...state.router, commands: state.router.commands.with(existingIndex, command) } };
      }
      const combined = [command, ...state.router.commands];
      const trimmed = combined.length > ROUTER_STREAM_LIVE_MAX;
      const commands = trimmed ? combined.slice(0, ROUTER_STREAM_LIVE_MAX) : combined;
      return {
        ...next,
        router: {
          ...state.router,
          commands,
          commandsHasMore: state.router.commandsHasMore || trimmed,
        },
      };
    }
    case "router.command.updated": {
      const { command } = change.data;
      const existingIndex = state.router.commands.findIndex((c) => c.id === command.id);
      if (existingIndex === -1) return next;
      return { ...next, router: { ...state.router, commands: state.router.commands.with(existingIndex, command) } };
    }
    case "task_graph.created":
    case "task_graph.updated": {
      const graph = normalizeTaskGraph(change.data.graph);
      const existingIndex = state.activeTaskGraphs.findIndex((g) => g.id === graph.id);
      if (graph.status !== "active") {
        if (existingIndex === -1) return next;
        return {
          ...next,
          activeTaskGraphs: state.activeTaskGraphs.filter((g) => g.id !== graph.id),
        };
      }
      const activeTaskGraphs =
        existingIndex === -1
          ? [graph, ...state.activeTaskGraphs]
          : state.activeTaskGraphs.with(existingIndex, graph);
      return { ...next, activeTaskGraphs };
    }
  }
}

export function referencesUnknownConversation(state: HubState, change: Change): boolean {
  return change.type === "message.created" && !state.conversations[change.data.message.conversationId];
}

function mergeLoaded(state: HubState, lookup: ConversationsLookup): Pick<HubState, "conversations" | "sessions"> {
  let conversations = state.conversations;
  for (const c of lookup.conversations) {
    if (conversations[c.conversation.id]) continue;
    if (conversations === state.conversations) conversations = { ...state.conversations };
    conversations[c.conversation.id] = {
      conversation: c.conversation,
      messages: c.messages,
      hasMore: c.hasMore,
      ...(c.workerLine !== undefined ? { workerLine: c.workerLine } : {}),
      ...(c.workerBranch !== undefined ? { workerBranch: c.workerBranch } : {}),
    };
  }
  const known = new Set(state.sessions.map((s) => s.sessionId));
  const added = lookup.sessions.filter((s) => !known.has(s.sessionId));
  return { conversations, sessions: added.length === 0 ? state.sessions : [...state.sessions, ...added] };
}

function withLookups(
  lookups: HubState["lookups"],
  ids: readonly ConversationId[],
  value: "loading" | "missing" | undefined,
): HubState["lookups"] {
  const next = { ...lookups };
  for (const id of ids) {
    if (value === undefined) delete next[id];
    else next[id] = value;
  }
  if (Object.keys(next).length > MAX_CONVERSATION_LOOKUP_STATES) {
    for (const [id, v] of Object.entries(next)) if (v === "missing") delete next[Number(id)];
  }
  return next;
}

function keepStillFailed(retry: HubState["retry"], messages: Message[]): HubState["retry"] {
  const failed = new Set(messages.filter((m) => m.status === "failed").map((m) => m.id));
  return Object.fromEntries(Object.entries(retry).filter(([id]) => failed.has(Number(id))));
}

function withoutLoadError(state: HubState): HubState {
  const { loadError: _loadError, ...rest } = state;
  return rest;
}

function endedBefore(state: HubState, conversationId: ConversationId): boolean {
  const sessions = state.sessions.filter((s) => s.conversationId === conversationId);
  return sessions.length > 0 && sessions.every((s) => s.status === "ended");
}

// Older remote daemons omit commandsHasMore/briefingsHasMore; assume more pages when the window is non-empty.
function normalizeRouterSlice(router: RouterSlice): RouterSlice {
  const raw = router as Partial<Pick<RouterSlice, "commandsHasMore" | "briefingsHasMore">> & RouterSlice;
  if (typeof raw.commandsHasMore === "boolean" && typeof raw.briefingsHasMore === "boolean") {
    return router;
  }
  return {
    ...router,
    commandsHasMore: raw.commandsHasMore ?? router.commands.length > 0,
    briefingsHasMore: raw.briefingsHasMore ?? router.items.some((x) => x.kind === "report"),
  };
}

function fromSnapshot(state: HubState, snapshot: StateSnapshot): HubState {
  const conversations: Record<ConversationId, ConversationView> = {};
  for (const c of snapshot.conversations) {
    const prev = state.conversations[c.conversation.id];
    const keepLoaded =
      c.messages.length === 0 && c.hasMore && prev !== undefined && prev.messages.length > 0 && endedBefore(state, c.conversation.id);
    const workerLine = c.workerLine !== undefined ? { workerLine: c.workerLine } : {};
    const workerBranch = c.workerBranch !== undefined ? { workerBranch: c.workerBranch } : {};
    conversations[c.conversation.id] = keepLoaded
      ? { conversation: c.conversation, messages: prev.messages, hasMore: prev.hasMore, ...workerLine, ...workerBranch }
      : { conversation: c.conversation, messages: c.messages, hasMore: c.hasMore, ...workerLine, ...workerBranch };
  }
  const all = snapshot.conversations.flatMap((c) => c.messages);
  const base = withoutLoadError(state);
  return {
    ...base,
    phase: "ready",
    seq: snapshot.seq,
    snapshotRev: state.snapshotRev + 1,
    pms: snapshot.pms,
    projects: snapshot.projects,
    folders: snapshot.folders,
    conversations,
    sessions: snapshot.sessions,
    health: snapshot.health,
    schedules: snapshot.schedules,
    router: normalizeRouterSlice(snapshot.router),
    activeTaskGraphs: normalizeTaskGraphs(snapshot.activeTaskGraphs),
    lookups: {},
    server: snapshot.server,
    pending: dropConfirmed(state.pending, all),
    older: {},
    olderLoaded: {},
    retry: keepStillFailed(state.retry, all),
  };
}

export function reducer(state: HubState, action: HubAction): HubState {
  switch (action.type) {
    case "loading":
      return { ...state, phase: "loading" };
    case "loaded":
      return fromSnapshot(state, action.snapshot);
    case "loadFailed": {
      const { loadError: _old, ...rest } = state;
      const phase = action.unauthorized ? "unauthorized" : state.phase === "ready" ? "ready" : "error";
      return { ...rest, phase, ...(phase === "error" && action.error ? { loadError: action.error } : {}) };
    }
    case "change":
      return applyChange(state, action.change);
    case "connection":
      return { ...state, connection: action.status };
    case "olderStart":
      return {
        ...state,
        older: { ...state.older, [action.conversationId]: "loading" },
        olderLoaded: { ...state.olderLoaded, [action.conversationId]: true },
      };
    case "olderFailed":
      return { ...state, older: { ...state.older, [action.conversationId]: "error" } };
    case "olderDone": {
      const view = state.conversations[action.conversationId];
      if (!view || view.conversation.purgedAt !== undefined) return state;
      const known = new Set(view.messages.map((m) => m.id));
      const earlier = action.messages.filter((m) => !known.has(m.id));
      return {
        ...state,
        conversations: {
          ...state.conversations,
          [action.conversationId]: {
            ...view,
            messages: [...earlier, ...view.messages].toSorted((a, b) => a.id - b.id),
            hasMore: action.hasMore,
          },
        },
        older: { ...state.older, [action.conversationId]: undefined },
        olderLoaded: { ...state.olderLoaded, [action.conversationId]: true },
      };
    }
    case "lookupStart":
      return { ...state, lookups: withLookups(state.lookups, action.ids, "loading") };
    case "lookupFailed":
      return { ...state, lookups: withLookups(state.lookups, action.ids, "missing") };
    case "lookupDone": {
      const merged = mergeLoaded(state, action.lookup);
      const found = action.ids.filter((id) => merged.conversations[id] !== undefined);
      const missing = action.ids.filter((id) => merged.conversations[id] === undefined);
      return { ...state, ...merged, lookups: withLookups(withLookups(state.lookups, found, undefined), missing, "missing") };
    }
    case "pendingAdd":
      return {
        ...state,
        sessions: dropSessionQuotaRejection(state.sessions, action.pending.conversationId),
        pending: [...state.pending, action.pending],
      };
    case "retryStart": {
      let retryConvId: ConversationId | null = null;
      for (const view of Object.values(state.conversations)) {
        const m = view.messages.find((x) => x.id === action.messageId);
        if (m) {
          if (m.sender === "user" && !isLedgerWakeup(m)) retryConvId = m.conversationId;
          break;
        }
      }
      const sessions = retryConvId === null ? state.sessions : dropSessionQuotaRejection(state.sessions, retryConvId);
      return { ...state, sessions, retry: { ...state.retry, [action.messageId]: "retrying" } };
    }
    case "retryFailed":
      return { ...state, retry: { ...state.retry, [action.messageId]: "error" } };
    case "pendingPhase":
      return {
        ...state,
        pending: state.pending.map((p) => {
          if (p.clientId !== action.clientId) return p;
          const { failure: _old, reason: _oldReason, ...rest } = p;
          return { ...rest, phase: action.phase, ...(action.failure ? { failure: action.failure } : {}), ...(action.reason ? { reason: action.reason } : {}) };
        }),
      };
    case "pendingRewind": {
      const target = state.pending.find((p) => p.clientId === action.clientId);
      if (!target) return state;
      const key = userMessageDedupeKey(target.conversationId, target.clientId);
      const keys = [...(state.rewoundKeys ?? []).filter((k) => k !== key), key].slice(-MAX_REWOUND_PENDING_KEYS);
      const pending =
        target.attachments.length === 0
          ? state.pending.filter((p) => p.clientId !== action.clientId)
          : state.pending.map((p) => {
              if (p.clientId !== action.clientId) return p;
              const { workerPick: _pick, ...rest } = p;
              return { ...rest, text: "" };
            });
      return { ...state, pending, rewoundKeys: keys, sessions: clearConversationStreaming(state.sessions, target.conversationId) };
    }
    case "messageRewind": {
      const view = state.conversations[action.conversationId];
      if (!view) return state;
      const idx = view.messages.findIndex((m) => m.id === action.messageId);
      if (idx === -1 || isRewoundMessage(view.messages[idx]!)) return state;
      const messages = view.messages.with(idx, withRewoundMeta(view.messages[idx]!));
      return {
        ...state,
        sessions: clearConversationStreaming(state.sessions, action.conversationId),
        conversations: { ...state.conversations, [action.conversationId]: { ...view, messages } },
      };
    }
  }
}

export function oldestMessageId(view: ConversationView): MessageId | null {
  return view.messages[0]?.id ?? null;
}
