import { defaultRangeExtractor, observeElementRect, useVirtualizer, type Range, type Virtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type RefObject } from "react";
import type { MessageId } from "../shared/index.ts";

const ROW_ESTIMATE_PX = 160;
const OVERSCAN_ROWS = 6;
const UNSIZED_VIEWPORT_ROWS = 200;
const HIGHLIGHT_MS = 2_000;

type RowVirtualizer = Virtualizer<HTMLDivElement, Element>;

export interface VirtualRowsOptions {
  scrollRef: RefObject<HTMLDivElement | null>;
  listRef: RefObject<HTMLDivElement | null>;
  count: number;
  getItemKey: (index: number) => string;
  /** Changes whenever content above the list (the load-earlier button) changes height. */
  headLayoutKey: string;
}

export interface VirtualRows {
  virtualizer: RowVirtualizer;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
  onBlur: (event: FocusEvent<HTMLElement>) => void;
}

const tailRange = (count: number) => {
  const start = Math.max(0, count - UNSIZED_VIEWPORT_ROWS);
  return Array.from({ length: count - start }, (_, i) => start + i);
};

const withPinned = (indexes: number[], pinned: number) => (pinned < 0 || indexes.includes(pinned) ? indexes : [...indexes, pinned].sort((a, b) => a - b));

const isAtBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 1;

const rowOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>("[data-index]") : null);

export function useVirtualRows({ scrollRef, listRef, count, getItemKey, headLayoutKey }: VirtualRowsOptions): VirtualRows {
  const [scrollMargin, setScrollMargin] = useState(0);
  // A scroller without layout (jsdom, display: none) reports a zero viewport; render a bounded tail instead of a single row.
  const [unsized, setUnsized] = useState(false);
  // The row holding keyboard focus stays mounted so a half-typed answer survives scrolling away.
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const pinned = useMemo(() => {
    if (focusedKey === null) return -1;
    for (let i = count - 1; i >= 0; i--) if (getItemKey(i) === focusedKey) return i;
    return -1;
  }, [focusedKey, count, getItemKey]);
  const rangeExtractor = useCallback(
    (range: Range) => withPinned(unsized ? tailRange(range.count) : defaultRangeExtractor(range), pinned),
    [unsized, pinned],
  );
  const observeRect = useCallback<typeof observeElementRect>(
    (instance, cb) =>
      observeElementRect(instance, (rect) => {
        setUnsized(rect.height === 0);
        // The virtualizer skips range extraction for a zero viewport, so report one pixel to reach the tail fallback.
        cb(rect.height === 0 ? { width: rect.width, height: 1 } : rect);
      }),
    [],
  );

  const virtualizer = useVirtualizer<HTMLDivElement, Element>({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    getItemKey,
    overscan: OVERSCAN_ROWS,
    scrollMargin,
    anchorTo: "end",
    initialOffset: Number.MAX_SAFE_INTEGER,
    initialRect: { width: 0, height: typeof window === "undefined" ? 0 : window.innerHeight },
    observeElementRect: observeRect,
    rangeExtractor,
  });

  const marginRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const margin = listRef.current?.offsetTop ?? 0;
    const el = scrollRef.current;
    // The virtualizer anchors prepended rows but not a change of the content above the list (the load-earlier button unmounting with the last page).
    if (el && marginRef.current !== null && margin !== marginRef.current && !isAtBottom(el)) el.scrollTop += margin - marginRef.current;
    marginRef.current = margin;
    setScrollMargin(margin);
  }, [scrollRef, listRef, headLayoutKey]);

  const onFocus = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      const row = rowOf(event.target);
      if (row) setFocusedKey(getItemKey(Number(row.dataset.index)));
    },
    [getItemKey],
  );
  const onBlur = useCallback((event: FocusEvent<HTMLElement>) => {
    if (rowOf(event.relatedTarget) !== rowOf(event.target)) setFocusedKey(null);
  }, []);

  return { virtualizer, onFocus, onBlur };
}

const centerBehavior = (): ScrollBehavior =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";

export interface FocusOptions {
  scrollRef: RefObject<HTMLDivElement | null>;
  virtualizer: RowVirtualizer;
  focus: { id: MessageId; n: number } | null | undefined;
  onFocusDone: (() => void) | undefined;
  indexOf: (id: MessageId) => number;
}

/** Centers and highlights the focused message, scrolling an unmounted row into the window first. */
export function useFocusMessage({ scrollRef, virtualizer, focus, onFocusDone, indexOf }: FocusOptions): MessageId | null {
  const [highlightId, setHighlightId] = useState<MessageId | null>(null);
  const [seeking, setSeeking] = useState<MessageId | null>(null);
  const find = useCallback((id: MessageId) => scrollRef.current?.querySelector(`[data-message-id="${id}"]`) ?? null, [scrollRef]);

  const jump = useEffectEvent((id: MessageId) => {
    const el = find(id);
    if (el) el.scrollIntoView({ block: "center", behavior: centerBehavior() });
    else {
      const index = indexOf(id);
      if (index >= 0) {
        virtualizer.scrollToIndex(index, { align: "center" });
        setSeeking(id);
      }
    }
    setHighlightId(id);
    onFocusDone?.();
  });
  useEffect(() => {
    if (focus) jump(focus.id);
  }, [focus]);

  useEffect(() => {
    const el = seeking === null ? null : find(seeking);
    const row = rowOf(el);
    const start = row === null ? undefined : virtualizer.getVirtualItems().find((item) => item.index === Number(row.dataset.index))?.start;
    if (!el || !row || start === undefined) return;
    // Rows mounted this commit are measured but not yet repositioned, so the row start comes from the virtualizer; the offset command also stops scrollToIndex from re-centering a whole tall turn.
    const box = el.getBoundingClientRect();
    virtualizer.scrollToOffset(start + box.top - row.getBoundingClientRect().top + box.height / 2, { align: "center" });
    setSeeking(null);
  });

  useEffect(() => {
    if (highlightId === null) return;
    const timer = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightId]);

  return highlightId;
}
