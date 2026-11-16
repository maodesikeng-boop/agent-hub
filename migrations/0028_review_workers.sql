-- 0028_review_workers：审查步骤只查不修（docs/review-verify-only-design.md 第 3.1 节）。
-- 审查 Worker 在自己的 detached worktree 里干活，不挂分支：workspace = 'worktree' 时 branch 可以是 NULL，
-- 审的是哪条分支、开审时它在本地、origin 和 PR 上的样子记在新列 review_json（shared/review.ts 的 ReviewTarget）。
-- 改 CHECK 要按 SQLite 标准表重建法重建 workers；NATURAL LEFT JOIN 兼容“旧表没有 review_json”和“重跑时已经有”两种形态（同 0026）。
-- 保留原 id、外键、CHECK 和全部索引；workers 的 id 不是 AUTOINCREMENT，没有 sqlite_sequence 要搬。
CREATE TABLE workers_new (
  id                     INTEGER PRIMARY KEY,
  project_id             INTEGER NOT NULL REFERENCES projects (id),
  pm_id                  INTEGER NOT NULL REFERENCES pms (id),
  pm_conversation_id     INTEGER NOT NULL REFERENCES conversations (id),
  worker_conversation_id INTEGER NOT NULL UNIQUE REFERENCES conversations (id),
  title                  TEXT    NOT NULL,
  task                   TEXT    NOT NULL,
  model                  TEXT,
  readonly               INTEGER NOT NULL DEFAULT 0 CHECK (readonly IN (0, 1)),
  workspace              TEXT    NOT NULL CHECK (workspace IN ('worktree', 'main')),
  branch                 TEXT,
  worktree_path          TEXT,
  base_commit            TEXT,
  status                 TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'ended')),
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  effort                 TEXT,
  review_json            TEXT,
  CHECK (workspace = 'main' OR worktree_path IS NOT NULL),
  CHECK (workspace = 'main' OR branch IS NOT NULL OR review_json IS NOT NULL),
  CHECK (workspace = 'worktree' OR (branch IS NULL AND worktree_path IS NULL AND base_commit IS NULL AND review_json IS NULL))
) STRICT;

INSERT INTO workers_new (
  id, project_id, pm_id, pm_conversation_id, worker_conversation_id, title, task, model, readonly, workspace,
  branch, worktree_path, base_commit, status, created_at, updated_at, effort, review_json
)
SELECT
  id, project_id, pm_id, pm_conversation_id, worker_conversation_id, title, task, model, readonly, workspace,
  branch, worktree_path, base_commit, status, created_at, updated_at, effort, review_json
FROM workers NATURAL LEFT JOIN (SELECT NULL AS review_json)
ORDER BY id;

DROP TABLE workers;
ALTER TABLE workers_new RENAME TO workers;

CREATE INDEX IF NOT EXISTS workers_pm ON workers (pm_id, id);
CREATE INDEX IF NOT EXISTS workers_project ON workers (project_id);
CREATE INDEX IF NOT EXISTS workers_worktree_path ON workers (worktree_path) WHERE worktree_path IS NOT NULL;
