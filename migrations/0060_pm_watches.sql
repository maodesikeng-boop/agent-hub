CREATE TABLE IF NOT EXISTS pm_watches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pm_id           INTEGER NOT NULL REFERENCES pms(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind            TEXT    NOT NULL CHECK (kind IN ('once', 'poll', 'timer')),
  command         TEXT,
  every_ms        INTEGER,
  body            TEXT    NOT NULL,
  graph_id        INTEGER REFERENCES task_graphs(id) ON DELETE SET NULL,
  worker_id       INTEGER REFERENCES workers(id) ON DELETE SET NULL,
  status          TEXT    NOT NULL CHECK (status IN ('watching', 'met', 'failed', 'expired', 'closed')),
  runs            INTEGER NOT NULL DEFAULT 0,
  deadline_at     INTEGER NOT NULL,
  next_run_at     INTEGER,
  exit_code       INTEGER,
  output_tail     TEXT,
  settled_at      INTEGER,
  closed_at       INTEGER,
  created_at      INTEGER NOT NULL,
  CHECK ((kind = 'timer') = (command IS NULL))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_pm_watches_open
  ON pm_watches(pm_id, status);
