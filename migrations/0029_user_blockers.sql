-- 0029_user_blockers：要用户本人动手才解得开的阻塞（docs/user-blockers-design.md）。
-- 同一家厂商在这台设备上只有一条在等；被卡住的步骤记在 user_blocker_steps，起不来的 Worker 连同没送进去的消息记在 user_blocker_workers。
-- 不改 task_graph_steps 的列；要能从 user_version = 8 起重跑，表、索引、触发器都带 IF NOT EXISTS
-- （0026 重跑会重建 task_graph_steps、连带删掉它上面的触发器，这里重跑时再建回来）。
CREATE TABLE IF NOT EXISTS user_blockers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT    NOT NULL CHECK (kind IN ('vendor_signed_out', 'vendor_not_installed')),
  vendor          TEXT    NOT NULL,
  device          TEXT    NOT NULL,
  status          TEXT    NOT NULL CHECK (status IN ('open', 'resolved')),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ask_message_id  INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  rechecked_as    TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS user_blockers_open_vendor ON user_blockers (vendor) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS user_blocker_steps (
  step_id    INTEGER PRIMARY KEY REFERENCES task_graph_steps(id) ON DELETE CASCADE,
  blocker_id INTEGER NOT NULL REFERENCES user_blockers(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS user_blocker_steps_blocker ON user_blocker_steps (blocker_id);

CREATE TABLE IF NOT EXISTS user_blocker_workers (
  blocker_id       INTEGER NOT NULL REFERENCES user_blockers(id) ON DELETE CASCADE,
  worker_id        INTEGER NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  message_ids_json TEXT    NOT NULL,
  PRIMARY KEY (blocker_id, worker_id)
) STRICT;

CREATE INDEX IF NOT EXISTS user_blocker_workers_worker ON user_blocker_workers (worker_id);

-- 步骤离开“等用户”（换人、跳过、放行……）就不再被卡着：改步骤状态的代码不用记得清这张表
CREATE TRIGGER IF NOT EXISTS task_graph_steps_user_blocker_clear
AFTER UPDATE OF status, waiting_for ON task_graph_steps
WHEN NEW.status <> 'waiting' OR NEW.waiting_for IS NOT 'user'
BEGIN
  DELETE FROM user_blocker_steps WHERE step_id = NEW.id;
END;
