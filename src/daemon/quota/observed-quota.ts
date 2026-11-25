// Invariant: live vendor quota observations live in an LRUCache bounded by OBSERVED_QUOTA_CACHE_MAX, expire automatically at resetsAt or OBSERVED_QUOTA_FALLBACK_TTL_MS, and clear immediately on any successful turn, allowed rate-limit event, or vendor credential change.
import type { QuotaResponse } from "../../shared/api.ts";
import type { RateLimitInfo } from "../../shared/domain.ts";
import type { HubVendorQuota } from "../../shared/hub.ts";
import type { AgentVendor, VendorAvailability } from "../../shared/vendors.ts";

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
  /**
   * Precondition: info came from a driver rate_limit event for vendor.
   * Postcondition: records an active limitation when info is rejected or exhausted with future expiry; clears any stored limitation when info reports an allowed status.
   */
  observeRateLimit(vendor: AgentVendor, info: RateLimitInfo, at?: number): void;
  /**
   * Precondition: errorMessage came from a failed turn.ended event for vendor.
   * Postcondition: when errorMessage classifies as a vendor quota failure, stores and returns a bounded VendorQuotaObservation with parsed resetsAt or fallback TTL; otherwise leaves existing state untouched and returns null.
   */
  observeTurnError(vendor: AgentVendor, errorMessage: string, at?: number): VendorQuotaObservation | null;
  /**
   * Postcondition: clears any active limitation recorded for vendor because a turn completed cleanly.
   */
  observeTurnSuccess(vendor: AgentVendor): void;
  /**
   * Postcondition: clears any active limitation recorded for vendor (for example after credential or account change).
   */
  clearVendor(vendor: AgentVendor): void;
  /**
   * Postcondition: returns the active observation for vendor if not expired at the given timestamp, deleting expired entries lazily and returning null when clear or expired.
   */
  getActive(vendor: AgentVendor, at?: number): VendorQuotaObservation | null;
  /**
   * Postcondition: returns all non-expired vendor observations as of at, purging expired entries.
   */
  snapshot(at?: number): Partial<Record<AgentVendor, VendorQuotaObservation>>;
}

/**
 * Precondition: errorMessage is a raw vendor failure message and nowMs is epoch ms.
 * Postcondition: extracts a future Unix epoch timestamp in seconds from epoch markers, ISO timestamps, or human reset phrases (such as "resets 7:10pm (Asia/Shanghai)"), or returns null when no unambiguous reset time is present.
 */
export function parseQuotaResetAt(_errorMessage: string, _nowMs: number, _fallbackTimeZone?: string): number | null {
  throw new Error("Not implemented");
}

/**
 * Precondition: observed is an active ObservedQuotaStore entry (or null) and fetched is the latest providerQuota snapshot (or null).
 * Postcondition: merges active observed rejections and fetched windows into a HubVendorQuota summary for vendor, returning undefined when neither source has data.
 */
export function mergeVendorQuota(
  _vendor: AgentVendor,
  _observed: VendorQuotaObservation | null,
  _fetched: QuotaResponse | null,
  _at?: number,
): HubVendorQuota | undefined {
  throw new Error("Not implemented");
}

/**
 * Precondition: availability is the catalog availability for a vendor and quota is its merged HubVendorQuota (if any).
 * Postcondition: returns the display status line for hub models, surfacing live limitation and reset time or reason when limited while preserving not_installed and signed_out precedence.
 */
export function formatVendorQuotaStatus(
  _availability: VendorAvailability,
  _quota: HubVendorQuota | undefined,
  _nowMs: number,
): string {
  throw new Error("Not implemented");
}

/**
 * Precondition: options.maxEntries defaults to OBSERVED_QUOTA_CACHE_MAX and options.fallbackTtlMs defaults to OBSERVED_QUOTA_FALLBACK_TTL_MS.
 * Postcondition: returns an ObservedQuotaStore backed by a bounded LRUCache.
 */
export function createObservedQuotaStore(_options?: ObservedQuotaStoreOptions): ObservedQuotaStore {
  throw new Error("Not implemented");
}
