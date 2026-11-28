import { redactSecrets } from "../ledger/redact.ts";
import { LRUCache } from "lru-cache";
import type { QuotaResponse } from "../../shared/api.ts";
import { isQuotaExhausted, truncateChars, type RateLimitInfo } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import type { HubVendorQuota } from "../../shared/hub.ts";
import { MAX_QUOTA_REASON_CHARS, OBSERVED_QUOTA_CACHE_MAX, OBSERVED_QUOTA_FALLBACK_TTL_MS } from "../../shared/limits.ts";
import { QUOTA_WINDOWS, vendorFailureOf, type AgentVendor, type VendorAvailability } from "../../shared/vendors.ts";

export interface VendorQuotaObservation {
  vendor: AgentVendor;
  source: "observed" | "rate_limit";
  resetsAt: number | null;
  observedAt: number;
  expiresAt: number;
  reason: string | null;
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
   * Postcondition: clears the active observation for vendor and returns true only when probedAt > active.observedAt and fetched contains at least one active non-exhausted window with zero exhausted windows for vendor.
   */
  reconcileFetched(vendor: AgentVendor, fetched: QuotaResponse | null, probedAt: number, at?: number): boolean;
  clearVendor(vendor: AgentVendor): void;
  getActive(vendor: AgentVendor, at?: number): VendorQuotaObservation | null;
  snapshot(at?: number): Partial<Record<AgentVendor, VendorQuotaObservation>>;
}

const futureSeconds = (seconds: number, nowMs: number): number | null =>
  Number.isFinite(seconds) && seconds * 1000 > nowMs ? seconds : null;

function nextClockReset(clock: RegExpExecArray, timeZone: string | undefined, nowMs: number): number | null {
  const hours = Number(clock[1]);
  const minutes = Number(clock[2] ?? 0);
  const meridiem = clock[3]?.toLowerCase();
  if (minutes > 59 || (meridiem ? hours < 1 || hours > 12 : hours > 23)) return null;
  const hour = meridiem ? hours % 12 + (meridiem === "pm" ? 12 : 0) : hours;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
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

export function parseQuotaResetAt(errorMessage: string, nowMs: number, fallbackTimeZone?: string): number | null {
  const marker = /\breset(?:s?[_ ]?at|s)?["']?\s*[:=]?\s*/i.exec(errorMessage);
  if (marker === null) return null;
  const reset = errorMessage.slice(marker.index + marker[0].length).replace(/^["']/, "").replace(/^at\s+/i, "");
  const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)/i.exec(reset)?.[0];
  if (iso) return futureSeconds(Date.parse(iso) / 1000, nowMs);
  const epoch = /^(\d{13}|\d{10})(?!\d)/.exec(reset)?.[1];
  if (epoch) return futureSeconds(Number(epoch) / (epoch.length === 13 ? 1000 : 1), nowMs);
  const clock = /^(\d{1,2})(?::(\d\d))?\s*(am|pm)?\b\s*(?:\(([^)]+)\))?/i.exec(reset);
  if (!clock || (!clock[2] && !clock[3])) return null;
  try {
    return nextClockReset(clock, clock[4] ?? fallbackTimeZone, nowMs);
  } catch {
    return null;
  }
}

/**
 * Postcondition: merges observed and fetched quota for vendor; when fetchedProbedAt > observed.observedAt and fetched has active windows with none exhausted, fetched supersedes the stale observed limit.
 */
export function mergeVendorQuota(
  vendor: AgentVendor, observed: VendorQuotaObservation | null, fetched: QuotaResponse | null, at = Date.now(), fetchedProbedAt?: number,
): HubVendorQuota | undefined {
  void fetchedProbedAt;
  const windows = (fetched?.groups ?? []).filter((group) => group.vendor === vendor).flatMap(({ id, windows }) =>
    Object.entries(windows).flatMap(([key, window]) => {
      if (window === undefined || !Number.isFinite(window.utilization) || (window.resetsAt > 0 && window.resetsAt * 1000 <= at)) return [];
      const label = Object.entries(QUOTA_WINDOWS).find(([name]) => name === key)?.[1].short ?? key;
      return [{
        id: `${id}:${key}`, label, utilization: window.utilization, resetsAt: Number.isFinite(window.resetsAt) && window.resetsAt > 0 ? window.resetsAt : null,
        exhausted: window.utilization >= 1 || window.status === "rejected",
      }];
    }),
  );
  const details = windows.map(({ exhausted: _exhausted, ...window }) => window);
  if (observed !== null && observed.expiresAt > at) {
    const { source, resetsAt, observedAt, reason } = observed;
    return { status: "limited", source, resetsAt, observedAt, reason, ...(details.length ? { windows: details } : {}) };
  }
  if (windows.length === 0) return undefined;
  const exhausted = windows.filter((window) => window.exhausted);
  const resetTimes = exhausted.flatMap((window) => window.resetsAt ?? []);
  return {
    status: exhausted.length > 0 ? "limited" : "ok", source: "fetched",
    resetsAt: resetTimes.length ? Math.min(...resetTimes) : null, observedAt: at, reason: null, windows: details,
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
    vendor: AgentVendor, source: VendorQuotaObservation["source"], reason: string | null, resetsAt: number | null, at: number,
  ): VendorQuotaObservation => {
    const observation = { vendor, source, reason, resetsAt, observedAt: at, expiresAt: resetsAt === null ? at + fallbackTtlMs : resetsAt * 1000 };
    cache.set(vendor, observation);
    return observation;
  };
  return {
    observeRateLimit(vendor, info, at = now()) {
      if (isQuotaExhausted(info, at)) record(vendor, "rate_limit", null, info.resetsAt === null ? null : futureSeconds(info.resetsAt, at), at);
      else clear(vendor);
    },
    observeTurnError(vendor, errorMessage, at = now()) {
      if (vendorFailureOf(errorMessage, vendor)?.kind !== "quota") return null;
      const reset = parseQuotaResetAt(errorMessage, at) ?? getActive(vendor, at)?.resetsAt ?? null;
      return record(vendor, "observed", truncateChars(redactSecrets(errorMessage).trim().replace(/\s+/g, " "), MAX_QUOTA_REASON_CHARS), reset, at);
    },
    observeTurnSuccess: clear,
    reconcileFetched(vendor: AgentVendor, fetched: QuotaResponse | null, probedAt: number, at?: number): boolean {
      void vendor;
      void fetched;
      void probedAt;
      void at;
      throw new Error("Not implemented");
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
