import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendRun, HISTORY_FILE, LATEST_DIR, newRunId, pruneEvidence, readRuns } from "./history.ts";
import { TESTER_HISTORY_MAX_RUNS } from "./limits.ts";
import type { RunRecord } from "./types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "tester-history-"));
  dirs.push(dir);
  return dir;
}

const record = (n: number): RunRecord => ({ runId: `r${n}`, cadence: "nightly", startedAt: "", finishedAt: "", commits: {}, preflight: { available: [], problems: [], coverage: [] }, results: [] });

describe("appendRun", () => {
  it("appends the record as the last line", () => {
    const file = join(scratch(), HISTORY_FILE);
    appendRun(file, record(1));
    appendRun(file, record(2));
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines.map((l) => (JSON.parse(l) as RunRecord).runId)).toEqual(["r1", "r2"]);
  });

  it("keeps at most TESTER_HISTORY_MAX_RUNS lines by dropping the oldest", () => {
    const file = join(scratch(), HISTORY_FILE);
    for (let i = 0; i < TESTER_HISTORY_MAX_RUNS + 3; i++) appendRun(file, record(i));
    const runs = readRuns(file, Number.MAX_SAFE_INTEGER).runs;
    expect(runs).toHaveLength(TESTER_HISTORY_MAX_RUNS);
    expect(runs[0]!.runId).toBe("r3");
    expect(runs.at(-1)!.runId).toBe(`r${TESTER_HISTORY_MAX_RUNS + 2}`);
  });

  it("never leaves a torn file when the process dies mid-write", () => {
    const dir = scratch();
    const file = join(dir, HISTORY_FILE);
    appendRun(file, record(1));
    appendRun(file, record(2));
    expect(readdirSync(dir)).toEqual([HISTORY_FILE]);
    expect(readFileSync(file, "utf8").endsWith("}\n")).toBe(true);
  });
});

describe("readRuns", () => {
  it("returns up to the limit of newest records, oldest first", () => {
    const file = join(scratch(), HISTORY_FILE);
    for (let i = 1; i <= 5; i++) appendRun(file, record(i));
    expect(readRuns(file, 2).runs.map((r) => r.runId)).toEqual(["r4", "r5"]);
  });

  it("returns an empty list for a missing file", () => {
    expect(readRuns(join(scratch(), HISTORY_FILE), 10)).toEqual({ runs: [], skipped: [] });
  });

  it("skips a malformed line and reports its line number", () => {
    const file = join(scratch(), HISTORY_FILE);
    appendRun(file, record(1));
    appendFileSync(file, '{"torn": \n{"runId": 7}\n');
    appendFileSync(file, `${JSON.stringify(record(2))}\n`);
    expect(readRuns(file, 10)).toEqual({ runs: [record(1), record(2)], skipped: [2, 3] });
  });
});

describe("pruneEvidence", () => {
  const runDir = (root: string, at: number) => {
    const id = newRunId(new Date(Date.UTC(2026, 10, 1, 0, 0, at)), "nightly");
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(join(root, id, "summary.md"), "x");
    return id;
  };

  it("keeps only the newest evidence directories", () => {
    const root = scratch();
    const ids = [1, 2, 3, 4].map((s) => runDir(root, s));
    expect(pruneEvidence(root, 2)).toEqual(ids.slice(0, 2));
    expect(readdirSync(root).sort()).toEqual(ids.slice(2));
  });

  it("never deletes history.jsonl or runs/latest", () => {
    const root = scratch();
    runDir(root, 1);
    appendRun(join(root, HISTORY_FILE), record(1));
    mkdirSync(join(root, LATEST_DIR));
    pruneEvidence(root, 0);
    expect(existsSync(join(root, HISTORY_FILE))).toBe(true);
    expect(existsSync(join(root, LATEST_DIR))).toBe(true);
  });
});
