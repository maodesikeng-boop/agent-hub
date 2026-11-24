import { useEffect, useState, type RefObject } from "react";
import { COMPOSER_SINGLE_ROW_SLACK_PX, COMPOSER_WRAP_PROBE_CHARS } from "./limits.ts";

export const NATIVE_MULTILINE_SIZING = typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content");

interface LineMeasure {
  width: number;
  measure(value: string): number;
}

export function useComposerSoftWrap(probe: RefObject<HTMLDivElement | null>, value: string): boolean {
  const [line, setLine] = useState<LineMeasure | null>(null);
  useEffect(() => {
    const node = probe.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    let context: CanvasRenderingContext2D | null = null;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width <= 0) return;
      const canvas = context ??= document.createElement("canvas").getContext("2d");
      if (!canvas) return;
      const { fontStyle, fontWeight, fontSize, fontFamily } = getComputedStyle(node);
      canvas.font = `${fontStyle} ${fontWeight} ${fontSize} ${fontFamily}`;
      setLine({ width: entry.contentRect.width - COMPOSER_SINGLE_ROW_SLACK_PX, measure: (text) => canvas.measureText(text).width });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [probe]);
  if (line === null || value === "") return false;
  if (value.length > COMPOSER_WRAP_PROBE_CHARS && line.measure(value.slice(0, COMPOSER_WRAP_PROBE_CHARS)) > line.width) return true;
  return line.measure(value) > line.width;
}
