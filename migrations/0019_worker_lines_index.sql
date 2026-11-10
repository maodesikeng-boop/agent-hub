-- 初始快照（ledger.ts 的 snapshot）每次都要把项目经理对话里的 Worker 行（kind worker）全拿出来算每个 Worker 最近一行的摘要
-- （shared/snapshot.ts）；messages 没有按 kind 的索引，要扫整张表。只给这些行建一个部分索引。
CREATE INDEX IF NOT EXISTS messages_worker_lines ON messages(id) WHERE kind = 'worker';
