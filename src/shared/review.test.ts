import { describe, expect, it } from "vitest";
import { REVIEW_MAX_ROUNDS } from "./limits.ts";
import {
  REVIEW_CHECKLIST,
  diffReviewSnapshot,
  parseReviewCommit,
  parseReviewVerdict,
  reviewFindingSeverities,
  reviewPushGuardEnv,
  reviewReportProblem,
  type ReviewSnapshot,
} from "./review.ts";
import { taskGraphSkillBody } from "./task-graph-skill.ts";

const SHA = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const before: ReviewSnapshot = { sha: SHA, remote: { sha: SHA }, pr: { number: 7, state: "OPEN", url: "https://x/pull/7" } };

describe("审查结论", () => {
  it("三种结论，大小写、+ 两边空格、首尾标点不计较；别的写法是 null", () => {
    expect(parseReviewVerdict("PASS")).toBe("PASS");
    expect(parseReviewVerdict(" pass + notes。")).toBe("PASS+NOTES");
    expect(parseReviewVerdict("**FAIL**")).toBe("FAIL");
    for (const bad of ["", "通过", "PASS / FAIL", "OK"]) expect(parseReviewVerdict(bad)).toBeNull();
  });

  it("验证提交：首尾的反引号、句号、加粗不计较，转成小写；空的是 null", () => {
    expect(parseReviewCommit(`\`${SHA.slice(0, 8).toUpperCase()}\`。`)).toBe(SHA.slice(0, 8));
    expect(parseReviewCommit(`**${SHA}**`)).toBe(SHA);
    expect(parseReviewCommit(" ")).toBeNull();
  });

  it("汇报的毛病：没写结论；验证提交不是被审的提交（至少 7 位前缀才算）；开审时没记下被审提交", () => {
    const target = { branch: "hub/1-impl", snapshot: before };
    const q = "";
    expect(reviewReportProblem({ verdict: null, verifiedCommit: SHA, questions: q }, target)).toContain("没写“结论”");
    expect(reviewReportProblem({ verdict: "PASS", verifiedCommit: SHA, questions: q }, target)).toBeNull();
    expect(reviewReportProblem({ verdict: "PASS", verifiedCommit: SHA.slice(0, 7), questions: q }, target)).toBeNull();
    expect(reviewReportProblem({ verdict: "PASS", verifiedCommit: SHA.slice(0, 6), questions: q }, target)).toContain("被审的是分支 hub/1-impl");
    expect(reviewReportProblem({ verdict: "PASS", verifiedCommit: null, questions: q }, target)).toContain("（没写）");
    expect(reviewReportProblem({ verdict: "PASS", verifiedCommit: SHA, questions: q }, { branch: "hub/1-impl", snapshot: null })).toContain("没记下被审分支 hub/1-impl 开审时的提交");
  });

  it("三档分级：只认行首的级别标签（可带列表符号、编号），正文里顺带提到的不算", () => {
    const text = ["- [Important] a.ts:3 关机后还写库", "2. [nit] 命名", "* [Pre-existing] 主干就有", "没有别的 [Important] 了", "1、[Nit] 多余空行"].join("\n");
    expect(reviewFindingSeverities(text)).toEqual(["Important", "Nit", "Pre-existing", "Nit"]);
    expect(reviewFindingSeverities("无")).toEqual([]);
  });

  it("判 PASS、PASS+NOTES 还列着 [Important] 是汇报有误；FAIL 带 [Important]、PASS+NOTES 只带 [Nit]/[Pre-existing] 没毛病", () => {
    const target = { branch: "hub/1-impl", snapshot: before };
    const important = "- [Important] sandbox.ts:10 读得到 admin.sock";
    expect(reviewReportProblem({ verdict: "PASS+NOTES", verifiedCommit: SHA, questions: important }, target)).toContain("只能判 FAIL");
    expect(reviewReportProblem({ verdict: "PASS", verifiedCommit: SHA, questions: important }, target)).toContain("只能判 FAIL");
    expect(reviewReportProblem({ verdict: "FAIL", verifiedCommit: SHA, questions: important }, target)).toBeNull();
    expect(reviewReportProblem({ verdict: "PASS+NOTES", verifiedCommit: SHA, questions: "- [Nit] 命名\n- [Pre-existing] 旧抖动" }, target)).toBeNull();
  });
});

describe("收尾核对", () => {
  it("本地、origin、PR 都没变：没有问题", () => {
    expect(diffReviewSnapshot("b", before, { sha: SHA, remote: { sha: SHA }, pr: { number: 7, state: "OPEN", url: "https://x/pull/7" } })).toEqual([]);
  });

  it("PR 被合并、查不了、查不到都算问题；开审时没有 PR、没有 origin 的不核对那一项", () => {
    expect(diffReviewSnapshot("b", before, { sha: SHA, remote: { sha: SHA }, pr: { number: 7, state: "MERGED", url: "https://x/pull/7" } })).toEqual([
      "PR https://x/pull/7 从 OPEN 变成了 MERGED",
    ]);
    expect(diffReviewSnapshot("b", before, { sha: SHA, remote: { sha: SHA }, pr: { unavailable: "gh 网络错误" } })).toEqual([
      "查不了 PR https://x/pull/7 的状态（gh 网络错误）",
    ]);
    expect(diffReviewSnapshot("b", before, { sha: SHA, remote: { sha: SHA }, pr: null })).toEqual(["PR https://x/pull/7 查不到了"]);
    expect(diffReviewSnapshot("b", { sha: SHA, remote: null, pr: null }, { sha: SHA, remote: { sha: "ffff" }, pr: { unavailable: "gh 没装" } })).toEqual([]);
  });

  it("开审时 origin 上还没有这个分支，审查期间被推上去：算变了", () => {
    expect(diffReviewSnapshot("b", { sha: SHA, remote: { sha: null }, pr: null }, { sha: SHA, remote: { sha: "ffffffff" }, pr: null })).toEqual([
      "origin 上的分支 b 从 （没有） 变成了 ffffffff",
    ]);
  });
});

describe("禁推环境变量", () => {
  it("只设 core.hooksPath；守护进程环境里已有 GIT_CONFIG_COUNT 时接在后面", () => {
    expect(reviewPushGuardEnv("/h", {})).toEqual({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/h" });
    expect(reviewPushGuardEnv("/h", { GIT_CONFIG_COUNT: "2" })).toEqual({ GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_2: "core.hooksPath", GIT_CONFIG_VALUE_2: "/h" });
  });
});

describe("文案只查不修", () => {
  it("审查清单和任务图手册里没有让审查直接修、推送的说法", () => {
    for (const text of [REVIEW_CHECKLIST, taskGraphSkillBody()]) {
      expect(text).not.toMatch(/直接修|推上去|接手实现的分支/);
    }
    expect(REVIEW_CHECKLIST).toContain("只查不修");
    expect(REVIEW_CHECKLIST).toContain("结论: PASS | PASS+NOTES | FAIL");
    expect(taskGraphSkillBody()).toContain("审查只查不修");
  });

  it("审查清单写明两层审查只读主干的 REVIEW.md、三档分级、增量复审与轮次上限、本机优先门禁", () => {
    expect(REVIEW_CHECKLIST).toContain("git show origin/main:REVIEW.md");
    expect(REVIEW_CHECKLIST).toContain("被审分支自己改过的那份不算数");
    for (const tag of ["[Important]", "[Nit]", "[Pre-existing]"]) expect(REVIEW_CHECKLIST).toContain(tag);
    expect(REVIEW_CHECKLIST).toContain("git diff <上一轮被审提交>..HEAD");
    expect(REVIEW_CHECKLIST).toContain(`第 ${REVIEW_MAX_ROUNDS} 轮还有未决的`);
    expect(REVIEW_CHECKLIST).toContain("pnpm verify");
    expect(REVIEW_CHECKLIST).toContain("不许用 `gh run rerun`");
    expect(taskGraphSkillBody()).toContain(`第 ${REVIEW_MAX_ROUNDS} 轮审查还有`);
  });
});
