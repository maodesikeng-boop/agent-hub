// 结果目录的上限和保留期（设计第 7 节）、对照表的样子。
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { shortTmp } from "../e2e/harness.ts";
import { EVAL_KEEP_FAILED_WORK, EVAL_KEEP_RUNS } from "./limits.ts";
import { pruneFailedWork, pruneRuns, renderSummary, runIdOf } from "./report.ts";
import type { TrialResult } from "./types.ts";

const root = mkdtempSync(join(shortTmp(), "ah-evalrep-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("保留期", () => {
  it(`运行结果留最近 ${EVAL_KEEP_RUNS} 次，超过 30 天的也删`, () => {
    const runs = join(root, "runs");
    const now = new Date("2026-11-12T10:00:00").getTime();
    for (let i = 0; i < EVAL_KEEP_RUNS + 3; i++) mkdirSync(join(runs, runIdOf(new Date(now - i * 3_600_000))), { recursive: true });
    const old = join(runs, runIdOf(new Date(now - 2 * 3_600_000)));
    utimesSync(old, new Date(now - 40 * 86_400_000), new Date(now - 40 * 86_400_000));
    const removed = pruneRuns(runs, now);
    expect(removed).toHaveLength(4);
    expect(removed).toContain(old);
    expect(readdirSync(runs)).toHaveLength(EVAL_KEEP_RUNS - 1);
  });

  it(`没通过的现场最多留 ${EVAL_KEEP_FAILED_WORK} 个，删最旧的`, () => {
    const work = join(root, "w");
    for (let i = 0; i < EVAL_KEEP_FAILED_WORK + 2; i++) {
      const d = join(work, `ah-eval-${i}`);
      mkdirSync(d, { recursive: true });
      utimesSync(d, new Date(1_000_000 + i * 1000), new Date(1_000_000 + i * 1000));
    }
    expect(pruneFailedWork(work).map((p) => p.slice(-1))).toEqual(["1", "0"]);
  });
});

describe("对照表", () => {
  const trial = (version: string, status: "pass" | "fail", envError: string | null = null): TrialResult => ({
    scenario: "s3a-tray",
    version,
    commit: "c",
    envError,
    checks: [{ id: "A1", title: "验收不读 diff", status, reason: status === "pass" ? "没读" : "读了 1 次", evidence: status === "pass" ? [] : ["messages#9 读 diff：git diff main"] }],
    metrics: { pmTurns: 3, toolCalls: 5, hubCalls: 1, asks: 0, unscriptedAnswers: 0, durationMs: 60_000, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } },
    promptSha256: null,
    resultDir: "/r",
    workDir: null,
  });
  it("每条检查两个版本各是过还是不过、变化、原因和证据都在", () => {
    const md = renderSummary(
      {
        runId: "x",
        startedAt: "",
        finishedAt: "",
        versions: [
          { label: "base", ref: "9b87864^1", commit: "aaaaaaaaaa", subject: "旧" },
          { label: "head", ref: "main", commit: "bbbbbbbbbb", subject: "新" },
        ],
        scenarios: [{ id: "s3a-tray", title: "S3a 托盘", source: "#453" }],
        trials: [trial("base", "fail"), trial("head", "pass")],
      },
      { terminal: true },
    );
    expect(md).toContain("| A1 验收不读 diff | 不过 | 过 | 变好 |");
    expect(md).toContain("messages#9 读 diff：git diff main");
    expect(md).toContain("`9b87864^1` = `aaaaaaaaa`");
  });
  it("环境出错的单列，不算不过", () => {
    const md = renderSummary({ runId: "x", startedAt: "", finishedAt: "", versions: [{ label: "base", ref: "a", commit: "a", subject: "" }, { label: "head", ref: "b", commit: "b", subject: "" }], scenarios: [{ id: "s3a-tray", title: "S3a", source: "" }], trials: [trial("base", "pass", "超时"), trial("head", "pass")] });
    expect(md).toContain("| A1 验收不读 diff | 环境出错 | 过 | 变了 |");
    expect(md).toContain("环境出错，这次不计分");
  });
});
