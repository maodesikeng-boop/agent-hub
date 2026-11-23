// Run history on the developer machine: one JSON line per run in <bench root>/runs/history.jsonl,
// evidence in <bench root>/runs/<runId>/<flowId>/, and summary.md plus summary.json beside it.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { TESTER_HISTORY_MAX_RUNS } from "./limits.ts";
import type { RunRecord } from "./types.ts";

export const HISTORY_FILE = "history.jsonl";
export const LATEST_DIR = "latest";
/** Run ids sort by time: an ISO timestamp with separators removed, plus the cadence. */
const RUN_ID = /^\d{8}T\d{6}Z-(nightly|rc|pr)$/;

export function newRunId(at: Date, cadence: RunRecord["cadence"]): string {
  return `${at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${cadence}`;
}

function lines(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
}

/**
 * Postcondition: `record` is the last line of `file`, and the file holds at most TESTER_HISTORY_MAX_RUNS lines,
 * dropping the oldest. The write is atomic: a reader never sees a torn line or a half-pruned file.
 */
export function appendRun(file: string, record: RunRecord): void {
  const kept = [...lines(file), JSON.stringify(record)].slice(-TESTER_HISTORY_MAX_RUNS);
  writeFileAtomic.sync(file, `${kept.join("\n")}\n`);
}

/** Postcondition: returns up to `limit` newest records, oldest first. A missing file gives []. A malformed line is skipped and named in `skipped`. */
export function readRuns(file: string, limit: number): { runs: RunRecord[]; skipped: number[] } {
  const runs: RunRecord[] = [];
  const skipped: number[] = [];
  lines(file).forEach((line, i) => {
    try {
      const value = JSON.parse(line) as RunRecord;
      if (typeof value.runId !== "string" || !Array.isArray(value.results)) throw new Error("not a run record");
      runs.push(value);
    } catch {
      skipped.push(i + 1);
    }
  });
  return { runs: limit <= 0 ? [] : runs.slice(-limit), skipped };
}

/** Postcondition: only the newest `keep` run evidence directories under `runsDir` remain; history.jsonl and the latest summary are never deleted. Returns the deleted run ids. */
export function pruneEvidence(runsDir: string, keep: number): string[] {
  if (!existsSync(runsDir)) return [];
  const runs = readdirSync(runsDir)
    .filter((name) => RUN_ID.test(name) && statSync(join(runsDir, name)).isDirectory())
    .sort();
  const doomed = runs.slice(0, Math.max(0, runs.length - Math.max(0, keep)));
  for (const name of doomed) rmSync(join(runsDir, name), { recursive: true, force: true });
  return doomed;
}
