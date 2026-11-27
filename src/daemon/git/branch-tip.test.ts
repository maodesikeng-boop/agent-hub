import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { branchRemote, remoteBranchHead, resolveBranchTip, syncWorktreeBranch } from "./branch-tip.ts";

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] }).trim();

const B = "feature/x";

describe("resolveBranchTip", () => {
  let root: string;
  let repo: string;
  let n = 0;

  const commit = (cwd: string, content: string): string => {
    writeFileSync(join(cwd, "f.txt"), content);
    git(cwd, "commit", "-qam", content);
    return git(cwd, "rev-parse", "HEAD");
  };
  const addRemote = (name: string): string => {
    const bare = join(root, `${name}.git`);
    git(root, "init", "-q", "--bare", "-b", "main", bare);
    git(repo, "remote", "add", name, bare);
    return bare;
  };
  const pushElsewhere = (bare: string, branch: string, content: string): string => {
    const other = join(root, `clone-${++n}`);
    git(root, "clone", "-q", "--branch", branch, bare, other);
    const sha = commit(other, content);
    git(other, "push", "-q", "origin", branch);
    return sha;
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-tip-")));
    repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "f.txt"), "0");
    git(repo, "add", "f.txt");
    git(repo, "commit", "-qm", "init");
    git(repo, "branch", B);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("no remote: uses the local branch and says so", async () => {
    const local = git(repo, "rev-parse", B);
    expect(await resolveBranchTip(repo, B, null)).toEqual({ commit: local, local, remote: null, findings: [{ kind: "no_remote" }] });
    expect(await remoteBranchHead(repo, B)).toBeUndefined();
  });

  it("remote unreachable (offline): falls back to the local branch with the fetch error", async () => {
    git(repo, "remote", "add", "up", join(root, "missing.git"));
    const local = git(repo, "rev-parse", B);
    const tip = await resolveBranchTip(repo, B, null);
    expect(tip).toMatchObject({ commit: local, local, remote: null });
    expect(tip.findings).toEqual([expect.objectContaining({ kind: "fetch_failed", remote: "up" })]);
  });

  it("not a git repository: throws instead of guessing", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    await expect(resolveBranchTip(plain, B, null)).rejects.toThrow();
  });

  it("the only remote under any name is used, and a remote that moved ahead wins over the stale local branch", async () => {
    const bare = addRemote("upstream-fork");
    git(repo, "push", "-q", "upstream-fork", B);
    const stale = git(repo, "rev-parse", B);
    const ahead = pushElsewhere(bare, B, "remote");
    expect(await resolveBranchTip(repo, B, ahead.slice(0, 8))).toEqual({
      commit: ahead, local: stale, remote: { name: "upstream-fork", sha: ahead }, findings: [{ kind: "remote_ahead", remote: "upstream-fork", local: stale }],
    });
    expect(git(repo, "rev-parse", `refs/remotes/upstream-fork/${B}`)).toBe(ahead);
    expect(git(repo, "rev-parse", B)).toBe(stale);
  });

  it("several remotes: follows the branch's push remote; without config it reports the ambiguity and stays local", async () => {
    addRemote("a");
    const second = addRemote("b");
    git(repo, "push", "-q", "b", B);
    const ahead = pushElsewhere(second, B, "on-b");
    expect(await branchRemote(repo, B)).toEqual({ kind: "remote", name: "b" });
    git(repo, "update-ref", "-d", `refs/remotes/b/${B}`);
    expect((await resolveBranchTip(repo, B, null)).findings).toEqual([{ kind: "ambiguous_remote", remotes: ["a", "b"] }]);
    git(repo, "config", `branch.${B}.pushRemote`, "b");
    expect(await branchRemote(repo, B)).toEqual({ kind: "remote", name: "b" });
    expect((await resolveBranchTip(repo, B, null)).commit).toBe(ahead);
    expect(await remoteBranchHead(repo, B)).toEqual({ name: "b", sha: ahead });
  });

  it("branch not pushed yet: the local branch, no finding", async () => {
    addRemote("origin");
    const local = git(repo, "rev-parse", B);
    expect(await resolveBranchTip(repo, B, null)).toEqual({ commit: local, local, remote: { name: "origin", sha: null }, findings: [] });
  });

  it("local ahead keeps local; diverged prefers the side holding the upstream's commit; a reported commit outside the result is flagged", async () => {
    const bare = addRemote("origin");
    git(repo, "push", "-q", "origin", B);
    git(repo, "checkout", "-q", B);
    const localOnly = commit(repo, "local");
    expect((await resolveBranchTip(repo, B, null)).findings).toEqual([expect.objectContaining({ kind: "local_ahead" })]);
    const remoteOnly = pushElsewhere(bare, B, "remote");
    const diverged = await resolveBranchTip(repo, B, localOnly);
    expect(diverged.commit).toBe(localOnly);
    expect(diverged.findings).toEqual([{ kind: "diverged", remote: "origin", local: localOnly, remoteSha: remoteOnly }]);
    expect((await resolveBranchTip(repo, B, null)).commit).toBe(remoteOnly);
    expect((await resolveBranchTip(repo, B, "0123456789")).findings).toContainEqual({ kind: "expected_missing", expected: "0123456789" });
  });

  it("syncWorktreeBranch fast-forwards a clean checkout, leaves a dirty one, and ignores a worktree on another branch", async () => {
    const bare = addRemote("origin");
    git(repo, "push", "-q", "origin", B);
    const wt = join(root, "wt");
    git(repo, "worktree", "add", "-q", wt, B);
    const from = git(wt, "rev-parse", "HEAD");
    const ahead = pushElsewhere(bare, B, "ahead");

    writeFileSync(join(wt, "f.txt"), "dirty");
    expect((await syncWorktreeBranch(repo, wt, B, null)).outcome).toEqual({ kind: "dirty", to: ahead });
    git(wt, "checkout", "-q", "--", "f.txt");

    expect((await syncWorktreeBranch(repo, wt, "other", null)).outcome).toEqual({ kind: "not_on_branch" });
    expect((await syncWorktreeBranch(repo, wt, B, null)).outcome).toEqual({ kind: "fast_forwarded", from, to: ahead });
    expect(git(wt, "rev-parse", "HEAD")).toBe(ahead);
    expect((await syncWorktreeBranch(repo, wt, B, null)).outcome).toEqual({ kind: "up_to_date" });
  });
});
