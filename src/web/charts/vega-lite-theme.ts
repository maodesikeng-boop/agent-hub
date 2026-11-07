// Vega-Lite 的主题（docs/ui-standard.md 第 15 条“图表”）：颜色、字体、字号全部来自 chartTheme()（CSS 变量 + palette.ts），这里只把它们摆进 Vega-Lite 的 config。
// 单独一个文件，不和 Mermaid 的主题挤在 theme.ts 里。agent 自己在规格里写的 config 会盖过这里（Vega-Lite 的合并顺序）。
import type { Config } from "vega-lite";
import type { ChartTheme } from "./registry.ts";

export function vegaLiteConfig(theme: ChartTheme): Config {
  const first = theme.categoryColors[0]!;
  const text = { font: theme.fontFamily, color: theme.foreground, fontSize: theme.fontSize };
  return {
    background: theme.background,
    font: theme.fontFamily,
    view: { stroke: "transparent" },
    // 没写颜色的 mark 用第一个分类色；悬停提示默认开（vega-embed 自带的 tooltip 会转义内容）
    mark: { color: first, tooltip: true },
    text,
    title: { font: theme.fontFamily, color: theme.foreground, fontSize: theme.fontSize, fontWeight: 500, anchor: "start" },
    axis: {
      labelFont: theme.fontFamily,
      titleFont: theme.fontFamily,
      labelFontSize: theme.axisFontSize,
      titleFontSize: theme.fontSize,
      titleFontWeight: 400,
      labelColor: theme.mutedForeground,
      titleColor: theme.foreground,
      domainColor: theme.mutedForeground,
      tickColor: theme.mutedForeground,
      gridColor: theme.border,
    },
    legend: {
      labelFont: theme.fontFamily,
      titleFont: theme.fontFamily,
      labelFontSize: theme.axisFontSize,
      titleFontSize: theme.fontSize,
      titleFontWeight: 400,
      labelColor: theme.foreground,
      titleColor: theme.foreground,
    },
    header: { labelFont: theme.fontFamily, titleFont: theme.fontFamily, labelFontSize: theme.axisFontSize, titleFontSize: theme.fontSize, labelColor: theme.foreground, titleColor: theme.foreground },
    range: {
      category: [...theme.categoryColors],
      // 连续色：从边框灰到第一个分类色，不用库默认的渐变（里面有紫色）
      ramp: [theme.border, first],
      heatmap: [theme.border, first],
    },
  };
}
