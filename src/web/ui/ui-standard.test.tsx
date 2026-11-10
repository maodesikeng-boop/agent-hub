// 共用组件守着 docs/ui-standard.md 的几条硬规则：聚焦不用主色、控件统一高度、不能点的主按钮是中性灰。
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Button } from "./button.tsx";
import { Input, Select, Textarea } from "./input.tsx";
import { Switch } from "./switch.tsx";
import { Avatar } from "../components/Avatar.tsx";
import { PALETTE } from "../lib/palette.ts";

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

  it("聊天输入框（Composer）：聚焦时只多出强调色的纯模糊光晕（.composer-frame，边框不变，没有实心的圈和黑影，不内联 <style>），空输入时发送键不可点，回弹动画在 styles.css，空/单行同一行、多行落到下一行", () => {
    const composerSrc = readFileSync("src/web/components/Composer.tsx", "utf8");
    expect(composerSrc).toContain("composer-frame");
    expect(composerSrc).not.toContain("focus-within:");
    expect(composerSrc).not.toContain("<style>");
    expect(composerSrc).toContain("composer-send-bounce");
    expect(composerSrc).toMatch(/disabled=\{!canSend\}/);
    expect(composerSrc).toMatch(/data-multiline=\{multiline\}/);
    const css = readFileSync("src/web/styles.css", "utf8");
    expect(css).toMatch(/\.composer-send-bounce\s*\{\s*animation: composer-send-bounce 150ms/);
    expect(css).toMatch(/@keyframes composer-send-bounce/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.composer-send-bounce\s*\{\s*animation: none/);

    // 聚焦态：只动 box-shadow（边框颜色、粗细都不变，不引起布局跳动），光晕只用 --primary 掺透明
    expect(css).toMatch(/--motion-focus: 180ms;/);
    const rest = /\.composer-frame \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rest).toMatch(/box-shadow: 0 2px 10px rgba\(0, 0, 0, 0\.05\);/);
    expect(rest).toMatch(/transition: box-shadow var\(--motion-focus\) ease-out;/);
    const focus = /\.composer-frame:focus-within \{([^}]*)\}/.exec(css)?.[1] ?? "";
    const declared = [...focus.matchAll(/^\s*([a-z-]+):/gm)].map((m) => m[1]);
    expect(declared).toEqual(["box-shadow"]);
    // 光晕每一层：偏移 0、模糊半径 ≥ 12px、没有 spread（不是硬圈）、颜色是 --primary 掺透明，不是黑色
    const shadow = /box-shadow:([^;]*);/.exec(focus)?.[1] ?? "";
    const layers = shadow
      .replace(/\([^()]*(?:\([^()]*(?:\([^()]*\)[^()]*)*\)[^()]*)*\)/g, (fn) => fn.replaceAll(",", ";")) // 括号里的逗号不算分层
      .split(",")
      .map((l) => l.trim());
    expect(layers).toHaveLength(2);
    for (const layer of layers) {
      const m = /^0 0 (\d+)px (color-mix\(.*\))$/.exec(layer);
      expect(Number(m?.[1])).toBeGreaterThanOrEqual(12);
      expect(m?.[2]).toContain("var(--primary)");
    }
    expect(shadow).not.toMatch(/#000|black|rgba?\(/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.composer-frame\s*\{\s*transition: none/);
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

  it("开关：精致尺寸 h-5 w-9（滑块 size-4），带 touch-target 与中性键盘焦点圈", () => {
    render(<Switch aria-label="Notifications" checked={false} onCheckedChange={() => {}} />);
    const sw = screen.getByRole("switch", { name: "Notifications" });
    expect(classOf(sw)).toEqual(expect.arrayContaining(["h-5", "w-9", "touch-target", "focus-visible:ring-ring/50"]));
    expect(sw.firstElementChild).toHaveClass("size-4");
  });

  it("头像（第 17 条）：项目经理渲染完整水果切片（slice），Worker（neutral）渲染对应水果切下的果瓣（wedge）", () => {
    const { container } = render(
      <>
        <Avatar colorKey={0} size={44} />
        <Avatar colorKey={0} size={24} neutral />
      </>,
    );
    const avatars = container.querySelectorAll("[data-slot='avatar']");
    expect(avatars).toHaveLength(2);
    expect(avatars[0]).not.toHaveAttribute("data-neutral");
    expect(avatars[1]).toHaveAttribute("data-neutral", "true");
    expect(avatars[0]!.querySelector("img")?.getAttribute("src")).toBe(PALETTE[0]!.slice);
    expect(avatars[1]!.querySelector("img")?.getAttribute("src")).toBe(PALETTE[0]!.wedge);
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

// 第 19 条：手机和小屏。jsdom 不算媒体查询，所以这里读 styles.css / index.html 的文字，守住数字和写法。
describe("界面标准：手机和小屏（第 19 条）", () => {
  const css = readFileSync("src/web/styles.css", "utf8");
  const html = readFileSync("src/web/index.html", "utf8");
  /** 取某个 @media 块里的全部文字（花括号配对）。 */
  const mediaBlock = (query: RegExp) => {
    const start = query.exec(css);
    expect(start, `styles.css 里要有 ${query}`).not.toBeNull();
    let depth = 0;
    for (let i = css.indexOf("{", start!.index); i < css.length; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", start!.index) + 1, i);
    }
    throw new Error("花括号没配上");
  };

  it("视口：viewport-fit=cover（铺到刘海下）、interactive-widget=resizes-content（键盘弹起时网页变矮）", () => {
    const viewport = /<meta name="viewport" content="([^"]+)"/.exec(html)![1]!;
    expect(viewport).toContain("width=device-width");
    expect(viewport).toContain("viewport-fit=cover");
    expect(viewport).toContain("interactive-widget=resizes-content");
  });

  it("整页高度用 100dvh，不用会被地址栏挤出屏幕的 100vh", () => {
    expect(css).toMatch(/#root\s*\{[^}]*height:\s*100dvh/);
    expect(css).not.toMatch(/\b100vh\b/);
  });

  it("安全区：--safe-top / --safe-bottom 一处从 env() 取，主区和左栏抽屉上下各垫一份，组件里不直接写 env()", () => {
    expect(css).toMatch(/--safe-top:\s*env\(safe-area-inset-top, 0px\)/);
    expect(css).toMatch(/--safe-bottom:\s*env\(safe-area-inset-bottom, 0px\)/);
    expect(css).toMatch(/\.chat-main\s*\{[^}]*padding-top:\s*var\(--safe-top\)[^}]*padding-bottom:\s*var\(--safe-bottom\)/s);
    expect(readFileSync("src/web/components/Sidebar.tsx", "utf8")).toMatch(
      /pt-\[calc\(var\(--safe-top\)\+var\(--macos-traffic-lights-height\)\)\][^"]*pb-\[var\(--safe-bottom\)\]|pb-\[var\(--safe-bottom\)\][^"]*pt-\[calc\(var\(--safe-top\)\+var\(--macos-traffic-lights-height\)\)\]/,
    );
    for (const file of ["Sidebar", "Conversation", "WorkerConversation", "PmProfile", "Composer"]) {
      expect(readFileSync(`src/web/components/${file}.tsx`, "utf8"), `${file} 不直接写 env(`).not.toContain("env(");
    }
  });

  it("Mac 桌面应用（第 16 条）：红黄绿交通灯安全区变量在 styles.css 集中定义，左栏常驻避让红黄绿，顶栏无需额外让出 72px", () => {
    expect(css).toMatch(/--macos-traffic-lights-width:\s*0px;/);
    expect(css).toMatch(/--macos-traffic-lights-height:\s*0px;/);
    expect(css).toMatch(/html\[data-macos-app="true"\]\s*\{[^}]*--macos-traffic-lights-width:\s*72px;[^}]*--macos-traffic-lights-height:\s*28px;/s);
    expect(css).not.toMatch(/@media \(max-width: 1100px\)\s*\{[^}]*html\[data-macos-app="true"\]/s);
  });

  it("触屏（pointer: coarse）下 input / textarea / select 一律 16px，防 iOS 聚焦放大；电脑上仍是组件自己的 15px", () => {
    const coarse = mediaBlock(/@media \(pointer: coarse\)/);
    expect(coarse).toMatch(/input,\s*textarea,\s*select\s*\{[^}]*font-size:\s*max\(16px, var\(--text-body\)\)/);
    // 16px 只在触屏规则里，不改电脑上的 15px
    expect(css.replace(coarse, "")).not.toMatch(/input,\s*textarea,\s*select\s*\{[^}]*font-size/);
  });

  it("触屏下 .touch-target 把可点范围撑到 44px（视觉大小不变），放在 components 层，不盖掉 absolute 之类的工具类", () => {
    const coarse = mediaBlock(/@media \(pointer: coarse\)/);
    expect(coarse).toMatch(/\.touch-target::after\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/s);
    expect(css).toMatch(/@layer components\s*\{[\s\S]*\.touch-target\s*\{[^}]*position:\s*relative/);
  });

  it("按钮（含图标按钮）和待发文件的“去掉”带 touch-target；视觉尺寸仍是 36 / 32px", () => {
    render(
      <>
        <Button>默认</Button>
        <Button size="sm">小</Button>
        <Button size="icon" aria-label="图标" />
        <Button size="icon-sm" aria-label="小图标" />
      </>,
    );
    for (const name of ["默认", "小", "图标", "小图标"]) expect(classOf(screen.getByRole("button", { name }))).toContain("touch-target");
    expect(classOf(screen.getByRole("button", { name: "图标" }))).toContain("size-9");
    expect(classOf(screen.getByRole("button", { name: "小图标" }))).toContain("size-8");
    const composerSrc = readFileSync("src/web/components/Composer.tsx", "utf8");
    expect(composerSrc).toMatch(/const CHIP_CLOSE_CLASS =\s*"touch-target [^"]*";/);
    expect(composerSrc).toMatch(/className=\{CHIP_CLOSE_CLASS\}\s+onClick=\{\(\) => staging\.remove/);
  });

  it("右栏的行（一行挨一行）触屏下本身 44px 高，不用撑开的办法", () => {
    expect(readFileSync("src/web/components/RightRail.tsx", "utf8")).toContain("pointer-coarse:min-h-11");
  });

  it("没有悬停才出现的操作", () => {
    for (const file of ["Messages", "RightRail", "Sidebar", "Composer", "Conversation"]) {
      expect(readFileSync(`src/web/components/${file}.tsx`, "utf8")).not.toMatch(/group-hover:(opacity|visible)|opacity-0/);
    }
  });

  it("在忙的状态词流光：只用字本身的颜色，减少动态效果时不动", () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    const rule = css.match(/\.status-shimmer \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/background-clip: text/);
    expect(rule).toMatch(/animation: status-shimmer/);
    expect(rule).not.toMatch(/#[0-9a-f]{3,6}\b|\brgba?\(|\bhsla?\(/i);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.status-shimmer \{\s*animation: none;/);
  });
});
