export { listConversations, previewText, type ConversationEntry } from "./conversation-list.ts";
export {
  allPendingAsks,
  askingConversations,
  pendingAsks,
  runningWorkerCount,
  sessionOf,
  visibleSessionOf,
  waitingConversations,
  type LastSeen,
  type RouterReminderSummary,
} from "../shared/reminders.ts";
export {
  activeGraphsOf,
  boundWorkerIdsOf,
  isWorkerBound,
  pendingDecisionsOf,
  sortActiveGraphs,
  taskGraphPriority,
  unboundWorkersOf,
  workersByWorkerId,
} from "./task-graph-selectors.ts";
import {
  CHECKLIST_MESSAGE_KIND,
  VENDOR_LIST,
  DEFAULT_AGENT_VENDOR,
  QUOTA_WINDOWS,
  VENDOR_FAILURE_SIGNS,
  EMPTY_TOKEN_USAGE,
  attachmentsOf,
  exhaustRateLimitInfo,
  isHandoverTraffic,
  isRewoundMessage,
  isSilentTriggerMessage,
  isAgentVendor,
  vendorSpec,
  isQuotaExhausted,
  pendingDecisionsOf as devicePendingDecisionsOf,
  systemEventOf,
  unwrapWorkerReportText,
  workerEventOf,
  workerLineText,
  workerReportHeader,
  isWorkerEndLine,
  type AgentVendor,
  type ConversationId,
  type HealthEntry,
  type Message,
  type MessageId,
  type MessageStatus,
  type PendingDecision,
  type TokenUsage,
  type Pm,
  type PmId,
  type Project,
  type ProjectId,
  type QuotaResponse,
  type QuotaWindowKey,
  type RateLimitWindow,
  type SessionState,
  type WorkerId,
  type WorkerMessageMeta,
} from "../shared/index.ts";
import { defaultLookOf, resolvePmLook, type SlimeLook } from "../shared/slimes.ts";
import {
  renewingIn,
  routerReminderSummary,
  sessionOf,
  type RouterReminderSummary,
} from "../shared/reminders.ts";
import { workerStatusOf, type WorkerTone } from "./worker-status.ts";
import type { HubState, PendingMessage } from "./state.ts";

export function isWaitingForQuota(session: SessionState | null, now: number = Date.now()): boolean {
  return isQuotaExhausted(session?.rateLimit, now);
}

const QUOTA_WARNING_PERCENT = 80;

const QUOTA_VENDORS = VENDOR_LIST.flatMap(({ id, quota }) => (quota === undefined ? [] : [{ id, ...quota }]));

export interface QuotaWindowUsage {
  key: string;
  short: string;
  percent: number;
  resetsAt: number | null;
  warning: boolean;
}

export interface QuotaVendor {
  id: string;
  name: string;
  group?: string;
  windows: QuotaWindowUsage[];
  exhausted: boolean;
}

const newerSession = (a: SessionState, b: SessionState | null): boolean =>
  b === null || (a.lastEventAt ?? -1) > (b.lastEventAt ?? -1) || ((a.lastEventAt ?? -1) === (b.lastEventAt ?? -1) && a.sessionId > b.sessionId);

const isReset = (resetsAt: number, now: number): boolean => Number.isFinite(resetsAt) && resetsAt > 0 && resetsAt * 1000 <= now;

function windowUsage(key: QuotaWindowKey, window: RateLimitWindow, now: number, warningStatus: string | undefined): QuotaWindowUsage {
  const { short } = QUOTA_WINDOWS[key];
  if (isReset(window.resetsAt, now)) return { key, short, percent: 0, resetsAt: null, warning: false };
  const percent = Math.round(Math.min(1, Math.max(0, window.utilization)) * 100);
  return {
    key,
    short,
    percent,
    resetsAt: Number.isFinite(window.resetsAt) && window.resetsAt > 0 ? window.resetsAt : null,
    warning: window.status === warningStatus || percent >= QUOTA_WARNING_PERCENT,
  };
}

const REAL_EPOCH_SEC = 1_000_000_000;
const WINDOW_DURATION_TOLERANCE_SEC = 3600;

function isValidQuotaWindow(key: QuotaWindowKey, w: RateLimitWindow | undefined, lastEventAt: number | null, nowMs: number): w is RateLimitWindow {
  if (w === undefined || !Number.isFinite(w.utilization)) return false;
  if (Number.isFinite(w.resetsAt) && w.resetsAt >= REAL_EPOCH_SEC) {
    const maxSpanSec = QUOTA_WINDOWS[key].durationMins * 60 + WINDOW_DURATION_TOLERANCE_SEC;
    if (lastEventAt !== null && lastEventAt >= REAL_EPOCH_SEC * 1000 && w.resetsAt - lastEventAt / 1000 > maxSpanSec) {
      return false;
    }
    if (nowMs >= REAL_EPOCH_SEC * 1000 && w.resetsAt - nowMs / 1000 > maxSpanSec) {
      return false;
    }
  }
  return true;
}

const TURN_STARTED_STATUSES: ReadonlySet<MessageStatus> = new Set(["delivered", "processing", "replied", "failed", "stopped"]);

function sessionQuotaFailureAt(state: HubState, session: SessionState, vendor: AgentVendor): number | null {
  if (session.conversationId === null) return null;
  const quotaPattern = VENDOR_FAILURE_SIGNS[vendor].quota;
  const convView = state.conversations[session.conversationId];
  if (convView) {
    for (let i = convView.messages.length - 1; i >= 0; i--) {
      const m = convView.messages[i]!;
      if (m.sessionId !== session.sessionId || m.status === null || !TURN_STARTED_STATUSES.has(m.status)) continue;
      return m.status === "failed" && typeof m.failureReason === "string" && quotaPattern.test(m.failureReason) ? m.updatedAt : null;
    }
    if (convView.conversation.kind === "worker" && convView.conversation.pmId !== null) {
      const latest = workerLinesOf(state, convView.conversation.pmId).latest.get(session.conversationId);
      const line = latest?.line;
      if (line?.event === "turn_failed" && typeof line.summary === "string" && quotaPattern.test(line.summary)) return latest!.at;
    }
  }
  return null;
}

function sanitizeSessionWindows(
  session: SessionState,
  allowedKeys: readonly QuotaWindowKey[],
  now: number,
): SessionState {
  if (session.rateLimit === null) return session;
  const validWindows: Record<string, RateLimitWindow> = {};
  for (const key of allowedKeys) {
    const w = session.rateLimit.windows[key];
    if (isValidQuotaWindow(key, w, session.lastEventAt, now)) {
      validWindows[key] = w;
    }
  }
  return {
    ...session,
    rateLimit: { ...session.rateLimit, windows: validWindows },
  };
}

function applySessionQuotaFailure(state: HubState, session: SessionState, vendor: AgentVendor): SessionState {
  const rateLimit = session.rateLimit;
  if (rateLimit === null || rateLimit.status === "rejected" || Object.keys(rateLimit.windows).length === 0) return session;
  const failedAt = sessionQuotaFailureAt(state, session, vendor);
  if (failedAt === null) return session;
  const exhausted = exhaustRateLimitInfo(rateLimit);
  const targetEntry = (Object.entries(exhausted.windows) as [QuotaWindowKey, RateLimitWindow][]).find(
    ([k, w]) => w.status === "rejected" && rateLimit.windows[k]?.status !== "rejected",
  );
  if (!targetEntry) return session;
  const [targetKey, targetWin] = targetEntry;
  const durationSec = QUOTA_WINDOWS[targetKey].durationMins * 60;
  const failedSec = failedAt / 1000;
  if (targetWin.resetsAt > 0 && failedSec >= targetWin.resetsAt - durationSec && failedSec <= targetWin.resetsAt) {
    return { ...session, rateLimit: exhausted };
  }
  return session;
}

// Do not compare lastEventAt: closing sessions refresh it and would let a pre-reset value override a post-reset one.
const newerWindow = (a: SessionState, b: SessionState | null, key: string): boolean => {
  if (b === null) return true;
  const wa = a.rateLimit!.windows[key]!;
  const wb = b.rateLimit!.windows[key]!;
  if (wa.resetsAt !== wb.resetsAt) return wa.resetsAt > wb.resetsAt;
  if (wa.utilization !== wb.utilization) return wa.utilization > wb.utilization;
  return newerSession(a, b);
};

const quotaUsageCache = new WeakMap<
  HubState["conversations"],
  WeakMap<HubState["sessions"], { json: string; value: QuotaVendor[] }>
>();
// Keep the last result so unrelated session updates return the same array reference.
let lastQuotaUsage: { json: string; value: QuotaVendor[] } | null = null;
const NO_QUOTA_VENDORS: QuotaVendor[] = [];
const sessionsWithQuotaCache = new WeakMap<HubState["sessions"], SessionState[]>();

function quotaSessionsOf(sessions: HubState["sessions"]): SessionState[] {
  let list = sessionsWithQuotaCache.get(sessions);
  if (list === undefined) {
    list = [];
    for (const s of sessions) if (s.rateLimit !== null) list.push(s);
    sessionsWithQuotaCache.set(sessions, list);
  }
  return list;
}

let lastQuotaFast: {
  conversations: HubState["conversations"];
  quotaSessions: SessionState[];
  minNowMs: number;
  maxNowMs: number;
  value: QuotaVendor[];
} | null = null;

export function quotaUsage(state: HubState, now: number = Date.now()): QuotaVendor[] {
  const quotaSessions = quotaSessionsOf(state.sessions);
  if (quotaSessions.length === 0) return NO_QUOTA_VENDORS;
  if (
    lastQuotaFast !== null &&
    lastQuotaFast.conversations === state.conversations &&
    lastQuotaFast.quotaSessions.length === quotaSessions.length &&
    quotaSessions.every((s, i) => s === lastQuotaFast!.quotaSessions[i]) &&
    now >= lastQuotaFast.minNowMs &&
    now < lastQuotaFast.maxNowMs
  ) {
    return lastQuotaFast.value;
  }
  let minNowMs = Number.NEGATIVE_INFINITY;
  let maxNowMs = Number.POSITIVE_INFINITY;
  const boundNowMs = (thresholdMs: number) => {
    if (thresholdMs <= now) minNowMs = Math.max(minNowMs, thresholdMs);
    else maxNowMs = Math.min(maxNowMs, thresholdMs);
  };
  const vendors: QuotaVendor[] = [];
  for (const spec of QUOTA_VENDORS) {
    const windows: QuotaWindowUsage[] = [];
    const pickedRawWindows: RateLimitWindow[] = [];
    const sessions = quotaSessions
      .filter((s) => (s.vendor ?? DEFAULT_AGENT_VENDOR) === spec.id)
      .map((s) => {
        if (s.rateLimit !== null) {
          if (s.rateLimit.resetsAt !== null && Number.isFinite(s.rateLimit.resetsAt) && s.rateLimit.resetsAt > 0) {
            boundNowMs(s.rateLimit.resetsAt * 1000);
          }
          for (const key of spec.windows) {
            const w = s.rateLimit.windows[key];
            if (w === undefined || !Number.isFinite(w.utilization) || !Number.isFinite(w.resetsAt)) continue;
            if (w.resetsAt > 0) boundNowMs(w.resetsAt * 1000);
            if (w.resetsAt >= REAL_EPOCH_SEC) {
              const maxSpanSec = QUOTA_WINDOWS[key].durationMins * 60 + WINDOW_DURATION_TOLERANCE_SEC;
              boundNowMs(REAL_EPOCH_SEC * 1000);
              boundNowMs((w.resetsAt - maxSpanSec) * 1000);
            }
          }
        }
        return sanitizeSessionWindows(s, spec.windows, now);
      });
    let latestIdx = -1;
    let latestWithWindows: SessionState | null = null;
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i]!;
      if (s.rateLimit !== null && Object.keys(s.rateLimit.windows).length > 0 && newerSession(s, latestWithWindows)) {
        latestWithWindows = s;
        latestIdx = i;
      }
    }
    if (latestWithWindows === null) continue;
    latestWithWindows = applySessionQuotaFailure(state, latestWithWindows, spec.id);
    sessions[latestIdx] = latestWithWindows;
    const activeKeys = spec.windows.filter((key) => latestWithWindows!.rateLimit!.windows[key] !== undefined);
    for (const key of activeKeys) {
      let best: SessionState | null = null;
      for (const s of sessions) {
        const w = s.rateLimit?.windows[key];
        if (w !== undefined && Number.isFinite(w.utilization) && newerWindow(s, best, key)) best = s;
      }
      const window = best?.rateLimit?.windows[key];
      if (window === undefined) continue;
      pickedRawWindows.push(window);
      windows.push(windowUsage(key, window, now, spec.warningStatus));
    }
    if (windows.length === 0) continue;
    let latest: SessionState | null = null;
    for (const s of sessions) if (s.rateLimit !== null && newerSession(s, latest)) latest = s;
    const exhausted =
      isQuotaExhausted(latest?.rateLimit, now) || pickedRawWindows.some((w) => !isReset(w.resetsAt, now) && w.status === "rejected");
    vendors.push({ id: spec.id, name: spec.name, windows, exhausted });
  }
  const json = JSON.stringify(vendors);
  let bySessions = quotaUsageCache.get(state.conversations);
  if (bySessions === undefined) {
    bySessions = new WeakMap();
    quotaUsageCache.set(state.conversations, bySessions);
  }
  const prev = bySessions.get(state.sessions);
  if (prev !== undefined && prev.json === json) {
    lastQuotaFast = { conversations: state.conversations, quotaSessions, minNowMs, maxNowMs, value: prev.value };
    return prev.value;
  }
  const value = lastQuotaUsage !== null && lastQuotaUsage.json === json ? lastQuotaUsage.value : vendors;
  lastQuotaUsage = { json, value };
  bySessions.set(state.sessions, lastQuotaUsage);
  lastQuotaFast = { conversations: state.conversations, quotaSessions, minNowMs, maxNowMs, value };
  return value;
}

function legacyFetchedQuota(id: string): (typeof QUOTA_VENDORS)[number] | undefined {
  const owners = QUOTA_VENDORS.filter((v) => v.fetched?.groups.some((g) => g.key === id));
  return owners.length === 1 ? owners[0] : undefined;
}

export function fetchedQuotaUsage(res: QuotaResponse, now: number = Date.now(), current = false): QuotaVendor[] {
  const blocks: QuotaVendor[] = [];
  for (const group of res.groups) {
    const quota = group.vendor === undefined ? legacyFetchedQuota(group.id) : isAgentVendor(group.vendor) ? vendorSpec(group.vendor).quota : undefined;
    const name = quota?.fetched?.groups.find((g) => g.key === group.id)?.name;
    if (quota === undefined || (name === undefined && !(current && group.id === group.vendor && quota.fetched === undefined))) continue;
    let exhausted = false;
    const windows = quota.windows.flatMap((key) => {
      const window = group.windows[key];
      if (window === undefined || !Number.isFinite(window.utilization) || (current && isReset(window.resetsAt, now))) return [];
      const usage = windowUsage(key, window, now, quota.warningStatus);
      exhausted ||= usage.percent >= 100 || (current && window.status === "rejected");
      return [usage];
    });
    if (windows.length > 0) blocks.push({ id: group.id, name: quota.name, group: name, windows, exhausted });
  }
  return blocks;
}

const fetchedQuotaSessionCache = new WeakMap<HubState["sessions"], boolean>();

export function hasFetchedQuotaSession(state: HubState): boolean {
  const cached = fetchedQuotaSessionCache.get(state.sessions);
  if (cached !== undefined) return cached;
  const result = state.sessions.some((s) => {
    const vendor = s.vendor ?? DEFAULT_AGENT_VENDOR;
    return isAgentVendor(vendor) && vendorSpec(vendor).quota?.fetched !== undefined;
  });
  fetchedQuotaSessionCache.set(state.sessions, result);
  return result;
}

const quotaResetTimesCache = new WeakMap<HubState["sessions"], number[]>();
const NO_RESET_TIMES: number[] = [];
let lastQuotaResetTimes: number[] = NO_RESET_TIMES;

export function quotaResetTimes(state: HubState): number[] {
  const hit = quotaResetTimesCache.get(state.sessions);
  if (hit !== undefined) return hit;
  const quotaSessions = quotaSessionsOf(state.sessions);
  if (quotaSessions.length === 0) {
    quotaResetTimesCache.set(state.sessions, NO_RESET_TIMES);
    return NO_RESET_TIMES;
  }
  const times = new Set<number>();
  for (const { rateLimit } of quotaSessions) {
    if (rateLimit === null) continue;
    for (const w of Object.values(rateLimit.windows)) if (Number.isFinite(w.resetsAt) && w.resetsAt > 0) times.add(w.resetsAt * 1000);
    if (rateLimit.resetsAt !== null && Number.isFinite(rateLimit.resetsAt) && rateLimit.resetsAt > 0) times.add(rateLimit.resetsAt * 1000);
  }
  const sorted = times.size === 0 ? NO_RESET_TIMES : [...times].sort((a, b) => a - b);
  const value =
    sorted.length === lastQuotaResetTimes.length && sorted.every((t, i) => t === lastQuotaResetTimes[i])
      ? lastQuotaResetTimes
      : sorted;
  lastQuotaResetTimes = value;
  quotaResetTimesCache.set(state.sessions, value);
  return value;
}

export type WorkerPhase = "preparing" | "open" | "ended";

export interface WorkerOutcome {
  id: MessageId;
  at: number;
  line: WorkerMessageMeta;
  reportBody: string | null;
}

const OUTCOME_WORKER_EVENTS: ReadonlySet<WorkerMessageMeta["event"]> = new Set(["report", "turn_failed", "worktree_failed"]);

function extractWorkerReportBody(line: WorkerMessageMeta, text: string): string | null {
  if (line.event !== "report") return null;
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === workerReportHeader(line.workerId, line.title) || trimmed === workerLineText(line)) return null;
  const unwrapped = unwrapWorkerReportText({ id: line.workerId, title: line.title }, text).trim();
  return unwrapped === "" ? null : unwrapped;
}

interface WorkerLine {
  id: MessageId;
  at: number;
  line: WorkerMessageMeta;
}

interface WorkerLineIndex {
  latest: ReadonlyMap<ConversationId, WorkerLine>;
  endedAt: ReadonlyMap<ConversationId, number>;
  outcomes: ReadonlyMap<ConversationId, readonly WorkerOutcome[]>;
}

const pmWorkerIndexCache = new WeakMap<readonly Message[], WorkerLineIndex>();

function pmWorkerIndexOf(messages: readonly Message[]): WorkerLineIndex {
  let cached = pmWorkerIndexCache.get(messages);
  if (cached !== undefined) return cached;
  const latest = new Map<ConversationId, WorkerLine>();
  const endedAt = new Map<ConversationId, number>();
  const outcomes = new Map<ConversationId, WorkerOutcome[]>();
  for (const message of messages) {
    const line = workerEventOf(message);
    if (!line) continue;
    latest.set(line.workerConversationId, { id: message.id, at: message.createdAt, line });
    if (isWorkerEndLine(line)) endedAt.set(line.workerConversationId, Math.max(endedAt.get(line.workerConversationId) ?? 0, message.createdAt));
    if (OUTCOME_WORKER_EVENTS.has(line.event)) {
      let list = outcomes.get(line.workerConversationId);
      if (list === undefined) {
        list = [];
        outcomes.set(line.workerConversationId, list);
      }
      list.push({ id: message.id, at: message.createdAt, line, reportBody: extractWorkerReportBody(line, message.text) });
    }
  }
  cached = { latest, endedAt, outcomes };
  pmWorkerIndexCache.set(messages, cached);
  return cached;
}

const workerLinesCache = new WeakMap<HubState["conversations"], Map<PmId, WorkerLineIndex>>();

function mergeOutcomes(
  existing: readonly WorkerOutcome[] | undefined,
  extra: readonly WorkerOutcome[],
): readonly WorkerOutcome[] {
  if (existing === undefined) return extra;
  const seen = new Set(existing.map((o) => o.id));
  const added = extra.filter((o) => !seen.has(o.id));
  if (added.length === 0) return existing;
  return [...existing, ...added].toSorted((a, b) => a.id - b.id);
}

function workerLinesOf(state: HubState, pmId: PmId): WorkerLineIndex {
  let byPm = workerLinesCache.get(state.conversations);
  if (byPm === undefined) {
    byPm = new Map();
    workerLinesCache.set(state.conversations, byPm);
  }
  const hit = byPm.get(pmId);
  if (hit !== undefined) return hit;
  const latest = new Map<ConversationId, WorkerLine>();
  const endedAt = new Map<ConversationId, number>();
  const outcomes = new Map<ConversationId, readonly WorkerOutcome[]>();
  const snapshotOutcomes = new Map<ConversationId, WorkerOutcome>();
  const views = Object.values(state.conversations).filter((v) => v.conversation.pmId === pmId);
  for (const { conversation, workerLine } of views) {
    if (conversation.kind !== "worker" || workerLine === undefined) continue;
    latest.set(conversation.id, { id: workerLine.messageId, at: workerLine.at, line: workerLine.line });
    if (workerLine.endedAt !== null) endedAt.set(conversation.id, workerLine.endedAt);
    if (OUTCOME_WORKER_EVENTS.has(workerLine.line.event)) {
      snapshotOutcomes.set(conversation.id, { id: workerLine.messageId, at: workerLine.at, line: workerLine.line, reportBody: null });
    }
  }
  for (const { conversation, messages } of views) {
    if (conversation.kind === "worker") continue;
    const index = pmWorkerIndexOf(messages);
    for (const [id, line] of index.latest) {
      if ((latest.get(id)?.id ?? -1) <= line.id) latest.set(id, line);
    }
    for (const [id, at] of index.endedAt) endedAt.set(id, Math.max(endedAt.get(id) ?? 0, at));
    for (const [id, list] of index.outcomes) outcomes.set(id, mergeOutcomes(outcomes.get(id), list));
  }
  for (const [id, fallback] of snapshotOutcomes) {
    outcomes.set(id, mergeOutcomes(outcomes.get(id), [fallback]));
  }
  const result = { latest, endedAt, outcomes };
  byPm.set(pmId, result);
  return result;
}

const NO_ENDED: ReadonlyMap<ConversationId, number> = new Map();

const toneOf = (latest: WorkerLine | undefined): WorkerTone => (latest === undefined ? "neutral" : workerStatusOf(latest.line).tone);

function phaseOf(
  state: HubState,
  workerConversationId: ConversationId,
  endedLines: ReadonlyMap<ConversationId, number>,
  session: SessionState | null = sessionOf(state, workerConversationId),
): WorkerPhase {
  const view = state.conversations[workerConversationId];
  if (endedLines.has(workerConversationId) || session?.status === "ended" || view?.conversation.purgedAt !== undefined) return "ended";
  if (session?.activity === "preparing") return "preparing";
  const task = view?.hasMore === false ? view.messages[0] : undefined;
  return task?.sender === "pm" && task.status === "queued" ? "preparing" : "open";
}

export function workerPhaseOf(state: HubState, workerConversationId: ConversationId): WorkerPhase {
  const pmId = state.conversations[workerConversationId]?.conversation.pmId ?? null;
  return phaseOf(state, workerConversationId, pmId === null ? NO_ENDED : workerLinesOf(state, pmId).endedAt);
}

export interface WorkerEntry {
  conversationId: ConversationId;
  workerId?: WorkerId;
  title: string;
  activity: string;
  ended: boolean;
  vendor?: string;
  model?: string | null;
  effort?: string | null;
  usage: TokenUsage;
  tone: WorkerTone;
}

interface CachedPmWorkers {
  conversations: HubState["conversations"];
  sessionsByWorker: (SessionState | null)[];
  entries: WorkerEntry[];
}

const workersCache = new WeakMap<HubState["conversations"], WeakMap<HubState["sessions"], Map<PmId, WorkerEntry[]>>>();
const MAX_CACHED_PM_WORKERS = 64;
const lastWorkersByPm = new Map<PmId, CachedPmWorkers>();

function sameUsage(a: TokenUsage, b: TokenUsage): boolean {
  return (
    a === b ||
    (a.input === b.input &&
      a.output === b.output &&
      a.cacheRead === b.cacheRead &&
      a.cacheWrite === b.cacheWrite &&
      a.context === b.context)
  );
}

function sameWorkerSessionFields(a: SessionState | null, b: SessionState | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.status === b.status &&
    a.activity === b.activity &&
    a.vendor === b.vendor &&
    a.model === b.model &&
    a.effort === b.effort &&
    sameUsage(a.usage ?? EMPTY_TOKEN_USAGE, b.usage ?? EMPTY_TOKEN_USAGE)
  );
}

function sameWorkerEntry(a: WorkerEntry, b: WorkerEntry): boolean {
  return (
    a.conversationId === b.conversationId &&
    a.workerId === b.workerId &&
    a.title === b.title &&
    a.activity === b.activity &&
    a.ended === b.ended &&
    a.vendor === b.vendor &&
    a.model === b.model &&
    a.effort === b.effort &&
    a.tone === b.tone &&
    sameUsage(a.usage ?? EMPTY_TOKEN_USAGE, b.usage ?? EMPTY_TOKEN_USAGE)
  );
}

export function workersOf(state: HubState, pmId: PmId): WorkerEntry[] {
  let bySessions = workersCache.get(state.conversations);
  if (bySessions === undefined) {
    bySessions = new WeakMap();
    workersCache.set(state.conversations, bySessions);
  }
  let byPm = bySessions.get(state.sessions);
  if (byPm === undefined) {
    byPm = new Map();
    bySessions.set(state.sessions, byPm);
  }
  let entries = byPm.get(pmId);
  if (entries === undefined) {
    const workerConvs = workerConvsForPm(state.conversations, pmId);
    const sessionsByWorker = workerConvs.map((v) => sessionOf(state, v.conversation.id));
    const prev = lastWorkersByPm.get(pmId);
    if (
      prev !== undefined &&
      prev.conversations === state.conversations &&
      prev.sessionsByWorker.length === sessionsByWorker.length &&
      sessionsByWorker.every((s, i) => sameWorkerSessionFields(s, prev.sessionsByWorker[i]!))
    ) {
      entries = prev.entries;
      byPm.set(pmId, entries);
      return entries;
    }
    const computed = computeWorkers(state, pmId);
    entries = prev !== undefined && prev.entries.length === computed.length && computed.every((w, i) => sameWorkerEntry(w, prev.entries[i]!))
      ? prev.entries
      : computed;
    if (!lastWorkersByPm.has(pmId) && lastWorkersByPm.size >= MAX_CACHED_PM_WORKERS) {
      const oldest = lastWorkersByPm.keys().next().value;
      if (oldest !== undefined) lastWorkersByPm.delete(oldest);
    }
    lastWorkersByPm.set(pmId, { conversations: state.conversations, sessionsByWorker, entries });
    byPm.set(pmId, entries);
  }
  return entries;
}

const workerConvsByPmCache = new WeakMap<HubState["conversations"], Map<PmId, HubState["conversations"][ConversationId][]>>();

function workerConvsForPm(conversations: HubState["conversations"], pmId: PmId): HubState["conversations"][ConversationId][] {
  let byPm = workerConvsByPmCache.get(conversations);
  if (byPm === undefined) {
    byPm = new Map();
    for (const view of Object.values(conversations)) {
      if (view.conversation.kind !== "worker" || view.conversation.pmId === null) continue;
      let list = byPm.get(view.conversation.pmId);
      if (list === undefined) {
        list = [];
        byPm.set(view.conversation.pmId, list);
      }
      list.push(view);
    }
    workerConvsByPmCache.set(conversations, byPm);
  }
  return byPm.get(pmId) ?? [];
}

function computeWorkers(state: HubState, pmId: PmId): WorkerEntry[] {
  const { latest, endedAt: endedLines } = workerLinesOf(state, pmId);
  return workerConvsForPm(state.conversations, pmId)
    .map(({ conversation, messages }) => {
      const session = sessionOf(state, conversation.id);
      const latestEntry = latest.get(conversation.id);
      const workerId = latestEntry?.line.workerId ?? messages[0]?.workerId ?? undefined;
      return {
        conversationId: conversation.id,
        ...(workerId !== undefined ? { workerId } : {}),
        title: conversation.title,
        activity: session?.activity ?? "idle",
        ended: phaseOf(state, conversation.id, endedLines, session) === "ended",
        vendor: session?.vendor,
        model: session?.model,
        effort: session?.effort,
        usage: session?.usage ?? EMPTY_TOKEN_USAGE,
        tone: toneOf(latestEntry),
      };
    })
    .toSorted((a, b) => {
      if (a.ended !== b.ended) return Number(a.ended) - Number(b.ended);
      if (!a.ended) return a.conversationId - b.conversationId;
      const at = endedLines.get(a.conversationId);
      const bt = endedLines.get(b.conversationId);
      if (at !== undefined && bt !== undefined && at !== bt) return bt - at;
      if ((at === undefined) !== (bt === undefined)) return at === undefined ? 1 : -1;
      return b.conversationId - a.conversationId;
    });
}

export function workerLineOf(state: HubState, workerConversationId: ConversationId): WorkerMessageMeta | null {
  const pmId = state.conversations[workerConversationId]?.conversation.pmId;
  if (pmId == null) return null;
  return workerLinesOf(state, pmId).latest.get(workerConversationId)?.line ?? null;
}

const NO_WORKER_OUTCOMES: readonly WorkerOutcome[] = [];

export function workerOutcomesOf(state: HubState, workerConversationId: ConversationId): readonly WorkerOutcome[] {
  const pmId = state.conversations[workerConversationId]?.conversation.pmId;
  if (pmId == null) return NO_WORKER_OUTCOMES;
  return workerLinesOf(state, pmId).outcomes.get(workerConversationId) ?? NO_WORKER_OUTCOMES;
}

const NO_PENDING: PendingMessage[] = [];
const pendingByConversationCache = new WeakMap<readonly PendingMessage[], Map<ConversationId, PendingMessage[]>>();

export function pendingOf(state: HubState, conversationId: ConversationId): PendingMessage[] {
  if (state.pending.length === 0) return NO_PENDING;
  let byConv = pendingByConversationCache.get(state.pending);
  if (byConv === undefined) {
    byConv = new Map();
    pendingByConversationCache.set(state.pending, byConv);
  }
  let cached = byConv.get(conversationId);
  if (cached !== undefined) return cached;
  const filtered = state.pending.filter((p) => p.conversationId === conversationId);
  cached = filtered.length === 0 ? NO_PENDING : filtered;
  byConv.set(conversationId, cached);
  return cached;
}

export function isRenewing(state: HubState, conversationId: ConversationId): boolean {
  return renewingIn(state.conversations[conversationId]?.messages ?? []);
}

// Routine Worker start and end lines carry no status or summary; Pieces and the Task Graph show that state instead.
function hiddenFromChat(message: Message): boolean {
  if (isSilentTriggerMessage(message)) return true;
  const event = workerEventOf(message)?.event;
  return event === "started" || event === "ended";
}

export function visibleMessages(messages: Message[]): Message[] {
  const filtered = messages.some(hiddenFromChat) ? messages.filter((m) => !hiddenFromChat(m)) : messages;
  if (!renewingIn(filtered)) return filtered;
  return filtered.map((m) => (m.sender === "user" && m.status === "queued" ? { ...m, status: "delivered" } : m));
}

export function failingHealth(state: HubState): HealthEntry[] {
  return state.health.filter((h) => h.lastError !== null);
}

export type RenderItem =
  | { kind: "message"; message: Message }
  | { kind: "turn"; key: string; work: Message[]; checklists: Message[]; parts: Message[]; startedAt: number; endedAt: number };

type FlowRole =
  | "input"
  | "silent_input"
  | "divider"
  | "agent"
  | "work"
  | "notice";

const INPUT_WORKER_EVENTS: ReadonlySet<WorkerMessageMeta["event"]> = new Set(["report", "turn_failed", "worktree_failed", "user_message"]);
const INPUT_SYSTEM_EVENTS: ReadonlySet<string> = new Set(["schedule.run"]);
const WORK_SYSTEM_EVENTS: ReadonlySet<string> = new Set(["schedule.created", "schedule.removed"]);

function flowRole(message: Message): FlowRole {
  if (isSilentTriggerMessage(message) || (isRewoundMessage(message) && attachmentsOf(message).length === 0)) return "silent_input";
  const line = workerEventOf(message);
  if (line) return INPUT_WORKER_EVENTS.has(line.event) ? "input" : "work";
  if (message.sender === "user" || message.sender === "pm") return "input";
  if (message.sender === "agent") return "agent";
  const event = systemEventOf(message)?.event;
  if (event === "session.renewed") return "divider";
  if (event !== undefined && INPUT_SYSTEM_EVENTS.has(event)) return "input";
  if (event !== undefined && WORK_SYSTEM_EVENTS.has(event)) return "work";
  return "notice";
}

function placeHandovers(all: Message[]): Message[] {
  const shown = all.filter((m) => !isHandoverTraffic(m));
  const dividers = shown.filter((m) => systemEventOf(m)?.event === "session.renewed");
  if (dividers.length === 0) return shown;
  const isDivider = new Set(dividers);
  let rest = shown.filter((m) => !isDivider.has(m));
  for (const divider of dividers) {
    const { sessionId, turnStartId } = divider.meta as { sessionId: number; turnStartId?: number };
    const after = turnStartId ?? divider.id;
    const held = new Set(rest.filter((m) => m.id <= after && m.sessionId === sessionId));
    if (held.size > 0) rest = rest.filter((m) => !held.has(m));
    const at = rest.findIndex((m) => m.id > after && !isDivider.has(m));
    rest.splice(at === -1 ? rest.length : at, 0, divider, ...held);
  }
  return rest;
}

interface GroupedMessages {
  items: RenderItem[];
  tailTurnKey: string | null;
}

const groupMessagesCache = new WeakMap<readonly Message[], GroupedMessages>();

export function groupMessages(all: Message[]): GroupedMessages {
  const hit = groupMessagesCache.get(all);
  if (hit !== undefined) return hit;
  const messages = placeHandovers(all);
  const items: RenderItem[] = [];
  let turn: Extract<RenderItem, { kind: "turn" }> | null = null;
  let lastInputAt: number | null = null;
  let lastAgentAt: number | null = null;

  const close = () => {
    if (turn === null) return;
    const trailing: Message[] = [];
    while (turn.parts.length > 0 && turn.parts.at(-1)!.sender !== "agent") trailing.unshift(turn.parts.pop()!);
    for (const message of trailing) items.push({ kind: "message", message });
    turn = null;
  };

  for (const message of messages) {
    const role = flowRole(message);
    if (role === "silent_input") {
      close();
      lastInputAt = message.createdAt;
      continue;
    }
    if (role === "divider") {
      close();
      items.push({ kind: "message", message });
      continue;
    }
    if (role === "input") {
      close();
      items.push({ kind: "message", message });
      lastInputAt = message.createdAt;
      continue;
    }
    if (role === "agent" && turn === null) {
      const starts = [lastInputAt, lastAgentAt].filter((t): t is number => t !== null);
      turn = { kind: "turn", key: `turn-${message.id}`, work: [], checklists: [], parts: [], startedAt: starts.length > 0 ? Math.max(...starts) : message.createdAt, endedAt: message.createdAt };
      items.push(turn);
    }
    if (turn === null) {
      items.push({ kind: "message", message });
      continue;
    }
    if (role === "notice") {
      turn.parts.push(message);
      continue;
    }
    if (message.kind === CHECKLIST_MESSAGE_KIND) turn.checklists.push(message);
    else if (message.kind === "tool" || role === "work") turn.work.push(message);
    else turn.parts.push(message);
    turn.endedAt = message.createdAt;
    lastAgentAt = message.createdAt;
  }
  const grouped = { items, tailTurnKey: turn?.key ?? null };
  close();
  groupMessagesCache.set(all, grouped);
  return grouped;
}

export interface DeviceRouterView {
  decisions: PendingDecision[];
}

const deviceRouterViewCache = new WeakMap<readonly PendingDecision[], DeviceRouterView>();

export function deviceRouterView(state: HubState, deviceId = "local"): DeviceRouterView {
  const decisions = devicePendingDecisionsOf(state, deviceId);
  let cached = deviceRouterViewCache.get(decisions);
  if (!cached) {
    cached = { decisions };
    deviceRouterViewCache.set(decisions, cached);
  }
  return cached;
}

export interface FleetRouterDeviceInput {
  id: string;
  key?: string;
  name: string;
  self: boolean;
  online: boolean;
  state: HubState;
}

export interface FleetDecisionEntry {
  decision: PendingDecision;
  deviceKey: string;
  deviceId: string;
  deviceName: string;
  self: boolean;
  online: boolean;
  look: SlimeLook;
}

export interface RouterTargetCandidate {
  key: string;
  deviceKey: string;
  deviceId: string;
  deviceName: string;
  self: boolean;
  online: boolean;
  pmId: PmId;
  pmName: string;
  projectId: ProjectId | null;
  projectName: string | null;
  conversationId: ConversationId;
  look: SlimeLook;
  label: string;
}

export interface FleetRouterView {
  decisions: FleetDecisionEntry[];
  targets: RouterTargetCandidate[];
  summary: RouterReminderSummary;
  multiDevice: boolean;
  lookOf: (deviceKey: string, pmId: PmId) => SlimeLook;
}

const EMPTY_DEVICE_ROUTER_VIEW: DeviceRouterView = { decisions: [] };
const pmConversationSigCache = new WeakMap<HubState["conversations"], string>();

function pmConversationSignature(conversations: HubState["conversations"]): string {
  const hit = pmConversationSigCache.get(conversations);
  if (hit !== undefined) return hit;
  const parts: string[] = [];
  for (const { conversation } of Object.values(conversations)) {
    if (conversation.kind === "worker") continue;
    parts.push(`${conversation.id}:${conversation.pmId ?? ""}:${conversation.projectId ?? ""}`);
  }
  parts.sort();
  const sig = parts.join("|");
  pmConversationSigCache.set(conversations, sig);
  return sig;
}

interface FleetDeviceFingerprint {
  id: string;
  key: string;
  name: string;
  self: boolean;
  online: boolean;
  phase: HubState["phase"];
  decisions: readonly PendingDecision[];
  items: HubState["router"]["items"];
  pms: readonly Pm[];
  projects: readonly Project[];
  pmConvSig: string;
}

let lastFleetMemo: { deps: FleetDeviceFingerprint[]; value: FleetRouterView } | null = null;

export function fleetRouterView(devices: readonly FleetRouterDeviceInput[]): FleetRouterView {
  const deps: FleetDeviceFingerprint[] = devices.map((d) => {
    const logicalId = d.self ? "local" : d.id;
    const view = d.state.phase === "ready" ? deviceRouterView(d.state, logicalId) : EMPTY_DEVICE_ROUTER_VIEW;
    return {
      id: d.id,
      key: d.key ?? (d.self ? "" : d.id),
      name: d.name,
      self: d.self,
      online: d.online,
      phase: d.state.phase,
      decisions: view.decisions,
      items: d.state.router.items,
      pms: d.state.pms,
      projects: d.state.projects,
      pmConvSig: pmConversationSignature(d.state.conversations),
    };
  });

  if (
    lastFleetMemo !== null &&
    lastFleetMemo.deps.length === deps.length &&
    deps.every((cur, idx) => {
      const prev = lastFleetMemo!.deps[idx]!;
      return (
        prev.id === cur.id &&
        prev.key === cur.key &&
        prev.name === cur.name &&
        prev.self === cur.self &&
        prev.online === cur.online &&
        prev.phase === cur.phase &&
        prev.decisions === cur.decisions &&
        prev.items === cur.items &&
        prev.pms === cur.pms &&
        prev.projects === cur.projects &&
        prev.pmConvSig === cur.pmConvSig
      );
    })
  ) {
    return lastFleetMemo.value;
  }

  const decisions: FleetDecisionEntry[] = [];
  const targets: RouterTargetCandidate[] = [];

  for (let i = 0; i < devices.length; i++) {
    const d = devices[i]!;
    const fp = deps[i]!;
    if (d.state.phase !== "ready") continue;

    const pmById = new Map<PmId, Pm>();
    for (const pm of d.state.pms) pmById.set(pm.id, pm);
    for (const dec of fp.decisions) {
      decisions.push({
        decision: dec,
        deviceKey: fp.key,
        deviceId: d.self ? "local" : d.id,
        deviceName: d.name,
        self: d.self,
        online: d.online,
        look: lookOfPm(pmById.get(dec.pmId), dec.pmId),
      });
    }

    for (const { conversation } of Object.values(d.state.conversations)) {
      if (conversation.kind === "worker" || conversation.pmId === null) continue;
      const pm = pmById.get(conversation.pmId);
      if (!pm || pm.archivedAt != null) continue;
      const proj = d.state.projects.find((p) => p.conversationId === conversation.id) ?? null;
      targets.push({
        key: `${fp.key || "local"}:${conversation.id}`,
        deviceKey: fp.key,
        deviceId: d.self ? "local" : d.id,
        deviceName: d.name,
        self: d.self,
        online: d.online,
        pmId: pm.id,
        pmName: pm.name,
        projectId: proj?.id ?? null,
        projectName: proj?.name ?? null,
        conversationId: conversation.id,
        look: resolvePmLook(pm),
        label: proj?.name ?? pm.name,
      });
    }
  }

  decisions.sort((a, b) => b.decision.createdAt - a.decision.createdAt || a.decision.key.localeCompare(b.decision.key));

  const summary = routerReminderSummary(
    devices
      .filter((d) => d.state.phase === "ready")
      .map((d) => ({ deviceId: d.self ? "local" : d.id, state: d.state })),
  );

  const looks = new Map<string, SlimeLook>();
  for (let i = 0; i < devices.length; i++) {
    for (const pm of devices[i]!.state.pms) looks.set(`${deps[i]!.key}:${pm.id}`, resolvePmLook(pm));
  }
  const value: FleetRouterView = {
    decisions,
    targets,
    summary,
    multiDevice: devices.length > 1,
    lookOf: (deviceKey, pmId) => looks.get(`${deviceKey}:${pmId}`) ?? defaultLookOf(pmId),
  };
  lastFleetMemo = { deps, value };
  return value;
}

const lookOfPm = (pm: Pm | undefined, pmId: PmId): SlimeLook => (pm === undefined ? defaultLookOf(pmId) : resolvePmLook(pm));
