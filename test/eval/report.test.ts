// Retention pruning and unified multi-dimension capability report checks.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { shortTmp } from "../e2e/harness.ts";
import { EVAL_KEEP_FAILED_WORK, EVAL_KEEP_RUNS } from "./limits.ts";
import { listProductEvalScenarios, selectEvalScenarios } from "./product/catalog.ts";
import { renderCapabilityReport } from "./product/ledger.ts";
import { computeGraderFingerprint, evaluateComparison } from "./product/scoring.ts";
import { CAPABILITY_DIMENSIONS, type TrialOutcome } from "./product/types.ts";
import { pruneFailedWork, pruneRuns, runIdOf } from "./report.ts";

const root = mkdtempSync(join(shortTmp(), "ah-evalrep-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("retention pruning", () => {
  it(`keeps the newest ${EVAL_KEEP_RUNS} runs and prunes runs older than 30 days`, () => {
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

  it(`keeps at most ${EVAL_KEEP_FAILED_WORK} failed work directories and prunes the oldest`, () => {
    const work = join(root, "w");
    for (let i = 0; i < EVAL_KEEP_FAILED_WORK + 2; i++) {
      const d = join(work, `ah-eval-${i}`);
      mkdirSync(d, { recursive: true });
      utimesSync(d, new Date(1_000_000 + i * 1000), new Date(1_000_000 + i * 1000));
    }
    expect(pruneFailedWork(work).map((p) => p.slice(-1))).toEqual(["1", "0"]);
  });
});

describe("unified capability report", () => {
  const [s3a] = selectEvalScenarios({ ids: ["s3a-tray"] }, listProductEvalScenarios());
  const graderSha = computeGraderFingerprint([s3a!]);

  const outcome = (
    versionLabel: "base" | "head",
    trialIndex: number,
    status: "pass" | "fail",
    envError: string | null = null,
  ): TrialOutcome => ({
    scenarioId: s3a!.id,
    dimension: s3a!.dimension,
    suite: s3a!.suite,
    split: s3a!.split,
    versionLabel,
    commit: versionLabel === "base" ? "aaaaaaaaaa" : "bbbbbbbbbb",
    vendor: "claude",
    model: "sonnet",
    effort: "xhigh",
    trialIndex,
    envError,
    checks: [{ id: "A1", title: "验收不读 diff", status, reason: status === "pass" ? "ok" : "read diff", evidence: [] }],
    efficiency: {
      turns: 3,
      toolCalls: 5,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 800,
      cacheWriteTokens: 200,
      cacheReadRatio: 0.8,
      prefixStable: true,
    },
    promptSha256: null,
    graderSha256: graderSha,
  });

  it("renders all five dimensions separately with verdict and release gate status", () => {
    const scorecard = evaluateComparison({
      runId: "20261128-030000",
      baseRef: "main",
      baseCommit: "aaaaaaaaaa",
      headRef: "feature",
      headCommit: "bbbbbbbbbb",
      scenarios: [s3a!],
      baseTrials: [0, 1, 2].map((i) => outcome("base", i, "fail")),
      headTrials: [0, 1, 2].map((i) => outcome("head", i, "pass")),
    });
    const md = renderCapabilityReport(scorecard, { format: "markdown" });
    for (const dim of CAPABILITY_DIMENSIONS) {
      expect(md).toContain(`| ${dim} |`);
    }
    expect(md).toContain("Verdict: `PASS`");
    expect(md).toContain("Release Gate: `PASS`");
    expect(md).toContain("improved");
    expect(md).not.toMatch(/total score/i);
  });

  it("flags high environment error rates as invalid_run instead of failing product score", () => {
    const scorecard = evaluateComparison({
      runId: "20261128-030100",
      baseRef: "a",
      baseCommit: "aaaaaaaa",
      headRef: "b",
      headCommit: "bbbbbbbb",
      scenarios: [s3a!],
      baseTrials: [outcome("base", 0, "pass", "timeout"), outcome("base", 1, "pass"), outcome("base", 2, "pass")],
      headTrials: [0, 1, 2].map((i) => outcome("head", i, "pass")),
    });
    const md = renderCapabilityReport(scorecard, { format: "terminal" });
    expect(scorecard.verdict).toBe("invalid_run");
    expect(scorecard.releaseGatePass).toBe(false);
    expect(md).toContain("Verdict: `INVALID_RUN`");
  });
});
