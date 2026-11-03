-- 0002_projects：M2 的项目经理、项目、交接、性格设定、hub 调用记录（设计第 6.2 节，m2-plan 第 3 节第 1 条）。
-- 约定同 0001。迁移器跑每个文件时关着外键检查，提交前用 PRAGMA foreign_key_check 查一遍（见 src/daemon/store/migrate.ts），
-- 所以这里可以按 SQLite 的标准做法重建被引用的表（https://www.sqlite.org/lang_altertable.html 第 7 节）。

-- ---- pms：重建，mode 改成两种模式并加 CHECK，名字唯一，加 persona ----
-- M1 的 'default' 一律变成 'manage_only'。persona 是性格设定正文，以它为准（personas/pm-<编号>.md 只是副本）；
-- M1 升上来的是 NULL，守护进程启动时 syncPersonaFiles 按文件填上。
CREATE TABLE pms_new (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL UNIQUE,
  avatar_file   TEXT,
  mode          TEXT    NOT NULL DEFAULT 'manage_only' CHECK (mode IN ('manage_only', 'hands_on')),
  default_model TEXT,
  persona_file  TEXT,
  persona       TEXT,
  created_at    INTEGER NOT NULL
) STRICT;

INSERT INTO pms_new (id, name, avatar_file, mode, default_model, persona_file, persona, created_at)
  SELECT id, name, avatar_file,
         CASE WHEN mode IN ('manage_only', 'hands_on') THEN mode ELSE 'manage_only' END,
         default_model, persona_file, NULL, created_at
  FROM pms;

DROP TABLE pms;
ALTER TABLE pms_new RENAME TO pms;

-- ---- agent_sessions：记属于哪个项目经理 ----
-- 项目经理的会话一定有（同一个群换人后，旧一代仍属于原项目经理）；总助、Worker 是 NULL。M1 的按对话补上。
ALTER TABLE agent_sessions ADD COLUMN pm_id INTEGER REFERENCES pms (id);

UPDATE agent_sessions
  SET pm_id = (SELECT c.pm_id FROM conversations c WHERE c.id = agent_sessions.conversation_id)
  WHERE role = 'pm' AND pm_id IS NULL;

CREATE INDEX agent_sessions_pm ON agent_sessions (pm_id);

-- ---- conversations：一个项目只有一个群 ----
-- conversations.project_id 没有外键（0001 建表时 projects 还没有，加外键要重建 conversations 及其下游，不值得）；由账本保证。
CREATE UNIQUE INDEX conversations_project_group ON conversations (project_id) WHERE kind = 'project_group';

-- ---- projects ----
-- 建项目的顺序（同一个事务）：先建群（project_id 空）、再建项目（conversation_id 指向群）、再回填群的 project_id。
CREATE TABLE projects (
  id              INTEGER PRIMARY KEY,
  name            TEXT    NOT NULL,
  description     TEXT,
  status          TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
  pm_id           INTEGER NOT NULL REFERENCES pms (id),
  conversation_id INTEGER NOT NULL UNIQUE REFERENCES conversations (id),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;

-- 进行中的项目名字唯一；归档、删除的不占名字。
CREATE UNIQUE INDEX projects_active_name ON projects (name) WHERE status = 'active';
CREATE INDEX projects_pm ON projects (pm_id);

-- ---- project_folders ----
-- path 是真实路径。移除只标 removed_at，不删行；主文件夹不能标移除（换主文件夹 M2 不做，以后先把 is_main 改成 0）。
CREATE TABLE project_folders (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id),
  path       TEXT    NOT NULL,
  is_main    INTEGER NOT NULL DEFAULT 0 CHECK (is_main IN (0, 1)),
  added_at   INTEGER NOT NULL,
  removed_at INTEGER,
  CHECK (is_main = 0 OR removed_at IS NULL)
) STRICT;

-- 一个项目同一时间只有一个主文件夹。
CREATE UNIQUE INDEX project_folders_one_main ON project_folders (project_id) WHERE is_main = 1 AND removed_at IS NULL;
-- 同一个真实路径只能当一个项目的主文件夹。M2 的项目都是进行中的；M4 归档、删除项目时要决定它的主文件夹还占不占这个路径。
CREATE UNIQUE INDEX project_folders_main_path ON project_folders (path) WHERE is_main = 1 AND removed_at IS NULL;
-- 同一个项目同一个路径同一时间只挂一次；移除后可以再挂。
CREATE UNIQUE INDEX project_folders_attached ON project_folders (project_id, path) WHERE removed_at IS NULL;

-- ---- persona_changes：性格设定的每次修改 ----
-- actor（user / pm / file）会扩展，不加 CHECK。text_before / text_after 不叫 before / after：那是 SQL 关键字。
CREATE TABLE persona_changes (
  id          INTEGER PRIMARY KEY,
  pm_id       INTEGER NOT NULL REFERENCES pms (id),
  actor       TEXT    NOT NULL,
  session_id  INTEGER REFERENCES agent_sessions (id),
  text_before TEXT    NOT NULL,
  text_after  TEXT    NOT NULL,
  mode_before TEXT    NOT NULL CHECK (mode_before IN ('manage_only', 'hands_on')),
  mode_after  TEXT    NOT NULL CHECK (mode_after IN ('manage_only', 'hands_on')),
  reason      TEXT,
  revert_of   INTEGER REFERENCES persona_changes (id),
  created_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX persona_changes_pm ON persona_changes (pm_id, id);

-- ---- handoffs：交接 ----
-- 正文在 file（state/handoffs/<项目编号>/<时间>.md）。reason 会扩展（会话太长、换主文件夹），不加 CHECK。
CREATE TABLE handoffs (
  id              INTEGER PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES projects (id),
  from_session_id INTEGER NOT NULL REFERENCES agent_sessions (id),
  to_session_id   INTEGER NOT NULL REFERENCES agent_sessions (id),
  from_pm_id      INTEGER NOT NULL REFERENCES pms (id),
  to_pm_id        INTEGER NOT NULL REFERENCES pms (id),
  file            TEXT    NOT NULL,
  reason          TEXT    NOT NULL,
  created_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX handoffs_project ON handoffs (project_id, id);

-- ---- hub_calls：hub 调用记录（设计里没有，m2-plan 第 7 节第 9 条）----
-- 令牌不对、参数校验没过的请求到不了账本，不记。args 是请求体 JSON；result 成功时是返回的 text，失败时是 message。
CREATE TABLE hub_calls (
  id         INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES agent_sessions (id),
  command    TEXT    NOT NULL,
  args       TEXT    NOT NULL,
  ok         INTEGER NOT NULL CHECK (ok IN (0, 1)),
  error_code TEXT,
  result     TEXT    NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX hub_calls_session ON hub_calls (session_id, id);
