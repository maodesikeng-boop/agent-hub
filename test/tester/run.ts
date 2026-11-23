// Orchestrates one tester run: guards, preflight, flows grouped by local CLI mode, verdicts, history, summary.
import type { RunSummary } from "./report.ts";
import type { Cadence, RunRecord } from "./types.ts";

export interface RunOptions {
  cadence: Cadence;
  benchConfigPath: string;
  /** Checkout the local test computer runs; the remote is deployed to the same commit for pr and rc runs. */
  codeDir: string;
  flowIds?: readonly string[];
  changedPaths?: readonly string[];
}

/**
 * Postcondition: one RunRecord appended to history, its evidence under runs/<runId>/, and summary.md plus summary.json
 * written beside it and copied to runs/latest/. Runs flows one at a time within TESTER_NIGHTLY_BUDGET_MS; a flow past its
 * own timeoutMs is aborted and recorded as product_fail with reason "timeout" unless preflight already explained it.
 * Throws ProductionGuardError before touching any instance when the config fails the production guards.
 */
export async function runTester(options: RunOptions): Promise<{ record: RunRecord; summary: RunSummary }> {
  throw new Error("Not implemented");
}
