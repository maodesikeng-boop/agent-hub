// Statistical multi-trial aggregation, anti-gaming guards, paired comparison, and release-gate policy.
// Invariant: pure functions with no I/O and no wall-clock reads; environment errors are quarantined from product scores.
import { createHash } from "node:crypto";
import {
  PRODUCT_EVAL_MAX_CACHE_READ_DROP,
  PRODUCT_EVAL_MAX_ENV_ERROR_RATE,
  PRODUCT_EVAL_MAX_OVERFIT_GAP,
} from "./limits.ts";
import {
  CAPABILITY_DIMENSIONS,
  type CapabilityScorecard,
  type ComparisonInput,
  type ComparisonVerdict,
  type DimensionScorecard,
  type DimensionStatus,
  type EvalScenarioSpec,
  type EvalSplit,
  type ScenarioAggregate,
  type ScenarioStatus,
  type TrialOutcome,
} from "./types.ts";

const DEFAULT_WILSON_Z = 1.959964;
const EPSILON = 1e-9;

export interface Tier1ProbeGateItem {
  readonly vendor: string;
  readonly status: "verified" | "failed" | "not_verified";
  readonly userConfigUntouched: boolean;
  readonly resumePrefixStable: boolean | null;
  readonly detail: string;
}

export interface Tier1EvaluationInput {
  readonly runId: string;
  readonly ref: string;
  readonly commit: string;
  readonly scenarios: readonly EvalScenarioSpec[];
  readonly trials: readonly TrialOutcome[];
  readonly realCliProbes?: readonly Tier1ProbeGateItem[];
}

function assertValidTrialCounts(nValid: number, nPassed: number): void {
  if (!Number.isInteger(nValid) || !Number.isInteger(nPassed) || nValid < 1 || nPassed < 0 || nPassed > nValid) {
    throw new RangeError(`Invalid trial counts: nValid=${nValid}, nPassed=${nPassed}`);
  }
}

export function computePassAtK(nValid: number, nPassed: number, k: number): number {
  assertValidTrialCounts(nValid, nPassed);
  if (!Number.isInteger(k) || k < 1 || k > nValid) {
    throw new RangeError(`Invalid k=${k} for nValid=${nValid}`);
  }
  if (nValid - nPassed < k) return 1;
  if (nPassed === 0) return 0;

  let failProb = 1;
  for (let i = 0; i < k; i += 1) {
    failProb *= (nValid - nPassed - i) / (nValid - i);
  }
  return Math.max(0, Math.min(1, 1 - failProb));
}

export function computePassPowK(nValid: number, nPassed: number, k: number): number {
  assertValidTrialCounts(nValid, nPassed);
  if (!Number.isInteger(k) || k < 1) {
    throw new RangeError(`Invalid k=${k} for pass^k`);
  }
  return Math.max(0, Math.min(1, (nPassed / nValid) ** k));
}

export function wilsonInterval(nValid: number, nPassed: number, z = DEFAULT_WILSON_Z): { low: number; high: number } {
  assertValidTrialCounts(nValid, nPassed);
  if (!Number.isFinite(z) || z < 0) {
    throw new RangeError(`Invalid z-score: ${z}`);
  }
  const p = nPassed / nValid;
  const z2 = z * z;
  const denom = 1 + z2 / nValid;
  const center = (p + z2 / (2 * nValid)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / nValid + z2 / (4 * nValid * nValid))) / denom;
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

export function computeGraderFingerprint(scenarios: readonly EvalScenarioSpec[]): string {
  const canonical = [...scenarios]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((s) => ({
      id: s.id,
      dimension: s.dimension,
      tier: s.tier,
      suite: s.suite,
      split: s.split,
      gateLevel: s.gateLevel,
      minimumTrials: s.minimumTrials,
      checkIds: [...s.checkIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function isAdvisoryScenario(spec: EvalScenarioSpec): boolean {
  return spec.gateLevel === "advisory" || spec.tier === "canary";
}

function requiresAbsolutePass(spec: EvalScenarioSpec): boolean {
  return spec.tier === "harness" || spec.gateLevel === "pr_blocking";
}

function isTrialPassed(trial: TrialOutcome): boolean {
  if (trial.envError !== null) return false;
  if (trial.checks.length === 0) return false;
  if (trial.checks.some((c) => c.status === "fail")) return false;
  if (!trial.checks.some((c) => c.status === "pass")) return false;
  return trial.efficiency.prefixStable !== false;
}

function meanOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function aggregateScenarioTrials(
  spec: EvalScenarioSpec,
  trials: readonly TrialOutcome[],
): ScenarioAggregate {
  const nTotal = trials.length;
  const valid = trials.filter((t) => t.envError === null);
  const nValid = valid.length;
  const nEnvError = nTotal - nValid;
  const envErrorRate = nTotal === 0 ? 0 : nEnvError / nTotal;
  const nPassed = valid.filter(isTrialPassed).length;
  const k = nValid > 0 ? Math.max(1, Math.min(spec.minimumTrials, nValid)) : spec.minimumTrials;

  const passAtK = nValid > 0 ? computePassAtK(nValid, nPassed, k) : null;
  const passPowK = nValid > 0 ? computePassPowK(nValid, nPassed, k) : null;
  const ci = nValid > 0 ? wilsonInterval(nValid, nPassed) : null;
  const meanTurns = meanOf(valid.map((t) => t.efficiency.turns));
  const cacheRatios = valid
    .map((t) => t.efficiency.cacheReadRatio)
    .filter((v): v is number => v !== null);
  const meanCacheReadRatio = meanOf(cacheRatios);
  const allPrefixesStable = valid.every((t) => t.efficiency.prefixStable !== false);

  let status: ScenarioStatus;
  if (nTotal === 0) {
    status = "inconclusive";
  } else if (envErrorRate > PRODUCT_EVAL_MAX_ENV_ERROR_RATE) {
    status = "invalid_run";
  } else if (nValid < spec.minimumTrials) {
    status = "inconclusive";
  } else if (!allPrefixesStable) {
    status = "fail";
  } else if (spec.suite === "regression") {
    status = nPassed === nValid ? "pass" : "fail";
  } else {
    status = nPassed > 0 ? "pass" : "fail";
  }

  return {
    scenarioId: spec.id,
    dimension: spec.dimension,
    suite: spec.suite,
    split: spec.split,
    nTotal,
    nValid,
    nPassed,
    nEnvError,
    envErrorRate,
    k,
    passAtK,
    passPowK,
    wilsonLow: ci?.low ?? null,
    wilsonHigh: ci?.high ?? null,
    meanTurns,
    meanCacheReadRatio,
    allPrefixesStable,
    status,
  };
}

function uniqueGraderSha(trials: readonly TrialOutcome[]): { sha: string | null; consistent: boolean } {
  const unique = [...new Set(trials.map((t) => t.graderSha256))];
  if (unique.length === 0) return { sha: null, consistent: false };
  if (unique.length > 1) return { sha: unique[0]!, consistent: false };
  return { sha: unique[0]!, consistent: true };
}

function splitPassRate(
  entries: readonly { readonly agg: ScenarioAggregate | null }[],
  split: EvalSplit,
): number | null {
  const rates: number[] = [];
  for (const { agg } of entries) {
    if (agg === null || agg.split !== split || agg.nValid === 0) continue;
    rates.push(agg.nPassed / agg.nValid);
  }
  return meanOf(rates);
}

interface ScenarioPair {
  readonly spec: EvalScenarioSpec;
  readonly base: ScenarioAggregate | null;
  readonly head: ScenarioAggregate | null;
}

function evaluatePairGroup(pairs: readonly ScenarioPair[]): {
  status: DimensionStatus;
  prefixRegressed: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  const prefixRegressed = pairs.some((p) => p.head !== null && !p.head.allPrefixesStable);

  if (pairs.some((p) => p.base?.status === "invalid_run" || p.head?.status === "invalid_run")) {
    reasons.push("Environment error rate exceeded cap");
    return { status: "invalid_run", prefixRegressed, reasons };
  }
  if (
    pairs.some(
      (p) =>
        p.base === null ||
        p.head === null ||
        p.base.status === "inconclusive" ||
        p.head.status === "inconclusive",
    )
  ) {
    reasons.push("Valid trials below scenario minimumTrials");
    return { status: "inconclusive", prefixRegressed, reasons };
  }

  let regressed = false;
  let improved = false;

  if (prefixRegressed) {
    regressed = true;
    reasons.push("Prompt-cache prefix stability regressed");
  }

  for (const p of pairs) {
    const b = p.base!;
    const h = p.head!;

    if (b.meanCacheReadRatio !== null && h.meanCacheReadRatio !== null) {
      const delta = h.meanCacheReadRatio - b.meanCacheReadRatio;
      if (delta < -PRODUCT_EVAL_MAX_CACHE_READ_DROP - EPSILON) {
        regressed = true;
        reasons.push(
          `${p.spec.id}: cacheReadRatio dropped by ${(-delta * 100).toFixed(1)}pp (limit ${(PRODUCT_EVAL_MAX_CACHE_READ_DROP * 100).toFixed(1)}pp)`,
        );
      }
    }

    if (requiresAbsolutePass(p.spec) && h.status !== "pass") {
      regressed = true;
      reasons.push(`${p.spec.id}: Tier 1 absolute pass gate failed (${h.nPassed}/${h.nValid}, status=${h.status})`);
    } else if (p.spec.suite === "regression") {
      if (b.passPowK !== null && h.passPowK !== null && h.passPowK < b.passPowK - EPSILON) {
        regressed = true;
        reasons.push(`${p.spec.id}: pass^${h.k} dropped ${b.passPowK.toFixed(2)} -> ${h.passPowK.toFixed(2)}`);
      } else if (b.passPowK !== null && h.passPowK !== null && h.passPowK > b.passPowK + EPSILON) {
        improved = true;
      }
    } else if (b.passAtK !== null && h.passAtK !== null && h.passAtK > b.passAtK + EPSILON) {
      improved = true;
    }
  }

  return {
    status: regressed ? "regressed" : improved ? "improved" : "pass",
    prefixRegressed,
    reasons,
  };
}

function buildDimensionScorecard(
  dimension: (typeof CAPABILITY_DIMENSIONS)[number],
  pairs: readonly ScenarioPair[],
): DimensionScorecard {
  if (pairs.length === 0) {
    return {
      dimension,
      suite: "regression",
      basePassPowK: null,
      headPassPowK: null,
      basePassAtK: null,
      headPassAtK: null,
      cacheReadDelta: null,
      turnDelta: null,
      prefixRegressed: false,
      status: "not_applicable",
      reasons: [],
    };
  }

  const blockingPairs = pairs.filter((p) => !isAdvisoryScenario(p.spec));
  const advisoryPairs = pairs.filter((p) => isAdvisoryScenario(p.spec));
  const primaryPairs = blockingPairs.length > 0 ? blockingPairs : advisoryPairs;

  const suite = pairs.some((p) => p.spec.suite === "regression") ? "regression" : "capability";
  const basePassPowK = meanOf(primaryPairs.map((p) => p.base?.passPowK).filter((v): v is number => v !== null && v !== undefined));
  const headPassPowK = meanOf(primaryPairs.map((p) => p.head?.passPowK).filter((v): v is number => v !== null && v !== undefined));
  const basePassAtK = meanOf(primaryPairs.map((p) => p.base?.passAtK).filter((v): v is number => v !== null && v !== undefined));
  const headPassAtK = meanOf(primaryPairs.map((p) => p.head?.passAtK).filter((v): v is number => v !== null && v !== undefined));
  const baseCache = meanOf(primaryPairs.map((p) => p.base?.meanCacheReadRatio).filter((v): v is number => v !== null && v !== undefined));
  const headCache = meanOf(primaryPairs.map((p) => p.head?.meanCacheReadRatio).filter((v): v is number => v !== null && v !== undefined));
  const baseTurns = meanOf(primaryPairs.map((p) => p.base?.meanTurns).filter((v): v is number => v !== null && v !== undefined));
  const headTurns = meanOf(primaryPairs.map((p) => p.head?.meanTurns).filter((v): v is number => v !== null && v !== undefined));

  const cacheReadDelta = baseCache !== null && headCache !== null ? headCache - baseCache : null;
  const turnDelta = baseTurns !== null && headTurns !== null ? headTurns - baseTurns : null;

  const primaryEval = evaluatePairGroup(primaryPairs);
  const reasons = [...primaryEval.reasons];
  if (blockingPairs.length > 0 && advisoryPairs.length > 0) {
    const advEval = evaluatePairGroup(advisoryPairs);
    for (const r of advEval.reasons) {
      reasons.push(`[advisory] ${r}`);
    }
  }

  return {
    dimension,
    suite,
    basePassPowK,
    headPassPowK,
    basePassAtK,
    headPassAtK,
    cacheReadDelta,
    turnDelta,
    prefixRegressed: primaryEval.prefixRegressed,
    status: primaryEval.status,
    reasons,
  };
}

export function evaluateComparison(input: ComparisonInput): CapabilityScorecard {
  const baseByScenario = new Map<string, TrialOutcome[]>();
  const headByScenario = new Map<string, TrialOutcome[]>();
  for (const t of input.baseTrials) {
    const list = baseByScenario.get(t.scenarioId) ?? [];
    list.push(t);
    baseByScenario.set(t.scenarioId, list);
  }
  for (const t of input.headTrials) {
    const list = headByScenario.get(t.scenarioId) ?? [];
    list.push(t);
    headByScenario.set(t.scenarioId, list);
  }

  const expectedGraderSha = computeGraderFingerprint(input.scenarios);
  const baseGrader = uniqueGraderSha(input.baseTrials);
  const headGrader = uniqueGraderSha(input.headTrials);
  const graderMatched =
    baseGrader.consistent &&
    headGrader.consistent &&
    baseGrader.sha === headGrader.sha &&
    baseGrader.sha === expectedGraderSha;

  const totalTrials = input.baseTrials.length + input.headTrials.length;
  const totalEnvErrors =
    input.baseTrials.filter((t) => t.envError !== null).length +
    input.headTrials.filter((t) => t.envError !== null).length;
  const envErrorRate = totalTrials === 0 ? 0 : totalEnvErrors / totalTrials;

  const scenarioPairs: ScenarioPair[] = input.scenarios.map((spec) => {
    const baseList = baseByScenario.get(spec.id) ?? [];
    const headList = headByScenario.get(spec.id) ?? [];
    return {
      spec,
      base: baseList.length > 0 ? aggregateScenarioTrials(spec, baseList) : null,
      head: headList.length > 0 ? aggregateScenarioTrials(spec, headList) : null,
    };
  });

  const basePublic = splitPassRate(scenarioPairs.map((p) => ({ agg: p.base })), "public");
  const headPublic = splitPassRate(scenarioPairs.map((p) => ({ agg: p.head })), "public");
  const baseHoldout = splitPassRate(scenarioPairs.map((p) => ({ agg: p.base })), "holdout");
  const headHoldout = splitPassRate(scenarioPairs.map((p) => ({ agg: p.head })), "holdout");

  const publicDelta = basePublic !== null && headPublic !== null ? headPublic - basePublic : null;
  const holdoutDelta = baseHoldout !== null && headHoldout !== null ? headHoldout - baseHoldout : null;
  const overfitGap = publicDelta !== null && holdoutDelta !== null ? publicDelta - holdoutDelta : null;
  const isOverfit =
    publicDelta !== null &&
    holdoutDelta !== null &&
    publicDelta > EPSILON &&
    holdoutDelta < -EPSILON &&
    (Math.abs(holdoutDelta) > PRODUCT_EVAL_MAX_OVERFIT_GAP + EPSILON ||
      (overfitGap !== null && overfitGap > PRODUCT_EVAL_MAX_OVERFIT_GAP + EPSILON));

  const dimensions: DimensionScorecard[] = CAPABILITY_DIMENSIONS.map((dimension) =>
    buildDimensionScorecard(
      dimension,
      scenarioPairs.filter((p) => p.spec.dimension === dimension),
    ),
  );

  const blockingDimensions = dimensions.filter((d) =>
    scenarioPairs.some((p) => p.spec.dimension === d.dimension && !isAdvisoryScenario(p.spec)),
  );
  const blockingScenarioIds = new Set(scenarioPairs.filter((p) => !isAdvisoryScenario(p.spec)).map((p) => p.spec.id));
  const blockingTrials = [...input.baseTrials, ...input.headTrials].filter((t) => blockingScenarioIds.has(t.scenarioId));
  const blockingEnvErrorRate =
    blockingTrials.length === 0
      ? 0
      : blockingTrials.filter((t) => t.envError !== null).length / blockingTrials.length;

  const reasons: string[] = [];
  let verdict: ComparisonVerdict = "pass";
  let releaseGatePass = true;

  if (!graderMatched) {
    verdict = "grader_changed";
    releaseGatePass = false;
    reasons.push(
      `Grader SHA-256 mismatch: expected=${expectedGraderSha}, base=${String(baseGrader.sha)}, head=${String(headGrader.sha)}`,
    );
  } else if (
    blockingEnvErrorRate > PRODUCT_EVAL_MAX_ENV_ERROR_RATE + EPSILON ||
    blockingDimensions.some((d) => d.status === "invalid_run")
  ) {
    verdict = "invalid_run";
    releaseGatePass = false;
    reasons.push(
      `Environment error rate ${(blockingEnvErrorRate * 100).toFixed(1)}% exceeded cap ${(PRODUCT_EVAL_MAX_ENV_ERROR_RATE * 100).toFixed(1)}%`,
    );
  } else if (blockingDimensions.some((d) => d.status === "inconclusive")) {
    verdict = "inconclusive";
    releaseGatePass = false;
    reasons.push("Exploratory or incomplete trial count cannot pass release gate");
  } else if (isOverfit) {
    verdict = "overfit_warning";
    releaseGatePass = false;
    reasons.push(
      `Public/holdout divergence detected: public ${(publicDelta! * 100).toFixed(1)}pp, holdout ${(holdoutDelta! * 100).toFixed(1)}pp (gap ${overfitGap!.toFixed(2)} > ${PRODUCT_EVAL_MAX_OVERFIT_GAP.toFixed(2)})`,
    );
  } else if (blockingDimensions.some((d) => d.status === "regressed")) {
    verdict = "regressed";
    releaseGatePass = false;
    for (const d of blockingDimensions) {
      if (d.status === "regressed") {
        reasons.push(`${d.dimension}: ${d.reasons.join("; ") || "regressed"}`);
      }
    }
  }

  for (const d of dimensions) {
    const isAdvisoryOnly = !blockingDimensions.includes(d) && d.status !== "not_applicable";
    if (isAdvisoryOnly && (d.status === "regressed" || d.status === "inconclusive" || d.status === "invalid_run")) {
      reasons.push(`[advisory] ${d.dimension}: ${d.reasons.join("; ") || d.status}`);
    }
  }

  return {
    schemaVersion: 1,
    runId: input.runId,
    baseRef: input.baseRef,
    baseCommit: input.baseCommit,
    headRef: input.headRef,
    headCommit: input.headCommit,
    graderSha256Base: baseGrader.sha,
    graderSha256Head: headGrader.sha,
    graderMatched,
    envErrorRate,
    publicDelta,
    holdoutDelta,
    overfitGap,
    dimensions,
    scenarioAggregates: scenarioPairs.map((p) => ({
      scenarioId: p.spec.id,
      base: p.base,
      head: p.head,
    })),
    verdict,
    releaseGatePass,
    reasons,
  };
}

export function evaluateTier1Scorecard(input: Tier1EvaluationInput): CapabilityScorecard {
  const byScenario = new Map<string, TrialOutcome[]>();
  for (const t of input.trials) {
    const list = byScenario.get(t.scenarioId) ?? [];
    list.push(t);
    byScenario.set(t.scenarioId, list);
  }

  const expectedGraderSha = computeGraderFingerprint(input.scenarios);
  const headGrader = uniqueGraderSha(input.trials);
  const graderMatched = headGrader.consistent && headGrader.sha === expectedGraderSha;

  const totalTrials = input.trials.length;
  const totalEnvErrors = input.trials.filter((t) => t.envError !== null).length;
  const envErrorRate = totalTrials === 0 ? 0 : totalEnvErrors / totalTrials;

  const aggregates = input.scenarios.map((spec) => {
    const list = byScenario.get(spec.id) ?? [];
    return {
      spec,
      head: list.length > 0 ? aggregateScenarioTrials(spec, list) : null,
    };
  });

  const failedProbes = (input.realCliProbes ?? []).filter(
    (p) => p.status === "failed" || !p.userConfigUntouched || p.resumePrefixStable === false,
  );
  const probeFailedPrefix = failedProbes.some((p) => p.resumePrefixStable === false);
  const probeTouchedConfig = failedProbes.some((p) => !p.userConfigUntouched);

  const dimensions: DimensionScorecard[] = CAPABILITY_DIMENSIONS.map((dimension) => {
    const entries = aggregates.filter((a) => a.spec.dimension === dimension);
    if (entries.length === 0) {
      return {
        dimension,
        suite: "regression",
        basePassPowK: null,
        headPassPowK: null,
        basePassAtK: null,
        headPassAtK: null,
        cacheReadDelta: null,
        turnDelta: null,
        prefixRegressed: false,
        status: "not_applicable",
        reasons: [],
      };
    }

    const headPassPowK = meanOf(entries.map((e) => e.head?.passPowK).filter((v): v is number => v !== null && v !== undefined));
    const headPassAtK = meanOf(entries.map((e) => e.head?.passAtK).filter((v): v is number => v !== null && v !== undefined));
    const scenarioPrefixRegressed = entries.some((e) => e.head !== null && !e.head.allPrefixesStable);
    const dimPrefixRegressed = scenarioPrefixRegressed || (dimension === "efficiency" && probeFailedPrefix);
    const dimReasons: string[] = [];
    let status: DimensionStatus = "pass";

    if (entries.some((e) => e.head?.status === "invalid_run")) {
      status = "invalid_run";
      dimReasons.push("Environment error rate exceeded cap");
    } else if (entries.some((e) => e.head === null || e.head.status === "inconclusive")) {
      status = "inconclusive";
      dimReasons.push("Missing or incomplete Tier 1 trials");
    } else {
      let failed = false;
      if (scenarioPrefixRegressed) {
        failed = true;
        dimReasons.push("Prompt-cache prefix stability regressed");
      }
      for (const e of entries) {
        if (e.head!.status !== "pass" || e.head!.nPassed < e.head!.nValid) {
          failed = true;
          dimReasons.push(`${e.spec.id}: Tier 1 harness failed (${e.head!.nPassed}/${e.head!.nValid}, status=${e.head!.status})`);
        }
      }
      if (dimension === "efficiency" && failedProbes.length > 0 && (probeFailedPrefix || !probeTouchedConfig)) {
        failed = true;
        for (const p of failedProbes) {
          if (p.resumePrefixStable === false || p.status === "failed") {
            dimReasons.push(`real-cli ${p.vendor}: ${p.detail}`);
          }
        }
      }
      if (dimension === "execution" && probeTouchedConfig) {
        failed = true;
        for (const p of failedProbes) {
          if (!p.userConfigUntouched) {
            dimReasons.push(`real-cli ${p.vendor}: real user config mutated (${p.detail})`);
          }
        }
      }
      if (failed) status = "regressed";
    }

    return {
      dimension,
      suite: "regression",
      basePassPowK: null,
      headPassPowK,
      basePassAtK: null,
      headPassAtK,
      cacheReadDelta: null,
      turnDelta: null,
      prefixRegressed: dimPrefixRegressed,
      status,
      reasons: dimReasons,
    };
  });

  const reasons: string[] = [];
  let verdict: ComparisonVerdict = "pass";
  let releaseGatePass = true;

  if (!graderMatched) {
    verdict = "grader_changed";
    releaseGatePass = false;
    reasons.push(`Grader SHA-256 mismatch: expected=${expectedGraderSha}, head=${String(headGrader.sha)}`);
  } else if (envErrorRate > PRODUCT_EVAL_MAX_ENV_ERROR_RATE + EPSILON || dimensions.some((d) => d.status === "invalid_run")) {
    verdict = "invalid_run";
    releaseGatePass = false;
    reasons.push(
      `Environment error rate ${(envErrorRate * 100).toFixed(1)}% exceeded cap ${(PRODUCT_EVAL_MAX_ENV_ERROR_RATE * 100).toFixed(1)}%`,
    );
  } else if (dimensions.some((d) => d.status === "inconclusive")) {
    verdict = "inconclusive";
    releaseGatePass = false;
    reasons.push("Tier 1 harness missing required scenario outcomes");
  } else if (dimensions.some((d) => d.status === "regressed") || failedProbes.length > 0) {
    verdict = "regressed";
    releaseGatePass = false;
    for (const d of dimensions) {
      if (d.status === "regressed") {
        reasons.push(`${d.dimension}: ${d.reasons.join("; ") || "failed"}`);
      }
    }
    for (const p of failedProbes) {
      const msg = `real-cli ${p.vendor}: ${p.detail}`;
      if (!reasons.some((r) => r.includes(msg))) reasons.push(msg);
    }
  }

  return {
    schemaVersion: 1,
    runId: input.runId,
    baseRef: "absolute-gate",
    baseCommit: "tier1",
    headRef: input.ref,
    headCommit: input.commit,
    graderSha256Base: expectedGraderSha,
    graderSha256Head: headGrader.sha,
    graderMatched,
    envErrorRate,
    publicDelta: null,
    holdoutDelta: null,
    overfitGap: null,
    dimensions,
    scenarioAggregates: aggregates.map((a) => ({
      scenarioId: a.spec.id,
      base: null,
      head: a.head,
    })),
    verdict,
    releaseGatePass,
    reasons,
  };
}
