-- 0008_schedules：M6 的定时任务。到点往项目经理自己的对话发一条系统消息，照常交给它（src/daemon/ledger/schedules.ts）。
-- 约定同 0001～0007。只加一张新表，老数据一行不动。不建运行记录表：每次运行的结果就是对话里带 meta.scheduleId 的那条消息。
-- - kind：daily（每天 at_time，本机本地时间，"HH:MM"）或 interval（每隔 every_minutes 分钟，最短几分钟见 limits.ts）；
-- - enabled：暂停是 0；next_run_at：下一次运行的时间（毫秒），到点后按“现在”重算，不是从原定时间往后推；
-- - last_status：sent（已发给项目经理）/ skipped（到点时上一条还没处理完）/ failed（这一轮失败或会话起不来，原因在 last_error）；
-- - last_message_id：最近一次发出去的那条消息，没有外键（由账本保证）。
CREATE TABLE schedules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pm_id           INTEGER NOT NULL REFERENCES pms (id),
  name            TEXT    NOT NULL,
  kind            TEXT    NOT NULL CHECK (kind IN ('daily', 'interval')),
  at_time         TEXT,
  every_minutes   INTEGER,
  prompt          TEXT    NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  next_run_at     INTEGER NOT NULL,
  last_run_at     INTEGER,
  last_status     TEXT    CHECK (last_status IN ('sent', 'skipped', 'failed')),
  last_error      TEXT,
  last_message_id INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  CHECK ((kind = 'daily' AND at_time IS NOT NULL AND every_minutes IS NULL) OR (kind = 'interval' AND every_minutes IS NOT NULL AND at_time IS NULL))
) STRICT;

CREATE INDEX schedules_due ON schedules (enabled, next_run_at);
CREATE INDEX schedules_pm ON schedules (pm_id, id);
