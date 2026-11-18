// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PALETTE } from "../lib/palette.ts";
import { Avatar } from "./Avatar.tsx";

const img = (ui: React.ReactElement) => render(ui).container.querySelector("img")!;

describe("Avatar：水果史莱姆小动物头像", () => {
  it("项目经理渲染主形象的原生 SVG，Piece（neutral）渲染纸片分身；没有位图", () => {
    expect(img(<Avatar colorKey={1} />).getAttribute("src")).toBe(PALETTE[1]!.main);
    expect(img(<Avatar colorKey={1} neutral />).getAttribute("src")).toBe(PALETTE[1]!.piece);
    for (const color of PALETTE) for (const url of [color.main, color.piece]) expect(url).toMatch(/\.svg$|^data:image\/svg\+xml/);
  });

  it("空闲时不带 data-working（不动）；在干活才带，交给 styles.css 的 .slime-pet 蹦跳", () => {
    expect(img(<Avatar colorKey={2} />).hasAttribute("data-working")).toBe(false);
    const working = img(<Avatar colorKey={2} working />);
    expect([working.getAttribute("data-working"), working.classList.contains("slime-pet")]).toEqual(["true", true]);
  });

  it("蹦跳只动 transform、以脚底为原点；减弱动态效果时悬停和干活的动画都关掉", () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    expect(css).toMatch(/\.slime-pet \{\s*transform-origin: 50% 100%;\s*\}/);
    for (const name of ["slime-hop", "slime-hop-working"]) {
      const body = new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`).exec(css)![1]!;
      const props = [...body.matchAll(/^\s+([a-z-]+):/gm)].map((m) => m[1]);
      expect(new Set(props), name).toEqual(new Set(["transform"]));
    }
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.slime-pet:hover,\s*\.slime-pet\[data-working\] \{\s*animation: none;/);
  });
});
