import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GIT_PROBE_TIMEOUT_MS, GIT_TIMEOUT_MS, SQUASH_MERGE_CANDIDATES_MAX, SQUASH_MERGE_CONTAINING_REFS_MAX, SQUASH_MERGE_RELAY_DEPTH_MAX } from "../../shared/limits.ts";
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
import { verifyRelayCarriesChanges } from "./relay-carry.ts";

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
  mergeTree: "unknown" | "usable" | "unusable";
  scratch: { objectDir: string; alternates: string } | null;
};

type ContentVerdict = "merged" | "not_merged" | "target_behind";

/** files lists what commit changed since its merge-base with the target, when that comparison was made. */
type ContentResult = { verdict: ContentVerdict; mergeBase: string | null; files: ReadonlySet<string> | null };

type TouchingCommit = { sha: string; sameFiles: boolean };

// binary and unset (-merge) keep every two-sided change as a conflict, so only union and unknown drivers can hide one.
const SAFE_MERGE_ATTRIBUTE_VALUES = new Set(["unspecified", "set", "text", "unset", "binary"]);

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

/** Any merge.<name>.* driver or a non-text merge.default can run a configured command inside merge-tree or resolve a conflict in favor of one side. */
async function customMergeConfigured(probe: ContentProbe): Promise<boolean> {
  const run = await runGit(probe.repoFolder, [...GIT_READONLY_ARGS, "config", "--null", "--get-regexp", "^merge\\."], probe.timeoutMs, PROBE_ENV);
  if (run.code === 1) return false;
  if (run.code !== 0) throw failedGit("git config --get-regexp", run);
  for (const entry of run.stdout.split("\0")) {
    const newline = entry.indexOf("\n");
    const key = (newline < 0 ? entry : entry.slice(0, newline)).toLowerCase();
    const value = newline < 0 ? "" : entry.slice(newline + 1);
    if (/^merge\..+\.[^.]+$/.test(key)) return true;
    if (key === "merge.default" && value !== "text") return true;
  }
  return false;
}

async function mergeTreeUsable(probe: ContentProbe): Promise<boolean> {
  if (probe.mergeTree === "unknown") probe.mergeTree = (await customMergeConfigured(probe)) ? "unusable" : "usable";
  return probe.mergeTree === "usable";
}

/** Only paths that differ between the two sides can reach a content merge; a union or unknown merge attribute on any of them makes the merge result untrustworthy. */
async function differingPathsMergeSafely(probe: ContentProbe, onto: string, commit: string): Promise<boolean> {
  const diff = await runGit(probe.repoFolder, [...GIT_READONLY_ARGS, "diff-tree", "-r", "-z", "--no-renames", "--name-only", onto, commit], probe.timeoutMs, PROBE_ENV);
  if (diff.code !== 0) throw failedGit("git diff-tree", diff);
  if (diff.stdout.split("\0").every((path) => path === "")) return true;
  const attrs = await runGit(probe.repoFolder, [...GIT_READONLY_ARGS, "check-attr", "--stdin", "-z", "merge"], probe.timeoutMs, PROBE_ENV, diff.stdout);
  if (attrs.code !== 0) throw failedGit("git check-attr", attrs);
  const fields = attrs.stdout.split("\0");
  for (let i = 2; i < fields.length; i += 3) {
    if (!SAFE_MERGE_ATTRIBUTE_VALUES.has(fields[i] ?? "")) return false;
  }
  return true;
}

/** True when merging commit into onto leaves onto's tree unchanged; merge-tree writes its result objects into a throwaway object directory so the repository stays untouched. */
async function mergeLeavesTreeUnchanged(probe: ContentProbe, onto: string, commit: string): Promise<boolean | "unusable"> {
  if (!(await differingPathsMergeSafely(probe, onto, commit))) return "unusable";
  const scratch = await scratchObjectDir(probe);
  const run = await runGit(
    probe.repoFolder,
    [...GIT_READONLY_ARGS, "-c", "merge.renormalize=false", "merge-tree", "--write-tree", "--no-messages", onto, commit],
    probe.timeoutMs,
    { ...PROBE_ENV, GIT_OBJECT_DIRECTORY: scratch.objectDir, GIT_ALTERNATE_OBJECT_DIRECTORIES: scratch.alternates },
  );
  // git before 2.38 has no --write-tree and exits with usage.
  if (run.code === 129) {
    probe.mergeTree = "unusable";
    return "unusable";
  }
  if (run.code === 1) return false;
  // A candidate from a history merged in with --allow-unrelated-histories shares no base with the branch.
  if (run.code === 128 && /refusing to merge unrelated histories/.test(run.stderr)) return false;
  if (run.code !== 0) throw failedGit("git merge-tree --write-tree", run);
  const tree = run.stdout.split("\n")[0]?.trim() ?? "";
  const ontoTree = await runGit(probe.repoFolder, [...GIT_READONLY_ARGS, "rev-parse", "--verify", "--quiet", `${onto}^{tree}`], probe.timeoutMs, PROBE_ENV);
  if (ontoTree.code !== 0) throw failedGit("git rev-parse", ontoTree);
  return tree !== "" && tree === ontoTree.stdout.trim();
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

/** Tries targetCommit first so the history scan runs only when the branch's content is not already a no-op merge into today's target. */
async function squashFound(probe: ContentProbe, mergeBase: string, commit: string, targetCommit: string, files: ReadonlySet<string>): Promise<boolean> {
  let touching: TouchingCommit[] | null = null;
  const candidates = async (): Promise<TouchingCommit[]> => (touching ??= await commitsTouchingAll(probe, mergeBase, targetCommit, files));
  if (await mergeTreeUsable(probe)) {
    let result = await mergeLeavesTreeUnchanged(probe, targetCommit, commit);
    for (const candidate of result === false ? await candidates() : []) {
      if (candidate.sha === targetCommit) continue;
      result = await mergeLeavesTreeUnchanged(probe, candidate.sha, commit);
      if (result !== false) break;
    }
    if (result !== "unusable") return result;
  }
  return patchIdFindsContent(probe, mergeBase, commit, await candidates());
}

/** Whether everything commit changed since its merge-base with targetCommit already sits in targetCommit or in one commit on its history. */
async function contentInTarget(probe: ContentProbe, commit: string, targetCommit: string): Promise<ContentResult> {
  if (commit === targetCommit) return { verdict: "merged", mergeBase: commit, files: null };
  const { repoFolder, timeoutMs } = probe;
  const mbRun = await runGit(repoFolder, [...GIT_READONLY_ARGS, "merge-base", targetCommit, commit], timeoutMs, PROBE_ENV);
  const mergeBase = mbRun.code === 0 ? mbRun.stdout.trim() : "";
  if (mergeBase === "") return { verdict: "not_merged", mergeBase: null, files: null };
  if (mergeBase === commit) return { verdict: "merged", mergeBase, files: null };
  if (mergeBase === targetCommit) return { verdict: "target_behind", mergeBase, files: null };

  const filesRun = await runGit(
    repoFolder,
    [...GIT_READONLY_ARGS, "-c", "core.quotePath=false", "diff-tree", "-r", "--no-renames", "--name-only", mergeBase, commit],
    timeoutMs,
    PROBE_ENV,
  );
  if (filesRun.code !== 0) throw failedGit("git diff-tree", filesRun);
  const files = new Set(filesRun.stdout.split("\n").filter((l) => l !== ""));
  if (files.size === 0) return { verdict: "merged", mergeBase, files };
  return { verdict: (await squashFound(probe, mergeBase, commit, targetCommit, files)) ? "merged" : "not_merged", mergeBase, files };
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

/** Whether tip was built on commit by following first parents; a branch merged in from the side, as an integration branch does, may since have been reverted there. */
async function builtOnFirstParent(probe: ContentProbe, tip: string, commit: string): Promise<boolean> {
  const run = await runGit(
    probe.repoFolder,
    [...GIT_READONLY_ARGS, "rev-list", "--first-parent", "--parents", `--max-count=${SQUASH_MERGE_RELAY_DEPTH_MAX}`, tip, `^${commit}`],
    probe.timeoutMs,
    PROBE_ENV,
  );
  if (run.code !== 0) throw failedGit("git rev-list --first-parent", run);
  const lines = run.stdout.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0 || lines.length >= SQUASH_MERGE_RELAY_DEPTH_MAX) return false;
  return lines[lines.length - 1]?.trim().split(" ")[1] === commit;
}

/**
 * Precondition: repoFolder is a git repository and branch names a local branch under refs/heads/.
 * Postcondition: returns true when the branch's changes since its merge-base with a main/master target ref already sit in that target or in one commit on its history (merging the branch there changes nothing), or when a branch or remote-tracking ref built on the branch along its first-parent line passes the same test while retaining or refining every file and hunk the branch changed; any conflict, reverted hunk, leftover change, or doubt counts as not merged. Uses merge-tree only while git config defines no custom merge driver and every path it could merge uses git's text or binary merge, so no configured command ever runs; otherwise, or when git lacks merge-tree --write-tree, falls back to comparing git patch-ids. Never writes an object or ref into the repository.
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
    const own = new Map<string, ContentResult>();
    for (const target of targetCommits) {
      const result = await contentInTarget(probe, branchCommit, target);
      if (result.verdict === "merged") return true;
      own.set(target, result);
    }
    // Every target is an ancestor of the branch, so nothing containing the branch can be on main either.
    if ([...own.values()].every((result) => result.verdict === "target_behind")) return false;
    for (const containing of await refsContaining(probe, branchCommit, ownRef)) {
      if (!(await builtOnFirstParent(probe, containing, branchCommit))) continue;
      for (const [target, result] of own) {
        if (result.mergeBase === null || result.files === null || result.files.size === 0) continue;
        const containingResult = await contentInTarget(probe, containing, target);
        if (containingResult.verdict !== "merged" || containingResult.mergeBase === null) continue;
        if (
          await verifyRelayCarriesChanges({
            repoFolder,
            timeoutMs,
            ownMergeBase: result.mergeBase,
            branchCommit,
            containingMergeBase: containingResult.mergeBase,
            containingCommit: containing,
          })
        ) {
          return true;
        }
      }
    }
    return false;
  } finally {
    if (probe.scratch !== null) await rm(probe.scratch.objectDir, { recursive: true, force: true }).catch(() => {});
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
