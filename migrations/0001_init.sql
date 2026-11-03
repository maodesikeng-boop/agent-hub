-- 0001_init：M1 用到的六张表（设计第 6.2 节）。其余的表 M2 起各自用新的迁移文件加。
-- 迁移器按文件名里的编号执行，成功后把 PRAGMA user_version 设成这个编号；本文件里不设。
-- 约定：时间一律是毫秒时间戳（INTEGER）；JSON 列存 JSON 文本；布尔存 0 / 1。
-- 枚举列：以后会加取值的（actions.type、messages.kind、messages.sender）不加 CHECK，
-- 由代码用 src/shared 里的 `as const` 数组校验（isOneOf），加新取值不用改表；状态类的列保留 CHECK。

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

-- 一个项目经理只有一个私聊。项目群（M2）一个项目经理可以有好几个，所以只管 kind = 'pm'。
CREATE UNIQUE INDEX conversations_pm_private ON conversations (pm_id, kind) WHERE kind = 'pm';

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

-- 同一个对话的同一代只有一个会话。conversation_id 为空（Worker 会话）时不受限。
CREATE UNIQUE INDEX agent_sessions_conversation ON agent_sessions (conversation_id, generation);

CREATE TABLE messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id),
  session_id      INTEGER REFERENCES agent_sessions (id),
  ticket_id       INTEGER,
  sender          TEXT    NOT NULL,
  kind            TEXT    NOT NULL,
  text            TEXT    NOT NULL,
  meta            TEXT,
  collapsed       INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),
  dedupe_key      TEXT    NOT NULL UNIQUE,
  status          TEXT    CHECK (status IN ('queued', 'delivered', 'processing', 'replied', 'stopped', 'failed')),
  failure_reason  TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX messages_conversation ON messages (conversation_id, id);

-- 登记动作用一条 UPSERT（同一类型同一个去重键只有一行）。已结束的（done / failed / abandoned）
-- 重置成待执行、次数清零；没结束的只更新参数。SET 里的 status 读的都是改之前的值：
--   INSERT INTO actions (type, dedupe_key, params, next_attempt_at, created_at, updated_at) VALUES (...)
--   ON CONFLICT (type, dedupe_key) DO UPDATE SET
--     params          = excluded.params,
--     status          = CASE WHEN status IN ('done', 'failed', 'abandoned') THEN 'pending' ELSE status END,
--     attempts        = CASE WHEN status IN ('done', 'failed', 'abandoned') THEN 0 ELSE attempts END,
--     last_error      = CASE WHEN status IN ('done', 'failed', 'abandoned') THEN NULL ELSE last_error END,
--     next_attempt_at = CASE WHEN status IN ('done', 'failed', 'abandoned') THEN excluded.next_attempt_at ELSE next_attempt_at END,
--     updated_at      = excluded.updated_at
CREATE TABLE actions (
  id              INTEGER PRIMARY KEY,
  type            TEXT    NOT NULL,
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
