-- 0023_router_and_task_graphs.sql
-- Router（总助）与持久化任务图（Task DAG）统一账本表及索引。
-- 全部使用 CREATE TABLE IF NOT EXISTS ... STRICT 与 CREATE INDEX IF NOT EXISTS，不改旧表结构，支持从旧 user_version 幂等重跑。

-- ============================================================
-- 1. Router（总助）6 张表与索引（docs/router-design.md §3.1）
-- ============================================================

-- 1.1 待拍板与里程碑汇报统一收件箱
CREATE TABLE IF NOT EXISTS router_items (
  id              INTEGER PRIMARY KEY,
  pm_id           INTEGER NOT NULL REFERENCES pms(id) ON DELETE CASCADE,
  project_id      INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  session_id      INTEGER REFERENCES agent_sessions(id) ON DELETE SET NULL,
  kind            TEXT    NOT NULL CHECK (kind IN ('decision', 'report')),
  status          TEXT    NOT NULL CHECK (
                    (kind = 'decision' AND status IN ('pending', 'resolved', 'superseded')) OR
                    (kind = 'report'   AND status IN ('unread', 'archived'))
                  ),
  question        TEXT,
  context         TEXT,
  options_json    TEXT,
  summary         TEXT,
  links_json      TEXT,
  resolution_json TEXT,
  ask_message_id  INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS router_items_active
  ON router_items (status, created_at DESC, id DESC)
  WHERE status IN ('pending', 'unread');

CREATE INDEX IF NOT EXISTS router_items_pm_pending
  ON router_items (pm_id, id)
  WHERE kind = 'decision' AND status = 'pending';

CREATE INDEX IF NOT EXISTS router_items_cursor
  ON router_items (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS router_items_ask_msg
  ON router_items (ask_message_id)
  WHERE ask_message_id IS NOT NULL;

-- 1.2 用户在 Router 顶栏发出的跨项目指令与计划记录
CREATE TABLE IF NOT EXISTS router_commands (
  id              INTEGER PRIMARY KEY,
  client_id       TEXT    NOT NULL UNIQUE,
  input_text      TEXT    NOT NULL,
  vendor          TEXT    NOT NULL,
  model           TEXT,
  effort          TEXT,
  status          TEXT    NOT NULL CHECK (status IN ('planning', 'needs_confirm', 'dispatched', 'answered', 'failed', 'cancelled')),
  plan_json       TEXT,
  dispatched_json TEXT,
  error           TEXT,
  duration_ms     INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS router_commands_recent
  ON router_commands (created_at DESC, id DESC);

-- 1.3 每个 PM 写给 Router 的一句话项目近况备忘
CREATE TABLE IF NOT EXISTS router_pm_notes (
  pm_id      INTEGER PRIMARY KEY REFERENCES pms(id) ON DELETE CASCADE,
  text       TEXT    NOT NULL,
  session_id INTEGER REFERENCES agent_sessions(id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- 1.4 Router 自身配置（单例行 id = 1）
CREATE TABLE IF NOT EXISTS router_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  vendor     TEXT,
  model      TEXT,
  effort     TEXT,
  updated_at INTEGER NOT NULL
) STRICT;

-- 1.5 溯源因果链：Worker -> PM 派发消息 -> Router 指令或拍板
CREATE TABLE IF NOT EXISTS router_worker_origins (
  worker_id      INTEGER PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
  source_kind    TEXT    NOT NULL CHECK (source_kind IN ('router_command', 'router_resolve')),
  source_id      INTEGER NOT NULL,
  pm_message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at     INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS router_worker_origins_pm_msg
  ON router_worker_origins (pm_message_id);

-- 1.6 轻量审计环（上限由账本与定期清理控制在 500 行内）
CREATE TABLE IF NOT EXISTS router_audit_log (
  id          INTEGER PRIMARY KEY,
  actor       TEXT    NOT NULL CHECK (actor IN ('pm', 'user', 'router_agent', 'system')),
  action      TEXT    NOT NULL,
  pm_id       INTEGER,
  ref_id      INTEGER,
  detail_json TEXT,
  created_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS router_audit_log_recent
  ON router_audit_log (id DESC);

-- ============================================================
-- 2. 持久化任务图（Task DAG）3 张表与索引（docs/task-graph-design.md §2.2）
-- ============================================================

-- 2.1 任务图主表
CREATE TABLE IF NOT EXISTS task_graphs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pm_id           INTEGER NOT NULL REFERENCES pms(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  title           TEXT    NOT NULL,
  status          TEXT    NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
  origin_msg_id   INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  completed_at    INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS idx_task_graphs_active
  ON task_graphs(project_id, updated_at DESC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_task_graphs_pm_active
  ON task_graphs(pm_id, updated_at DESC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_task_graphs_project_history
  ON task_graphs(project_id, id DESC)
  WHERE status != 'active';

-- 2.2 任务节点表
CREATE TABLE IF NOT EXISTS task_graph_nodes (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  graph_id            INTEGER NOT NULL REFERENCES task_graphs(id) ON DELETE CASCADE,
  node_key            TEXT    NOT NULL,
  title               TEXT    NOT NULL,
  kind                TEXT    NOT NULL CHECK (kind IN ('piece', 'gate')),
  status              TEXT    NOT NULL CHECK (status IN (
                        'pending',
                        'ready',
                        'running',
                        'waiting_user',
                        'attention',
                        'done',
                        'skipped'
                      )),
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
  UNIQUE(graph_id, node_key)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_task_graph_nodes_worker
  ON task_graph_nodes(active_worker_id)
  WHERE active_worker_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_task_graph_nodes_waiting_gate
  ON task_graph_nodes(graph_id)
  WHERE kind = 'gate' AND status = 'waiting_user';

-- 2.3 任务图有向边表（from_key 完成后才解锁 to_key）
CREATE TABLE IF NOT EXISTS task_graph_edges (
  graph_id  INTEGER NOT NULL REFERENCES task_graphs(id) ON DELETE CASCADE,
  from_key  TEXT    NOT NULL,
  to_key    TEXT    NOT NULL,
  PRIMARY KEY (graph_id, from_key, to_key),
  CHECK (from_key != to_key)
) STRICT;
