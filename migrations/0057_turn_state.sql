-- 0057_turn_state: one row per model turn, the inputs it took, the tools it ran, and the background wait it left behind.
-- These tables become the only record of turn boundaries, input settlement, tool completion, and background waits;
-- messages keeps the transcript and a read projection of each input's status. New tables only, so the file re-runs.
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
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, id);

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
