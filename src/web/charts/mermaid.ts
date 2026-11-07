// Mermaid 引擎（registry.ts 的 `mermaid` 行 `() => import("./mermaid.ts")` 加载它；docs/charts-diagrams-design.md 第 2.3、5 节）：
// - 这个文件静态引用 mermaid，所以库和这个文件一起按需加载（vite 拆成单独的块，每种图再按需拆）；没有 mermaid 块的对话一个字节都不下载。
//   库没下载下来 = 这个文件的动态 import 失败，由 registry 报“图表组件加载失败”。
// - initialize 只调一次（securityLevel: "strict"），主题变了才再调。
// - 一次只渲染一张由 registry 的串行队列保证；结果缓存（同一份源码不重画）在 ChartBlock 一侧。
// - 渲染出的 SVG 字符串再过一遍 DOMPurify（不信 mermaid 自己洗过的），再去掉样式里指向外部的地址，才插进页面。
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

/** 洗 SVG：去掉脚本、事件属性、javascript: 链接、foreignObject 里的 HTML；再去掉 <style> 里的 @import 和指向外部的 url()。 */
export function sanitizeSvg(svg: string): string {
  const clean = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
  return clean.replace(/@import\b[^;{}]*;?/gi, "").replace(/url\(\s*(?!["']?#)[^)]*\)/gi, "none");
}

/** mermaid 的语法错误是多行的（第几行、源码片段、^ 指针、期望什么）；界面只显示第一行，所以并成一行：第几行 + 期望什么。 */
function tidyError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error));
  const lines = error.message.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length < 3 || !/^Parse error on line \d+:?$/.test(lines[0]!)) return error;
  return new Error(`${lines[0]} ${lines.at(-1)}`, { cause: error });
}

/** 渲染一份 Mermaid 源码，画进 el，返回洗过的 SVG 字符串（进缓存）。语法错误等原样抛出（message 是 mermaid 的原文）。 */
export async function render(source: string, theme: ChartTheme, el: HTMLElement): Promise<ChartRendered> {
  // mermaid 自己超限时不抛错，而是画一张“超限”的图，所以这里先拦
  if (source.length > CHART_MAX_SOURCE_CHARS) throw new Error(`图表源码太长（超过 ${CHART_MAX_SOURCE_CHARS} 字）`);
  initialize(theme);
  const id = `chart-mermaid-${++counter}`;
  let clean: string;
  try {
    clean = sanitizeSvg((await mermaid.render(id, source)).svg);
  } catch (error) {
    throw tidyError(error);
  } finally {
    // 失败时 mermaid 会把临时节点留在 <body> 里；必须在插入 SVG 之前清（SVG 的 id 和临时节点同名，晚了会误删刚插进去的图）
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
  el.innerHTML = clean;
  return { svg: clean };
}
