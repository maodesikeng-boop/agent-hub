// 贴底：在底部时内容变高（图片加载完、展开、流式长出来）继续贴底；用户往上翻了不被拉回去。
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../shared/index.ts";
import { MessageList } from "./components/MessageList.tsx";
import type { MessageActions } from "./components/Messages.tsx";
import { makeMessage, makeUserMessage } from "./test-utils.ts";

const actions: MessageActions = { retry: {}, onOpenWorker: () => {}, onRetryMessage: () => {}, onRevertPersona: () => Promise.resolve() };

/** 记下所有 ResizeObserver 的回调，测试里手动触发“尺寸变了”。 */
const observers: { callback: ResizeObserverCallback; targets: Element[] }[] = [];
class FakeResizeObserver {
  private entry: { callback: ResizeObserverCallback; targets: Element[] };
  constructor(callback: ResizeObserverCallback) {
    this.entry = { callback, targets: [] };
    observers.push(this.entry);
  }
  observe(target: Element) {
    this.entry.targets.push(target);
  }
  unobserve() {}
  disconnect() {
    this.entry.targets = [];
  }
}
const resize = () =>
  act(() => {
    for (const o of observers) if (o.targets.length > 0) o.callback([], {} as ResizeObserver);
  });

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => vi.unstubAllGlobals());

/** jsdom 不排版：给滚动区一个可控的 scrollHeight / clientHeight / scrollTop。 */
function fakeLayout(el: HTMLElement, initial: { scrollHeight: number; clientHeight: number }) {
  const box = { ...initial, scrollTop: 0 };
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => box.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => box.clientHeight });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => box.scrollTop,
    set: (v: number) => {
      box.scrollTop = Math.max(0, Math.min(v, box.scrollHeight - box.clientHeight));
    },
  });
  return box;
}

const messages: Message[] = [makeUserMessage({ id: 1, text: "看图" }), makeMessage({ id: 2, text: "![图](/files/a.png)" })];

function setup() {
  render(<MessageList messages={messages} pending={[]} agentOf={() => ({ name: "小林", avatarKey: 1 })} hasMore={false} older={undefined} onLoadOlder={() => {}} onRetry={() => {}} actions={actions} />);
  const log = screen.getByRole("log");
  const box = fakeLayout(log, { scrollHeight: 1000, clientHeight: 400 });
  log.scrollTop = 600;
  fireEvent.scroll(log);
  return { log, box };
}

describe("贴底", () => {
  it("在底部时内容变高（比如图片加载完）：继续贴底", () => {
    const { log, box } = setup();
    expect(observers.some((o) => o.targets.length > 0)).toBe(true);
    box.scrollHeight = 1500;
    resize();
    expect(log.scrollTop).toBe(1100);
  });

  it("滚动区本身变矮（输入框长高）：也贴底", () => {
    const { log, box } = setup();
    box.clientHeight = 300;
    resize();
    expect(log.scrollTop).toBe(700);
  });

  it("贴底时没有“回到底部”，消息区没有渐隐蒙版", () => {
    const { log } = setup();
    expect(log.className).not.toContain("fade");
    expect(log).not.toHaveAttribute("data-away");
    expect(screen.queryByRole("button", { name: "回到底部" })).not.toBeInTheDocument();
  });

  it("用户往上翻了：内容变高不拉回去，“回到底部”浮在消息列水平正中（浅灰底、没有描边和阴影、不带字），点了回到底部", () => {
    const { log, box } = setup();
    log.scrollTop = 100;
    fireEvent.scroll(log);
    box.scrollHeight = 1500;
    resize();
    expect(log.scrollTop).toBe(100);
    const back = screen.getByRole("button", { name: "回到底部" });
    expect(back.className).not.toMatch(/shadow|border/);
    expect(back.className).toContain("bg-secondary");
    expect(back).toHaveTextContent("");
    // 浮在输入框上方一点、消息列正中；外层不挡鼠标，只有按钮自己能点；消息区的高度不跟着变（不让出一条、不加蒙版）
    expect(log).not.toContainElement(back);
    expect(log.className).not.toMatch(/mask|fade/);
    const holder = back.closest("[data-back-to-bottom]") as HTMLElement;
    expect(holder.className).toContain("messages");
    expect(holder.className).toContain("justify-center");
    expect(holder.className).toContain("absolute");
    expect(holder.className).toContain("pointer-events-none");
    expect(back.className).toContain("pointer-events-auto");
    fireEvent.click(back);
    expect(log.scrollTop).toBe(1100);
    expect(screen.queryByRole("button", { name: "回到底部" })).not.toBeInTheDocument();
    // 回到底部后又贴底
    box.scrollHeight = 1800;
    resize();
    expect(log.scrollTop).toBe(1400);
  });
});
