import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { CompletedCursor, CompletedWorkPage, PmId } from "../shared/index.ts";
import { useClient } from "./device-scope.tsx";
import { LOCAL_DEVICE } from "./devices.ts";
import { COMPLETED_WORK_MAX_PAGES } from "./limits.ts";
import { completedWorkKey, useHubQueryClient } from "./query-client.ts";
import { completedDaysOf, type CompletedDay } from "./work-panel-model.ts";

export interface CompletedWorkQuery {
  days: readonly CompletedDay[];
  /** Server total from the newest page, or null before the first page arrives. */
  total: number | null;
  status: "loading" | "error" | "ready";
  error: unknown;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  retry: () => void;
}

const EMPTY_DAYS: readonly CompletedDay[] = [];
const EMPTY_PAGES: readonly CompletedWorkPage[] = [];
const NOOP = () => {};
const NO_COMPLETED_WORK: CompletedWorkQuery = {
  days: EMPTY_DAYS,
  total: null,
  status: "ready",
  error: null,
  hasMore: false,
  loadingMore: false,
  loadMore: NOOP,
  retry: NOOP,
};

export function completedWorkQueryKey(device: string | null, pmId: PmId | null) {
  return completedWorkKey(device ?? LOCAL_DEVICE, pmId);
}

export function useCompletedWork(pmId: PmId | null, enabled: boolean): CompletedWorkQuery {
  const client = useClient();
  const qc = useHubQueryClient();
  const queryKey = useMemo(() => completedWorkQueryKey(client.device, pmId), [client.device, pmId]);

  const query = useInfiniteQuery(
    {
      queryKey,
      queryFn: ({ pageParam, signal }) => client.fetchCompletedWork(pmId!, pageParam, signal),
      initialPageParam: null as CompletedCursor | null,
      getNextPageParam: (lastPage, allPages) =>
        lastPage.next !== null && allPages.length < COMPLETED_WORK_MAX_PAGES ? lastPage.next : undefined,
      maxPages: COMPLETED_WORK_MAX_PAGES,
      enabled: enabled && pmId !== null,
    },
    qc,
  );

  const pages = query.data?.pages ?? EMPTY_PAGES;
  const days = useMemo(() => (pages.length === 0 ? EMPTY_DAYS : completedDaysOf(pages)), [pages]);
  const total = pages.length > 0 ? pages[0]!.total : null;
  const hasMore = Boolean(query.hasNextPage) && pages.length < COMPLETED_WORK_MAX_PAGES;
  const { fetchNextPage, refetch, isFetchingNextPage, isFetchNextPageError } = query;

  const loadMore = useCallback(() => {
    if (pmId === null || !hasMore || isFetchingNextPage || isFetchNextPageError) return;
    void fetchNextPage();
  }, [pmId, hasMore, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

  const retry = useCallback(() => {
    if (pmId === null) return;
    if (pages.length > 0 && isFetchNextPageError) {
      void fetchNextPage();
      return;
    }
    void refetch();
  }, [pmId, pages.length, isFetchNextPageError, fetchNextPage, refetch]);

  const status: CompletedWorkQuery["status"] =
    pages.length > 0 ? "ready" : query.isError ? "error" : query.isPending ? "loading" : "ready";
  const error = query.error ?? null;

  return useMemo(
    () => pmId === null ? NO_COMPLETED_WORK : {
      days, total, status, error, hasMore, loadingMore: isFetchingNextPage, loadMore, retry,
    },
    [pmId, days, total, status, error, hasMore, isFetchingNextPage, loadMore, retry],
  );
}
