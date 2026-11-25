import { notifyManager, QueryClient, QueryClientContext } from "@tanstack/react-query";
import { useContext } from "react";
import type { AccountStatusView, ProjectId } from "../shared/index.ts";
import type { DeviceKey } from "./devices.ts";

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
const ACCOUNT_GENERATION_ID = "account";

export function resetQueryClient(): void {
  queryClient.clear();
}

export function useHubQueryClient(): QueryClient {
  return useContext(QueryClientContext) ?? queryClient;
}

export const taskGraphHistoryKey = (device: DeviceKey, projectId: ProjectId | null) =>
  ["project-task-graphs", device, projectId] as const;

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

function advanceAccountGeneration(state: QueryGeneration): void {
  const next = Math.max(state.gen, state.latest) + 1;
  state.gen = next;
  state.latest = next;
}

export function claimAccountTicket(qc: QueryClient): number {
  const state = queryGenerationOf(qc, ACCOUNT_GENERATION_ID);
  const next = Math.max(state.gen, state.latest) + 1;
  state.latest = next;
  return next;
}

export function commitAccountStatus(qc: QueryClient, ticket: number, next: AccountStatusView): void {
  const state = queryGenerationOf(qc, ACCOUNT_GENERATION_ID);
  if (ticket !== state.latest) return;
  advanceAccountGeneration(state);
  qc.setQueryData<AccountStatusView>(ACCOUNT_QUERY_KEY, next);
}

export function invalidateAccount(qc: QueryClient): Promise<void> {
  advanceAccountGeneration(queryGenerationOf(qc, ACCOUNT_GENERATION_ID));
  return qc.invalidateQueries({ queryKey: ACCOUNT_QUERY_KEY });
}

// Re-fetches inside the active promise when an invalidation arrives before the first response lands (data === undefined).
export function accountQueryFn(qc: QueryClient, fetcher: (signal?: AbortSignal) => Promise<AccountStatusView>) {
  return async ({ signal }: { signal?: AbortSignal } = {}): Promise<AccountStatusView> => {
    const state = queryGenerationOf(qc, ACCOUNT_GENERATION_ID);
    for (;;) {
      const genAtStart = state.gen;
      const fetched = await fetcher(signal);
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      if (genAtStart === state.gen) return fetched;
      const cached = qc.getQueryData<AccountStatusView>(ACCOUNT_QUERY_KEY);
      if (cached !== undefined) return cached;
    }
  };
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
