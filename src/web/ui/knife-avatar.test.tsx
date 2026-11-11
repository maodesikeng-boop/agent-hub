import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KnifeAvatar } from "../components/KnifeAvatar.tsx";
import { contrastRatio } from "../lib/palette.ts";

describe("KnifeAvatar（水果刀矢量头像，docs/ui-standard.md 第 4、21 条）", () => {
  it("尺寸换算为 size / 16 rem（默认 44 -> 2.75rem），与 Avatar.tsx 完全对齐跟随四档界面缩放", () => {
    const { container, rerender } = render(<KnifeAvatar />);
    const root = container.querySelector<HTMLElement>("[data-slot='knife-avatar']");
    expect(root).not.toBeNull();
    expect(root).toHaveAttribute("aria-hidden", "true");
    expect(root!.style.width).toBe("2.75rem");
    expect(root!.style.height).toBe("2.75rem");

    const svg = root!.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute("viewBox", "0 0 44 44");

    for (const [size, expectedRem] of [
      [20, "1.25rem"],
      [28, "1.75rem"],
      [36, "2.25rem"],
      [40, "2.5rem"],
    ] as const) {
      rerender(<KnifeAvatar size={size} className="opacity-40" />);
      const updated = container.querySelector<HTMLElement>("[data-slot='knife-avatar']")!;
      expect(updated.style.width).toBe(expectedRem);
      expect(updated.style.height).toBe(expectedRem);
      expect(updated).toHaveClass("opacity-40");
    }
  });

  it("SVG 内部 linearGradient 使用 useId() 生成实例级唯一 ID，同屏多实例卸载其一不会导致另一把刀渐变丢失变黑", () => {
    function DualKnives({ showSidebarKnife }: { showSidebarKnife: boolean }) {
      return (
        <div>
          {showSidebarKnife && <KnifeAvatar size={44} className="sidebar-knife" />}
          <KnifeAvatar size={28} className="header-knife" />
        </div>
      );
    }

    const { container, rerender } = render(<DualKnives showSidebarKnife={true} />);
    const avatars = container.querySelectorAll("[data-slot='knife-avatar']");
    expect(avatars).toHaveLength(2);

    const grad0 = avatars[0]!.querySelector("linearGradient");
    const grad1 = avatars[1]!.querySelector("linearGradient");
    expect(grad0).not.toBeNull();
    expect(grad1).not.toBeNull();

    const id0 = grad0!.getAttribute("id")!;
    const id1 = grad1!.getAttribute("id")!;
    expect(id0).toBeTruthy();
    expect(id1).toBeTruthy();
    expect(id0).not.toBe("knife-blade");
    expect(id1).not.toBe("knife-blade");
    expect(id0).not.toBe(id1);

    const blade0 = avatars[0]!.querySelector("[data-part='blade']")!;
    const blade1 = avatars[1]!.querySelector("[data-part='blade']")!;
    expect(blade0.getAttribute("fill")).toBe(`url(#${id0})`);
    expect(blade1.getAttribute("fill")).toBe(`url(#${id1})`);

    // 卸载左栏置顶刀后，顶栏刀引用的 linearGradient ID 依然完好在 DOM 中
    rerender(<DualKnives showSidebarKnife={false} />);
    expect(container.querySelectorAll("[data-slot='knife-avatar']")).toHaveLength(1);
    const remainingBlade = container.querySelector("[data-part='blade']")!;
    expect(remainingBlade.getAttribute("fill")).toBe(`url(#${id1})`);
    const remainingGrad = container.querySelector("linearGradient")!;
    expect(remainingGrad.getAttribute("id")).toBe(id1);
  });

  it("刀背轮廓描边与碳黑刀柄对工作台白底及侧栏各态底色对比度均满足 WCAG 1.4.11 >= 3:1", () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    const cssHex = (varName: string) => {
      const m = new RegExp(`--${varName}:\\s*(#[0-9a-fA-F]{6});`).exec(css);
      expect(m, `styles.css 应定义 --${varName}`).not.toBeNull();
      return m![1]!.toLowerCase();
    };
    const surfaces = [
      cssHex("background"),
      cssHex("sidebar"),
      cssHex("sidebar-hover"),
      cssHex("sidebar-active"),
    ];

    const { container } = render(<KnifeAvatar />);
    const blade = container.querySelector("[data-part='blade']")!;
    const handle = container.querySelector("[data-part='handle']")!;
    const spineStroke = blade.getAttribute("stroke")!;
    const handleFill = handle.getAttribute("fill")!;

    expect(spineStroke).toMatch(/^#[0-9a-f]{6}$/i);
    expect(handleFill).toMatch(/^#[0-9a-f]{6}$/i);

    for (const bg of surfaces) {
      expect(contrastRatio(spineStroke, bg)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(handleFill, bg)).toBeGreaterThanOrEqual(3);
    }
  });
});
