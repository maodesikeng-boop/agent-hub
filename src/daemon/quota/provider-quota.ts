import { FETCHED_QUOTA_TIMEOUT_MS, VENDOR_LIST, type AgentVendor } from "../../shared/index.ts";
import { VENDOR_DAEMONS } from "../../vendors/daemon-registry.ts";
import type { VendorRuntimeResolver } from "../provider-manager/runtime-resolver.ts";
import { createFetchedQuota, mergeFetchedQuotas, queryFetchedQuota } from "./fetched-quota.ts";

export function createProviderQuota(runtime: VendorRuntimeResolver) {
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
    close() {
      closed = true;
      for (const source of sources.values()) source.invalidate();
    },
  };
}
