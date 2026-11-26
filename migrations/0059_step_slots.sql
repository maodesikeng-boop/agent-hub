CREATE TABLE IF NOT EXISTS task_graph_step_slots (
  step_id   INTEGER PRIMARY KEY REFERENCES task_graph_steps(id) ON DELETE CASCADE,
  slot      TEXT    NOT NULL CHECK (length(slot) BETWEEN 1 AND 32 AND slot NOT GLOB '*[^a-z0-9-]*'),
  queued_at INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS task_graph_step_slots_slot ON task_graph_step_slots (slot);
CREATE INDEX IF NOT EXISTS task_graph_step_slots_queue ON task_graph_step_slots (slot, queued_at, step_id) WHERE queued_at IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS task_graph_step_slots_unqueue
AFTER UPDATE OF status ON task_graph_steps
WHEN NEW.status IS NOT 'pending'
BEGIN
  UPDATE task_graph_step_slots SET queued_at = NULL WHERE step_id = NEW.id AND queued_at IS NOT NULL;
END;

-- Background commands outlive the turn that started them, so a step keeps its slot while its Worker's session has a row here.
-- A row exists only while the count is above zero; processes die with the daemon, so startup recovery deletes every row.
CREATE TABLE IF NOT EXISTS session_background_tasks (
  session_id INTEGER PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
  count      INTEGER NOT NULL CHECK (count > 0)
) STRICT;

-- A step holds its slot while it runs, or while its active Worker still has a running turn or background commands.
-- The condition on `n` is the same text as HOLDS_SLOT_SQL in src/daemon/ledger/task-graphs/slots.ts, checked by a test.
-- Ended graphs leave no step running and no Worker attached, so the graph's status is not needed here; a trigger on
-- task_graph_steps may not read task_graphs, because rerunning an older migration rebuilds that table under it.
CREATE TRIGGER IF NOT EXISTS task_graph_step_slots_admit
BEFORE UPDATE OF status ON task_graph_steps
WHEN NEW.status = 'running' AND OLD.status IS NOT 'running' AND EXISTS (
  SELECT 1 FROM task_graph_step_slots mine
    JOIN task_graph_step_slots s ON s.slot = mine.slot AND s.step_id != mine.step_id
    JOIN task_graph_steps n ON n.id = s.step_id
   WHERE mine.step_id = NEW.id
     AND (n.status = 'running' OR (n.active_worker_id IS NOT NULL AND EXISTS (SELECT 1 FROM agent_sessions a WHERE a.worker_id = n.active_worker_id AND (EXISTS (SELECT 1 FROM session_background_tasks b WHERE b.session_id = a.id) OR EXISTS (SELECT 1 FROM turns t WHERE t.session_id = a.id AND t.status = 'running'))))))
BEGIN
  SELECT RAISE(ABORT, 'slot_held');
END;
