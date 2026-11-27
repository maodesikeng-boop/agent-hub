// Unified five-dimension scenario catalog, external holdout loader, and scale-safe ledger fact extractor.
// Invariant: orchestration scenarios derive directly from test/eval/scenarios.ts with no hand-synced duplicate table.
import type {
  EvalDimensionFacts,
  EvalScenarioSpec,
  EvalSelectionFilter,
  ScaleSafeFactsInput,
} from "./types.ts";

/**
 * Postcondition: returns all built-in public scenarios spanning all five CAPABILITY_DIMENSIONS,
 * wrapping every scenario from test/eval/scenarios.ts under the orchestration dimension.
 */
export function listProductEvalScenarios(): readonly EvalScenarioSpec[] {
  throw new Error("Not implemented");
}

/**
 * Precondition: filter specifies any combination of tiers, dimensions, suites, splits, gateLevels, changedPaths, or ids.
 * Postcondition: returns matching scenarios in deterministic catalog order; throws Error on unknown explicit id.
 */
export function selectEvalScenarios(
  _filter: EvalSelectionFilter,
  _catalog?: readonly EvalScenarioSpec[],
): EvalScenarioSpec[] {
  throw new Error("Not implemented");
}

/**
 * Precondition: holdoutDir is a directory outside the repository root containing JSON scenario files marked split: "holdout".
 * Postcondition: validates each file, rejects non-holdout or malformed specs with Error, and returns sorted EvalScenarioSpec entries.
 */
export function loadHoldoutScenarios(_holdoutDir: string): EvalScenarioSpec[] {
  throw new Error("Not implemented");
}

/**
 * Precondition: input.dbFile points to a Bellwood SQLite database; maxRows defaults to PRODUCT_EVAL_LEDGER_SCAN_MAX_ROWS.
 * Postcondition: reads bounded worker, message, step-log, turns (including interrupted count), and router_commands facts
 * for one-month ledger volumes, degrades cleanly when legacy ledgers lack newer tables, tolerates corrupt JSON meta columns
 * by incrementing malformedMetaCount, and sets truncated: true if row counts exceed maxRows.
 */
export function extractScaleSafeFacts(_input: ScaleSafeFactsInput): EvalDimensionFacts {
  throw new Error("Not implemented");
}
