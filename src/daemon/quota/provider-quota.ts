import { FETCHED_QUOTA_TIMEOUT_MS, VENDOR_LIST, type AgentVendor, type QuotaResponse } from "../../shared/index.ts";
import { VENDOR_DAEMONS } from "../../vendors/daemon-registry.ts";
import type { VendorRuntimeResolver } from "../provider-manager/runtime-resolver.ts";
import { createFetchedQuota, mergeFetchedQuotas, queryFetchedQuota } from "./fetched-quota.ts";

export interface ProviderQuota {
  get(): Promise<QuotaResponse>;
  refresh(vendor: AgentVendor): void;
  /**
   * Postcondition: prevents new quota probes, aborts all in-flight and draining vendor quota probes, and resolves only after every underlying child process has exited.
   */
  close(): Promise<void>;
}

export function createProviderQuota(runtime: VendorRuntimeResolver): ProviderQuota {
  const sources = new Map(VENDOR_LIST.flatMap(({ id, quota }) => {
    if (quota === undefined) return [];
    const { queryQuota, quotaScope } = VENDOR_DAEMONS[id];
    const fetched = quota.fetched;
    return [[id, createFetchedQuota({
      fingerprint: () => JSON.stringify([
        runtime.locateBinary(id),
        runtime.secrets.fingerprint(id),
        quotaScope?.(runtime.userHome, runtime.resolveVendorEnv(id)),
      ]),
      query: async (signal) => {
        const path = runtime.locateBinary(id);
        if (path === null) return { groups: [] };
        const options = { path, cwd: runtime.userHome, env: runtime.resolveVendorEnv(id), signal, timeoutMs: FETCHED_QUOTA_TIMEOUT_MS };
        if (queryQuota) return queryQuota(options);
        return fetched ? queryFetchedQuota({ ...options, vendor: id, spec: fetched }) : { groups: [] };
      },
    })] as const];
  }));
  const merged = mergeFetchedQuotas([...sources.values()]);
  let closed = false;
  return {
    get: () => closed ? Promise.resolve({ groups: [] }) : merged.get(),
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
