// 图表渲染器表（docs/charts-diagrams-design.md 第 5 节）：fence 语言名 → 渲染器。可调的数集中在这里。
// 主包不静态引用任何图表库：表里只有 `() => import("./mermaid.ts")` 这种函数，vite 自动拆块，没有图表块的对话不下载一个字节。

/** 源码超过这个字数不渲染，当普通代码块 + 一行错误；Mermaid 的 maxTextSize / maxEdges 同步设成这一档。 */
export const CHART_MAX_SOURCE_CHARS = 50_000;
/** 图块内最高多少 px：更高的等比缩到这个高度，点放大看原尺寸。 */
export const CHART_MAX_INLINE_HEIGHT = 480;
/** 还没渲染好（占位、转圈）时图区最小高度 px。 */
export const CHART_MIN_HEIGHT = 160;
/** 渲染结果缓存的条数（LRU）。 */
export const CHART_CACHE_SIZE = 200;
/** 离视口还有多远就开始渲染（IntersectionObserver 的 rootMargin，px）。 */
export const CHART_VIEWPORT_MARGIN = 600;

/** 渲染器收到的主题：theme.ts 的 chartTheme() 从 CSS 变量和调色板读出来；version 进缓存键，主题变了重画。 */
export interface ChartTheme {
  version: string;
  foreground: string;
  mutedForeground: string;
  border: string;
  muted: string;
  background: string;
  fontFamily: string;
  /** 图里的字 px。 */
  fontSize: number;
  /** 坐标轴标签 px。 */
  axisFontSize: number;
  /** 数据系列的分类色（palette.ts 的 CHART_CATEGORY_COLORS）。 */
  categoryColors: readonly string[];
}

/** 一次渲染的结果：svg 是洗过的 SVG 字符串（进缓存，下次直接插）；dispose 在块卸载时调（Vega 的 view.finalize()）。 */
export interface ChartRendered {
  svg: string;
  dispose?: () => void;
}

/** 渲染引擎：动态 import 出来的模块就是它。把图画进 el（el 在页面里，渲染中可以量尺寸），返回结果。源码有错就抛。 */
export interface ChartEngine {
  render(source: string, theme: ChartTheme, el: HTMLElement): Promise<ChartRendered>;
}

export interface ChartRenderer {
  /** 按需加载引擎（动态 import）。 */
  load: () => Promise<ChartEngine>;
  /** 点图本身是否打开放大窗：Mermaid 是；Vega 有自己的交互（悬停提示），只有放大按钮。 */
  zoomOnClick: boolean;
  /** 切到“源码”时 Shiki 用的语言（Vega-Lite 写 json）。 */
  sourceLanguage: string;
}

/**
 * 语言名（小写）→ 渲染器。加一种图表：在这里加一行（别名写多行）。
 * 比如：`mermaid: { load: () => import("./mermaid.ts"), zoomOnClick: true, sourceLanguage: "mermaid" }`。
 * 不认 `vega`（完整 Vega 能写信号、事件、数据请求，面太大），也不猜 `json` 代码块是不是图表。
 */
export const CHART_RENDERERS: Record<string, ChartRenderer> = {
  mermaid: { load: () => import("./mermaid.ts"), zoomOnClick: true, sourceLanguage: "mermaid" },
};

export function isChartLanguage(language: string): boolean {
  return Object.hasOwn(CHART_RENDERERS, language.toLowerCase());
}

export function chartRendererOf(language: string): ChartRenderer | undefined {
  const key = language.toLowerCase();
  return Object.hasOwn(CHART_RENDERERS, key) ? CHART_RENDERERS[key] : undefined;
}

/** 引擎加载失败（断网、chunk 404）：界面写“图表组件加载失败”，不显示底层报错。 */
export class ChartLoadError extends Error {
  constructor(cause: unknown) {
    super("图表组件加载失败", { cause });
  }
}

/** 加载 promise 模块级缓存：多张图并发只加载一次；失败的清掉，下次可以重试。 */
const engines = new Map<ChartRenderer, Promise<ChartEngine>>();

function loadEngine(renderer: ChartRenderer): Promise<ChartEngine> {
  let promise = engines.get(renderer);
  if (promise === undefined) {
    promise = renderer.load().catch((error: unknown) => {
      engines.delete(renderer);
      throw new ChartLoadError(error);
    });
    engines.set(renderer, promise);
  }
  return promise;
}

/** 串行队列：Mermaid 要往 DOM 里放临时节点量尺寸，同时渲染会互相干扰；Vega 也进同一个队列，免得主线程一次卡太久。 */
let queue: Promise<unknown> = Promise.resolve();

/** 渲染一张图：排队 → 加载引擎 → 画进 el。引擎加载失败抛 ChartLoadError。 */
export function renderChart(renderer: ChartRenderer, source: string, theme: ChartTheme, el: HTMLElement): Promise<ChartRendered> {
  const run = queue.then(async () => (await loadEngine(renderer)).render(source, theme, el));
  queue = run.catch(() => {});
  return run;
}

/** 测试用：清掉加载缓存和队列。 */
export function resetChartRegistry(): void {
  engines.clear();
  queue = Promise.resolve();
}
