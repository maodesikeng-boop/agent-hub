-- 0028_loaded_skills：项目经理加载过的技能（docs/skill-carryover-design.md）。一个技能一行，换代时按代数取出、把正文带进新会话。
CREATE TABLE IF NOT EXISTS loaded_skills (
  conversation_id INTEGER NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  skill_key       TEXT    NOT NULL, -- SKILL.md 的真实路径（realpath），软链和原文件算同一个技能
  name            TEXT    NOT NULL, -- 规整后的技能名，显示用
  path            TEXT    NOT NULL, -- 最近一次认到的路径，原样
  source          TEXT    NOT NULL CHECK (source IN ('user', 'model')), -- 最近一次是谁加载的
  generation      INTEGER NOT NULL, -- 最近一次加载或被带进的那一代
  loaded_at       INTEGER NOT NULL, -- 最近一次真正加载的时间；被带进下一代时不改
  PRIMARY KEY (conversation_id, skill_key)
) STRICT;

CREATE INDEX IF NOT EXISTS loaded_skills_generation ON loaded_skills (conversation_id, generation, loaded_at DESC);

-- handovers 加 skills_section：换代时拼好的“上一个会话加载过的技能”一节。普通换代已拼进 preamble，切换厂商时开场说明现拼，从这里取。
-- 要能从 user_version = 8 重跑（ALTER TABLE ADD COLUMN 重跑会报 duplicate column name）：照 0026 用表重建法，
-- NATURAL LEFT JOIN 兼容“旧表没有新列”和“重跑时已有新列且有数据”两种形态，保留 id 和全部索引。
CREATE TABLE handovers_new (
  id               INTEGER PRIMARY KEY,
  conversation_id  INTEGER NOT NULL REFERENCES conversations (id),
  -- 旧会话（被复制的那一代）；每一代自动试了几次、上次失败什么时候，按它数
  from_session_id  INTEGER NOT NULL REFERENCES agent_sessions (id),
  -- 换代后的新会话
  to_session_id    INTEGER REFERENCES agent_sessions (id),
  -- 新会话用哪家、什么模型和思考程度：to_vendor 是 NULL = 和旧会话一样（三列都照抄旧会话）；
  -- 不是 NULL 就照这三列开（to_model、to_effort 是 NULL = 新厂商的默认）。复制、写交接永远用旧会话的厂商。
  to_vendor        TEXT,
  to_model         TEXT,
  to_effort        TEXT,
  auto             INTEGER NOT NULL CHECK (auto IN (0, 1)),
  -- native / copy / in_session / vendor_switch：用的哪个办法
  method           TEXT,
  status           TEXT NOT NULL CHECK (status IN ('queued', 'forking', 'writing', 'ready', 'switched', 'failed', 'abandoned')),
  -- 切点：开始复制那一刻库里最大的消息编号。交接覆盖到这里，之后的原话全带
  cut_message_id   INTEGER,
  -- 复制那份的身份（shared/handover.ts 的 ForkRef，JSON），重启后凭它清理
  fork_ref         TEXT,
  -- 交接全文
  text             TEXT,
  -- 换代时定稿的开场说明（技能 + 交接 + 原话），sessionPreamble 直接返回它；切换厂商是 NULL
  preamble         TEXT,
  -- 换代时拼好的“上一个会话加载过的技能”一节（daemon/ledger/loaded-skills.ts）；没有是 NULL
  skills_section   TEXT,
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

INSERT INTO handovers_new (id, conversation_id, from_session_id, to_session_id, to_vendor, to_model, to_effort, auto, method, status, cut_message_id, fork_ref, text, preamble, skills_section, usage, failure_reason, created_at, started_at, ready_at, switched_at, cleaned_at, updated_at)
SELECT id, conversation_id, from_session_id, to_session_id, to_vendor, to_model, to_effort, auto, method, status, cut_message_id, fork_ref, text, preamble, skills_section, usage, failure_reason, created_at, started_at, ready_at, switched_at, cleaned_at, updated_at
FROM handovers NATURAL LEFT JOIN (SELECT NULL AS skills_section)
ORDER BY id;

DROP TABLE handovers;
ALTER TABLE handovers_new RENAME TO handovers;

CREATE UNIQUE INDEX handovers_active ON handovers (conversation_id) WHERE status IN ('queued', 'forking', 'writing', 'ready');
CREATE INDEX handovers_uncleaned ON handovers (id) WHERE cleaned_at IS NULL AND fork_ref IS NOT NULL;
CREATE INDEX handovers_from_session ON handovers (from_session_id);
CREATE INDEX handovers_to_session ON handovers (to_session_id) WHERE to_session_id IS NOT NULL;
CREATE INDEX handovers_conversation ON handovers (conversation_id, id DESC);
