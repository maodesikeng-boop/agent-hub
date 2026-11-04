-- 0007_token_usage：会话累计用了多少 token（驱动层每轮结束时累加，重启后接着算），给 Worker 面板和以后的资料页显示。
-- 约定同 0001～0006。只加列：老数据一行不删、值不改，NULL = 还没记过（读出来当全 0）。
-- 内容是 JSON：{ input, cacheRead, cacheWrite, output, context }（shared/domain.ts 的 TokenUsage）。
ALTER TABLE agent_sessions ADD COLUMN token_usage TEXT;
