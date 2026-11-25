// 项目经理的颜色表（docs/ui-standard.md 第 4 条）：头像颜色和强调色共用一份，强调色按 WCAG 2.x AA 的文字对比度 4.5:1 配好。
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JELLY_COLOR_IDS, jellyColorOf } from "../../shared/slimes.ts";
import { accentStyleOf, avatarTileFillOf, CHART_CATEGORY_COLORS, contrastRatio, ROUTER_SEND_COLORS, sendColorsOf } from "./palette.ts";

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
    expect([a["--send"], a["--send-hover"], a["--send-press"], a["--send-ink"]]).toEqual(Object.values(sendColorsOf("grapefruit")));
    for (const fn of [accentStyleOf, sendColorsOf]) expect(fn("teal")).toBe(fn("teal"));
  });

  it.each(PALETTE.map((c) => [c.name, c] as const))("%s: the pastel send button steps darker on hover and press, and its arrow keeps 7:1 on the pressed fill", (_name, c) => {
    const send = sendColorsOf(c.id);
    const toBlack = (hex: string) => contrastRatio(hex, "#000000");
    expect(toBlack(send.rest)).toBeGreaterThan(toBlack(send.hover));
    expect(toBlack(send.hover)).toBeGreaterThan(toBlack(send.press));
    expect(contrastRatio(send.ink, send.press)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(send.ink, send.rest)).toBeGreaterThanOrEqual(8);
  });

  it("matches the reviewed pastels: grapefruit and sky, and lemon lifted out of mustard", () => {
    expect(sendColorsOf("grapefruit")).toEqual({ rest: "#fdb9a9", hover: "#f6ac9b", press: "#eea190", ink: "#4f1409" });
    expect(sendColorsOf("sky").rest).toBe("#95d6fa");
    expect(sendColorsOf("lemon").rest).toBe("#f2dd83");
  });

  it("avatarTileFillOf: every tile stands at least 4:1 above the year rings and stays darker than the cream selected band; the same color returns the same value", () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    const rings = /\n {2}--rings-top: (#[0-9a-f]{6});/.exec(css)![1]!;
    const band = /\n {2}--row-selected: (#[0-9a-f]{6});/.exec(css)![1]!;
    const darker = (a: string, b: string) => contrastRatio(a, "#000000") < contrastRatio(b, "#000000");
    for (const id of JELLY_COLOR_IDS) {
      const fill = avatarTileFillOf(id);
      expect(fill, id).toMatch(/^#[0-9a-f]{6}$/);
      expect(contrastRatio(fill, rings), id).toBeGreaterThanOrEqual(4);
      expect(darker(fill, band), id).toBe(true);
      expect(contrastRatio(fill, band), id).toBeGreaterThanOrEqual(1.5);
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

describe("zone palette and contrast (styles.css, docs/ui-standard.md sections 2.4 and 4)", () => {
  const css = readFileSync("src/web/styles.css", "utf8");
  const token = (name: string) => new RegExp(`\\n  --${name}: (#[0-9a-f]{6});`).exec(css)![1]!;
  const mixOf = (name: string) => Number(new RegExp(`--mix-${name}: ([0-9.]+)%;`).exec(css)?.[1]);
  const foreground = token("foreground");
  const sheets = (): Array<[string, string]> => (["background", "panel", "hover", "open", "send-disabled"] as const).map((name) => [name, token(name)]);
  const grain = readFileSync("src/web/assets/wood-grain.svg", "utf8");
  const sheen = /stroke="(#[0-9a-f]{6})"[^>]*stroke-opacity="([0-9.]+)"/.exec(grain)!;
  // The lightest wood a text sits on: the frame under the grain's light sheen, the rings under a row's hover fill.
  const frameLightest = mix(sheen[1]!, Number(sheen[2]) * 100, token("wood-top"));
  const railHoverLightest = mix("#fff4e4", 10, frameLightest);
  const ringsLightest = mix("#fff0dc", 7, token("rings-top"));
  const translucent = (name: string, base = token("rings-top")) => {
    const [, r, g, b, alpha] = new RegExp(`\\n  --${name}: rgb\\((\\d+) (\\d+) (\\d+) / ([0-9.]+)\\);`).exec(css)!;
    const hex = `#${[r, g, b].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`;
    return mix(hex, Number(alpha) * 100, base);
  };

  it("已删除水果混底和果冻选中底，只保留分区色板", () => {
    expect(css).not.toMatch(/--mix-(chat|sidebar|line)|--color-(surface-chat|surface-sidebar|line|jelly)/);
    expect(css).not.toContain(".tint-fade");
  });

  it.each(PALETTE.map((c) => [c.name, c] as const))("%s：用户气泡浅底上，前景色字对比度 ≥ 4.5:1", (_name, c) => {
    expect(contrastRatio(foreground, mix(c.accent, mixOf("bubble-me"), WHITE))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(sheets())("secondary text on %s stays at 4.5:1 or more", (_name, surface) => {
    expect(contrastRatio(token("muted-foreground"), surface)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(sheets())("amber status words on %s stay at 4.5:1 or more", (_name, surface) => {
    expect(contrastRatio(token("warn-foreground"), surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the wood text at or above the reviewed contrast at the lightest point of each texture", () => {
    expect(contrastRatio(token("rail-ink"), frameLightest)).toBeGreaterThanOrEqual(8.72);
    expect(contrastRatio(token("rail-ink"), railHoverLightest)).toBeGreaterThanOrEqual(6.5);
    expect(contrastRatio(token("rail-ink-soft"), frameLightest)).toBeGreaterThanOrEqual(4.6);
    expect(contrastRatio(token("list-ink"), ringsLightest)).toBeGreaterThanOrEqual(5.95);
    expect(contrastRatio(token("list-ink-soft"), ringsLightest)).toBeGreaterThanOrEqual(4.63);
    expect(contrastRatio(token("row-selected-ink"), token("row-selected"))).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(token("row-selected-ink-soft"), token("row-selected"))).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the soft ink at 4.6:1 or more on the translucent fills under text on the year rings, the search field's placeholder included", () => {
    // `.wood-rings` points the placeholder color (--muted-foreground) at the soft ink, so the field's fill sits under it.
    expect(css).toMatch(/\.wood-rings \{[^}]*--muted-foreground: var\(--list-ink-soft\);/);
    for (const fill of ["list-field", "list-hover"]) expect(contrastRatio(token("list-ink-soft"), translucent(fill)), fill).toBeGreaterThanOrEqual(4.6);
  });

  it("keeps the top-bar Router input readable on the frame wood at rest and on hover, and solid while focused", () => {
    for (const fill of ["topbar-field", "topbar-field-hover"]) {
      const surface = translucent(fill, frameLightest);
      expect(contrastRatio(token("list-ink-soft"), surface), fill).toBeGreaterThanOrEqual(4.6);
      expect(contrastRatio(token("rail-ink"), surface), fill).toBeGreaterThanOrEqual(5.5);
    }
    expect(css).toMatch(/\.topbar-router input::placeholder \{\s*color: var\(--list-ink-soft\);/);
    expect(css).toMatch(/\.topbar-router:focus-within \{[^}]*background-color: var\(--background\);[^}]*color: var\(--foreground\);/);
    expect(contrastRatio(token("muted-foreground"), token("background"))).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the hourglass sand, warning, and full colors readable on the frame wood", () => {
    for (const name of ["sand", "rail-warn", "rail-danger"]) expect(contrastRatio(token(name), frameLightest), name).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps a 1.34:1 step from the frame to the year rings, as reviewed", () => {
    expect(contrastRatio(token("rings-top"), token("wood-top"))).toBeCloseTo(1.34, 1);
  });

  it("sets the send colors outside a PM from the Router bell's honey", () => {
    const rootSend = ["send", "send-hover", "send-press", "send-ink"].map(token);
    expect(rootSend).toEqual([ROUTER_SEND_COLORS.rest, ROUTER_SEND_COLORS.hover, ROUTER_SEND_COLORS.press, ROUTER_SEND_COLORS.ink]);
    expect(contrastRatio(token("brand-ink"), WHITE)).toBeGreaterThanOrEqual(7);
  });

  it("琥珀色的填充色（--caution）对白底不到 3:1，只能当方块指示和用量条颜色，组件里不拿它当字色", () => {
    expect(contrastRatio(token("caution"), WHITE)).toBeLessThan(3);
    const sources = readdirSync("src/web", { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".tsx") && !f.includes(".test."));
    for (const file of sources) expect(readFileSync(`src/web/${file}`, "utf8"), file).not.toContain("text-caution");
  });
});
