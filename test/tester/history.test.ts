import { describe, it } from "vitest";

describe("appendRun", () => {
  it.todo("appends the record as the last line");
  it.todo("keeps at most TESTER_HISTORY_MAX_RUNS lines by dropping the oldest");
  it.todo("never leaves a torn file when the process dies mid-write");
});

describe("readRuns", () => {
  it.todo("returns up to the limit of newest records, oldest first");
  it.todo("returns an empty list for a missing file");
  it.todo("skips a malformed line and reports its line number");
});

describe("pruneEvidence", () => {
  it.todo("keeps only the newest evidence directories");
  it.todo("never deletes history.jsonl or runs/latest");
});
