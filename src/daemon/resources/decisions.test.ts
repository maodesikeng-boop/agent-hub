import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RESOURCE_DECISIONS_MAX_ROWS } from "../../shared/limits.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createResourceDecisionsStore } from "./decisions.ts";

let db: Db;

beforeEach(() => {
  db = openTestDb();
});

afterEach(() => {
  db.close();
});

describe("createResourceDecisionsStore", () => {
  it("persists and lists Keep decisions newest first", () => {
    const store = createResourceDecisionsStore(db);
    store.keep("worktree", "10", "uncommitted_changes", 1_000);
    store.keep("git_branch", "1:hub/12-wip", "unmerged_ended_branch", 3_000);
    store.keep("temp_dir", "bw-abc", "orphaned_temp_dir", 2_000);

    expect(store.list()).toEqual([
      { kind: "git_branch", targetKey: "1:hub/12-wip", reason: "unmerged_ended_branch", decidedAt: 3_000 },
      { kind: "temp_dir", targetKey: "bw-abc", reason: "orphaned_temp_dir", decidedAt: 2_000 },
      { kind: "worktree", targetKey: "10", reason: "uncommitted_changes", decidedAt: 1_000 },
    ]);
  });

  it("updates decidedAt and reason when keeping an already-kept target", () => {
    const store = createResourceDecisionsStore(db);
    store.keep("worktree", "42", "untracked_files", 1_000);
    store.keep("worktree", "42", "uncommitted_changes", 5_000);

    expect(store.list()).toEqual([
      { kind: "worktree", targetKey: "42", reason: "uncommitted_changes", decidedAt: 5_000 },
    ]);
  });

  it("evicts the oldest decisions when exceeding RESOURCE_DECISIONS_MAX_ROWS", () => {
    const store = createResourceDecisionsStore(db);
    const total = RESOURCE_DECISIONS_MAX_ROWS + 5;
    for (let i = 1; i <= total; i++) {
      store.keep("worktree", `w-${i}`, "uncommitted_changes", i * 10);
    }

    const rows = store.list();
    expect(rows).toHaveLength(RESOURCE_DECISIONS_MAX_ROWS);
    expect(rows[0]?.targetKey).toBe(`w-${total}`);
    expect(rows.at(-1)?.targetKey).toBe("w-6");
  });

  it("removes a Keep decision on unkeep and returns false when absent", () => {
    const store = createResourceDecisionsStore(db);
    store.keep("worktree", "7", "uncommitted_changes", 1_000);

    expect(store.unkeep("worktree", "7")).toBe(true);
    expect(store.unkeep("worktree", "7")).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it("prunes stored decisions whose targets are absent from liveKeys", () => {
    const store = createResourceDecisionsStore(db);
    store.keep("worktree", "1", "uncommitted_changes", 1_000);
    store.keep("git_branch", "1:hub/a", "unmerged_ended_branch", 2_000);
    store.keep("process", "99:s1:abc", "leaked_process", 3_000);

    const pruned = store.pruneMissing(new Set(["git_branch:1:hub/a"]));
    expect(pruned).toBe(2);
    expect(store.list().map((r) => `${r.kind}:${r.targetKey}`)).toEqual(["git_branch:1:hub/a"]);
  });
});
