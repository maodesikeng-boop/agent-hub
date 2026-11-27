// Invariant: wires daemon-level resource cleanup and inspection outside daemon.ts so startup and shutdown stay bounded and testable.
import type { ProjectId } from "../../shared/domain.ts";
import { WORKTREE_CLEANUP_INTERVAL_MS } from "../../shared/limits.ts";
import { LOG_PREFIX } from "../../shared/names.ts";
import type { HubPaths } from "../../shared/paths.ts";
import { runRetentionRound } from "../db-retention.ts";
import type { FeishuOfflineInbox } from "../feishu/account-bot.ts";
import type { FeishuStore } from "../feishu/store.ts";
import { cleanupManagedFiles } from "../file-cleanup.ts";
import type { SqliteLedger } from "../ledger/index.ts";
import type { ProcessLedger } from "../process-ledger.ts";
import type { DaemonSessionScope } from "../session-tmp.ts";
import type { Db } from "../store/index.ts";
import type { WorktreeCleanup } from "../worktree-cleanup.ts";
import {
  createBranchCleanup,
  type BranchCleanupLedger,
  type ManagedBranchProject,
  type ManagedBranchWorkerRef,
} from "./branch-cleanup.ts";
import { createResourceDecisionsStore } from "./decisions.ts";
import { createResourceInspector, reapEndedSessionProcesses, type ProcessResourcePort, type ResourceInspector } from "./inspector.ts";
import type { SessionProcessReaper } from "./session-processes.ts";

export interface DaemonResourcesOptions {
  readonly db: Db;
  readonly paths: HubPaths;
  readonly ledger: SqliteLedger;
  readonly worktrees: WorktreeCleanup;
  readonly sessionScope: DaemonSessionScope;
  readonly sessionProcesses: SessionProcessReaper;
  readonly runningWatchIds: () => ReadonlySet<number>;
  readonly processLedger: ProcessLedger;
  readonly feishuPosts: Pick<FeishuStore, "prunePosts">;
  readonly feishuOfflineInbox: Pick<FeishuOfflineInbox, "expire">;
  readonly uploadsDir: string;
  readonly sentFilesDir: string;
  readonly extraWorktreeRoots: () => readonly string[];
  readonly log: (line: string) => void;
}

export interface DaemonResourcesHandle {
  readonly inspector: ResourceInspector;
  /** Resolves once background runs have stopped touching the ledger, so the caller can close the database afterwards. */
  stop(): Promise<void>;
}

function createBranchLedgerAdapter(db: Db): BranchCleanupLedger {
  return {
    listActiveProjectRepos(): ManagedBranchProject[] {
      return db
        .all<{ id: number; name: string; path: string }>(
          `SELECT p.id, p.name, f.path
             FROM projects p
             JOIN project_folders f ON f.project_id = p.id AND f.is_main = 1 AND f.removed_at IS NULL
            WHERE p.status = 'active'
            ORDER BY p.id`,
        )
        .map((r) => ({ projectId: r.id, projectName: r.name, repoFolder: r.path }));
    },
    listManagedBranchWorkers(projectId: ProjectId): ManagedBranchWorkerRef[] {
      const rows = db.all<{
        id: number;
        project_id: number;
        branch: string;
        base_commit: string | null;
        status: "open" | "ended";
        updated_at: number;
        in_active_graph: number;
      }>(
        `SELECT w.id, w.project_id, w.branch, w.base_commit, w.status, w.updated_at,
                EXISTS (
                  SELECT 1 FROM task_graphs g
                  JOIN task_graph_steps n ON n.graph_id = g.id, json_each(n.worker_ids_json) j
                 WHERE g.status = 'active' AND j.value = w.id
                ) AS in_active_graph
           FROM workers w
          WHERE w.project_id = ? AND w.branch IS NOT NULL AND w.branch != ''`,
        projectId,
      );
      return rows.map((r) => ({
        workerId: r.id,
        projectId: r.project_id,
        branch: r.branch,
        baseCommit: r.base_commit,
        status: r.status,
        inActiveGraph: r.in_active_graph === 1,
        endedAt: r.status === "ended" ? r.updated_at : null,
      }));
    },
  };
}

export function startDaemonResources(options: DaemonResourcesOptions): DaemonResourcesHandle {
  const { db, paths, ledger, worktrees, sessionScope, sessionProcesses, processLedger, feishuPosts, feishuOfflineInbox, uploadsDir, sentFilesDir, extraWorktreeRoots, log } = options;
  let stopped = false;
  const stopController = new AbortController();
  const background = new Set<Promise<void>>();
  const track = (label: string, run: () => Promise<unknown>) => {
    const task: Promise<void> = run()
      .then(() => undefined)
      .catch((error: unknown) => {
        if (!stopController.signal.aborted) log(`${LOG_PREFIX} ${label}出错：${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => background.delete(task));
    background.add(task);
    return task;
  };

  const activeSessionIds = (): ReadonlySet<number> =>
    new Set(
      db.all<{ id: number }>("SELECT id FROM agent_sessions WHERE status != 'ended' OR pid IS NOT NULL").map((r) => r.id),
    );

  const decisions = createResourceDecisionsStore(db);
  const branches = createBranchCleanup({ ledger: createBranchLedgerAdapter(db), log, signal: stopController.signal });

  const processes: ProcessResourcePort = {
    get trackedCount() {
      return processLedger.size;
    },
    listLeakedTaggedProcesses: () => sessionProcesses.listEnded(activeSessionIds(), options.runningWatchIds()),
    reapTaggedProcess: (pid, tag) => sessionProcesses.reapOne(pid, tag),
  };

  const inspector = createResourceInspector({
    db,
    paths,
    extraWorktreeRoots,
    decisions,
    worktrees,
    branches,
    sessionTmp: sessionScope.tmp,
    processes,
    runDbRetention: async () => {
      const round = await runRetentionRound({
        ledger,
        db,
        feishuPosts,
        feishuOfflineInbox,
        log,
        isStopped: () => stopped,
      });
      return { rows: round.rows, pages: round.pages };
    },
    runFileCleanup: async () => {
      const stats = cleanupManagedFiles(
        {
          uploadsDir,
          sentFilesDir,
          setupLogsDir: paths.setupLogsDir,
          isWorkerOpen: (id) => db.get("SELECT 1 FROM workers WHERE id = ? AND status = 'open'", id) !== undefined,
        },
        log,
      );
      return { removedFiles: stats.removedFiles };
    },
    activeSessionIds,
  });

  let branchRun: Promise<void> | null = null;
  const runBranches = () => {
    if (stopped || branchRun !== null) return;
    branchRun = track("自动清理已合并分支", () => branches.runOnce()).finally(() => {
      branchRun = null;
    });
  };
  const timer = setInterval(runBranches, WORKTREE_CLEANUP_INTERVAL_MS);
  timer.unref?.();
  // Sessions that ended while the daemon was down never got their session.end reap.
  void track("回收已收工会话留下的进程", async () => {
    const kept = new Set(decisions.list().map((row) => `${row.kind}:${row.targetKey}`));
    const reaped = await reapEndedSessionProcesses(processes, kept, activeSessionIds(), stopController.signal);
    if (reaped > 0) log(`${LOG_PREFIX} 回收了 ${reaped} 个已收工会话留下的进程`);
  });

  return {
    inspector,
    async stop() {
      stopped = true;
      clearInterval(timer);
      stopController.abort();
      inspector.close();
      await Promise.all([...background]);
    },
  };
}
