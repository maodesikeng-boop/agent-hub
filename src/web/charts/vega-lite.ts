// Vega-Lite 渲染引擎（docs/charts-diagrams-design.md）：registry.ts 里 `() => import("./vega-lite.ts")` 才会加载到这里，
// 所以 vega、vega-lite、vega-embed 只在出现 ```vega-lite 块时下载。
// 安全：规格先过 vega-lite-security.ts 的检查；表达式用 vega-interpreter 解释执行（ast: true，不用 new Function）；
// loader 一律拒绝（不发请求）；actions:false（没有导出 / 编辑器菜单）；tooltip 用 vega-embed 自带的（会转义）。
import embed, { type VisualizationSpec } from "vega-embed";
import { expressionInterpreter } from "vega-interpreter";
import type { ChartEngine, ChartTheme } from "./registry.ts";
import { blockedLoader, parseVegaLiteSource, sanitizeSvg } from "./vega-lite-security.ts";
import { vegaLiteConfig } from "./vega-lite-theme.ts";

/** vega 的日志级别：只记错误（1），不往控制台刷警告。 */
const LOG_LEVEL_ERROR = 1;

/** 多图规格（分面、拼接、重复）里 width: "container" 不适用，保持规格自己的尺寸。 */
const MULTI_VIEW_KEYS = ["facet", "repeat", "concat", "hconcat", "vconcat"];

/** 规格没写 width 时按容器宽度画（图随消息列宽）；容器此刻量不到宽度（藏着）就用库的默认。 */
function withContainerWidth(spec: Record<string, unknown>, el: HTMLElement): Record<string, unknown> {
  if ("width" in spec || MULTI_VIEW_KEYS.some((key) => key in spec) || el.clientWidth <= 0) return spec;
  return { ...spec, width: "container" };
}

/** Vega 的 SVG 只有固定的 width / height：补上 viewBox，列宽放不下时才能等比缩小（CSS 的 max-width / max-height），放大窗也靠 viewBox 还原原尺寸。 */
function sizeOf(attrs: { get(name: string): string | null | undefined }): string | undefined {
  const width = Number.parseFloat(attrs.get("width") ?? "");
  const height = Number.parseFloat(attrs.get("height") ?? "");
  return width > 0 && height > 0 ? `0 0 ${width} ${height}` : undefined;
}

function fitLive(svg: SVGSVGElement): void {
  const viewBox = sizeOf({ get: (name) => svg.getAttribute(name) });
  if (viewBox === undefined) return;
  svg.setAttribute("viewBox", viewBox);
  svg.style.height = "auto";
}

function fitString(svg: string): string {
  return svg.replace(/<svg\b[^>]*>/, (tag) => {
    const attrs = new Map([...tag.matchAll(/\s([\w:-]+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
    const viewBox = sizeOf(attrs);
    return viewBox === undefined || attrs.has("viewBox") ? tag : tag.replace(/>$/, ` viewBox="${viewBox}" style="height:auto">`);
  });
}

export const render: ChartEngine["render"] = async (source, theme: ChartTheme, el) => {
  const spec = withContainerWidth(parseVegaLiteSource(source), el);
  let result: Awaited<ReturnType<typeof embed>> | undefined;
  try {
    result = await embed(el, spec as VisualizationSpec, {
      mode: "vega-lite",
      renderer: "svg",
      actions: false,
      ast: true,
      expr: expressionInterpreter,
      loader: blockedLoader() as never,
      config: vegaLiteConfig(theme),
      logLevel: LOG_LEVEL_ERROR,
    });
    const svg = fitString(sanitizeSvg(await result.view.toSVG()));
    const live = el.querySelector("svg");
    if (live !== null) fitLive(live);
    return { svg, dispose: result.finalize };
  } catch (error) {
    result?.finalize();
    el.replaceChildren();
    throw error;
  }
};
