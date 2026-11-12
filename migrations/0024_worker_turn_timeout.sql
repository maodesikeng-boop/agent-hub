-- 0024_worker_turn_timeout：编排简化第 3 步（docs/orchestration-simplify-design.md 第 5.2 节、第 10 节第 7 条、第 13 节）。可重复执行。
-- 1. Worker 单轮超时计时落盘：原来只在内存里（ledger/workers.ts 的定时器），守护进程重启就丢。现在每个在计时的 Worker 一行，
--    重启后按库里的截止时刻重新挂定时器（workers.ts 的 recoverTurnTimeouts），已过期的触发一次提醒；提醒过的同一轮不再提醒。
--    单独一张表而不是给 workers 加列：迁移要能重复执行（几个测试把 user_version 退回 8 重跑），SQLite 的 ADD COLUMN 做不到；
--    和 0014 的 worker_background_waits 同一个做法。一轮结束、收工时删掉那一行。
--    - max_time_ms：这一轮设的最大时间（--max-time / hub worker max-time，没给是默认值）；
--    - deadline_at：这一轮的截止时刻（毫秒时间戳，开始计时的时刻 + max_time_ms）；
--    - notified：这一轮的超时提醒发过没有（0 没发 / 1 发过）。
CREATE TABLE IF NOT EXISTS worker_turn_timeouts (
  worker_id   INTEGER PRIMARY KEY REFERENCES workers (id) ON DELETE CASCADE,
  max_time_ms INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  notified    INTEGER NOT NULL DEFAULT 0 CHECK (notified IN (0, 1))
) STRICT;

-- 2. 换人接手同一步（hub worker start --node）时新 Worker 接着用前任的 worktree 和分支，同一个 worktree_path 会被前后几个 Worker 共用：
--    按目录找共用它的 Worker（自动清理时判断还有没有人在用、接手时等前任的会话结束、提示词里写“这是前任 #X 的目录”）。
CREATE INDEX IF NOT EXISTS workers_worktree_path ON workers (worktree_path) WHERE worktree_path IS NOT NULL;
