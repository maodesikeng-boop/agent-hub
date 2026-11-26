import { render } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { PlatformIcon } from "../components/DeviceBadges.tsx";
import * as icons from "./icons.ts";

describe("图标出口", () => {
  it("每个导出都渲染成一个 24x24 平滑线条 <svg data-icon=\"line\">，没有 crispEdges、渐变和 <image>", () => {
    const entries = Object.entries(icons).filter((entry): entry is [string, icons.Icon] => typeof entry[1] === "function");
    expect(entries.length).toBeGreaterThanOrEqual(65);

    for (const [name, Icon] of entries) {
      const { container } = render(createElement(Icon));
      const svg = container.querySelector("svg");
      expect(svg, name).not.toBeNull();
      expect(svg, name).toHaveAttribute("data-icon", "line");
      expect(svg, name).toHaveAttribute("aria-hidden", "true");
      expect(svg, name).toHaveAttribute("viewBox", "0 0 24 24");
      expect(svg, name).toHaveAttribute("fill", "none");
      expect(svg, name).toHaveAttribute("stroke", "currentColor");
      expect(svg!.getAttribute("shape-rendering"), name).toBeNull();
      expect(container.querySelector("image, linearGradient, radialGradient"), name).toBeNull();
    }
  });

  it("传 aria-label 时取消 aria-hidden，并透传 className 和 strokeWidth", () => {
    const { container } = render(createElement(icons.Pin, { "aria-label": "Pinned", className: "size-4 text-primary", strokeWidth: 1.5 }));
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-label", "Pinned");
    expect(svg).not.toHaveAttribute("aria-hidden");
    expect(svg).toHaveClass("size-4", "text-primary");
    expect(svg).toHaveAttribute("stroke-width", "1.5");
  });

  it("在忙转圈 Loader2 带 animate-spin 与减弱动效兜底，不再用 pixel-loader", () => {
    const { container } = render(createElement(icons.Loader2, { className: "size-4" }));
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveClass("animate-spin", "motion-reduce:animate-none", "size-4");
    expect(svg.className.baseVal).not.toContain("pixel-loader");
  });

  it("provides the solid pin, the usage hourglass, the send arrow, more and user, and five device icons", () => {
    const pinOutline = render(createElement(icons.Pin)).container.querySelector("svg")!;
    const pinFilled = render(createElement(icons.PinFilled)).container.querySelector("svg")!;
    expect(pinFilled.innerHTML).toContain('fill="currentColor"');
    expect(pinFilled.innerHTML).not.toBe(pinOutline.innerHTML);

    for (const [name, Icon] of [
      ["Hourglass", icons.Hourglass],
      ["ArrowUp", icons.ArrowUp],
      ["MoreHorizontal", icons.MoreHorizontal],
      ["User", icons.User],
      ["Video", icons.Video],
    ] as const) {
      const svg = render(createElement(Icon)).container.querySelector("svg");
      expect(svg, name).not.toBeNull();
      expect(svg, name).toHaveAttribute("data-icon", "line");
    }
    expect("ComposerSend" in icons).toBe(false);
    expect("ComposerStop" in icons).toBe(false);

    const deviceSvgs = [
      icons.DeviceMacos,
      icons.DeviceWindows,
      icons.DeviceLinux,
      icons.DeviceIphone,
      icons.DeviceAndroid,
    ].map((Icon) => render(createElement(Icon)).container.querySelector("svg")!.innerHTML);
    expect(new Set(deviceSvgs).size).toBe(5);
  });

  it("全站只在图标出口导入 lucide-react，已移除 pixelarticons", () => {
    const files = readdirSync("src/web", { recursive: true, encoding: "utf8" }).filter(
      (f) => /\.(ts|tsx)$/.test(f) && f !== join("ui", "icons.ts") && !f.includes(".test."),
    );
    for (const file of files) {
      const text = readFileSync(join("src/web", file), "utf8");
      expect(text, file).not.toMatch(/from "lucide-react"|from "pixelarticons/);
    }
    const entry = readFileSync("src/web/ui/icons.ts", "utf8");
    expect(entry).toContain('from "lucide-react"');
    expect(entry).not.toContain("pixelarticons");
    expect(readFileSync("package.json", "utf8")).toContain('"lucide-react"');
    expect(readFileSync("package.json", "utf8")).not.toContain('"pixelarticons"');
  });

  it("PlatformIcon 为五种主流设备与兜底桌面返回区分清晰的图标", () => {
    const rendered = ["darwin", "win32", "linux", "iphone", "android", "freebsd"].map(
      (platform) => render(createElement(PlatformIcon, { platform })).container.querySelector("svg")!.innerHTML,
    );
    expect(new Set(rendered).size).toBe(6);
  });

  it("gives every device a solid form for the selected computer that fills its outline and keeps the line icon's size", () => {
    for (const platform of ["darwin", "win32", "linux", "iphone", "android", "freebsd"]) {
      const line = render(createElement(PlatformIcon, { platform })).container.querySelector("svg")!;
      const solid = render(createElement(PlatformIcon, { platform, solid: true })).container.querySelector("svg")!;
      expect(solid.getAttribute("viewBox"), platform).toBe(line.getAttribute("viewBox"));
      expect(solid.outerHTML, platform).toMatch(/fill="currentColor"/);
      expect(solid.outerHTML, platform).not.toBe(line.outerHTML);
    }
  });
});
