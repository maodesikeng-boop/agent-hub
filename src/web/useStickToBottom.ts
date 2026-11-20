import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const STICK_DISTANCE_PX = 80;
const LOAD_OLDER_DISTANCE_PX = 40;

export interface UseStickToBottomOptions {
  lastKey: string | number;
  ownCount: number;
  headKey: string | number;
  canLoadOlder: boolean;
  onLoadOlder: () => void;
}

export function useStickToBottom({ lastKey, ownCount, headKey, canLoadOlder, onLoadOlder }: UseStickToBottomOptions) {
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const anchorHeight = useRef<number | null>(null);
  const prevOwnCount = useRef(ownCount);

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    stick.current = true;
    setAway(false);
  }, []);

  useLayoutEffect(() => {
    const own = ownCount > prevOwnCount.current;
    prevOwnCount.current = ownCount;
    if (stick.current || own) scrollToBottom();
    else setAway(true);
  }, [lastKey, ownCount, scrollToBottom]);

  useEffect(() => {
    const el = ref.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(content);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && anchorHeight.current !== null) {
      el.scrollTop += el.scrollHeight - anchorHeight.current;
      anchorHeight.current = null;
    }
  }, [headKey]);

  const loadOlder = useCallback(() => {
    anchorHeight.current = ref.current?.scrollHeight ?? null;
    onLoadOlder();
  }, [onLoadOlder]);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_DISTANCE_PX;
    stick.current = nearBottom;
    setAway(!nearBottom);
    if (canLoadOlder && el.scrollTop < LOAD_OLDER_DISTANCE_PX) loadOlder();
  }, [canLoadOlder, loadOlder]);

  return { ref, contentRef, away, scrollToBottom, loadOlder, onScroll };
}
