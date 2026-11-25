// 项目经理的颜色表（docs/ui-standard.md 第 4 条）：头像颜色和强调色共用一份，强调色按 WCAG 2.x AA 的文字对比度 4.5:1 配好。
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JELLY_COLOR_IDS, jellyColorOf } from "../../shared/slimes.ts";
import { accentStyleOf, avatarTileFillOf, CHART_CATEGORY_COLORS, contrastRatio, fruitTrackVars } from "./palette.ts";

const WHITE = "#ffffff";

/** 全部颜色（20 种水果原色 + 新加的），每种带上名字。 */
const PALETTE = JELLY_COLOR_IDS.map((id) => ({ name: id, ...jellyColorOf(id) }));

describe("颜色表", () => {
  it.each(PALETTE.map((c) => [c.name, c] as const))("%s：强调色上的文字、白底上的链接和状态词，对比度都 ≥ 4.5:1（WCAG 1.4.3 AA）", (_name, c) => {
    expect(contrastRatio(c.accentForeground, c.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c.accent, WHITE)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(PALETTE.map((c) => [c.name, c] as const))("%s：按钮悬停（变深一点）之后对比度也不低于 4.5:1", (_name, c) => {
    expect(contrastRatio(c.accentForeground, darken(c.accent, 0.9))).toBeGreaterThanOrEqual(4.5);
  });

  it("accentStyleOf：换颜色，--primary 和 --primary-foreground 跟着换；同一种颜色两次返回同一个对象", () => {
    const a = accentStyleOf("grapefruit") as Record<string, string>;
    const b = accentStyleOf("sky") as Record<string, string>;
    expect(a["--primary"]).toBe(jellyColorOf("grapefruit").accent);
    expect(a["--primary-foreground"]).toBe(jellyColorOf("grapefruit").accentForeground);
    expect(b["--primary"]).toBe(jellyColorOf("sky").accent);
    for (const fn of [accentStyleOf, fruitTrackVars]) expect(fn("teal")).toBe(fn("teal"));
  });

  it("fruitTrackVars：果冻管道的三层和珠子的暗面取这个颜色的描边、身体、浅色、暗面", () => {
    const vars = fruitTrackVars("sakura");
    const { roles } = jellyColorOf("sakura");
    expect([vars["--tube-line"], vars["--tube-core"], vars["--tube-glint"], vars["--tube-shade"]]).toEqual([roles.outline, roles.body, roles.light, roles.shade]);
  });

  it("avatarTileFillOf：每种颜色的头像方块都比黄色列表底深出 1.08:1 以上，也比白色选中行和原来的浅底深；同一种颜色两次返回同一个值", () => {
    const list = readFileSync("src/web/styles.css", "utf8").match(/\n {2}--list: (#[0-9a-f]{6});/)![1]!;
    const darker = (a: string, b: string) => contrastRatio(a, "#000000") < contrastRatio(b, "#000000");
    for (const id of JELLY_COLOR_IDS) {
      const fill = avatarTileFillOf(id);
      expect(fill, id).toMatch(/^#[0-9a-f]{6}$/);
      expect(darker(fill, list), id).toBe(true);
      expect(contrastRatio(fill, list), id).toBeGreaterThanOrEqual(1.08);
      expect(darker(fill, WHITE), id).toBe(true);
      expect(darker(fill, jellyColorOf(id).backdrop), id).toBe(true);
    }
    expect(avatarTileFillOf("lemon")).toBe(avatarTileFillOf("lemon"));
  });

  it("图表分类色：颜色表 accent 里的 6 种，互不重复", () => {
    expect(CHART_CATEGORY_COLORS).toHaveLength(6);
    expect(new Set(CHART_CATEGORY_COLORS).size).toBe(6);
    for (const color of CHART_CATEGORY_COLORS) expect(PALETTE.map((c) => c.accent)).toContain(color);
  });

  it.each(CHART_CATEGORY_COLORS.map((c) => [c] as const))("图表分类色 %s：对白底 ≥ 4.5:1（同时满足 WCAG 1.4.3 与 1.4.11）", (color) => {
    expect(contrastRatio(color, WHITE)).toBeGreaterThanOrEqual(4.5);
  });

  it("对比度公式：黑白 21:1，同色 1:1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });
});

/** 悬停：按钮用 brightness(0.9) 变深，这里按各通道乘 0.9 近似。 */
function darken(hex: string, f: number): string {
  const ch = [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * f).toString(16).padStart(2, "0"));
  return `#${ch.join("")}`;
}

/** sRGB 里把 hex 颜色按 percent% 掺进 base，和 CSS 的 `color-mix(in srgb, <hex> <percent>%, <base>)` 一样。 */
function mix(hex: string, percent: number, base: string): string {
  const p = percent / 100;
  const ch = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  const out = [1, 3, 5].map((i) => Math.round(ch(hex, i) * p + ch(base, i) * (1 - p)));
  return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

describe("分区色板与对比度（styles.css，docs/ui-standard.md 第 4 条）", () => {
  const css = readFileSync("src/web/styles.css", "utf8");
  const token = (name: string) => new RegExp(`\\n  --${name}: (#[0-9a-f]{6});`).exec(css)![1]!;
  const mixOf = (name: string) => Number(new RegExp(`--mix-${name}: ([0-9.]+)%;`).exec(css)?.[1]);
  const foreground = token("foreground");
  const surfaces = (): Array<[string, string]> =>
    (["background", "panel", "hover", "open", "list", "list-hover", "list-field", "send-disabled"] as const).map((name) => [name, token(name)]);

  it("已删除水果混底和果冻选中底，只保留分区色板", () => {
    expect(css).not.toMatch(/--mix-(chat|sidebar|line)|--color-(surface-chat|surface-sidebar|line|jelly)/);
    expect(css).not.toContain(".tint-fade");
  });

  it.each(JELLY_COLOR_IDS)("%s：已完成步骤角标与前景色字的对比度 ≥ 4.5:1", (id) => {
    const vars = fruitTrackVars(id);
    expect(contrastRatio(foreground, vars["--step-done-bg"])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(PALETTE.map((c) => [c.name, c] as const))("%s：用户气泡浅底上，前景色字对比度 ≥ 4.5:1", (_name, c) => {
    expect(contrastRatio(foreground, mix(c.accent, mixOf("bubble-me"), WHITE))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(surfaces().filter(([name]) => !name.startsWith("list") || name === "list-field"))("次要文字压在 %s 上 ≥ 4.5:1（黄色列表底上的次要文字用 --list-ink-soft，见下面一条）", (_name, surface) => {
    expect(contrastRatio(token("muted-foreground"), surface)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(surfaces())("琥珀色的状态字（Waiting on PM）压在 %s 上 ≥ 4.5:1", (_name, surface) => {
    expect(contrastRatio(token("warn-foreground"), surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("蜜黄 rail 与奶油 list 区域文字对比度 ≥ 4.5:1", () => {
    expect(contrastRatio(token("rail-ink"), token("rail"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(token("rail-ink"), token("rail-hover"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(token("rail-ink-soft"), token("rail"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(token("list-ink"), token("list"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(token("list-ink-soft"), token("list"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(token("list-ink-soft"), token("list-hover"))).toBeGreaterThanOrEqual(4.5);
  });

  it("琥珀色的填充色（--caution）对白底不到 3:1，只能当方块指示和用量条颜色，组件里不拿它当字色", () => {
    expect(contrastRatio(token("caution"), WHITE)).toBeLessThan(3);
    const sources = readdirSync("src/web", { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".tsx") && !f.includes(".test."));
    for (const file of sources) expect(readFileSync(`src/web/${file}`, "utf8"), file).not.toContain("text-caution");
  });
});
