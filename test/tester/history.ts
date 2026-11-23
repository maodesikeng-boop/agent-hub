// Run history on the developer machine: one JSON line per run in <bench root>/runs/history.jsonl,
// evidence in <bench root>/runs/<runId>/<flowId>/, and summary.md plus summary.json beside it.
import type { RunRecord } from "./types.ts";

/**
 * Postcondition: `record` is the last line of `file`, and the file holds at most TESTER_HISTORY_MAX_RUNS lines,
 * dropping the oldest. The write is atomic: a reader never sees a torn line or a half-pruned file.
 */
export function appendRun(file: string, record: RunRecord): void {
  throw new Error("Not implemented");
}

/** Postcondition: returns up to `limit` newest records, oldest first. A missing file gives []. A malformed line is skipped and named in `skipped`. */
export function readRuns(file: string, limit: number): { runs: RunRecord[]; skipped: number[] } {
  throw new Error("Not implemented");
}

/** Postcondition: only the newest `keep` run evidence directories under `runsDir` remain; history.jsonl and the latest summary are never deleted. Returns the deleted run ids. */
export function pruneEvidence(runsDir: string, keep: number): string[] {
  throw new Error("Not implemented");
}
