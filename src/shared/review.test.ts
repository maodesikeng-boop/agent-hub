import { describe, expect, it } from "vitest";
import {
  REVIEW_CHECKLIST,
  diffReviewSnapshot,
  parseReviewCommit,
  parseReviewVerdict,
  reviewPushGuardEnv,
  reviewReportProblem,
  type ReviewSnapshot,
} from "./review.ts";
import { taskGraphSkillBody } from "./task-graph-skill.ts";

const SHA = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const before: ReviewSnapshot = { sha: SHA, remote: { name: "origin", sha: SHA }, pr: { number: 7, state: "OPEN", url: "https://x/pull/7" } };

describe("审查结论", () => {
  it("只认 PASS 和 FAIL，大小写与首尾标点不计较；PASS+NOTES 和别的写法是 null", () => {
    expect(parseReviewVerdict("PASS")).toBe("PASS");
    expect(parseReviewVerdict(" pass。")).toBe("PASS");
    expect(parseReviewVerdict("**FAIL**")).toBe("FAIL");
    for (const bad of ["", "PASS+NOTES", " pass + notes。", "通过", "PASS / FAIL", "OK"]) expect(parseReviewVerdict(bad)).toBeNull();
  });

  it("验证提交：首尾的反引号、句号、加粗不计较，转成小写；空的是 null", () => {
    expect(parseReviewCommit(`\`${SHA.slice(0, 8).toUpperCase()}\`。`)).toBe(SHA.slice(0, 8));
    expect(parseReviewCommit(`**${SHA}**`)).toBe(SHA);
    expect(parseReviewCommit(" ")).toBeNull();
  });

  it("汇报的毛病：没写结论；验证提交不是被审的提交（至少 7 位前缀才算）；开审时没记下被审提交", () => {
    const target = { branch: "hub/1-impl", snapshot: before };
    expect(reviewReportProblem({ verdict: null, verifiedCommit: SHA }, target)).toContain("没写“结论”");
    expect(reviewReportProblem({ verdict: "PASS", verifiedCommit: SHA }, target)).toBeNull();
    expect(reviewReportProblem({ verdict: "FAIL", verifiedCommit: SHA }, target)).toBeNull();
    expect(reviewReportProblem({ verdict: "PASS", verifiedCommit: SHA.slice(0, 7) }, target)).toBeNull();
    expect(reviewReportProblem({ verdict: "PASS", verifiedCommit: SHA.slice(0, 6) }, target)).toContain("被审的是分支 hub/1-impl");
    expect(reviewReportProblem({ verdict: "PASS", verifiedCommit: null }, target)).toContain("（没写）");
    expect(reviewReportProblem({ verdict: "PASS", verifiedCommit: SHA }, { branch: "hub/1-impl", snapshot: null })).toContain("没记下被审分支 hub/1-impl 开审时的提交");
  });
});

describe("收尾核对", () => {
  it("本地、origin、PR 都没变：没有问题", () => {
    expect(diffReviewSnapshot("b", before, { sha: SHA, remote: { name: "origin", sha: SHA }, pr: { number: 7, state: "OPEN", url: "https://x/pull/7" } })).toEqual([]);
  });

  it("PR 被合并、查不了、查不到都算问题；开审时没有 PR、没有 origin 的不核对那一项", () => {
    expect(diffReviewSnapshot("b", before, { sha: SHA, remote: { name: "origin", sha: SHA }, pr: { number: 7, state: "MERGED", url: "https://x/pull/7" } })).toEqual([
      "PR https://x/pull/7 从 OPEN 变成了 MERGED",
    ]);
    expect(diffReviewSnapshot("b", before, { sha: SHA, remote: { name: "origin", sha: SHA }, pr: { unavailable: "gh 网络错误" } })).toEqual([
      "查不了 PR https://x/pull/7 的状态（gh 网络错误）",
    ]);
    expect(diffReviewSnapshot("b", before, { sha: SHA, remote: { name: "origin", sha: SHA }, pr: null })).toEqual(["PR https://x/pull/7 查不到了"]);
    expect(diffReviewSnapshot("b", { sha: SHA, remote: null, pr: null }, { sha: SHA, remote: { name: "origin", sha: "ffff" }, pr: { unavailable: "gh 没装" } })).toEqual([]);
  });

  it("checked out a remote commit the local branch lagged behind: compares the local branch with its own start, not with the checkout", () => {
    const remoteTip = "ffffffffffffffffffffffffffffffffffffffff";
    const start: ReviewSnapshot = { sha: remoteTip, local: SHA, remote: { name: "up", sha: remoteTip }, pr: null };
    expect(diffReviewSnapshot("b", start, { sha: SHA, remote: { name: "up", sha: remoteTip }, pr: null })).toEqual([]);
    expect(diffReviewSnapshot("b", start, { sha: remoteTip, remote: { name: "up", sha: "eeeeeeee" }, pr: null })).toEqual([
      `本地分支 b 从 ${SHA.slice(0, 12)} 变成了 ${remoteTip.slice(0, 12)}`,
      `up 上的分支 b 从 ${remoteTip.slice(0, 12)} 变成了 eeeeeeee`,
    ]);
  });

  it("开审时 origin 上还没有这个分支，审查期间被推上去：算变了", () => {
    expect(diffReviewSnapshot("b", { sha: SHA, remote: { name: "origin", sha: null }, pr: null }, { sha: SHA, remote: { name: "origin", sha: "ffffffff" }, pr: null })).toEqual([
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

describe("极简通用审查协议", () => {
  it("审查清单和任务图手册里只保留极简通用约束：只查不修、PASS/FAIL、增量复审、不硬逼重跑全量", () => {
    for (const text of [REVIEW_CHECKLIST, taskGraphSkillBody()]) {
      expect(text).not.toMatch(/直接修|推上去|接手实现的分支/);
    }
    expect(REVIEW_CHECKLIST).toContain("只查不修");
    expect(REVIEW_CHECKLIST).toContain("结论: PASS | FAIL");
    expect(REVIEW_CHECKLIST).toContain("验证提交");
    expect(REVIEW_CHECKLIST).toContain("复审");
    expect(REVIEW_CHECKLIST).toContain("不硬要求已有云端 CI 的项目在本机重跑全量测试");
    expect(taskGraphSkillBody()).toContain("审查只查不修");
    expect(taskGraphSkillBody()).toContain("结论只有 PASS 和 FAIL");
  });

  it("不包含本仓私有过拟合规矩（REVIEW.md 路径触发、三档级别、PASS+NOTES、轮次上限、防复发落点、GitHub 盖章）", () => {
    for (const text of [REVIEW_CHECKLIST, taskGraphSkillBody()]) {
      expect(text).not.toMatch(/REVIEW\.md|Trigger:|Check:|Seen in:|\[Important\]|\[Nit\]|\[Pre-existing\]|PASS\+NOTES|防复发落点|不许靠重跑盖住抖动的测试|提交状态|pnpm|bwrap|\bgh /u);
    }
  });
});
