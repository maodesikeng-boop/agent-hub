import DOMPurify from "dompurify";
import mermaid from "mermaid";
import { mermaidConfig } from "./mermaid-theme.ts";
import { CHART_MAX_SOURCE_CHARS, type ChartRendered, type ChartTheme } from "./registry.ts";

let initializedWith: string | undefined;
let counter = 0;

function initialize(theme: ChartTheme): void {
  if (theme.version === initializedWith) return;
  mermaid.initialize(mermaidConfig(theme));
  initializedWith = theme.version;
}

export function sanitizeSvg(svg: string): string {
  const clean = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
  return clean.replace(/@import\b[^;{}]*;?/gi, "").replace(/url\(\s*(?!["']?#)[^)]*\)/gi, "none");
}

function tidyError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error));
  const lines = error.message.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length < 3 || !/^Parse error on line \d+:?$/.test(lines[0]!)) return error;
  return new Error(`${lines[0]} ${lines.at(-1)}`, { cause: error });
}

export async function render(source: string, theme: ChartTheme, el: HTMLElement): Promise<ChartRendered> {
  if (source.length > CHART_MAX_SOURCE_CHARS) throw new Error(`Chart source is too long (over ${CHART_MAX_SOURCE_CHARS} characters)`);
  initialize(theme);
  const id = `chart-mermaid-${++counter}`;
  let clean: string;
  try {
    clean = sanitizeSvg((await mermaid.render(id, source)).svg);
  } catch (error) {
    throw tidyError(error);
  } finally {
    // Mermaid leaves its temp node in <body> on failure; clear it before inserting the SVG because both share the same id.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
  el.innerHTML = clean;
  return { svg: clean };
}
