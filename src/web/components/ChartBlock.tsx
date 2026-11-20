import { AlertCircle, ChartNetwork, Code, Loader2, Maximize2 } from "../ui/icons.ts";
import { memo, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { chartCache, chartCacheKey, type ChartCacheEntry } from "../charts/cache.ts";
import {
  CHART_MAX_SOURCE_CHARS,
  CHART_MIN_HEIGHT,
  CHART_MIN_INLINE_FONT_PX,
  CHART_VIEWPORT_MARGIN,
  ChartLoadError,
  chartRendererOf,
  renderChart,
  type ChartRendered,
} from "../charts/registry.ts";
import { chartTheme } from "../charts/theme.ts";
import { cn } from "../lib/utils.ts";
import { Dialog, DialogBody, DialogContent, ZOOM_DIALOG } from "../ui/dialog.tsx";
import { BarButton, CodeBody, CodeView, CopyCodeButton } from "./CodeBlock.tsx";

const TOO_LONG_TEXT = `Chart source is too long (over ${CHART_MAX_SOURCE_CHARS.toLocaleString("en-US")} characters), not rendered`;

function useNearViewport(ref: { current: Element | null }, enabled: boolean): boolean {
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (near || !enabled || el === null) return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { rootMargin: `${CHART_VIEWPORT_MARGIN}px` });
    observer.observe(el);
    return () => observer.disconnect();
  }, [near, enabled, ref]);
  return near;
}

const ZOOM_MAX_SCALE = 2.5;

function ZoomedSvg({ svg }: { svg: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (host === null) return;
    host.innerHTML = svg;
    const el = host.querySelector("svg");
    const box = el?.viewBox.baseVal;
    if (el === null || box === undefined || box.width === 0) return;
    el.setAttribute("width", String(box.width));
    el.setAttribute("height", String(box.height));
    el.style.maxHeight = "none";
    el.style.width = `${box.width * ZOOM_MAX_SCALE}px`;
    el.style.maxWidth = "100%";
    el.style.height = "auto";
    host.style.width = `${box.width * ZOOM_MAX_SCALE}px`;
  }, [svg]);
  return <div ref={ref} data-chart-zoomed className="mx-auto max-w-full" />;
}

const firstLine = (message: string) => message.split("\n", 1)[0]!.trim();

function FailedChart({ language, source, message }: { language: string; source: string; message: string }) {
  return (
    <div data-chart-failed className="md-chart-failed">
      <div data-chart-error title={message} className="mb-1.5 flex items-center gap-2 text-minor text-danger">
        <AlertCircle className="size-pixel-sm shrink-0" />
        <span className="truncate">{firstLine(message)}</span>
      </div>
      <CodeView code={source} language={language} />
    </div>
  );
}

export const ChartBlock = memo(function ChartBlock({ language, source }: { language: string; source: string }) {
  const renderer = chartRendererOf(language);
  const tooLong = source.length > CHART_MAX_SOURCE_CHARS;
  const theme = useMemo(chartTheme, []);
  const key = chartCacheKey(language, source, theme.version);
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [zoomed, setZoomed] = useState(false);

  const entry: ChartCacheEntry | undefined = tooLong ? { ok: false, message: TOO_LONG_TEXT } : chartCache.get(key);
  const shell = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const painted = useRef<string | null>(null);
  const disposeLive = useRef<ChartRendered["dispose"]>(undefined);

  const near = useNearViewport(shell, entry === undefined && !loadFailed);
  const loading = near && entry === undefined && !loadFailed;

  useLayoutEffect(() => {
    if (entry?.ok !== true) {
      painted.current = null;
      return;
    }
    if (host.current !== null && painted.current !== key) {
      host.current.innerHTML = entry.svg;
      painted.current = key;
    }
  });

  useEffect(() => {
    if (renderer === undefined || tooLong || !near || entry !== undefined || host.current === null) return;
    let cancelled = false;
    renderChart(renderer, source, theme, host.current).then(
      (result) => {
        chartCache.set(key, { ok: true, svg: result.svg });
        if (cancelled) {
          result.dispose?.();
          return;
        }
        disposeLive.current?.();
        disposeLive.current = result.dispose;
        painted.current = key;
        refresh();
      },
      (error: unknown) => {
        if (error instanceof ChartLoadError) {
          if (!cancelled) setLoadFailed(true);
          return;
        }
        chartCache.set(key, { ok: false, message: error instanceof Error ? error.message : String(error) });
        if (!cancelled) refresh();
      },
    );
    return () => {
      cancelled = true;
    };
  }, [near, key]);

  useLayoutEffect(() => {
    const svg = host.current?.querySelector("svg");
    const width = svg?.viewBox?.baseVal?.width ?? 0;
    if (svg && width > 0) svg.style.minWidth = `${Math.floor((width * CHART_MIN_INLINE_FONT_PX) / theme.fontSize)}px`;
  });

  useEffect(() => () => disposeLive.current?.(), []);

  if (renderer === undefined) return <CodeView code={source} language={language} />;
  if (loadFailed) return <FailedChart language={language} source={source} message={new ChartLoadError(undefined).message} />;
  if (entry?.ok === false) return <FailedChart language={language} source={source} message={entry.message} />;

  const ok = entry?.ok === true;
  const ToggleIcon = showSource ? ChartNetwork : Code;
  return (
    <>
      <div ref={shell} data-chart data-chart-language={language} className="md-code md-chart">
        <div className="md-code-bar">
          <span data-chart-lang className="md-code-lang">
            {language}
          </span>
          <BarButton aria-label="View source" aria-pressed={showSource} onClick={() => setShowSource((v) => !v)}>
            <ToggleIcon className="size-3.5" />
          </BarButton>
          {ok && !showSource && (
            <BarButton aria-label="Zoom" onClick={() => setZoomed(true)}>
              <Maximize2 className="size-pixel-sm" />
            </BarButton>
          )}
          <CopyCodeButton code={source} />
        </div>
        {showSource && (
          <div data-chart-source>
            <CodeBody code={source} language={renderer.sourceLanguage} />
          </div>
        )}
        <div
          data-chart-body
          hidden={showSource}
          onClick={ok && renderer.zoomOnClick ? () => setZoomed(true) : undefined}
          style={ok ? undefined : { minHeight: CHART_MIN_HEIGHT }}
          className={cn("md-chart-body", ok && renderer.zoomOnClick && "cursor-zoom-in")}
        >
          <div ref={host} data-chart-host />
          {loading && (
            <div data-chart-loading className="absolute inset-0 flex items-center justify-center text-muted-foreground">
              <Loader2 className="size-pixel" aria-hidden="true" />
            </div>
          )}
        </div>
      </div>
      {entry?.ok === true && (
        <Dialog open={zoomed} onOpenChange={setZoomed}>
          <DialogContent title="Chart" className={cn(ZOOM_DIALOG, "w-[min(96vw,1400px)]")}>
            <DialogBody className="overflow-auto">
              <ZoomedSvg svg={entry.svg} />
            </DialogBody>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
});
