-- 0027_vendor_switch：记录会话是否已读取过首轮开场上下文（解除对 session.renewed 消息 meta.seen 的耦合），并补齐 handovers 查询索引。
CREATE TABLE IF NOT EXISTS session_preamble_seen (
  session_id INTEGER PRIMARY KEY REFERENCES agent_sessions (id) ON DELETE CASCADE,
  seen_at    INTEGER NOT NULL
) STRICT;

INSERT OR IGNORE INTO session_preamble_seen (session_id, seen_at)
SELECT id, updated_at FROM agent_sessions WHERE generation > 1 AND has_completed_turn = 1;

INSERT OR IGNORE INTO session_preamble_seen (session_id, seen_at)
SELECT CAST(json_extract(meta, '$.sessionId') AS INTEGER), updated_at
  FROM messages
 WHERE sender = 'system' AND kind = 'text'
   AND CASE WHEN json_valid(meta)
         THEN json_extract(meta, '$.event') = 'session.renewed' AND json_extract(meta, '$.seen') = 1
         ELSE 0 END
   AND EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id = CAST(json_extract(meta, '$.sessionId') AS INTEGER));

CREATE INDEX IF NOT EXISTS handovers_to_session
  ON handovers (to_session_id)
  WHERE to_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS handovers_conversation
  ON handovers (conversation_id, id DESC);
