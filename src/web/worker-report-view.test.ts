import { describe, expect, it } from "vitest";
import { leanReportOf } from "./worker-report-view.ts";

const FULL_REPORT = `这里是一段开场白。

=== 汇报 ===
状态: 做完了
摘要: Rewrote Info tab and Worker detail header to match the work panel spec.
PR: https://github.com/example/bellwood/pull/441
提交: a1b2c3d4
测试: pnpm typecheck 和 vitest 全部通过
偏离: 无
交棒: 下一步可以直接删掉旧侧栏组件。
文件: [preview](/tmp/preview.png)
问题: 无
=== 汇报结束 ===`;

describe("leanReportOf", () => {
  it("returns null for text that is not a formatted Worker report", () => {
    expect(leanReportOf("Just a normal assistant reply.")).toBeNull();
    expect(leanReportOf("=== 汇报 ===\n状态: 做完了\n=== 汇报结束 ===")).toBeNull();
  });

  it("keeps the summary and drops status, commit, PR, tests, deviation, and handoff", () => {
    const report = leanReportOf(FULL_REPORT);
    expect(report).toEqual({
      summary: "Rewrote Info tab and Worker detail header to match the work panel spec.",
      question: null,
    });
    expect(JSON.stringify(report)).not.toContain("a1b2c3d4");
    expect(JSON.stringify(report)).not.toContain("pull/441");
    expect(JSON.stringify(report)).not.toContain("交棒");
    expect(JSON.stringify(report)).not.toContain("测试");
  });

  it("keeps the question as one line and returns null when it says there is none", () => {
    const withQuestion = `=== 汇报 ===
状态: 有问题
摘要: Need a decision on the narrow breakpoint.
问题: Should the phone tier use a full page
  or a bottom sheet?
=== 汇报结束 ===`;
    expect(leanReportOf(withQuestion)).toEqual({
      summary: "Need a decision on the narrow breakpoint.",
      question: "Should the phone tier use a full page or a bottom sheet?",
    });

    const withNone = `=== 汇报 ===
状态: 做完了
摘要: Done.
问题: 无（没有需要确认的）
=== 汇报结束 ===`;
    expect(leanReportOf(withNone)?.question).toBeNull();
  });

  it("returns the same object for the same text", () => {
    const first = leanReportOf(FULL_REPORT);
    const second = leanReportOf(FULL_REPORT);
    expect(first).not.toBeNull();
    expect(first).toBe(second);
  });
});
