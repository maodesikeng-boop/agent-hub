-- 0010_session_steps：会话一步一步干了什么（hub worker show / log 从这里取，和厂商无关）。
-- 约定同 0001～0009。只加一张新表，老数据一行不动。以前只有工具调用、文字回复入了 messages，思考、工具结果回来的时间、
-- 一轮的开始和结局（成功 / 被打断 / 出错）都没有记，这里补上；每个会话只留最近的若干条（limits.ts 的 SESSION_STEPS_KEEP）。
-- - kind：turn_started（一轮开始）/ thinking / tool（调了工具，name、tool_use_id、summary 是一行摘要）/
--   tool_result（结果回来了，tool_use_id 对上 tool）/ text（回了一段话，summary 是开头几十个字）/ turn_ended；
-- - turn_ended 的 outcome：ok / interrupted / failed，summary 是失败原因，duration_ms 是厂商报的这一轮用时（没有是 NULL）；
-- - at：账本记下它的时间（毫秒）；
-- - 用 IF NOT EXISTS：有的测试把 user_version 退回 8 再跑一遍迁移，表已经在了也要能跑完；
-- - dedupe_key：thinking、tool、text 用驱动层事件的 uuid 去重，重放不会记两遍；其余是 NULL。
CREATE TABLE IF NOT EXISTS session_steps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES agent_sessions (id),
  kind        TEXT    NOT NULL CHECK (kind IN ('turn_started', 'thinking', 'tool', 'tool_result', 'text', 'turn_ended')),
  at          INTEGER NOT NULL,
  name        TEXT,
  tool_use_id TEXT,
  summary     TEXT,
  outcome     TEXT    CHECK (outcome IN ('ok', 'interrupted', 'failed')),
  duration_ms INTEGER,
  dedupe_key  TEXT    UNIQUE
) STRICT;

CREATE INDEX IF NOT EXISTS session_steps_session ON session_steps (session_id, id);
