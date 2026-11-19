-- 0038_pm_looks：项目经理换过的造型和颜色（docs/slime-cohesion-design.md）。一个项目经理最多一行；
-- 没有行、或某一列是 NULL，那一项用默认（造型按编号轮着取，颜色用造型自己的原色），老项目经理看起来和以前一样，不回填。
-- 值是 shared/slimes.ts 名录里的 id，读出来不认识的（别的版本写的）当默认。
-- 单独一张表（照 0033）：CREATE TABLE IF NOT EXISTS 能从 user_version = 8 重跑，不用重建 pms。
CREATE TABLE IF NOT EXISTS pm_looks (
  pm_id      INTEGER PRIMARY KEY REFERENCES pms (id) ON DELETE CASCADE,
  fruit      TEXT,
  color      TEXT,
  updated_at INTEGER NOT NULL
) STRICT;
