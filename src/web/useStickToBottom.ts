import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** 离底部不到这么多像素算“在底部”，内容变高、新消息来了跟着滚。 */
const STICK_DISTANCE_PX = 80;
/** 滚到离顶部这么近就加载更早的内容。 */
const LOAD_OLDER_DISTANCE_PX = 40;

export interface UseStickToBottomOptions {
  /** 列表末尾身份（新内容来了变它）；打开或变了时，原本贴底或自己刚发的一定滚到底。 */
  lastKey: string | number;
  /** 自己刚发出去的条数（变大时不管在哪都滚到底）。 */
  ownCount: number;
  /** 列表开头身份（更早的内容接到前面后变它）；变了按记录的高度补偿滚动位置。 */
  headKey: string | number;
  /** 能不能继续往上翻页。 */
  canLoadOlder: boolean;
  /** 触发加载更早一页（调用前已自动记下当前 scrollHeight 用于补偿位置）。 */
  onLoadOlder: () => void;
}

/**
 * 贴底与向上翻页滚动控制（MessageList 与 RouterStream 共用，docs/ui-standard.md 第 17、21 条）：
 * 打开、刷新、图片加载完、内容变高或输入框长高时，原本在底部的继续贴底（ResizeObserver），往上翻了就不拉回去并出“回到底部”。
 */
export function useStickToBottom({ lastKey, ownCount, headKey, canLoadOlder, onLoadOlder }: UseStickToBottomOptions) {
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  /** 触发“加载更早”时的内容高度，加载完据此保持原来的位置。 */
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
