-- 0032_project_catalogs：总助的项目目录（docs/router-project-catalog-design.md）。一个项目一行，后台按账本里的对话增量自动维护。
-- 档案正文是 shared/project-catalog.ts 的 ProjectCatalog（JSON）。删项目时跟着删。
-- 实现步骤在同一个文件里补 DROP TABLE router_pm_notes（hub router note 一起删）；方案 PR 不单独合入。
CREATE TABLE IF NOT EXISTS project_catalogs (
  project_id      INTEGER PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  -- ProjectCatalog 的 JSON；NULL = 还没写成过（只有失败记录）
  catalog_json    TEXT,
  -- 档案覆盖到的最大消息编号：之后的对话算增量
  cut_message_id  INTEGER NOT NULL DEFAULT 0,
  -- 最近一次写成的时刻；NULL = 还没写成过
  refreshed_at    INTEGER,
  -- 有事件（任务图结束、项目经理换代）要求下次到最短间隔就刷新，不看增量字数
  forced          INTEGER NOT NULL DEFAULT 0 CHECK (forced IN (0, 1)),
  -- 当前切点上连续失败了几次，写成后清零
  attempts        INTEGER NOT NULL DEFAULT 0,
  -- 失败退避：这之前不再试
  next_attempt_at INTEGER,
  last_error      TEXT,
  -- 上次写档的用量（TokenUsage 的 JSON），排查用
  usage           TEXT,
  updated_at      INTEGER NOT NULL
) STRICT;
