// git 操作（M3 W1）：判断主文件夹是不是有提交的仓库、有没有没提交的改动、给 Worker 建 worktree。
// 用 execFile 直接调 git，不经过 shell；每次调用都有超时；拿不到的错误转成 GitError（中文信息 + kind）。
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { WorkspaceProbe } from "../../shared/ledger.ts";
import { GIT_PROBE_TIMEOUT_MS } from "../../shared/limits.ts";

/** 一次 git 调用最多等多久（毫秒）；超了就 SIGKILL 掉 git。调用时可以用 timeoutMs 改。 */
export const GIT_TIMEOUT_MS = 30_000;
/** git 输出最多收多少字节（status 遇到大量没跟踪的文件会很长）。 */
export const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export interface GitOptions {
  /** 一次 git 调用的超时（毫秒），默认 GIT_TIMEOUT_MS。 */
  timeoutMs?: number;
}

export interface AddWorktreeOptions extends GitOptions {
  /** 主文件夹（git 仓库）。 */
  repoFolder: string;
  /** worktree 放哪。上一级目录不存在时 git 会自己建。 */
  worktreePath: string;
  /** 新分支名，比如 `hub/7-fix-x`。 */
  branch: string;
  /** 从哪个提交起，默认 `HEAD`（主文件夹当前分支的最新提交）。 */
  base?: string;
}

export interface AddWorktreeResult {
  /** 这次新建了 worktree；false 表示它本来就在（重复执行）。 */
  created: boolean;
  /** worktree 起点的完整提交号。重复执行时是分支和基准的共同祖先，一般就是第一次的起点。 */
  baseCommit: string;
}

export type GitErrorKind =
  | "git_missing" // 找不到 git 程序
  | "timeout" // 超时
  | "git_failed" // git 退出码非 0
  | "branch_taken" // 分支名已经有了，而且不是我们要的那个 worktree
  | "path_taken"; // 目录已经是别的分支的 worktree

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

/**
 * 跑一次 git。退出码非 0 不抛，交给调用方判断；找不到 git、超时才抛 GitError。
 * 一律 `git -C <folder>`：文件夹不存在也只是退出码 128，不会和“找不到 git”混在一起。
 */
function runGit(folder: string, args: string[], timeoutMs: number, extraEnv: Record<string, string> = {}): Promise<GitRun> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      ["-C", folder, ...args],
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: GIT_MAX_BUFFER_BYTES, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv } },
      (error, stdout, stderr) => {
        if (!error) return resolvePromise({ code: 0, stdout, stderr });
        const err = error as NodeJS.ErrnoException & { killed?: boolean };
        if (err.killed) return reject(new GitError("timeout", `git 超过 ${Math.round(timeoutMs / 1000)} 秒没有结束，已中止（git ${args.join(" ")}）。`));
        if (err.code === "ENOENT") return reject(new GitError("git_missing", "找不到 git 程序，请先安装 git，并确认它在 PATH 里。"));
        if (typeof err.code === "number") return resolvePromise({ code: err.code, stdout, stderr });
        reject(new GitError("git_failed", `git 没能运行：${err.message}`));
      },
    );
  });
}

/** git 退出码非 0 当成错误；`what` 是给人看的命令名，比如 "git worktree add"。 */
function failed(what: string, run: GitRun): GitError {
  const detail = run.stderr.trim() || run.stdout.trim() || `退出码 ${run.code}`;
  return new GitError("git_failed", `${what} 失败：${detail}`);
}

/**
 * 是 git 仓库，而且至少有一次提交（`git rev-parse --verify --quiet HEAD` 成功）。
 * 只有 git 正常跑完、明确答了“否”才返回 false：不是仓库（退出码 128，“not a git repository”）、还没有提交（退出码 1、不出声）。
 * 别的情况一律抛 GitError，不当成“不是仓库”：超时、找不到 git、文件夹不存在、别的非零退出（比如 Xcode 许可证没同意）。
 * 认“not a git repository”要英文的提示，所以这一次用 LC_ALL=C 跑。
 */
export async function isRepoWithCommit(folder: string, options: GitOptions = {}): Promise<boolean> {
  const run = await runGit(folder, ["rev-parse", "--verify", "--quiet", "HEAD"], options.timeoutMs ?? GIT_TIMEOUT_MS, { LC_ALL: "C" });
  if (run.code === 0) return true;
  if (run.code === 1 && run.stderr.trim() === "") return false;
  if (run.code === 128 && /not a git repository/i.test(run.stderr)) return false;
  throw failed("git rev-parse", run);
}

/** 有没提交的改动：已跟踪的文件改了、已暂存、有没跟踪的文件，任何一种都算。不是仓库会抛 GitError。 */
export async function hasUncommittedChanges(folder: string, options: GitOptions = {}): Promise<boolean> {
  const run = await runGit(folder, ["--no-optional-locks", "status", "--porcelain"], options.timeoutMs ?? GIT_TIMEOUT_MS);
  if (run.code !== 0) throw failed("git status", run);
  return run.stdout.trim().length > 0;
}

/**
 * hub worker start 之前探主文件夹（agent 接口调，结果交给账本的 hubCall，m3-plan 第 2.6 节）：是不是有提交的仓库，
 * 是的话再看有没有没提交的改动。每次 git 调用最多 timeoutMs（默认 GIT_PROBE_TIMEOUT_MS）。
 * 不抛错：git 没跑成（见 isRepoWithCommit）返回 failed，原因写在 error 里。
 */
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

/**
 * 建 worktree：`git worktree add -b <branch> <worktreePath> <base>`。
 * 重复执行算成功：worktree 已经在这个目录、分支也对得上，就直接返回 `created: false`，不动里面的东西。
 * 分支名已经有了（比如别的 Worker 占着）、目录已经是别的分支的 worktree，报清楚的错（kind 是 branch_taken、path_taken）。
 */
export async function addWorktree(options: AddWorktreeOptions): Promise<AddWorktreeResult> {
  const { repoFolder, worktreePath, branch, base = "HEAD" } = options;
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const git = (args: string[]) => runGit(repoFolder, args, timeoutMs);

  const baseRun = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${base}^{commit}`]);
  if (baseRun.code !== 0) throw new GitError("git_failed", `${repoFolder} 里找不到基准“${base}”（要是仓库里的一个提交）。`);
  const baseCommit = baseRun.stdout.trim();

  const listRun = await git(["-c", "core.quotePath=false", "worktree", "list", "--porcelain"]);
  if (listRun.code !== 0) throw failed("git worktree list", listRun);
  const existing = findWorktree(parseWorktreeList(listRun.stdout), worktreePath);
  if (existing) {
    if (existing.branch !== `refs/heads/${branch}`) {
      const now = existing.branch ? existing.branch.replace(/^refs\/heads\//, "") : "（没有分支）";
      throw new GitError("path_taken", `${worktreePath} 已经是分支 ${now} 的 worktree，不是 ${branch}。`);
    }
    const mergeBase = await git(["merge-base", `refs/heads/${branch}`, baseCommit]);
    return { created: false, baseCommit: mergeBase.code === 0 ? mergeBase.stdout.trim() : baseCommit };
  }

  const branchRun = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (branchRun.code === 0) throw new GitError("branch_taken", `分支 ${branch} 已经存在（可能是别的 Worker 占着），没法再建。`);

  const addRun = await git(["worktree", "add", "-b", branch, worktreePath, baseCommit]);
  if (addRun.code !== 0) throw failed("git worktree add", addRun);
  return { created: true, baseCommit };
}

interface WorktreeEntry {
  path: string;
  /** `refs/heads/...`；游离 HEAD 或 bare 时没有。 */
  branch: string | null;
}

/** 解析 `git worktree list --porcelain`：每个 worktree 一段，段之间空一行。 */
function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of output.split(/\n\s*\n/)) {
    let path: string | null = null;
    let branch: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length);
    }
    if (path !== null) entries.push({ path, branch });
  }
  return entries;
}

/** git 登记的是 realpath（macOS 的 /var 其实是 /private/var），所以两边都转成 realpath 再比。 */
function findWorktree(entries: WorktreeEntry[], worktreePath: string): WorktreeEntry | undefined {
  const target = realpathLoose(worktreePath);
  return entries.find((entry) => realpathLoose(entry.path) === target);
}

/** realpath，路径还不存在时：找到最近的存在的上级，转成 realpath 后接上剩下的部分。 */
function realpathLoose(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(realpathLoose(parent), basename(absolute));
  }
}
