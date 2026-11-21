import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOURCES_INSPECT_TTL_MS } from "../../shared/limits.ts";
import type { HeldBranchResource, HeldWorktreeResource } from "../../shared/resources.ts";
import { createSessionTmpStore } from "../session-tmp.ts";
import { migrate, openDatabase, type Db } from "../store/index.ts";
import { createResourceDecisionsStore } from "./decisions.ts";
import {
  createResourceInspector,
  measureDatabaseUsage,
  measureDirectoryUsage,
  type ProcessResourcePort,
  type ResourceInspectorDeps,
  type WorktreeResourcePort,
} from "./inspector.ts";
import type { BranchCleanup } from "./branch-cleanup.ts";

let root: string;
let dbFile: string;
let db: Db;

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-inspector-")));
  dbFile = join(root, "state", "hub.sqlite");
  mkdirSync(join(root, "state"), { recursive: true });
  db = openDatabase(dbFile);
  migrate(db);
});

afterEach(() => {
  try {
    db.close();
  } catch {
  }
  rmSync(root, { recursive: true, force: true });
});

function makePaths() {
  const stateDir = join(root, "state");
  const logsDir = join(stateDir, "logs");
  return {
    dbFile,
    stateDir,
    worktreesDir: join(root, "worktrees"),
    sentFilesDir: join(root, "sent-files"),
    uploadsDir: join(root, "uploads"),
    logsDir,
    setupLogsDir: join(logsDir, "setup"),
    syncBackupsDir: join(root, "backups", "sync"),
    launchDir: join(stateDir, "launch"),
    pmMemoryDir: join(stateDir, "pm-memory"),
    pmHomeDir: join(root, "pm-home"),
  };
}

describe("createResourceInspector", () => {
  it("measures database file size, WAL size, freelist bytes, and per-table usage via dbstat with fallback when dbstat is unavailable", () => {
    db.run("INSERT INTO health (module, consecutive_failures, updated_at) VALUES ('driver', 0, 1000)");
    const usage = measureDatabaseUsage(db, dbFile);
    expect(usage.fileBytes).toBeGreaterThan(0);
    expect(usage.dbstatAvailable).toBe(true);
    const health = usage.tables.find((t) => t.table === "health");
    expect(health?.rows).toBe(1);
    expect(typeof health?.bytes).toBe("number");

    const fakeDb: Db = {
      ...db,
      all<T>(sql: string, ...params: Parameters<Db["all"]> extends [string, ...infer P] ? P : never): T[] {
        if (sql.includes("FROM dbstat")) throw new Error("no such table: dbstat");
        return db.all<T>(sql, ...params);
      },
    };
    const fallback = measureDatabaseUsage(fakeDb, dbFile);
    expect(fallback.dbstatAvailable).toBe(false);
    expect(fallback.tables.find((t) => t.table === "health")).toMatchObject({ rows: 1, bytes: null });
  });

  it("measures directory sizes asynchronously without following symlinks and stops cleanly at maxEntries or timeoutMs", async () => {
    const dir = join(root, "scan-dir");
    const outside = join(root, "outside");
    mkdirSync(join(dir, "sub"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(dir, "a.bin"), "12345");
    writeFileSync(join(dir, "sub", "b.bin"), "1234567890");
    writeFileSync(join(outside, "big.bin"), "x".repeat(5_000));
    symlinkSync(outside, join(dir, "link-out"));

    const full = await measureDirectoryUsage(dir);
    expect(full).toEqual({ bytes: 15, fileCount: 2, truncated: false });

    const capped = await measureDirectoryUsage(dir, { maxEntries: 1 });
    expect(capped.truncated).toBe(true);

    const aborted = new AbortController();
    aborted.abort();
    expect((await measureDirectoryUsage(dir, { signal: aborted.signal })).truncated).toBe(true);
    expect(await measureDirectoryUsage(join(root, "missing"))).toEqual({ bytes: 0, fileCount: 0, truncated: false });
  });

  it("coalesces concurrent inspect() calls and serves cached results within RESOURCES_INSPECT_TTL_MS unless refresh is true", async () => {
    let nowMs = 10_000;
    let resolveWorktrees!: (items: HeldWorktreeResource[]) => void;
    const inspectHeldWorktrees = vi.fn(
      () => new Promise<HeldWorktreeResource[]>((resolve) => {
        resolveWorktrees = resolve;
      }),
    );
    const deps: ResourceInspectorDeps = {
      db,
      paths: makePaths(),
      decisions: createResourceDecisionsStore(db, () => nowMs),
      worktrees: { inspectHeldWorktrees, discardWorktree: vi.fn(async () => ({ removedBytes: 0 })), runOnce: vi.fn(async () => []) },
      branches: { inspect: vi.fn(async () => ({ held: [], repos: [] })), runOnce: vi.fn(async () => ({ deleted: [], held: [], repos: [] })), discardBranch: vi.fn(async () => {}) },
      sessionTmp: createSessionTmpStore({ ledgerFile: join(root, "state", "session-tmp.json"), tmpRoot: join(root, "tmp") }),
      processes: { trackedCount: 1, listLeakedTaggedProcesses: vi.fn(async () => []), reapTaggedProcess: vi.fn(async () => false) },
      runDbRetention: vi.fn(async () => ({ rows: 0, pages: 0 })),
      runFileCleanup: vi.fn(async () => ({ removedFiles: 0 })),
      activeSessionIds: () => new Set(),
      now: () => nowMs,
    };

    const inspector = createResourceInspector(deps);
    const p1 = inspector.inspect();
    const p2 = inspector.inspect();
    await vi.waitFor(() => expect(inspectHeldWorktrees).toHaveBeenCalledTimes(1));
    resolveWorktrees([]);
    const [s1, s2] = await Promise.all([p1, p2]);
    expect(s1).toBe(s2);

    const s3 = await inspector.inspect();
    expect(s3).toBe(s1);
    expect(inspectHeldWorktrees).toHaveBeenCalledTimes(1);

    const pRefresh = inspector.inspect({ refresh: true });
    await vi.waitFor(() => expect(inspectHeldWorktrees).toHaveBeenCalledTimes(2));
    resolveWorktrees([]);
    await pRefresh;

    nowMs += RESOURCES_INSPECT_TTL_MS + 1;
    const pExpired = inspector.inspect();
    await vi.waitFor(() => expect(inspectHeldWorktrees).toHaveBeenCalledTimes(3));
    resolveWorktrees([]);
    await pExpired;
  });

  it("merges held worktrees, unmerged branches, orphan temp dirs, and leaked tagged processes with stored Keep decisions", async () => {
    const tmpRoot = join(root, "tmp");
    const sessionTmp = createSessionTmpStore({ ledgerFile: join(root, "state", "session-tmp.json"), tmpRoot });
    const orphanDir = sessionTmp.allocate(88);
    writeFileSync(join(orphanDir, "x.tmp"), "1234");
    const activeDir = sessionTmp.allocate(99);
    writeFileSync(join(activeDir, "y.tmp"), "1234");

    const decisions = createResourceDecisionsStore(db);
    decisions.keep("worktree", "5", "uncommitted_changes", 5_000);
    decisions.keep("worktree", "999", "untracked_files", 4_000);

    const heldWt: HeldWorktreeResource = {
      kind: "worktree",
      targetKey: "5",
      reason: "uncommitted_changes",
      label: "#5 Fix",
      projectId: 1,
      projectName: "demo",
      bytes: 1200,
      detectedAt: 2_000,
      samplePaths: ["a.ts"],
      keptAt: null,
      workerId: 5,
      branch: "hub/5-fix",
      worktreePath: join(root, "worktrees", "1", "5"),
      dirtyCount: 1,
    };
    const heldBranch: HeldBranchResource = {
      kind: "git_branch",
      targetKey: "1:hub/6-old",
      reason: "unmerged_ended_branch",
      label: "hub/6-old",
      projectId: 1,
      projectName: "demo",
      bytes: null,
      detectedAt: 1_000,
      samplePaths: [],
      keptAt: null,
      workerId: 6,
      repoFolder: join(root, "repo"),
      branch: "hub/6-old",
      commitsAhead: 2,
    };

    const inspector = createResourceInspector({
      db,
      paths: makePaths(),
      decisions,
      worktrees: { inspectHeldWorktrees: async () => [heldWt], discardWorktree: async () => ({ removedBytes: 0 }), runOnce: async () => [] },
      branches: { inspect: async () => ({ held: [heldBranch], repos: [] }), runOnce: async () => ({ deleted: [], held: [], repos: [] }), discardBranch: async () => {} },
      sessionTmp,
      processes: {
        trackedCount: 2,
        listLeakedTaggedProcesses: async () => [
          { pid: 4321, sessionId: 88, tag: "s88:abc", command: "node fake-worker.js" },
          { pid: 4322, sessionId: 99, tag: "s99:abc", command: "node active-worker.js" },
        ],
        reapTaggedProcess: async () => true,
      },
      runDbRetention: async () => ({ rows: 0, pages: 0 }),
      runFileCleanup: async () => ({ removedFiles: 0 }),
      activeSessionIds: () => new Set([99]),
    });

    const snap = await inspector.inspect();
    expect(snap.held.map((h) => `${h.kind}:${h.targetKey}`).sort()).toEqual([
      `git_branch:1:hub/6-old`,
      `process:4321:s88:abc`,
      `temp_dir:${orphanDir.split("/").at(-1)}`,
      `worktree:5`,
    ]);
    expect(snap.held.find((h) => h.kind === "worktree")?.keptAt).toBe(5_000);
    expect(snap.attentionCount).toBe(3);
    expect(snap.processes).toEqual({ trackedCount: 2, leakedCount: 1 });
    expect(decisions.list().map((d) => d.targetKey)).toEqual(["5"]);
  });

  it("applies keep, unkeep, and validated discard decisions, invalidates cache, and rejects unknown or unmanaged target keys", async () => {
    let wtPresent = true;
    const discardWorktree = vi.fn(async () => {
      wtPresent = false;
      return { removedBytes: 4096 };
    });
    const heldWt: HeldWorktreeResource = {
      kind: "worktree",
      targetKey: "7",
      reason: "uncommitted_changes",
      label: "#7 Edit",
      projectId: 1,
      projectName: "demo",
      bytes: 4096,
      detectedAt: 1_000,
      samplePaths: ["src/a.ts"],
      keptAt: null,
      workerId: 7,
      branch: "hub/7-edit",
      worktreePath: join(root, "worktrees", "1", "7"),
      dirtyCount: 1,
    };
    const inspector = createResourceInspector({
      db,
      paths: makePaths(),
      decisions: createResourceDecisionsStore(db),
      worktrees: { inspectHeldWorktrees: async () => (wtPresent ? [heldWt] : []), discardWorktree, runOnce: async () => [] },
      branches: { inspect: async () => ({ held: [], repos: [] }), runOnce: async () => ({ deleted: [], held: [], repos: [] }), discardBranch: async () => {} },
      sessionTmp: createSessionTmpStore({ ledgerFile: join(root, "state", "session-tmp.json"), tmpRoot: join(root, "tmp") }),
      processes: { trackedCount: 0, listLeakedTaggedProcesses: async () => [], reapTaggedProcess: async () => false },
      runDbRetention: async () => ({ rows: 0, pages: 0 }),
      runFileCleanup: async () => ({ removedFiles: 0 }),
      activeSessionIds: () => new Set(),
    });

    await expect(inspector.decide({ kind: "worktree", targetKey: "999", action: "discard" })).rejects.toThrow();

    const kept = await inspector.decide({ kind: "worktree", targetKey: "7", action: "keep" });
    expect(kept.snapshot.attentionCount).toBe(0);
    expect(kept.snapshot.held[0]?.keptAt).not.toBeNull();

    const unkept = await inspector.decide({ kind: "worktree", targetKey: "7", action: "unkeep" });
    expect(unkept.snapshot.attentionCount).toBe(1);

    const discarded = await inspector.decide({ kind: "worktree", targetKey: "7", action: "discard", deleteBranch: true });
    expect(discardWorktree).toHaveBeenCalledWith(7, { deleteBranch: true });
    expect(discarded.removedBytes).toBe(4096);
    expect(discarded.snapshot.held).toEqual([]);
  });

  it("runs safe automatic cleanups on runCleanup() without deleting held unsaved work", async () => {
    const tmpRoot = join(root, "tmp");
    const sessionTmp = createSessionTmpStore({ ledgerFile: join(root, "state", "session-tmp.json"), tmpRoot });
    sessionTmp.allocate(50);

    const discardWorktree = vi.fn(async () => ({ removedBytes: 0 }));
    const worktrees: WorktreeResourcePort = {
      inspectHeldWorktrees: async () => [],
      discardWorktree,
      runOnce: vi.fn(async () => [1, 2]),
    };
    const branches: BranchCleanup = {
      inspect: async () => ({ held: [], repos: [] }),
      runOnce: vi.fn(async () => ({ deleted: [{ repoFolder: "/r", branch: "hub/1-a" }], held: [], repos: [] })),
      discardBranch: vi.fn(async () => {}),
    };
    const processes: ProcessResourcePort = {
      trackedCount: 1,
      listLeakedTaggedProcesses: async () => [{ pid: 777, sessionId: 50, tag: "s50:xyz", command: "node leaked.js" }],
      reapTaggedProcess: vi.fn(async () => true),
    };

    const inspector = createResourceInspector({
      db,
      paths: makePaths(),
      decisions: createResourceDecisionsStore(db),
      worktrees,
      branches,
      sessionTmp,
      processes,
      runDbRetention: vi.fn(async () => ({ rows: 120, pages: 4 })),
      runFileCleanup: vi.fn(async () => ({ removedFiles: 3 })),
      activeSessionIds: () => new Set(),
    });

    const res = await inspector.runCleanup();
    expect(discardWorktree).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      purgedDbRows: 120,
      reclaimedDbPages: 4,
      removedFiles: 3,
      removedWorktrees: 2,
      removedBranches: 1,
      removedTempDirs: 1,
      reapedProcesses: 1,
    });
  });

  it("aborts in-flight scans on close() without touching the database after shutdown starts", async () => {
    let releaseScan!: () => void;
    const decisions = createResourceDecisionsStore(db);
    const pruneSpy = vi.spyOn(decisions, "pruneMissing");
    const inspector = createResourceInspector({
      db,
      paths: makePaths(),
      decisions,
      worktrees: {
        inspectHeldWorktrees: () => new Promise<HeldWorktreeResource[]>((resolve) => {
          releaseScan = () => resolve([]);
        }),
        discardWorktree: async () => ({ removedBytes: 0 }),
        runOnce: async () => [],
      },
      branches: { inspect: async () => ({ held: [], repos: [] }), runOnce: async () => ({ deleted: [], held: [], repos: [] }), discardBranch: async () => {} },
      sessionTmp: createSessionTmpStore({ ledgerFile: join(root, "state", "session-tmp.json"), tmpRoot: join(root, "tmp") }),
      processes: { trackedCount: 0, listLeakedTaggedProcesses: async () => [], reapTaggedProcess: async () => false },
      runDbRetention: async () => ({ rows: 0, pages: 0 }),
      runFileCleanup: async () => ({ removedFiles: 0 }),
      activeSessionIds: () => new Set(),
    });

    const pending = inspector.inspect();
    inspector.close();
    db.close();
    releaseScan();
    await expect(pending).rejects.toThrow();
    expect(pruneSpy).not.toHaveBeenCalled();
  });
});
