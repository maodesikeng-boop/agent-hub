import type { PmId, SessionId, TaskGraphId, WorkerId } from "../../../shared/domain.ts";
import type { HubCommand } from "../../../shared/hub.ts";
import { WORKER_LIST_RECENT_ENDED, WORKTREE_BRANCH_CACHE_MAX } from "../../../shared/limits.ts";
import { createWorktreeBranchProbe, type WorktreeBranchProbe } from "../../git/worktree-branch.ts";
import type { Db } from "../../store/index.ts";
import { getAgentSession } from "../../store/index.ts";
import type { LedgerContext, Pending } from "../context.ts";

export interface WorktreeBranchTarget {
  worktreePath: string;
  branch: string | null;
}

export interface WorktreeBranchScope {
  pmId?: PmId;
  workerId?: WorkerId;
  graphId?: TaskGraphId;
}

export interface BranchSyncResult {
  updatedWorkerIds: WorkerId[];
  updatedGraphIds: TaskGraphId[];
}

const MEMBERSHIP = "EXISTS (SELECT 1 FROM json_each(s.worker_ids_json) WHERE value = w.id)";
const TRACKED = "w.workspace = 'worktree' AND w.review_json IS NULL AND w.base_commit IS NOT NULL AND w.worktree_path <> ''";

export function listWorktreeBranchTargets(db: Db, { pmId, workerId, graphId }: WorktreeBranchScope = {}): WorktreeBranchTarget[] {
  if (workerId === undefined && graphId === undefined) return listRecentWorktreeBranchTargets(db, pmId);
  return db.all<WorktreeBranchTarget>(
    `SELECT w.worktree_path AS worktreePath, w.branch FROM workers w WHERE ${TRACKED}
     AND (? IS NULL OR w.pm_id = ?) AND (? IS NULL OR w.worktree_path = (SELECT worktree_path FROM workers WHERE id = ?))
     AND (? IS NULL OR EXISTS (SELECT 1 FROM task_graph_steps s WHERE s.graph_id = ? AND ${MEMBERSHIP}))
     GROUP BY w.worktree_path ORDER BY max(w.id) DESC`,
    pmId ?? null, pmId ?? null, workerId ?? null, workerId ?? null, graphId ?? null, graphId ?? null,
  );
}

function listRecentWorktreeBranchTargets(db: Db, pmId: PmId | undefined): WorktreeBranchTarget[] {
  const pmFilter = pmId === undefined ? "" : "AND pm_id = ?";
  const pmParams = pmId === undefined ? [] : [pmId];
  return db.all<WorktreeBranchTarget>(
    `WITH active_graph_workers AS (
       SELECT ids.value FROM task_graphs g
       JOIN task_graph_steps s ON s.graph_id = g.id JOIN json_each(s.worker_ids_json) ids
       WHERE g.status = 'active' ${pmFilter}
     ), recent_ended AS (
       SELECT id FROM workers WHERE status = 'ended' ${pmFilter}
       ORDER BY updated_at DESC, id DESC LIMIT ?
     ), targets AS (
       SELECT w.worktree_path, max(w.id) AS id,
              max(CASE WHEN w.status <> 'ended' THEN 2 WHEN w.id IN active_graph_workers THEN 1 ELSE 0 END) AS priority
         FROM workers w WHERE ${TRACKED} ${pmFilter}
          AND (w.status <> 'ended' OR w.id IN active_graph_workers OR w.id IN recent_ended)
        GROUP BY w.worktree_path ORDER BY priority DESC, id DESC LIMIT ?
     )
     SELECT t.worktree_path AS worktreePath, w.branch
       FROM targets t JOIN workers w ON w.id = t.id ORDER BY t.priority DESC, t.id DESC`,
    ...pmParams, ...pmParams, WORKER_LIST_RECENT_ENDED, ...pmParams, WORKTREE_BRANCH_CACHE_MAX,
  );
}

type PublishGraph = (p: Pending, graphId: TaskGraphId) => void;

export function syncWorktreeBranchIn(
  db: Db, p: Pending, now: () => number, worktreePath: string, actualBranch: string, publishGraph?: PublishGraph,
): BranchSyncResult {
  const t = now();
  const steps = db.all<{ graph_id: TaskGraphId }>(
    `UPDATE task_graph_steps AS s
        SET artifact_json = json_set(artifact_json, '$.branch', ?), updated_at = ?
      WHERE EXISTS (
        SELECT 1 FROM workers w WHERE ${TRACKED}
          AND w.worktree_path = ? AND w.branch <> ? AND ${MEMBERSHIP}
          AND w.id = json_extract(s.worker_ids_json, '$[#-1]')
          AND json_extract(s.artifact_json, '$.branch') = w.branch
      ) RETURNING graph_id`,
    actualBranch, t, worktreePath, actualBranch,
  );
  const rows = db.all<{ id: WorkerId }>(
    `UPDATE workers AS w SET branch = ? WHERE ${TRACKED} AND worktree_path = ? AND branch IS NOT ? RETURNING id`,
    actualBranch, worktreePath, actualBranch,
  );
  const updatedGraphIds = [...new Set(steps.map(({ graph_id }) => graph_id))];
  for (const graphId of updatedGraphIds) {
    db.run("UPDATE task_graphs SET updated_at = ? WHERE id = ?", t, graphId);
    publishGraph?.(p, graphId);
  }
  return { updatedWorkerIds: rows.map(({ id }) => id), updatedGraphIds };
}

const BRANCH_COMMANDS = new Set<HubCommand>([
  "status", "worker.show", "worker.list", "worker.start", "graph.show", "graph.list",
  "graph.patch", "graph.done", "graph.decide", "graph.skip", "graph.finish",
]);

export function createLedgerBranchSync(
  ctx: Pick<LedgerContext, "db" | "now" | "write">, publishGraph: PublishGraph, closing: AbortSignal,
  probe: WorktreeBranchProbe = createWorktreeBranchProbe(),
) {
  const { db, now, write } = ctx;
  const list = (scope?: WorktreeBranchScope) => listWorktreeBranchTargets(db, scope);
  const sync = (path: string, branch: string) => write((p) => syncWorktreeBranchIn(db, p, now, path, branch, publishGraph));
  const reconcile = (scope: WorktreeBranchScope, callerSignal?: AbortSignal): Promise<void> | null => {
    const signal = callerSignal === undefined ? closing : AbortSignal.any([closing, callerSignal]);
    if (signal.aborted) return null;
    const targets = list(scope);
    if (targets.length === 0) return null;
    return Promise.all(targets.map(async ({ worktreePath, branch: previous }) => {
      const branch = await probe.readBranch(worktreePath);
      if (signal.aborted || branch === null || branch === previous) return;
      const current = db.get<{ branch: string | null }>(
        `SELECT w.branch FROM workers w WHERE ${TRACKED} AND w.worktree_path = ? ORDER BY w.id DESC LIMIT 1`, worktreePath,
      );
      if (current?.branch === previous) sync(worktreePath, branch);
    })).then(() => undefined);
  };
  return {
    listWorktreeBranchTargets: list,
    syncWorktreeBranch: sync,
    reconcileWorktreeBranches: reconcile,
    reconcileHubBranches(sessionId: SessionId, command: HubCommand, body: Record<string, unknown>, signal: AbortSignal) {
      if (closing.aborted || signal.aborted || !BRANCH_COMMANDS.has(command)) return null;
      const session = getAgentSession(db, sessionId);
      if (session?.role === "worker" && session.workerId !== null && command === "status") {
        const graphId = graphIdForWorker(db, session.workerId);
        return reconcile(graphId === undefined ? { workerId: session.workerId } : { graphId }, signal);
      }
      if (session?.role !== "pm" || session.pmId === null || command === "status") return null;
      if (command === "worker.start" && body.node === undefined) return null;
      const workerId = command === "worker.show" && typeof body.workerId === "number" ? body.workerId : undefined;
      const graphId = typeof body.graphId === "number" ? body.graphId : undefined;
      return reconcile({ pmId: session.pmId, workerId, graphId }, signal);
    },
    reconcileWorkerGraph(workerId: WorkerId, signal?: AbortSignal) {
      if (closing.aborted || signal?.aborted) return null;
      const graphId = graphIdForWorker(db, workerId);
      return reconcile(graphId === undefined ? { workerId } : { graphId }, signal);
    },
  };
}

function graphIdForWorker(db: Db, workerId: WorkerId): TaskGraphId | undefined {
  return db.get<{ graph_id: TaskGraphId }>(
    `SELECT s.graph_id FROM task_graph_steps s JOIN task_graphs g ON g.id = s.graph_id
      JOIN workers w ON w.pm_id = g.pm_id WHERE w.id = ? AND ${MEMBERSHIP} ORDER BY s.id DESC LIMIT 1`, workerId,
  )?.graph_id;
}
