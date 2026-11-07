-- 0014_worker_background_waits：Worker 一轮正常结束时还有后台命令在跑、先不汇报的（ledger/workers.ts 的 awaitingBackground）。
-- 约定同 0001～0013。只加一张新表，老数据一行不动。原来只在内存里：守护进程被杀（没走关机、驱动层的 session.exited 没来）
-- 重启后没人记得它在等，后台命令随旧进程没了，项目经理永远收不到这一轮的汇报。重启恢复按这张表补发一次（workers.ts 的 recoverBackgroundWaits）。
-- 单独一张表、用 IF NOT EXISTS（不在 agent_sessions 上加列）：有的测试把 user_version 退回去再跑一遍迁移。
CREATE TABLE IF NOT EXISTS worker_background_waits (
  session_id INTEGER PRIMARY KEY REFERENCES agent_sessions (id),
  -- 等后台命令那一轮开头时库里最大的消息编号：汇报取它之后最后一段文字
  turn_start INTEGER NOT NULL,
  -- 现在还有没有后台命令（驱动层的 background.changed）：进程被关时说明“后台命令被停了”用
  background INTEGER NOT NULL CHECK (background IN (0, 1)),
  created_at INTEGER NOT NULL
) STRICT;
