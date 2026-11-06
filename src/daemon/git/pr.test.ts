// hub worker show 查 PR：gh pr list 的输出只取编号、状态、网址（pr.ts）。
import { describe, expect, it } from "vitest";
import { parsePrList, probePr } from "./pr.ts";

describe("parsePrList", () => {
  it("取第一个 PR 的编号、状态、网址，别的字段不带", () => {
    expect(parsePrList('[{"number":97,"state":"OPEN","url":"https://github.com/o/r/pull/97","title":"x","body":"secret"}]')).toEqual({
      number: 97,
      state: "OPEN",
      url: "https://github.com/o/r/pull/97",
    });
  });

  it.each(["", "not json", "{}", "[]", '[{"number":"97","state":"OPEN","url":"u"}]', '[{"number":97}]', "null"])("认不出的当没有：%j", (input) => {
    expect(parsePrList(input)).toBeNull();
  });
});

describe("probePr", () => {
  it("目录不存在、gh 跑不了：不抛错，当没有", async () => {
    await expect(probePr("/nonexistent-dir-for-test", "hub/1-x", 1_000)).resolves.toBeNull();
  });
});
