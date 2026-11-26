import { describe, expect, it } from "vitest";
import { CARRIED_STAMP_PREFIX, GATE_STATUS_CREATOR, decideGateStatus, decideStampCarry, type CommitStatus, type PrDiffFile } from "./review-stamp-gate.ts";

const OLD_SHA = "c".repeat(40);
const REVIEWER: CommitStatus = { state: "success", description: "Independent Bellwood review: PASS on this commit", creator: "maodesikeng-boop" };

function file(filename: string, patch: string | null, extra: Partial<PrDiffFile> = {}): PrDiffFile {
  return { filename, status: "modified", previousFilename: null, patch, ...extra };
}

const BEFORE = [file("src/a.ts", "@@ -10,3 +10,4 @@ export function a() {\n   one();\n+  two();\n   three();\n")];
// Same PR change after main added lines above it: hunk header and context moved, added and removed lines did not.
const AFTER_CLEAN = [file("src/a.ts", "@@ -14,3 +14,4 @@ export function a() {\n   oneRenamedOnMain();\n+  two();\n   three();\n")];

describe("decideStampCarry", () => {
  const base = { previousSha: OLD_SHA, previousStamp: REVIEWER, previousDiff: BEFORE, currentDiff: AFTER_CLEAN, diffTruncated: false };

  it("carries a reviewer's success when the update only merged main", () => {
    const decision = decideStampCarry(base);
    expect(decision.kind).toBe("carry");
    if (decision.kind === "carry") {
      expect(decision.description.startsWith(CARRIED_STAMP_PREFIX)).toBe(true);
      expect(decision.description).toContain(OLD_SHA.slice(0, 7));
      expect(decision.description.length).toBeLessThanOrEqual(140);
    }
  });

  it("carries again from a stamp the gate itself carried, so two clean updates in a row keep it", () => {
    const carried: CommitStatus = { state: "success", description: `${CARRIED_STAMP_PREFIX}${"d".repeat(7)}`, creator: GATE_STATUS_CREATOR };
    expect(decideStampCarry({ ...base, previousStamp: carried }).kind).toBe("carry");
  });

  it("does not carry when the PR's own lines changed, as after a conflict resolution", () => {
    const edited = [file("src/a.ts", "@@ -14,3 +14,4 @@\n   one();\n+  twoEdited();\n   three();\n")];
    expect(decideStampCarry({ ...base, currentDiff: edited }).kind).toBe("no-carry");
  });

  it("does not carry when a file was added, dropped, renamed, or changed status", () => {
    expect(decideStampCarry({ ...base, currentDiff: [...AFTER_CLEAN, file("src/b.ts", "@@ -0,0 +1 @@\n+x\n", { status: "added" })] }).kind).toBe("no-carry");
    expect(decideStampCarry({ ...base, currentDiff: [] }).kind).toBe("no-carry");
    expect(decideStampCarry({ ...base, currentDiff: [file("src/a.ts", AFTER_CLEAN[0]!.patch, { status: "renamed", previousFilename: "src/old.ts" })] }).kind).toBe("no-carry");
  });

  it("does not carry without a reviewer success on the previous head", () => {
    expect(decideStampCarry({ ...base, previousStamp: null }).kind).toBe("no-carry");
    expect(decideStampCarry({ ...base, previousStamp: { ...REVIEWER, state: "failure" } }).kind).toBe("no-carry");
    expect(decideStampCarry({ ...base, previousStamp: { state: "pending", description: "Needs an independent review PASS on this commit: x", creator: GATE_STATUS_CREATOR } }).kind).toBe("no-carry");
    expect(decideStampCarry({ ...base, previousStamp: { state: "success", description: "No high-risk paths changed; review stamp not required", creator: GATE_STATUS_CREATOR } }).kind).toBe("no-carry");
  });

  it("fails closed on a truncated diff or a file GitHub sent without a patch", () => {
    expect(decideStampCarry({ ...base, diffTruncated: true }).kind).toBe("no-carry");
    expect(decideStampCarry({ ...base, previousDiff: [file("src/a.ts", null)], currentDiff: [file("src/a.ts", null)] }).kind).toBe("no-carry");
  });
});

describe("decideGateStatus with a carried stamp", () => {
  it("keeps a success the gate carried instead of re-judging it by path on a re-run", () => {
    const current: CommitStatus = { state: "success", description: `${CARRIED_STAMP_PREFIX}${OLD_SHA.slice(0, 7)}`, creator: GATE_STATUS_CREATOR };
    expect(decideGateStatus({ matched: ["migrations/0055_a.sql"], filesTruncated: false, current }).kind).toBe("keep");
  });

  it("still re-judges the gate's own path-based success, as before", () => {
    const current: CommitStatus = { state: "success", description: "No high-risk paths changed; review stamp not required", creator: GATE_STATUS_CREATOR };
    expect(decideGateStatus({ matched: ["migrations/0055_a.sql"], filesTruncated: false, current })).toMatchObject({ kind: "post", state: "pending" });
  });
});
