import { CHART_MAX_SOURCE_CHARS, type ChartTheme } from "./registry.ts";

const MERMAID_MAX_EDGES = 500;

const categoryColor = (theme: ChartTheme, index: number): string => theme.categoryColors[index % theme.categoryColors.length]!;

function categoryScale(theme: ChartTheme): Record<string, string> {
  const scale: Record<string, string> = {};
  for (let i = 0; i < 12; i++) {
    scale[`pie${i + 1}`] = categoryColor(theme, i);
    scale[`cScale${i}`] = categoryColor(theme, i);
  }
  return scale;
}

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
    ...categoryScale(theme),
    cScaleLabel0: background,
    pieStrokeColor: background,
    pieOuterStrokeColor: background,
    pieSectionTextColor: background,
    pieTitleTextColor: foreground,
    pieLegendTextColor: foreground,
    pieOpacity: "1",
    pieTitleTextSize: `${fontSize + 2}px`,
    pieSectionTextSize: `${fontSize}px`,
    pieLegendTextSize: `${fontSize}px`,
    taskBkgColor: categoryColor(theme, 0),
    taskBorderColor: categoryColor(theme, 0),
    taskTextColor: background,
    taskTextLightColor: background,
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

// Allowlist text-only tags: mermaid's default config keeps <img src>, which would let agent content make the page fetch arbitrary URLs.
const MERMAID_LABEL_SANITIZE = {
  ALLOWED_TAGS: ["b", "i", "u", "s", "em", "strong", "code", "sub", "sup", "small", "br", "span"],
  ALLOWED_ATTR: ["class"],
};

export function mermaidConfig(theme: ChartTheme) {
  return {
    startOnLoad: false,
    suppressErrorRendering: true,
    securityLevel: "strict" as const,
    theme: "base" as const,
    look: "classic" as const,
    themeVariables: mermaidThemeVariables(theme),
    fontFamily: theme.fontFamily,
    maxTextSize: CHART_MAX_SOURCE_CHARS,
    maxEdges: MERMAID_MAX_EDGES,
    dompurifyConfig: MERMAID_LABEL_SANITIZE,
    // d3 axis <line> elements carry stroke=currentColor, which themeVariables.gridColor cannot override.
    themeCSS: `.grid .tick line { stroke: ${theme.border}; } .node rect { rx: 8px; ry: 8px; }`,
    // Use SVG text labels: sanitizing strips foreignObject entirely and would leave labels empty.
    htmlLabels: false,
    flowchart: { useMaxWidth: true },
    sequence: { useMaxWidth: true, actorFontSize: theme.fontSize, noteFontSize: theme.fontSize, messageFontSize: theme.fontSize },
    state: { useMaxWidth: true },
    class: { useMaxWidth: true },
    er: { useMaxWidth: true },
    gantt: { useMaxWidth: true },
    journey: { useMaxWidth: true },
    pie: { useMaxWidth: true },
  };
}
