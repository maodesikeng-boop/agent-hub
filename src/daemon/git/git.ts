import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { WorkspaceProbe } from "../../shared/ledger.ts";
import { GIT_MAX_BUFFER_BYTES, GIT_PROBE_TIMEOUT_MS, GIT_TIMEOUT_MS, RESOURCES_SAMPLE_PATHS_MAX } from "../../shared/limits.ts";
import { findExecutable } from "../../shared/paths.ts";
import { firstEnvKey, normalizePathForComparison, resolveSpawn } from "../platform/index.ts";

/** A repo's core.fsmonitor can point at a script that git runs while reading the index, so untrusted repos are listed with it disabled and without optional locks. */
export const GIT_READONLY_ARGS: readonly string[] = ["-c", "core.fsmonitor=false", "-c", "gc.auto=0"];
export const GIT_READONLY_ENV: Readonly<Record<string, string>> = { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };

export interface GitOptions {
  timeoutMs?: number;
}

export interface AddWorktreeOptions extends GitOptions {
  repoFolder: string;
  worktreePath: string;
  branch: string | null;
  base?: string;
  prepareDir?: (worktreePath: string) => Promise<void> | void;
}

export interface AddWorktreeResult {
  created: boolean;
  baseCommit: string;
}

export type GitErrorKind =
  | "git_missing"
  | "timeout"
  | "git_failed"
  | "branch_taken"
  | "path_taken";

export class GitError extends Error {
  readonly kind: GitErrorKind;
  constructor(kind: GitErrorKind, message: string) {
    super(message);
    this.name = "GitError";
    this.kind = kind;
  }
}

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

function preferGitForWindowsMingw(foundPath: string): string {
  const match = /^(.*)[\\/]cmd[\\/]git\.exe$/i.exec(foundPath);
  if (!match) return foundPath;
  const mingwCandidate = join(match[1]!, "mingw64", "bin", "git.exe");
  return existsSync(mingwCandidate) ? mingwCandidate : foundPath;
}

function resolveGitInvocation(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): { file: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (process.platform !== "win32") {
    return { file: "git", args: [...args] };
  }
  const pathKey = firstEnvKey(env, "PATH");
  const envPath = pathKey ? env[pathKey] : undefined;
  const pathExtKey = firstEnvKey(env, "PATHEXT");
  const pathExt = pathExtKey ? env[pathExtKey] : undefined;
  const found = findExecutable("git", envPath, [], { platform: "win32", pathExt });
  if (found === null) {
    return { file: "git", args: [...args] };
  }
  const upgraded = preferGitForWindowsMingw(found);
  const spawned = resolveSpawn({ program: upgraded, args, env }, "win32");
  return {
    file: spawned.file,
    args: spawned.args,
    windowsVerbatimArguments: spawned.options.windowsVerbatimArguments,
  };
}

/** Non-zero exits are returned for the caller to judge; only a missing git binary or a timeout throws. */
export function runGit(
  folder: string,
  args: string[],
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
  stdin?: string,
): Promise<GitRun> {
  return new Promise((resolvePromise, reject) => {
    const prefixArgs =
      process.platform === "win32"
        ? ["-c", "core.longpaths=true", "-C", folder]
        : ["-C", folder];
    const fullEnv: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv };
    const invocation = resolveGitInvocation([...prefixArgs, ...args], fullEnv);
    const child = execFile(
      invocation.file,
      invocation.args,
      {
        timeout: timeoutMs,
        ...(process.platform === "win32"
          ? { windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments }
          : { killSignal: "SIGKILL" as const }),
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        encoding: "utf8",
        env: fullEnv,
      },
      (error, stdout, stderr) => {
        if (!error) return resolvePromise({ code: 0, stdout, stderr });
        const err = error as NodeJS.ErrnoException & { killed?: boolean };
        if (err.killed) return reject(new GitError("timeout", `git 超过 ${Math.round(timeoutMs / 1000)} 秒没有结束，已中止（git ${args.join(" ")}）。`));
        if (err.code === "ENOENT") return reject(new GitError("git_missing", "找不到 git 程序，请先安装 git，并确认它在 PATH 里。"));
        if (typeof err.code === "number") return resolvePromise({ code: err.code, stdout, stderr });
        reject(new GitError("git_failed", `git 没能运行：${err.message}`));
      },
    );
    if (stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    }
  });
}

export function failedGit(what: string, run: GitRun): GitError {
  const detail = run.stderr.trim() || run.stdout.trim() || `退出码 ${run.code}`;
  return new GitError("git_failed", `${what} 失败：${detail}`);
}

const failed = failedGit;

export async function isRepoWithCommit(folder: string, options: GitOptions = {}): Promise<boolean> {
  const run = await runGit(folder, ["rev-parse", "--verify", "--quiet", "HEAD"], options.timeoutMs ?? GIT_TIMEOUT_MS, { LC_ALL: "C" });
  if (run.code === 0) return true;
  if (run.code === 1 && run.stderr.trim() === "") return false;
  if (run.code === 128 && /not a git repository/i.test(run.stderr)) return false;
  throw failed("git rev-parse", run);
}

export async function hasUncommittedChanges(folder: string, options: GitOptions = {}): Promise<boolean> {
  const run = await runGit(folder, ["--no-optional-locks", "status", "--porcelain"], options.timeoutMs ?? GIT_TIMEOUT_MS);
  if (run.code !== 0) throw failed("git status", run);
  return run.stdout.trim().length > 0;
}

export async function probeWorkspace(folder: string, options: GitOptions = {}): Promise<WorkspaceProbe> {
  const timeoutMs = options.timeoutMs ?? GIT_PROBE_TIMEOUT_MS;
  try {
    const isRepo = await isRepoWithCommit(folder, { timeoutMs });
    const dirty = isRepo ? await hasUncommittedChanges(folder, { timeoutMs }) : false;
    return { kind: "ok", isRepoWithCommit: isRepo, hasUncommittedChanges: dirty };
  } catch (error) {
    return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

/** git locks a worktree with this reason during add (builtin/worktree.c); if it is still locked, a previous add was killed and left a partial checkout. add runs with LC_ALL=C so the text is not translated. */
const INITIALIZING_LOCK = "initializing";

export async function addWorktree(options: AddWorktreeOptions): Promise<AddWorktreeResult> {
  const { repoFolder, worktreePath, branch, base = "HEAD" } = options;
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const git = (args: string[]) => runGit(repoFolder, args, timeoutMs);

  const baseRun = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${base}^{commit}`]);
  if (baseRun.code !== 0) throw new GitError("git_failed", `${repoFolder} 里找不到基准“${base}”（要是仓库里的一个提交）。`);
  const baseCommit = baseRun.stdout.trim();

  const listRun = await git(["-c", "core.quotePath=false", "worktree", "list", "--porcelain"]);
  if (listRun.code !== 0) throw failed("git worktree list", listRun);
  let existing = findWorktree(parseWorktreeList(listRun.stdout), worktreePath);
  if (existing?.locked === INITIALIZING_LOCK) {
    // A locked worktree needs two -f flags to be removed.
    const removeRun = await git(["worktree", "remove", "-f", "-f", existing.path]);
    if (removeRun.code !== 0) throw failed("git worktree remove（清掉没建完的 worktree）", removeRun);
    if (branch !== null && existing.branch === `refs/heads/${branch}`) {
      const deleteRun = await git(["branch", "-D", branch]);
      if (deleteRun.code !== 0) throw failed("git branch -D（清掉没建完的 worktree 的分支）", deleteRun);
    }
    existing = undefined;
  }
  if (existing) {
    const want = branch === null ? null : `refs/heads/${branch}`;
    if (existing.branch !== want) {
      const now = existing.branch ? existing.branch.replace(/^refs\/heads\//, "") : "（没有分支）";
      throw new GitError("path_taken", `${worktreePath} 已经是分支 ${now} 的 worktree，不是 ${branch ?? "detached"}。`);
    }
    if (branch === null) {
      const head = await resolveCommit(existing.path, "HEAD", { timeoutMs });
      return { created: false, baseCommit: head ?? baseCommit };
    }
    const mergeBase = await git(["merge-base", `refs/heads/${branch}`, baseCommit]);
    return { created: false, baseCommit: mergeBase.code === 0 ? mergeBase.stdout.trim() : baseCommit };
  }

  if (branch !== null) {
    const branchRun = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (branchRun.code === 0) throw new GitError("branch_taken", `分支 ${branch} 已经存在（可能是别的 Worker 占着），没法再建。`);
  }

  await options.prepareDir?.(worktreePath);

  const checkout = branch === null ? ["--detach", worktreePath, baseCommit] : ["-b", branch, worktreePath, baseCommit];
  const addRun = await runGit(repoFolder, ["worktree", "add", ...checkout], timeoutMs, { LC_ALL: "C" });
  if (addRun.code !== 0) throw failed("git worktree add", addRun);
  return { created: true, baseCommit };
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
  locked: string | null;
}

export function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of output.replace(/\r\n/g, "\n").split(/\n\s*\n/)) {
    let path: string | null = null;
    let branch: string | null = null;
    let locked: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length);
      else if (line === "locked" || line.startsWith("locked ")) locked = line.slice("locked".length).trim();
    }
    if (path !== null) entries.push({ path, branch, locked });
  }
  return entries;
}

/** git records real paths (macOS /var is /private/var), so both sides are compared after realpath. */
function findWorktree(entries: WorktreeEntry[], worktreePath: string): WorktreeEntry | undefined {
  const target = normalizePathForComparison(realpathLoose(worktreePath));
  return entries.find((entry) => normalizePathForComparison(realpathLoose(entry.path)) === target);
}

/** realpath of a path that does not exist yet resolves its nearest existing parent. */
export function realpathLoose(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(realpathLoose(parent), basename(absolute));
  }
}

export const MAIN_TARGET_REFS = [
  "refs/remotes/origin/main",
  "refs/heads/main",
  "refs/remotes/origin/master",
  "refs/heads/master",
] as const;

export async function isBranchMergedToMain(
  repoFolder: string,
  branch: string,
  baseCommit: string | null,
  options: GitOptions = {},
): Promise<boolean> {
  if (baseCommit === null) return false;
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const branchRef = `refs/heads/${branch}`;
  const refsRun = await runGit(
    repoFolder,
    ["for-each-ref", "--format=%(refname) %(objectname)", branchRef, ...MAIN_TARGET_REFS],
    timeoutMs,
  );
  if (refsRun.code !== 0) throw failed("git for-each-ref", refsRun);

  let branchCommit: string | null = null;
  const targetCommits = new Set<string>();
  for (const line of refsRun.stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const space = trimmed.lastIndexOf(" ");
    if (space <= 0) continue;
    const ref = trimmed.slice(0, space);
    const sha = trimmed.slice(space + 1);
    if (ref === branchRef) branchCommit = sha;
    else targetCommits.add(sha);
  }
  if (branchCommit === null || branchCommit === baseCommit) return false;

  for (const targetCommit of targetCommits) {
    if (branchCommit === targetCommit) return true;
    const ancRun = await runGit(repoFolder, ["merge-base", "--is-ancestor", branchCommit, targetCommit], timeoutMs);
    if (ancRun.code === 0) return true;
    if (ancRun.code !== 1) throw failed("git merge-base --is-ancestor", ancRun);
  }
  return false;
}

export type WorktreeRemovalProbe =
  | {
      kind: "ok";
      isRepoWithCommit: boolean;
      hasContent: boolean;
      onBranch: boolean;
      head: string | null;
      /** Mid-operation states leave HEAD and the work tree inconsistent, so the directory is never deleted. */
      inProgress: boolean;
      uncommittedCount: number;
      untrackedCount: number;
      samplePaths: string[];
    }
  | { kind: "failed"; error: string };

const MISSING_TRACKED_FILE = "1 .D N... ";

const IN_PROGRESS_GIT_PATHS = [
  "rebase-merge",
  "rebase-apply",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "sequencer",
  "BISECT_LOG",
] as const;

function parsePorcelainV2Path(line: string): string | null {
  if (line.startsWith("? ")) return line.slice(2) || null;
  if (line.startsWith("1 ")) return parsePorcelainV2OrdinaryPath(line);
  if (line.startsWith("2 ")) {
    const tab = line.indexOf("\t");
    const head = tab === -1 ? line : line.slice(0, tab);
    let pos = 0;
    for (let i = 0; i < 9; i++) {
      pos = head.indexOf(" ", pos);
      if (pos === -1) return null;
      pos++;
    }
    return pos < head.length ? head.slice(pos) : null;
  }
  if (line.startsWith("u ")) {
    let pos = 0;
    for (let i = 0; i < 10; i++) {
      pos = line.indexOf(" ", pos);
      if (pos === -1) return null;
      pos++;
    }
    return pos < line.length ? line.slice(pos) : null;
  }
  return null;
}

export async function probeWorktreeForRemoval(worktreePath: string, options: GitOptions = {}): Promise<WorktreeRemovalProbe> {
  const timeoutMs = options.timeoutMs ?? GIT_PROBE_TIMEOUT_MS;
  try {
    const run = await runGit(
      worktreePath,
      [...GIT_READONLY_ARGS, "-c", "core.quotePath=false", "status", "--porcelain=v2", "--branch", "--untracked-files=normal", "--ignore-submodules=none"],
      timeoutMs,
      { ...GIT_READONLY_ENV, LC_ALL: "C" },
    );
    if (run.code === 128 && /not a git repository/i.test(run.stderr)) {
      return {
        kind: "ok",
        isRepoWithCommit: false,
        hasContent: true,
        onBranch: false,
        head: null,
        inProgress: false,
        uncommittedCount: 0,
        untrackedCount: 0,
        samplePaths: [],
      };
    }
    if (run.code !== 0) throw failed("git status", run);
    let hasCommit = true;
    let onBranch = false;
    let hasContent = false;
    let head: string | null = null;
    let uncommittedCount = 0;
    let untrackedCount = 0;
    const samplePaths: string[] = [];
    for (const line of run.stdout.split("\n")) {
      if (line === "") continue;
      if (line === "# branch.oid (initial)") hasCommit = false;
      else if (line.startsWith("# branch.oid ")) head = line.slice("# branch.oid ".length);
      else if (line.startsWith("# branch.head ")) onBranch = line !== "# branch.head (detached)";
      else if (!line.startsWith("# ") && !line.startsWith(MISSING_TRACKED_FILE)) {
        hasContent = true;
        if (line.startsWith("? ")) untrackedCount++;
        else uncommittedCount++;
        if (samplePaths.length < RESOURCES_SAMPLE_PATHS_MAX) {
          const p = parsePorcelainV2Path(line);
          if (p !== null && !samplePaths.includes(p)) samplePaths.push(p);
        }
      }
    }
    const inProgress = await hasOperationInProgress(worktreePath, timeoutMs);
    return {
      kind: "ok",
      isRepoWithCommit: hasCommit,
      hasContent,
      onBranch,
      head: hasCommit ? head : null,
      inProgress,
      uncommittedCount,
      untrackedCount,
      samplePaths,
    };
  } catch (error) {
    return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

async function hasOperationInProgress(worktreePath: string, timeoutMs: number): Promise<boolean> {
  const args = ["rev-parse", "--path-format=absolute"];
  for (const name of IN_PROGRESS_GIT_PATHS) args.push("--git-path", name);
  const run = await runGit(worktreePath, [...GIT_READONLY_ARGS, ...args], timeoutMs, { ...GIT_READONLY_ENV, LC_ALL: "C" });
  if (run.code !== 0) throw failed("git rev-parse --git-path", run);
  return run.stdout
    .split("\n")
    .map((line) => line.trim())
    .some((path) => path !== "" && existsSync(path));
}

export async function resolveCommit(folder: string, ref: string, options: GitOptions = {}): Promise<string | null> {
  if (ref.trim() === "" || ref.startsWith("-")) return null;
  const run = await runGit(
    folder,
    [...GIT_READONLY_ARGS, "rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
    options.timeoutMs ?? GIT_PROBE_TIMEOUT_MS,
    { ...GIT_READONLY_ENV, LC_ALL: "C" },
  );
  if (run.code === 0) {
    const sha = run.stdout.trim();
    return sha === "" ? null : sha;
  }
  if ((run.code === 1 || run.code === 128) && run.stderr.trim() === "") return null;
  if (run.code === 128 && /not a git repository/i.test(run.stderr)) return null;
  throw failed("git rev-parse", run);
}

export async function remoteBranchHead(repoFolder: string, branch: string, options: GitOptions = {}): Promise<string | null | undefined> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const remoteRun = await runGit(repoFolder, ["remote"], timeoutMs);
  if (remoteRun.code !== 0) throw failed("git remote", remoteRun);
  if (!remoteRun.stdout.split("\n").some((line) => line.trim() === "origin")) return undefined;
  const run = await runGit(repoFolder, ["ls-remote", "origin", `refs/heads/${branch}`], timeoutMs, { LC_ALL: "C" });
  if (run.code !== 0) throw failed("git ls-remote", run);
  const line = run.stdout.split("\n").find((l) => l.endsWith(`\trefs/heads/${branch}`));
  return line === undefined ? null : line.split("\t")[0]!;
}

export async function isCommitMergedToMain(repoFolder: string, commit: string, options: GitOptions = {}): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const refsRun = await runGit(repoFolder, ["for-each-ref", "--format=%(objectname)", ...MAIN_TARGET_REFS], timeoutMs);
  if (refsRun.code !== 0) throw failed("git for-each-ref", refsRun);
  for (const target of new Set(refsRun.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== ""))) {
    if (target === commit) return true;
    const ancRun = await runGit(repoFolder, ["merge-base", "--is-ancestor", commit, target], timeoutMs);
    if (ancRun.code === 0) return true;
    if (ancRun.code !== 1) throw failed("git merge-base --is-ancestor", ancRun);
  }
  return false;
}

/** Commits on a detached HEAD would vanish with the worktree, so unreachable ones get a branch first. */
export async function pinDetachedHead(repoFolder: string, head: string, label: string, options: GitOptions = {}): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const containing = await runGit(
    repoFolder,
    ["for-each-ref", "--contains", head, "--count=1", "--format=%(refname)", "refs/heads", ...MAIN_TARGET_REFS],
    timeoutMs,
  );
  if (containing.code !== 0) throw failed("git for-each-ref --contains", containing);
  if (containing.stdout.trim() !== "") return null;
  const name = `hub/detached-${label}-${head.slice(0, 8)}`;
  const created = await runGit(repoFolder, ["branch", "--", name, head], timeoutMs, { LC_ALL: "C" });
  if (created.code !== 0) {
    // A previous run created the branch and then failed later; the branch already on this commit counts as success.
    if ((await resolveCommit(repoFolder, `refs/heads/${name}`, options)) !== head) throw failed("git branch", created);
  }
  return name;
}

export type WorktreeLink = "linked" | "orphan";

/** Checks only the filesystem because git refuses to run once .git is gone. */
export function inspectWorktreeLink(worktreePath: string): WorktreeLink {
  const dotGit = join(worktreePath, ".git");
  let stat;
  try {
    stat = lstatSync(dotGit);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "orphan" : "linked";
  }
  if (!stat.isFile()) return "linked";
  let text: string;
  try {
    text = readFileSync(dotGit, "utf8");
  } catch {
    return "linked";
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (match === null) return "linked";
  const target = isAbsolute(match[1]!) ? match[1]! : resolve(worktreePath, match[1]!);
  return existsSync(join(target, "HEAD")) ? "linked" : "orphan";
}

export type OrphanContentProbe = { kind: "ok"; hasContent: boolean; samplePaths?: string[]; dirtyCount?: number } | { kind: "failed"; error: string };

export interface ProbeOrphanOptions extends GitOptions {
  /** After the branch is deleted and main moves on, untouched files in an orphan dir still match the base commit, so it is included to avoid false positives. */
  baseCommit?: string | null;
  includeSamples?: boolean;
}

const ORPHAN_PATHSPEC_CHUNK = 500;
const ORPHAN_HISTORY_COMMIT_LIMIT = 16;

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

async function hasCheckoutRemnant(repoFolder: string, dir: string, commits: readonly string[], timeoutMs: number): Promise<boolean> {
  for (const commit of commits) {
    const run = await runGit(repoFolder, [...GIT_READONLY_ARGS, "ls-tree", "-z", "--name-only", commit], timeoutMs, {
      ...GIT_READONLY_ENV,
      LC_ALL: "C",
    });
    if (run.code !== 0) throw failed("git ls-tree", run);
    if (run.stdout.split("\0").some((name) => name !== "" && lstatExists(join(dir, name)))) return true;
  }
  return false;
}

function parsePorcelainV2OrdinaryPath(record: string): string | null {
  let pos = 0;
  for (let i = 0; i < 8; i++) {
    pos = record.indexOf(" ", pos);
    if (pos === -1) return null;
    pos++;
  }
  return pos < record.length ? record.slice(pos) : null;
}

export async function probeOrphanContent(
  repoFolder: string,
  orphanPath: string,
  ref: string | null,
  options: ProbeOrphanOptions = {},
): Promise<OrphanContentProbe> {
  const timeoutMs = options.timeoutMs ?? GIT_PROBE_TIMEOUT_MS;
  let tmp: string | null = null;
  try {
    const common = await runGit(
      repoFolder,
      [...GIT_READONLY_ARGS, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      timeoutMs,
      { ...GIT_READONLY_ENV, LC_ALL: "C" },
    );
    if (common.code !== 0) throw failed("git rev-parse --git-common-dir", common);
    const gitDir = common.stdout.trim();

    const commits: string[] = [];
    const seenCommits = new Set<string>();
    const addCommit = (sha: string | null) => {
      if (sha !== null && sha !== "" && !seenCommits.has(sha)) {
        seenCommits.add(sha);
        commits.push(sha);
      }
    };

    if (ref !== null) {
      const resolvedRef = await resolveCommit(repoFolder, ref, { timeoutMs });
      if (resolvedRef === null) throw new GitError("git_failed", `git read-tree 失败：找不到基准引用 ${ref}`);
      addCommit(resolvedRef);
    }

    const mainRefsRun = await runGit(
      repoFolder,
      [...GIT_READONLY_ARGS, "for-each-ref", "--format=%(objectname)", ...MAIN_TARGET_REFS],
      timeoutMs,
      { ...GIT_READONLY_ENV, LC_ALL: "C" },
    );
    if (mainRefsRun.code !== 0) throw failed("git for-each-ref", mainRefsRun);
    const mainCommits: string[] = [];
    for (const line of mainRefsRun.stdout.split("\n")) {
      const sha = line.trim();
      if (sha !== "" && !mainCommits.includes(sha)) mainCommits.push(sha);
    }
    const repoHead = await resolveCommit(repoFolder, "HEAD", { timeoutMs });
    if (repoHead !== null && !mainCommits.includes(repoHead)) mainCommits.push(repoHead);
    for (const sha of mainCommits) addCommit(sha);

    const resolvedBase = options.baseCommit ? await resolveCommit(repoFolder, options.baseCommit, { timeoutMs }) : null;
    addCommit(resolvedBase);

    if (commits.length > 0 && !(await hasCheckoutRemnant(repoFolder, orphanPath, commits, timeoutMs))) {
      return { kind: "ok", hasContent: false };
    }

    tmp = await mkdtemp(join(tmpdir(), "agent-hub-orphan-"));
    const env = { ...GIT_READONLY_ENV, LC_ALL: "C", GIT_DIR: gitDir, GIT_WORK_TREE: orphanPath, GIT_INDEX_FILE: join(tmp, "index") };

    const checkAgainst = async (commit: string | null, filterPaths: string[] | null): Promise<{ unknownFormat: boolean; paths: string[] }> => {
      if (commit !== null) {
        const read = await runGit(orphanPath, [...GIT_READONLY_ARGS, "read-tree", commit], timeoutMs, env);
        if (read.code !== 0) throw failed("git read-tree", read);
        const lsIgnores = await runGit(
          orphanPath,
          [...GIT_READONLY_ARGS, "ls-files", "-z", "--", ".gitignore", ":(glob)**/.gitignore"],
          timeoutMs,
          env,
        );
        if (lsIgnores.code !== 0) throw failed("git ls-files", lsIgnores);
        const missingIgnores = lsIgnores.stdout
          .split("\0")
          .filter((relPath) => relPath !== "" && !lstatExists(join(orphanPath, relPath)));
        if (missingIgnores.length > 0) {
          const skip = await runGit(
            orphanPath,
            [...GIT_READONLY_ARGS, "update-index", "--skip-worktree", "-z", "--stdin"],
            timeoutMs,
            env,
            `${missingIgnores.join("\0")}\0`,
          );
          if (skip.code !== 0) throw failed("git update-index", skip);
        }
      }

      const chunks: Array<string[] | null> = [];
      if (filterPaths === null) {
        chunks.push(null);
      } else {
        for (let i = 0; i < filterPaths.length; i += ORPHAN_PATHSPEC_CHUNK) {
          chunks.push(filterPaths.slice(i, i + ORPHAN_PATHSPEC_CHUNK));
        }
      }

      const remaining: string[] = [];
      const seenPaths = new Set<string>();
      for (const chunk of chunks) {
        const status = await runGit(
          orphanPath,
          [
            ...GIT_READONLY_ARGS,
            ...(chunk === null ? [] : ["--literal-pathspecs"]),
            "status",
            "--porcelain=v2",
            "-z",
            "--no-renames",
            "--untracked-files=normal",
            "--ignore-submodules=none",
            ...(chunk === null ? [] : ["--", ...chunk]),
          ],
          timeoutMs,
          env,
        );
        if (status.code !== 0) throw failed("git status", status);
        for (const record of status.stdout.split("\0")) {
          if (record === "" || record === "? .git") continue;
          if (record.startsWith("? ")) {
            const p = record.slice(2);
            if (!seenPaths.has(p)) {
              seenPaths.add(p);
              remaining.push(p);
            }
            continue;
          }
          // Tracked files only compare the work tree against the index (second XY character).
          if (record.startsWith("1 ")) {
            if (record[3] === "." || record[3] === "D") continue;
            const p = parsePorcelainV2OrdinaryPath(record);
            if (p === null) return { unknownFormat: true, paths: [] };
            if (!seenPaths.has(p)) {
              seenPaths.add(p);
              remaining.push(p);
            }
            continue;
          }
          return { unknownFormat: true, paths: [] };
        }
      }
      return { unknownFormat: false, paths: remaining };
    };

    const ok = (hasContent: boolean, paths: string[] = []): OrphanContentProbe =>
      options.includeSamples
        ? { kind: "ok", hasContent, samplePaths: paths.slice(0, RESOURCES_SAMPLE_PATHS_MAX), dirtyCount: hasContent ? Math.max(1, paths.length) : 0 }
        : { kind: "ok", hasContent };

    if (commits.length === 0) {
      const res = await checkAgainst(null, null);
      return ok(res.unknownFormat || res.paths.length > 0, res.paths);
    }

    let suspectPaths: string[] | null = null;
    for (const commit of commits) {
      const res = await checkAgainst(commit, suspectPaths);
      if (res.unknownFormat) return ok(true);
      suspectPaths = res.paths;
      if (suspectPaths.length === 0) return ok(false);
    }

    if (
      suspectPaths !== null &&
      suspectPaths.length > 0 &&
      resolvedBase !== null &&
      mainCommits.length > 0 &&
      suspectPaths.length <= ORPHAN_PATHSPEC_CHUNK
    ) {
      const revRun = await runGit(
        repoFolder,
        [
          ...GIT_READONLY_ARGS,
          "--literal-pathspecs",
          "rev-list",
          `--max-count=${ORPHAN_HISTORY_COMMIT_LIMIT}`,
          `^${resolvedBase}`,
          ...mainCommits,
          "--",
          ...suspectPaths,
        ],
        timeoutMs,
        { ...GIT_READONLY_ENV, LC_ALL: "C" },
      );
      if (revRun.code === 0) {
        for (const rawSha of revRun.stdout.split("\n")) {
          const sha = rawSha.trim();
          if (sha === "" || seenCommits.has(sha)) continue;
          seenCommits.add(sha);
          const res = await checkAgainst(sha, suspectPaths);
          if (res.unknownFormat) return ok(true);
          suspectPaths = res.paths;
          if (suspectPaths.length === 0) return ok(false);
        }
      }
    }

    return ok(true, suspectPaths ?? []);
  } catch (error) {
    return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (tmp !== null) await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

export async function moveWorktree(repoFolder: string, worktreePath: string, intoDir: string, options: GitOptions = {}): Promise<void> {
  const run = await runGit(repoFolder, ["worktree", "move", worktreePath, intoDir], options.timeoutMs ?? GIT_TIMEOUT_MS, { LC_ALL: "C" });
  if (run.code !== 0) throw failed("git worktree move", run);
}

export async function pruneWorktrees(repoFolder: string, options: GitOptions = {}): Promise<void> {
  const run = await runGit(repoFolder, ["worktree", "prune"], options.timeoutMs ?? GIT_TIMEOUT_MS, { LC_ALL: "C" });
  if (run.code !== 0) throw failed("git worktree prune", run);
}

export interface DiffFileStat {
  file: string;
  /** git prints "-" for binary files. */
  added: number | null;
  deleted: number | null;
}

export function parseDiffNumstatZ(stdout: string): DiffFileStat[] {
  const out: DiffFileStat[] = [];
  for (const record of stdout.split("\0")) {
    if (record === "") continue;
    const firstTab = record.indexOf("\t");
    if (firstTab === -1) continue;
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (secondTab === -1) continue;
    const rawAdd = record.slice(0, firstTab);
    const rawDel = record.slice(firstTab + 1, secondTab);
    const file = record.slice(secondTab + 1);
    if (file === "") continue;
    const added = rawAdd === "-" ? null : Number.parseInt(rawAdd, 10);
    const deleted = rawDel === "-" ? null : Number.parseInt(rawDel, 10);
    out.push({
      file,
      added: added !== null && Number.isFinite(added) ? added : null,
      deleted: deleted !== null && Number.isFinite(deleted) ? deleted : null,
    });
  }
  return out;
}

export async function probeDiffNumstat(
  repoFolder: string,
  branch: string,
  options: GitOptions & { baseCommit?: string | null } = {},
): Promise<DiffFileStat[] | null> {
  const trimmed = branch.trim();
  if (trimmed === "" || trimmed.startsWith("-")) return null;
  const timeoutMs = options.timeoutMs ?? GIT_PROBE_TIMEOUT_MS;
  const ranges = [`HEAD...${trimmed}`];
  if (options.baseCommit && /^[0-9a-f]{7,64}$/i.test(options.baseCommit)) {
    ranges.push(`${options.baseCommit}...${trimmed}`);
  }
  for (const range of ranges) {
    try {
      const run = await runGit(
        repoFolder,
        [...GIT_READONLY_ARGS, "-c", "core.quotepath=false", "diff", "--numstat", "--no-renames", "-z", range, "--"],
        timeoutMs,
        { ...GIT_READONLY_ENV, LC_ALL: "C" },
      );
      if (run.code === 0) return parseDiffNumstatZ(run.stdout);
    } catch {
      return null;
    }
  }
  return null;
}

export interface LocalBranchInfo {
  readonly name: string;
  readonly commit: string;
  readonly checkedOutPath: string | null;
}


