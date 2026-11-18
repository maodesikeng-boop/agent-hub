import type { CSSProperties } from "react";
import { FRUITS, pmFruitAvatarFile, pmFruitOf, type PmFruit } from "../../shared/fruits.ts";

const AVATAR_DIR = "../../../assets/avatars/";
const AVATAR_URLS = import.meta.glob<string>("../../../assets/avatars/*.svg", { eager: true, query: "?url", import: "default" });

function avatarUrl(fruit: PmFruit, kind: "main" | "piece"): string {
  const url = AVATAR_URLS[AVATAR_DIR + pmFruitAvatarFile(fruit, kind)];
  if (url === undefined) throw new Error(`assets/avatars 里没有 ${pmFruitAvatarFile(fruit, kind)}：先跑 node scripts/render-avatars.ts`);
  return url;
}

/**
 * 项目经理的水果配色表（docs/ui-standard.md 第 4 条、第 17 条）：水果名录和颜色在 shared/fruits.ts 的 FRUITS（飞书群头像也按它取），这里只配上头像图。
 * - main：项目经理的史莱姆小动物头像（透明底 SVG）。
 * - piece：Piece 的纸片分身头像（同一只小动物压薄）。
 * - blob、accent、accentForeground：见 shared/fruits.ts。
 * 对比度按 WCAG 2.x 1.4.3（AA，普通文字 4.5:1）算：https://www.w3.org/TR/WCAG21/#contrast-minimum ，
 * 公式见 https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio ；palette.test.ts 逐色校验。
 */
export const PALETTE = FRUITS.map((style) => ({ ...style, main: avatarUrl(style.fruit, "main"), piece: avatarUrl(style.fruit, "piece") }));

export type PaletteColor = (typeof PALETTE)[number];

const BY_FRUIT = new Map<PmFruit, PaletteColor>(PALETTE.map((color) => [color.fruit, color]));

/**
 * 数据图表的分类色（docs/ui-standard.md 第 15 条“图表”）：取颜色表的 accent 一组（都已过白底对比度校验），不另起一套。
 * 顺序按“相邻两个差别大”排。图形元素（柱、线、点）按 WCAG 1.4.11 对白底 ≥ 3:1（实际全部 ≥ 4.5:1），palette.test.ts 逐色校验：
 * https://www.w3.org/TR/WCAG21/#non-text-contrast
 */
const CHART_ORDER = ["粉红西柚", "青柠", "橙", "奇异果", "草莓", "柠檬"] as const;
export const CHART_CATEGORY_COLORS: readonly string[] = CHART_ORDER.map((name) => PALETTE.find((c) => c.name === name)!.accent);

/** 按 key 在颜色表里轮着取（项目经理用它的编号）。 */
export function paletteOf(key: number): PaletteColor {
  return BY_FRUIT.get(pmFruitOf(key))!;
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
