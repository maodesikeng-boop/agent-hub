-- 0006_agent_settings：项目经理的厂商、模型、思考程度可选可改，派 Worker 能指定思考程度。
-- 厂商、模型、思考程度的取值在 src/shared/vendors.ts（厂商清单），会扩展，不加 CHECK。model、effort 是 NULL = 默认（不传参数）。
-- 约定同 0001～0004。只加列：老数据一行不删、值不改，新列是默认（厂商 claude，模型照旧，思考程度 NULL）。
-- 0005 是 projects.setup_command（worktree 准备命令）。

-- ---- pms：厂商、思考程度。模型还是 default_model（Worker 不给 --model 时也用它）----
ALTER TABLE pms ADD COLUMN vendor TEXT NOT NULL DEFAULT 'claude';
ALTER TABLE pms ADD COLUMN effort TEXT;

-- ---- agent_sessions：思考程度。驱动层启动时按会话这一行的 vendor、model、effort 传参数，变了下一条消息前 --resume 重启 ----
ALTER TABLE agent_sessions ADD COLUMN effort TEXT;

-- ---- workers：hub worker start --effort 给的；NULL = 用项目经理自己的思考程度（同 model）----
ALTER TABLE workers ADD COLUMN effort TEXT;

-- ---- persona_changes：修改记录也记厂商、模型、思考程度的前后两份，撤销时一起改回去 ----
-- 老记录改的时候这三样还改不了，前后都填成项目经理现在的值（撤销老记录不会动它们）。
ALTER TABLE persona_changes ADD COLUMN vendor_before TEXT NOT NULL DEFAULT 'claude';
ALTER TABLE persona_changes ADD COLUMN vendor_after TEXT NOT NULL DEFAULT 'claude';
ALTER TABLE persona_changes ADD COLUMN model_before TEXT;
ALTER TABLE persona_changes ADD COLUMN model_after TEXT;
ALTER TABLE persona_changes ADD COLUMN effort_before TEXT;
ALTER TABLE persona_changes ADD COLUMN effort_after TEXT;

UPDATE persona_changes
  SET model_before = (SELECT default_model FROM pms WHERE pms.id = persona_changes.pm_id),
      model_after  = (SELECT default_model FROM pms WHERE pms.id = persona_changes.pm_id);
