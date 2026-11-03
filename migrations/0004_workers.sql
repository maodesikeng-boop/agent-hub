-- 0004_workers：M3 的 Worker（m3-plan 第 3 节接口约定）。项目经理用 hub worker start 派活，每张工单一个 Worker：
-- 它自己的对话（kind = 'worker'，左栏不显示）和会话（role = 'worker'，agent_sessions.ticket_id 指向工单）。
-- 约定同 0001～0003。老数据一行不改：迁移器升级前已经把库备份成 hub.sqlite.bak-3-<时间>（见 src/daemon/store/migrate.ts）。
-- agent_sessions.ticket_id、messages.ticket_id 0001 就有了（没有外键，由账本保证），这里不动。

-- ---- conversations：kind 加 'worker'，要重建表（CHECK 改不了）----
-- 迁移器跑这个文件时关着外键检查、提交前查一遍，所以可以照 SQLite 的标准做法重建被引用的表
-- （https://www.sqlite.org/lang_altertable.html 第 7 节）。agent_sessions、messages、projects 指向它的外键按表名，重建后照常生效。
-- Worker 的对话：pm_id 是派它的项目经理，project_id 是工单的项目，title 是工单标题。
CREATE TABLE conversations_new (
  id         INTEGER PRIMARY KEY,
  kind       TEXT    NOT NULL CHECK (kind IN ('assistant', 'pm', 'project_group', 'worker')),
  pm_id      INTEGER REFERENCES pms (id),
  project_id INTEGER,
  title      TEXT    NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

INSERT INTO conversations_new (id, kind, pm_id, project_id, title, created_at)
  SELECT id, kind, pm_id, project_id, title, created_at FROM conversations;

DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;

-- 删表时索引跟着没了，照 0001、0002 原样建回来。Worker 的对话一个项目经理可以有很多个，不受这两条限制。
CREATE UNIQUE INDEX conversations_pm_private ON conversations (pm_id, kind) WHERE kind = 'pm';
CREATE UNIQUE INDEX conversations_project_group ON conversations (project_id) WHERE kind = 'project_group';

-- ---- tickets：工单（设计第 2.3、8.4 节，m3-plan 第 2 节）----
-- 一张工单就是一次派活。字段说明见 src/shared/domain.ts 的 Ticket。
-- - pm_conversation_id：汇报那一行发到哪（项目经理的对话）；worker_conversation_id：Worker 自己的对话，一张工单一个；
-- - model：派活时 --model 给的；NULL = 用项目经理自己的模型（账本建 Worker 会话时定下来写进 agent_sessions.model）；
-- - readonly：--readonly，Worker 被打回、重启都沿用；
-- - workspace：worktree（守护进程建的 git worktree）或 main（直接在项目的主文件夹里干）。
--   worktree：branch、worktree_path 派活时就定好；base_commit 是建 worktree 时 HEAD 的提交，建好之前是 NULL。
--   main：三列都是 NULL；
-- - status：open / ended（hub worker end、建 worktree 彻底失败）。别的状态（做完了、有问题……）只在汇报那一行里，不在这里。
CREATE TABLE tickets (
  id                     INTEGER PRIMARY KEY,
  project_id             INTEGER NOT NULL REFERENCES projects (id),
  pm_id                  INTEGER NOT NULL REFERENCES pms (id),
  pm_conversation_id     INTEGER NOT NULL REFERENCES conversations (id),
  worker_conversation_id INTEGER NOT NULL UNIQUE REFERENCES conversations (id),
  title                  TEXT    NOT NULL,
  task                   TEXT    NOT NULL,
  model                  TEXT,
  readonly               INTEGER NOT NULL DEFAULT 0 CHECK (readonly IN (0, 1)),
  workspace              TEXT    NOT NULL CHECK (workspace IN ('worktree', 'main')),
  branch                 TEXT,
  worktree_path          TEXT,
  base_commit            TEXT,
  status                 TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'ended')),
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  CHECK (workspace = 'main' OR (branch IS NOT NULL AND worktree_path IS NOT NULL)),
  CHECK (workspace = 'worktree' OR (branch IS NULL AND worktree_path IS NULL AND base_commit IS NULL))
) STRICT;

-- hub worker list：某个项目经理派出去的工单。
CREATE INDEX tickets_pm ON tickets (pm_id, id);
