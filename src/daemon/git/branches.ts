import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GIT_PROBE_TIMEOUT_MS, GIT_TIMEOUT_MS, SQUASH_MERGE_CANDIDATES_MAX, SQUASH_MERGE_CONTAINING_REFS_MAX } from "../../shared/limits.ts";
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

/**
 * Precondition: repoFolder is a git repository and targetCommits came from resolveMainTargetCommits.
 * Postcondition: returns the names of local branches under prefix whose tip is already contained in one of targetCommits, using one git call per target.
 */
export async function listBranchesMergedInto(
  repoFolder: string,
  targetCommits: readonly string[],
  prefix: string,
  options: GitOptions = {},
): Promise<Set<string>> {
  const merged = new Set<string>();
  for (const target of targetCommits) {
    const run = await runGit(
      repoFolder,
      [...GIT_READONLY_ARGS, "for-each-ref", `--merged=${target}`, "--format=%(refname:short)", `refs/heads/${prefix}`],
      options.timeoutMs ?? GIT_TIMEOUT_MS,
      PROBE_ENV,
    );
    if (run.code !== 0) throw failedGit("git for-each-ref --merged", run);
    for (const line of run.stdout.split("\n")) if (line.trim() !== "") merged.add(line.trim());
  }
  return merged;
}

async function resolveBranchAndTargets(repoFolder: string, branchRef: string, timeoutMs: number): Promise<{ branchCommit: string | null; targetCommits: string[] }> {
  const run = await runGit(
    repoFolder,
    [...GIT_READONLY_ARGS, "for-each-ref", "--format=%(refname) %(objectname)", branchRef, ...MAIN_TARGET_REFS],
    timeoutMs,
    PROBE_ENV,
  );
  if (run.code !== 0) throw failedGit("git for-each-ref", run);
  let branchCommit: string | null = null;
  const targets = new Set<string>();
  for (const line of run.stdout.split("\n")) {
    const item = line.trim();
    const space = item.lastIndexOf(" ");
    if (space <= 0) continue;
    if (item.slice(0, space) === branchRef) branchCommit = item.slice(space + 1);
    else targets.add(item.slice(space + 1));
  }
  return { branchCommit, targetCommits: [...targets].sort() };
}

function patchIdsOf(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0] ?? "")
    .filter((id) => id !== "");
}

type ContentProbe = {
  repoFolder: string;
  timeoutMs: number;
  mergeTree: "unknown" | "supported" | "unsupported";
  scratch: { objectDir: string; alternates: string } | null;
};

type ContentVerdict = "merged" | "not_merged" | "target_behind";

type TouchingCommit = { sha: string; sameFiles: boolean };

/** Non-merge commits on target past mergeBase that touch every file the branch changed, newest first; only these can hold the branch's squash. */
async function commitsTouchingAll(probe: ContentProbe, mergeBase: string, targetCommit: string, files: ReadonlySet<string>): Promise<TouchingCommit[]> {
  const run = await runGit(
    probe.repoFolder,
    [...GIT_READONLY_ARGS, "-c", "core.quotePath=false", "log", "--no-merges", "--no-renames", "--format=%x00%H", "--name-only", `${mergeBase}..${targetCommit}`],
    probe.timeoutMs,
    PROBE_ENV,
  );
  if (run.code !== 0) throw failedGit("git log", run);
  const matches: TouchingCommit[] = [];
  for (const chunk of run.stdout.split("\0")) {
    const lines = chunk.split("\n").filter((l) => l !== "");
    const sha = lines.shift();
    if (sha === undefined) continue;
    const touched = new Set(lines);
    if ([...files].every((file) => touched.has(file))) matches.push({ sha, sameFiles: touched.size === files.size });
    if (matches.length >= SQUASH_MERGE_CANDIDATES_MAX) break;
  }
  return matches;
}

function quoteAlternate(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function scratchObjectDir(probe: ContentProbe): Promise<{ objectDir: string; alternates: string }> {
  if (probe.scratch !== null) return probe.scratch;
  const run = await runGit(probe.repoFolder, [...GIT_READONLY_ARGS, "rev-parse", "--git-path", "objects"], probe.timeoutMs, PROBE_ENV);
  if (run.code !== 0) throw failedGit("git rev-parse --git-path objects", run);
  const objects = resolve(probe.repoFolder, run.stdout.trim());
  const objectDir = await mkdtemp(join(tmpdir(), "agent-hub-merge-probe-"));
  probe.scratch = { objectDir, alternates: quoteAlternate(objects) };
  return probe.scratch;
}

/** True when merging commit into onto leaves onto's tree unchanged; merge-tree writes its result objects into a throwaway object directory so the repository stays untouched. */
async function mergeLeavesTreeUnchanged(probe: ContentProbe, onto: string, commit: string): Promise<boolean | "unsupported"> {
  const scratch = await scratchObjectDir(probe);
  const run = await runGit(
    probe.repoFolder,
    [...GIT_READONLY_ARGS, "merge-tree", "--write-tree", "--no-messages", onto, commit],
    probe.timeoutMs,
    { ...PROBE_ENV, GIT_OBJECT_DIRECTORY: scratch.objectDir, GIT_ALTERNATE_OBJECT_DIRECTORIES: scratch.alternates },
  );
  // git before 2.38 has no --write-tree and exits with usage.
  if (run.code === 129) return "unsupported";
  if (run.code === 1) return false;
  if (run.code !== 0) throw failedGit("git merge-tree --write-tree", run);
  const tree = run.stdout.split("\n")[0]?.trim() ?? "";
  const ontoTree = await runGit(probe.repoFolder, [...GIT_READONLY_ARGS, "rev-parse", "--verify", "--quiet", `${onto}^{tree}`], probe.timeoutMs, PROBE_ENV);
  if (ontoTree.code !== 0) throw failedGit("git rev-parse", ontoTree);
  return tree !== "" && tree === ontoTree.stdout.trim();
}

async function mergeTreeFindsContent(probe: ContentProbe, commit: string, targetCommit: string, candidates: readonly TouchingCommit[]): Promise<boolean | "unsupported"> {
  for (const onto of [targetCommit, ...candidates.map((c) => c.sha).filter((sha) => sha !== targetCommit)]) {
    const result = await mergeLeavesTreeUnchanged(probe, onto, commit);
    if (result !== false) return result;
  }
  return false;
}

async function patchIdFindsContent(probe: ContentProbe, mergeBase: string, commit: string, candidates: readonly TouchingCommit[]): Promise<boolean> {
  const exact = candidates.filter((c) => c.sameFiles).map((c) => c.sha);
  if (exact.length === 0) return false;
  const { repoFolder, timeoutMs } = probe;
  const squashPatch = await runGit(repoFolder, [...GIT_READONLY_ARGS, "diff-tree", "-p", "--no-renames", "--full-index", mergeBase, commit], timeoutMs, PROBE_ENV);
  if (squashPatch.code !== 0) throw failedGit("git diff-tree", squashPatch);
  const squashId = await runGit(repoFolder, ["patch-id", "--stable"], timeoutMs, PROBE_ENV, squashPatch.stdout);
  if (squashId.code !== 0) throw failedGit("git patch-id", squashId);
  const wanted = patchIdsOf(squashId.stdout)[0];
  if (wanted === undefined) return false;
  const candidatePatches = await runGit(
    repoFolder,
    [...GIT_READONLY_ARGS, "diff-tree", "-p", "--no-renames", "--full-index", "--stdin"],
    timeoutMs,
    PROBE_ENV,
    `${exact.join("\n")}\n`,
  );
  if (candidatePatches.code !== 0) throw failedGit("git diff-tree --stdin", candidatePatches);
  const candidateIds = await runGit(repoFolder, ["patch-id", "--stable"], timeoutMs, PROBE_ENV, candidatePatches.stdout);
  if (candidateIds.code !== 0) throw failedGit("git patch-id", candidateIds);
  return patchIdsOf(candidateIds.stdout).includes(wanted);
}

/** Whether everything commit changed since its merge-base with targetCommit already sits in targetCommit or in one commit on its history. */
async function contentInTarget(probe: ContentProbe, commit: string, targetCommit: string): Promise<ContentVerdict> {
  if (commit === targetCommit) return "merged";
  const { repoFolder, timeoutMs } = probe;
  const mbRun = await runGit(repoFolder, [...GIT_READONLY_ARGS, "merge-base", targetCommit, commit], timeoutMs, PROBE_ENV);
  const mergeBase = mbRun.code === 0 ? mbRun.stdout.trim() : "";
  if (mergeBase === "") return "not_merged";
  if (mergeBase === commit) return "merged";
  if (mergeBase === targetCommit) return "target_behind";

  const filesRun = await runGit(
    repoFolder,
    [...GIT_READONLY_ARGS, "-c", "core.quotePath=false", "diff-tree", "-r", "--no-renames", "--name-only", mergeBase, commit],
    timeoutMs,
    PROBE_ENV,
  );
  if (filesRun.code !== 0) throw failedGit("git diff-tree", filesRun);
  const files = new Set(filesRun.stdout.split("\n").filter((l) => l !== ""));
  if (files.size === 0) return "merged";

  const candidates = await commitsTouchingAll(probe, mergeBase, targetCommit, files);
  if (probe.mergeTree !== "unsupported") {
    const found = await mergeTreeFindsContent(probe, commit, targetCommit, candidates);
    if (found !== "unsupported") {
      probe.mergeTree = "supported";
      return found ? "merged" : "not_merged";
    }
    probe.mergeTree = "unsupported";
  }
  return (await patchIdFindsContent(probe, mergeBase, commit, candidates)) ? "merged" : "not_merged";
}

/** Other branches and remote-tracking refs that contain commit, such as the PR head that later relay Workers pushed on top of it. */
async function refsContaining(probe: ContentProbe, commit: string, ownRef: string): Promise<string[]> {
  const run = await runGit(
    probe.repoFolder,
    [...GIT_READONLY_ARGS, "for-each-ref", "--contains", commit, "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes"],
    probe.timeoutMs,
    PROBE_ENV,
  );
  if (run.code !== 0) throw failedGit("git for-each-ref --contains", run);
  const skipRefs = new Set<string>([ownRef, ...MAIN_TARGET_REFS]);
  const commits = new Set<string>();
  for (const line of run.stdout.split("\n")) {
    const item = line.trim();
    const space = item.lastIndexOf(" ");
    if (space <= 0) continue;
    const ref = item.slice(0, space);
    const sha = item.slice(space + 1);
    if (skipRefs.has(ref) || ref.endsWith("/HEAD") || sha === commit) continue;
    commits.add(sha);
    if (commits.size >= SQUASH_MERGE_CONTAINING_REFS_MAX) break;
  }
  return [...commits];
}

async function contentInAnyTarget(probe: ContentProbe, commit: string, targetCommits: readonly string[]): Promise<ContentVerdict> {
  let verdict: ContentVerdict = "target_behind";
  for (const target of targetCommits) {
    const result = await contentInTarget(probe, commit, target);
    if (result === "merged") return "merged";
    if (result === "not_merged") verdict = "not_merged";
  }
  return verdict;
}

/**
 * Precondition: repoFolder is a git repository and branch names a local branch under refs/heads/.
 * Postcondition: returns true when the branch's changes since its merge-base with a main/master target ref already sit in that target or in one commit on its history (merging the branch there changes nothing), or when another branch or remote-tracking ref that contains the branch passes the same test; any conflict or leftover change counts as not merged. Falls back to comparing git patch-ids when git lacks merge-tree --write-tree. Never writes an object or ref into the repository.
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
  const ownRef = `refs/heads/${trimmed}`;
  const { branchCommit, targetCommits } = await resolveBranchAndTargets(repoFolder, ownRef, timeoutMs);
  if (branchCommit === null || targetCommits.length === 0) return false;
  if (baseCommit !== null && branchCommit === baseCommit) return false;

  const probe: ContentProbe = { repoFolder, timeoutMs, mergeTree: "unknown", scratch: null };
  try {
    const own = await contentInAnyTarget(probe, branchCommit, targetCommits);
    if (own === "merged") return true;
    // Every target is an ancestor of the branch, so nothing containing the branch can be on main either.
    if (own === "target_behind") return false;
    for (const containing of await refsContaining(probe, branchCommit, ownRef)) {
      if ((await contentInAnyTarget(probe, containing, targetCommits)) === "merged") return true;
    }
    return false;
  } finally {
    if (probe.scratch !== null) await rm(probe.scratch.objectDir, { recursive: true, force: true });
  }
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
