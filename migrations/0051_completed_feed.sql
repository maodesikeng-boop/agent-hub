-- 0051_completed_feed: When each Worker ended, so the work panel's Completed tab can page finished Workers and finished
-- Task Graphs together, newest first. workers.updated_at is not used because later worktree moves rewrite it.
-- A side table instead of ADD COLUMN keeps this migration re-runnable; the backfill takes updated_at as the best guess.
CREATE TABLE IF NOT EXISTS worker_endings (
  worker_id INTEGER PRIMARY KEY REFERENCES workers (id) ON DELETE CASCADE,
  pm_id     INTEGER NOT NULL REFERENCES pms (id) ON DELETE CASCADE,
  ended_at  INTEGER NOT NULL
) STRICT;

INSERT OR IGNORE INTO worker_endings (worker_id, pm_id, ended_at)
SELECT id, pm_id, updated_at FROM workers WHERE status = 'ended';

CREATE INDEX IF NOT EXISTS worker_endings_recent ON worker_endings (pm_id, ended_at DESC, worker_id DESC);

CREATE INDEX IF NOT EXISTS idx_task_graphs_project_finished
  ON task_graphs (project_id, completed_at DESC, id DESC)
  WHERE status != 'active';
