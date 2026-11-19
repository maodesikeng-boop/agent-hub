import type { CSSProperties } from "react";
import { JELLY_COLOR_IDS, jellyColorOf, type JellyColorId } from "../../shared/slimes.ts";

export { contrastRatio } from "../../shared/slimes.ts";

/**
 * 项目经理颜色在网页上的用法（docs/ui-standard.md 第 4 条、第 17 条）：颜色名录和色值在 shared/slimes.ts（飞书群头像也按它取），
 * 这里只把一种颜色换成 CSS 变量。对比度按 WCAG 2.x 1.4.3（AA，普通文字 4.5:1）算，palette.test.ts 逐色校验。
 * 每个函数对同一种颜色返回同一个对象（memo 的子组件不重画）。
 */

function cachedBy<T>(build: (id: JellyColorId) => T): (id: JellyColorId) => T {
  const table = new Map<JellyColorId, T>(JELLY_COLOR_IDS.map((id) => [id, build(id)]));
  return (id) => table.get(id)!;
}

/** 这个会话的强调色：设在外层容器上，里面的 `bg-primary`、`text-primary` 等都跟着变。 */
export const accentStyleOf = cachedBy((id): CSSProperties => {
  const { accent, accentForeground } = jellyColorOf(id);
  return { "--primary": accent, "--primary-foreground": accentForeground } as CSSProperties;
});

/** 外壳底色掺的颜色（styles.css 的 `--color-surface-*`、`--color-line`）：只设 `--fruit`，不动 `--primary`，左栏里的强调色照旧是中性的。 */
export const tintStyleOf = cachedBy((id): CSSProperties => ({ "--fruit": jellyColorOf(id).accent }) as CSSProperties);

/** 列表行的果冻底（styles.css 的 bg-jelly）：选中、悬停是这一行项目经理颜色的极淡底。 */
export const jellyStyleOf = cachedBy((id): CSSProperties => ({ "--jelly": jellyColorOf(id).accent }) as CSSProperties);

type FruitTrackVars = CSSProperties & Record<"--tube-line" | "--tube-core" | "--tube-glint" | "--tube-shade" | "--peel" | "--step-done-bg", string>;

/**
 * 任务图（果皮轨、放大全览、进度图标）的颜色变量：走通的果冻管道和珠子用这个颜色的描边、身体、浅色、暗面；
 * 没走通的空管子、没轮到的珠子、等项目经理的琥珀色珠子是 styles.css 里的固定色（--tube-empty-*、--bead-*）。
 */
export const fruitTrackVars = cachedBy((id): FruitTrackVars => {
  const { roles, blob, backdrop } = jellyColorOf(id);
  return {
    "--tube-line": roles.outline,
    "--tube-core": roles.body,
    "--tube-glint": roles.light,
    "--tube-shade": roles.shade,
    "--peel": blob,
    "--step-done-bg": backdrop,
  };
});

/**
 * 数据图表的分类色（docs/ui-standard.md 第 15 条“图表”）：取颜色表的 accent 一组（都已过白底对比度校验），不另起一套。
 * 顺序按“相邻两个差别大”排。图形元素（柱、线、点）按 WCAG 1.4.11 对白底 ≥ 3:1（实际全部 ≥ 4.5:1），palette.test.ts 逐色校验：
 * https://www.w3.org/TR/WCAG21/#non-text-contrast
 */
const CHART_ORDER: readonly JellyColorId[] = ["grapefruit", "lime", "orange", "kiwi", "strawberry", "lemon"];
export const CHART_CATEGORY_COLORS: readonly string[] = CHART_ORDER.map((id) => jellyColorOf(id).accent);
