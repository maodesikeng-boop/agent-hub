import { useInfiniteQuery, type InfiniteData } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { CompletedCursor, CompletedWorkPage, PmId } from "../shared/index.ts";
import { useClient } from "./device-scope.tsx";
import { COMPLETED_WORK_MAX_PAGES } from "./limits.ts";
import { useHubQueryClient } from "./query-client.ts";
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

export function completedWorkQueryKey(device: string | null, pmId: PmId | null) {
  return ["completed-work", device, pmId] as const;
}

export function useCompletedWork(pmId: PmId | null, enabled: boolean, finishSignal?: string): CompletedWorkQuery {
  const client = useClient();
  const qc = useHubQueryClient();
  const queryKey = useMemo(() => completedWorkQueryKey(client.device, pmId), [client.device, pmId]);

  const query = useInfiniteQuery(
    {
      queryKey,
      queryFn: ({ pageParam }) => client.fetchCompletedWork(pmId!, pageParam),
      initialPageParam: null as CompletedCursor | null,
      getNextPageParam: (lastPage, allPages) =>
        lastPage.next !== null && allPages.length < COMPLETED_WORK_MAX_PAGES ? lastPage.next : undefined,
      maxPages: COMPLETED_WORK_MAX_PAGES,
      enabled: enabled && pmId !== null,
    },
    qc,
  );

  // Refetch from the first page when an active graph or Worker of this PM finishes.
  const prevSignalRef = useRef<{ pmId: PmId | null; device: string | null; signal: string | undefined }>({
    pmId,
    device: client.device,
    signal: finishSignal,
  });
  useEffect(() => {
    const prev = prevSignalRef.current;
    prevSignalRef.current = { pmId, device: client.device, signal: finishSignal };
    if (pmId === null || !enabled) return;
    if (prev.pmId !== pmId || prev.device !== client.device) return;
    if (finishSignal === undefined || prev.signal === undefined || prev.signal === finishSignal) return;
    qc.setQueryData<InfiniteData<CompletedWorkPage, CompletedCursor | null>>(queryKey, (existing) =>
      existing === undefined || existing.pages.length <= 1
        ? existing
        : { pages: existing.pages.slice(0, 1), pageParams: existing.pageParams.slice(0, 1) },
    );
    void qc.invalidateQueries({ queryKey, exact: true });
  }, [pmId, client.device, enabled, finishSignal, qc, queryKey]);

  const pages = query.data?.pages ?? EMPTY_PAGES;
  const days = useMemo(() => (pages.length === 0 ? EMPTY_DAYS : completedDaysOf(pages, Date.now())), [pages]);
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

  if (pmId === null) {
    return {
      days: EMPTY_DAYS,
      total: null,
      status: "ready",
      error: null,
      hasMore: false,
      loadingMore: false,
      loadMore: NOOP,
      retry: NOOP,
    };
  }

  const status: CompletedWorkQuery["status"] =
    pages.length > 0 ? "ready" : query.isError ? "error" : query.isPending ? "loading" : "ready";

  return {
    days,
    total,
    status,
    error: query.error ?? null,
    hasMore,
    loadingMore: isFetchingNextPage,
    loadMore,
    retry,
  };
}
