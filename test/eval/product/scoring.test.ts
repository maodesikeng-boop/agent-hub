import { describe, expect, it } from "vitest";
import {
  PRODUCT_EVAL_DEFAULT_CAPABILITY_TRIALS,
  PRODUCT_EVAL_MAX_CACHE_READ_DROP,
  PRODUCT_EVAL_MAX_ENV_ERROR_RATE,
  PRODUCT_EVAL_MAX_OVERFIT_GAP,
  PRODUCT_EVAL_MIN_REGRESSION_TRIALS,
} from "./limits.ts";
import {
  aggregateScenarioTrials,
  computeGraderFingerprint,
  computePassAtK,
  computePassPowK,
  evaluateComparison,
  wilsonInterval,
} from "./scoring.ts";
import {
  CAPABILITY_DIMENSIONS,
  EVAL_SPLITS,
  EVAL_SUITES,
  EVAL_TIERS,
  RELEASE_GATE_LEVELS,
  type CapabilityDimension,
  type CapabilityScorecard,
  type ComparisonInput,
  type ComparisonVerdict,
  type DimensionScorecard,
  type DimensionStatus,
  type EvalScenarioSpec,
  type ScenarioAggregate,
  type ScenarioStatus,
  type TrialEfficiencyMetrics,
  type TrialOutcome,
} from "./types.ts";

function makeScenario(overrides: Partial<EvalScenarioSpec> & { id: string; dimension: CapabilityDimension }): EvalScenarioSpec {
  return {
    title: overrides.id,
    tier: "replay",
    suite: "regression",
    split: "public",
    gateLevel: "rc_blocking",
    targetRole: "pm",
    entryPoints: ["daemon", "hub_cli"],
    minimumTrials: PRODUCT_EVAL_MIN_REGRESSION_TRIALS,
    triggers: ["src/daemon/prompt.ts"],
    checkIds: ["C1"],
    ...overrides,
  };
}

function makeEfficiency(overrides: Partial<TrialEfficiencyMetrics> = {}): TrialEfficiencyMetrics {
  return {
    turns: 3,
    toolCalls: 6,
    inputTokens: 10_000,
    outputTokens: 600,
    cacheReadTokens: 8_500,
    cacheWriteTokens: 1_500,
    cacheReadRatio: 0.85,
    prefixStable: true,
    ...overrides,
  };
}

function makeTrial(
  spec: EvalScenarioSpec,
  opts: {
    versionLabel: "base" | "head";
    trialIndex: number;
    passed?: boolean;
    envError?: string | null;
    graderSha256?: string;
    efficiency?: Partial<TrialEfficiencyMetrics>;
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
    checks: [
      {
        id: "C1",
        title: "Primary check",
        status: opts.passed === false ? "fail" : "pass",
        reason: opts.passed === false ? "failed" : "passed",
        evidence: [],
      },
    ],
    efficiency: makeEfficiency(opts.efficiency),
    promptSha256: "aaaaaaaaaaaaaaaa",
    graderSha256: opts.graderSha256 ?? "grader-sha-v1",
  };
}

describe("statistical estimators for multi-trial evaluation", () => {
  it("computes exact unbiased pass@k, pass^k, and Wilson 95% confidence bounds", () => {
    expect(CAPABILITY_DIMENSIONS).toHaveLength(5);
    expect(EVAL_TIERS).toEqual(["harness", "replay", "canary"]);
    expect(EVAL_SUITES).toEqual(["regression", "capability"]);
    expect(EVAL_SPLITS).toEqual(["public", "holdout"]);
    expect(RELEASE_GATE_LEVELS).toEqual(["pr_blocking", "rc_blocking", "advisory"]);

    // With n=5 valid trials and c=1 passing trial, pass@3 = 1 - C(4,3)/C(5,3) = 1 - 4/10 = 0.6.
    expect(computePassAtK(5, 1, PRODUCT_EVAL_DEFAULT_CAPABILITY_TRIALS)).toBeCloseTo(0.6, 6);
    expect(computePassAtK(3, 3, 3)).toBe(1);
    expect(computePassAtK(3, 0, 3)).toBe(0);

    // Consistency metric pass^3 = (2/3)^3 = 8/27.
    expect(computePassPowK(3, 2, 3)).toBeCloseTo(8 / 27, 6);
    expect(computePassPowK(3, 3, 3)).toBe(1);

    const ci = wilsonInterval(10, 8);
    expect(ci.low).toBeGreaterThan(0.45);
    expect(ci.low).toBeLessThan(0.8);
    expect(ci.high).toBeGreaterThan(0.8);
    expect(ci.high).toBeLessThan(0.96);
  });

  it("throws RangeError on invalid estimator bounds", () => {
    expect(() => computePassAtK(3, 4, 2)).toThrow(RangeError);
    expect(() => computePassAtK(2, 1, 3)).toThrow(RangeError);
    expect(() => computePassPowK(0, 0, 1)).toThrow(RangeError);
    expect(() => wilsonInterval(0, 0)).toThrow(RangeError);
  });
});

describe("anti-flakiness aggregation and environment-error quarantine", () => {
  it("marks k=1 exploratory runs inconclusive and quarantines envError runs above cap", () => {
    const spec = makeScenario({ id: "orch-1", dimension: "orchestration" });

    const singleTrial: ScenarioAggregate = aggregateScenarioTrials(spec, [
      makeTrial(spec, { versionLabel: "head", trialIndex: 0, passed: true }),
    ]);
    const inconclusiveStatus: ScenarioStatus = "inconclusive";
    expect(singleTrial.status).toBe(inconclusiveStatus);
    expect(singleTrial.nValid).toBe(1);

    // 2 of 5 trials failed due to environment outage: 40% exceeds PRODUCT_EVAL_MAX_ENV_ERROR_RATE (20%).
    const noisyTrials = [
      makeTrial(spec, { versionLabel: "head", trialIndex: 0, passed: true }),
      makeTrial(spec, { versionLabel: "head", trialIndex: 1, passed: true }),
      makeTrial(spec, { versionLabel: "head", trialIndex: 2, passed: true }),
      makeTrial(spec, { versionLabel: "head", trialIndex: 3, envError: "network_timeout" }),
      makeTrial(spec, { versionLabel: "head", trialIndex: 4, envError: "quota_exhausted" }),
    ];
    const noisyAgg = aggregateScenarioTrials(spec, noisyTrials);
    expect(noisyAgg.nEnvError).toBe(2);
    expect(noisyAgg.envErrorRate).toBeGreaterThan(PRODUCT_EVAL_MAX_ENV_ERROR_RATE);
    expect(noisyAgg.status).toBe("invalid_run");
  });
});

describe("non-collapsed scorecard, grader lock, cache regression, and holdout anti-overfitting", () => {
  it("fails releaseGatePass when one dimension regresses in cacheReadRatio even if four dimensions pass", () => {
    const scenarios = CAPABILITY_DIMENSIONS.map((dimension) =>
      makeScenario({ id: `reg-${dimension}`, dimension }),
    );
    const graderSha = computeGraderFingerprint(scenarios);
    const baseTrials = scenarios.flatMap((s) =>
      [0, 1, 2].map((trialIndex) => makeTrial(s, { versionLabel: "base", trialIndex, graderSha256: graderSha })),
    );
    const headTrials = scenarios.flatMap((s) =>
      [0, 1, 2].map((trialIndex) =>
        makeTrial(s, {
          versionLabel: "head",
          trialIndex,
          graderSha256: graderSha,
          efficiency:
            s.dimension === "efficiency"
              ? { cacheReadRatio: 0.85 - PRODUCT_EVAL_MAX_CACHE_READ_DROP - 0.05 }
              : undefined,
        }),
      ),
    );

    const input: ComparisonInput = {
      runId: "20261128-030000",
      baseRef: "main",
      baseCommit: "11111111",
      headRef: "feature",
      headCommit: "22222222",
      scenarios,
      baseTrials,
      headTrials,
    };
    const scorecard: CapabilityScorecard = evaluateComparison(input);
    const expectedVerdict: ComparisonVerdict = "regressed";
    const expectedDimStatus: DimensionStatus = "regressed";

    expect(scorecard.verdict).toBe(expectedVerdict);
    expect(scorecard.releaseGatePass).toBe(false);
    expect(scorecard.dimensions).toHaveLength(5);
    const eff: DimensionScorecard | undefined = scorecard.dimensions.find((d) => d.dimension === "efficiency");
    expect(eff?.status).toBe(expectedDimStatus);
    expect(eff?.cacheReadDelta).toBeLessThan(-PRODUCT_EVAL_MAX_CACHE_READ_DROP);
  });

  it("rejects comparison with grader_changed when base and head grader fingerprints disagree", () => {
    const s = makeScenario({ id: "route-1", dimension: "routing" });
    const baseTrials = [0, 1, 2].map((trialIndex) =>
      makeTrial(s, { versionLabel: "base", trialIndex, graderSha256: "sha-old" }),
    );
    const headTrials = [0, 1, 2].map((trialIndex) =>
      makeTrial(s, { versionLabel: "head", trialIndex, graderSha256: "sha-new" }),
    );
    const scorecard = evaluateComparison({
      runId: "20261128-030100",
      baseRef: "main",
      baseCommit: "11111111",
      headRef: "feature",
      headCommit: "22222222",
      scenarios: [s],
      baseTrials,
      headTrials,
    });
    expect(scorecard.graderMatched).toBe(false);
    expect(scorecard.verdict).toBe("grader_changed");
    expect(scorecard.releaseGatePass).toBe(false);
  });

  it("emits overfit_warning and blocks release gate when public improves while holdout drops past cap", () => {
    const pub = makeScenario({ id: "orch-pub", dimension: "orchestration", split: "public", suite: "capability" });
    const hold = makeScenario({ id: "orch-hold", dimension: "orchestration", split: "holdout", suite: "capability" });
    const graderSha = computeGraderFingerprint([pub, hold]);
    // Order-independent fingerprint check.
    expect(computeGraderFingerprint([hold, pub])).toBe(graderSha);

    const baseTrials = [
      // Public base: 1/3 pass (0.33); Holdout base: 3/3 pass (1.00).
      makeTrial(pub, { versionLabel: "base", trialIndex: 0, passed: true, graderSha256: graderSha }),
      makeTrial(pub, { versionLabel: "base", trialIndex: 1, passed: false, graderSha256: graderSha }),
      makeTrial(pub, { versionLabel: "base", trialIndex: 2, passed: false, graderSha256: graderSha }),
      makeTrial(hold, { versionLabel: "base", trialIndex: 0, passed: true, graderSha256: graderSha }),
      makeTrial(hold, { versionLabel: "base", trialIndex: 1, passed: true, graderSha256: graderSha }),
      makeTrial(hold, { versionLabel: "base", trialIndex: 2, passed: true, graderSha256: graderSha }),
    ];
    const headTrials = [
      // Public head: 3/3 pass (+0.67); Holdout head: 1/3 pass (-0.67).
      makeTrial(pub, { versionLabel: "head", trialIndex: 0, passed: true, graderSha256: graderSha }),
      makeTrial(pub, { versionLabel: "head", trialIndex: 1, passed: true, graderSha256: graderSha }),
      makeTrial(pub, { versionLabel: "head", trialIndex: 2, passed: true, graderSha256: graderSha }),
      makeTrial(hold, { versionLabel: "head", trialIndex: 0, passed: true, graderSha256: graderSha }),
      makeTrial(hold, { versionLabel: "head", trialIndex: 1, passed: false, graderSha256: graderSha }),
      makeTrial(hold, { versionLabel: "head", trialIndex: 2, passed: false, graderSha256: graderSha }),
    ];

    const scorecard = evaluateComparison({
      runId: "20261128-030200",
      baseRef: "main",
      baseCommit: "11111111",
      headRef: "feature",
      headCommit: "22222222",
      scenarios: [pub, hold],
      baseTrials,
      headTrials,
    });
    expect(scorecard.overfitGap).toBeGreaterThan(PRODUCT_EVAL_MAX_OVERFIT_GAP);
    expect(scorecard.verdict).toBe("overfit_warning");
    expect(scorecard.releaseGatePass).toBe(false);
  });
});
