// Markdown report renderer for Tier 1 deterministic product capability harness runs.
import { renderCapabilityReport } from "./ledger.ts";
import type { RealCliProbeOutcome } from "./real-cli-probes.ts";
import type { CapabilityScorecard, EvalScenarioSpec, TrialOutcome, VendorCoverageRow } from "./types.ts";

export interface ScaleBenchmarkMetrics {
  readonly workerCount: number;
  readonly messageCount: number;
  readonly stepLogCount: number;
  readonly turnCount: number;
  readonly interruptedTurnCount: number;
  readonly routerCommandCount: number;
  readonly malformedMetaCount: number;
  readonly runs: number;
  readonly scanDurationMs: number;
  readonly scanMinMs: number;
  readonly scanMaxMs: number;
  readonly heapDeltaBytes: number;
  readonly truncated: boolean;
}

export interface Tier1HarnessReportInput {
  readonly runId: string;
  readonly recordedAt: string;
  readonly branch: string;
  readonly commit: string;
  readonly durationMs: number;
  readonly scenarios: readonly EvalScenarioSpec[];
  readonly trials: readonly TrialOutcome[];
  readonly scorecard: CapabilityScorecard;
  readonly vendorMatrix: readonly VendorCoverageRow[];
  readonly realCliProbes: readonly RealCliProbeOutcome[];
  readonly scaleBenchmark: ScaleBenchmarkMetrics;
}

export function renderTier1BaselineReport(result: Tier1HarnessReportInput): string {
  const passedCount = result.trials.filter(
    (t) => t.checks.length > 0 && t.checks.every((c) => c.status === "pass"),
  ).length;
  const lines: string[] = [
    renderCapabilityReport(result.scorecard, { format: "markdown" }),
    "",
    "## Tier 1 Execution Summary",
    "",
    `- Recorded At: \`${result.recordedAt}\``,
    `- Branch / Commit: \`${result.branch}\` (\`${result.commit}\`)`,
    `- Wall Duration: \`${result.durationMs} ms\` | API Cost: \`$0.00\``,
    `- Tier 1 Scenarios Passed: \`${passedCount}/${result.trials.length}\``,
    "",
    "### Check Details",
    "",
    "| Scenario | Dimension | Check | Status | Reason |",
    "|---|---|---|---|---|",
  ];

  for (const trial of result.trials) {
    for (const check of trial.checks) {
      lines.push(`| ${trial.scenarioId} | ${trial.dimension} | ${check.id} ${check.title} | ${check.status} | ${check.reason} |`);
    }
  }

  lines.push(
    "",
    "## One-Month Ledger Scale Benchmark",
    "",
    `- Seeded Volume: \`${result.scaleBenchmark.workerCount}\` workers, \`${result.scaleBenchmark.messageCount}\` messages (\`${result.scaleBenchmark.malformedMetaCount}\` corrupt meta), \`${result.scaleBenchmark.stepLogCount}\` step logs, \`${result.scaleBenchmark.turnCount}\` turns (\`${result.scaleBenchmark.interruptedTurnCount}\` interrupted), \`${result.scaleBenchmark.routerCommandCount}\` router commands`,
    `- Scan Duration: \`${result.scaleBenchmark.scanDurationMs} ms\` (median of \`${result.scaleBenchmark.runs}\` runs after 1 warm-up, range \`${result.scaleBenchmark.scanMinMs}..${result.scaleBenchmark.scanMaxMs} ms\`) | Median Heap Delta: \`${(result.scaleBenchmark.heapDeltaBytes / (1024 * 1024)).toFixed(2)} MiB\` | Truncated: \`${String(result.scaleBenchmark.truncated)}\``,
    "",
    "## Cross-Vendor Coverage Matrix",
    "",
    "| Vendor | Tier 1 Coverage | Prompt-Cache Check | Replay Support | Gap / Notes |",
    "|---|---|---|---|---|",
  );

  for (const row of result.vendorMatrix) {
    lines.push(
      `| ${row.vendor} | ${row.tier1Coverage} | ${row.promptCacheCheck} | ${row.replaySupport} | ${row.gapReason ?? "none"} |`,
    );
  }

  if (result.realCliProbes.length > 0) {
    lines.push(
      "",
      "## Real-CLI Loopback Verification",
      "",
      "| Vendor | Binary | Status | Recorded Turns | User Config Untouched | Detail |",
      "|---|---|---|---|---|---|",
    );
    for (const probe of result.realCliProbes) {
      lines.push(
        `| ${probe.vendor} | ${probe.binaryPath ? "installed" : "missing"} | ${probe.status} | ${probe.recordedTurns} | ${String(probe.userConfigUntouched)} | ${probe.detail} |`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}
