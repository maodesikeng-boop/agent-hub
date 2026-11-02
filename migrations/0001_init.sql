-- 0001_init：M1 用到的六张表（设计第 6.2 节）。其余的表 M2 起各自用新的迁移文件加。
-- 迁移器按文件名里的编号执行，成功后把 PRAGMA user_version 设成这个编号；本文件里不设。
-- 约定：时间一律是毫秒时间戳（INTEGER）；JSON 列存 JSON 文本；布尔存 0 / 1。

CREATE TABLE pms (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  avatar_file   TEXT,
  mode          TEXT    NOT NULL DEFAULT 'default',
  default_model TEXT,
  persona_file  TEXT,
  created_at    INTEGER NOT NULL
) STRICT;

CREATE TABLE conversations (
  id         INTEGER PRIMARY KEY,
  kind       TEXT    NOT NULL CHECK (kind IN ('assistant', 'pm', 'project_group')),
  pm_id      INTEGER REFERENCES pms (id),
  project_id INTEGER,
  title      TEXT    NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE agent_sessions (
  id                  INTEGER PRIMARY KEY,
  role                TEXT    NOT NULL CHECK (role IN ('assistant', 'pm', 'worker')),
  conversation_id     INTEGER REFERENCES conversations (id),
  ticket_id           INTEGER,
  vendor              TEXT    NOT NULL DEFAULT 'claude',
  vendor_session_id   TEXT    NOT NULL UNIQUE,
  cwd                 TEXT    NOT NULL,
  add_dirs            TEXT    NOT NULL DEFAULT '[]',
  generation          INTEGER NOT NULL DEFAULT 1,
  model               TEXT,
  pid                 INTEGER,
  status              TEXT    NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'ended', 'broken')),
  has_completed_turn  INTEGER NOT NULL DEFAULT 0 CHECK (has_completed_turn IN (0, 1)),
  last_event_at       INTEGER,
  rate_limit          TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
) STRICT;

CREATE INDEX agent_sessions_conversation ON agent_sessions (conversation_id, generation);

CREATE TABLE messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id),
  session_id      INTEGER REFERENCES agent_sessions (id),
  ticket_id       INTEGER,
  sender          TEXT    NOT NULL CHECK (sender IN ('user', 'agent', 'system')),
  kind            TEXT    NOT NULL CHECK (kind IN ('text', 'tool')),
  text            TEXT    NOT NULL,
  meta            TEXT,
  collapsed       INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),
  dedupe_key      TEXT    NOT NULL UNIQUE,
  status          TEXT    CHECK (status IN ('queued', 'delivered', 'processing', 'replied', 'stopped', 'failed')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX messages_conversation ON messages (conversation_id, id);

CREATE TABLE actions (
  id              INTEGER PRIMARY KEY,
  type            TEXT    NOT NULL CHECK (type IN ('session.start', 'session.send')),
  dedupe_key      TEXT    NOT NULL,
  params          TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed', 'abandoned')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (type, dedupe_key)
) STRICT;

CREATE INDEX actions_due ON actions (status, next_attempt_at);

CREATE TABLE health (
  module               TEXT    PRIMARY KEY,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  updated_at           INTEGER NOT NULL
) STRICT;
