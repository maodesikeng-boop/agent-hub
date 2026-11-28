import { describe, expect, it } from "vitest";
import { listProductEvalScenarios, selectEvalScenarios } from "./catalog.ts";
import { PRODUCT_EVAL_MAX_CACHE_READ_DROP } from "./limits.ts";
import {
  aggregateScenarioTrials,
  computeGraderFingerprint,
  evaluateComparison,
  evaluateTier1Scorecard,
} from "./scoring.ts";
import type { CapabilityDimension, EvalScenarioSpec, TrialOutcome } from "./types.ts";

function makeScenario(overrides: Partial<EvalScenarioSpec> & { id: string; dimension: CapabilityDimension }): EvalScenarioSpec {
  return {
    title: overrides.id,
    tier: "replay",
    suite: "regression",
    split: "public",
    gateLevel: "rc_blocking",
    targetRole: "pm",
    entryPoints: ["daemon", "hub_cli"],
    minimumTrials: 3,
    triggers: ["src/daemon/prompt.ts"],
    checkIds: ["C1"],
    ...overrides,
  };
}

function makeTrial(
  spec: EvalScenarioSpec,
  opts: {
    versionLabel: "base" | "head";
    trialIndex: number;
    passed?: boolean;
    checks?: TrialOutcome["checks"];
    cacheReadRatio?: number | null;
    prefixStable?: boolean | null;
    graderSha256: string;
    envError?: string | null;
  },
): TrialOutcome {
  return {
    scenarioId: spec.id,
    dimension: spec.dimension,
    suite: spec.suite,
    split: spec.split,
    versionLabel: opts.versionLabel,
    commit: opts.versionLabel === "base" ? "11111111" : "22222222",
    vendor: "claude",
    model: "sonnet",
    effort: "high",
    trialIndex: opts.trialIndex,
    envError: opts.envError ?? null,
    checks:
      opts.checks ??
      spec.checkIds.map((id) => ({
        id,
        title: id,
        status: opts.passed === false ? "fail" : "pass",
        reason: opts.passed === false ? "failed" : "passed",
        evidence: [],
      })),
    efficiency: {
      turns: 2,
      toolCalls: 2,
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 800,
      cacheWriteTokens: 200,
      cacheReadRatio: opts.cacheReadRatio === undefined ? 0.85 : opts.cacheReadRatio,
      prefixStable: opts.prefixStable === undefined ? true : opts.prefixStable,
    },
    promptSha256: "aaaaaaaaaaaaaaaa",
    graderSha256: opts.graderSha256,
  };
}

describe("Tier 1 absolute gate and empty-check regressions", () => {
  it("fails release gate when Tier 1 harness checks fail, even if base and head trials both fail", () => {
    const specs = selectEvalScenarios({ tiers: ["harness"] }, listProductEvalScenarios());
    const sha = computeGraderFingerprint(specs);
    const failedHead = specs.map((s) =>
      makeTrial(s, { versionLabel: "head", trialIndex: 0, passed: false, graderSha256: sha }),
    );

    const tier1Card = evaluateTier1Scorecard({
      runId: "tier1-fail",
      ref: "feature",
      commit: "22222222",
      scenarios: specs,
      trials: failedHead,
    });
    expect(tier1Card.verdict).toBe("regressed");
    expect(tier1Card.releaseGatePass).toBe(false);
    expect(tier1Card.dimensions.every((d) => d.status === "regressed")).toBe(true);

    // Even direct paired evaluateComparison must never mask failing Tier 1 pr_blocking scenarios behind a failing base.
    const selfCompared = evaluateComparison({
      runId: "tier1-self-fail",
      baseRef: "b",
      baseCommit: "1",
      headRef: "h",
      headCommit: "1",
      scenarios: specs,
      baseTrials: failedHead.map((t) => ({ ...t, versionLabel: "base" })),
      headTrials: failedHead,
    });
    expect(selfCompared.verdict).toBe("regressed");
    expect(selfCompared.releaseGatePass).toBe(false);
  });

  it("treats empty checks arrays as failed trials instead of passing", () => {
    const spec = makeScenario({ id: "tier1-empty", dimension: "routing", tier: "harness", gateLevel: "pr_blocking", minimumTrials: 1, checkIds: ["RT1", "RT2"] });
    const sha = computeGraderFingerprint([spec]);
    const agg = aggregateScenarioTrials(spec, [
      makeTrial(spec, { versionLabel: "head", trialIndex: 0, checks: [], graderSha256: sha }),
    ]);
    expect(agg.nPassed).toBe(0);
    expect(agg.status).toBe("fail");
  });

  it("blocks Tier 1 release gate when an installed real-CLI probe fails or mutates user config", () => {
    const specs = selectEvalScenarios({ tiers: ["harness"] }, listProductEvalScenarios());
    const sha = computeGraderFingerprint(specs);
    const passing = specs.map((s) =>
      makeTrial(s, { versionLabel: "head", trialIndex: 0, passed: true, graderSha256: sha }),
    );

    const brokenPrefix = evaluateTier1Scorecard({
      runId: "tier1-probe-prefix",
      ref: "feature",
      commit: "22222222",
      scenarios: specs,
      trials: passing,
      realCliProbes: [
        {
          vendor: "codex",
          status: "failed",
          userConfigUntouched: true,
          resumePrefixStable: false,
          detail: "resume prefix diverged",
        },
      ],
    });
    expect(brokenPrefix.verdict).toBe("regressed");
    expect(brokenPrefix.releaseGatePass).toBe(false);
    expect(brokenPrefix.dimensions.find((d) => d.dimension === "efficiency")?.prefixRegressed).toBe(true);

    const configMutated = evaluateTier1Scorecard({
      runId: "tier1-probe-config",
      ref: "feature",
      commit: "22222222",
      scenarios: specs,
      trials: passing,
      realCliProbes: [
        {
          vendor: "claude",
          status: "failed",
          userConfigUntouched: false,
          resumePrefixStable: true,
          detail: "~/.claude.json mtime changed",
        },
      ],
    });
    expect(configMutated.verdict).toBe("regressed");
    expect(configMutated.releaseGatePass).toBe(false);
    expect(configMutated.dimensions.find((d) => d.dimension === "execution")?.status).toBe("regressed");
  });
});

describe("per-scenario cacheReadRatio, advisory gating, and grader fingerprint lock", () => {
  it("flags single-scenario cacheReadRatio drop > 5pp even when a sibling scenario in the same dimension rises", () => {
    const effA = makeScenario({ id: "eff-a", dimension: "efficiency" });
    const effB = makeScenario({ id: "eff-b", dimension: "efficiency" });
    const scenarios = [effA, effB];
    const sha = computeGraderFingerprint(scenarios);

    const baseTrials = [
      ...[0, 1, 2].map((i) => makeTrial(effA, { versionLabel: "base", trialIndex: i, cacheReadRatio: 0.85, graderSha256: sha })),
      ...[0, 1, 2].map((i) => makeTrial(effB, { versionLabel: "base", trialIndex: i, cacheReadRatio: 0.80, graderSha256: sha })),
    ];
    // Scenario A crashes by -9pp (beyond 5pp cap) while Scenario B rises +5pp (dimension mean is only -2pp).
    const headTrials = [
      ...[0, 1, 2].map((i) => makeTrial(effA, { versionLabel: "head", trialIndex: i, cacheReadRatio: 0.85 - PRODUCT_EVAL_MAX_CACHE_READ_DROP - 0.04, graderSha256: sha })),
      ...[0, 1, 2].map((i) => makeTrial(effB, { versionLabel: "head", trialIndex: i, cacheReadRatio: 0.85, graderSha256: sha })),
    ];

    const scorecard = evaluateComparison({
      runId: "cache-no-mask",
      baseRef: "main",
      baseCommit: "11111111",
      headRef: "feature",
      headCommit: "22222222",
      scenarios,
      baseTrials,
      headTrials,
    });
    expect(scorecard.verdict).toBe("regressed");
    expect(scorecard.releaseGatePass).toBe(false);
    const eff = scorecard.dimensions.find((d) => d.dimension === "efficiency");
    expect(eff?.status).toBe("regressed");
    expect(eff?.reasons.some((r) => r.includes("eff-a"))).toBe(true);
  });

  it("keeps advisory capability and canary scenarios non-blocking when blocking regression scenarios pass", () => {
    const blocking = makeScenario({
      id: "reg-orch",
      dimension: "orchestration",
      suite: "regression",
      gateLevel: "rc_blocking",
      minimumTrials: 3,
    });
    const advisoryCap = makeScenario({
      id: "cap-exec",
      dimension: "execution",
      suite: "capability",
      gateLevel: "advisory",
      minimumTrials: 3,
    });
    const canary = makeScenario({
      id: "canary-eff",
      dimension: "efficiency",
      tier: "canary",
      suite: "capability",
      gateLevel: "advisory",
      minimumTrials: 3,
    });
    const scenarios = [blocking, advisoryCap, canary];
    const sha = computeGraderFingerprint(scenarios);

    const baseTrials = [
      ...[0, 1, 2].map((i) => makeTrial(blocking, { versionLabel: "base", trialIndex: i, passed: true, graderSha256: sha })),
      // Advisory capability only has k=1 (inconclusive) and canary has a cache dip.
      makeTrial(advisoryCap, { versionLabel: "base", trialIndex: 0, passed: true, graderSha256: sha }),
      ...[0, 1, 2].map((i) => makeTrial(canary, { versionLabel: "base", trialIndex: i, passed: true, cacheReadRatio: 0.9, graderSha256: sha })),
    ];
    const headTrials = [
      ...[0, 1, 2].map((i) => makeTrial(blocking, { versionLabel: "head", trialIndex: i, passed: true, graderSha256: sha })),
      makeTrial(advisoryCap, { versionLabel: "head", trialIndex: 0, passed: false, graderSha256: sha }),
      ...[0, 1, 2].map((i) => makeTrial(canary, { versionLabel: "head", trialIndex: i, passed: true, cacheReadRatio: 0.7, graderSha256: sha })),
    ];

    const scorecard = evaluateComparison({
      runId: "advisory-non-blocking",
      baseRef: "main",
      baseCommit: "11111111",
      headRef: "feature",
      headCommit: "22222222",
      scenarios,
      baseTrials,
      headTrials,
    });
    expect(scorecard.verdict).toBe("pass");
    expect(scorecard.releaseGatePass).toBe(true);
    expect(scorecard.reasons.some((r) => r.startsWith("[advisory]"))).toBe(true);
  });

  it("marks graderMatched false when base and head share a stale SHA that does not match input.scenarios", () => {
    const spec = makeScenario({ id: "route-stale", dimension: "routing" });
    const staleSha = "0000000000000000000000000000000000000000000000000000000000000000";
    expect(computeGraderFingerprint([spec])).not.toBe(staleSha);

    const scorecard = evaluateComparison({
      runId: "stale-grader-sha",
      baseRef: "main",
      baseCommit: "11111111",
      headRef: "feature",
      headCommit: "22222222",
      scenarios: [spec],
      baseTrials: [0, 1, 2].map((i) => makeTrial(spec, { versionLabel: "base", trialIndex: i, graderSha256: staleSha })),
      headTrials: [0, 1, 2].map((i) => makeTrial(spec, { versionLabel: "head", trialIndex: i, graderSha256: staleSha })),
    });
    expect(scorecard.graderMatched).toBe(false);
    expect(scorecard.verdict).toBe("grader_changed");
    expect(scorecard.releaseGatePass).toBe(false);
  });
});
