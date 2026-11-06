import { expect, it } from "vitest";
it("故意失败（探 dot reporter 在 CI 里会不会吞失败汇总）", () => {
  expect(1).toBe(2);
});
