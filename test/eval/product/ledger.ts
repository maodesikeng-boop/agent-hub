// Corruption-tolerant JSONL baseline history ledger and non-collapsed multi-dimension report renderer.
// Invariant: history files stay bounded to PRODUCT_EVAL_HISTORY_MAX_RUNS and rendered output stays within PRODUCT_EVAL_MAX_EVIDENCE_BYTES.
import type { BaselineEntry, BaselineReadResult, CapabilityScorecard } from "./types.ts";

/**
 * Precondition: ledgerFile is a JSONL path (may not exist yet).
 * Postcondition: returns all valid entries, skips corrupt or half-written trailing lines while recording skippedMalformedLines,
 * and upgrades legacy v0 records while recording upgradedLegacyLines.
 */
export function readBaselineLedger(_ledgerFile: string): BaselineReadResult {
  throw new Error("Not implemented");
}

/**
 * Precondition: entry is a valid schemaVersion 1 BaselineEntry.
 * Postcondition: appends entry atomically as a complete JSONL line, preserves prior valid entries even after a torn tail,
 * and prunes the oldest entries so at most maxRuns (default PRODUCT_EVAL_HISTORY_MAX_RUNS) remain.
 */
export function appendBaselineEntry(
  _ledgerFile: string,
  _entry: BaselineEntry,
  _maxRuns?: number,
): void {
  throw new Error("Not implemented");
}

/**
 * Precondition: scorecard is a CapabilityScorecard from evaluateComparison.
 * Postcondition: renders all five dimensions separately alongside verdict, release gate status, env error rate,
 * split gap, and efficiency deltas without collapsing to a single scalar score, bounded by PRODUCT_EVAL_MAX_EVIDENCE_BYTES.
 */
export function renderCapabilityReport(
  _scorecard: CapabilityScorecard,
  _options?: { readonly format?: "markdown" | "terminal" },
): string {
  throw new Error("Not implemented");
}
