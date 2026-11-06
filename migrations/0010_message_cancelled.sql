-- 0010_message_cancelled：消息状态多一个 cancelled（已取消）：一轮中途写给 agent、它还没取走，用户点了停止，
-- agent 没看到过、不自动重发（shared/domain.ts 的 MESSAGE_STATUS_TRANSITIONS，docs/mid-turn-messages.md）。
-- 约定同 0001～0009。CHECK 改不了，照 SQLite 的标准做法重建 messages（https://www.sqlite.org/lang_altertable.html 第 7 节；
-- 迁移器跑这个文件时关着外键检查、提交前查一遍）。列、顺序、约束和原来一样，只是 status 多一个值；老数据一行不删、值不改，
-- 编号原样搬过去，AUTOINCREMENT 的计数也接着原来的（删过的最大编号不会被再用）。
CREATE TABLE messages_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id),
  session_id      INTEGER REFERENCES agent_sessions (id),
  worker_id       INTEGER,
  sender          TEXT    NOT NULL,
  kind            TEXT    NOT NULL,
  text            TEXT    NOT NULL,
  meta            TEXT,
  collapsed       INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),
  dedupe_key      TEXT    NOT NULL UNIQUE,
  status          TEXT    CHECK (status IN ('queued', 'delivered', 'processing', 'replied', 'stopped', 'failed', 'cancelled')),
  failure_reason  TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;

INSERT INTO messages_new (id, conversation_id, session_id, worker_id, sender, kind, text, meta, collapsed, dedupe_key, status, failure_reason, created_at, updated_at)
  SELECT id, conversation_id, session_id, worker_id, sender, kind, text, meta, collapsed, dedupe_key, status, failure_reason, created_at, updated_at
  FROM messages ORDER BY id;

INSERT INTO sqlite_sequence (name, seq)
  SELECT 'messages_new', seq FROM sqlite_sequence
  WHERE name = 'messages' AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'messages_new');
UPDATE sqlite_sequence SET seq = max(seq, (SELECT seq FROM sqlite_sequence WHERE name = 'messages'))
  WHERE name = 'messages_new' AND EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'messages');

DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;

-- 删表时索引跟着没了，照 0001 原样建回来
CREATE INDEX messages_conversation ON messages (conversation_id, id);
