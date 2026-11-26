CREATE TABLE IF NOT EXISTS task_graph_step_states (
  step_id     INTEGER PRIMARY KEY REFERENCES task_graph_steps(id) ON DELETE CASCADE,
  state_since INTEGER NOT NULL
) STRICT;

INSERT OR IGNORE INTO task_graph_step_states (step_id, state_since)
  SELECT id, updated_at FROM task_graph_steps;

CREATE TRIGGER IF NOT EXISTS task_graph_step_states_insert
AFTER INSERT ON task_graph_steps
BEGIN
  INSERT OR REPLACE INTO task_graph_step_states (step_id, state_since) VALUES (NEW.id, NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS task_graph_step_states_update
AFTER UPDATE OF status, waiting_for ON task_graph_steps
WHEN NEW.status IS NOT OLD.status OR NEW.waiting_for IS NOT OLD.waiting_for
BEGIN
  INSERT OR REPLACE INTO task_graph_step_states (step_id, state_since) VALUES (NEW.id, NEW.updated_at);
END;

CREATE TABLE IF NOT EXISTS pm_agenda_cursors (
  session_id            INTEGER PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
  version               INTEGER NOT NULL CHECK (version >= 0),
  lines_json            TEXT    NOT NULL,
  deltas_since_snapshot INTEGER NOT NULL DEFAULT 0 CHECK (deltas_since_snapshot >= 0),
  last_message_id       INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  compaction_id         INTEGER NOT NULL DEFAULT 0,
  delivered_at          INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS workers_pm_open ON workers(pm_id, id) WHERE status = 'open';
