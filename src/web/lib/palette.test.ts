// 项目经理的颜色表（docs/ui-standard.md 第 4 条）：头像颜色和强调色共用一份，强调色按 WCAG 2.x AA 的文字对比度 4.5:1 配好。
import { describe, expect, it } from "vitest";
import { accentStyle, contrastRatio, PALETTE, paletteOf } from "./palette.ts";

const WHITE = "#ffffff";

describe("颜色表", () => {
  it("有 6 种颜色，名字、头像色、强调色都不重复", () => {
    expect(PALETTE).toHaveLength(6);
    expect(new Set(PALETTE.map((c) => c.name)).size).toBe(6);
    expect(new Set(PALETTE.map((c) => c.blob)).size).toBe(6);
    expect(new Set(PALETTE.map((c) => c.accent)).size).toBe(6);
  });

  it.each(PALETTE.map((c) => [c.name, c] as const))("%s：强调色上的文字、白底上的链接和状态词，对比度都 ≥ 4.5:1（WCAG 1.4.3 AA）", (_name, c) => {
    expect(contrastRatio(c.accentForeground, c.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c.accent, WHITE)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(PALETTE.map((c) => [c.name, c] as const))("%s：按钮悬停（变深一点）之后对比度也不低于 4.5:1", (_name, c) => {
    expect(contrastRatio(c.accentForeground, darken(c.accent, 0.9))).toBeGreaterThanOrEqual(4.5);
  });

  it("按 key 轮着取，负数和超过 6 的都能取到", () => {
    expect(paletteOf(0)).toBe(PALETTE[0]);
    expect(paletteOf(6)).toBe(PALETTE[0]);
    expect(paletteOf(7)).toBe(PALETTE[1]);
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
