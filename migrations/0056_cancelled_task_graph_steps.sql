CREATE TABLE task_graph_steps_new (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  graph_id            INTEGER NOT NULL REFERENCES task_graphs(id) ON DELETE CASCADE,
  node_key            TEXT    NOT NULL,
  title               TEXT    NOT NULL,
  brief               TEXT,
  vendor              TEXT,
  model               TEXT,
  effort              TEXT,
  readonly            INTEGER NOT NULL DEFAULT 0 CHECK (readonly IN (0, 1)),
  max_time_ms         INTEGER,
  confirm             INTEGER NOT NULL DEFAULT 0 CHECK (confirm IN (0, 1)),
  review              INTEGER NOT NULL DEFAULT 0 CHECK (review IN (0, 1)),
  base                TEXT,
  pm_note             TEXT,
  status              TEXT    NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'done', 'cancelled')),
  waiting_for         TEXT    CHECK (waiting_for IN ('user', 'pm')),
  skipped             INTEGER NOT NULL DEFAULT 0 CHECK (skipped IN (0, 1)),
  sort_order          INTEGER NOT NULL DEFAULT 0,
  active_worker_id    INTEGER REFERENCES workers(id) ON DELETE SET NULL,
  worker_ids_json     TEXT    NOT NULL DEFAULT '[]',
  artifact_json       TEXT,
  gate_question       TEXT,
  gate_options_json   TEXT,
  gate_summary_md     TEXT,
  gate_recommended    TEXT,
  gate_ask_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  decision_json       TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (graph_id, node_key),
  CHECK ((status = 'waiting') = (waiting_for IS NOT NULL)),
  CHECK (skipped = 0 OR status = 'done'),
  CHECK (status <> 'cancelled' OR active_worker_id IS NULL)
) STRICT;

INSERT INTO task_graph_steps_new SELECT * FROM task_graph_steps;

INSERT INTO sqlite_sequence (name, seq)
  SELECT 'task_graph_steps_new', seq FROM sqlite_sequence
  WHERE name = 'task_graph_steps' AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'task_graph_steps_new');
UPDATE sqlite_sequence SET seq = max(seq, (SELECT seq FROM sqlite_sequence WHERE name = 'task_graph_steps'))
  WHERE name = 'task_graph_steps_new' AND EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'task_graph_steps');

DROP TABLE task_graph_steps;
ALTER TABLE task_graph_steps_new RENAME TO task_graph_steps;

CREATE INDEX idx_task_graph_steps_worker
  ON task_graph_steps(active_worker_id)
  WHERE active_worker_id IS NOT NULL;

CREATE INDEX idx_task_graph_steps_waiting_user
  ON task_graph_steps(graph_id)
  WHERE status = 'waiting' AND waiting_for = 'user';

CREATE TRIGGER task_graph_steps_user_blocker_clear
AFTER UPDATE OF status, waiting_for ON task_graph_steps
WHEN NEW.status <> 'waiting' OR NEW.waiting_for IS NOT 'user'
BEGIN
  DELETE FROM user_blocker_steps WHERE step_id = NEW.id;
END;

UPDATE task_graph_steps
   SET status = 'cancelled', waiting_for = NULL, active_worker_id = NULL
 WHERE status IN ('pending', 'running', 'waiting')
   AND graph_id IN (SELECT id FROM task_graphs WHERE status = 'cancelled');
