import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addWorktree } from "../git/index.ts";
import {
  createBranchCleanup,
  type BranchCleanupLedger,
  type ManagedBranchProject,
  type ManagedBranchWorkerRef,
} from "./branch-cleanup.ts";

let root: string;
let repo: string;
let emptyGitConfig: string;
let nowMs: number;
const T0 = 1_760_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: emptyGitConfig, GIT_CONFIG_SYSTEM: emptyGitConfig },
    },
  ).trim();
}

function branchExists(branch: string): boolean {
  return git(repo, "branch", "--list", branch) !== "";
}

function createCommitOnBranch(branch: string, fileName: string, content: string): string {
  git(repo, "checkout", "-b", branch);
  writeFileSync(join(repo, fileName), content);
  git(repo, "add", fileName);
  git(repo, "commit", "-q", "-m", `add ${fileName}`);
  const sha = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "main");
  return sha;
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-branch-cleanup-")));
  emptyGitConfig = join(root, ".empty-gitconfig");
  writeFileSync(emptyGitConfig, "");
  repo = join(root, "repo");
  git(root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "README.md"), "init\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "init");
  nowMs = T0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeLedger(workers: ManagedBranchWorkerRef[], projects?: ManagedBranchProject[]): BranchCleanupLedger {
  const activeProjects = projects ?? [{ projectId: 1, projectName: "demo", repoFolder: repo }];
  return {
    listActiveProjectRepos: () => activeProjects,
    listManagedBranchWorkers: (projectId) => workers.filter((w) => w.projectId === projectId),
  };
}

describe("createBranchCleanup", () => {
  it("deletes managed hub/* branches that are ancestor-merged or squash-merged after mergedRetentionMs when no worktree checks them out", async () => {
    const base = git(repo, "rev-parse", "HEAD");
    createCommitOnBranch("hub/1-ff", "ff.txt", "ff\n");
    git(repo, "merge", "--ff-only", "hub/1-ff");

    createCommitOnBranch("hub/2-squash", "sq.txt", "squash line\n");
    git(repo, "merge", "--squash", "hub/2-squash");
    git(repo, "commit", "-q", "-m", "squash hub/2-squash");

    createCommitOnBranch("hub/3-recent", "recent.txt", "recent\n");
    git(repo, "merge", "--ff-only", "hub/3-recent");

    const workers: ManagedBranchWorkerRef[] = [
      { workerId: 1, projectId: 1, branch: "hub/1-ff", baseCommit: base, status: "ended", inActiveGraph: false, endedAt: T0 - 2 * DAY_MS },
      { workerId: 2, projectId: 1, branch: "hub/2-squash", baseCommit: base, status: "ended", inActiveGraph: false, endedAt: T0 - 2 * DAY_MS },
      { workerId: 3, projectId: 1, branch: "hub/3-recent", baseCommit: base, status: "ended", inActiveGraph: false, endedAt: T0 - 1_000 },
    ];
    const cleanup = createBranchCleanup({ ledger: makeLedger(workers), log: () => {}, now: () => nowMs });
    const result = await cleanup.runOnce();

    expect(result.deleted.map((d) => d.branch).sort()).toEqual(["hub/1-ff", "hub/2-squash"]);
    expect(branchExists("hub/1-ff")).toBe(false);
    expect(branchExists("hub/2-squash")).toBe(false);
    expect(branchExists("hub/3-recent")).toBe(true);
    expect(result.repos[0]?.mergedCleanableCount).toBe(1);
  });

  it("enforces maxMergedKept per repository by deleting the oldest merged managed branches beyond the cap", async () => {
    const base = git(repo, "rev-parse", "HEAD");
    const workers: ManagedBranchWorkerRef[] = [];
    for (let i = 1; i <= 4; i++) {
      const branch = `hub/${i}-cap`;
      createCommitOnBranch(branch, `f${i}.txt`, `v${i}\n`);
      git(repo, "merge", "--ff-only", branch);
      workers.push({
        workerId: i,
        projectId: 1,
        branch,
        baseCommit: base,
        status: "ended",
        inActiveGraph: false,
        endedAt: T0 - (5 - i) * 10_000,
      });
    }
    const cleanup = createBranchCleanup({
      ledger: makeLedger(workers),
      log: () => {},
      now: () => nowMs,
      mergedRetentionMs: DAY_MS,
      maxMergedKept: 2,
    });
    const result = await cleanup.runOnce();

    expect(result.deleted.map((d) => d.branch)).toEqual(["hub/1-cap", "hub/2-cap"]);
    expect(branchExists("hub/1-cap")).toBe(false);
    expect(branchExists("hub/2-cap")).toBe(false);
    expect(branchExists("hub/3-cap")).toBe(true);
    expect(branchExists("hub/4-cap")).toBe(true);
  });

  it("never deletes main, master, HEAD, checked-out worktree branches, active Worker branches, or branches in active Task Graphs", async () => {
    const base = git(repo, "rev-parse", "HEAD");
    git(repo, "branch", "feature/user-owned");

    createCommitOnBranch("hub/10-open", "open.txt", "open\n");
    git(repo, "merge", "--ff-only", "hub/10-open");

    createCommitOnBranch("hub/11-graph", "graph.txt", "graph\n");
    git(repo, "merge", "--ff-only", "hub/11-graph");

    const wtPath = join(root, "wt-12");
    await addWorktree({ repoFolder: repo, worktreePath: wtPath, branch: "hub/12-checkedout" });

    const workers: ManagedBranchWorkerRef[] = [
      { workerId: 10, projectId: 1, branch: "hub/10-open", baseCommit: base, status: "open", inActiveGraph: false, endedAt: null },
      { workerId: 11, projectId: 1, branch: "hub/11-graph", baseCommit: base, status: "ended", inActiveGraph: true, endedAt: T0 - 10 * DAY_MS },
      { workerId: 12, projectId: 1, branch: "hub/12-checkedout", baseCommit: base, status: "ended", inActiveGraph: false, endedAt: T0 - 10 * DAY_MS },
    ];
    const cleanup = createBranchCleanup({ ledger: makeLedger(workers), log: () => {}, now: () => nowMs });
    const result = await cleanup.runOnce();

    expect(result.deleted).toEqual([]);
    expect(branchExists("main")).toBe(true);
    expect(branchExists("feature/user-owned")).toBe(true);
    expect(branchExists("hub/10-open")).toBe(true);
    expect(branchExists("hub/11-graph")).toBe(true);
    expect(branchExists("hub/12-checkedout")).toBe(true);
    expect(result.repos[0]?.activeCount).toBe(3);
  });

  it("surfaces ended unmerged managed branches past unmergedHoldMs as held items instead of deleting them", async () => {
    const base = git(repo, "rev-parse", "HEAD");
    createCommitOnBranch("hub/20-old-unmerged", "unmerged.txt", "wip\n");
    createCommitOnBranch("hub/21-fresh-unmerged", "fresh.txt", "wip2\n");

    const workers: ManagedBranchWorkerRef[] = [
      { workerId: 20, projectId: 1, branch: "hub/20-old-unmerged", baseCommit: base, status: "ended", inActiveGraph: false, endedAt: T0 - 8 * DAY_MS },
      { workerId: 21, projectId: 1, branch: "hub/21-fresh-unmerged", baseCommit: base, status: "ended", inActiveGraph: false, endedAt: T0 - 2 * DAY_MS },
    ];
    const cleanup = createBranchCleanup({ ledger: makeLedger(workers), log: () => {}, now: () => nowMs });
    const inspected = await cleanup.inspect();

    expect(inspected.held).toHaveLength(1);
    expect(inspected.held[0]).toMatchObject({
      kind: "git_branch",
      reason: "unmerged_ended_branch",
      branch: "hub/20-old-unmerged",
      workerId: 20,
      commitsAhead: 1,
    });
    const run = await cleanup.runOnce();
    expect(run.deleted).toEqual([]);
    expect(branchExists("hub/20-old-unmerged")).toBe(true);
  });

  it("force-deletes a held managed branch on explicit discardBranch after re-verifying it is inactive and unchecked-out", async () => {
    const base = git(repo, "rev-parse", "HEAD");
    createCommitOnBranch("hub/30-discard", "d.txt", "wip\n");
    const workers: ManagedBranchWorkerRef[] = [
      { workerId: 30, projectId: 1, branch: "hub/30-discard", baseCommit: base, status: "ended", inActiveGraph: false, endedAt: T0 - 9 * DAY_MS },
    ];
    const cleanup = createBranchCleanup({ ledger: makeLedger(workers), log: () => {}, now: () => nowMs });

    await cleanup.discardBranch(repo, "hub/30-discard");
    expect(branchExists("hub/30-discard")).toBe(false);
  });

  it("rejects discardBranch for protected or non-managed branches", async () => {
    const base = git(repo, "rev-parse", "HEAD");
    createCommitOnBranch("feature/not-hub", "n.txt", "n\n");
    createCommitOnBranch("hub/31-active", "a.txt", "a\n");
    const workers: ManagedBranchWorkerRef[] = [
      { workerId: 31, projectId: 1, branch: "hub/31-active", baseCommit: base, status: "open", inActiveGraph: false, endedAt: null },
    ];
    const cleanup = createBranchCleanup({ ledger: makeLedger(workers), log: () => {}, now: () => nowMs });

    await expect(cleanup.discardBranch(repo, "main")).rejects.toThrow();
    await expect(cleanup.discardBranch(repo, "feature/not-hub")).rejects.toThrow();
    await expect(cleanup.discardBranch(repo, "hub/31-active")).rejects.toThrow();
    await expect(cleanup.discardBranch(join(root, "unknown-repo"), "hub/31-active")).rejects.toThrow();
    expect(branchExists("feature/not-hub")).toBe(true);
    expect(branchExists("hub/31-active")).toBe(true);
  });

  it("stops before touching the ledger again once the stop signal aborts mid-scan", async () => {
    createCommitOnBranch("hub/40-a", "a40.txt", "a\n");
    const controller = new AbortController();
    let ledgerCallsAfterAbort = 0;
    const ledger: BranchCleanupLedger = {
      listActiveProjectRepos: () => [{ projectId: 1, projectName: "demo", repoFolder: repo }],
      listManagedBranchWorkers: () => {
        if (controller.signal.aborted) ledgerCallsAfterAbort++;
        return [];
      },
    };
    const cleanup = createBranchCleanup({ ledger, log: () => {}, now: () => nowMs, signal: controller.signal });
    const run = cleanup.runOnce();
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(ledgerCallsAfterAbort).toBe(0);
    expect(branchExists("hub/40-a")).toBe(true);
  });

  it("reuses merge verdicts until the branch or main moves, and reports a repository it could not scan as incomplete", async () => {
    const base = git(repo, "rev-parse", "HEAD");
    createCommitOnBranch("hub/41-held", "h.txt", "h\n");
    const workers: ManagedBranchWorkerRef[] = [
      { workerId: 41, projectId: 1, branch: "hub/41-held", baseCommit: base, status: "ended", inActiveGraph: false, endedAt: T0 - 9 * DAY_MS },
    ];
    const cleanup = createBranchCleanup({ ledger: makeLedger(workers), log: () => {}, now: () => nowMs });
    const first = await cleanup.inspect();
    expect(first.complete).toBe(true);
    expect(first.held.map((h) => [h.branch, h.commitsAhead])).toEqual([["hub/41-held", 1]]);

    git(repo, "checkout", "-q", "hub/41-held");
    writeFileSync(join(repo, "h2.txt"), "h2\n");
    git(repo, "add", "h2.txt");
    git(repo, "commit", "-q", "-m", "more");
    git(repo, "checkout", "-q", "main");
    const moved = await cleanup.inspect();
    expect(moved.held.map((h) => [h.branch, h.commitsAhead])).toEqual([["hub/41-held", 2]]);

    const missing = createBranchCleanup({
      ledger: makeLedger(workers, [{ projectId: 2, projectName: "gone", repoFolder: join(root, "unmounted") }]),
      log: () => {},
      now: () => nowMs,
    });
    expect(await missing.inspect()).toEqual({ held: [], repos: [], complete: false });
  });

  it("does not delete an earlier relay branch when a later squash-merged branch reverted its file edit and made another edit to that same file", async () => {
    writeFileSync(join(repo, "README.md"), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-q", "-m", "ten lines");
    const base = git(repo, "rev-parse", "HEAD");

    git(repo, "checkout", "-q", "-b", "hub/50-part1");
    writeFileSync(join(repo, "README.md"), Array.from({ length: 10 }, (_, i) => (i === 4 ? "part1 work" : `line ${i + 1}`)).join("\n") + "\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-q", "-m", "part1");

    git(repo, "checkout", "-q", "-b", "hub/51-part2");
    writeFileSync(join(repo, "README.md"), Array.from({ length: 10 }, (_, i) => (i === 8 ? "unrelated edit" : `line ${i + 1}`)).join("\n") + "\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-q", "-m", "revert part1 and edit line 9");

    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--squash", "hub/51-part2");
    git(repo, "commit", "-q", "-m", "squash part2");

    const workers: ManagedBranchWorkerRef[] = [
      { workerId: 50, projectId: 1, branch: "hub/50-part1", baseCommit: base, status: "ended", inActiveGraph: false, endedAt: T0 - 8 * DAY_MS },
      { workerId: 51, projectId: 1, branch: "hub/51-part2", baseCommit: base, status: "ended", inActiveGraph: false, endedAt: T0 - 8 * DAY_MS },
    ];
    const cleanup = createBranchCleanup({ ledger: makeLedger(workers), log: () => {}, now: () => nowMs });
    const run = await cleanup.runOnce();

    expect(run.deleted.map((d) => d.branch)).toEqual(["hub/51-part2"]);
    expect(branchExists("hub/50-part1")).toBe(true);
    expect(run.held.map((h) => h.branch)).toEqual(["hub/50-part1"]);
  });

  it("holds rather than deletes an earlier relay branch when a later squash-merged branch reverted one of two adjacent edited lines", async () => {
    writeFileSync(join(repo, "README.md"), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-q", "-m", "ten lines");
    const base = git(repo, "rev-parse", "HEAD");

    git(repo, "checkout", "-q", "-b", "hub/52-part1");
    writeFileSync(
      join(repo, "README.md"),
      Array.from({ length: 10 }, (_, i) => (i === 4 ? "part1 lost" : i === 5 ? "part1 kept" : `line ${i + 1}`)).join("\n") + "\n",
    );
    git(repo, "add", "README.md");
    git(repo, "commit", "-q", "-m", "edit adjacent lines 5 and 6");

    git(repo, "checkout", "-q", "-b", "hub/53-part2");
    writeFileSync(
      join(repo, "README.md"),
      Array.from({ length: 10 }, (_, i) => (i === 5 ? "part1 kept" : `line ${i + 1}`)).join("\n") + "\n",
    );
    git(repo, "add", "README.md");
    git(repo, "commit", "-q", "-m", "revert line 5 and retain line 6");

    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--squash", "hub/53-part2");
    git(repo, "commit", "-q", "-m", "squash part2");

    const workers: ManagedBranchWorkerRef[] = [
      { workerId: 52, projectId: 1, branch: "hub/52-part1", baseCommit: base, status: "ended", inActiveGraph: false, endedAt: T0 - 8 * DAY_MS },
      { workerId: 53, projectId: 1, branch: "hub/53-part2", baseCommit: base, status: "ended", inActiveGraph: false, endedAt: T0 - 8 * DAY_MS },
    ];
    const cleanup = createBranchCleanup({ ledger: makeLedger(workers), log: () => {}, now: () => nowMs });
    const run = await cleanup.runOnce();

    expect(run.deleted.map((d) => d.branch)).toEqual(["hub/53-part2"]);
    expect(branchExists("hub/52-part1")).toBe(true);
    expect(run.held.map((h) => h.branch)).toEqual(["hub/52-part1"]);
  });
});
