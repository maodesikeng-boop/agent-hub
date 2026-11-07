// 测试用的固定主题（和 styles.css 的浅色一致），各个渲染器的测试共用。
import type { ChartTheme } from "./registry.ts";

export const TEST_THEME: ChartTheme = {
  version: "test",
  foreground: "#18181b",
  mutedForeground: "#71717a",
  border: "#ececef",
  muted: "#f3f3f5",
  background: "#ffffff",
  fontFamily: "sans-serif",
  fontSize: 13.5,
  axisFontSize: 12,
  categoryColors: ["#2563eb", "#c2410c"],
};
