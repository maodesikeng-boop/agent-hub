import { expect, it } from "vitest";
it("先写 stderr 再失败（探 dot reporter 在有 console 输出时会不会吞失败汇总）", () => {
  console.error("probe stderr line");
  expect(1).toBe(2);
});
