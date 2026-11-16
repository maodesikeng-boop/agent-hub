// Worker 的 git worktree 自动清理：
// 满足任一条件就自动删 worktree（分支 hub/<id>-<slug> 保留）：
// 1. 已合并进主分支（origin/main、main 等）：登记的分支，或 worktree 当前实际的 HEAD（detached 在 PR 提交上、review-* 临时分支、
//    一个提交都没新增的 0 提交探索目录——HEAD 就在 main 历史里——都算，不用白留 3 天）；
// 2. Worker 已收工满 WORKTREE_RETENTION_DAYS（3 天）。
// 任何情况下：还在跑（未收工）的不删；同一个目录被换人接手的后任接着用（还开着、还在跑）的不删，共用这个目录的 Worker 经手过的
// 任务图还 active 的也不删（随时可能再换人接着用，docs/orchestration-simplify-design.md 第 4.4 节；判断在账本的 isWorkerCleanable，
// 注册 worktree 和孤儿目录两条路径都在动手前复核）；共用同一目录时“收工满 3 天”按末任收工时间算（账本 endedAt 取该目录全部 Worker 的最晚时间）；
// 有未提交改动（含未跟踪文件）的不删（PR 已合并也不删，留给人看）；
// rebase / merge / cherry-pick / bisect 进行到一半的不删；不用 worktree 的跳过；路径不在 worktreesDir 下（含符号链接）的绝不删。
// detached HEAD 且 HEAD 没合入主分支：满 3 天才删，删之前先建 hub/detached-<Worker>-<提交号> 分支保住提交。
// 已被外部 git worktree remove / prune 解绑、只剩壳的孤儿目录：同样条件下（且没有未被忽略的文件）同样回收。
// 被 .gitignore 忽略的文件（node_modules、.env、截图等）不算改动，随目录一起删；只缺已跟踪文件（上一轮删到一半）也不算。
// 每轮最多检查 WORKTREE_CLEANUP_BATCH_LIMIT 个：先判条件（不到期才查合并，git 引用很便宜），满足了才跑 git status。
// 删除分两步，每一步都能被打断、下一轮从磁盘上的状态接着做：
// 1. 一次 rename 把整个目录挪进同一根目录下的 .trash/<临时名>/（注册 worktree 用 git worktree move，锁着或带子模块的 git 会拒绝），
//    挪之前先在临时目录里写下主仓路径；原路径要么原样还在，要么已经不在，不会出现删了一半的 worktree。
// 2. 每轮最后清空 .trash：删掉挪进来的目录，对记下的主仓跑 git worktree prune，最后删掉临时目录（连同主仓路径）。
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
/** 待删临时目录里记主仓路径的文件：挪进来的目录删完后靠它知道该对哪个仓库跑 git worktree prune。 */
const TRASH_REPO_FILE = ".repo";

export interface WorktreeCleanupLedger {
  listEndedWorktreeWorkers(): EndedWorktreeCandidate[];
  /** 这个 Worker 的 worktree 目录现在能不能删：它已收工、没在跑，共用这个目录的都已收工没在跑，经手的任务图都结束了。 */
  isWorkerCleanable(workerId: WorkerId): boolean;
}

export interface WorktreeCleanupOptions {
  ledger: WorktreeCleanupLedger;
  worktreesDir: string;
  /** 额外的已登记跨卷 worktree 根目录（如 `D:\.fusa-wt\<指纹>`），清理时与 worktreesDir 一视同仁。 */
  extraWorktreeRoots?: () => readonly string[];
  log: (line: string) => void;
  now?: () => number;
  retentionMs?: number;
  batchLimit?: number;
  intervalMs?: number;
  git?: GitOptions;
}

export interface WorktreeCleanup {
  /** 跑一轮清理，返回本轮从原路径挪走 worktree 的 Worker 编号。同一时刻最多一轮在跑。 */
  runOnce(): Promise<WorkerId[]>;
  /** 停掉定时器并等正在跑的一轮收尾。 */
  stop(): Promise<void>;
}

/**
 * 校验 worktreePath 存在、是真目录（不是符号链接），且字面路径与真实路径都在 worktreesDir 之下。
 * 已手动删掉的目录（ENOENT）或不在 worktreesDir 下的路径都返回 false。
 */
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

  const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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

  /** 主仓路径文件最后删：任何一步中断，下一轮都还知道要 prune 哪个仓库。 */
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

  /**
   * 孤儿目录（已不是有效 worktree）：登记的分支已合并 / 已不存在 / 收工满保留期之一成立，
   * 且目录里没有未被忽略的用户文件（node_modules、.codegraph 这类忽略目录随目录一起收回），才挪进 .trash。返回是否挪走了。
   */
  const cleanOrphan = async (candidate: EndedWorktreeCandidate): Promise<boolean> => {
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
    // 动手前再核一次：路径仍是 worktreesDir 下的真目录（不是符号链接）、Worker 没重新跑起来
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

  const doRunOnce = async (): Promise<WorkerId[]> => {
    if (stopped) return [];
    const cleaned = await moveCandidatesToTrash();
    await emptyTrash();
    return cleaned;
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

    const batch = selectBatch(eligible);
    const cleaned: WorkerId[] = [];

    for (const candidate of batch) {
      if (stopped) break;
      if (!isUnderWorktreesDir(candidate.worktreePath, currentRoots()) || !ledger.isWorkerCleanable(candidate.workerId)) continue;

      // 0. 已经不是有效 git worktree 的残留目录（外部 git worktree remove / prune 之后剩下的壳）：走孤儿流程，不跑 git status
      if (inspectWorktreeLink(candidate.worktreePath) === "orphan") {
        if (await cleanOrphan(candidate)) cleaned.push(candidate.workerId);
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
          log(`${LOG_PREFIX} 清理 worktree：检查分支合并状态失败（worker #${candidate.workerId}）：${errorText(error)}`);
          continue;
        }
        if (!merged) continue;
      }

      // 2. 有未提交改动（含未跟踪文件）、rebase / merge / cherry-pick / bisect 进行到一半的一律不删（即使 PR 已合并也留给人看）；
      //    只缺已跟踪文件的（上一轮删到一半）照删
      const probe = await probeWorktreeForRemoval(candidate.worktreePath, git);
      if (probe.kind !== "ok") {
        log(`${LOG_PREFIX} 清理 worktree：检查状态失败（worker #${candidate.workerId}，${candidate.worktreePath}）：${probe.error}`);
        continue;
      }
      if (!probe.isRepoWithCommit || probe.hasContent || probe.inProgress || probe.head === null) continue;

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
          log(`${LOG_PREFIX} 清理 worktree：保全 detached HEAD 失败（worker #${candidate.workerId}）：${errorText(error)}`);
          continue;
        }
      }

      // 3. 动手删之前再核一次路径和 Worker 状态，确保未重新跑起来
      if (stopped || !isUnderWorktreesDir(candidate.worktreePath, currentRoots()) || !ledger.isWorkerCleanable(candidate.workerId)) continue;

      try {
        await moveToTrash(candidate, true);
      } catch (error) {
        const lockInfo =
          process.platform === "win32"
            ? formatWin32LockHolders(queryWin32WhoLocks(candidate.worktreePath))
            : "";
        const lockSuffix = lockInfo === "" ? "" : `（占用进程：${lockInfo}）`;
        log(`${LOG_PREFIX} 清理 worktree 失败（worker #${candidate.workerId}，${candidate.worktreePath}）：${errorText(error)}${lockSuffix}`);
        continue;
      }
      cleaned.push(candidate.workerId);
      log(
        `${LOG_PREFIX} 已自动清理 worktree：worker #${candidate.workerId}（${candidate.worktreePath}，分支 ${candidate.branch} 保留${pinned === null ? "" : `，detached HEAD 已保底到分支 ${pinned}`}）`,
      );
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
    stopController.abort();
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
