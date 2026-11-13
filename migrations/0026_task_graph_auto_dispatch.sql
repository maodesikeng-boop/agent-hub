-- 0026_task_graph_auto_dispatch：编排简化第 5a 步，补齐整张图目标与步骤自动开工/模型参数列（docs/orchestration-simplify-design.md 第 4.3 节）。
-- 必须支持从 user_version = 8、24、25 重复执行（SQLite 的 ALTER TABLE ADD COLUMN 重跑会报 duplicate column name）：
-- 按 SQLite 标准表重建法重建 task_graphs 与 task_graph_steps，用 NATURAL LEFT JOIN 兼容“旧表无新列”与“重跑时已有新列且存有数据”两种形态，
-- 保留原 id、sqlite_sequence 自增水位、外键约束、CHECK 约束与全部索引。

-- 1. task_graphs：新增 goal TEXT
CREATE TABLE task_graphs_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pm_id           INTEGER NOT NULL REFERENCES pms(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  title           TEXT    NOT NULL,
  goal            TEXT,
  status          TEXT    NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
  origin_msg_id   INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  completed_at    INTEGER
) STRICT;

INSERT INTO task_graphs_new (
  id, project_id, pm_id, conversation_id, title, goal, status, origin_msg_id, created_at, updated_at, completed_at
)
SELECT
  id, project_id, pm_id, conversation_id, title, goal, status, origin_msg_id, created_at, updated_at, completed_at
FROM task_graphs NATURAL LEFT JOIN (SELECT NULL AS goal)
ORDER BY id;

INSERT INTO sqlite_sequence (name, seq)
  SELECT 'task_graphs_new', seq FROM sqlite_sequence
  WHERE name = 'task_graphs' AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'task_graphs_new');
UPDATE sqlite_sequence SET seq = max(seq, (SELECT seq FROM sqlite_sequence WHERE name = 'task_graphs'))
  WHERE name = 'task_graphs_new' AND EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'task_graphs');

DROP TABLE task_graphs;
ALTER TABLE task_graphs_new RENAME TO task_graphs;

CREATE INDEX IF NOT EXISTS idx_task_graphs_active
  ON task_graphs(project_id, updated_at DESC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_task_graphs_pm_active
  ON task_graphs(pm_id, updated_at DESC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_task_graphs_project_history
  ON task_graphs(project_id, id DESC)
  WHERE status != 'active';

-- 2. task_graph_steps：新增 brief、vendor、model、effort、readonly、max_time_ms、confirm、review、base、pm_note
CREATE TABLE task_graph_steps_new (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  graph_id            INTEGER NOT NULL REFERENCES task_graphs(id) ON DELETE CASCADE,
  node_key            TEXT    NOT NULL,
  title               TEXT    NOT NULL,
  brief               TEXT,
  vendor              TEXT,
  model               TEXT,
  effort              TEXT,
  readonly            INTEGER NOT NULL DEFAULT 0 CHECK (readonly IN (0, 1)),
  max_time_ms         INTEGER,
  confirm             INTEGER NOT NULL DEFAULT 0 CHECK (confirm IN (0, 1)),
  review              INTEGER NOT NULL DEFAULT 0 CHECK (review IN (0, 1)),
  base                TEXT,
  pm_note             TEXT,
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
  CHECK ((status = 'waiting') = (waiting_for IS NOT NULL)),
  CHECK (skipped = 0 OR status = 'done')
) STRICT;

INSERT INTO task_graph_steps_new (
  id, graph_id, node_key, title,
  brief, vendor, model, effort, readonly, max_time_ms, confirm, review, base, pm_note,
  status, waiting_for, skipped, sort_order,
  active_worker_id, worker_ids_json, artifact_json,
  gate_question, gate_options_json, gate_summary_md, gate_recommended, gate_ask_message_id, decision_json,
  created_at, updated_at
)
SELECT
  id, graph_id, node_key, title,
  brief, vendor, model, effort,
  COALESCE(readonly, 0), max_time_ms, COALESCE(confirm, 0), COALESCE(review, 0), base, pm_note,
  status, waiting_for, skipped, sort_order,
  active_worker_id, worker_ids_json, artifact_json,
  gate_question, gate_options_json, gate_summary_md, gate_recommended, gate_ask_message_id, decision_json,
  created_at, updated_at
FROM task_graph_steps NATURAL LEFT JOIN (
  SELECT NULL AS brief, NULL AS vendor, NULL AS model, NULL AS effort,
         NULL AS readonly, NULL AS max_time_ms, NULL AS confirm, NULL AS review,
         NULL AS base, NULL AS pm_note
)
ORDER BY id;

INSERT INTO sqlite_sequence (name, seq)
  SELECT 'task_graph_steps_new', seq FROM sqlite_sequence
  WHERE name = 'task_graph_steps' AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'task_graph_steps_new');
UPDATE sqlite_sequence SET seq = max(seq, (SELECT seq FROM sqlite_sequence WHERE name = 'task_graph_steps'))
  WHERE name = 'task_graph_steps_new' AND EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'task_graph_steps');

DROP TABLE task_graph_steps;
ALTER TABLE task_graph_steps_new RENAME TO task_graph_steps;

CREATE INDEX IF NOT EXISTS idx_task_graph_steps_worker
  ON task_graph_steps(active_worker_id)
  WHERE active_worker_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_task_graph_steps_waiting_user
  ON task_graph_steps(graph_id)
  WHERE status = 'waiting' AND waiting_for = 'user';
