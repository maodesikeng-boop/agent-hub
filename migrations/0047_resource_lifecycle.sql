CREATE TABLE IF NOT EXISTS resource_decisions (
  kind       TEXT    NOT NULL CHECK (kind IN ('worktree', 'git_branch', 'temp_dir', 'process')),
  target_key TEXT    NOT NULL,
  decision   TEXT    NOT NULL CHECK (decision IN ('keep')),
  reason     TEXT    NOT NULL,
  decided_at INTEGER NOT NULL,
  PRIMARY KEY (kind, target_key)
) STRICT;

CREATE INDEX IF NOT EXISTS resource_decisions_decided ON resource_decisions (decided_at);

CREATE INDEX IF NOT EXISTS messages_pm_tools ON messages (conversation_id, id) WHERE kind = 'tool';

UPDATE messages
   SET meta = json_remove(meta, '$.input')
 WHERE kind = 'tool'
   AND meta IS NOT NULL
   AND json_valid(meta)
   AND json_type(meta, '$.input') IS NOT NULL;

DELETE FROM session_steps
 WHERE session_id IN (SELECT id FROM agent_sessions WHERE role != 'worker');

UPDATE handovers
   SET preamble = NULL,
       skills_section = NULL
 WHERE status = 'switched'
   AND to_session_id IS NOT NULL
   AND (preamble IS NOT NULL OR skills_section IS NOT NULL)
   AND (
     to_session_id IN (SELECT session_id FROM session_preamble_seen)
     OR to_session_id NOT IN (SELECT id FROM agent_sessions WHERE status != 'ended')
   );
