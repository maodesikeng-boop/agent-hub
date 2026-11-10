// 动效（docs/ui-standard.md 第 14 条）：新来的消息淡入一次（打开时的历史、加载更早的不播）；切换对话用 View Transitions，不支持就直接换；减弱动态效果时都关。
import { act, render, renderHook, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../shared/index.ts";
import { MessageList } from "./components/MessageList.tsx";
import type { MessageActions } from "./components/Messages.tsx";
import { useRoute } from "./route.ts";
import type { PendingMessage } from "./state.ts";
import { makeMessage, makeUserMessage } from "./test-utils.ts";
import { withViewTransition } from "./view-transition.ts";

const actions: MessageActions = { retry: {}, onOpenWorker: () => {}, onRetryMessage: () => {}, onRevertPersona: () => Promise.resolve() };

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let reducedMotion = false;
beforeEach(() => {
  reducedMotion = false;
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce") && reducedMotion, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => vi.unstubAllGlobals());

function list(messages: Message[], extra: { pending?: PendingMessage[]; hasMore?: boolean } = {}) {
  return (
    <MessageList
      messages={messages}
      pending={extra.pending ?? []}
      agentOf={() => ({ name: "小林", avatarKey: 1 })}
      hasMore={extra.hasMore ?? false}
      older={undefined}
      onLoadOlder={() => {}}
      onRetry={() => {}}
      actions={actions}
    />
  );
}
const items = () => [...screen.getByRole("log").firstElementChild!.children];
const entering = () => items().filter((el) => el.classList.contains("message-enter"));

const history = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? makeUserMessage({ id: i + 1, text: `问 ${i + 1}` }) : makeMessage({ id: i + 1, text: `答 ${i + 1}` })));

describe("新消息淡入", () => {
  it("打开对话时的历史不播；之后新来的那条播一次（只有它），播完摘掉", () => {
    const view = render(list(history));
    expect(entering()).toHaveLength(0);
    view.rerender(list([...history, makeUserMessage({ id: 41, text: "新问题" })]));
    expect(entering()).toEqual([items().at(-1)]);
    const el = items().at(-1)!;
    act(() => {
      el.dispatchEvent(Object.assign(new Event("animationend", { bubbles: true }), { animationName: "message-enter" }));
    });
    expect(el.classList.contains("message-enter")).toBe(false);
  });

  it("往上加载更早的消息（接在前面）不播", () => {
    const view = render(list(history.slice(20), { hasMore: true }));
    view.rerender(list(history, { hasMore: false }));
    expect(entering()).toHaveLength(0);
  });

  it("拉历史前是空的（只带 hasMore），历史一下来了一批：不播", () => {
    const view = render(list([], { hasMore: true }));
    view.rerender(list(history, { hasMore: false }));
    expect(entering()).toHaveLength(0);
  });

  it("自己发的：待发的那条播；服务端确认、换成真消息时不再播", () => {
    const view = render(list(history));
    const pending: PendingMessage = { clientId: "c99", conversationId: 1, text: "刚发的", attachments: [], phase: "sending", createdAt: 0 };
    view.rerender(list(history, { pending: [pending] }));
    expect(entering().map((el) => el.textContent)).toEqual(["刚发的"]);
    view.rerender(list([...history, makeUserMessage({ id: 41, text: "刚发的", dedupeKey: "client:1:c99" })]));
    expect(entering()).toHaveLength(0);
  });

  it("空对话里的第一句播", () => {
    const view = render(list([]));
    view.rerender(list([makeUserMessage({ id: 1, text: "你好" })]));
    expect(entering().map((el) => el.textContent)).toEqual(["你好"]);
  });

  it("减弱动态效果：不播", () => {
    reducedMotion = true;
    const view = render(list(history));
    view.rerender(list([...history, makeUserMessage({ id: 41 })]));
    expect(entering()).toHaveLength(0);
  });

  it("样子：120ms 淡入、上移 4px，不循环；减弱动态效果时 animation: none", () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    expect(css).toMatch(/--motion-enter: 120ms;/);
    expect(css).toMatch(/@keyframes message-enter \{\s*from \{\s*opacity: 0;\s*transform: translateY\(4px\);/);
    expect(css).toMatch(/\.message-enter \{\s*animation: message-enter var\(--motion-enter\) ease-out;\s*\}/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{[^@]*\.message-enter \{\s*animation: none;/);
  });
});

describe("切换对话：View Transitions", () => {
  it("浏览器不支持：直接换，没有动画", () => {
    const update = vi.fn();
    withViewTransition(update);
    expect(update).toHaveBeenCalledOnce();
  });

  it("支持：交给 document.startViewTransition；减弱动态效果时不走它", () => {
    const start = vi.fn((cb: () => void) => cb());
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });
    try {
      const update = vi.fn();
      withViewTransition(update);
      expect(start).toHaveBeenCalledOnce();
      expect(update).toHaveBeenCalledOnce();
      reducedMotion = true;
      withViewTransition(update);
      expect(start).toHaveBeenCalledOnce();
      expect(update).toHaveBeenCalledTimes(2);
    } finally {
      delete (document as { startViewTransition?: unknown }).startViewTransition;
    }
  });

  it("只在切对话时播：点开对话、Piece 走过渡；打开资料页、刚打开时补默认对话（replace）不走", () => {
    const start = vi.fn((cb: () => void) => cb());
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });
    try {
      const { result } = renderHook(() => useRoute());
      act(() => result.current.replace({ view: "conversation", id: 1 }));
      expect(start).not.toHaveBeenCalled();
      act(() => result.current.navigate({ view: "conversation", id: 2 }));
      act(() => result.current.navigate({ view: "worker", id: 3 }));
      expect(start).toHaveBeenCalledTimes(2);
      act(() => result.current.navigate({ view: "profile", pmId: 1 }));
      expect(start).toHaveBeenCalledTimes(2);
      expect(result.current.route).toEqual({ view: "profile", pmId: 1 });
    } finally {
      delete (document as { startViewTransition?: unknown }).startViewTransition;
    }
  });

  it("只有顶栏的头像和标题起名字，整页（:root）不截快照", () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    expect(css).toMatch(/:root \{\s*view-transition-name: none;\s*\}/);
    expect(css.match(/view-transition-name: chat-[a-z]+;/g)).toEqual(["view-transition-name: chat-avatar;", "view-transition-name: chat-title;"]);
    for (const file of ["Conversation.tsx", "WorkerConversation.tsx"]) {
      const src = readFileSync(`src/web/components/${file}`, "utf8");
      expect(src, file).toMatch(/vt-chat-avatar/);
      expect(src, file).toMatch(/vt-chat-title/);
    }
  });
});
