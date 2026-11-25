CREATE TABLE IF NOT EXISTS worker_sandbox_approvals (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id          INTEGER NOT NULL UNIQUE REFERENCES workers (id) ON DELETE CASCADE,
  pm_id              INTEGER NOT NULL REFERENCES pms (id) ON DELETE CASCADE,
  conversation_id    INTEGER NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  message_id         INTEGER REFERENCES messages (id) ON DELETE SET NULL,
  step_id            INTEGER REFERENCES task_graph_steps (id) ON DELETE SET NULL,
  vendor             TEXT    NOT NULL,
  capabilities_json  TEXT    NOT NULL,
  task_summary       TEXT    NOT NULL,
  max_time_ms        INTEGER NOT NULL,
  status             TEXT    NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
  decided_by         TEXT    CHECK (decided_by IS NULL OR decided_by IN ('user', 'system')),
  decision_client_id TEXT,
  created_at         INTEGER NOT NULL,
  decided_at         INTEGER,
  revoked_at         INTEGER,
  updated_at         INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_worker_sandbox_approvals_status_updated
  ON worker_sandbox_approvals (status, updated_at, id);

CREATE INDEX IF NOT EXISTS idx_worker_sandbox_approvals_pm_status
  ON worker_sandbox_approvals (pm_id, status);

CREATE INDEX IF NOT EXISTS idx_worker_sandbox_approvals_step
  ON worker_sandbox_approvals (step_id)
  WHERE step_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_graph_step_sandbox (
  step_id          INTEGER PRIMARY KEY REFERENCES task_graph_steps (id) ON DELETE CASCADE,
  no_outer_sandbox INTEGER NOT NULL CHECK (no_outer_sandbox IN (0, 1))
) STRICT;
