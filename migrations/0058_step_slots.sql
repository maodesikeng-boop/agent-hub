CREATE TABLE IF NOT EXISTS task_graph_step_slots (
  step_id INTEGER PRIMARY KEY REFERENCES task_graph_steps(id) ON DELETE CASCADE,
  slot    TEXT    NOT NULL CHECK (length(slot) BETWEEN 1 AND 32 AND slot NOT GLOB '*[^a-z0-9-]*')
) STRICT;

CREATE INDEX IF NOT EXISTS task_graph_step_slots_slot ON task_graph_step_slots (slot);
