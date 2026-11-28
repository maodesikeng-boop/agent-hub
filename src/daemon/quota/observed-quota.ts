import { redactSecrets } from "../ledger/redact.ts";
import type { Db } from "../store/db.ts";
import { LRUCache } from "lru-cache";
import type { QuotaResponse } from "../../shared/api.ts";
import { isQuotaExhausted, truncateChars, type RateLimitInfo } from "../../shared/domain.ts";
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

function activeFetchedWindows(vendor: AgentVendor, fetched: QuotaResponse | null, at: number) {
  return (fetched?.groups ?? []).filter((group) => group.vendor === vendor).flatMap(({ id, windows }) =>
    Object.entries(windows).flatMap(([key, window]) => {
      if (window === undefined || !Number.isFinite(window.utilization) || (window.resetsAt > 0 && window.resetsAt * 1000 <= at)) return [];
      const label = Object.entries(QUOTA_WINDOWS).find(([name]) => name === key)?.[1].short ?? key;
      return [{
        id: `${id}:${key}`,
        label,
        utilization: window.utilization,
        resetsAt: Number.isFinite(window.resetsAt) && window.resetsAt > 0 ? window.resetsAt : null,
        exhausted: window.utilization >= 1 || window.status === "rejected",
      }];
    }),
  );
}

function exhaustedRateLimitReset(info: RateLimitInfo, at: number): { exhausted: boolean; resetsAt: number | null } {
  const exhaustedWindows = Object.values(info.windows).filter(
    (window) =>
      window !== undefined &&
      (window.resetsAt <= 0 || window.resetsAt * 1000 > at) &&
      (window.status === "rejected" || (Number.isFinite(window.utilization) && window.utilization >= 1)),
  );
  if (exhaustedWindows.length > 0) {
    const resets = exhaustedWindows.flatMap((window) => {
      const reset = futureSeconds(window.resetsAt, at);
      return reset === null ? [] : [reset];
    });
    const fallback = info.resetsAt === null ? null : futureSeconds(info.resetsAt, at);
    return { exhausted: true, resetsAt: resets.length > 0 ? Math.min(...resets) : fallback };
  }
  if (isQuotaExhausted(info, at)) {
    return { exhausted: true, resetsAt: info.resetsAt === null ? null : futureSeconds(info.resetsAt, at) };
  }
  return { exhausted: false, resetsAt: null };
}

/**
 * Postcondition: merges observed and fetched quota for vendor; when fetchedProbedAt > observed.observedAt and fetched has active windows with none exhausted, fetched supersedes the stale observed limit.
 */
export function mergeVendorQuota(
  vendor: AgentVendor, observed: VendorQuotaObservation | null, fetched: QuotaResponse | null, at = Date.now(), fetchedProbedAt?: number,
): HubVendorQuota | undefined {
  const windows = activeFetchedWindows(vendor, fetched, at);
  const details = windows.map(({ exhausted: _exhausted, ...window }) => window);
  const exhausted = windows.filter((window) => window.exhausted);
  const fetchedSupersedesObserved =
    observed !== null &&
    fetchedProbedAt !== undefined &&
    fetchedProbedAt > observed.observedAt &&
    windows.length > 0 &&
    exhausted.length === 0;
  if (observed !== null && observed.expiresAt > at && !fetchedSupersedesObserved) {
    const { source, resetsAt, observedAt, reason } = observed;
    return { status: "limited", source, resetsAt, observedAt, reason, ...(details.length ? { windows: details } : {}) };
  }
  if (windows.length === 0) return undefined;
  const resetTimes = exhausted.flatMap((window) => window.resetsAt ?? []);
  return {
    status: exhausted.length > 0 ? "limited" : "ok", source: "fetched",
    resetsAt: resetTimes.length ? Math.min(...resetTimes) : null, observedAt: fetchedProbedAt ?? at, reason: null, windows: details,
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
  now = Date.now, fallbackTtlMs = OBSERVED_QUOTA_FALLBACK_TTL_MS, maxEntries = OBSERVED_QUOTA_CACHE_MAX,
}: ObservedQuotaStoreOptions = {}): ObservedQuotaStore {
  const cache = new LRUCache<AgentVendor, VendorQuotaObservation>({ max: maxEntries });
  const clear = (vendor: AgentVendor) => { cache.delete(vendor); };
  const getActive = (vendor: AgentVendor, at = now()) => {
    const record = cache.get(vendor);
    if (record === undefined) return null;
    if (record.expiresAt > at) return record;
    clear(vendor);
    return null;
  };
  const record = (
    vendor: AgentVendor, source: VendorQuotaObservation["source"], reason: string | null, resetsAt: number | null, observedAt: number, expiresAt: number,
  ): VendorQuotaObservation => {
    const observation = { vendor, source, reason, resetsAt, observedAt, expiresAt };
    cache.set(vendor, observation);
    return observation;
  };
  return {
    observeRateLimit(vendor, info, at = now()) {
      const { exhausted, resetsAt } = exhaustedRateLimitReset(info, at);
      if (exhausted) {
        record(vendor, "rate_limit", null, resetsAt, at, resetsAt === null ? at + fallbackTtlMs : resetsAt * 1000);
        return;
      }
      const active = getActive(vendor, at);
      if (active !== null && at > active.observedAt) clear(vendor);
    },
    observeTurnError(vendor, errorMessage, at = now()) {
      if (vendorFailureOf(errorMessage, vendor)?.kind !== "quota") return null;
      const reset = parseQuotaResetAt(errorMessage, at) ?? getActive(vendor, at)?.resetsAt ?? null;
      const reason = truncateChars(redactSecrets(errorMessage).trim().replace(/\s+/g, " "), MAX_QUOTA_REASON_CHARS);
      return record(vendor, "observed", reason, reset, at, reset === null ? at + fallbackTtlMs : reset * 1000);
    },
    observeTurnSuccess: clear,
    reconcileFetched(vendor: AgentVendor, fetched: QuotaResponse | null, probedAt: number, at = now()): QuotaReconcileOutcome {
      const windows = activeFetchedWindows(vendor, fetched, at);
      if (windows.length === 0) return "unchanged";
      const exhausted = windows.filter((window) => window.exhausted);
      const active = getActive(vendor, at);
      if (exhausted.length > 0) {
        if (active !== null && probedAt < active.observedAt) return "unchanged";
        const resetTimes = exhausted.flatMap((window) => window.resetsAt ?? []);
        const resetsAt = resetTimes.length > 0 ? Math.min(...resetTimes) : null;
        record(vendor, "fetched", null, resetsAt, probedAt, resetsAt === null ? at + fallbackTtlMs : resetsAt * 1000);
        return "recorded";
      }
      if (active !== null && probedAt > active.observedAt) {
        clear(vendor);
        return "cleared";
      }
      return "unchanged";
    },
    hydrateFromRateLimits(entries: readonly PersistedSessionRateLimit[], at = now()): number {
      const hydrated = new Set<AgentVendor>();
      for (const entry of entries) {
        const { exhausted, resetsAt } = exhaustedRateLimitReset(entry.rateLimit, at);
        if (!exhausted) continue;
        const expiresAt = resetsAt === null ? entry.updatedAt + fallbackTtlMs : resetsAt * 1000;
        if (expiresAt <= at) continue;
        const existing = getActive(entry.vendor, at);
        if (existing !== null && existing.observedAt >= entry.updatedAt) continue;
        record(entry.vendor, "rate_limit", null, resetsAt, entry.updatedAt, expiresAt);
        hydrated.add(entry.vendor);
      }
      return hydrated.size;
    },
    clearVendor: clear,
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
    try {
      const parsed = JSON.parse(row.rate_limit) as RateLimitInfo;
      if (typeof parsed === "object" && parsed !== null && typeof parsed.status === "string" && typeof parsed.windows === "object" && parsed.windows !== null) {
        out.push({ vendor: row.vendor, rateLimit: parsed, updatedAt: row.updated_at });
      }
    } catch {
      // Ignore malformed persisted rate_limit rows.
    }
  }
  return out;
}
