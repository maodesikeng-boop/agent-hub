import type { Config } from "vega-lite";
import type { ChartTheme } from "./registry.ts";

export function vegaLiteConfig(theme: ChartTheme): Config {
  const first = theme.categoryColors[0]!;
  const text = { font: theme.fontFamily, color: theme.foreground, fontSize: theme.fontSize };
  return {
    background: theme.background,
    font: theme.fontFamily,
    view: { stroke: "transparent" },
    mark: { color: theme.mutedForeground, tooltip: true },
    bar: { cornerRadiusEnd: 4, fillOpacity: 0.7 },
    scale: { bandPaddingInner: 0.45, bandPaddingOuter: 0.25 },
    axisX: { labelAngle: 0, labelOverlap: "parity" },
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
      ramp: [theme.border, first],
      heatmap: [theme.border, first],
    },
  };
}
