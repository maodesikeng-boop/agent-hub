import { defaultRangeExtractor, observeElementRect, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";
import type { CompletedWorkItem, ConversationId } from "../../shared/index.ts";
import { cleanWorkerTitle, errorLine, errorText, errorTitle } from "../format.ts";
import { completedFlowOf } from "../graph-flow.ts";
import { MINUTE_TICK_MS } from "../limits.ts";
import { cn } from "../lib/utils.ts";
import { Loader2 } from "../ui/icons.ts";
import type { CompletedWorkQuery } from "../useCompletedWork.ts";
import { useNow } from "../useNow.ts";
import { completedDayLabel, completedKeyOf, prLabelOf, type CompletedDay } from "../work-panel-model.ts";
import { completedWorkStatusOf } from "../work-status.ts";
import { GraphCanvas } from "./GraphCanvas.tsx";
import { WorkStatusIcon } from "./WorkStatusIcon.tsx";

export interface CompletedTabProps {
  query: CompletedWorkQuery;
  onOpenWorker: (id: ConversationId) => void;
}

type FlatRow =
  | { kind: "day"; key: string; day: CompletedDay; isFirst: boolean }
  | { kind: "item"; key: string; item: CompletedWorkItem; isExpanded: boolean }
  | { kind: "footer-error"; key: string }
  | { kind: "footer-loading"; key: string };

const OVERSCAN_ROWS = 8;
const LOAD_MORE_THRESHOLD_ROWS = 4;
const LOAD_MORE_SCROLL_PX = 160;
const UNSIZED_VIEWPORT_ROWS = 200;

const pad2 = (n: number) => String(n).padStart(2, "0");

function DayLabel({ dayStart }: { dayStart: number }) {
  return completedDayLabel(dayStart, useNow(MINUTE_TICK_MS));
}

function formatClockTime(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function headRange(count: number): number[] {
  const len = Math.min(count, UNSIZED_VIEWPORT_ROWS);
  return Array.from({ length: len }, (_, i) => i);
}

function estimateRowHeight(row: FlatRow): number {
  if (row.kind === "day") return row.isFirst ? 36 : 44;
  if (row.kind === "footer-error" || row.kind === "footer-loading") return 40;
  if (row.item.kind === "graph" && row.isExpanded) {
    return 30 + row.item.steps.length * 28 + 16;
  }
  return 30;
}

const CompletedItemRow = memo(function CompletedItemRow({
  item,
  isExpanded,
  onToggleGraph,
  onOpenWorker,
}: {
  item: CompletedWorkItem;
  isExpanded: boolean;
  onToggleGraph: (key: string) => void;
  onOpenWorker: (id: ConversationId) => void;
}) {
  const key = completedKeyOf(item);
  const status = completedWorkStatusOf(item);
  const cancelled = status === "cancelled";
  const displayTitle = item.kind === "worker" ? cleanWorkerTitle(item.title) : item.title;
  const prLabel = prLabelOf(item.prUrl);
  const clockTime = formatClockTime(item.finishedAt);
  const expandedFlow = useMemo(
    () => (item.kind === "graph" && isExpanded ? completedFlowOf(item) : null),
    [item, isExpanded],
  );

  const handleActivate = () => {
    if (item.kind === "graph") onToggleGraph(key);
    else onOpenWorker(item.conversationId);
  };

  return (
    <div>
      <div
        data-completed-key={key}
        data-cancelled={cancelled || undefined}
        data-expanded={isExpanded || undefined}
        className="work-completed-row h-7.5 pointer-coarse:min-h-11"
        onClick={(event) => {
          if ((event.target as Element).closest("a, button") !== null) return;
          handleActivate();
        }}
      >
        <button
          type="button"
          aria-expanded={item.kind === "graph" ? isExpanded : undefined}
          aria-label={`${displayTitle}, ${cancelled ? "cancelled" : "done"}`}
          title={item.title}
          onClick={handleActivate}
          className="work-completed-trigger"
        >
          <WorkStatusIcon status={status} />
          <span
            className={cn("min-w-0 flex-1 truncate text-left text-minor", cancelled ? "work-completed-title-cancelled" : "work-completed-title")}
            title={item.title}
          >
            {displayTitle}
          </span>
        </button>
        {prLabel !== null && item.prUrl !== null && (
          <a
            href={item.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="work-completed-pr shrink-0 text-xs tabular-nums"
          >
            {prLabel}
          </a>
        )}
        <time dateTime={new Date(item.finishedAt).toISOString()} className="work-completed-time shrink-0 text-xs tabular-nums">
          {clockTime}
        </time>
      </div>
      {expandedFlow !== null && (
        <div className="work-completed-exp">
          <GraphCanvas flow={expandedFlow} orientation="vertical" paper={false} />
        </div>
      )}
    </div>
  );
});

export const CompletedTab = memo(function CompletedTab({ query, onOpenWorker }: CompletedTabProps): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [unsized, setUnsized] = useState(false);

  const toggleGraph = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const rows = useMemo<FlatRow[]>(() => {
    const list: FlatRow[] = [];
    query.days.forEach((day, dayIndex) => {
      list.push({ kind: "day", key: `day:${day.dayStart}`, day, isFirst: dayIndex === 0 });
      for (const item of day.items) {
        const key = completedKeyOf(item);
        list.push({ kind: "item", key, item, isExpanded: item.kind === "graph" && expandedKeys.has(key) });
      }
    });
    if (query.error !== null && query.days.length > 0) {
      list.push({ kind: "footer-error", key: "footer:error" });
    } else if (query.loadingMore) {
      list.push({ kind: "footer-loading", key: "footer:loading" });
    }
    return list;
  }, [query.days, query.error, query.loadingMore, expandedKeys]);

  const getItemKey = useCallback((index: number) => rows[index]!.key, [rows]);
  const estimateSize = useCallback((index: number) => estimateRowHeight(rows[index]!), [rows]);
  const rangeExtractor = useCallback(
    (range: Range) => (unsized ? headRange(range.count) : defaultRangeExtractor(range)),
    [unsized],
  );
  const observeRect = useCallback<typeof observeElementRect>(
    (instance, cb) =>
      observeElementRect(instance, (rect) => {
        setUnsized(rect.height === 0);
        cb(rect.height === 0 ? { width: rect.width, height: 1 } : rect);
      }),
    [],
  );

  const virtualizer = useVirtualizer<HTMLDivElement, Element>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    overscan: OVERSCAN_ROWS,
    initialRect: { width: 640, height: typeof window === "undefined" ? 0 : window.innerHeight },
    observeElementRect: observeRect,
    rangeExtractor,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const lastVisibleIndex = virtualItems.at(-1)?.index ?? -1;

  useEffect(() => {
    if (
      query.status === "ready" &&
      query.hasMore &&
      !query.loadingMore &&
      query.error === null &&
      rows.length > 0 &&
      lastVisibleIndex >= rows.length - LOAD_MORE_THRESHOLD_ROWS
    ) {
      query.loadMore();
    }
  }, [query, rows.length, lastVisibleIndex]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el === null || !query.hasMore || query.loadingMore || query.error !== null) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= LOAD_MORE_SCROLL_PX) {
      query.loadMore();
    }
  }, [query]);

  if (query.status === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 px-5 py-8 text-minor work-panel-muted">
        <Loader2 className="size-pixel-md" aria-hidden="true" />
        <span>Loading…</span>
      </div>
    );
  }

  if (query.status === "error") {
    const info = errorText(query.error);
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-5 py-8 text-center">
        <p role="alert" title={errorTitle(info)} className="text-minor text-danger">
          {errorLine(info)}
        </p>
        <button type="button" onClick={query.retry} className="work-retry-btn touch-target text-minor font-medium">
          Retry
        </button>
      </div>
    );
  }

  if (query.days.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-5 py-8 text-minor work-panel-muted">
        Nothing completed yet
      </div>
    );
  }

  const nextErrorInfo = query.error !== null ? errorText(query.error) : null;

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="right-rail-scroll work-panel-scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain [contain:layout_style]"
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualItems.map((virtualRow) => {
          const row = rows[virtualRow.index]!;
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {row.kind === "day" && (
                <div className={cn("work-day-header", !row.isFirst && "work-day-header-divider")}>
                  <span><DayLabel dayStart={row.day.dayStart} /></span>
                  <span className="tabular-nums">{row.day.items.length}</span>
                </div>
              )}
              {row.kind === "item" && (
                <CompletedItemRow
                  item={row.item}
                  isExpanded={row.isExpanded}
                  onToggleGraph={toggleGraph}
                  onOpenWorker={onOpenWorker}
                />
              )}
              {row.kind === "footer-loading" && (
                <div className="flex items-center justify-center gap-2 py-3 text-minor work-panel-muted">
                  <Loader2 className="size-pixel-sm" aria-hidden="true" />
                  <span>Loading…</span>
                </div>
              )}
              {row.kind === "footer-error" && nextErrorInfo !== null && (
                <div className="flex items-center justify-between gap-3 py-2.5">
                  <p role="alert" title={errorTitle(nextErrorInfo)} className="min-w-0 truncate text-minor text-danger">
                    {errorLine(nextErrorInfo)}
                  </p>
                  <button type="button" onClick={query.retry} className="work-retry-btn touch-target shrink-0 text-minor font-medium">
                    Retry
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
