import { describe, it } from "vitest";

describe("readBuildCommit", () => {
  it.todo("returns the full HEAD commit of a clean checkout");
  it.todo("adds -dirty when a tracked file differs from HEAD");
  it.todo("ignores untracked and git-ignored build output");
  it.todo("throws outside a git checkout");
});

describe("stageDaemonTree", () => {
  it.todo("writes the pruned lockfile next to the staged package.json and installs with STAGED_INSTALL_ARGS");
  it.todo("keeps the pruned pnpm-lock.yaml in the staged daemon directory as the record of shipped versions");
});
