-- 0013_handovers：后台写交接（docs/background-handover-design.md 第 8 节）。一次交接一行：复制项目经理的会话、复制那份在后台写交接、
-- 写好了在旧会话两轮之间换代。状态见 shared/handover.ts 的 HANDOVER_STATUSES；流程在 ledger/handover.ts，干活的是 daemon/handover/runner.ts。
-- 约定同 0001～0012：状态列限制取值，会扩展的（method、厂商）不在库里限制。只加新表，老数据一行不动。
-- 用 IF NOT EXISTS：有的测试把 user_version 退回 8 再跑一遍迁移。
CREATE TABLE IF NOT EXISTS handovers (
  id               INTEGER PRIMARY KEY,
  conversation_id  INTEGER NOT NULL REFERENCES conversations (id),
  -- 旧会话（被复制的那一代）；每一代自动试了几次、上次失败什么时候，按它数
  from_session_id  INTEGER NOT NULL REFERENCES agent_sessions (id),
  -- 换代后的新会话
  to_session_id    INTEGER REFERENCES agent_sessions (id),
  -- 新会话用哪家、什么模型和思考程度（第 12 节“给已有项目经理换厂商”）：to_vendor 是 NULL = 和旧会话一样（三列都照抄旧会话）；
  -- 不是 NULL 就照这三列开（to_model、to_effort 是 NULL = 新厂商的默认）。复制、写交接永远用旧会话的厂商。
  to_vendor        TEXT,
  to_model         TEXT,
  to_effort        TEXT,
  auto             INTEGER NOT NULL CHECK (auto IN (0, 1)),
  -- native / copy / in_session：用的哪个办法（排查用）
  method           TEXT,
  status           TEXT NOT NULL CHECK (status IN ('queued', 'forking', 'writing', 'ready', 'switched', 'failed', 'abandoned')),
  -- 切点：开始复制那一刻库里最大的消息编号。交接覆盖到这里，之后的原话全带
  cut_message_id   INTEGER,
  -- 复制那份的身份（shared/handover.ts 的 ForkRef，JSON），重启后凭它清理
  fork_ref         TEXT,
  -- 交接全文
  text             TEXT,
  -- 换代时定稿的开场说明（交接 + 原话），sessionPreamble 直接返回它
  preamble         TEXT,
  -- 复制那份的用量（TokenUsage 的 JSON），不进项目经理会话的用量
  usage            TEXT,
  failure_reason   TEXT,
  created_at       INTEGER NOT NULL,
  started_at       INTEGER,
  ready_at         INTEGER,
  switched_at      INTEGER,
  cleaned_at       INTEGER,
  updated_at       INTEGER NOT NULL
) STRICT;

-- 每个对话同时最多一行不在终态（同 ACTIVE_HANDOVER_STATUSES）
CREATE UNIQUE INDEX IF NOT EXISTS handovers_active ON handovers (conversation_id) WHERE status IN ('queued', 'forking', 'writing', 'ready');
-- 守护进程启动时补清复制那份
CREATE INDEX IF NOT EXISTS handovers_uncleaned ON handovers (id) WHERE cleaned_at IS NULL AND fork_ref IS NOT NULL;
-- 按一代会话数自动试的次数
CREATE INDEX IF NOT EXISTS handovers_from_session ON handovers (from_session_id);
