// 共用组件守着 docs/ui-standard.md 的几条硬规则：聚焦不用主色、控件统一高度、不能点的主按钮是中性灰。
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Button } from "./button.tsx";
import { Input, Select, Textarea } from "./input.tsx";

const classOf = (el: HTMLElement) => el.className.split(/\s+/);

describe("界面标准：共用组件", () => {
  it("输入框、多行输入、下拉：聚焦时样子不变（边框不加深、没有光圈），靠光标表示；圆角 rounded-xl；输入框和下拉高 36px", () => {
    render(
      <>
        <Input aria-label="输入框" />
        <Textarea aria-label="多行" />
        <Select aria-label="下拉">
          <option>一</option>
        </Select>
      </>,
    );
    for (const el of [screen.getByRole("textbox", { name: "输入框" }), screen.getByRole("textbox", { name: "多行" }), screen.getByRole("combobox", { name: "下拉" })]) {
      const cls = classOf(el);
      expect(cls).toContain("rounded-xl");
      expect(el.className).not.toMatch(/primary|focus|ring/);
    }
    expect(classOf(screen.getByRole("textbox", { name: "输入框" }))).toContain("h-9");
    expect(classOf(screen.getByRole("combobox", { name: "下拉" }))).toContain("h-9");
  });

  it("下拉 plain（分组行里改了马上存的）：没有边框和底色，悬停、聚焦浅灰底，高 36px，不用主色", () => {
    render(
      <Select aria-label="行里的下拉" variant="plain">
        <option>一</option>
      </Select>,
    );
    const cls = classOf(screen.getByRole("combobox", { name: "行里的下拉" }));
    expect(cls).toEqual(expect.arrayContaining(["h-9", "rounded-xl", "bg-transparent", "hover:bg-sidebar-hover", "focus-visible:bg-sidebar-hover"]));
    expect(cls).not.toContain("border");
    expect(cls.join(" ")).not.toMatch(/primary/);
  });

  it("按钮：默认 36px、sm 32px，图标按钮同两档；键盘焦点是中性的 ring-ring；不能点的主按钮换中性灰", () => {
    render(
      <>
        <Button>默认</Button>
        <Button size="sm">小</Button>
        <Button size="icon" aria-label="图标" />
        <Button size="icon-sm" aria-label="小图标" />
      </>,
    );
    expect(classOf(screen.getByRole("button", { name: "默认" }))).toEqual(expect.arrayContaining(["h-9", "focus-visible:ring-ring/50", "disabled:bg-sidebar-active"]));
    expect(classOf(screen.getByRole("button", { name: "小" }))).toContain("h-8");
    expect(classOf(screen.getByRole("button", { name: "图标" }))).toContain("size-9");
    expect(classOf(screen.getByRole("button", { name: "小图标" }))).toContain("size-8");
  });

  it("--ring 是中性灰，不是主色", () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    expect(css).toMatch(/--color-ring: var\(--ring\);/);
    expect(css).toMatch(/--ring: #a1a1aa;/);
  });

  it("界面字体用系统字体（-apple-system、SF Pro Text 在前，中文字体在后），不打包 Inter", () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    const stack = /--font-ui:\s*([^;]+);/.exec(css)![1]!;
    expect(stack).not.toMatch(/Inter/);
    const order = ["-apple-system", "BlinkMacSystemFont", '"SF Pro Text"', '"PingFang SC"', "sans-serif"].map((f) => stack.indexOf(f));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(readFileSync("src/web/main.tsx", "utf8")).not.toMatch(/fontsource/);
    expect(readFileSync("package.json", "utf8")).not.toMatch(/fontsource/);
  });
});
