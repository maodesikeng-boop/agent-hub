import { render } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import * as icons from "./icons.ts";

const LINE_ICONS = new Set(["ComposerAdd", "ComposerSend", "ComposerStop", "ComposerFile", "ComposerRemove", "ComposerBot"]);
const exported = Object.entries(icons).filter((entry): entry is [string, icons.Icon] => typeof entry[1] === "function" || typeof entry[1] === "object");

function svgOf(name: string, props: Record<string, unknown> = {}): SVGSVGElement {
  const Icon = (icons as unknown as Record<string, icons.Icon>)[name]!;
  const { container } = render(createElement(Icon, props));
  return container.querySelector("svg")!;
}

describe("图标出口", () => {
  it("除输入框的 Composer* 外，每个导出都渲染成一个 crispEdges、fill=currentColor 的 <svg>，没有 stroke、渐变和 <image>", () => {
    const pixel = exported.filter(([name]) => !LINE_ICONS.has(name));
    expect(pixel.length).toBeGreaterThan(50);
    for (const [name] of pixel) {
      const svg = svgOf(name);
      expect(svg, name).not.toBeNull();
      expect(svg.getAttribute("shape-rendering"), name).toBe("crispEdges");
      expect(svg.getAttribute("fill"), name).toBe("currentColor");
      expect(svg.getAttribute("data-icon"), name).toBe("pixel");
      expect(svg.getAttribute("viewBox"), name).toBe("0 0 24 24");
      expect(svg.outerHTML, name).not.toMatch(/stroke=|Gradient|<image/);
    }
  });

  it("Composer* 是 stroke=currentColor 的线条图标，没有 crispEdges", () => {
    for (const name of LINE_ICONS) {
      const svg = svgOf(name);
      expect(svg.getAttribute("stroke"), name).toBe("currentColor");
      expect(svg.getAttribute("shape-rendering"), name).toBeNull();
      expect(svg.getAttribute("data-icon"), name).toBe("line");
    }
  });

  it("不传 aria-label 时 aria-hidden；传了 aria-label 时读屏念它", () => {
    expect(svgOf("Settings").getAttribute("aria-hidden")).toBe("true");
    const labelled = svgOf("Settings", { "aria-label": "Settings" });
    expect(labelled.getAttribute("aria-hidden")).toBeNull();
    expect(labelled.getAttribute("aria-label")).toBe("Settings");
    expect(svgOf("ComposerSend").getAttribute("aria-hidden")).toBe("true");
  });

  it("className 原样带到 <svg> 上，传 strokeWidth 不报错也不改样子；像素图标没有写死的宽高", () => {
    const svg = svgOf("Plus", { className: "size-pixel text-primary", strokeWidth: 3 });
    expect(svg.getAttribute("class")).toBe("size-pixel text-primary");
    expect(svg.getAttribute("stroke-width")).toBeNull();
    expect([svg.getAttribute("width"), svg.getAttribute("height")]).toEqual([null, null]);
  });

  it("在忙的转圈是 8 根一根根亮，自己带 pixel-loader 动画，不靠 animate-spin 转画布", () => {
    const svg = svgOf("Loader2", { className: "size-pixel-sm" });
    expect(svg.getAttribute("class")).toBe("pixel-loader size-pixel-sm");
    expect(svg.querySelectorAll("path")).toHaveLength(8);
    const css = readFileSync("src/web/styles.css", "utf8");
    expect(css).toMatch(/\.pixel-loader > path \{[^}]*animation: pixel-loader/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.pixel-loader > path \{\s*animation: none;/);
  });

  it("全站只在图标出口导入 pixelarticons，已移除 lucide-react", () => {
    const files = readdirSync("src/web", { recursive: true, encoding: "utf8" }).filter((f) => /\.(ts|tsx)$/.test(f) && f !== join("ui", "icons.ts") && !f.includes(".test."));
    for (const file of files) {
      const text = readFileSync(join("src/web", file), "utf8");
      expect(text, file).not.toMatch(/from "lucide-react"|from "pixelarticons/);
    }
    expect(readFileSync("src/web/ui/icons.ts", "utf8")).not.toContain('from "lucide-react"');
    expect(readFileSync("package.json", "utf8")).not.toContain('"lucide-react"');
  });
});
