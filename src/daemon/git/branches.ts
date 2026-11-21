import { GIT_PROBE_TIMEOUT_MS, GIT_TIMEOUT_MS } from "../../shared/limits.ts";
import {
  GIT_READONLY_ARGS,
  GIT_READONLY_ENV,
  GitError,
  MAIN_TARGET_REFS,
  failedGit,
  parseWorktreeList,
  runGit,
  type GitOptions,
  type LocalBranchInfo,
} from "./git.ts";

const PROTECTED_BRANCH_NAMES = new Set(["main", "master", "HEAD"]);

const SYNTHETIC_COMMIT_ENV: Readonly<Record<string, string>> = {
  ...GIT_READONLY_ENV,
  LC_ALL: "C",
  GIT_AUTHOR_NAME: "bellwood",
  GIT_AUTHOR_EMAIL: "bellwood@local",
  GIT_COMMITTER_NAME: "bellwood",
  GIT_COMMITTER_EMAIL: "bellwood@local",
};

/**
 * Precondition: repoFolder is a git repository and branch names a local branch under refs/heads/.
 * Postcondition: returns true when branch's squashed diff against its merge-base with a main/master target ref is already present in that target ref (via git commit-tree and git cherry), without creating refs or touching the worktree.
 */
export async function isBranchSquashMergedToMain(
  repoFolder: string,
  branch: string,
  baseCommit: string | null,
  options: GitOptions = {},
): Promise<boolean> {
  const trimmed = branch.trim();
  if (trimmed === "" || trimmed.startsWith("-")) return false;
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const branchRef = `refs/heads/${trimmed}`;
  const refsRun = await runGit(
    repoFolder,
    [...GIT_READONLY_ARGS, "for-each-ref", "--format=%(refname) %(objectname)", branchRef, ...MAIN_TARGET_REFS],
    timeoutMs,
    { ...GIT_READONLY_ENV, LC_ALL: "C" },
  );
  if (refsRun.code !== 0) throw failedGit("git for-each-ref", refsRun);

  let branchCommit: string | null = null;
  const targetCommits = new Set<string>();
  for (const line of refsRun.stdout.split("\n")) {
    const item = line.trim();
    if (item === "") continue;
    const space = item.lastIndexOf(" ");
    if (space <= 0) continue;
    const ref = item.slice(0, space);
    const sha = item.slice(space + 1);
    if (ref === branchRef) branchCommit = sha;
    else targetCommits.add(sha);
  }
  if (branchCommit === null || targetCommits.size === 0) return false;
  if (baseCommit !== null && branchCommit === baseCommit) return false;

  let branchTree: string | null = null;

  for (const targetCommit of targetCommits) {
    if (branchCommit === targetCommit) return true;
    const mbRun = await runGit(
      repoFolder,
      [...GIT_READONLY_ARGS, "merge-base", targetCommit, branchCommit],
      timeoutMs,
      { ...GIT_READONLY_ENV, LC_ALL: "C" },
    );
    if (mbRun.code !== 0) continue;
    const mergeBase = mbRun.stdout.trim();
    if (mergeBase === "") continue;
    if (mergeBase === branchCommit) return true;
    // Target has no commits past merge-base, so it cannot contain a squash commit of this branch.
    if (mergeBase === targetCommit) continue;

    if (branchTree === null) {
      const branchTreeRun = await runGit(
        repoFolder,
        [...GIT_READONLY_ARGS, "rev-parse", "--verify", "--quiet", `${branchCommit}^{tree}`],
        timeoutMs,
        { ...GIT_READONLY_ENV, LC_ALL: "C" },
      );
      if (branchTreeRun.code !== 0) return false;
      branchTree = branchTreeRun.stdout.trim();
      if (branchTree === "") return false;
    }

    const mbTreeRun = await runGit(
      repoFolder,
      [...GIT_READONLY_ARGS, "rev-parse", "--verify", "--quiet", `${mergeBase}^{tree}`],
      timeoutMs,
      { ...GIT_READONLY_ENV, LC_ALL: "C" },
    );
    if (mbTreeRun.code === 0 && mbTreeRun.stdout.trim() === branchTree) return true;

    const commitTreeRun = await runGit(
      repoFolder,
      [...GIT_READONLY_ARGS, "-c", "commit.gpgsign=false", "commit-tree", branchTree, "-p", mergeBase, "-m", "_"],
      timeoutMs,
      SYNTHETIC_COMMIT_ENV,
    );
    if (commitTreeRun.code !== 0) throw failedGit("git commit-tree", commitTreeRun);
    const dangling = commitTreeRun.stdout.trim();
    if (dangling === "") continue;

    const cherryRun = await runGit(
      repoFolder,
      [...GIT_READONLY_ARGS, "cherry", targetCommit, dangling],
      timeoutMs,
      { ...GIT_READONLY_ENV, LC_ALL: "C" },
    );
    if (cherryRun.code !== 0) throw failedGit("git cherry", cherryRun);
    const lines = cherryRun.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    if (lines.length === 0 || lines.every((l) => l.startsWith("-"))) return true;
  }
  return false;
}

export async function countCommitsAheadOfMain(
  repoFolder: string,
  branch: string,
  options: GitOptions = {},
): Promise<number | null> {
  const trimmed = branch.trim();
  if (trimmed === "" || trimmed.startsWith("-")) return null;
  const timeoutMs = options.timeoutMs ?? GIT_PROBE_TIMEOUT_MS;
  const refsRun = await runGit(
    repoFolder,
    [...GIT_READONLY_ARGS, "for-each-ref", "--format=%(objectname)", ...MAIN_TARGET_REFS],
    timeoutMs,
    { ...GIT_READONLY_ENV, LC_ALL: "C" },
  );
  if (refsRun.code !== 0) return null;
  const target = refsRun.stdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (target === undefined) return null;
  const countRun = await runGit(
    repoFolder,
    [...GIT_READONLY_ARGS, "rev-list", "--count", `${target}..refs/heads/${trimmed}`],
    timeoutMs,
    { ...GIT_READONLY_ENV, LC_ALL: "C" },
  );
  if (countRun.code !== 0) return null;
  const n = Number.parseInt(countRun.stdout.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Precondition: repoFolder is a git repository.
 * Postcondition: lists local branches under refs/heads/ matching prefix (or all local branches when prefix is omitted), annotated with any worktree checkout path.
 */
export async function listLocalBranches(
  repoFolder: string,
  prefix?: string,
  options: GitOptions = {},
): Promise<LocalBranchInfo[]> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const refsRun = await runGit(
    repoFolder,
    [...GIT_READONLY_ARGS, "for-each-ref", "--format=%(refname:short)%00%(objectname)", "refs/heads"],
    timeoutMs,
    { ...GIT_READONLY_ENV, LC_ALL: "C" },
  );
  if (refsRun.code !== 0) throw failedGit("git for-each-ref", refsRun);

  const wtRun = await runGit(
    repoFolder,
    [...GIT_READONLY_ARGS, "-c", "core.quotePath=false", "worktree", "list", "--porcelain"],
    timeoutMs,
    { ...GIT_READONLY_ENV, LC_ALL: "C" },
  );
  if (wtRun.code !== 0) throw failedGit("git worktree list", wtRun);

  const checkedOut = new Map<string, string>();
  for (const entry of parseWorktreeList(wtRun.stdout)) {
    if (entry.branch !== null && entry.branch.startsWith("refs/heads/")) {
      checkedOut.set(entry.branch.slice("refs/heads/".length), entry.path);
    }
  }

  const branches: LocalBranchInfo[] = [];
  for (const line of refsRun.stdout.split("\n")) {
    if (line === "") continue;
    const sep = line.indexOf("\0");
    if (sep <= 0) continue;
    const name = line.slice(0, sep);
    const commit = line.slice(sep + 1).trim();
    if (prefix !== undefined && !name.startsWith(prefix)) continue;
    branches.push({ name, commit, checkedOutPath: checkedOut.get(name) ?? null });
  }
  return branches;
}

/**
 * Precondition: repoFolder is a git repository and branch is a managed non-protected local branch not checked out in any worktree.
 * Postcondition: deletes refs/heads/<branch> (using -d unless force is true); throws GitError("git_failed") if branch is main, master, HEAD, or checked out by a worktree.
 */
export async function deleteLocalBranch(
  repoFolder: string,
  branch: string,
  options: GitOptions & { force?: boolean } = {},
): Promise<void> {
  const trimmed = branch.trim();
  if (trimmed === "" || trimmed !== branch || trimmed.startsWith("-") || PROTECTED_BRANCH_NAMES.has(trimmed)) {
    throw new GitError("git_failed", `Refusing to delete protected or invalid branch: ${branch}`);
  }
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const headRun = await runGit(
    repoFolder,
    [...GIT_READONLY_ARGS, "symbolic-ref", "--quiet", "--short", "HEAD"],
    timeoutMs,
    { ...GIT_READONLY_ENV, LC_ALL: "C" },
  );
  if (headRun.code === 0 && headRun.stdout.trim() === trimmed) {
    throw new GitError("git_failed", `Refusing to delete checked-out HEAD branch: ${trimmed}`);
  }

  const wtRun = await runGit(
    repoFolder,
    [...GIT_READONLY_ARGS, "-c", "core.quotePath=false", "worktree", "list", "--porcelain"],
    timeoutMs,
    { ...GIT_READONLY_ENV, LC_ALL: "C" },
  );
  if (wtRun.code !== 0) throw failedGit("git worktree list", wtRun);
  const fullRef = `refs/heads/${trimmed}`;
  if (parseWorktreeList(wtRun.stdout).some((entry) => entry.branch === fullRef)) {
    throw new GitError("git_failed", `Refusing to delete branch checked out in a worktree: ${trimmed}`);
  }

  const delRun = await runGit(
    repoFolder,
    ["branch", options.force ? "-D" : "-d", "--", trimmed],
    timeoutMs,
    { LC_ALL: "C" },
  );
  if (delRun.code !== 0) throw failedGit("git branch", delRun);
}
