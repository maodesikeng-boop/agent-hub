import { describe, it } from "vitest";

// captureAll 要起浏览器和守护进程，不在单元测试里跑，用 `pnpm ui:polish shots --verify` 验（方案第 8 节）。
describe("diffManifests", () => {
  it.todo("两份清单每张图 sha256 都一样时返回空数组");
  it.todo("一张图 sha256 不同时返回它的 key");
  it.todo("一边多出来的图也返回");
  it.todo("局部图的 sha256 不同也算");
});
