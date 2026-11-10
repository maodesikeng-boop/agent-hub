// Worker 的 git worktree 自动清理：
// 满足任一条件就自动删 worktree（分支 hub/<id>-<slug> 保留）：
// 1. 这个 Worker 的分支已合并进主分支（origin/main、main 等）；
// 2. Worker 已收工满 WORKTREE_RETENTION_DAYS（3 天），且 worktree 里没有未提交改动（含未跟踪文件）。
// 任何情况下：还在跑（未收工）的不删；有未提交改动的不删（PR 已合并也不删，留给人看）；不用 worktree 的跳过；
// 路径不在 worktreesDir 下的绝不删。每轮最多检查 WORKTREE_CLEANUP_BATCH_LIMIT 个，用 git worktree remove（不带 --force），
// 失败只记日志下轮再试，删完跑 git worktree prune。
import { lstatSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { WorkerId } from "../shared/domain.ts";
import {
  LOG_PREFIX,
  WORKTREE_CLEANUP_BATCH_LIMIT,
  WORKTREE_CLEANUP_INTERVAL_MS,
  WORKTREE_RETENTION_MS,
} from "../shared/index.ts";
import {
  isBranchMergedToMain,
  probeWorkspace,
  pruneWorktrees,
  realpathLoose,
  removeWorktree,
  type GitOptions,
} from "./git/index.ts";
import type { EndedWorktreeCandidate } from "./ledger/index.ts";

export interface WorktreeCleanupLedger {
  listEndedWorktreeWorkers(): EndedWorktreeCandidate[];
  isWorkerCleanable(workerId: WorkerId): boolean;
}

export interface WorktreeCleanupOptions {
  ledger: WorktreeCleanupLedger;
  worktreesDir: string;
  log: (line: string) => void;
  now?: () => number;
  retentionMs?: number;
  batchLimit?: number;
  intervalMs?: number;
  git?: GitOptions;
}

export interface WorktreeCleanup {
  /** 跑一轮清理，返回本轮成功删掉 worktree 的 Worker 编号。同一时刻最多一轮在跑。 */
  runOnce(): Promise<WorkerId[]>;
  /** 停掉定时器并等正在跑的一轮收尾。 */
  stop(): Promise<void>;
}

function isStrictlyInside(parentDir: string, targetPath: string): boolean {
  const rel = relative(parentDir, targetPath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * 校验 worktreePath 存在、是真目录（不是符号链接），且字面路径与真实路径都在 worktreesDir 之下。
 * 已手动删掉的目录（ENOENT）或不在 worktreesDir 下的路径都返回 false。
 */
export function isUnderWorktreesDir(worktreePath: string, worktreesDir: string): boolean {
  if (!isStrictlyInside(resolve(worktreesDir), resolve(worktreePath))) return false;
  try {
    const stat = lstatSync(worktreePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  } catch {
    return false;
  }
  return isStrictlyInside(realpathLoose(worktreesDir), realpathLoose(worktreePath));
}

export function createWorktreeCleanup(options: WorktreeCleanupOptions): WorktreeCleanup {
  const {
    ledger,
    worktreesDir,
    log,
    now = () => Date.now(),
    retentionMs = WORKTREE_RETENTION_MS,
    batchLimit = WORKTREE_CLEANUP_BATCH_LIMIT,
    git,
  } = options;

  let cursor = 0;
  let running: Promise<WorkerId[]> | null = null;
  let stopped = false;

  const selectBatch = (eligible: EndedWorktreeCandidate[]): EndedWorktreeCandidate[] => {
    if (eligible.length <= batchLimit) {
      cursor = 0;
      return eligible;
    }
    const startIdx = eligible.findIndex((c) => c.workerId > cursor);
    const offset = startIdx === -1 ? 0 : startIdx;
    const batch: EndedWorktreeCandidate[] = [];
    for (let i = 0; i < batchLimit; i++) {
      batch.push(eligible[(offset + i) % eligible.length]!);
    }
    cursor = batch.at(-1)!.workerId;
    return batch;
  };

  const doRunOnce = async (): Promise<WorkerId[]> => {
    if (stopped) return [];
    let all: EndedWorktreeCandidate[];
    try {
      all = ledger.listEndedWorktreeWorkers();
    } catch (error) {
      log(`${LOG_PREFIX} 清理 worktree：读取候选失败：${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    const eligible = all.filter((c) => isUnderWorktreesDir(c.worktreePath, worktreesDir) && ledger.isWorkerCleanable(c.workerId));
    if (eligible.length === 0) {
      cursor = 0;
      return [];
    }

    const batch = selectBatch(eligible);
    const cleaned: WorkerId[] = [];
    const prunedRepos = new Set<string>();

    for (const candidate of batch) {
      if (stopped) break;
      if (!isUnderWorktreesDir(candidate.worktreePath, worktreesDir) || !ledger.isWorkerCleanable(candidate.workerId)) continue;

      // 1. 先查 worktree 里有没有未提交改动（含未跟踪文件）：有改动的一律不删（即使 PR 已合并也留给人看）
      const probe = await probeWorkspace(candidate.worktreePath, git);
      if (probe.kind !== "ok") {
        log(`${LOG_PREFIX} 清理 worktree：检查状态失败（worker #${candidate.workerId}，${candidate.worktreePath}）：${probe.error}`);
        continue;
      }
      if (!probe.isRepoWithCommit || probe.hasUncommittedChanges) continue;

      // 2. 满足“收工满 3 天”或“分支已合并进主分支”任一条件才删
      const expired = now() - candidate.endedAt >= retentionMs;
      let merged = false;
      if (!expired) {
        try {
          merged = await isBranchMergedToMain(candidate.repoFolder, candidate.branch, candidate.baseCommit, git);
        } catch (error) {
          log(`${LOG_PREFIX} 清理 worktree：检查分支合并状态失败（worker #${candidate.workerId}）：${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
      }
      if (!expired && !merged) continue;

      // 3. 动手删之前再核一次路径和 Worker 状态，确保未重新跑起来
      if (stopped || !isUnderWorktreesDir(candidate.worktreePath, worktreesDir) || !ledger.isWorkerCleanable(candidate.workerId)) continue;

      try {
        await removeWorktree(candidate.repoFolder, candidate.worktreePath, git);
      } catch (error) {
        log(
          `${LOG_PREFIX} 清理 worktree 失败（worker #${candidate.workerId}，${candidate.worktreePath}）：${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      cleaned.push(candidate.workerId);
      prunedRepos.add(candidate.repoFolder);
      log(`${LOG_PREFIX} 已自动清理 worktree：worker #${candidate.workerId}（${candidate.worktreePath}，分支 ${candidate.branch} 保留）`);
    }

    for (const repoFolder of prunedRepos) {
      if (stopped) break;
      try {
        await pruneWorktrees(repoFolder, git);
      } catch (error) {
        log(`${LOG_PREFIX} git worktree prune 失败（${repoFolder}）：${error instanceof Error ? error.message : String(error)}`);
      }
    }

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
    if (running !== null) {
      await running.catch(() => {});
    }
  };

  return { runOnce, stop };
}

/** 启动定时清理（启动时先跑一轮，之后每 WORKTREE_CLEANUP_INTERVAL_MS 跑一轮）。 */
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
