import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { FETCHED_QUOTA_FRESH_MS, type QuotaResponse } from "../shared/index.ts";
import type { HubClient } from "./client.ts";
import { refreshDeviceModels } from "./models.tsx";
import { fetchedQuotaUsage, type QuotaVendor } from "./selectors.ts";
import { useRerenderAt } from "./useRerenderAt.ts";

const EMPTY: QuotaResponse = { groups: [] };
const NO_QUOTA: QuotaVendor[] = [];
const currentQuotaKey = (client: HubClient) => ["current-quota", client.device ?? ""] as const;

export function quotaQueryOptions(client: HubClient, current: boolean) {
  return queryOptions({
    queryKey: current ? currentQuotaKey(client) : ["quota", client.device ?? ""],
    queryFn: ({ signal }) => client.fetchQuota(signal).catch(() => EMPTY),
    staleTime: 0,
  });
}

export function refreshProviderData(qc: QueryClient, client: HubClient) {
  refreshDeviceModels(qc, client);
  const queryKey = currentQuotaKey(client);
  if (qc.getQueryState(queryKey) === undefined) return;
  void qc.resetQueries({ queryKey, exact: true });
}

export function useCurrentQuota(
  qc: QueryClient,
  client: HubClient,
  { enabled, visible }: { enabled: boolean; visible: boolean },
): QuotaVendor[] {
  const { data, dataUpdatedAt } = useQuery({
    ...quotaQueryOptions(client, true),
    enabled,
    refetchOnWindowFocus: visible,
    refetchOnReconnect: visible,
    refetchInterval: visible ? FETCHED_QUOTA_FRESH_MS : false,
  }, qc);
  const expires = dataUpdatedAt + FETCHED_QUOTA_FRESH_MS;
  const resets = useMemo(() => data?.groups.flatMap((g) => Object.values(g.windows).map((w) => w.resetsAt * 1000)) ?? [], [data]);
  const times = useMemo(() => resets.length > 0 ? [expires, ...resets] : [], [resets, expires]);
  useRerenderAt(times);
  const now = Date.now();
  const expired = now >= expires;
  const asOf = resets.reduce((last, t) => t <= now ? Math.max(last, t) : last, 0);
  return useMemo(() => {
    if (!enabled || !data?.groups.length || expired) return NO_QUOTA;
    return fetchedQuotaUsage(data, asOf, true);
  }, [data, asOf, enabled, expired]);
}
