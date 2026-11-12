// 测试用的固定主题（和 styles.css 的浅色一致），各个渲染器的测试共用。
import type { ChartTheme } from "./registry.ts";

export const TEST_THEME: ChartTheme = {
  version: "test",
  foreground: "#1c1b19",
  mutedForeground: "#66635c",
  border: "#e8e6e1",
  muted: "#f1efe9",
  background: "#fcfbf9",
  fontFamily: "sans-serif",
  fontSize: 13.5,
  axisFontSize: 12,
  categoryColors: ["#2563eb", "#c2410c"],
};
