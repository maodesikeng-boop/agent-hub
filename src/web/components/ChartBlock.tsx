// 图表块（docs/charts-diagrams-design.md）：```mermaid / ```vega-lite 闭合后的外壳。
// 和代码块同一个外壳（.md-code），正文换成图；工具条：语言名、源码/图切换、放大、复制。
// 引擎按需加载（charts/registry.ts），进视口才排队渲染，结果进缓存；失败显示成普通代码块 + 上方一行错误。
import { AlertCircle, ChartNetwork, Code, Loader2, Maximize2 } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { chartCache, chartCacheKey, type ChartCacheEntry } from "../charts/cache.ts";
import {
  CHART_MAX_SOURCE_CHARS,
  CHART_MIN_HEIGHT,
  CHART_VIEWPORT_MARGIN,
  ChartLoadError,
  chartRendererOf,
  renderChart,
  type ChartRendered,
} from "../charts/registry.ts";
import { chartTheme } from "../charts/theme.ts";
import { cn } from "../lib/utils.ts";
import { Dialog, DialogBody, DialogContent } from "../ui/dialog.tsx";
import { BarButton, CodeBody, CodeView, CopyCodeButton } from "./CodeBlock.tsx";

const TOO_LONG_TEXT = `图表源码太长（超过 ${CHART_MAX_SOURCE_CHARS.toLocaleString("en-US")} 字），没有渲染`;

/** 离视口 CHART_VIEWPORT_MARGIN 以内才返回 true，之后一直是 true。没有 IntersectionObserver 的环境当作一直在视口里。 */
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

/** 放大窗里的原尺寸图：按 viewBox 还原宽高，不再按列宽缩放、不限高；窗口放不下就两个方向滚动。 */
function ZoomedSvg({ svg }: { svg: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (host === null) return;
    host.innerHTML = svg;
    const el = host.querySelector("svg");
    const box = el?.viewBox.baseVal;
    if (el === null || box === undefined || box.width === 0) return;
    el.style.maxWidth = "none";
    el.style.maxHeight = "none";
    el.setAttribute("width", String(box.width));
    el.setAttribute("height", String(box.height));
  }, [svg]);
  return <div ref={ref} data-chart-zoomed className="w-fit" />;
}

const firstLine = (message: string) => message.split("\n", 1)[0]!.trim();

/** 失败：代码块（源码、上色、复制都在）+ 上方一行错误，完整错误放 title。 */
function FailedChart({ language, source, message }: { language: string; source: string; message: string }) {
  return (
    <div data-chart-failed className="md-chart-failed">
      <div data-chart-error title={message} className="mb-1.5 flex items-center gap-2 text-[13.5px] text-danger">
        <AlertCircle className="size-3.5 shrink-0" />
        <span className="truncate">{firstLine(message)}</span>
      </div>
      <CodeView code={source} language={language} />
    </div>
  );
}

/**
 * 模块级 + memo（按 language、source 比较）：外面 Markdown 重新解析、同一条消息后面继续追加文字，不改源码就不动。
 * 渲染结果进缓存（语言 + 源码 + 主题版本），卸载再挂上同步出图。
 */
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
  /** host 里现在画的是哪个 key（缓存命中时由我们把 SVG 插进去；现场渲染的由引擎画好）。 */
  const painted = useRef<string | null>(null);
  const disposeLive = useRef<ChartRendered["dispose"]>(undefined);

  const near = useNearViewport(shell, entry === undefined && !loadFailed);
  const loading = near && entry === undefined && !loadFailed;

  // 缓存命中：同步把 SVG 插进去（不出现转圈）
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
        // 引擎没加载下来不进缓存（下次打开可重试）；源码本身的错进缓存，同样的源码不反复重试
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
    // entry 由 key 决定；进视口（near）或源码、语言变了才重新排队
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, key]);

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
          <BarButton aria-label="查看源码" aria-pressed={showSource} onClick={() => setShowSource((v) => !v)}>
            <ToggleIcon className="size-3.5" />
          </BarButton>
          {ok && !showSource && (
            <BarButton aria-label="放大" onClick={() => setZoomed(true)}>
              <Maximize2 className="size-3.5" />
            </BarButton>
          )}
          <CopyCodeButton code={source} />
        </div>
        {showSource && (
          <div data-chart-source>
            <CodeBody code={source} language={renderer.sourceLanguage} />
          </div>
        )}
        {/* 图区一直挂着（切到源码只是藏起来）：切回来不用重画，Vega 的交互状态也在 */}
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
              <Loader2 className="size-5 animate-spin" aria-hidden="true" />
            </div>
          )}
        </div>
      </div>
      {entry?.ok === true && (
        <Dialog open={zoomed} onOpenChange={setZoomed}>
          <DialogContent title="图表" className="h-[90dvh] w-[min(96vw,1400px)] max-w-none">
            <DialogBody className="overflow-auto">
              <ZoomedSvg svg={entry.svg} />
            </DialogBody>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
});
