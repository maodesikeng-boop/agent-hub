// Shared primitives guard docs/ui-standard.md: one 4px radius, 1px warm-ink lines, neutral focus, one control height, warm disabled primary, custom dropdowns.
import { act, render, renderHook, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SCROLLBAR_IDLE_HIDE_MS } from "../limits.ts";
import { useAutoHideScrollbars } from "../useAutoHideScrollbars.ts";
import { Button } from "./button.tsx";
import { Drawer, DrawerContent, DrawerTitle } from "./drawer.tsx";
import { Input, Textarea } from "./input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select.tsx";
import { Switch } from "./switch.tsx";
import { Avatar } from "../components/Avatar.tsx";

import { defaultLookOf, slimePaths } from "../../shared/slimes.ts";
const classOf = (el: HTMLElement) => el.className.split(/\s+/);

describe("界面标准：共用组件", () => {
  it("输入框、多行输入、自建下拉：4px 小圆角、1px border-border-strong 控件线，聚焦只加深到 --border-focus，输入框和下拉高 36px", () => {
    render(
      <>
        <Input aria-label="输入框" />
        <Textarea aria-label="多行" />
        <Select value="a" onValueChange={() => {}}>
          <SelectTrigger aria-label="下拉">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="a">一</SelectItem>
          </SelectContent>
        </Select>
      </>,
    );
    for (const el of [screen.getByRole("textbox", { name: "输入框" }), screen.getByRole("textbox", { name: "多行" }), screen.getByRole("combobox", { name: "下拉" })]) {
      const cls = classOf(el);
      // The select trigger is a <button>, so it takes the 4px radius from the base layer like every control.
      expect(cls).toEqual(expect.arrayContaining(["border", "border-border-strong"]));
      expect(cls.some((c) => /^focus(-visible)?:field-focus$/.test(c))).toBe(true);
      expect(el.className).not.toMatch(/border-2|rounded-(?!sm\b)|primary|ring/);
    }
    for (const name of ["输入框", "多行"]) expect(classOf(screen.getByRole("textbox", { name }))).toContain("rounded-sm");
    expect(classOf(screen.getByRole("textbox", { name: "输入框" }))).toContain("h-9");
    expect(classOf(screen.getByRole("combobox", { name: "下拉" }))).toContain("h-9");
  });

  it("自建 Radix 下拉（SelectContent / SelectItem）：展开 4px 圆角、1px 结构线加浮层阴影的面板，支持空值往返并禁用原始 <select>", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    function Harness() {
      const [val, setVal] = useState("");
      return (
        <Select
          value={val}
          onValueChange={(next) => {
            setVal(next);
            onChange(next);
          }}
        >
          <SelectTrigger aria-label="展开测试">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">默认</SelectItem>
            <SelectItem value="codex">Codex</SelectItem>
          </SelectContent>
        </Select>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole("combobox", { name: "展开测试" });
    expect(document.querySelector("select")).toBeNull();
    expect(trigger).toHaveTextContent("默认");
    await user.click(trigger);
    const listbox = await screen.findByRole("listbox");
    const panel = classOf(listbox.closest<HTMLElement>("[data-slot='select-content']")!);
    expect(panel).toEqual(expect.arrayContaining(["rounded-sm", "border", "border-border", "shadow-[var(--shadow-overlay)]"]));
    expect(panel).not.toContain("border-2");
    await user.click(screen.getByRole("option", { name: "Codex" }));
    expect(onChange).toHaveBeenCalledWith("codex");
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "默认" }));
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("抽屉（第 10 条）：DrawerContent 顶上 4px 圆角、1px 结构线 bg-background、最高 85dvh、底部垫安全区，遮罩暖暗色；顶上拖动条 36×4 圆头", () => {
    render(
      <Drawer open>
        <DrawerContent>
          <DrawerTitle>Pieces</DrawerTitle>
        </DrawerContent>
      </Drawer>,
    );
    const cls = classOf(screen.getByRole("dialog"));
    for (const c of ["rounded-t-sm", "border-t", "border-border", "bg-background", "max-h-[85dvh]", "pb-[var(--safe-bottom)]"]) expect(cls).toContain(c);
    expect(cls).not.toContain("border-t-2");
    expect(classOf(document.querySelector<HTMLElement>('[data-slot="drawer-overlay"]')!)).toContain("bg-[rgb(28_25_23_/_0.3)]");
    const handle = screen.getByRole("dialog").querySelector<HTMLElement>('[aria-hidden="true"]')!;
    for (const c of ["h-1", "w-9", "bg-border-strong", "my-2", "rounded-full"]) expect(classOf(handle)).toContain(c);
    // 进出动画是 vaul 自带的，仓库没装 tw-animate-css
    expect(readFileSync("src/web/ui/drawer.tsx", "utf8")).not.toMatch(/animate-in|animate-out|fade-in|fade-out/);
  });

  it("聊天输入框（Composer）：.composer-frame 是 1px 控件线、4px 圆角、聚焦加深到 1px --border-focus 配柔和浮起投影（无 2px 硬框）、空输入发送键不可点、回弹与菜单动效在 styles.css", () => {
    const composerSrc = readFileSync("src/web/components/Composer.tsx", "utf8");
    expect(composerSrc).toContain("composer-frame");
    expect(composerSrc).not.toContain("focus-within:");
    expect(composerSrc).not.toContain("<style>");
    expect(composerSrc).toContain("composer-send-bounce");
    expect(composerSrc).toMatch(/disabled=\{!canSend \|\| picking\}/);
    expect(composerSrc).toMatch(/data-multiline=\{multiline\}/);
    const css = readFileSync("src/web/styles.css", "utf8");
    expect(css).toMatch(/\.composer-send-bounce\s*\{\s*animation: composer-send-bounce 150ms/);
    expect(css).toMatch(/@keyframes composer-send-bounce/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.composer-send-bounce\s*\{\s*animation: none/);
    expect(css).not.toContain("--motion-focus");

    const rest = /\.composer-frame \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rest).toMatch(/border: 1px solid var\(--border-strong\);/);
    expect(rest).toMatch(/border-radius: var\(--radius-sm\);/);
    const focus = /\.composer-frame:focus-within \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(focus).toMatch(/border-color: var\(--border-focus\);/);
    expect(focus).not.toMatch(/box-shadow:\s*0 0 0 1px/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.composer-frame\s*\{\s*transition: none/);
  });

  it("下拉 plain（分组行里改了马上存的）：透明底无实线框，悬停和打开时 bg-hover，高 36px，不用主色", () => {
    render(
      <Select value="a" onValueChange={() => {}}>
        <SelectTrigger aria-label="行里的下拉" variant="plain">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">一</SelectItem>
        </SelectContent>
      </Select>,
    );
    const cls = classOf(screen.getByRole("combobox", { name: "行里的下拉" }));
    expect(cls).toEqual(expect.arrayContaining(["h-9", "bg-transparent", "border-transparent", "hover:bg-hover", "data-[state=open]:bg-hover"]));
    expect(cls.join(" ")).not.toMatch(/rounded-|primary/);
  });

  it("按钮：默认 36px、sm 32px，图标按钮同两档；键盘焦点是中性深棕描边，禁用主按钮用 --send-disabled", () => {
    render(
      <>
        <Button>默认</Button>
        <Button size="sm">小</Button>
        <Button size="icon" aria-label="图标" />
        <Button size="icon-sm" aria-label="小图标" />
      </>,
    );
    expect(classOf(screen.getByRole("button", { name: "默认" }))).toEqual(
      expect.arrayContaining(["h-9", "rounded-sm", "btn-solid", "focus-visible:outline-border-focus", "disabled:bg-send-disabled"]),
    );
    expect(screen.getByRole("button", { name: "默认" }).className).not.toContain("border-2");
    expect(classOf(screen.getByRole("button", { name: "小" }))).toContain("h-8");
    expect(classOf(screen.getByRole("button", { name: "图标" }))).toContain("size-9");
    expect(classOf(screen.getByRole("button", { name: "小图标" }))).toContain("size-8");
  });

  it("开关：4px 圆角 1px 控件线（h-5.5 w-10），2px 圆角滑块 size-4，带 touch-target 与 focus-visible:outline-border-focus", () => {
    render(<Switch aria-label="Notifications" checked={false} onCheckedChange={() => {}} />);
    const sw = screen.getByRole("switch", { name: "Notifications" });
    expect(classOf(sw)).toEqual(expect.arrayContaining(["h-5.5", "w-10", "rounded-sm", "border", "border-border-strong", "touch-target", "focus-visible:outline-border-focus"]));
    expect(sw.className).not.toContain("border-2");
    expect(sw.firstElementChild).toHaveClass("size-4", "rounded-xs");
  });

  it("头像（第 17 条）：项目经理渲染史莱姆小动物（main），Worker（neutral）渲染同色的便签小灵（piece）", () => {
    const { container } = render(
      <>
        <Avatar look={defaultLookOf(0)} size={44} />
        <Avatar look={defaultLookOf(0)} size={24} neutral />
      </>,
    );
    const avatars = container.querySelectorAll("[data-slot='avatar']");
    expect(avatars).toHaveLength(2);
    expect(avatars[0]).not.toHaveAttribute("data-neutral");
    expect(avatars[1]).toHaveAttribute("data-neutral", "true");
    const fills = (el: Element) => [...el.querySelectorAll("path")].map((p) => p.getAttribute("fill"));
    expect(fills(avatars[0]!)).toEqual(slimePaths(defaultLookOf(0), "main").map((p) => p.fill));
    expect(fills(avatars[1]!)).toEqual(slimePaths(defaultLookOf(0), "piece").map((p) => p.fill));
  });

  it("--ring 是暖深棕焦点色，不是主色", () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    expect(css).toMatch(/--color-ring: var\(--ring\);/);
    expect(css).toMatch(/--ring: var\(--border-focus\);/);
    expect(css).toMatch(/--border-focus: #4a4038;/);
  });

  it("界面字体（第 13 条）：英文和数字是打包进来的 Geist，系统英文字体兜底，中文字体在最后；只在 styles.css 引一次，不用像素字", () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    const stack = /--font-ui:\s*([^;]+);/.exec(css)![1]!;
    expect(stack).not.toMatch(/Inter|Pixel|Tiny5|Silkscreen/);
    const order = ['"Geist Variable"', "-apple-system", "BlinkMacSystemFont", '"SF Pro Text"', '"PingFang SC"', '"Microsoft YaHei"', "sans-serif"].map((f) => stack.indexOf(f));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(css.match(/@import "@fontsource-variable\/geist";/g)).toHaveLength(1);
    expect(readFileSync("src/web/main.tsx", "utf8")).not.toMatch(/fontsource/);
    expect(JSON.parse(readFileSync("package.json", "utf8")).dependencies).toHaveProperty("@fontsource-variable/geist");
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
    expect(readFileSync("src/web/components/AppRail.tsx", "utf8")).toMatch(
      /pt-\[calc\(var\(--safe-top\)\+var\(--macos-traffic-lights-height\)\)\][^"]*pb-\[var\(--safe-bottom\)\]|pb-\[var\(--safe-bottom\)\][^"]*pt-\[calc\(var\(--safe-top\)\+var\(--macos-traffic-lights-height\)\)\]/,
    );
    for (const file of ["AppRail", "ProjectList", "SidePanel", "ProfilePanel", "Conversation", "WorkerConversation", "Composer", "RouterWorkbench", "RouterDecisionCard"]) {
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
    expect(composerSrc).toMatch(/className=\{CHIP_CLOSE_CLASS\}\s+onClick=\{\(\) => onRemoveFile/);
  });

  it("右栏的行（一行挨一行）触屏下本身 44px 高，不用撑开的办法", () => {
    expect(readFileSync("src/web/components/RightRail.tsx", "utf8")).toContain("pointer-coarse:min-h-11");
  });

  it("没有悬停才出现的操作（仅项目列表行的快捷按键按媒体悬停规范显隐）", () => {
    for (const file of ["Messages", "RightRail", "AppRail", "ProjectList", "SidePanel", "ProfilePanel", "Composer", "Conversation", "RouterWorkbench", "RouterDecisionCard"]) {
      expect(readFileSync(`src/web/components/${file}.tsx`, "utf8")).not.toMatch(/group-hover:(opacity|visible)|opacity-0/);
    }
  });

  it("在忙的状态词流光：用合成层双反向位移扫过文字本身，无矩形底框，减少动态效果时停用并隐藏", () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    const trackRule = css.match(/\.status-shimmer-track \{[^}]*\}/)?.[0] ?? "";
    const maskRule = css.match(/\.status-shimmer-mask \{[^}]*\}/)?.[0] ?? "";
    const beamRule = css.match(/\.status-shimmer-beam \{[^}]*\}/)?.[0] ?? "";
    expect(trackRule).toMatch(/text-overflow:\s*inherit/);
    expect(maskRule).toMatch(/text-overflow:\s*inherit/);
    expect(maskRule).toMatch(/mask-image:\s*linear-gradient\(/);
    expect(maskRule).toMatch(/animation:\s*status-shimmer\b/);
    expect(maskRule).toMatch(/will-change:\s*transform/);
    expect(beamRule).toMatch(/text-overflow:\s*inherit/);
    expect(beamRule).toMatch(/animation:\s*status-shimmer-counter\b/);
    expect(beamRule).toMatch(/will-change:\s*transform/);
    expect(beamRule).not.toMatch(/#[0-9a-f]{3,6}\b|\brgba?\(|\bhsla?\(/i);
    const kfSlide = css.match(/@keyframes status-shimmer \{[\s\S]*?\n\}/)?.[0] ?? "";
    const kfCounter = css.match(/@keyframes status-shimmer-counter \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(kfSlide).toContain("transform");
    expect(kfSlide).not.toContain("background-position");
    expect(kfSlide).not.toContain("opacity");
    expect(kfCounter).toContain("transform");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.status-shimmer-mask,\s*\.status-shimmer-beam \{\s*animation: none;\s*\}\s*\.status-shimmer-track \{\s*display: none;\s*\}\s*\}/);
  });

  it("排版隔离与滚动条守卫：滚动容器用 layout style 隔离，静止全透明无底槽，滚动/悬停时浮现细圆角滑块", () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    expect(css).toMatch(/\.messages\[role="log"\]\s*\{[^}]*contain:\s*layout style;/);
    expect(css).toMatch(/\.sidebar-list\s*\{[^}]*contain:\s*layout style;/);
    expect(css).not.toMatch(/contain:\s*strict/);
    expect(css).toMatch(/\.composer-dock\s*\{[^}]*contain:\s*layout style;/);
    expect(css).toMatch(/\.router-timeline\s*\{[^}]*contain:\s*layout style;/);
    expect(css).toMatch(/\.messages,\s*\.sidebar-list,\s*\.right-rail-scroll,\s*\.router-tray-scroll,\s*\.router-timeline,\s*\.page-fade,\s*\.dialog-body-fade\s*\{[^}]*scrollbar-width:\s*thin;[^}]*scrollbar-color:\s*transparent transparent;/);
    expect(css).toMatch(/\.messages\[data-scrolling\],[\s\S]*?\.dialog-body-fade\[data-scrolling\]\s*\{[^}]*scrollbar-color:\s*color-mix\(in srgb, var\(--foreground\) 26%, transparent\) transparent;/);
    expect(css).toMatch(/\.messages::-webkit-scrollbar,[\s\S]*?\.dialog-body-fade::-webkit-scrollbar\s*\{[^}]*width:\s*6px;[^}]*background:\s*transparent;/);
    expect(css).toMatch(/\.messages::-webkit-scrollbar-thumb,[\s\S]*?\.dialog-body-fade::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*transparent;[^}]*border-radius:\s*9999px;/);
    expect(css).toMatch(/\.messages\[data-scrolling\]::-webkit-scrollbar-thumb,[\s\S]*?\.dialog-body-fade::-webkit-scrollbar-thumb:active\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--foreground\) 26%, transparent\);/);
    const rightRail = readFileSync("src/web/components/RightRail.tsx", "utf8");
    expect(rightRail).toContain("right-rail-scroll");
    expect(rightRail).toContain("[contain:layout_style]");
    expect(rightRail).not.toContain("[contain:strict]");
    expect(readFileSync("src/web/components/Avatar.tsx", "utf8")).toContain("[contain:size_layout]");
    expect(readFileSync("src/web/components/RouterAvatar.tsx", "utf8")).toContain("[contain:size_layout]");
    expect(readFileSync("src/web/components/Composer.tsx", "utf8")).not.toContain("field-sizing");
  });

  it("自动隐藏滚动条委托：捕获滚动事件标 data-scrolling，停滚后按 SCROLLBAR_IDLE_HIDE_MS 自动摘掉，卸载清定时器", () => {
    vi.useFakeTimers();
    try {
      const { unmount } = renderHook(() => useAutoHideScrollbars());
      const scroller = document.createElement("div");
      scroller.className = "sidebar-list";
      const ignored = document.createElement("div");
      document.body.append(scroller, ignored);

      act(() => {
        scroller.dispatchEvent(new Event("scroll"));
        ignored.dispatchEvent(new Event("scroll"));
      });
      expect(scroller.hasAttribute("data-scrolling")).toBe(true);
      expect(ignored.hasAttribute("data-scrolling")).toBe(false);

      act(() => {
        vi.advanceTimersByTime(SCROLLBAR_IDLE_HIDE_MS - 100);
      });
      expect(scroller.hasAttribute("data-scrolling")).toBe(true);

      act(() => {
        scroller.dispatchEvent(new Event("scroll"));
      });
      act(() => {
        vi.advanceTimersByTime(SCROLLBAR_IDLE_HIDE_MS - 100);
      });
      expect(scroller.hasAttribute("data-scrolling")).toBe(true);

      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(scroller.hasAttribute("data-scrolling")).toBe(false);

      act(() => {
        scroller.dispatchEvent(new Event("scroll"));
      });
      expect(scroller.hasAttribute("data-scrolling")).toBe(true);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
      scroller.remove();
      ignored.remove();
    } finally {
      vi.useRealTimers();
    }
  });
});
