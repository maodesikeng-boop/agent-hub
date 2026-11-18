// 项目经理的颜色表（docs/ui-standard.md 第 4 条）：头像颜色和强调色共用一份，强调色按 WCAG 2.x AA 的文字对比度 4.5:1 配好。
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PM_FRUITS, pmFruitOf } from "../../shared/fruits.ts";
import { accentStyle, CHART_CATEGORY_COLORS, contrastRatio, PALETTE, paletteOf } from "./palette.ts";

const WHITE = "#ffffff";

describe("颜色表", () => {
  it("顺序和 shared/fruits.ts 的 PM_FRUITS 一样；名字、fruit 标识、主形象与纸片分身素材、主色、强调色都不重复", () => {
    const n = PM_FRUITS.length;
    expect(PALETTE.map((c) => c.fruit)).toEqual([...PM_FRUITS]);
    for (const key of ["name", "fruit", "main", "piece", "blob", "accent"] as const) expect(new Set(PALETTE.map((c) => c[key])).size).toBe(n);
  });

  it.each(PALETTE.map((c) => [c.name, c] as const))("%s：强调色上的文字、白底上的链接和状态词，对比度都 ≥ 4.5:1（WCAG 1.4.3 AA）", (_name, c) => {
    expect(contrastRatio(c.accentForeground, c.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c.accent, WHITE)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(PALETTE.map((c) => [c.name, c] as const))("%s：按钮悬停（变深一点）之后对比度也不低于 4.5:1", (_name, c) => {
    expect(contrastRatio(c.accentForeground, darken(c.accent, 0.9))).toBeGreaterThanOrEqual(4.5);
  });

  it("按 key 轮着取，负数和超过水果个数的都能取到", () => {
    const n = PALETTE.length;
    expect(paletteOf(0)).toBe(PALETTE[0]);
    expect(paletteOf(n)).toBe(PALETTE[0]);
    expect(paletteOf(n + 1)).toBe(PALETTE[1]);
    expect(paletteOf(-1)).toBe(PALETTE[1]);
    // 飞书群头像按 pmFruitOf 取（daemon/feishu/avatars.ts），和网页头像是同一个水果
    for (let key = 0; key <= n * 2; key++) expect(paletteOf(key).fruit).toBe(pmFruitOf(key));
  });

  it("accentStyle：换 key，--primary 和 --primary-foreground 跟着换", () => {
    const a = accentStyle(0) as Record<string, string>;
    const b = accentStyle(1) as Record<string, string>;
    expect(a["--primary"]).toBe(PALETTE[0]!.accent);
    expect(a["--primary-foreground"]).toBe(PALETTE[0]!.accentForeground);
    expect(b["--primary"]).toBe(PALETTE[1]!.accent);
    expect(b["--primary"]).not.toBe(a["--primary"]);
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

describe("水果色的掺入比例（styles.css 的 --mix-*，docs/ui-standard.md 第 4 条）", () => {
  const css = readFileSync("src/web/styles.css", "utf8");
  const mixOf = (name: string) => Number(new RegExp(`--mix-${name}: ([0-9.]+)%;`).exec(css)?.[1]);
  const foreground = /--foreground: (#[0-9a-f]{6});/.exec(css)![1]!;

  it("外壳底色不超过 5%、分割线不超过 10%，不让界面发黄发粉", () => {
    expect(mixOf("chat")).toBeGreaterThan(0);
    expect(mixOf("chat")).toBeLessThanOrEqual(5);
    expect(mixOf("sidebar")).toBeLessThanOrEqual(5);
    expect(mixOf("line")).toBeLessThanOrEqual(10);
  });

  it.each(PALETTE.map((c) => [c.name, c] as const))("%s：用户气泡的浅果冻底上，前景色字对比度 ≥ 4.5:1", (_name, c) => {
    expect(contrastRatio(foreground, mix(c.accent, mixOf("bubble-me"), WHITE))).toBeGreaterThanOrEqual(4.5);
  });
});

describe("次要文字和状态字的对比度（styles.css 的 --muted-foreground、--warn-foreground，WCAG 1.4.3）", () => {
  const css = readFileSync("src/web/styles.css", "utf8");
  const token = (name: string) => new RegExp(`\\n  --${name}: (#[0-9a-f]{6});`).exec(css)![1]!;
  const mixOf = (name: string) => Number(new RegExp(`--mix-${name}: ([0-9.]+)%;`).exec(css)?.[1]);
  const JELLY_PERCENT = 10;
  /** 次要文字会压在上面的每一种底：中性的几种，加上每种水果各自的左栏底、对话区底，以及盖在它们上面的选中果冻底。 */
  const surfaces = (): Array<[string, string]> => {
    const list: Array<[string, string]> = ["background", "sidebar", "sidebar-active", "sidebar-hover", "muted", "bubble-agent"].map((name) => [name, token(name)]);
    for (const c of PALETTE) {
      const sidebar = mix(c.accent, mixOf("sidebar"), token("sidebar"));
      const chat = mix(c.accent, mixOf("chat"), token("background"));
      list.push([`${c.name} 左栏底`, sidebar], [`${c.name} 对话区底`, chat], [`${c.name} 左栏选中果冻底`, mix(c.accent, JELLY_PERCENT, sidebar)], [`${c.name} 右栏选中果冻底`, mix(c.accent, JELLY_PERCENT, chat)]);
    }
    return list;
  };

  it("果冻底的浓度和这里算的一样（10%）", () => {
    expect(css).toMatch(/--color-jelly: color-mix\(in srgb, var\(--jelly, var\(--primary\)\) 10%, transparent\);/);
  });

  it.each(surfaces())("次要文字压在 %s 上 ≥ 4.5:1", (_name, surface) => {
    expect(contrastRatio(token("muted-foreground"), surface)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(surfaces())("琥珀色的状态字（Waiting on PM）压在 %s 上 ≥ 4.5:1", (_name, surface) => {
    expect(contrastRatio(token("warn-foreground"), surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("琥珀色的填充色（--caution）对白底不到 3:1，只能当圆点、用量条的颜色，组件里不拿它当字色", () => {
    expect(contrastRatio(token("caution"), WHITE)).toBeLessThan(3);
    const sources = readdirSync("src/web", { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".tsx") && !f.includes(".test."));
    for (const file of sources) expect(readFileSync(`src/web/${file}`, "utf8"), file).not.toContain("text-caution");
  });
});
