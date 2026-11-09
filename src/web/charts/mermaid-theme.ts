// Mermaid 的主题和初始化配置（theme.ts 的 chartTheme() 给颜色，这里只管怎么交给 Mermaid）。
// 单独一个文件：Vega-Lite 那一半也要往主题里加东西，分开写两边不互相改同一个文件。
import { CHART_MAX_SOURCE_CHARS, type ChartTheme } from "./registry.ts";

/** Mermaid 一张图最多多少条连线。 */
const MERMAID_MAX_EDGES = 500;

/** 按序轮着取分类色（系列比颜色多时从头再来）。 */
const categoryColor = (theme: ChartTheme, index: number): string => theme.categoryColors[index % theme.categoryColors.length]!;

/** 饼图 pie1..pie12、cScale0..cScale11（旅程图、时间线、象限图等按序号取色）：都取页面的分类色，不用 mermaid 从 primaryColor 算出的色。 */
function categoryScale(theme: ChartTheme): Record<string, string> {
  const scale: Record<string, string> = {};
  for (let i = 0; i < 12; i++) {
    scale[`pie${i + 1}`] = categoryColor(theme, i);
    scale[`cScale${i}`] = categoryColor(theme, i);
  }
  return scale;
}

/**
 * Mermaid 的 themeVariables（theme: "base"）：节点白底、1px 描边（次要文字色）、前景色字，连线用次要文字色；分组、注释的底用 --muted、边用 --border。
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
    // 节点描边用次要文字色而不是 --border：#ececef 在白底上只有 1.2:1，看不清形状（图形元素要 ≥ 3:1）
    primaryBorderColor: mutedForeground,
    primaryTextColor: foreground,
    secondaryColor: muted,
    secondaryBorderColor: border,
    secondaryTextColor: foreground,
    tertiaryColor: muted,
    tertiaryBorderColor: border,
    tertiaryTextColor: foreground,
    mainBkg: background,
    nodeBorder: mutedForeground,
    nodeTextColor: foreground,
    clusterBkg: muted,
    clusterBorder: border,
    edgeLabelBackground: background,
    // 时序图
    actorBkg: background,
    actorBorder: mutedForeground,
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
    // 饼图、旅程图等：分类色；扇区里的字白色（分类色都按“白字的底色”校验过），扇区之间留白底描边
    ...categoryScale(theme),
    cScaleLabel0: background,
    pieStrokeColor: background,
    pieOuterStrokeColor: background,
    pieSectionTextColor: background,
    pieTitleTextColor: foreground,
    pieLegendTextColor: foreground,
    // 默认 0.7 透明，颜色会发灰、和图例对不上；字号对齐图里的字号（默认标题 25px）
    pieOpacity: "1",
    pieTitleTextSize: `${fontSize + 2}px`,
    pieSectionTextSize: `${fontSize}px`,
    pieLegendTextSize: `${fontSize}px`,
    // 甘特图：普通任务蓝、进行中橙、已完成灰、关键任务樱粉（分类色的前几个）；分区底用 --muted，网格线 --border，今天的线樱粉
    taskBkgColor: categoryColor(theme, 0),
    taskBorderColor: categoryColor(theme, 0),
    taskTextColor: background,
    taskTextLightColor: background,
    // 进行中、已完成的任务条上的字（叫 Dark 但画在有色的条上）：白字；条外的字另用 taskTextOutsideColor
    taskTextDarkColor: background,
    taskTextOutsideColor: foreground,
    taskTextClickableColor: foreground,
    activeTaskBkgColor: categoryColor(theme, 1),
    activeTaskBorderColor: categoryColor(theme, 1),
    doneTaskBkgColor: mutedForeground,
    doneTaskBorderColor: mutedForeground,
    critBkgColor: categoryColor(theme, 3),
    critBorderColor: categoryColor(theme, 3),
    gridColor: border,
    sectionBkgColor: muted,
    sectionBkgColor2: muted,
    altSectionBkgColor: background,
    excludeBkgColor: muted,
    todayLineColor: categoryColor(theme, 3),
  };
}

/**
 * 标签文字过 DOMPurify 时只留文字排版用的标签。mermaid 默认的配置会留下 <img src>：渲染时它被放进页面，浏览器立刻去取图
 *（agent 写的内容就能让页面往任意地址发请求），所以用白名单，图片、框架、链接、样式都不要。
 */
const MERMAID_LABEL_SANITIZE = {
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
    // classic：1px 描边的节点；默认的 neo 给节点加投影，ui-standard 不要重阴影
    look: "classic" as const,
    themeVariables: mermaidThemeVariables(theme),
    fontFamily: theme.fontFamily,
    maxTextSize: CHART_MAX_SOURCE_CHARS,
    maxEdges: MERMAID_MAX_EDGES,
    dompurifyConfig: MERMAID_LABEL_SANITIZE,
    // 甘特图的网格线：d3 坐标轴的 <line> 自带 stroke=currentColor，themeVariables.gridColor 管不到
    themeCSS: `.grid .tick line { stroke: ${theme.border}; }`,
    // 标签用 SVG 文字，不用 foreignObject 里的 HTML（洗 SVG 时 foreignObject 会被整个去掉，标签就空了）
    htmlLabels: false,
    // 宽度跟容器（不撑破消息列）
    flowchart: { useMaxWidth: true },
    // 时序图的字号默认 16px，和别的图对齐到图里的字号
    sequence: { useMaxWidth: true, actorFontSize: theme.fontSize, noteFontSize: theme.fontSize, messageFontSize: theme.fontSize },
    state: { useMaxWidth: true },
    class: { useMaxWidth: true },
    er: { useMaxWidth: true },
    gantt: { useMaxWidth: true },
    journey: { useMaxWidth: true },
    pie: { useMaxWidth: true },
  };
}
