// git 操作（M3 W1）：判断主文件夹是不是有提交的仓库、有没有没提交的改动、给 Worker 建 worktree。
// 用 execFile 直接调 git，不经过 shell；每次调用都有超时；拿不到的错误转成 GitError（中文信息 + kind）。
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { WorkspaceProbe } from "../../shared/ledger.ts";
import { GIT_MAX_BUFFER_BYTES, GIT_PROBE_TIMEOUT_MS, GIT_TIMEOUT_MS } from "../../shared/limits.ts";

/**
 * 只读地列仓库里的东西（`git ls-files` 这类，对象是别人给的、不一定可信的仓库）时加在子命令前面的参数和环境变量：
 * 仓库配置里的 `core.fsmonitor` 指到脚本的话，git 读索引时会执行它（审查实测），所以每次都用 `-c core.fsmonitor=false` 盖掉；
 * GIT_OPTIONAL_LOCKS=0 不去抢可选的锁（不刷新索引、不挡用户自己的 git 操作）。
 */
export const GIT_READONLY_ARGS: readonly string[] = ["-c", "core.fsmonitor=false"];
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
  const target = realpathLoose(worktreePath);
  return entries.find((entry) => realpathLoose(entry.path) === target);
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
  | { kind: "ok"; isRepoWithCommit: boolean; clean: boolean; onBranch: boolean }
  | { kind: "failed"; error: string };

/**
 * 自动清理删 worktree 之前探一次（一个 `git status --porcelain=v2 --branch` 子进程）：
 * - clean：没有已跟踪文件的改动、暂存、未跟踪文件、子模块改动。显式 `--untracked-files=normal`：
 *   仓库配了 `status.showUntrackedFiles=no` 时默认的 status 看不到未跟踪文件，而 `git worktree remove` 也照删不误（实测）。
 * - onBranch：HEAD 指在某个分支上。detached HEAD（含 rebase、bisect 进行到一半）上的新提交不在任何分支里，
 *   `git worktree remove` 不拦，删了 worktree 连同它的 HEAD reflog 一起没了（实测），所以不在分支上的不删。
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
      return { kind: "ok", isRepoWithCommit: false, clean: false, onBranch: false };
    }
    if (run.code !== 0) throw failed("git status", run);
    let hasCommit = true;
    let onBranch = false;
    let clean = true;
    for (const line of run.stdout.split("\n")) {
      if (line === "") continue;
      if (line === "# branch.oid (initial)") hasCommit = false;
      else if (line.startsWith("# branch.head ")) onBranch = line !== "# branch.head (detached)";
      else if (!line.startsWith("# ")) clean = false;
    }
    return { kind: "ok", isRepoWithCommit: hasCommit, clean, onBranch };
  } catch (error) {
    return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
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
