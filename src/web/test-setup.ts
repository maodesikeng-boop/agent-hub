// 网页测试（vitest 的 web 项目）的公共设置：每条测试结束后卸载组件，并加上 jest-dom 的断言。
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);

// jsdom 没有 ResizeObserver，Radix 的单选组要用
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;
