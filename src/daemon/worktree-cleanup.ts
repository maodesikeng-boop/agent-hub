import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { WorkerId } from "../shared/domain.ts";
import {
  LOG_PREFIX,
  WORKTREE_CLEANUP_BATCH_LIMIT,
  WORKTREE_CLEANUP_INTERVAL_MS,
  WORKTREE_RETENTION_MS,
} from "../shared/index.ts";
import {
  inspectWorktreeLink,
  isBranchMergedToMain,
  isCommitMergedToMain,
  moveWorktree,
  pinDetachedHead,
  probeOrphanContent,
  probeWorktreeForRemoval,
  pruneWorktrees,
  realpathLoose,
  resolveCommit,
  type GitOptions,
} from "./git/index.ts";
import type { EndedWorktreeCandidate } from "./ledger/index.ts";
import {
  formatWin32LockHolders,
  isCrossPlatformAbsolutePath,
  isPathStrictlyInside,
  queryWin32WhoLocks,
  removeTreeWithRetry,
} from "./platform/index.ts";

const TRASH_DIR = ".trash";
const TRASH_REPO_FILE = ".repo";
const OUT_OF_QUOTA = Symbol("out-of-quota");

export interface WorktreeCleanupLedger {
  listEndedWorktreeWorkers(): EndedWorktreeCandidate[];
  isWorkerCleanable(workerId: WorkerId): boolean;
}

export interface WorktreeCleanupOptions {
  ledger: WorktreeCleanupLedger;
  worktreesDir: string;
  extraWorktreeRoots?: () => readonly string[];
  log: (line: string) => void;
  now?: () => number;
  retentionMs?: number;
  batchLimit?: number;
  intervalMs?: number;
  git?: GitOptions;
}

export interface WorktreeCleanup {
  runOnce(): Promise<WorkerId[]>;
  stop(): Promise<void>;
}

export function isUnderWorktreesDir(worktreePath: string, worktreesDir: string | readonly string[]): boolean {
  if (!isCrossPlatformAbsolutePath(worktreePath)) return false;
  const roots = typeof worktreesDir === "string" ? [worktreesDir] : worktreesDir;
  if (roots.length === 0) return false;
  const resolvedTarget = resolve(worktreePath);
  const matchingRoots = roots.filter((root) => isPathStrictlyInside(resolve(root), resolvedTarget));
  if (matchingRoots.length === 0) return false;
  try {
    const stat = lstatSync(worktreePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  } catch {
    return false;
  }
  const realTarget = realpathLoose(worktreePath);
  return matchingRoots.some((root) => isPathStrictlyInside(realpathLoose(root), realTarget));
}

export function createWorktreeCleanup(options: WorktreeCleanupOptions): WorktreeCleanup {
  const {
    ledger,
    worktreesDir,
    extraWorktreeRoots,
    log,
    now = () => Date.now(),
    retentionMs = WORKTREE_RETENTION_MS,
    batchLimit = WORKTREE_CLEANUP_BATCH_LIMIT,
    git,
  } = options;

  const currentRoots = (): string[] => [worktreesDir, ...(extraWorktreeRoots?.() ?? [])];
  const stopController = new AbortController();

  let cursor = 0;
  let running: Promise<WorkerId[]> | null = null;
  let stopped = false;

  const rotateFromCursor = (eligible: EndedWorktreeCandidate[]): EndedWorktreeCandidate[] => {
    const startIdx = eligible.findIndex((c) => c.workerId > cursor);
    const offset = startIdx === -1 ? 0 : startIdx;
    return [...eligible.slice(offset), ...eligible.slice(0, offset)];
  };

  const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  /** On Windows a failed move usually means a process holds the directory, so report who. */
  const win32LockSuffix = (path: string): string => {
    if (process.platform !== "win32") return "";
    const holders = formatWin32LockHolders(queryWin32WhoLocks(path));
    return holders === "" ? "" : `（占用进程：${holders}）`;
  };

  const moveToTrash = async (candidate: EndedWorktreeCandidate, linked: boolean): Promise<void> => {
    const root = currentRoots().find((r) => isPathStrictlyInside(resolve(r), resolve(candidate.worktreePath)));
    if (root === undefined) throw new Error("不在任何 worktree 根目录下");
    const trash = join(root, TRASH_DIR);
    await mkdir(trash, { recursive: true });
    if (!isUnderWorktreesDir(trash, [root])) throw new Error(`${trash} 不是根目录下的真目录`);
    const stage = await mkdtemp(join(trash, `${candidate.workerId}-`));
    writeFileSync(join(stage, TRASH_REPO_FILE), candidate.repoFolder);
    if (linked) await moveWorktree(candidate.repoFolder, candidate.worktreePath, stage, git);
    else await rename(candidate.worktreePath, join(stage, basename(candidate.worktreePath)));
  };

  /** Delete the repo path file last so an interrupted run still knows which repo to prune. */
  const emptyTrash = async (): Promise<void> => {
    for (const root of new Set(currentRoots())) {
      const trash = join(root, TRASH_DIR);
      if (!isUnderWorktreesDir(trash, [root])) continue;
      for (const name of await readdir(trash).catch(() => [])) {
        if (stopped) return;
        const stage = join(trash, name);
        try {
          if (lstatSync(stage).isDirectory()) {
            for (const entry of await readdir(stage)) {
              if (entry !== TRASH_REPO_FILE) await removeTreeWithRetry(join(stage, entry), { signal: stopController.signal });
            }
            const repoFile = join(stage, TRASH_REPO_FILE);
            const repoFolder = existsSync(repoFile) ? readFileSync(repoFile, "utf8") : "";
            if (repoFolder !== "" && existsSync(repoFolder)) await pruneWorktrees(repoFolder, git);
          }
          await removeTreeWithRetry(stage, { signal: stopController.signal });
        } catch (error) {
          if (!stopped) log(`${LOG_PREFIX} 删除待删的 worktree 目录失败，下轮再删（${stage}）：${errorText(error)}`);
        }
      }
    }
  };

  const cleanOrphan = async (candidate: Extract<EndedWorktreeCandidate, { review: false }>): Promise<boolean> => {
    const tag = `worker #${candidate.workerId}，${candidate.worktreePath}`;
    const expired = now() - candidate.endedAt >= retentionMs;
    let tip: string | null;
    try {
      tip = await resolveCommit(candidate.repoFolder, `refs/heads/${candidate.branch}`, git);
      if (!expired && tip !== null && !(await isCommitMergedToMain(candidate.repoFolder, tip, git))) return false;
    } catch (error) {
      log(`${LOG_PREFIX} 清理孤儿 worktree 目录：检查分支合并状态失败（${tag}）：${errorText(error)}`);
      return false;
    }
    const content = await probeOrphanContent(candidate.repoFolder, candidate.worktreePath, tip, {
      ...git,
      baseCommit: candidate.baseCommit,
    });
    if (content.kind !== "ok") {
      log(`${LOG_PREFIX} 清理孤儿 worktree 目录：检查内容失败（${tag}）：${content.error}`);
      return false;
    }
    if (content.hasContent) {
      log(`${LOG_PREFIX} 清理孤儿 worktree 目录：目录里有没被忽略的文件，保留（${tag}）`);
      return false;
    }
    // Re-check right before acting in case the Worker restarted.
    if (stopped || !isUnderWorktreesDir(candidate.worktreePath, currentRoots()) || !ledger.isWorkerCleanable(candidate.workerId)) return false;
    try {
      await moveToTrash(candidate, false);
    } catch (error) {
      log(`${LOG_PREFIX} 清理孤儿 worktree 目录失败（${tag}）：${errorText(error)}`);
      return false;
    }
    log(
      `${LOG_PREFIX} 已清理孤儿 worktree 目录：worker #${candidate.workerId}（${candidate.worktreePath}，${tip === null ? `分支 ${candidate.branch} 已不在` : `分支 ${candidate.branch} 保留`}）`,
    );
    return true;
  };

  const cleanReview = async (candidate: Extract<EndedWorktreeCandidate, { review: true }>): Promise<boolean> => {
    const tag = `worker #${candidate.workerId}，${candidate.worktreePath}`;
    if (stopped) return false;
    try {
      await moveToTrash(candidate, inspectWorktreeLink(candidate.worktreePath) !== "orphan");
    } catch (error) {
      log(`${LOG_PREFIX} 清理审查目录失败（${tag}）：${errorText(error)}${win32LockSuffix(candidate.worktreePath)}`);
      return false;
    }
    log(`${LOG_PREFIX} 已清理审查目录：${tag}`);
    return true;
  };

  const doRunOnce = async (): Promise<WorkerId[]> => {
    if (stopped) return [];
    const cleaned = await moveCandidatesToTrash();
    await emptyTrash();
    return cleaned;
  };

  const processCandidate = async (
    candidate: EndedWorktreeCandidate,
    takeQuota: () => boolean,
  ): Promise<WorkerId | null | typeof OUT_OF_QUOTA> => {
    if (!isUnderWorktreesDir(candidate.worktreePath, currentRoots()) || !ledger.isWorkerCleanable(candidate.workerId)) return null;

    if (candidate.review) return (await cleanReview(candidate)) ? candidate.workerId : null;

    if (inspectWorktreeLink(candidate.worktreePath) === "orphan") {
      if (!takeQuota()) return OUT_OF_QUOTA;
      return (await cleanOrphan(candidate)) ? candidate.workerId : null;
    }

    const expired = now() - candidate.endedAt >= retentionMs;
    if (!expired) {
      let merged: boolean;
      try {
        merged = await isBranchMergedToMain(candidate.repoFolder, candidate.branch, candidate.baseCommit, git);
        if (!merged) {
          const head = await resolveCommit(candidate.worktreePath, "HEAD", git);
          merged = head !== null && (await isCommitMergedToMain(candidate.repoFolder, head, git));
        }
      } catch (error) {
        log(`${LOG_PREFIX} 清理 worktree：检查分支合并状态失败（worker #${candidate.workerId}）：${errorText(error)}`);
        return null;
      }
      if (!merged) return null;
    }
    if (!takeQuota()) return OUT_OF_QUOTA;

    // Never delete with uncommitted changes or an unfinished rebase, merge, cherry-pick or bisect, even after the PR merged.
    const probe = await probeWorktreeForRemoval(candidate.worktreePath, git);
    if (probe.kind !== "ok") {
      log(`${LOG_PREFIX} 清理 worktree：检查状态失败（worker #${candidate.workerId}，${candidate.worktreePath}）：${probe.error}`);
      return null;
    }
    if (!probe.isRepoWithCommit || probe.hasContent || probe.inProgress || probe.head === null) return null;

    // Before the retention period ends, HEAD itself must be on main in case the worktree switched to unmerged work.
    let pinned: string | null = null;
    if (!expired || !probe.onBranch) {
      try {
        const headMerged = await isCommitMergedToMain(candidate.repoFolder, probe.head, git);
        if (!headMerged) {
          if (!expired) return null;
          if (!probe.onBranch) {
            pinned = await pinDetachedHead(candidate.repoFolder, probe.head, String(candidate.workerId), git);
          }
        }
      } catch (error) {
        log(`${LOG_PREFIX} 清理 worktree：保全 detached HEAD 失败（worker #${candidate.workerId}）：${errorText(error)}`);
        return null;
      }
    }

    if (stopped || !isUnderWorktreesDir(candidate.worktreePath, currentRoots()) || !ledger.isWorkerCleanable(candidate.workerId)) return null;

    try {
      await moveToTrash(candidate, true);
    } catch (error) {
      log(`${LOG_PREFIX} 清理 worktree 失败（worker #${candidate.workerId}，${candidate.worktreePath}）：${errorText(error)}${win32LockSuffix(candidate.worktreePath)}`);
      return null;
    }
    log(
      `${LOG_PREFIX} 已自动清理 worktree：worker #${candidate.workerId}（${candidate.worktreePath}，分支 ${candidate.branch} 保留${pinned === null ? "" : `，detached HEAD 已保底到分支 ${pinned}`}）`,
    );
    return candidate.workerId;
  };

  const moveCandidatesToTrash = async (): Promise<WorkerId[]> => {
    let all: EndedWorktreeCandidate[];
    try {
      all = ledger.listEndedWorktreeWorkers();
    } catch (error) {
      log(`${LOG_PREFIX} 清理 worktree：读取候选失败：${errorText(error)}`);
      return [];
    }
    const roots = currentRoots();
    const eligible = all.filter((c) => isUnderWorktreesDir(c.worktreePath, roots) && ledger.isWorkerCleanable(c.workerId));
    if (eligible.length === 0) {
      cursor = 0;
      return [];
    }

    const cleaned: WorkerId[] = [];
    let quotaLeft = batchLimit;
    const takeQuota = (): boolean => quotaLeft-- > 0;

    for (const candidate of rotateFromCursor(eligible)) {
      if (stopped) return cleaned;
      const outcome = await processCandidate(candidate, takeQuota);
      if (outcome === OUT_OF_QUOTA) return cleaned;
      cursor = candidate.workerId;
      if (outcome !== null) cleaned.push(outcome);
    }
    cursor = 0;
    return cleaned;
  };

  const runOnce = (): Promise<WorkerId[]> => {
    if (running !== null) return running;
    const task = doRunOnce().finally(() => {
      running = null;
    });
    running = task;
    return task;
  };

  const stop = async (): Promise<void> => {
    stopped = true;
    stopController.abort();
    if (running !== null) {
      await running.catch(() => {});
    }
  };

  return { runOnce, stop };
}

export function startWorktreeCleanup(options: WorktreeCleanupOptions): WorktreeCleanup {
  const intervalMs = options.intervalMs ?? WORKTREE_CLEANUP_INTERVAL_MS;
  const cleanup = createWorktreeCleanup(options);
  void cleanup.runOnce();
  const timer = setInterval(() => {
    void cleanup.runOnce();
  }, intervalMs);
  timer.unref?.();
  return {
    runOnce: () => cleanup.runOnce(),
    stop: async () => {
      clearInterval(timer);
      await cleanup.stop();
    },
  };
}
