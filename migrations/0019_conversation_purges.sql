-- 0019_conversation_purges：已收工的 Worker 满 WORKER_RETENTION_DAYS 天后，对话（消息、步骤日志等）按保留期清掉，
-- 对话行本身、workers 行、agent_sessions 行、项目经理对话里的汇报都留着（hub worker search / show、网页的已收工列表照常能查到结论）。
-- 这张表记“哪个对话清过、什么时候清的”（毫秒）；没有这一行 = 没清过。只有 kind = 'worker' 的对话会有。
-- 单独一张表、用 IF NOT EXISTS（不在 conversations 上加列）：有的测试把 user_version 退回 8 再跑一遍迁移，ADD COLUMN 跑不了第二遍。
-- ON DELETE CASCADE：归档到期清理项目经理时删对话，这一行跟着没（和 0017 的 browser_session_public 一样）。
CREATE TABLE IF NOT EXISTS conversation_purges (
  conversation_id INTEGER PRIMARY KEY REFERENCES conversations (id) ON DELETE CASCADE,
  purged_at       INTEGER NOT NULL
) STRICT;
