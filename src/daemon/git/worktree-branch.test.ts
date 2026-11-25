import { describe, it } from "vitest";

describe("readWorktreeBranch", () => {
  it.todo("reads the checked-out local branch from a linked git worktree .git file and HEAD");
  it.todo("reads the checked-out local branch when .git is a regular repository directory");
  it.todo("returns the new branch name immediately after git branch -m renames the worktree branch");
  it.todo("returns null when the worktree is on a detached HEAD");
  it.todo("returns null when the worktree path does not exist or is not a git worktree");
  it.todo("handles relative gitdir paths and Windows backslash separators in .git files");
});

describe("createWorktreeBranchProbe", () => {
  it.todo("returns the cached branch when the HEAD file stat fingerprint is unchanged");
  it.todo("invalidates and reads the new branch as soon as HEAD changes after a branch rename");
  it.todo("bounds cached entries to WORKTREE_BRANCH_CACHE_MAX using LRU eviction");
  it.todo("clears one path or all paths when invalidate() is called");
});
