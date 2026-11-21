import { describe, it } from "vitest";

describe("createBranchCleanup", () => {
  it.todo("deletes managed hub/* branches that are ancestor-merged or squash-merged after mergedRetentionMs when no worktree checks them out");
  it.todo("enforces maxMergedKept per repository by deleting the oldest merged managed branches beyond the cap");
  it.todo("never deletes main, master, HEAD, checked-out worktree branches, active Worker branches, or branches in active Task Graphs");
  it.todo("surfaces ended unmerged managed branches past unmergedHoldMs as held items instead of deleting them");
  it.todo("force-deletes a held managed branch on explicit discardBranch after re-verifying it is inactive and unchecked-out");
  it.todo("rejects discardBranch for protected or non-managed branches");
});
