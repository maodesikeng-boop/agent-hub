import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { FETCHED_QUOTA_FRESH_MS, FETCHED_QUOTA_RETRY_MS, SLOW_API_REQUEST_TIMEOUT_MS, type QuotaResponse } from "../shared/index.ts";
import type { HubClient } from "./client.ts";
import { refreshDeviceModels } from "./models.tsx";
import { fetchedQuotaUsage, type QuotaVendor } from "./selectors.ts";
import { useRerenderAt } from "./useRerenderAt.ts";

const EMPTY: QuotaResponse = { groups: [] };
const NO_QUOTA: QuotaVendor[] = [];
const quotaKey = (client: HubClient) => ["quota", client.device ?? ""] as const;

function refreshAfter(data: QuotaResponse | undefined): number {
  return data?.groups.length ? FETCHED_QUOTA_FRESH_MS : FETCHED_QUOTA_RETRY_MS;
}

export function refreshProviderData(qc: QueryClient, client: HubClient) {
  refreshDeviceModels(qc, client);
  void qc.resetQueries({ queryKey: quotaKey(client) });
}

export function useFetchedQuota(
  qc: QueryClient,
  client: HubClient,
  { enabled, current }: { enabled: boolean; current: boolean },
) {
  const { data, dataUpdatedAt, isLoading } = useQuery({
    queryKey: [...quotaKey(client), current],
    queryFn: ({ signal }) => client.fetchQuota(signal).catch(() => EMPTY),
    enabled,
    staleTime: 0,
    refetchOnWindowFocus: ({ state }) => Date.now() - state.dataUpdatedAt >= refreshAfter(state.data),
    refetchInterval: ({ state }) => refreshAfter(state.data),
  }, qc);
  const expires = dataUpdatedAt + FETCHED_QUOTA_FRESH_MS + SLOW_API_REQUEST_TIMEOUT_MS;
  const resets = useMemo(() => current ? data?.groups.flatMap((g) => Object.values(g.windows).map((w) => w.resetsAt * 1000)) ?? [] : [], [current, data]);
  const times = useMemo(() => data?.groups.length ? [expires, ...resets] : [], [data, resets, expires]);
  useRerenderAt(times);
  const now = Date.now();
  const expired = now >= expires;
  const asOf = resets.reduce((last, t) => t <= now ? Math.max(last, t) : last, 0);
  const rows = useMemo(() => {
    if (!data?.groups.length || expired) return NO_QUOTA;
    return fetchedQuotaUsage(data, asOf, current);
  }, [data, asOf, current, expired]);
  return useMemo(() => ({ rows, loading: isLoading }), [rows, isLoading]);
}
