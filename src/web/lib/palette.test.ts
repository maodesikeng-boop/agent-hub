// 项目经理的颜色表（docs/ui-standard.md 第 4 条）：头像颜色和强调色共用一份，强调色按 WCAG 2.x AA 的文字对比度 4.5:1 配好。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { accentStyle, CHART_CATEGORY_COLORS, contrastRatio, PALETTE, paletteOf } from "./palette.ts";

const WHITE = "#ffffff";
const css = readFileSync("src/web/styles.css", "utf8");
/** styles.css 里 :root 定义的中性色（和纸暖白、墨色），这里按真值校验，不另写一份。 */
const cssHex = (name: string) => new RegExp(`--${name}: (#[0-9a-f]{6});`).exec(css)![1]!;
const PAPER = cssHex("background");

describe("颜色表", () => {
  it("有 8 种水果配色，名字、fruit 标识、切片与果瓣素材、主色、强调色都不重复", () => {
    expect(PALETTE).toHaveLength(8);
    expect(new Set(PALETTE.map((c) => c.name)).size).toBe(8);
    expect(new Set(PALETTE.map((c) => c.fruit)).size).toBe(8);
    expect(new Set(PALETTE.map((c) => c.slice)).size).toBe(8);
    expect(new Set(PALETTE.map((c) => c.wedge)).size).toBe(8);
    expect(new Set(PALETTE.map((c) => c.blob)).size).toBe(8);
    expect(new Set(PALETTE.map((c) => c.accent)).size).toBe(8);
  });

  it.each(PALETTE.map((c) => [c.name, c] as const))("%s：强调色上的文字、纯白和和纸底上的链接和状态词，对比度都 ≥ 4.5:1（WCAG 1.4.3 AA）", (_name, c) => {
    expect(contrastRatio(c.accentForeground, c.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(WHITE, c.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c.accent, WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c.accent, PAPER)).toBeGreaterThanOrEqual(4.5);
  });

  it("强调色上的字就是和纸白（和 --background、:root 的 --primary-foreground 同一个色）", () => {
    for (const c of PALETTE) expect(c.accentForeground).toBe(PAPER);
    expect(cssHex("primary-foreground")).toBe(PAPER);
  });

  it.each(PALETTE.map((c) => [c.name, c] as const))("%s：按钮悬停（变深一点）之后对比度也不低于 4.5:1", (_name, c) => {
    expect(contrastRatio(c.accentForeground, darken(c.accent, 0.9))).toBeGreaterThanOrEqual(4.5);
  });

  it("按 key 轮着取，负数和超过 8 的都能取到", () => {
    expect(paletteOf(0)).toBe(PALETTE[0]);
    expect(paletteOf(8)).toBe(PALETTE[0]);
    expect(paletteOf(9)).toBe(PALETTE[1]);
    expect(paletteOf(-1)).toBe(PALETTE[1]);
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

  it.each(CHART_CATEGORY_COLORS.map((c) => [c] as const))("图表分类色 %s：对纯白和和纸底都 ≥ 4.5:1（同时满足 WCAG 1.4.3 与 1.4.11）", (color) => {
    expect(contrastRatio(color, WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(color, PAPER)).toBeGreaterThanOrEqual(4.5);
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

describe("和纸中性色（styles.css 的 :root，docs/ui-standard.md 第 4 条）", () => {
  const surfaces = ["background", "sidebar", "sidebar-hover", "sidebar-active", "muted", "secondary", "accent", "bubble-agent"] as const;

  it.each(surfaces.map((s) => [s] as const))("--%s 上：墨色正文和次要文字对比度都 ≥ 4.5:1", (surface) => {
    expect(contrastRatio(cssHex("foreground"), cssHex(surface))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(cssHex("muted-foreground"), cssHex(surface))).toBeGreaterThanOrEqual(4.5);
  });

  it("底色是暖白而不是黄纸：R ≥ G ≥ B，最大和最小通道只差几级", () => {
    for (const name of ["background", "sidebar", "sidebar-active", "border"] as const) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(cssHex(name).slice(i, i + 2), 16)) as [number, number, number];
      expect(r).toBeGreaterThanOrEqual(g);
      expect(g).toBeGreaterThanOrEqual(b);
      expect(r - b).toBeLessThanOrEqual(10);
    }
  });
});

describe("水果色的掺入比例（styles.css 的 --mix-*，docs/ui-standard.md 第 4 条）", () => {
  const mixOf = (name: string) => Number(new RegExp(`--mix-${name}: ([0-9.]+)%;`).exec(css)?.[1]);
  const foreground = /--foreground: (#[0-9a-f]{6});/.exec(css)![1]!;

  it("外壳底色不超过 5%、分割线不超过 10%，不让界面发黄发粉", () => {
    expect(mixOf("chat")).toBeGreaterThan(0);
    expect(mixOf("chat")).toBeLessThanOrEqual(5);
    expect(mixOf("sidebar")).toBeLessThanOrEqual(5);
    expect(mixOf("line")).toBeLessThanOrEqual(10);
  });

  it("用户气泡掺进的是和纸底（var(--background)），不是写死的纯白", () => {
    expect(css).toMatch(/--color-bubble-me: color-mix\(in srgb, var\(--primary\) var\(--mix-bubble-me\), var\(--background\)\);/);
  });

  it.each(PALETTE.map((c) => [c.name, c] as const))("%s：用户气泡的浅果冻底（掺和纸底）上，前景色字对比度 ≥ 4.5:1", (_name, c) => {
    expect(contrastRatio(foreground, mix(c.accent, mixOf("bubble-me"), PAPER))).toBeGreaterThanOrEqual(4.5);
  });
});
