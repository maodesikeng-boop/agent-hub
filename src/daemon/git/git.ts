// git 操作（M3 W1）：判断主文件夹是不是有提交的仓库、有没有没提交的改动、给 Worker 建 worktree。
// 用 execFile 直接调 git，不经过 shell；每次调用都有超时；拿不到的错误转成 GitError（中文信息 + kind）。
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { WorkspaceProbe } from "../../shared/ledger.ts";
import { GIT_MAX_BUFFER_BYTES, GIT_PROBE_TIMEOUT_MS, GIT_TIMEOUT_MS } from "../../shared/limits.ts";
import { normalizePathForComparison } from "../platform/index.ts";

/**
 * 只读地列仓库里的东西（`git ls-files` 这类，对象是别人给的、不一定可信的仓库）时加在子命令前面的参数和环境变量：
 * 仓库配置里的 `core.fsmonitor` 指到脚本的话，git 读索引时会执行它（审查实测），所以每次都用 `-c core.fsmonitor=false` 盖掉；
 * GIT_OPTIONAL_LOCKS=0 不去抢可选的锁（不刷新索引、不挡用户自己的 git 操作）。
 */
export const GIT_READONLY_ARGS: readonly string[] = ["-c", "core.fsmonitor=false", "-c", "gc.auto=0"];
export const GIT_READONLY_ENV: Readonly<Record<string, string>> = { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };

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
  /**
   * 在 `git worktree add` 检出工作区文件前预先建好空目录并设置 ACL（Windows 4.4.2：子文件自动继承 `ALLOW FusaWorker-<id>`，零传播开销）。
   */
  prepareDir?: (worktreePath: string) => Promise<void> | void;
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

let cachedWinGitBinary: string | undefined;

function resolveGitExecutable(): string {
  if (process.platform !== "win32") return "git";
  if (cachedWinGitBinary !== undefined) return cachedWinGitBinary;
  const candidates = [
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "mingw64", "bin", "git.exe"),
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "cmd", "git.exe"),
    ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, "Programs", "Git", "mingw64", "bin", "git.exe")] : []),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      cachedWinGitBinary = c;
      return c;
    }
  }
  cachedWinGitBinary = "git";
  return "git";
}

/**
 * 跑一次 git。退出码非 0 不抛，交给调用方判断；找不到 git、超时才抛 GitError。
 * 一律 `git -C <folder>`：文件夹不存在也只是退出码 128，不会和“找不到 git”混在一起。
 */
function runGit(
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
    const child = execFile(
      resolveGitExecutable(),
      [...prefixArgs, ...args],
      {
        timeout: timeoutMs,
        ...(process.platform === "win32" ? { windowsHide: true } : { killSignal: "SIGKILL" as const }),
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv },
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
 * `git worktree add` 建的过程中给 worktree 加的锁的理由（git 源码 builtin/worktree.c）。git 正常跑完会解锁；
 * 还锁着这个理由，说明上次 add 被强杀了，留下的是半成品（文件不全）。add 用 LC_ALL=C 跑，这个理由不会被翻译。
 */
const INITIALIZING_LOCK = "initializing";

/**
 * 建 worktree：`git worktree add -b <branch> <worktreePath> <base>`。
 * 重复执行算成功：worktree 已经在这个目录、分支也对得上，就直接返回 `created: false`，不动里面的东西。
 * 上次 add 被强杀留下的半成品（还锁着 initializing）不算建好：`git worktree remove -f -f` 加 `git branch -D` 清掉，再重建。
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
  let existing = findWorktree(parseWorktreeList(listRun.stdout), worktreePath);
  if (existing?.locked === INITIALIZING_LOCK) {
    // 两个 -f：锁着的 worktree 要这样才删得掉。分支是那次 add 建的，还没有 Worker 在上面干过活
    const removeRun = await git(["worktree", "remove", "-f", "-f", existing.path]);
    if (removeRun.code !== 0) throw failed("git worktree remove（清掉没建完的 worktree）", removeRun);
    if (existing.branch === `refs/heads/${branch}`) {
      const deleteRun = await git(["branch", "-D", branch]);
      if (deleteRun.code !== 0) throw failed("git branch -D（清掉没建完的 worktree 的分支）", deleteRun);
    }
    existing = undefined;
  }
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

  await options.prepareDir?.(worktreePath);

  const addRun = await runGit(repoFolder, ["worktree", "add", "-b", branch, worktreePath, baseCommit], timeoutMs, { LC_ALL: "C" });
  if (addRun.code !== 0) throw failed("git worktree add", addRun);
  return { created: true, baseCommit };
}

interface WorktreeEntry {
  path: string;
  /** `refs/heads/...`；游离 HEAD 或 bare 时没有。 */
  branch: string | null;
  /** 锁着时的理由（没写理由是空串）；没锁是 null。 */
  locked: string | null;
}

/** 解析 `git worktree list --porcelain`：每个 worktree 一段，段之间空一行。 */
function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of output.split(/\n\s*\n/)) {
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

/** git 登记的是 realpath（macOS 的 /var 其实是 /private/var），所以两边都转成 realpath 再比。 */
function findWorktree(entries: WorktreeEntry[], worktreePath: string): WorktreeEntry | undefined {
  const target = normalizePathForComparison(realpathLoose(worktreePath));
  return entries.find((entry) => normalizePathForComparison(realpathLoose(entry.path)) === target);
}

/** realpath，路径还不存在时：找到最近的存在的上级，转成 realpath 后接上剩下的部分。 */
export function realpathLoose(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(realpathLoose(parent), basename(absolute));
  }
}

/** 本地判断分支是否已合并时依次检查的目标主分支引用（兼顾远端 origin/main 与本地 main/master）。 */
const MAIN_TARGET_REFS = [
  "refs/remotes/origin/main",
  "refs/heads/main",
  "refs/remotes/origin/master",
  "refs/heads/master",
] as const;

/**
 * 本地判断 Worker 的分支 `refs/heads/<branch>` 是否已合并进主分支（`origin/main`、`main`，或 master）：
 * - 账本 `workers` 表不持久化 PR 状态，且定期清理不能每轮调 GitHub API，因此用本地 git plumbing 判断；
 *   squash / rebase 合并判不出来（返回 false），交给“收工满 N 天”兜底。宁可判“没合并”，不能把没合并的判成合并。
 * - 用一次 `for-each-ref` 取出分支与各候选主分支的 SHA，再用 `merge-base --is-ancestor` 的退出码（0 是、1 否）判断；
 * - 没有 baseCommit（worktree 没登记起点）、分支没有新提交（`branchCommit === baseCommit`）一律 false：
 *   刚开出来的分支天然是 main 的祖先，不能当成“PR 已合并”。
 */
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
      clean: boolean;
      onBranch: boolean;
      /** HEAD 当前指向的完整提交号；还没有提交或不是仓库时是 null。 */
      head: string | null;
      /** rebase / merge / cherry-pick / revert / bisect 进行到一半（这些中间状态下的 HEAD 和工作区不能当成“干净”）。 */
      inProgress: boolean;
    }
  | { kind: "failed"; error: string };

/** 这些 git 内部文件或目录存在，说明有一个多步操作停在中途（rebase、merge、cherry-pick、revert、bisect）。 */
const IN_PROGRESS_GIT_PATHS = [
  "rebase-merge",
  "rebase-apply",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "sequencer",
  "BISECT_LOG",
] as const;

/**
 * 自动清理删 worktree 之前探一次（一个 `git status --porcelain=v2 --branch` 子进程，外加一次 `git rev-parse --git-path` 查中间状态）：
 * - clean：没有已跟踪文件的改动、暂存、未跟踪文件、子模块改动。显式 `--untracked-files=normal`：
 *   仓库配了 `status.showUntrackedFiles=no` 时默认的 status 看不到未跟踪文件，而 `git worktree remove` 也照删不误（实测）。
 * - onBranch：HEAD 指在某个分支上；head：HEAD 的提交号。detached HEAD 上的新提交不在任何分支里，
 *   `git worktree remove` 不拦，删了 worktree 连同它的 HEAD reflog 一起没了（实测），所以调用方要先确认 head 已合入主分支，
 *   或者先给它建一个分支引用（见 pinDetachedHead），才能删。
 * - inProgress：rebase、merge、cherry-pick、bisect 进行到一半，任何时候都不删。
 * - 不是 git 仓库（目录还在但 .git 没了）返回 isRepoWithCommit: false，不算失败。
 * 被 .gitignore 忽略的文件（node_modules、.env、截图）不算改动，`git worktree remove` 会连目录一起删掉。
 */
export async function probeWorktreeForRemoval(worktreePath: string, options: GitOptions = {}): Promise<WorktreeRemovalProbe> {
  const timeoutMs = options.timeoutMs ?? GIT_PROBE_TIMEOUT_MS;
  try {
    const run = await runGit(
      worktreePath,
      [...GIT_READONLY_ARGS, "status", "--porcelain=v2", "--branch", "--untracked-files=normal", "--ignore-submodules=none"],
      timeoutMs,
      { ...GIT_READONLY_ENV, LC_ALL: "C" },
    );
    if (run.code === 128 && /not a git repository/i.test(run.stderr)) {
      return { kind: "ok", isRepoWithCommit: false, clean: false, onBranch: false, head: null, inProgress: false };
    }
    if (run.code !== 0) throw failed("git status", run);
    let hasCommit = true;
    let onBranch = false;
    let clean = true;
    let head: string | null = null;
    for (const line of run.stdout.split("\n")) {
      if (line === "") continue;
      if (line === "# branch.oid (initial)") hasCommit = false;
      else if (line.startsWith("# branch.oid ")) head = line.slice("# branch.oid ".length);
      else if (line.startsWith("# branch.head ")) onBranch = line !== "# branch.head (detached)";
      else if (!line.startsWith("# ")) clean = false;
    }
    const inProgress = await hasOperationInProgress(worktreePath, timeoutMs);
    return { kind: "ok", isRepoWithCommit: hasCommit, clean, onBranch, head: hasCommit ? head : null, inProgress };
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

/** 解析一个引用到完整提交号；引用不存在（或文件夹不是仓库）返回 null，其他 git 故障抛 GitError。 */
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

/**
 * 提交已经在主分支（`origin/main`、`main`、master）的历史里（含恰好就是主分支的提交）。
 * 和 isBranchMergedToMain 不同，这里不排除“还停在起点”：调用方（自动清理）只对已收工且工作区干净的 Worker 问，
 * 起点就在 main 上、一个提交都没新增的目录没有任何东西会丢。
 */
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

/**
 * 保证 detached HEAD 上的提交不会随 worktree 一起丢：已经被本地分支或主分支（含 origin/main）包含就什么都不做，
 * 否则建分支 `hub/detached-<标签>-<提交号前 8 位>`（名字带提交号，不会覆盖别的分支）。返回保底分支名，不需要时返回 null。
 */
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
    // 上一轮建好了、后面一步失败：分支已经指在这个提交上就算成功
    if ((await resolveCommit(repoFolder, `refs/heads/${name}`, options)) !== head) throw failed("git branch", created);
  }
  return name;
}

export type WorktreeLink = "linked" | "orphan";

/**
 * 目录和主仓的 worktree 登记还连着吗（只看文件系统，不跑 git：`.git` 没了时 git 会往上找父目录的仓库，不能拿来判断）：
 * - orphan：`.git` 不存在，或是 `gitdir: <主仓>/.git/worktrees/<名字>` 指向的目录已经不在（外部 git worktree remove / prune 之后残留的壳）；
 * - linked：其他情况（含 `.git` 是目录的独立克隆、读不出来的，交给原来的流程处理）。
 */
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

export type OrphanContentProbe = { kind: "ok"; hasContent: boolean } | { kind: "failed"; error: string };

export interface ProbeOrphanOptions extends GitOptions {
  /** Worker 登记的起点提交；当分支已删且主分支在合并后继续演进时，孤儿目录里未改动的旧文件仍停在起点，并入基准避免误判。 */
  baseCommit?: string | null;
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

/** 从 porcelain=v2 的普通变更行（`1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`）取出末尾路径。 */
function parsePorcelainV2OrdinaryPath(record: string): string | null {
  let pos = 0;
  for (let i = 0; i < 8; i++) {
    pos = record.indexOf(" ", pos);
    if (pos === -1) return null;
    pos++;
  }
  return pos < record.length ? record.slice(pos) : null;
}

/**
 * 孤儿目录（已经不是有效 worktree、没有 .git 可用）里有没有“值得留”的东西：
 * - 用主仓对象库与临时索引跑 `git status --porcelain=v2 -z --no-renames --untracked-files=normal`（命中忽略目录时在目录层级直接跳过，不遍历 node_modules 里的上万文件）；
 * - 若磁盘上的 `.gitignore`（含子目录）已被中断的 `git worktree remove` 删掉，把缺失项标为 `--skip-worktree` 让 git 原生从临时索引按各自子目录作用域读取，同时保留主仓 `info/exclude` 与用户全局 `core.excludesFile`；
 * - 依次用 `ref`（分支）、主分支（`origin/main` / `main` / `HEAD`，兜住 PR 已合并且分支被 `git branch -D` 删掉的场景）、`baseCommit`（及 `baseCommit..main` 中触碰过剩余路径的已合入提交）渐进消解已入库文件；
 * - 任何基准都解释不了的未忽略文件或被改写文件才算“有内容”（缺失的已跟踪文件 `.D` 不算）。
 */
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
          // 已跟踪文件只看“工作区 vs 索引”这一侧（XY 的第二个字符）：没变（.）、缺失（D，目录被清空过）都不是用户内容；
          // 第一个字符是“索引 vs 主仓 HEAD”，主仓 HEAD 不是基准，不看。
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

    if (commits.length === 0) {
      const res = await checkAgainst(null, null);
      return { kind: "ok", hasContent: res.unknownFormat || res.paths.length > 0 };
    }

    let suspectPaths: string[] | null = null;
    for (const commit of commits) {
      const res = await checkAgainst(commit, suspectPaths);
      if (res.unknownFormat) return { kind: "ok", hasContent: true };
      suspectPaths = res.paths;
      if (suspectPaths.length === 0) return { kind: "ok", hasContent: false };
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
          if (res.unknownFormat) return { kind: "ok", hasContent: true };
          suspectPaths = res.paths;
          if (suspectPaths.length === 0) return { kind: "ok", hasContent: false };
        }
      }
    }

    return { kind: "ok", hasContent: true };
  } catch (error) {
    return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (tmp !== null) await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** 删掉指定的 worktree（不加 --force，有未提交改动或锁着时 git 会拒绝报错；分支保留）。 */
export async function removeWorktree(repoFolder: string, worktreePath: string, options: GitOptions = {}): Promise<void> {
  const run = await runGit(repoFolder, ["worktree", "remove", worktreePath], options.timeoutMs ?? GIT_TIMEOUT_MS, { LC_ALL: "C" });
  if (run.code !== 0) throw failed("git worktree remove", run);
}

/** 清理仓库里已经不存在的 worktree 登记（`git worktree prune`）。 */
export async function pruneWorktrees(repoFolder: string, options: GitOptions = {}): Promise<void> {
  const run = await runGit(repoFolder, ["worktree", "prune"], options.timeoutMs ?? GIT_TIMEOUT_MS, { LC_ALL: "C" });
  if (run.code !== 0) throw failed("git worktree prune", run);
}

export interface DiffFileStat {
  file: string;
  /** 二进制文件 git 输出 "-"，记为 null。 */
  added: number | null;
  deleted: number | null;
}

/** 解析 `git diff --numstat --no-renames -z` 的输出。 */
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

/**
 * 探测分支相对主干（`HEAD...<branch>`，若失败且有 baseCommit 则退回 `<baseCommit>...<branch>`）的改动文件与增删行数。
 * 只读运行、带超时；失败、非仓库或找不到分支时返回 null（交付单降级省略改动文件块，不抛错阻塞消息投递）。
 */
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
