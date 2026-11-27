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

-- A Worker with input not yet answered holds its step's slot, so the holding check finds that input by conversation.
CREATE INDEX IF NOT EXISTS messages_unanswered_input ON messages (conversation_id) WHERE status IN ('queued', 'delivered', 'processing');
