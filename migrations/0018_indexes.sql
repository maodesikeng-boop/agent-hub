-- 补齐高频查询缺失的索引（幂等迁移）：
-- 1. messages(session_id, sender, id)：按会话查交接状态（insertAgentMessage）、本轮最后一条 agent 消息（workers.ts）、停止处理中的消息（stopIn）；
-- 2. messages(worker_id, id)：按 Worker 查汇报（worker-search.ts）；
-- 3. agent_sessions(worker_id)：按 Worker 查会话（重启恢复、项目删除检查、归档清理）；
-- 4. workers(project_id)：按项目查 Worker（项目删除检查、归档清理）。
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, sender, id);
CREATE INDEX IF NOT EXISTS messages_worker ON messages(worker_id, id);
CREATE INDEX IF NOT EXISTS agent_sessions_worker ON agent_sessions(worker_id);
CREATE INDEX IF NOT EXISTS workers_project ON workers(project_id);
