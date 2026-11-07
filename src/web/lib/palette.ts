import type { CSSProperties } from "react";

/**
 * 项目经理的颜色表（docs/ui-standard.md 第 4 条）：头像的团子和这个会话的强调色都从这里取，别处不再写颜色。
 * - blob：头像的团子颜色（明亮，不放文字）。
 * - accent：这个会话里的 `--primary`（气泡、主按钮、选中、链接、在忙的状态词）：同一个色相，深一档，
 *   既当“白字的底色”，也当“白底上的文字色”，两种用法对白色的对比度都要 ≥ 4.5:1。
 * - accentForeground：放在 accent 上的字（`--primary-foreground`）。
 * 对比度按 WCAG 2.x 1.4.3（AA，普通文字 4.5:1）算：https://www.w3.org/TR/WCAG21/#contrast-minimum ，
 * 公式见 https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio ；palette.test.ts 逐色校验。
 */
export const PALETTE = [
  { name: "樱粉", blob: "#ff3d8b", accent: "#cc2c66", accentForeground: "#ffffff" },
  { name: "橙", blob: "#ff7a1a", accent: "#c2410c", accentForeground: "#ffffff" },
  { name: "蓝", blob: "#2f8cff", accent: "#2563eb", accentForeground: "#ffffff" },
  { name: "黑", blob: "#18181b", accent: "#18181b", accentForeground: "#ffffff" },
  { name: "绿", blob: "#1fb37d", accent: "#15803d", accentForeground: "#ffffff" },
  { name: "黄", blob: "#f5b400", accent: "#8f6200", accentForeground: "#ffffff" },
] as const;

export type PaletteColor = (typeof PALETTE)[number];

/**
 * 数据图表的分类色（docs/ui-standard.md 第 15 条“图表”）：取颜色表的 accent 一组（都已过白底对比度校验），不另起一套。
 * 顺序按“相邻两个差别大”排：蓝、橙、绿、樱粉、黄、黑。图形元素（柱、线、点）按 WCAG 1.4.11 对白底 ≥ 3:1，palette.test.ts 逐色校验：
 * https://www.w3.org/TR/WCAG21/#non-text-contrast
 */
const CHART_ORDER = ["蓝", "橙", "绿", "樱粉", "黄", "黑"] as const;
export const CHART_CATEGORY_COLORS: readonly string[] = CHART_ORDER.map((name) => PALETTE.find((c) => c.name === name)!.accent);

/** 按 key 在颜色表里轮着取（项目经理用它的编号）。 */
export function paletteOf(key: number): PaletteColor {
  return PALETTE[Math.abs(key) % PALETTE.length]!;
}

/** 这个会话的强调色：设在外层容器上，里面的 `bg-primary`、`text-primary` 等都跟着变。 */
export function accentStyle(key: number): CSSProperties {
  const { accent, accentForeground } = paletteOf(key);
  return { "--primary": accent, "--primary-foreground": accentForeground } as CSSProperties;
}

const channel = (hex: string, i: number) => {
  const v = parseInt(hex.slice(i, i + 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);

/** WCAG 2.x 的对比度：(亮 + 0.05) / (暗 + 0.05)，两个 #rrggbb。 */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
