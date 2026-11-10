import type { CSSProperties } from "react";
import bellPepperSlice from "../assets/avatars/bell_pepper.webp";
import bellPepperWedge from "../assets/avatars/bell_pepper_wedge.webp";
import grapefruitSlice from "../assets/avatars/grapefruit.webp";
import grapefruitWedge from "../assets/avatars/grapefruit_wedge.webp";
import kiwiSlice from "../assets/avatars/kiwi.webp";
import kiwiWedge from "../assets/avatars/kiwi_wedge.webp";
import lemonSlice from "../assets/avatars/lemon.webp";
import lemonWedge from "../assets/avatars/lemon_wedge.webp";
import limeSlice from "../assets/avatars/lime.webp";
import limeWedge from "../assets/avatars/lime_wedge.webp";
import orangeSlice from "../assets/avatars/orange.webp";
import orangeWedge from "../assets/avatars/orange_wedge.webp";
import pomeloSlice from "../assets/avatars/pomelo.webp";
import pomeloWedge from "../assets/avatars/pomelo_wedge.webp";
import strawberrySlice from "../assets/avatars/strawberry.webp";
import strawberryWedge from "../assets/avatars/strawberry_wedge.webp";

/**
 * 项目经理的水果配色表（docs/ui-standard.md 第 4 条、第 17 条）：头像切片（slice）、Worker 果瓣（wedge）、主色（blob）和会话强调色（accent）共用这一份，别处不再写颜色。
 * - slice：项目经理的完整水果横切面头像。
 * - wedge：Worker 的自然果瓣头像（从所属项目经理那片水果上顺着果络切下一瓣）。
 * - blob：水果主色（明亮原色，不放文字）。
 * - accent：这个会话里的 `--primary`（气泡、主按钮、选中、在忙的状态词）：同一个色相，深一档，
 *   既当“白字的底色”，也当“白底上的文字色”，两种用法对白色的对比度都要 ≥ 4.5:1。
 * - accentForeground：放在 accent 上的字（`--primary-foreground`）。
 * 对比度按 WCAG 2.x 1.4.3（AA，普通文字 4.5:1）算：https://www.w3.org/TR/WCAG21/#contrast-minimum ，
 * 公式见 https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio ；palette.test.ts 逐色校验。
 */
export const PALETTE = [
  { name: "粉红西柚", fruit: "grapefruit", slice: grapefruitSlice, wedge: grapefruitWedge, blob: "#ff6b57", accent: "#c83220", accentForeground: "#ffffff" },
  { name: "橙", fruit: "orange", slice: orangeSlice, wedge: orangeWedge, blob: "#ff7a1a", accent: "#c2410c", accentForeground: "#ffffff" },
  { name: "奇异果", fruit: "kiwi", slice: kiwiSlice, wedge: kiwiWedge, blob: "#5fb327", accent: "#3b6e14", accentForeground: "#ffffff" },
  { name: "草莓", fruit: "strawberry", slice: strawberrySlice, wedge: strawberryWedge, blob: "#e6392e", accent: "#b91c1c", accentForeground: "#ffffff" },
  { name: "青柠", fruit: "lime", slice: limeSlice, wedge: limeWedge, blob: "#4cb82a", accent: "#15803d", accentForeground: "#ffffff" },
  { name: "柠檬", fruit: "lemon", slice: lemonSlice, wedge: lemonWedge, blob: "#f5b400", accent: "#8f6200", accentForeground: "#ffffff" },
  { name: "白柚", fruit: "pomelo", slice: pomeloSlice, wedge: pomeloWedge, blob: "#d99b38", accent: "#855814", accentForeground: "#ffffff" },
  { name: "青椒", fruit: "bell_pepper", slice: bellPepperSlice, wedge: bellPepperWedge, blob: "#2f9e44", accent: "#1b6e2d", accentForeground: "#ffffff" },
] as const;

export type PaletteColor = (typeof PALETTE)[number];

/**
 * 数据图表的分类色（docs/ui-standard.md 第 15 条“图表”）：取颜色表的 accent 一组（都已过白底对比度校验），不另起一套。
 * 顺序按“相邻两个差别大”排。图形元素（柱、线、点）按 WCAG 1.4.11 对白底 ≥ 3:1（实际全部 ≥ 4.5:1），palette.test.ts 逐色校验：
 * https://www.w3.org/TR/WCAG21/#non-text-contrast
 */
const CHART_ORDER = ["粉红西柚", "青柠", "橙", "奇异果", "草莓", "柠檬"] as const;
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

/** 外壳底色掺的水果色（styles.css 的 `--color-surface-*`、`--color-line`）：只设 `--fruit`，不动 `--primary`，左栏里的强调色照旧是中性的。 */
export function tintStyle(key: number): CSSProperties {
  return { "--fruit": paletteOf(key).accent } as CSSProperties;
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
