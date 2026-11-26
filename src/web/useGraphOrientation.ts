import { LRUCache } from "lru-cache";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { orientationOf, type GraphOrientation, type MeasureStepText } from "./graph-flow.ts";
import { GRAPH_TEXT_WIDTH_CACHE_MAX } from "./limits.ts";
import { subscribeUiScale } from "./ui-scale.ts";

const DEFAULT_STEP_FONT_SIZE = "13.5px";
const DEFAULT_STEP_FONT_FAMILY = "sans-serif";
const FALLBACK_CHAR_WIDTH_PX = 8;

const textWidthCache = new LRUCache<string, number>({ max: GRAPH_TEXT_WIDTH_CACHE_MAX });
let sharedContext: CanvasRenderingContext2D | null | undefined;

function canvasContext(): CanvasRenderingContext2D | null {
  if (sharedContext !== undefined) return sharedContext;
  if (typeof document === "undefined") {
    sharedContext = null;
    return null;
  }
  try {
    sharedContext = document.createElement("canvas").getContext("2d");
  } catch {
    sharedContext = null;
  }
  return sharedContext;
}

function readProbeFont(probe: HTMLElement | null): { fontSize: string; fontFamily: string } {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") {
    return { fontSize: DEFAULT_STEP_FONT_SIZE, fontFamily: DEFAULT_STEP_FONT_FAMILY };
  }
  const target = probe ?? document.body;
  if (target === null) return { fontSize: DEFAULT_STEP_FONT_SIZE, fontFamily: DEFAULT_STEP_FONT_FAMILY };
  const style = getComputedStyle(target);
  return {
    fontSize: style.fontSize || DEFAULT_STEP_FONT_SIZE,
    fontFamily: style.fontFamily || DEFAULT_STEP_FONT_FAMILY,
  };
}

function measureWidth(title: string, font: string, epoch: number): number {
  const key = `${epoch}\0${font}\0${title}`;
  const cached = textWidthCache.get(key);
  if (cached !== undefined) return cached;
  const ctx = canvasContext();
  let width: number;
  if (ctx !== null) {
    ctx.font = font;
    width = ctx.measureText(title).width;
  } else {
    width = [...title].length * FALLBACK_CHAR_WIDTH_PX;
  }
  textWidthCache.set(key, width);
  return width;
}

function createMeasure(probe: HTMLElement | null, epoch: number): MeasureStepText {
  const { fontSize, fontFamily } = readProbeFont(probe);
  const normalFont = `400 ${fontSize} ${fontFamily}`;
  const emphasisFont = `500 ${fontSize} ${fontFamily}`;
  return (title: string, emphasis: boolean) => measureWidth(title, emphasis ? emphasisFont : normalFont, epoch);
}

export function useStepTextMeasure(probe: HTMLElement | null): MeasureStepText {
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    const invalidate = () => {
      textWidthCache.clear();
      setEpoch((v) => v + 1);
    };
    const unsubscribeScale = subscribeUiScale(invalidate);
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    const onFontsDone = () => invalidate();
    fonts?.addEventListener?.("loadingdone", onFontsDone);
    let cancelled = false;
    if (fonts?.status === "loading" && fonts.ready !== undefined) {
      void fonts.ready.then(() => {
        if (!cancelled) invalidate();
      });
    }
    return () => {
      cancelled = true;
      unsubscribeScale();
      fonts?.removeEventListener?.("loadingdone", onFontsDone);
    };
  }, []);

  return useMemo(() => createMeasure(probe, epoch), [probe, epoch]);
}

function readBoxWidth(box: HTMLElement | null): number {
  if (box === null) return 0;
  const width = box.clientWidth || box.getBoundingClientRect().width;
  return Number.isFinite(width) && width > 0 ? width : 0;
}

export function useGraphOrientation(box: HTMLElement | null, requiredPx: number): GraphOrientation {
  const [availablePx, setAvailablePx] = useState<number>(() => readBoxWidth(box));

  useLayoutEffect(() => {
    if (box === null) {
      setAvailablePx(0);
      return;
    }
    const update = (next: number) => {
      const safe = Number.isFinite(next) && next > 0 ? next : 0;
      setAvailablePx((prev) => (Math.abs(prev - safe) < 0.5 ? prev : safe));
    };
    update(readBoxWidth(box));
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(-1);
      if (entry === undefined) return;
      const w = entry.contentRect.width || readBoxWidth(box);
      update(w);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [box]);

  return orientationOf(requiredPx, availablePx);
}
