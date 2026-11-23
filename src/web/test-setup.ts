// 网页测试（vitest 的 web 项目）的公共设置：每条测试结束后卸载组件，并加上 jest-dom 的断言。
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { resetQueryClient } from "./query-client.ts";

afterEach(cleanup);
afterEach(resetQueryClient);
// 网址（每个对话一个，route.ts）和右栏收起的记忆不带到下一条测试
afterEach(() => {
  window.history.replaceState(null, "", "/");
  localStorage.removeItem("agent-hub.rightRail");
});

// jsdom 没有 ResizeObserver，Radix 的单选组要用
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;

// jsdom 缺 Radix Select 用到的指针捕获和滚动方法
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

// react-resizable-panels listens on document pointerdown in capture phase and hit-tests rects at (0,0).
// In un-laid-out jsdom every rect is 0x0 at (0,0), so keep un-laid-out groups/separators off-screen unless explicitly mocked.
const nativeGetBoundingClientRect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function (this: Element) {
  const rect = nativeGetBoundingClientRect.call(this);
  if (rect.width === 0 && rect.height === 0 && (this.hasAttribute("data-group") || this.hasAttribute("data-separator"))) {
    return { x: -10_000, y: -10_000, left: -10_000, top: -10_000, right: -10_000, bottom: -10_000, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
  }
  return rect;
};
