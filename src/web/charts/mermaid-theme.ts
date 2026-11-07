// Mermaid 的主题和初始化配置（theme.ts 的 chartTheme() 给颜色，这里只管怎么交给 Mermaid）。
// 单独一个文件：Vega-Lite 那一半也要往主题里加东西，分开写两边不互相改同一个文件。
import { CHART_MAX_SOURCE_CHARS, type ChartTheme } from "./registry.ts";

/** Mermaid 一张图最多多少条连线。 */
export const MERMAID_MAX_EDGES = 500;

/**
 * Mermaid 的 themeVariables（theme: "base"）：节点白底、1px 描边、前景色字，连线用次要文字色。
 * 每个颜色都显式给出：base 主题会拿 primaryColor 算出别的颜色（色相偏移，容易出紫），所以凡是会被算出来的都钉死。
 */
export function mermaidThemeVariables(theme: ChartTheme): Record<string, string> {
  const { foreground, mutedForeground, border, muted, background, fontFamily, fontSize } = theme;
  return {
    fontFamily,
    fontSize: `${fontSize}px`,
    background,
    textColor: foreground,
    titleColor: foreground,
    lineColor: mutedForeground,
    primaryColor: background,
    primaryBorderColor: border,
    primaryTextColor: foreground,
    secondaryColor: muted,
    secondaryBorderColor: border,
    secondaryTextColor: foreground,
    tertiaryColor: muted,
    tertiaryBorderColor: border,
    tertiaryTextColor: foreground,
    mainBkg: background,
    nodeBorder: border,
    nodeTextColor: foreground,
    clusterBkg: muted,
    clusterBorder: border,
    edgeLabelBackground: background,
    // 时序图
    actorBkg: background,
    actorBorder: border,
    actorTextColor: foreground,
    actorLineColor: mutedForeground,
    signalColor: mutedForeground,
    signalTextColor: foreground,
    labelBoxBkgColor: muted,
    labelBoxBorderColor: border,
    labelTextColor: foreground,
    loopTextColor: foreground,
    noteBkgColor: muted,
    noteBorderColor: border,
    noteTextColor: foreground,
    activationBkgColor: muted,
    activationBorderColor: mutedForeground,
    sequenceNumberColor: background,
    // 状态图、类图、ER 图
    stateBkg: background,
    stateLabelColor: foreground,
    altBackground: muted,
    compositeBackground: muted,
    compositeBorder: border,
    compositeTitleBackground: muted,
    transitionColor: mutedForeground,
    transitionLabelColor: foreground,
    classText: foreground,
    attributeBackgroundColorOdd: background,
    attributeBackgroundColorEven: muted,
  };
}

/**
 * 标签文字过 DOMPurify 时只留文字排版用的标签。mermaid 默认的配置会留下 <img src>：渲染时它被放进页面，浏览器立刻去取图
 *（agent 写的内容就能让页面往任意地址发请求），所以用白名单，图片、框架、链接、样式都不要。
 */
export const MERMAID_LABEL_SANITIZE = {
  ALLOWED_TAGS: ["b", "i", "u", "s", "em", "strong", "code", "sub", "sup", "small", "br", "span"],
  ALLOWED_ATTR: ["class"],
};

/** mermaid.initialize 的配置：只调一次。strict 下标签过 DOMPurify、禁点击回调；图里的 %%{init}%% 改不了 secure 里的项。 */
export function mermaidConfig(theme: ChartTheme) {
  return {
    startOnLoad: false,
    suppressErrorRendering: true,
    securityLevel: "strict" as const,
    theme: "base" as const,
    themeVariables: mermaidThemeVariables(theme),
    fontFamily: theme.fontFamily,
    maxTextSize: CHART_MAX_SOURCE_CHARS,
    maxEdges: MERMAID_MAX_EDGES,
    dompurifyConfig: MERMAID_LABEL_SANITIZE,
    // 标签用 SVG 文字，不用 foreignObject 里的 HTML（洗 SVG 时 foreignObject 会被整个去掉，标签就空了）
    htmlLabels: false,
    // 宽度跟容器（不撑破消息列）
    flowchart: { useMaxWidth: true },
    sequence: { useMaxWidth: true },
    state: { useMaxWidth: true },
    class: { useMaxWidth: true },
    er: { useMaxWidth: true },
    gantt: { useMaxWidth: true },
    journey: { useMaxWidth: true },
    pie: { useMaxWidth: true },
  };
}
