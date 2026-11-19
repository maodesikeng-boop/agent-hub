// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultLookOf, slimePaths } from "../../shared/slimes.ts";
import { Avatar } from "./Avatar.tsx";

const svg = (ui: React.ReactElement) => render(ui).container.querySelector("svg")!;
const fills = (el: Element) => [...el.querySelectorAll("path")].map((p) => p.getAttribute("fill"));

describe("Avatar：史莱姆小动物头像", () => {
  it("项目经理画主形象、Piece（neutral）画便签小灵，都是内联的像素 SVG（crispEdges），没有位图", () => {
    const look = defaultLookOf(1);
    const main = svg(<Avatar look={look} />);
    expect(main.getAttribute("shape-rendering")).toBe("crispEdges");
    expect(fills(main)).toEqual(slimePaths(look, "main").map((p) => p.fill));
    const piece = svg(<Avatar look={look} neutral />);
    expect(fills(piece)).toEqual(slimePaths(look, "piece").map((p) => p.fill));
    expect(render(<Avatar look={look} />).container.querySelector("img")).toBeNull();
  });

  it("空闲时不带 data-working（不动）；在干活才带，交给 styles.css 的 .slime-pet 蹦跳", () => {
    expect(svg(<Avatar look={defaultLookOf(2)} />).hasAttribute("data-working")).toBe(false);
    const working = svg(<Avatar look={defaultLookOf(2)} working />);
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
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.slime-pet:hover,\s*\.slime-pet\[data-working\],[^{]*\{\s*animation: none;/);
  });
});
