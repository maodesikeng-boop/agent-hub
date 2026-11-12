-- 0025_task_graph_steps：编排简化第 4 步，步骤状态 7 个变 4 个、节点类型 2 种变 1 种（docs/orchestration-simplify-design.md 第 3 节、第 13 节）。
-- 可重复执行（几个测试把 user_version 退回 8 重跑全部迁移）。
--
-- 为什么换表名而不是原地重建后改回 task_graph_nodes：
--   kind、status 有 CHECK 约束（0023），SQLite 改不了 CHECK，只能建新表拷数据。若新表改回原名，重跑时 0023 的
--   CREATE TABLE IF NOT EXISTS task_graph_nodes 会跳过（表已是新结构），本文件再按旧列（kind、旧状态）去读就会报错。
--   新表叫 task_graph_steps（设计里“节点类型只剩一种：步骤”），旧表拷完就删：
--   - 旧库升级：拷 task_graph_nodes 的全部行到新表，删旧表；
--   - 重跑：0023 重新建出一张空的 task_graph_nodes，这里拷 0 行再删掉，新表的数据原样不动。
--
-- 四个状态：
--   pending 没轮到；running 在干；waiting 等人（waiting_for：user 有拍板卡 / pm 等项目经理）；done 完了（skipped：是不是跳过的）。
-- 旧值到新值（第 3.4 节，全量，没有特殊分支；网页读入旧数据时用同一张表，见 shared/domain.ts 的 taskNodeStateFromLegacy）：
--   pending → pending；ready → waiting/pm；running → running；attention → waiting/pm；
--   waiting_user → waiting/user；done → done；skipped → done，skipped = 1。
-- kind 列删掉：gate 的问题、选项、摘要、推荐、卡片消息、定案（gate_* 与 decision_json）原样保留，就是挂在步骤上的拍板卡。
CREATE TABLE IF NOT EXISTS task_graph_steps (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  graph_id            INTEGER NOT NULL REFERENCES task_graphs(id) ON DELETE CASCADE,
  node_key            TEXT    NOT NULL,
  title               TEXT    NOT NULL,
  status              TEXT    NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'done')),
  waiting_for         TEXT    CHECK (waiting_for IN ('user', 'pm')),
  skipped             INTEGER NOT NULL DEFAULT 0 CHECK (skipped IN (0, 1)),
  sort_order          INTEGER NOT NULL DEFAULT 0,
  active_worker_id    INTEGER REFERENCES workers(id) ON DELETE SET NULL,
  worker_ids_json     TEXT    NOT NULL DEFAULT '[]',
  artifact_json       TEXT,
  gate_question       TEXT,
  gate_options_json   TEXT,
  gate_summary_md     TEXT,
  gate_recommended    TEXT,
  gate_ask_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  decision_json       TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (graph_id, node_key),
  -- 等谁只在等人时有；跳过只在完了时有
  CHECK ((status = 'waiting') = (waiting_for IS NOT NULL)),
  CHECK (skipped = 0 OR status = 'done')
) STRICT;

INSERT INTO task_graph_steps (
  id, graph_id, node_key, title, status, waiting_for, skipped, sort_order,
  active_worker_id, worker_ids_json, artifact_json,
  gate_question, gate_options_json, gate_summary_md, gate_recommended, gate_ask_message_id, decision_json,
  created_at, updated_at
)
SELECT
  id, graph_id, node_key, title,
  CASE status
    WHEN 'pending' THEN 'pending'
    WHEN 'running' THEN 'running'
    WHEN 'done' THEN 'done'
    WHEN 'skipped' THEN 'done'
    ELSE 'waiting'
  END,
  CASE status
    WHEN 'waiting_user' THEN 'user'
    WHEN 'ready' THEN 'pm'
    WHEN 'attention' THEN 'pm'
    ELSE NULL
  END,
  CASE status WHEN 'skipped' THEN 1 ELSE 0 END,
  sort_order,
  active_worker_id, worker_ids_json, artifact_json,
  gate_question, gate_options_json, gate_summary_md, gate_recommended, gate_ask_message_id, decision_json,
  created_at, updated_at
FROM task_graph_nodes;

-- 编号接着旧表往下发（旧表删过行时它的计数可能比现存最大编号大），不复用删掉的节点编号
UPDATE sqlite_sequence
   SET seq = (SELECT max(seq) FROM sqlite_sequence WHERE name IN ('task_graph_nodes', 'task_graph_steps'))
 WHERE name = 'task_graph_steps';
INSERT INTO sqlite_sequence (name, seq)
  SELECT 'task_graph_steps', seq FROM sqlite_sequence
   WHERE name = 'task_graph_nodes'
     AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'task_graph_steps');

-- 旧表的两个索引（idx_task_graph_nodes_worker、idx_task_graph_nodes_waiting_gate）随表一起删
DROP TABLE IF EXISTS task_graph_nodes;

CREATE INDEX IF NOT EXISTS idx_task_graph_steps_worker
  ON task_graph_steps(active_worker_id)
  WHERE active_worker_id IS NOT NULL;

-- 待拍板流、总助摘要按“等用户”的步骤查（原来按 kind = 'gate' AND status = 'waiting_user'）
CREATE INDEX IF NOT EXISTS idx_task_graph_steps_waiting_user
  ON task_graph_steps(graph_id)
  WHERE status = 'waiting' AND waiting_for = 'user';
