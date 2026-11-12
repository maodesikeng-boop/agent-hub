// Worker 的 git worktree 自动清理：
// 满足任一条件就自动删 worktree（分支 hub/<id>-<slug> 保留）：
// 1. 已合并进主分支（origin/main、main 等）：登记的分支，或 worktree 当前实际的 HEAD（detached 在 PR 提交上、review-* 临时分支、
//    一个提交都没新增的 0 提交探索目录——HEAD 就在 main 历史里——都算，不用白留 3 天）；
// 2. Worker 已收工满 WORKTREE_RETENTION_DAYS（3 天）。
// 任何情况下：还在跑（未收工）的不删；有未提交改动（含未跟踪文件）的不删（PR 已合并也不删，留给人看）；
// rebase / merge / cherry-pick / bisect 进行到一半的不删；不用 worktree 的跳过；路径不在 worktreesDir 下（含符号链接）的绝不删。
// detached HEAD 且 HEAD 没合入主分支：满 3 天才删，删之前先建 hub/detached-<Worker>-<提交号> 分支保住提交。
// 已被外部 git worktree remove / prune 解绑、只剩壳的孤儿目录：同样条件下（且没有未被忽略的文件）直接 fs.rm 回收。
// 被 .gitignore 忽略的文件（node_modules、.env、截图等）不算改动，随目录一起删。
// 每轮最多检查 WORKTREE_CLEANUP_BATCH_LIMIT 个：先判条件（不到期才查合并，git 引用很便宜），满足了才跑 git status；
// 用 git worktree remove（不带 --force），失败只记日志下轮再试，删完跑 git worktree prune。
import { existsSync, lstatSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
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
  pinDetachedHead,
  probeOrphanContent,
  probeWorktreeForRemoval,
  pruneWorktrees,
  realpathLoose,
  removeWorktree,
  resolveCommit,
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
  if (!isAbsolute(worktreePath) || !isStrictlyInside(resolve(worktreesDir), resolve(worktreePath))) return false;
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

  /**
   * 孤儿目录（已不是有效 worktree）：登记的分支已合并 / 已不存在 / 收工满保留期之一成立，
   * 且目录里没有未被忽略的用户文件（node_modules、.codegraph 这类忽略目录随目录一起收回），才物理删除。返回是否删掉了。
   */
  const cleanOrphan = async (candidate: EndedWorktreeCandidate): Promise<boolean> => {
    const tag = `worker #${candidate.workerId}，${candidate.worktreePath}`;
    const expired = now() - candidate.endedAt >= retentionMs;
    let tip: string | null;
    try {
      tip = await resolveCommit(candidate.repoFolder, `refs/heads/${candidate.branch}`, git);
      if (!expired && tip !== null && !(await isCommitMergedToMain(candidate.repoFolder, tip, git))) return false;
    } catch (error) {
      log(`${LOG_PREFIX} 清理孤儿 worktree 目录：检查分支合并状态失败（${tag}）：${error instanceof Error ? error.message : String(error)}`);
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
    // 动手前再核一次：路径仍是 worktreesDir 下的真目录（不是符号链接）、Worker 没重新跑起来
    if (stopped || !isUnderWorktreesDir(candidate.worktreePath, worktreesDir) || !ledger.isWorkerCleanable(candidate.workerId)) return false;
    try {
      // 不跟随符号链接；codegraph 守护进程刚退出时文件可能还在被释放，让 fs.rm 自己重试几次
      await rm(candidate.worktreePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) {
      log(`${LOG_PREFIX} 清理孤儿 worktree 目录失败（${tag}）：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (existsSync(candidate.worktreePath)) {
      log(`${LOG_PREFIX} 清理孤儿 worktree 目录：删除后目录仍在，下轮再试（${tag}）`);
      return false;
    }
    log(
      `${LOG_PREFIX} 已清理孤儿 worktree 目录：worker #${candidate.workerId}（${candidate.worktreePath}，${tip === null ? `分支 ${candidate.branch} 已不在` : `分支 ${candidate.branch} 保留`}）`,
    );
    return true;
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

      // 0. 已经不是有效 git worktree 的残留目录（外部 git worktree remove / prune 之后剩下的壳）：走孤儿流程，不跑 git status
      if (inspectWorktreeLink(candidate.worktreePath) === "orphan") {
        if (await cleanOrphan(candidate)) {
          cleaned.push(candidate.workerId);
          prunedRepos.add(candidate.repoFolder);
        }
        continue;
      }

      // 1. 满足“收工满 3 天”或“已合并进主分支”任一条件才往下走（不满足的不跑 git status）。
      //    “已合并”看两处：登记的分支，和 worktree 当前实际的 HEAD（审查 Worker 常 detached 在 PR 提交上，
      //    或停在 review-* 临时分支；一个提交都没新增、HEAD 还在 main 历史里的探索目录也算，没有任何东西会丢）。
      const expired = now() - candidate.endedAt >= retentionMs;
      let merged = false;
      if (!expired) {
        try {
          merged = await isBranchMergedToMain(candidate.repoFolder, candidate.branch, candidate.baseCommit, git);
          if (!merged) {
            const head = await resolveCommit(candidate.worktreePath, "HEAD", git);
            merged = head !== null && (await isCommitMergedToMain(candidate.repoFolder, head, git));
          }
        } catch (error) {
          log(`${LOG_PREFIX} 清理 worktree：检查分支合并状态失败（worker #${candidate.workerId}）：${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        if (!merged) continue;
      }

      // 2. 有未提交改动（含未跟踪文件）、rebase / merge / cherry-pick / bisect 进行到一半的一律不删（即使 PR 已合并也留给人看）
      const probe = await probeWorktreeForRemoval(candidate.worktreePath, git);
      if (probe.kind !== "ok") {
        log(`${LOG_PREFIX} 清理 worktree：检查状态失败（worker #${candidate.workerId}，${candidate.worktreePath}）：${probe.error}`);
        continue;
      }
      if (!probe.isRepoWithCommit || !probe.clean || probe.inProgress || probe.head === null) continue;

      // 2b. 未满保留期时，worktree 当前实际的 HEAD 也必须在主分支历史里（防登记分支已合入但工作区切到了别的未合并提交）；
      //     HEAD 不在分支上（detached）且没合入主分支时：满 3 天才删，并先给它建个分支引用，建失败绝不继续删目录丢提交。
      let pinned: string | null = null;
      if (!expired || !probe.onBranch) {
        try {
          const headMerged = await isCommitMergedToMain(candidate.repoFolder, probe.head, git);
          if (!headMerged) {
            if (!expired) continue;
            if (!probe.onBranch) {
              pinned = await pinDetachedHead(candidate.repoFolder, probe.head, String(candidate.workerId), git);
            }
          }
        } catch (error) {
          log(`${LOG_PREFIX} 清理 worktree：保全 detached HEAD 失败（worker #${candidate.workerId}）：${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
      }

      // 3. 动手删之前再核一次路径和 Worker 状态，确保未重新跑起来
      if (stopped || !isUnderWorktreesDir(candidate.worktreePath, worktreesDir) || !ledger.isWorkerCleanable(candidate.workerId)) continue;

      try {
        await removeWorktree(candidate.repoFolder, candidate.worktreePath, git);
      } catch (error) {
        // 探到删除之间被外部解绑了：照孤儿处理（里面还有没忽略的文件就保留）
        if (inspectWorktreeLink(candidate.worktreePath) === "orphan" && (await cleanOrphan(candidate))) {
          cleaned.push(candidate.workerId);
          prunedRepos.add(candidate.repoFolder);
          continue;
        }
        log(
          `${LOG_PREFIX} 清理 worktree 失败（worker #${candidate.workerId}，${candidate.worktreePath}）：${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      cleaned.push(candidate.workerId);
      prunedRepos.add(candidate.repoFolder);
      log(
        `${LOG_PREFIX} 已自动清理 worktree：worker #${candidate.workerId}（${candidate.worktreePath}，分支 ${candidate.branch} 保留${pinned === null ? "" : `，detached HEAD 已保底到分支 ${pinned}`}）`,
      );
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
