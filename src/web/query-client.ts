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

export interface QueryGeneration {
  gen: number;
  latest: number;
}

const generations = new WeakMap<QueryClient, Map<string, QueryGeneration>>();

// Ordering uses a local counter shared per (QueryClient, id) rather than server stamps or per-component refs, so every mounted editor of one entity agrees on what is newer.
export function queryGenerationOf(qc: QueryClient, id: string): QueryGeneration {
  let byId = generations.get(qc);
  if (byId === undefined) {
    byId = new Map();
    generations.set(qc, byId);
  }
  let state = byId.get(id);
  if (state === undefined) {
    state = { gen: 0, latest: 0 };
    byId.set(id, state);
  }
  return state;
}

// An automatic GET that overlapped a newer write yields to the cached value instead of replacing it.
export function guardedQueryFn<T>(qc: QueryClient, id: string, queryKey: readonly unknown[], fetcher: () => Promise<T>): () => Promise<T> {
  return async () => {
    const state = queryGenerationOf(qc, id);
    const genAtStart = state.gen;
    const fetched = await fetcher();
    return genAtStart === state.gen ? fetched : (qc.getQueryData<T>(queryKey) ?? fetched);
  };
}
