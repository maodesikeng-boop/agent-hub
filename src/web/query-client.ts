import { notifyManager, QueryClient, QueryClientContext } from "@tanstack/react-query";
import { useContext } from "react";

notifyManager.setScheduler(queueMicrotask);

const DEFAULT_QUERY_STALE_TIME_MS = 30_000;
const DEFAULT_QUERY_GC_TIME_MS = 5 * 60_000;

function createHubQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: DEFAULT_QUERY_STALE_TIME_MS,
        gcTime: DEFAULT_QUERY_GC_TIME_MS,
        retry: false,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

export const queryClient: QueryClient = createHubQueryClient();

export const ACCOUNT_QUERY_KEY = ["account"] as const;

export function resetQueryClient(): void {
  queryClient.clear();
}

export function useHubQueryClient(): QueryClient {
  return useContext(QueryClientContext) ?? queryClient;
}
