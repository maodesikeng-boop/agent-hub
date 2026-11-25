import { describe, it } from "vitest";

describe("listWorktreeBranchTargets", () => {
  it.todo("returns distinct non-review worktree paths for a PM, single Worker, or Task Graph scope");
  it.todo("excludes main-folder Workers and detached review Workers");
});

describe("syncWorktreeBranchIn", () => {
  it.todo("updates workers.branch for all non-review Workers sharing a renamed worktree path");
  it.todo("updates task_graph_steps.artifact_json branch fields and emits task_graph.updated when changed");
  it.todo("leaves review_json targets and unrelated worktree branches unchanged");
  it.todo("returns empty id lists and emits no changes when the ledger already matches actualBranch");
  it.todo("lets downstream hub graph show, worker list, worker show, worker start, and detached review checkout use the renamed branch");
});
