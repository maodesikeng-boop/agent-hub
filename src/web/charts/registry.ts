export const CHART_MAX_SOURCE_CHARS = 50_000;
export const CHART_MIN_HEIGHT = 160;
export const CHART_MIN_INLINE_FONT_PX = 12;
export const CHART_CACHE_SIZE = 200;
export const CHART_VIEWPORT_MARGIN = 600;

export interface ChartTheme {
  version: string;
  foreground: string;
  mutedForeground: string;
  border: string;
  muted: string;
  background: string;
  fontFamily: string;
  fontSize: number;
  axisFontSize: number;
  categoryColors: readonly string[];
}

export interface ChartRendered {
  svg: string;
  dispose?: () => void;
}

export interface ChartEngine {
  render(source: string, theme: ChartTheme, el: HTMLElement): Promise<ChartRendered>;
}

export interface ChartRenderer {
  load: () => Promise<ChartEngine>;
  zoomOnClick: boolean;
  sourceLanguage: string;
}

const VEGA_LITE: ChartRenderer = { load: () => import("./vega-lite.ts"), zoomOnClick: false, sourceLanguage: "json" };

export const CHART_RENDERERS: Record<string, ChartRenderer> = {
  mermaid: { load: () => import("./mermaid.ts"), zoomOnClick: true, sourceLanguage: "mermaid" },
  "vega-lite": VEGA_LITE,
  vegalite: VEGA_LITE,
};

export function isChartLanguage(language: string): boolean {
  return Object.hasOwn(CHART_RENDERERS, language.toLowerCase());
}

export function chartRendererOf(language: string): ChartRenderer | undefined {
  const key = language.toLowerCase();
  return Object.hasOwn(CHART_RENDERERS, key) ? CHART_RENDERERS[key] : undefined;
}

export class ChartLoadError extends Error {
  constructor(cause: unknown) {
    super("Failed to load the chart renderer", { cause });
  }
}

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

let queue: Promise<unknown> = Promise.resolve();

export function renderChart(renderer: ChartRenderer, source: string, theme: ChartTheme, el: HTMLElement): Promise<ChartRendered> {
  const run = queue.then(async () => (await loadEngine(renderer)).render(source, theme, el));
  queue = run.catch(() => {});
  return run;
}

export function resetChartRegistry(): void {
  engines.clear();
  queue = Promise.resolve();
}
