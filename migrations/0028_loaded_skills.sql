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

-- 换代时拼好的“上一个会话加载过的技能”一节：普通换代已拼进 preamble，切换厂商时开场说明现拼，从这里取
ALTER TABLE handovers ADD COLUMN skills_section TEXT;
