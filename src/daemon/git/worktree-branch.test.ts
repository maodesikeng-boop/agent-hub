import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { createWorktreeBranchProbe, readWorktreeBranch } from "./worktree-branch.ts";

vi.mock("node:fs/promises", { spy: true });

let root: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "worktree branch ")); });
afterEach(() => {
  vi.clearAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function realWorktree() {
  git(root, "init", "-q", "-b", "main");
  git(root, "commit", "--allow-empty", "-qm", "Initial");
  const worktree = join(root, "linked");
  git(root, "worktree", "add", "-q", "-b", "feature/old", worktree);
  return worktree;
}

function plainRepo(name: string) {
  const path = join(root, name);
  mkdirSync(join(path, ".git"), { recursive: true });
  writeFileSync(join(path, ".git", "HEAD"), `ref: refs/heads/${name}\n`);
  return path;
}

describe("worktree branch probes", () => {
  it("reads local branches from a plain repository and a linked worktree", async () => {
    const linked = realWorktree();
    await expect(readWorktreeBranch(root)).resolves.toBe("main");
    await expect(readWorktreeBranch(linked)).resolves.toBe("feature/old");
  });

  it("observes a same-length rename and a detached checkout on the next cached read", async () => {
    const linked = realWorktree();
    const probe = createWorktreeBranchProbe();
    await expect(probe.readBranch(linked)).resolves.toBe("feature/old");
    git(linked, "branch", "-m", "feature/new");
    await expect(probe.readBranch(linked)).resolves.toBe("feature/new");
    git(linked, "checkout", "-q", "--detach", "HEAD");
    await expect(probe.readBranch(linked)).resolves.toBeNull();
  });

  it("returns no branch for missing, non-Git, or malformed worktrees", async () => {
    await expect(readWorktreeBranch(join(root, "missing"))).resolves.toBeNull();
    await expect(readWorktreeBranch(root)).resolves.toBeNull();
    writeFileSync(join(root, ".git"), "not a gitdir");
    await expect(readWorktreeBranch(root)).resolves.toBeNull();
  });

  it.each(["../metadata/index", "..\\metadata\\index"])("resolves relative gitdir %s", async (pointer) => {
    const worktree = join(root, "linked");
    const gitdir = join(root, "metadata", "index");
    mkdirSync(worktree);
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${pointer}\r\n`);
    writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/feature/relative\n");
    await expect(readWorktreeBranch(worktree)).resolves.toBe("feature/relative");
  });

  it("reuses unchanged HEAD reads, evicts the least recently used path, and accepts invalidation", async () => {
    const probe = createWorktreeBranchProbe({ maxEntries: 2 });
    const a = plainRepo("a"), b = plainRepo("b"), c = plainRepo("c");
    for (const path of [a, b, a, c, a, b]) await probe.readBranch(path);
    expect(vi.mocked(fs.readFile).mock.calls.map(([path]) => path)).toEqual([a, b, c, b].map((path) => join(path, ".git", "HEAD")));
    vi.clearAllMocks();
    probe.invalidate(a);
    await probe.readBranch(a);
    await probe.readBranch(b);
    expect(fs.readFile).toHaveBeenCalledTimes(1);
    probe.invalidate();
    await probe.readBranch(a);
    await probe.readBranch(b);
    expect(fs.readFile).toHaveBeenCalledTimes(3);
  });
});
