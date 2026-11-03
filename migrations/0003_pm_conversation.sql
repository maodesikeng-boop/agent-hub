-- 0003_pm_conversation：一个项目经理就是一个会话（用户 2026-11-03 定的，m2-plan 第 1 节）。
-- 不再有项目群、一个项目经理管多个项目、交接。“项目”留着，就是一套文件夹，挂在项目经理唯一的那个对话（kind = 'pm'）上：
-- projects.conversation_id 指向项目经理的私聊，会话在主文件夹里跑，附加文件夹用 --add-dir 带进去。
-- 约定同 0001、0002。老数据一行不删：迁移器升级前已经把库备份成 hub.sqlite.bak-2-<时间>（见 src/daemon/store/migrate.ts）。

-- ---- 老的项目群：项目标归档，群里的会话标已结束 ----
-- 群、群里的消息、交接（handoffs）、hub_calls 都留在库里；账本不再建群、不再写 handoffs，快照里不给群和归档的项目，网页上看不到。
-- 会话标 ended：驱动层对它的 start、send 抛 session_ended，升级前还没处理完的动作按“会话已结束”收尾，不会在看不见的群里起 claude。
UPDATE projects
  SET status = 'archived', updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
  WHERE status = 'active'
    AND conversation_id IN (SELECT id FROM conversations WHERE kind = 'project_group');

UPDATE agent_sessions
  SET status = 'ended'
  WHERE conversation_id IN (SELECT id FROM conversations WHERE kind = 'project_group');

-- ---- 一个项目经理同时只管一个进行中的项目 ----
CREATE UNIQUE INDEX projects_active_pm ON projects (pm_id) WHERE status = 'active';

-- ---- 项目名不再唯一：hub 不再按名字找项目（每个项目经理只有一个），名字只是给人看的，默认是主文件夹的名字 ----
DROP INDEX projects_active_name;

-- ---- 主文件夹路径的唯一改由账本查 ----
-- 规则不变：同一个真实路径只能当一个“进行中”项目的主文件夹。但部分索引没法按 projects.status 过滤，
-- 留着的话老群（已归档）的主文件夹会一直占着路径，用户在项目经理的会话里用同一个文件夹建项目会被拒。
DROP INDEX project_folders_main_path;
