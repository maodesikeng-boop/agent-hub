import embed, { type VisualizationSpec } from "vega-embed";
import { expressionInterpreter } from "vega-interpreter";
import type { ChartEngine, ChartTheme } from "./registry.ts";
import { blockedLoader, parseVegaLiteSource, sanitizeSvg } from "./vega-lite-security.ts";
import { vegaLiteConfig } from "./vega-lite-theme.ts";

const LOG_LEVEL_ERROR = 1;

const MULTI_VIEW_KEYS = ["facet", "repeat", "concat", "hconcat", "vconcat"];

function withContainerWidth(spec: Record<string, unknown>, el: HTMLElement): Record<string, unknown> {
  if ("width" in spec || MULTI_VIEW_KEYS.some((key) => key in spec) || el.clientWidth <= 0) return spec;
  return { ...spec, width: "container" };
}

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
