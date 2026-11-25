CREATE TABLE IF NOT EXISTS session_checklists (
  session_id INTEGER PRIMARY KEY REFERENCES agent_sessions (id) ON DELETE CASCADE,
  snapshot   TEXT NOT NULL CHECK (json_valid(snapshot))
) STRICT;

CREATE TRIGGER IF NOT EXISTS clear_ended_session_checklist
AFTER UPDATE OF status ON agent_sessions
WHEN NEW.status = 'ended' AND OLD.status != 'ended'
BEGIN
  DELETE FROM session_checklists WHERE session_id = NEW.id;
END;
