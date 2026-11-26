-- 0057_turn_state: one row per model turn, the inputs it took, the tools it ran, and the background wait it left behind.
-- These tables become the only record of turn boundaries, input settlement, tool completion, and background waits;
-- messages keeps the transcript and a read projection of each input's status.
CREATE TABLE IF NOT EXISTS turns (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  cause            TEXT    NOT NULL CHECK (cause IN ('input', 'self', 'recovery')),
  status           TEXT    NOT NULL CHECK (status IN ('running', 'ended')),
  outcome          TEXT    CHECK (outcome IN ('ok', 'interrupted', 'failed', 'empty_recovery')),
  stop_source      TEXT    CHECK (stop_source IN ('user', 'shutdown', 'handover', 'session_ended', 'crash')),
  failure_reason   TEXT,
  parent_turn_id   INTEGER REFERENCES turns(id) ON DELETE SET NULL,
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  duration_ms      INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  first_output_id  INTEGER,
  last_output_id   INTEGER,
  reply_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  updated_at       INTEGER NOT NULL,
  CHECK ((status = 'running') = (ended_at IS NULL)),
  CHECK ((status = 'running') = (outcome IS NULL)),
  CHECK ((status = 'running') = (duration_ms IS NULL))
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_one_running_per_session ON turns(session_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_turns_conversation ON turns(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_turns_conversation_running ON turns(conversation_id, id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_turns_conversation_output ON turns(conversation_id, last_output_id, first_output_id) WHERE status = 'ended';
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, id);
CREATE INDEX IF NOT EXISTS idx_turns_parent ON turns(parent_turn_id) WHERE parent_turn_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_turns_reply_message ON turns(reply_message_id) WHERE reply_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS turn_inputs (
  turn_id          INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  message_id       INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  role             TEXT    NOT NULL CHECK (role IN ('opening', 'mid_turn')),
  after_message_id INTEGER,
  taken_at         INTEGER,
  outcome          TEXT    CHECK (outcome IN ('replied', 'stopped', 'failed', 'interrupted')),
  stop_source      TEXT    CHECK (stop_source IN ('user', 'shutdown', 'handover', 'session_ended', 'crash')),
  recovery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (recovery_attempts >= 0),
  recovery_boot_id TEXT,
  PRIMARY KEY (turn_id, message_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_turn_inputs_message ON turn_inputs(message_id, turn_id);

CREATE TABLE IF NOT EXISTS turn_tools (
  turn_id     INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  tool_use_id TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  summary     TEXT,
  status      TEXT    NOT NULL CHECK (status IN ('pending', 'running', 'done', 'unconfirmed')),
  recorded_at INTEGER NOT NULL,
  started_at  INTEGER,
  ended_at    INTEGER,
  PRIMARY KEY (turn_id, tool_use_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_turn_tools_open ON turn_tools(turn_id) WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_turn_tools_tool_use ON turn_tools(tool_use_id, turn_id);

CREATE TABLE IF NOT EXISTS turn_background_waits (
  turn_id          INTEGER PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  session_id       INTEGER NOT NULL UNIQUE REFERENCES agent_sessions(id) ON DELETE CASCADE,
  draft_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  direct_chat      INTEGER NOT NULL DEFAULT 0 CHECK (direct_chat IN (0, 1)),
  tasks_json       TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(tasks_json)),
  active_count     INTEGER NOT NULL CHECK (active_count >= 0),
  waiting_since    INTEGER NOT NULL,
  drained_at       INTEGER,
  reminders_sent   INTEGER NOT NULL DEFAULT 0,
  next_remind_at   INTEGER,
  updated_at       INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_turn_background_waits_due ON turn_background_waits(next_remind_at) WHERE next_remind_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_turn_background_waits_drained ON turn_background_waits(drained_at) WHERE drained_at IS NOT NULL;

-- Empty source tables let this migration rerun after the originals have been dropped.
CREATE TABLE IF NOT EXISTS worker_background_waits (
  session_id INTEGER PRIMARY KEY REFERENCES agent_sessions(id),
  turn_start INTEGER NOT NULL,
  background INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS worker_background_wait_details (
  session_id INTEGER PRIMARY KEY REFERENCES worker_background_waits(session_id) ON DELETE CASCADE,
  turn_end INTEGER NOT NULL,
  direct_chat INTEGER NOT NULL
) STRICT;

-- The old wait records the reply time only. Leave the first output unset so historical cards keep their duration estimate.
CREATE TEMP TABLE legacy_turn_waits AS
SELECT b.session_id, s.conversation_id, b.background, b.created_at, coalesce(d.direct_chat, 0) AS direct_chat,
       (SELECT m.id FROM messages m
         WHERE m.session_id = b.session_id AND m.sender = 'agent'
           AND m.id > b.turn_start AND (d.turn_end IS NULL OR m.id <= d.turn_end)
         ORDER BY m.id DESC LIMIT 1) AS last_output_id,
       (SELECT m.id FROM messages m
         WHERE m.session_id = b.session_id AND m.sender = 'agent' AND m.kind = 'text'
           AND m.id > b.turn_start AND (d.turn_end IS NULL OR m.id <= d.turn_end)
         ORDER BY m.id DESC LIMIT 1) AS draft_message_id
FROM worker_background_waits b
JOIN agent_sessions s ON s.id = b.session_id
JOIN workers w ON w.id = s.worker_id AND w.status = 'open'
LEFT JOIN worker_background_wait_details d ON d.session_id = b.session_id
WHERE NOT EXISTS (SELECT 1 FROM turn_background_waits n WHERE n.session_id = b.session_id);

INSERT INTO turns (session_id, conversation_id, cause, status, outcome, started_at, ended_at, duration_ms, last_output_id, reply_message_id, updated_at)
SELECT session_id, conversation_id, 'self', 'ended', 'ok', created_at, created_at, 0, last_output_id, draft_message_id, created_at
FROM legacy_turn_waits ORDER BY session_id;

INSERT INTO turn_background_waits (turn_id, session_id, draft_message_id, direct_chat, active_count, waiting_since, drained_at, updated_at)
SELECT (SELECT max(t.id) FROM turns t WHERE t.session_id = b.session_id), b.session_id, b.draft_message_id, b.direct_chat,
       b.background, b.created_at, CASE WHEN b.background = 0 THEN b.created_at END, b.created_at
FROM legacy_turn_waits b;

DROP TABLE legacy_turn_waits;
DROP TABLE worker_background_wait_details;
DROP TABLE worker_background_waits;
