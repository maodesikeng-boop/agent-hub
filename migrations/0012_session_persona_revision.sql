-- 0012_session_persona_revision：每个会话的 agent 已经看到的性格设定、模式是哪一版（persona_changes 的编号，驱动层写）。
-- 约定同 0001～0011。只加一张新表，老数据一行不动（没有这一行：没记过，驱动层按这次拼的提示词算）。
-- 性格设定、模式改了不重启，驱动层在下一条消息前加说明（shared/driver.ts 的“两轮之间自动重启”）；claude 2.1.314 恢复会话
-- （--resume）沿用会话最初的系统提示词，所以“看到了哪一版”要跟着会话走、守护进程重启也接得上，不能按进程算。
-- 单独一张表、用 IF NOT EXISTS（不在 agent_sessions 上加列）：有的测试把 user_version 退回 8 再跑一遍迁移，ADD COLUMN 跑不了第二遍。
CREATE TABLE IF NOT EXISTS session_persona_seen (
  session_id INTEGER PRIMARY KEY REFERENCES agent_sessions (id),
  revision   INTEGER NOT NULL
);
