import { FETCHED_QUOTA_TIMEOUT_MS, VENDOR_LIST, type AgentVendor, type QuotaResponse } from "../../shared/index.ts";
import { VENDOR_DAEMONS } from "../../vendors/daemon-registry.ts";
import type { VendorRuntimeResolver } from "../provider-manager/runtime-resolver.ts";
import { createFetchedQuota, mergeFetchedQuotas, queryFetchedQuota, type CachedQuota } from "./fetched-quota.ts";

export interface ProviderQuotaSnapshot {
  readonly response: QuotaResponse;
  readonly probedAt: Partial<Record<AgentVendor, number>>;
}

export interface ProviderQuotaOptions {
  readonly onFetched?: (vendor: AgentVendor, response: QuotaResponse, probedAt: number) => void;
  readonly onScopeChanged?: (vendor: AgentVendor) => void;
  readonly now?: () => number;
}

export interface ProviderQuota {
  get(): Promise<QuotaResponse>;
  /**
   * Postcondition: queries only options.vendor when specified (otherwise all quota-capable vendors), invalidating cached entries first when options.refresh is true; when options.timeoutMs is set, races each vendor independently against the deadline so already-settled vendors are never dropped when a sibling CLI is slow.
   */
  getSnapshot(options?: { readonly vendor?: AgentVendor; readonly refresh?: boolean; readonly timeoutMs?: number }): Promise<ProviderQuotaSnapshot>;
  refresh(vendor: AgentVendor): void;
  /**
   * Postcondition: prevents new quota probes, aborts all in-flight and draining vendor quota probes, and resolves only after every underlying child process has exited.
   */
  close(): Promise<void>;
}

export function createProviderQuota(runtime: VendorRuntimeResolver, options?: ProviderQuotaOptions): ProviderQuota {
  const sources = new Map<AgentVendor, CachedQuota>(VENDOR_LIST.flatMap(({ id, quota }) => {
    if (quota === undefined) return [];
    const { queryQuota, quotaScope } = VENDOR_DAEMONS[id];
    const fetched = quota.fetched;
    return [[id, createFetchedQuota({
      ...(options?.now ? { now: options.now } : {}),
      ...(options?.onFetched ? { onFetched: (response, probedAt) => options.onFetched!(id, response, probedAt) } : {}),
      ...(options?.onScopeChanged ? { onScopeChanged: () => options.onScopeChanged!(id) } : {}),
      fingerprint: () => JSON.stringify([
        runtime.locateBinary(id),
        runtime.secrets.fingerprint(id),
        quotaScope?.(runtime.userHome, runtime.resolveVendorEnv(id)),
      ]),
      query: async (signal) => {
        const path = runtime.locateBinary(id);
        if (path === null) return { groups: [] };
        const queryOpts = { path, cwd: runtime.userHome, env: runtime.resolveVendorEnv(id), signal, timeoutMs: FETCHED_QUOTA_TIMEOUT_MS };
        if (queryQuota) return queryQuota(queryOpts);
        return fetched ? queryFetchedQuota({ ...queryOpts, vendor: id, spec: fetched }) : { groups: [] };
      },
    })] as const];
  }));
  const merged = mergeFetchedQuotas([...sources.values()]);
  let closed = false;
  return {
    get: () => closed ? Promise.resolve({ groups: [] }) : merged.get(),
    async getSnapshot(opts?: { readonly vendor?: AgentVendor; readonly refresh?: boolean; readonly timeoutMs?: number }): Promise<ProviderQuotaSnapshot> {
      if (closed) return { response: { groups: [] }, probedAt: {} };
      const entries: ReadonlyArray<readonly [AgentVendor, CachedQuota]> =
        opts?.vendor !== undefined
          ? (sources.has(opts.vendor) ? [[opts.vendor, sources.get(opts.vendor)!]] : [])
          : [...sources.entries()];
      if (entries.length === 0) return { response: { groups: [] }, probedAt: {} };
      if (opts?.refresh === true) {
        for (const [, source] of entries) source.invalidate();
      }
      const timeoutMs = opts?.timeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut =
        timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs >= 0
          ? new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), timeoutMs);
            })
          : null;
      try {
        const settled = await Promise.all(
          entries.map(async ([vendor, source]) => {
            const snap = timedOut === null
              ? await source.getSnapshot()
              : await Promise.race([source.getSnapshot(), timedOut]);
            return { vendor, source, snap };
          }),
        );
        const groups: QuotaResponse["groups"] = [];
        const probedAt: Partial<Record<AgentVendor, number>> = {};
        for (const { vendor, source, snap } of settled) {
          if (snap === null || !source.isCurrent(snap.response)) continue;
          groups.push(...snap.response.groups);
          if (snap.probedAt !== null) probedAt[vendor] = snap.probedAt;
        }
        return { response: { groups }, probedAt };
      } finally {
        clearTimeout(timer);
      }
    },
    refresh(vendor: AgentVendor) {
      if (closed) return;
      const source = sources.get(vendor);
      source?.invalidate();
      void source?.get();
    },
    async close() {
      closed = true;
      await Promise.allSettled([...sources.values()].map((source) => source.close()));
    },
  };
}
