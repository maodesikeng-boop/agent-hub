// 网页测试（vitest 的 web 项目）的公共设置：每条测试结束后卸载组件，并加上 jest-dom 的断言。
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);
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
