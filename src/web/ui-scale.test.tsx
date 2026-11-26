// 界面大小（设置 → 通用 → 界面大小）：4 档，点了马上改 <html data-ui-scale> 并记住；字号、头像都是 rem，跟着根字号一起缩放。
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Avatar } from "./components/Avatar.tsx";
import { SettingsDialogFixture } from "./components/settings-dialog-fixture.tsx";
import { cn } from "./lib/utils.ts";
import { DEFAULT_UI_SCALE, readUiScale, UI_SCALE_KEY, UI_SCALE_ROOT_PX, UI_SCALES } from "./ui-scale.ts";

import { defaultLookOf } from "../shared/slimes.ts";
const notify = { permission: "granted" as const, enabled: false, setEnabled: async () => {} };

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.uiScale;
});

describe("Interface scale", () => {
  it("falls back to Default when nothing or a broken value is stored, and keeps a saved choice", () => {
    expect(DEFAULT_UI_SCALE).toBe("md");
    expect(readUiScale()).toBe("md");
    localStorage.setItem(UI_SCALE_KEY, "huge");
    expect(readUiScale()).toBe("md");
    localStorage.setItem(UI_SCALE_KEY, "lg");
    expect(readUiScale()).toBe("lg");
    localStorage.setItem(UI_SCALE_KEY, "sm");
    expect(readUiScale()).toBe("sm");
  });

  it("Settings offers Compact, Default, Large, and XL in a menu showing Default, and a pick applies and saves the scale", async () => {
    const user = userEvent.setup();
    render(<SettingsDialogFixture open onOpenChange={() => {}} notify={notify} />);
    const trigger = screen.getByRole("combobox", { name: "Interface scale" });
    expect(trigger).toHaveTextContent("Default");
    await user.click(trigger);
    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getAllByRole("option").map((o) => o.textContent)).toEqual(["Compact", "Default", "Large", "XL"]);
    expect(within(listbox).getByRole("option", { name: "Default" })).toHaveAttribute("aria-selected", "true");

    await user.click(within(listbox).getByRole("option", { name: "XL" }));
    expect(document.documentElement.dataset.uiScale).toBe("xl");
    expect(localStorage.getItem(UI_SCALE_KEY)).toBe("xl");
    expect(screen.getByRole("combobox", { name: "Interface scale" })).toHaveTextContent("XL");

    await user.click(screen.getByRole("combobox", { name: "Interface scale" }));
    await user.click(within(await screen.findByRole("listbox")).getByRole("option", { name: "Compact" }));
    expect(document.documentElement.dataset.uiScale).toBe("sm");
    expect(localStorage.getItem(UI_SCALE_KEY)).toBe("sm");
  });

  it("sets Default to 17.5px with the other scales 1.5px apart, as percentages in styles.css, and an unset scale renders as Default", () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    expect(UI_SCALES.map((scale) => UI_SCALE_ROOT_PX[scale])).toEqual([16, 17.5, 19, 20.5]);
    expect(css).toMatch(/html,\s*html\[data-ui-scale="md"\]\s*\{/);
    for (const scale of UI_SCALES) {
      const percent = new RegExp(`html\\[data-ui-scale="${scale}"\\]\\s*\\{\\s*font-size:\\s*([0-9.]+)%`).exec(css)?.[1];
      expect(Number(percent), scale).toBe((UI_SCALE_ROOT_PX[scale] / 16) * 100);
    }
    for (const token of ["display", "title", "body", "minor"]) expect(css).toMatch(new RegExp(`--text-${token}: [0-9.]+rem;`));
  });

  it("keeps four type sizes (12, 13.5, 15, 16 at a 16px root) with no 14px label size and no old text-small name", () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    const rem = (token: string) => Number(new RegExp(`--text-${token}: ([0-9.]+)rem;`).exec(css)?.[1]) * 16;
    expect([rem("minor"), rem("body"), rem("title")]).toEqual([13.5, 15, 16]);
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
    const { container } = render(<Avatar look={defaultLookOf(1)} size={44} />);
    expect((container.querySelector("[data-slot='avatar']") as HTMLElement).style.width).toBe("2.75rem");
  });

  it("自定义字号不会被 tailwind-merge 当成颜色吃掉", () => {
    expect(cn("text-body", "text-muted-foreground")).toBe("text-body text-muted-foreground");
    expect(cn("text-body", "text-minor")).toBe("text-minor");
  });
});
