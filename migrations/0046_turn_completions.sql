CREATE TABLE IF NOT EXISTS turn_completions (
  sequence         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       INTEGER NOT NULL REFERENCES agent_sessions (id) ON DELETE CASCADE,
  event            TEXT NOT NULL CHECK (json_valid(event)),
  facts            TEXT CHECK (facts IS NULL OR json_valid(facts)),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS turn_completions_session ON turn_completions (session_id, sequence);
CREATE INDEX IF NOT EXISTS turn_completions_due ON turn_completions (next_attempt_at, sequence);

CREATE TABLE IF NOT EXISTS turn_completion_watermarks (
  session_id  INTEGER PRIMARY KEY REFERENCES agent_sessions (id) ON DELETE CASCADE,
  sequence    INTEGER NOT NULL
) STRICT;
