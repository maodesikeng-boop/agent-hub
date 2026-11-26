CREATE TABLE IF NOT EXISTS worker_app_approvals (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id          INTEGER NOT NULL REFERENCES workers (id) ON DELETE CASCADE,
  session_id         INTEGER NOT NULL REFERENCES agent_sessions (id) ON DELETE CASCADE,
  sandbox_approval_id INTEGER NOT NULL REFERENCES worker_sandbox_approvals (id) ON DELETE CASCADE,
  pm_id              INTEGER NOT NULL REFERENCES pms (id) ON DELETE CASCADE,
  conversation_id    INTEGER NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  message_id         INTEGER REFERENCES messages (id) ON DELETE SET NULL,
  vendor             TEXT    NOT NULL,
  process_key        TEXT    NOT NULL,
  app_id             TEXT    NOT NULL,
  app_name           TEXT    NOT NULL,
  risk_level         TEXT,
  warning            TEXT,
  status             TEXT    NOT NULL CHECK (status IN ('pending', 'allowed', 'denied', 'expired', 'revoked')),
  decided_by         TEXT    CHECK (decided_by IS NULL OR decided_by IN ('user', 'system')),
  decision_client_id TEXT,
  request_count      INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  decided_at         INTEGER,
  ended_at           INTEGER,
  updated_at         INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_worker_app_approvals_status_updated
  ON worker_app_approvals (status, updated_at, id);

CREATE INDEX IF NOT EXISTS idx_worker_app_approvals_worker_app
  ON worker_app_approvals (worker_id, app_id, id);

CREATE INDEX IF NOT EXISTS idx_worker_app_approvals_session_process
  ON worker_app_approvals (session_id, process_key);
