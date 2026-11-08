-- 项目经理归档记录：归档后保留 7 天可恢复，到期由守护进程清理该 PM 的全部账本与内部磁盘数据。
CREATE TABLE IF NOT EXISTS pm_archives (
  pm_id       INTEGER PRIMARY KEY REFERENCES pms (id),
  archived_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS pm_archives_at ON pm_archives (archived_at);
