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
  const { data, dataUpdatedAt, isFetching } = useQuery({
    queryKey: [...quotaKey(client), current],
    queryFn: ({ signal }) => client.fetchQuota(signal).catch(() => EMPTY),
    enabled,
    staleTime: ({ state }) => refreshAfter(state.data),
    refetchOnWindowFocus: true,
    refetchInterval: ({ state }) => refreshAfter(state.data),
  }, qc);
  const expires = dataUpdatedAt + FETCHED_QUOTA_FRESH_MS + SLOW_API_REQUEST_TIMEOUT_MS;
  const resets = useMemo(() => current ? data?.groups.flatMap((g) => Object.values(g.windows).map((w) => w.resetsAt * 1000)) ?? [] : [], [current, data]);
  const times = useMemo(() => enabled && data?.groups.length ? [expires, ...resets] : [], [enabled, data, resets, expires]);
  useRerenderAt(times);
  const now = Date.now();
  const expired = now >= expires;
  const asOf = resets.reduce((last, t) => t <= now ? Math.max(last, t) : last, 0);
  const rows = useMemo(() => {
    if (!enabled || !data?.groups.length || expired) return NO_QUOTA;
    return fetchedQuotaUsage(data, asOf, current);
  }, [data, asOf, current, enabled, expired]);
  const loading = isFetching && rows.length === 0;
  return useMemo(() => ({ rows, loading }), [rows, loading]);
}
