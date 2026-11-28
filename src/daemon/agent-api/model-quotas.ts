import type { QuotaResponse } from "../../shared/api.ts";
import type { HubVendorQuota } from "../../shared/hub.ts";
import { HUB_MODELS_QUOTA_WAIT_MS, HUB_MODELS_REFRESH_QUOTA_WAIT_MS } from "../../shared/limits.ts";
import { AGENT_VENDORS, type AgentVendor } from "../../shared/vendors.ts";
import { mergeVendorQuota, type ObservedQuotaStore } from "../quota/observed-quota.ts";
import type { ProviderQuota } from "../quota/provider-quota.ts";
import { unlessAborted } from "../sent-files.ts";

export interface AgentApiQuotaOptions {
  observed: ObservedQuotaStore;
  get(): Promise<QuotaResponse>;
  getSnapshot?: ProviderQuota["getSnapshot"];
  now?: () => number;
}

export async function prepareModelQuotas(
  quota: AgentApiQuotaOptions | undefined,
  vendor: AgentVendor | undefined,
  refresh: boolean,
  signal: AbortSignal,
): Promise<Partial<Record<AgentVendor, HubVendorQuota>> | undefined> {
  if (quota === undefined) return undefined;
  const timeoutMs = refresh ? HUB_MODELS_REFRESH_QUOTA_WAIT_MS : HUB_MODELS_QUOTA_WAIT_MS;
  const vendors = vendor === undefined ? AGENT_VENDORS : [vendor];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let fetched: QuotaResponse | null = null;
    let probedAt: Partial<Record<AgentVendor, number>> = {};
    if (quota.getSnapshot) {
      const snap = await unlessAborted(
        quota.getSnapshot({
          ...(vendor ? { vendor } : {}),
          ...(refresh ? { refresh: true } : {}),
          timeoutMs,
        }).catch(() => null),
        signal,
        () => null,
      );
      if (snap !== null) {
        fetched = snap.response;
        probedAt = snap.probedAt;
      }
    } else {
      fetched = await unlessAborted(Promise.race([
        quota.get().catch(() => null),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
      ]), signal, () => null);
    }
    const at = (quota.now ?? Date.now)();
    if (fetched !== null) {
      for (const v of vendors) {
        const startedAt = probedAt[v];
        if (startedAt !== undefined) quota.observed.reconcileFetched(v, fetched, startedAt, at);
      }
    }
    const observed = quota.observed.snapshot(at);
    return Object.fromEntries(vendors.flatMap((v) => {
      const entry = mergeVendorQuota(v, observed[v] ?? null, fetched, at, probedAt[v]);
      return entry === undefined ? [] : [[v, entry]];
    }));
  } finally {
    clearTimeout(timer);
  }
}
