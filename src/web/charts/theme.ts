import { CHART_CATEGORY_COLORS } from "../lib/palette.ts";
import type { ChartTheme } from "./registry.ts";

const CHART_FONT_SIZE = 13.5;
const CHART_AXIS_FONT_SIZE = 12;

export function chartTheme(): ChartTheme {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => style.getPropertyValue(name).trim();
  const values = {
    foreground: read("--foreground"),
    mutedForeground: read("--muted-foreground"),
    border: read("--border"),
    muted: read("--muted"),
    background: read("--background"),
    fontFamily: read("--font-ui"),
  };
  return {
    ...values,
    fontSize: CHART_FONT_SIZE,
    axisFontSize: CHART_AXIS_FONT_SIZE,
    categoryColors: CHART_CATEGORY_COLORS,
    version: JSON.stringify(values),
  };
}
