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

const PROBE_ENV: Readonly<Record<string, string>> = { ...GIT_READONLY_ENV, LC_ALL: "C" };

/**
 * Precondition: repoFolder is a git repository.
 * Postcondition: returns the distinct commits that main/master target refs point at, sorted, or an empty array when none exist.
 */
export async function resolveMainTargetCommits(repoFolder: string, options: GitOptions = {}): Promise<string[]> {
  const run = await runGit(
    repoFolder,
    [...GIT_READONLY_ARGS, "for-each-ref", "--format=%(objectname)", ...MAIN_TARGET_REFS],
    options.timeoutMs ?? GIT_TIMEOUT_MS,
    PROBE_ENV,
  );
  if (run.code !== 0) throw failedGit("git for-each-ref", run);
  return [...new Set(run.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== ""))].sort();
}

async function resolveBranchCommit(repoFolder: string, branchRef: string, timeoutMs: number): Promise<string | null> {
  const run = await runGit(repoFolder, [...GIT_READONLY_ARGS, "rev-parse", "--verify", "--quiet", `${branchRef}^{commit}`], timeoutMs, PROBE_ENV);
  if (run.code !== 0) return null;
  const sha = run.stdout.trim();
  return sha === "" ? null : sha;
}

function patchIdsOf(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0] ?? "")
    .filter((id) => id !== "");
}

/** Commits on target past mergeBase that touch exactly the files the squashed branch touches; only those can carry the same patch. */
async function sameFileCommits(repoFolder: string, mergeBase: string, targetCommit: string, files: ReadonlySet<string>, timeoutMs: number): Promise<string[]> {
  const run = await runGit(
    repoFolder,
    [...GIT_READONLY_ARGS, "-c", "core.quotePath=false", "log", "--no-merges", "--no-renames", "--format=%x00%H", "--name-only", `${mergeBase}..${targetCommit}`],
    timeoutMs,
    PROBE_ENV,
  );
  if (run.code !== 0) throw failedGit("git log", run);
  const matches: string[] = [];
  for (const chunk of run.stdout.split("\0")) {
    const lines = chunk.split("\n").filter((l) => l !== "");
    const sha = lines.shift();
    if (sha === undefined || lines.length !== files.size) continue;
    if (lines.every((file) => files.has(file))) matches.push(sha);
  }
  return matches;
}

/**
 * Precondition: repoFolder is a git repository and branch names a local branch under refs/heads/.
 * Postcondition: returns true when the branch's squashed diff against its merge-base with a main/master target ref equals the patch of a commit already on that target, comparing git patch-ids without writing any object or ref into the repository.
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
  const branchCommit = await resolveBranchCommit(repoFolder, `refs/heads/${trimmed}`, timeoutMs);
  const targetCommits = await resolveMainTargetCommits(repoFolder, options);
  if (branchCommit === null || targetCommits.length === 0) return false;
  if (baseCommit !== null && branchCommit === baseCommit) return false;

  for (const targetCommit of targetCommits) {
    if (branchCommit === targetCommit) return true;
    const mbRun = await runGit(repoFolder, [...GIT_READONLY_ARGS, "merge-base", targetCommit, branchCommit], timeoutMs, PROBE_ENV);
    if (mbRun.code !== 0) continue;
    const mergeBase = mbRun.stdout.trim();
    if (mergeBase === "") continue;
    if (mergeBase === branchCommit) return true;
    // Target has no commits past merge-base, so it cannot contain a squash commit of this branch.
    if (mergeBase === targetCommit) continue;

    const filesRun = await runGit(
      repoFolder,
      [...GIT_READONLY_ARGS, "-c", "core.quotePath=false", "diff-tree", "-r", "--no-renames", "--name-only", mergeBase, branchCommit],
      timeoutMs,
      PROBE_ENV,
    );
    if (filesRun.code !== 0) throw failedGit("git diff-tree", filesRun);
    const files = new Set(filesRun.stdout.split("\n").filter((l) => l !== ""));
    if (files.size === 0) return true;

    const candidates = await sameFileCommits(repoFolder, mergeBase, targetCommit, files, timeoutMs);
    if (candidates.length === 0) continue;

    const squashPatch = await runGit(repoFolder, [...GIT_READONLY_ARGS, "diff-tree", "-p", "--no-renames", "--full-index", mergeBase, branchCommit], timeoutMs, PROBE_ENV);
    if (squashPatch.code !== 0) throw failedGit("git diff-tree", squashPatch);
    const squashId = await runGit(repoFolder, ["patch-id", "--stable"], timeoutMs, PROBE_ENV, squashPatch.stdout);
    if (squashId.code !== 0) throw failedGit("git patch-id", squashId);
    const wanted = patchIdsOf(squashId.stdout)[0];
    if (wanted === undefined) continue;

    const candidatePatches = await runGit(
      repoFolder,
      [...GIT_READONLY_ARGS, "diff-tree", "-p", "--no-renames", "--full-index", "--stdin"],
      timeoutMs,
      PROBE_ENV,
      `${candidates.join("\n")}\n`,
    );
    if (candidatePatches.code !== 0) throw failedGit("git diff-tree --stdin", candidatePatches);
    const candidateIds = await runGit(repoFolder, ["patch-id", "--stable"], timeoutMs, PROBE_ENV, candidatePatches.stdout);
    if (candidateIds.code !== 0) throw failedGit("git patch-id", candidateIds);
    if (patchIdsOf(candidateIds.stdout).includes(wanted)) return true;
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
 * Postcondition: deletes refs/heads/<branch> only while it still points at expectedCommit (an atomic compare-and-delete, so a commit added after the merge check survives) and drops its branch config; throws GitError("git_failed") if branch is main, master, HEAD, checked out by a worktree, or moved.
 */
export async function deleteLocalBranch(
  repoFolder: string,
  branch: string,
  expectedCommit: string,
  options: GitOptions = {},
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

  if (!/^[0-9a-f]{40,64}$/.test(expectedCommit)) {
    throw new GitError("git_failed", `Refusing to delete ${trimmed} without the verified commit`);
  }
  const delRun = await runGit(repoFolder, ["update-ref", "-d", fullRef, expectedCommit], timeoutMs, { LC_ALL: "C" });
  if (delRun.code !== 0) throw failedGit("git update-ref -d", delRun);
  // The ref is gone either way; a branch with no config section makes this exit non-zero, which is fine.
  await runGit(repoFolder, ["config", "--remove-section", `branch.${trimmed}`], timeoutMs, { LC_ALL: "C" });
}
