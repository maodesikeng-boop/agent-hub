// Corruption-tolerant JSONL baseline history ledger and non-collapsed multi-dimension report renderer.
// Invariant: history files stay bounded to PRODUCT_EVAL_HISTORY_MAX_RUNS and rendered output stays within PRODUCT_EVAL_MAX_EVIDENCE_BYTES.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  PRODUCT_EVAL_HISTORY_MAX_RUNS,
  PRODUCT_EVAL_MAX_ENV_ERROR_RATE,
  PRODUCT_EVAL_MAX_EVIDENCE_BYTES,
  PRODUCT_EVAL_MAX_OVERFIT_GAP,
} from "./limits.ts";
import {
  CAPABILITY_DIMENSIONS,
  type BaselineEntry,
  type BaselineReadResult,
  type CapabilityScorecard,
  type DimensionScorecard,
} from "./types.ts";

function upgradeLegacyScorecard(raw: Record<string, unknown>): CapabilityScorecard {
  const dimensions = Array.isArray(raw.dimensions)
    ? (raw.dimensions as DimensionScorecard[])
    : CAPABILITY_DIMENSIONS.map(
        (dimension): DimensionScorecard => ({
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
        }),
      );

  return {
    schemaVersion: 1,
    runId: String(raw.runId),
    baseRef: typeof raw.baseRef === "string" ? raw.baseRef : "unknown",
    baseCommit: typeof raw.baseCommit === "string" ? raw.baseCommit : "unknown",
    headRef: typeof raw.headRef === "string" ? raw.headRef : "unknown",
    headCommit: typeof raw.headCommit === "string" ? raw.headCommit : "unknown",
    graderSha256Base: typeof raw.graderSha256Base === "string" ? raw.graderSha256Base : null,
    graderSha256Head: typeof raw.graderSha256Head === "string" ? raw.graderSha256Head : null,
    graderMatched: typeof raw.graderMatched === "boolean" ? raw.graderMatched : true,
    envErrorRate: typeof raw.envErrorRate === "number" ? raw.envErrorRate : 0,
    publicDelta: typeof raw.publicDelta === "number" ? raw.publicDelta : null,
    holdoutDelta: typeof raw.holdoutDelta === "number" ? raw.holdoutDelta : null,
    overfitGap: typeof raw.overfitGap === "number" ? raw.overfitGap : null,
    dimensions,
    scenarioAggregates: Array.isArray(raw.scenarioAggregates) ? (raw.scenarioAggregates as CapabilityScorecard["scenarioAggregates"]) : [],
    verdict: (typeof raw.verdict === "string" ? raw.verdict : "inconclusive") as CapabilityScorecard["verdict"],
    releaseGatePass: typeof raw.releaseGatePass === "boolean" ? raw.releaseGatePass : false,
    reasons: Array.isArray(raw.reasons) ? raw.reasons.map(String) : [],
  };
}

export function readBaselineLedger(ledgerFile: string): BaselineReadResult {
  if (!existsSync(ledgerFile)) {
    return { entries: [], skippedMalformedLines: 0, upgradedLegacyLines: 0 };
  }

  const text = readFileSync(ledgerFile, "utf8");
  const lines = text.split(/\r?\n/);
  const entries: BaselineEntry[] = [];
  let skippedMalformedLines = 0;
  let upgradedLegacyLines = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      skippedMalformedLines += 1;
      continue;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      skippedMalformedLines += 1;
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    const sc = obj.scorecard;
    if (
      typeof obj.recordedAt !== "string" ||
      !sc ||
      typeof sc !== "object" ||
      Array.isArray(sc) ||
      typeof (sc as Record<string, unknown>).runId !== "string"
    ) {
      skippedMalformedLines += 1;
      continue;
    }

    const scObj = sc as Record<string, unknown>;
    if (obj.schemaVersion !== 1 || scObj.schemaVersion !== 1) {
      upgradedLegacyLines += 1;
      entries.push({
        schemaVersion: 1,
        recordedAt: obj.recordedAt,
        scorecard: upgradeLegacyScorecard(scObj),
      });
    } else {
      entries.push(obj as unknown as BaselineEntry);
    }
  }

  return { entries, skippedMalformedLines, upgradedLegacyLines };
}

export function appendBaselineEntry(
  ledgerFile: string,
  entry: BaselineEntry,
  maxRuns = PRODUCT_EVAL_HISTORY_MAX_RUNS,
): void {
  const dir = dirname(ledgerFile);
  mkdirSync(dir, { recursive: true });
  const existing = readBaselineLedger(ledgerFile);
  const cap = Math.max(1, Math.floor(maxRuns));
  const combined = [...existing.entries, entry].slice(-cap);
  const payload = `${combined.map((item) => JSON.stringify(item)).join("\n")}\n`;
  const tmpFile = join(dir, `.baseline-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmpFile, payload, "utf8");
  renameSync(tmpFile, ledgerFile);
}

function fmtMetricPair(powK: number | null, atK: number | null): string {
  if (powK === null && atK === null) return "n/a";
  const a = powK === null ? "n/a" : powK.toFixed(2);
  const b = atK === null ? "n/a" : atK.toFixed(2);
  return `${a} / ${b}`;
}

function fmtEfficiency(d: DimensionScorecard): string {
  const parts: string[] = [];
  if (d.turnDelta !== null) {
    parts.push(`${d.turnDelta >= 0 ? "+" : ""}${d.turnDelta.toFixed(1)} turns`);
  }
  if (d.cacheReadDelta !== null) {
    const pp = d.cacheReadDelta * 100;
    parts.push(`cacheRead ${pp >= 0 ? "+" : ""}${pp.toFixed(1)}pp`);
  }
  parts.push(d.prefixRegressed ? "prefix REGRESSED" : "prefix stable");
  return parts.join(", ");
}

function clampEvidenceBytes(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= PRODUCT_EVAL_MAX_EVIDENCE_BYTES) return text;
  const suffix = "\n\n... (truncated to 2 MiB evidence cap)\n";
  const budget = PRODUCT_EVAL_MAX_EVIDENCE_BYTES - Buffer.byteLength(suffix, "utf8");
  const buf = Buffer.from(text, "utf8");
  return `${buf.subarray(0, Math.max(0, budget)).toString("utf8")}${suffix}`;
}

export function renderCapabilityReport(
  scorecard: CapabilityScorecard,
  options?: { readonly format?: "markdown" | "terminal" },
): string {
  const format = options?.format ?? "markdown";
  const graderLabel = scorecard.graderSha256Head
    ? `\`${scorecard.graderSha256Head.slice(0, 12)}\` (${scorecard.graderMatched ? "matched" : "MISMATCH"})`
    : "n/a";
  const splitLabel =
    scorecard.overfitGap === null
      ? "n/a"
      : `${scorecard.overfitGap >= 0 ? "+" : ""}${scorecard.overfitGap.toFixed(2)} (limit ${PRODUCT_EVAL_MAX_OVERFIT_GAP.toFixed(2)})`;

  const lines: string[] = [
    format === "terminal"
      ? `Bellwood Product Capability Scorecard (${scorecard.runId})`
      : `# Bellwood Product Capability Scorecard (${scorecard.runId})`,
    "",
    `- Base: \`${scorecard.baseRef}\` (\`${scorecard.baseCommit.slice(0, 8)}\`) | Head: \`${scorecard.headRef}\` (\`${scorecard.headCommit.slice(0, 8)}\`) | Grader: ${graderLabel}`,
    `- Verdict: \`${scorecard.verdict.toUpperCase()}\` | Release Gate: \`${scorecard.releaseGatePass ? "PASS" : "FAIL"}\` | Env Error Rate: \`${(scorecard.envErrorRate * 100).toFixed(1)}%\` (limit \`${(PRODUCT_EVAL_MAX_ENV_ERROR_RATE * 100).toFixed(1)}%\`) | Split Gap: \`${splitLabel}\``,
    "",
    "| Dimension | Suite | Base (pass^k / pass@k) | Head (pass^k / pass@k) | Efficiency Delta | Status |",
    "|---|---|---|---|---|---|",
  ];

  const byDim = new Map(scorecard.dimensions.map((d) => [d.dimension, d]));
  for (const dim of CAPABILITY_DIMENSIONS) {
    const row = byDim.get(dim);
    if (!row) {
      lines.push(`| ${dim} | regression | n/a | n/a | n/a | not_applicable |`);
      continue;
    }
    lines.push(
      `| ${row.dimension} | ${row.suite} | ${fmtMetricPair(row.basePassPowK, row.basePassAtK)} | ${fmtMetricPair(row.headPassPowK, row.headPassAtK)} | ${fmtEfficiency(row)} | ${row.status} |`,
    );
  }

  if (scorecard.reasons.length > 0) {
    lines.push("", "## Gate Reasons", "");
    for (const reason of scorecard.reasons) {
      lines.push(`- ${reason}`);
    }
  }

  if (scorecard.scenarioAggregates.length > 0) {
    lines.push(
      "",
      "## Scenario Breakdown",
      "",
      "| Scenario | Dimension | Split | Base (pass/valid, status) | Head (pass/valid, status) |",
      "|---|---|---|---|---|",
    );
    for (const item of scorecard.scenarioAggregates) {
      const dim = item.head?.dimension ?? item.base?.dimension ?? "unknown";
      const split = item.head?.split ?? item.base?.split ?? "public";
      const bStr = item.base ? `${item.base.nPassed}/${item.base.nValid} (${item.base.status})` : "n/a";
      const hStr = item.head ? `${item.head.nPassed}/${item.head.nValid} (${item.head.status})` : "n/a";
      lines.push(`| ${item.scenarioId} | ${dim} | ${split} | ${bStr} | ${hStr} |`);
    }
  }

  return clampEvidenceBytes(lines.join("\n"));
}
