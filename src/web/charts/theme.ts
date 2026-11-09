// 图表主题（docs/ui-standard.md 第 15 条“图表”）：颜色从 styles.css 的 CSS 变量读，分类色取 palette.ts，不另起一套。
// 页面只有浅色；将来加暗色：变量变了、version 变了，缓存自然失效，重画即可，不用改渲染器。
import { CHART_CATEGORY_COLORS } from "../lib/palette.ts";
import type { ChartTheme } from "./registry.ts";

/** 图里的字、坐标轴标签 px（ui-standard 第 15 条）。 */
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
