// 强调色跟着当前会话的项目经理走（docs/ui-standard.md 第 4 条）；不属于任何项目经理的地方是中性的。
import { readFileSync } from "node:fs";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { StateSnapshot } from "../shared/index.ts";
import { App } from "./App.tsx";
import { PALETTE } from "./lib/palette.ts";
import { FakeApi, FakeWebSocket, installFakeWebSocket, makeConvSnapshot, makeMessage, makePm, makeSession, makeSnapshot } from "./test-utils.ts";

async function boot(snapshot: StateSnapshot) {
  new FakeApi(snapshot).install();
  installFakeWebSocket();
  render(<App />);
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  act(() => FakeWebSocket.last.open());
}

const two = () =>
  makeSnapshot({
    pms: [makePm({ id: 1, name: "小林" }), makePm({ id: 2, name: "老马" })],
    conversations: [
      makeConvSnapshot([makeMessage({ id: 1, conversationId: 1, text: "好的", createdAt: 30_000 })], { conversation: { id: 1, pmId: 1, title: "小林" } }),
      makeConvSnapshot([makeMessage({ id: 2, conversationId: 2, text: "收到", createdAt: 20_000 })], { conversation: { id: 2, pmId: 2, title: "老马" } }),
    ],
    sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1 }), makeSession({ sessionId: 2, conversationId: 2, pmId: 2 })],
  });

/** 往上找第一个设了 --primary 的祖先。 */
const nav = () => screen.getByRole("navigation", { name: "Conversations" });
const scopeOf = (el: HTMLElement) => el.closest<HTMLElement>("[data-accent]");

describe("强调色跟着项目经理", () => {
  it("对话页在项目经理的颜色里；换一个项目经理，颜色跟着换；左栏不在里面", async () => {
    await boot(two());
    const main = await screen.findByRole("main");
    const first = scopeOf(main)!;
    expect(first).not.toBeNull();
    expect(first.style.getPropertyValue("--primary")).toBe(PALETTE[1]!.accent);
    expect(first.style.getPropertyValue("--primary-foreground")).toBe(PALETTE[1]!.accentForeground);
    expect(scopeOf(document.querySelector<HTMLElement>("aside")!)).toBeNull();

    await userEvent.click(within(nav()).getByRole("button", { name: /小林/ }));
    await waitFor(() => expect(scopeOf(screen.getByRole("main"))!.style.getPropertyValue("--primary")).toBe(PALETTE[1]!.accent));
    await userEvent.click(within(nav()).getByRole("button", { name: /老马/ }));
    await waitFor(() => expect(scopeOf(screen.getByRole("main"))!.style.getPropertyValue("--primary")).toBe(PALETTE[2]!.accent));
  });

  it(":root 的 --primary 是中性色（前景黑），不是粉色；用户气泡是强调色掺白的浅果冻底 + 前景色字（不是实心强调色）", () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    expect(css).not.toMatch(/d6336c/i);
    expect(css).toMatch(/--primary: #18181b;/);
    expect(css).toMatch(/--color-bubble-me: color-mix\(in srgb, var\(--primary\) var\(--mix-bubble-me\), #ffffff\);/);
    expect(css).toMatch(/--color-bubble-me-foreground: var\(--foreground\);/);
  });

  it("外壳底色（对话区、左栏、分割线）掺当前项目经理的水果色：FruitTint 设 --fruit，切换时跟着换", async () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    expect(css).toMatch(/--color-surface-chat: color-mix\(in srgb, var\(--fruit, var\(--background\)\) var\(--mix-chat\), var\(--background\)\);/);
    expect(css).toMatch(/--color-surface-sidebar: color-mix\(in srgb, var\(--fruit, var\(--sidebar\)\) var\(--mix-sidebar\), var\(--sidebar\)\);/);
    expect(css).toMatch(/--color-line: color-mix\(in srgb, var\(--fruit, var\(--border\)\) var\(--mix-line\), var\(--border\)\);/);
    // 不写 * { transition }：只有带 tint-fade 的几个容器淡变
    expect(css).not.toMatch(/(^|[},])\s*\*\s*\{[^}]*transition/m);
    const { FruitTint } = await import("./lib/accent-scope.tsx");
    const { container, rerender } = render(<FruitTint colorKey={1}><span /></FruitTint>);
    const scope = container.firstElementChild as HTMLElement;
    expect(scope.style.getPropertyValue("--fruit")).toBe(PALETTE[1]!.accent);
    expect(scope.style.getPropertyValue("--primary")).toBe("");
    rerender(<FruitTint colorKey={null}><span /></FruitTint>);
    expect(scope.style.getPropertyValue("--fruit")).toBe("");
  });

  it("不属于任何项目经理的地方（左栏、加载页）不写主色", () => {
    expect(readFileSync("src/web/components/Sidebar.tsx", "utf8")).not.toMatch(/bg-primary|text-primary/);
    expect(readFileSync("src/web/App.tsx", "utf8")).not.toMatch(/text-primary/);
  });
});

describe("弹窗", () => {
  it("会话里打开的弹窗渲染在会话的容器里，强调色跟着；会话外的不带", async () => {
    const { AccentScope } = await import("./lib/accent-scope.tsx");
    const { Dialog, DialogContent } = await import("./ui/dialog.tsx");
    render(
      <AccentScope colorKey={2}>
        <Dialog open>
          <DialogContent title="在会话里">内容</DialogContent>
        </Dialog>
      </AccentScope>,
    );
    const inside = screen.getByRole("dialog", { name: "在会话里" });
    expect(scopeOf(inside)?.style.getPropertyValue("--primary")).toBe(PALETTE[2]!.accent);
  });
});
