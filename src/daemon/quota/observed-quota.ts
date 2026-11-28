import { redactSecrets } from "../ledger/redact.ts";
import type { Db } from "../store/db.ts";
import { LRUCache } from "lru-cache";
import type { QuotaResponse } from "../../shared/api.ts";
import { isQuotaExhausted, truncateChars, type RateLimitInfo, type RateLimitWindow } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import type { HubVendorQuota } from "../../shared/hub.ts";
import { MAX_QUOTA_REASON_CHARS, OBSERVED_QUOTA_CACHE_MAX, OBSERVED_QUOTA_FALLBACK_TTL_MS } from "../../shared/limits.ts";
import { QUOTA_WINDOWS, isAgentVendor, vendorFailureOf, type AgentVendor, type VendorAvailability } from "../../shared/vendors.ts";

export interface VendorQuotaObservation {
  vendor: AgentVendor;
  source: "observed" | "fetched" | "rate_limit";
  resetsAt: number | null;
  observedAt: number;
  expiresAt: number;
  reason: string | null;
  /** Independent rejected window keys so partial allowed probes never supersede an unconfirmed window. */
  rejectedWindows?: readonly string[];
}

export type QuotaReconcileOutcome = "recorded" | "cleared" | "unchanged";

export interface PersistedSessionRateLimit {
  readonly vendor: AgentVendor;
  readonly rateLimit: RateLimitInfo;
  readonly updatedAt: number;
}

export interface ObservedQuotaStoreOptions {
  now?: () => number;
  fallbackTtlMs?: number;
  maxEntries?: number;
  db?: Db;
}

export interface ObservedQuotaStore {
  observeRateLimit(vendor: AgentVendor, info: RateLimitInfo, at?: number): void;
  observeTurnError(vendor: AgentVendor, errorMessage: string, at?: number): VendorQuotaObservation | null;
  observeTurnSuccess(vendor: AgentVendor): void;
  /**
   * Precondition: probedAt is the daemon timestamp when the upstream quota probe started.
   * Postcondition: records an exhausted fetched window as source "fetched" (returning "recorded"), clears an active observation when probedAt > active.observedAt and all active fetched windows are non-exhausted (returning "cleared"), or leaves state unchanged (returning "unchanged").
   */
  reconcileFetched(vendor: AgentVendor, fetched: QuotaResponse | null, probedAt: number, at?: number): QuotaReconcileOutcome;
  /**
   * Precondition: entries hold persisted session rate limits loaded at daemon startup with each session's updatedAt timestamp.
   * Postcondition: seeds unexpired exhausted limits with observedAt = entry.updatedAt without overwriting fresher observations and returns the count of hydrated vendors.
   */
  hydrateFromRateLimits(entries: readonly PersistedSessionRateLimit[], at?: number): number;
  clearVendor(vendor: AgentVendor): void;
  getActive(vendor: AgentVendor, at?: number): VendorQuotaObservation | null;
  snapshot(at?: number): Partial<Record<AgentVendor, VendorQuotaObservation>>;
}

const futureSeconds = (seconds: number, nowMs: number): number | null =>
  Number.isFinite(seconds) && seconds * 1000 > nowMs ? seconds : null;

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function wallClockFormatter(timeZone: string | undefined): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
}

function zonedWallTimeToUtc(
  year: number, month: number, day: number, hour: number, minute: number,
  timeZone: string | undefined, nowMs: number,
): number | null {
  const formatter = wallClockFormatter(timeZone);
  const partsOf = (at: number) => Object.fromEntries(formatter.formatToParts(at).map(({ type, value }) => [type, Number(value)]));
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let utc = desired;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = partsOf(utc);
    const wall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!);
    if (wall === desired) return futureSeconds(utc / 1000, nowMs);
    utc += desired - wall;
  }
  return null;
}

function nextClockReset(clock: RegExpExecArray, timeZone: string | undefined, nowMs: number): number | null {
  const hours = Number(clock[1]);
  const minutes = Number(clock[2] ?? 0);
  const meridiem = clock[3]?.toLowerCase();
  if (minutes > 59 || (meridiem ? hours < 1 || hours > 12 : hours > 23)) return null;
  const hour = meridiem ? hours % 12 + (meridiem === "pm" ? 12 : 0) : hours;
  const formatter = wallClockFormatter(timeZone);
  const partsOf = (at: number) => Object.fromEntries(formatter.formatToParts(at).map(({ type, value }) => [type, Number(value)]));
  const local = partsOf(nowMs);
  const midnight = Date.UTC(local.year!, local.month! - 1, local.day!);
  for (let day = 0; day <= 1; day++) {
    const desired = midnight + ((day * 24 + hour) * 60 + minutes) * 60_000;
    let utc = desired;
    for (let attempt = 0; attempt < 3; attempt++) {
      const parts = partsOf(utc);
      const wall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour, parts.minute);
      if (wall === desired) {
        if (utc > nowMs) return utc / 1000;
        break;
      }
      utc += desired - wall;
    }
  }
  return null;
}

function parseCalendarReset(match: RegExpExecArray, fallbackTimeZone: string | undefined, nowMs: number): number | null {
  const month = MONTHS[match[1]!.toLowerCase()];
  if (month === undefined) return null;
  const day = Number(match[2]);
  const year = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5] ?? 0);
  const meridiem = match[6]?.toLowerCase();
  if ((!match[5] && !meridiem) || minutes > 59 || (meridiem ? hours < 1 || hours > 12 : hours > 23)) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  const hour = meridiem ? hours % 12 + (meridiem === "pm" ? 12 : 0) : hours;
  try {
    return zonedWallTimeToUtc(year, month, day, hour, minutes, match[7] ?? fallbackTimeZone, nowMs);
  } catch {
    return null;
  }
}

function parseResetTail(tail: string, nowMs: number, fallbackTimeZone?: string): number | null {
  const reset = tail.replace(/^["']/, "").replace(/^at\s+/i, "");
  const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)/i.exec(reset)?.[0];
  if (iso) return futureSeconds(Date.parse(iso) / 1000, nowMs);
  const epoch = /^(\d{13}|\d{10})(?!\d)/.exec(reset)?.[1];
  if (epoch) return futureSeconds(Number(epoch) / (epoch.length === 13 ? 1000 : 1), nowMs);
  const calendar = /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+(?:at\s+)?(\d{1,2})(?::(\d\d))?\s*(am|pm)?\b\s*(?:\(([^)]+)\))?/i.exec(reset);
  if (calendar) return parseCalendarReset(calendar, fallbackTimeZone, nowMs);
  const clock = /^(\d{1,2})(?::(\d\d))?\s*(am|pm)?\b\s*(?:\(([^)]+)\))?/i.exec(reset);
  if (!clock || (!clock[2] && !clock[3])) return null;
  try {
    return nextClockReset(clock, clock[4] ?? fallbackTimeZone, nowMs);
  } catch {
    return null;
  }
}

export function parseQuotaResetAt(errorMessage: string, nowMs: number, fallbackTimeZone?: string): number | null {
  for (const pattern of [/\breset(?:s?[_ ]?at|s)?["']?\s*[:=]?\s*/i, /\btry again(?:\s+at|\s+after)?\s+/i]) {
    const marker = pattern.exec(errorMessage);
    if (marker === null) continue;
    const parsed = parseResetTail(errorMessage.slice(marker.index + marker[0].length), nowMs, fallbackTimeZone);
    if (parsed !== null) return parsed;
  }
  return null;
}

function isValidRateLimitWindow(value: unknown): value is RateLimitWindow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const w = value as Record<string, unknown>;
  return (
    typeof w.utilization === "number" && Number.isFinite(w.utilization) &&
    typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt) &&
    typeof w.status === "string"
  );
}

function validRateLimitWindows(info: RateLimitInfo | null | undefined): Array<[string, RateLimitWindow]> {
  if (info === null || info === undefined) return [];
  const raw = info.windows as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, RateLimitWindow] =>
    isValidRateLimitWindow(entry[1]),
  );
}

// Persisted RateLimitInfo cleared by dropRateLimitRejection keeps utilization=1 with status="allowed"; respect explicit allowed status.
function isRateLimitWindowExhausted(window: RateLimitWindow): boolean {
  if (window.status === "rejected") return true;
  if (window.status === "allowed" || window.status === "allowed_warning") return false;
  return Number.isFinite(window.utilization) && window.utilization >= 1;
}

function isRateLimitWindowConfirmedAllowed(window: RateLimitWindow): boolean {
  return window.status !== "rejected" && Number.isFinite(window.utilization) && window.utilization < 1;
}

function windowObservedAt(window: RateLimitWindow, fallbackMs: number): number {
  return typeof window.observedAt === "number" && Number.isFinite(window.observedAt) && window.observedAt > 0
    ? Math.min(window.observedAt, fallbackMs)
    : fallbackMs;
}

interface ActiveFetchedWindow {
  readonly id: string;
  readonly windowKey: string;
  readonly scopedKey: string;
  readonly label: string;
  readonly utilization: number;
  readonly resetsAt: number | null;
  readonly exhausted: boolean;
}

function activeFetchedWindows(vendor: AgentVendor, fetched: QuotaResponse | null, at: number): ActiveFetchedWindow[] {
  return (fetched?.groups ?? []).filter((group) => group.vendor === vendor).flatMap(({ id, windows }) => {
    if (typeof windows !== "object" || windows === null || Array.isArray(windows)) return [];
    return Object.entries(windows).flatMap(([key, window]) => {
      if (!isValidRateLimitWindow(window) || (window.resetsAt > 0 && window.resetsAt * 1000 <= at)) return [];
      const label = Object.entries(QUOTA_WINDOWS).find(([name]) => name === key)?.[1].short ?? key;
      return [{
        id: `${id}:${key}`,
        windowKey: key,
        scopedKey: id === vendor ? key : `${id}:${key}`,
        label,
        utilization: window.utilization,
        resetsAt: window.resetsAt > 0 ? window.resetsAt : null,
        exhausted: window.utilization >= 1 || window.status === "rejected",
      }];
    });
  });
}

interface WindowLimitRecord {
  readonly source: "fetched" | "rate_limit";
  readonly resetsAt: number | null;
  readonly observedAt: number;
  readonly expiresAt: number;
}

interface UnscopedLimitRecord {
  readonly source: VendorQuotaObservation["source"];
  readonly resetsAt: number | null;
  readonly observedAt: number;
  readonly expiresAt: number;
  readonly reason: string | null;
}

interface VendorLimitState {
  windows: Map<string, WindowLimitRecord>;
  unscoped: UnscopedLimitRecord | null;
}

function pruneVendorState(state: VendorLimitState, at: number): boolean {
  for (const [key, rec] of state.windows) {
    if (rec.expiresAt <= at) state.windows.delete(key);
  }
  if (state.unscoped !== null && state.unscoped.expiresAt <= at) {
    state.unscoped = null;
  }
  return state.windows.size > 0 || state.unscoped !== null;
}

function projectObservation(vendor: AgentVendor, state: VendorLimitState): VendorQuotaObservation {
  const windowRecords = [...state.windows.values()];
  const allRecords: Array<{ source: VendorQuotaObservation["source"]; resetsAt: number | null; observedAt: number; expiresAt: number }> = [
    ...windowRecords,
    ...(state.unscoped === null ? [] : [state.unscoped]),
  ];
  let latest = allRecords[0]!;
  for (const rec of allRecords.slice(1)) {
    if (rec.observedAt >= latest.observedAt) latest = rec;
  }
  const resets = allRecords.flatMap((rec) => (rec.resetsAt === null ? [] : [rec.resetsAt]));
  const rejectedWindows = [...state.windows.keys()];
  return {
    vendor,
    source: latest.source,
    resetsAt: resets.length > 0 ? Math.max(...resets) : null,
    observedAt: Math.max(...allRecords.map((rec) => rec.observedAt)),
    expiresAt: Math.max(...allRecords.map((rec) => rec.expiresAt)),
    reason: state.unscoped?.reason ?? null,
    ...(rejectedWindows.length > 0 ? { rejectedWindows } : {}),
  };
}

/**
 * Postcondition: merges observed and fetched quota for vendor; when fetchedProbedAt > observed.observedAt and fetched confirms every rejected window allowed (with no exhausted window), fetched supersedes the stale observed limit.
 */
export function mergeVendorQuota(
  vendor: AgentVendor, observed: VendorQuotaObservation | null, fetched: QuotaResponse | null, at = Date.now(), fetchedProbedAt?: number,
): HubVendorQuota | undefined {
  const windows = activeFetchedWindows(vendor, fetched, at);
  const details = windows.map(({ id, label, utilization, resetsAt }) => ({ id, label, utilization, resetsAt }));
  const exhausted = windows.filter((window) => window.exhausted);
  const confirmedAllowed = (key: string) =>
    windows.some((w) => !w.exhausted && (w.scopedKey === key || w.windowKey === key)) &&
    !exhausted.some((w) => w.scopedKey === key || w.windowKey === key);
  const allRejectedConfirmed =
    observed?.rejectedWindows === undefined ||
    observed.rejectedWindows.length === 0 ||
    observed.rejectedWindows.every(confirmedAllowed);
  const fetchedSupersedesObserved =
    observed !== null &&
    fetchedProbedAt !== undefined &&
    fetchedProbedAt > observed.observedAt &&
    windows.length > 0 &&
    exhausted.length === 0 &&
    allRejectedConfirmed;
  if (observed !== null && observed.expiresAt > at && !fetchedSupersedesObserved) {
    const { source, resetsAt, observedAt, reason } = observed;
    return { status: "limited", source, resetsAt, observedAt, reason, ...(details.length ? { windows: details } : {}) };
  }
  if (windows.length === 0) return undefined;
  const resetTimes = exhausted.flatMap((window) => (window.resetsAt === null ? [] : [window.resetsAt]));
  return {
    status: exhausted.length > 0 ? "limited" : "ok", source: "fetched",
    resetsAt: resetTimes.length ? Math.max(...resetTimes) : null, observedAt: fetchedProbedAt ?? at, reason: null, windows: details,
  };
}

export function formatVendorQuotaStatus(availability: VendorAvailability, quota: HubVendorQuota | undefined, nowMs: number): string {
  if (availability === "signed_out") return "未登录";
  if (availability === "not_installed") return "未安装";
  if (quota?.status !== "limited") return "可用";
  if (quota.resetsAt !== null && quota.resetsAt * 1000 <= nowMs) return "可用";
  if (quota.resetsAt !== null) return `限额已用完（重置：${new Date(quota.resetsAt * 1000).toISOString()}）`;
  return quota.reason === null ? "限额已用完" : `限额已用完（${quota.reason}）`;
}

export function createObservedQuotaStore({
  now = Date.now, fallbackTtlMs = OBSERVED_QUOTA_FALLBACK_TTL_MS, maxEntries = OBSERVED_QUOTA_CACHE_MAX, db,
}: ObservedQuotaStoreOptions = {}): ObservedQuotaStore {
  const cache = new LRUCache<AgentVendor, VendorLimitState>({ max: maxEntries });
  const clear = (vendor: AgentVendor) => { cache.delete(vendor); };
  const activeStateOf = (vendor: AgentVendor, at: number): VendorLimitState | null => {
    const state = cache.get(vendor);
    if (state === undefined) return null;
    if (pruneVendorState(state, at)) return state;
    clear(vendor);
    return null;
  };
  const ensureState = (vendor: AgentVendor, at: number): VendorLimitState =>
    activeStateOf(vendor, at) ?? { windows: new Map(), unscoped: null };
  const commitState = (vendor: AgentVendor, state: VendorLimitState): void => {
    if (state.windows.size === 0 && state.unscoped === null) clear(vendor);
    else cache.set(vendor, state);
  };
  const getActive = (vendor: AgentVendor, at = now()): VendorQuotaObservation | null => {
    const state = activeStateOf(vendor, at);
    return state === null ? null : projectObservation(vendor, state);
  };
  return {
    observeRateLimit(vendor, info, at = now()) {
      const state = ensureState(vendor, at);
      const valid = validRateLimitWindows(info);
      const activeWindows = valid.filter(([, w]) => w.resetsAt <= 0 || w.resetsAt * 1000 > at);
      const infoFallbackReset = info.resetsAt === null ? null : futureSeconds(info.resetsAt, at);
      let sawExhaustedWindow = false;
      const clearedWindows = new Set<string>();
      for (const [key, w] of activeWindows) {
        if (isRateLimitWindowExhausted(w)) {
          sawExhaustedWindow = true;
          const existing = state.windows.get(key);
          if (existing !== undefined && existing.observedAt > at) continue;
          const resetsAt = futureSeconds(w.resetsAt, at) ?? infoFallbackReset;
          state.windows.set(key, {
            source: "rate_limit",
            resetsAt,
            observedAt: at,
            expiresAt: resetsAt === null ? at + fallbackTtlMs : resetsAt * 1000,
          });
        } else if (isRateLimitWindowConfirmedAllowed(w)) {
          const existing = state.windows.get(key);
          if (existing !== undefined && at > existing.observedAt) {
            state.windows.delete(key);
            clearedWindows.add(key);
          }
        }
      }
      if (sawExhaustedWindow) {
        commitState(vendor, state);
        if (db !== undefined && clearedWindows.size > 0) {
          clearPersistedVendorRateLimits(db, vendor, { clearedWindows });
        }
        return;
      }
      if (isQuotaExhausted(info, at)) {
        const resetsAt = infoFallbackReset;
        if (state.unscoped === null || at >= state.unscoped.observedAt) {
          state.unscoped = {
            source: "rate_limit",
            reason: null,
            resetsAt,
            observedAt: at,
            expiresAt: resetsAt === null ? at + fallbackTtlMs : resetsAt * 1000,
          };
        }
        commitState(vendor, state);
        if (db !== undefined && clearedWindows.size > 0) {
          clearPersistedVendorRateLimits(db, vendor, { clearedWindows });
        }
        return;
      }
      let clearedUnscoped = false;
      // Only clear an unscoped rejection when no specific rejected window remains active.
      if (state.windows.size === 0 && state.unscoped !== null && at > state.unscoped.observedAt) {
        state.unscoped = null;
        clearedUnscoped = true;
      }
      commitState(vendor, state);
      if (db !== undefined && (clearedWindows.size > 0 || clearedUnscoped)) {
        clearPersistedVendorRateLimits(db, vendor, { clearedWindows, clearUnscoped: clearedUnscoped });
      }
    },
    observeTurnError(vendor, errorMessage, at = now()) {
      if (vendorFailureOf(errorMessage, vendor)?.kind !== "quota") return null;
      const state = ensureState(vendor, at);
      const inheritedReset = state.unscoped?.resetsAt ?? (state.windows.size > 0 ? projectObservation(vendor, state).resetsAt : null);
      const reset = parseQuotaResetAt(errorMessage, at) ?? inheritedReset;
      const reason = truncateChars(redactSecrets(errorMessage).trim().replace(/\s+/g, " "), MAX_QUOTA_REASON_CHARS);
      state.unscoped = {
        source: "observed",
        reason,
        resetsAt: reset,
        observedAt: at,
        expiresAt: reset === null ? at + fallbackTtlMs : reset * 1000,
      };
      commitState(vendor, state);
      return projectObservation(vendor, state);
    },
    observeTurnSuccess(vendor) {
      const hadActive = cache.has(vendor);
      clear(vendor);
      if (db !== undefined && hadActive) clearPersistedVendorRateLimits(db, vendor, { clearAll: true });
    },
    reconcileFetched(vendor: AgentVendor, fetched: QuotaResponse | null, probedAt: number, at = now()): QuotaReconcileOutcome {
      const windows = activeFetchedWindows(vendor, fetched, at);
      if (windows.length === 0) return "unchanged";
      const existingState = activeStateOf(vendor, at);
      const hadActive = existingState !== null;
      const state: VendorLimitState = existingState ?? { windows: new Map(), unscoped: null };
      const exhausted = windows.filter((window) => window.exhausted);
      let recordedAny = false;
      for (const w of exhausted) {
        const existingWin = state.windows.get(w.scopedKey) ?? (w.scopedKey !== w.windowKey ? state.windows.get(w.windowKey) : undefined);
        if (existingWin !== undefined && probedAt < existingWin.observedAt) continue;
        if (existingWin === undefined && state.unscoped !== null && probedAt < state.unscoped.observedAt) continue;
        if (w.scopedKey !== w.windowKey && state.windows.has(w.windowKey)) state.windows.delete(w.windowKey);
        state.windows.set(w.scopedKey, {
          source: "fetched",
          resetsAt: w.resetsAt,
          observedAt: probedAt,
          expiresAt: w.resetsAt === null ? at + fallbackTtlMs : w.resetsAt * 1000,
        });
        recordedAny = true;
      }
      let clearedInMemory = false;
      const confirmedAllowed = new Set<string>();
      for (const w of windows) {
        if (w.exhausted) continue;
        const scoped = state.windows.get(w.scopedKey);
        if (scoped !== undefined && probedAt > scoped.observedAt) {
          state.windows.delete(w.scopedKey);
          clearedInMemory = true;
        }
        if (!state.windows.has(w.scopedKey)) confirmedAllowed.add(w.scopedKey);
        if (w.scopedKey !== w.windowKey) {
          const unscopedWin = state.windows.get(w.windowKey);
          const siblingExhausted = exhausted.some((ex) => ex.windowKey === w.windowKey);
          if (unscopedWin !== undefined && !siblingExhausted && probedAt > unscopedWin.observedAt) {
            state.windows.delete(w.windowKey);
            clearedInMemory = true;
          }
          if (!siblingExhausted && !state.windows.has(w.windowKey)) confirmedAllowed.add(w.windowKey);
        }
      }
      if (exhausted.length === 0 && state.windows.size === 0 && state.unscoped !== null && probedAt > state.unscoped.observedAt) {
        state.unscoped = null;
        clearedInMemory = true;
      }
      commitState(vendor, state);
      const allClear = exhausted.length === 0 && state.windows.size === 0 && state.unscoped === null;
      if (db !== undefined && (clearedInMemory || confirmedAllowed.size > 0 || allClear)) {
        clearPersistedVendorRateLimits(db, vendor, {
          clearedWindows: confirmedAllowed,
          clearUnscoped: allClear,
          ...(clearedInMemory ? {} : { beforeUpdatedAt: probedAt }),
        });
      }
      if (state.windows.size === 0 && state.unscoped === null) return hadActive ? "cleared" : "unchanged";
      return recordedAny ? "recorded" : "unchanged";
    },
    hydrateFromRateLimits(entries: readonly PersistedSessionRateLimit[], at = now()): number {
      const latestAllowedByVendor = new Map<AgentVendor, Map<string, number>>();
      for (const entry of entries) {
        for (const [key, w] of validRateLimitWindows(entry.rateLimit)) {
          if ((w.resetsAt > 0 && w.resetsAt * 1000 <= at) || !isRateLimitWindowConfirmedAllowed(w)) continue;
          let byKey = latestAllowedByVendor.get(entry.vendor);
          if (byKey === undefined) {
            byKey = new Map();
            latestAllowedByVendor.set(entry.vendor, byKey);
          }
          const prev = byKey.get(key) ?? -Infinity;
          if (entry.updatedAt > prev) byKey.set(key, entry.updatedAt);
        }
      }
      const hydrated = new Set<AgentVendor>();
      for (const entry of entries) {
        const valid = validRateLimitWindows(entry.rateLimit);
        const exhaustedWindows = valid.filter(
          ([, w]) => (w.resetsAt <= 0 || w.resetsAt * 1000 > at) && isRateLimitWindowExhausted(w),
        );
        const infoFallbackReset = entry.rateLimit.resetsAt === null ? null : futureSeconds(entry.rateLimit.resetsAt, at);
        if (exhaustedWindows.length > 0) {
          const state = ensureState(entry.vendor, at);
          const allowedMap = latestAllowedByVendor.get(entry.vendor);
          let changed = false;
          for (const [key, w] of exhaustedWindows) {
            const observedAt = windowObservedAt(w, entry.updatedAt);
            if ((allowedMap?.get(key) ?? -Infinity) > observedAt) continue;
            const resetsAt = futureSeconds(w.resetsAt, at) ?? infoFallbackReset;
            const expiresAt = resetsAt === null ? observedAt + fallbackTtlMs : resetsAt * 1000;
            if (expiresAt <= at) continue;
            const existing = state.windows.get(key);
            if (existing !== undefined && existing.observedAt >= observedAt) continue;
            state.windows.set(key, { source: "rate_limit", resetsAt, observedAt, expiresAt });
            changed = true;
          }
          if (changed) {
            commitState(entry.vendor, state);
            hydrated.add(entry.vendor);
          }
          continue;
        }
        if (!isQuotaExhausted(entry.rateLimit, at)) continue;
        const resetsAt = infoFallbackReset;
        const expiresAt = resetsAt === null ? entry.updatedAt + fallbackTtlMs : resetsAt * 1000;
        if (expiresAt <= at) continue;
        const state = ensureState(entry.vendor, at);
        if (state.unscoped !== null && state.unscoped.observedAt >= entry.updatedAt) continue;
        state.unscoped = { source: "rate_limit", reason: null, resetsAt, observedAt: entry.updatedAt, expiresAt };
        commitState(entry.vendor, state);
        hydrated.add(entry.vendor);
      }
      return hydrated.size;
    },
    clearVendor(vendor) {
      clear(vendor);
      if (db !== undefined) clearPersistedVendorRateLimits(db, vendor, { clearAll: true });
    },
    getActive,
    snapshot(at = now()) {
      return Object.fromEntries(Array.from(cache.keys()).flatMap((vendor) => {
        const observation = getActive(vendor, at);
        return observation === null ? [] : [[vendor, observation]];
      }));
    },
  };
}

export function observeDriverQuota(store: ObservedQuotaStore, vendor: AgentVendor, event: DriverEvent): void {
  if (event.type === "rate_limit") store.observeRateLimit(vendor, event.info, event.at);
  if (event.type !== "turn.ended") return;
  if (event.ok && !event.interrupted) store.observeTurnSuccess(vendor);
  else if (event.error) store.observeTurnError(vendor, event.error.message, event.at);
}

interface ClearPersistedRateLimitsSpec {
  readonly clearAll?: boolean;
  readonly clearedWindows?: ReadonlySet<string>;
  readonly clearUnscoped?: boolean;
  readonly beforeUpdatedAt?: number;
}

function clearPersistedRateLimitJson(
  rawJson: string,
  spec: ClearPersistedRateLimitsSpec,
): { readonly changed: boolean; readonly next: RateLimitInfo | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { changed: false, next: null };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { changed: false, next: null };
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.status !== "string") return { changed: false, next: null };
  if (typeof obj.windows !== "object" || obj.windows === null || Array.isArray(obj.windows)) {
    return obj.status === "rejected" && (spec.clearAll === true || spec.clearUnscoped === true)
      ? { changed: true, next: null }
      : { changed: false, next: null };
  }
  const info = parsePersistedRateLimit(rawJson);
  if (info === null) return { changed: false, next: null };
  const nextWindows: Record<string, RateLimitWindow> = { ...info.windows };
  let changed = false;
  let clearedOwnedTopReset = false;
  for (const [k, w] of Object.entries(info.windows)) {
    if (!isRateLimitWindowExhausted(w)) continue;
    if (spec.clearAll === true || spec.clearedWindows?.has(k) === true) {
      if (w.resetsAt > 0 && w.resetsAt === info.resetsAt) clearedOwnedTopReset = true;
      const { observedAt: _ignored, ...rest } = w;
      nextWindows[k] = { ...rest, status: "allowed" };
      changed = true;
    }
  }
  const remainingExhausted = Object.values(nextWindows).filter(isRateLimitWindowExhausted);
  if (remainingExhausted.length > 0) {
    if (!changed) return { changed: false, next: null };
    const resets = remainingExhausted.map((w) => w.resetsAt).filter((r) => Number.isFinite(r) && r > 0);
    return {
      changed: true,
      next: {
        ...info,
        status: "rejected",
        resetsAt: resets.length > 0 ? Math.max(...resets) : (clearedOwnedTopReset ? null : info.resetsAt),
        windows: nextWindows,
      },
    };
  }
  const clearTopLevel = changed || (info.status === "rejected" && (spec.clearAll === true || spec.clearUnscoped === true));
  if (!clearTopLevel) return { changed: false, next: null };
  return Object.keys(nextWindows).length === 0
    ? { changed: true, next: null }
    : { changed: true, next: { ...info, status: "allowed", windows: nextWindows } };
}

function clearPersistedVendorRateLimits(db: Db, vendor: AgentVendor, spec: ClearPersistedRateLimitsSpec): number {
  const rows =
    spec.beforeUpdatedAt !== undefined
      ? db.all<{ id: number; rate_limit: string }>(
          "SELECT id, rate_limit FROM agent_sessions WHERE vendor = ? AND rate_limit IS NOT NULL AND updated_at < ?",
          vendor,
          spec.beforeUpdatedAt,
        )
      : db.all<{ id: number; rate_limit: string }>(
          "SELECT id, rate_limit FROM agent_sessions WHERE vendor = ? AND rate_limit IS NOT NULL",
          vendor,
        );
  let updated = 0;
  for (const row of rows) {
    const result = clearPersistedRateLimitJson(row.rate_limit, spec);
    if (!result.changed) continue;
    db.run(
      "UPDATE agent_sessions SET rate_limit = ? WHERE id = ?",
      result.next === null ? null : JSON.stringify(result.next),
      row.id,
    );
    updated += 1;
  }
  return updated;
}

function parsePersistedRateLimit(rawJson: string): RateLimitInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.status !== "string") return null;
  if (typeof obj.windows !== "object" || obj.windows === null || Array.isArray(obj.windows)) return null;
  const windows: Record<string, RateLimitWindow> = {};
  for (const [key, value] of Object.entries(obj.windows as Record<string, unknown>)) {
    if (isValidRateLimitWindow(value)) windows[key] = value;
  }
  const resetsAt = typeof obj.resetsAt === "number" && Number.isFinite(obj.resetsAt) ? obj.resetsAt : null;
  return { status: obj.status, resetsAt, windows };
}

export function loadPersistedSessionRateLimits(db: Db): PersistedSessionRateLimit[] {
  const rows = db.all<{ vendor: string; rate_limit: string; updated_at: number }>(
    `SELECT vendor, rate_limit, updated_at FROM (
      SELECT vendor, rate_limit, updated_at,
        ROW_NUMBER() OVER (PARTITION BY vendor ORDER BY updated_at DESC, id DESC) AS rn
      FROM agent_sessions
      WHERE rate_limit IS NOT NULL
    ) WHERE rn <= 4`,
  );
  const out: PersistedSessionRateLimit[] = [];
  for (const row of rows) {
    if (!isAgentVendor(row.vendor)) continue;
    const rateLimit = parsePersistedRateLimit(row.rate_limit);
    if (rateLimit !== null) out.push({ vendor: row.vendor, rateLimit, updatedAt: row.updated_at });
  }
  return out;
}
