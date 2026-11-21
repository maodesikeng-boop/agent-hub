import { existsSync } from "node:fs";
import type { WorkerId } from "../../../shared/domain.ts";
import { isPathStrictlyInside } from "../../platform/index.ts";
import type { WorkerDbRow } from "../rows.ts";
import { workerRow } from "./ctx.ts";
import { isWorkerInFlight } from "./lines.ts";
import type { EndedWorktreeCandidate, WorkersCtx } from "./types.ts";

export function isWorktreeCleaned(w: WorkersCtx, worker: WorkerDbRow): boolean {
  if (worker.workspace !== "worktree" || worker.status !== "ended" || worker.base_commit === null || worker.worktree_path === null) {
    return false;
  }
  if (existsSync(worker.worktree_path)) return false;
  const { worktreesDir } = w.options;
  const allRoots = [worktreesDir, ...(w.options.extraWorktreeRoots?.() ?? [])];
  const owningRoot = allRoots.find((r) => isPathStrictlyInside(r, worker.worktree_path!));
  return existsSync(owningRoot ?? worktreesDir);
}

type EndedWorktreeRow = {
  id: number;
  project_id: number;
  project_name: string;
  title: string;
  branch: string | null;
  review_json: string | null;
  worktree_path: string;
  base_commit: string | null;
  ended_at: number;
  repo_folder: string;
};

export const listEndedWorktreeWorkers = (w: WorkersCtx): EndedWorktreeCandidate[] =>
  w.db
    .all<EndedWorktreeRow>(
      `SELECT w.id, w.project_id, p.name AS project_name, w.title, w.branch, w.review_json, w.worktree_path, w.base_commit,
              (SELECT max(o.updated_at) FROM workers o WHERE o.worktree_path = w.worktree_path) AS ended_at,
              f.path AS repo_folder
       FROM workers w
       JOIN projects p ON p.id = w.project_id
       JOIN project_folders f ON f.project_id = w.project_id AND f.is_main = 1 AND f.removed_at IS NULL
       WHERE w.status = 'ended' AND w.workspace = 'worktree'
         AND w.worktree_path IS NOT NULL AND w.worktree_path != ''
         AND w.id = (SELECT min(o.id) FROM workers o WHERE o.worktree_path = w.worktree_path AND o.status = 'ended')
       ORDER BY w.id`,
    )
    .map((r): EndedWorktreeCandidate => ({
      workerId: r.id,
      projectId: r.project_id,
      projectName: r.project_name,
      title: r.title,
      repoFolder: r.repo_folder,
      ...(r.review_json !== null || r.branch === null ? { review: true, branch: null } : { review: false, branch: r.branch }),
      worktreePath: r.worktree_path,
      baseCommit: r.base_commit,
      endedAt: r.ended_at,
    }));

const inActiveGraph = (w: WorkersCtx, workerIds: readonly WorkerId[]): boolean =>
  workerIds.length > 0 &&
  w.db.get(
    `SELECT 1 AS x FROM task_graphs g JOIN task_graph_steps n ON n.graph_id = g.id, json_each(n.worker_ids_json) j
      WHERE g.status = 'active' AND j.value IN (${workerIds.map(() => "?").join(", ")})
      LIMIT 1`,
    ...workerIds,
  ) !== undefined;

export function isWorkerCleanable(w: WorkersCtx, workerId: WorkerId): boolean {
  const worker = workerRow(w, workerId);
  if (worker === null || worker.status !== "ended" || worker.workspace !== "worktree" || worker.worktree_path === null || worker.worktree_path === "") {
    return false;
  }
  const sharing = w.db.all<WorkerDbRow>("SELECT * FROM workers WHERE worktree_path = ?", worker.worktree_path);
  const busy = sharing.some((x) => {
    if (x.status !== "ended" || isWorkerInFlight(w, x)) return true;
    const s = w.sessions.currentSession(x.worker_conversation_id);
    return s !== null && (s.pid !== null || w.sessions.liveOf(s.id).activity === "stopping");
  });
  if (busy) return false;
  // Review directories are single-use, so they do not wait for the task graph to finish.
  return worker.review_json !== null || !inActiveGraph(w, sharing.map((x) => x.id));
}
