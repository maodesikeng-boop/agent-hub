// 界面大小（设置 → 通用 → 界面大小）：4 档，点了马上改 <html data-ui-scale> 并记住；字号、头像都是 rem，跟着根字号一起缩放。
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Avatar } from "./components/Avatar.tsx";
import { SettingsDialog } from "./components/SettingsDialog.tsx";
import { cn } from "./lib/utils.ts";
import { DEFAULT_UI_SCALE, readUiScale, UI_SCALE_KEY } from "./ui-scale.ts";

const notify = { permission: "granted" as const, enabled: false, setEnabled: async () => {} };

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.uiScale;
});

describe("Interface scale", () => {
  it("没存过、存坏了都按默认的“大”", () => {
    expect(DEFAULT_UI_SCALE).toBe("lg");
    expect(readUiScale()).toBe("lg");
    localStorage.setItem(UI_SCALE_KEY, "huge");
    expect(readUiScale()).toBe("lg");
    localStorage.setItem(UI_SCALE_KEY, "sm");
    expect(readUiScale()).toBe("sm");
  });

  it("设置 → 通用 → 外观：紧凑 / 标准 / 大 / 特大，默认选“大”；点了马上改根字号档位并记住", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => {}} notify={notify} />);
    const group = screen.getByRole("radiogroup", { name: "Interface scale" });
    const options = within(group).getAllByRole("radio");
    expect(options.map((o) => o.textContent)).toEqual(["Compact", "Default", "Large", "XL"]);
    expect(within(group).getByRole("radio", { name: "Large" })).toHaveAttribute("aria-checked", "true");

    await user.click(within(group).getByRole("radio", { name: "XL" }));
    expect(document.documentElement.dataset.uiScale).toBe("xl");
    expect(localStorage.getItem(UI_SCALE_KEY)).toBe("xl");
    expect(within(group).getByRole("radio", { name: "XL" })).toHaveAttribute("aria-checked", "true");

    await user.click(within(group).getByRole("radio", { name: "Compact" }));
    expect(document.documentElement.dataset.uiScale).toBe("sm");
    expect(localStorage.getItem(UI_SCALE_KEY)).toBe("sm");
  });

  it("各档根字号在 styles.css 一处，用百分比；没设时是“大”", () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    expect(css).toMatch(/html,\s*html\[data-ui-scale="lg"\]\s*\{\s*font-size:\s*109\.375%/);
    expect(css).toMatch(/html\[data-ui-scale="sm"\]\s*\{\s*font-size:\s*90\.625%/);
    expect(css).toMatch(/html\[data-ui-scale="md"\]\s*\{\s*font-size:\s*100%/);
    expect(css).toMatch(/html\[data-ui-scale="xl"\]\s*\{\s*font-size:\s*118\.75%/);
    for (const token of ["display", "title", "body", "minor"]) expect(css).toMatch(new RegExp(`--text-${token}: [0-9.]+rem;`));
  });

  it("字号合成 4 档（12 / 13.5 / 15 / 17，docs/ui-standard.md 第 3 条）：没有 14px 的 text-label，旧名 text-small 已删", () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    const rem = (token: string) => Number(new RegExp(`--text-${token}: ([0-9.]+)rem;`).exec(css)?.[1]) * 16;
    expect([rem("minor"), rem("body"), rem("title")]).toEqual([13.5, 15, 17]);
    expect(css).not.toMatch(/--text-small:/);
    expect(css).not.toMatch(/--text-label:/);
    for (const dir of ["src/web/components", "src/web/ui"]) {
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".tsx") && !f.includes(".test."))) {
        expect(readFileSync(`${dir}/${file}`, "utf8"), file).not.toMatch(/\btext-(label|sm)\b/);
      }
    }
  });

  it("组件里不写死像素字号和宽度（text-[15px]、w-[240px]），不然界面大小管不到", () => {
    const dirs = ["src/web/components", "src/web/ui"];
    for (const dir of dirs) {
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".tsx") && !f.includes(".test."))) {
        const src = readFileSync(`${dir}/${file}`, "utf8");
        expect(src, file).not.toMatch(/\b(text|leading|w|h|max-w|min-w|min-h|size)-\[[0-9.]+px\]/);
      }
    }
  });

  it("头像写成 rem（标准档的像素 / 16）", () => {
    const { container } = render(<Avatar colorKey={1} size={44} />);
    expect((container.querySelector("[data-slot='avatar']") as HTMLElement).style.width).toBe("2.75rem");
  });

  it("自定义字号不会被 tailwind-merge 当成颜色吃掉", () => {
    expect(cn("text-body", "text-muted-foreground")).toBe("text-body text-muted-foreground");
    expect(cn("text-body", "text-minor")).toBe("text-minor");
  });
});
