-- 0054_system_wakeups: A PM wakeup the system queues (Task Graph progress, Router decisions) is a system notice, not
-- user text, and each turn's checklist is measured against the session's checklist when that turn started.
-- A side table instead of ADD COLUMN keeps this migration re-runnable.
CREATE TABLE IF NOT EXISTS session_checklist_turns (
  session_id INTEGER PRIMARY KEY REFERENCES agent_sessions (id) ON DELETE CASCADE,
  baseline   TEXT NOT NULL CHECK (json_valid(baseline))
) STRICT;

CREATE TRIGGER IF NOT EXISTS clear_ended_session_checklist_turn
AFTER UPDATE OF status ON agent_sessions
WHEN NEW.status = 'ended' AND OLD.status != 'ended'
BEGIN
  DELETE FROM session_checklist_turns WHERE session_id = NEW.id;
END;

UPDATE actions
   SET params = json_set(params, '$.source', 'system')
 WHERE type = 'session.send'
   AND json_extract(params, '$.messageId') IN (
     SELECT id FROM messages WHERE sender = 'user' AND json_extract(meta, '$.wakeup') = 1
   );

UPDATE messages
   SET sender = 'system',
       meta = json_object(
         'event', 'pm.wakeup',
         'source', CASE WHEN text LIKE '【Router%' THEN 'router' ELSE 'task_graph' END,
         'ref', dedupe_key
       )
 WHERE sender = 'user' AND json_extract(meta, '$.wakeup') = 1;
