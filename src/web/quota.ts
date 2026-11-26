import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { FETCHED_QUOTA_FRESH_MS, FETCHED_QUOTA_RETRY_MS, type QuotaResponse } from "../shared/index.ts";
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

function fetchedQuotaOptions(client: HubClient, current: boolean) {
  return queryOptions({
    queryKey: [...quotaKey(client), current],
    queryFn: ({ signal }) => client.fetchQuota(signal).catch(() => EMPTY),
    staleTime: ({ state }) => refreshAfter(state.data),
  });
}

export function refreshProviderData(qc: QueryClient, client: HubClient) {
  refreshDeviceModels(qc, client);
  void qc.resetQueries({ queryKey: quotaKey(client) });
}

export function useFetchedQuota(
  qc: QueryClient,
  client: HubClient,
  { enabled, current, preload = false }: { enabled: boolean; current: boolean; preload?: boolean },
) {
  const options = useMemo(() => fetchedQuotaOptions(client, current), [client, current]);
  const { data, isFetching } = useQuery({
    ...options,
    enabled,
    refetchOnWindowFocus: enabled,
    refetchOnReconnect: enabled,
    refetchInterval: ({ state }) => enabled ? refreshAfter(state.data) : false,
  }, qc);
  useEffect(() => {
    if (preload && qc.getQueryData(options.queryKey) === undefined) void qc.prefetchQuery(options);
  }, [options, preload, qc]);
  const resets = useMemo(() => data?.groups.flatMap((g) => Object.values(g.windows).map((w) => w.resetsAt * 1000)) ?? [], [data]);
  useRerenderAt(resets);
  const now = Date.now();
  const asOf = resets.reduce((last, t) => t <= now ? Math.max(last, t) : last, 0);
  const rows = useMemo(() => {
    if (!data?.groups.length) return NO_QUOTA;
    return fetchedQuotaUsage(data, asOf, current);
  }, [data, asOf, current]);
  // A settled empty response can stay visible during retries. Expired rows still need a replacement.
  const loading = isFetching && rows.length === 0 && data?.groups.length !== 0;
  return useMemo(() => ({ rows, loading }), [rows, loading]);
}
