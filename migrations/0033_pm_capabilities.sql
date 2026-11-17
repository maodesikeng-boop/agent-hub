-- 0033_pm_capabilities：每个项目经理能用的技能、MCP、云端连接器（docs/pm-capabilities-design.md）。
-- 只存和默认不同的部分：没有行的项目经理三类都是 all、没有单独设置，启动参数和以前一样，存量不用回填。
CREATE TABLE IF NOT EXISTS pm_capability_policies (
  pm_id      INTEGER NOT NULL REFERENCES pms (id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL CHECK (kind IN ('skill', 'mcp', 'connector')),
  base       TEXT    NOT NULL CHECK (base IN ('all', 'none')), -- 没单独设过的项默认开还是关
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (pm_id, kind)
) STRICT;

CREATE TABLE IF NOT EXISTS pm_capability_overrides (
  pm_id      INTEGER NOT NULL REFERENCES pms (id) ON DELETE CASCADE,
  item_key   TEXT    NOT NULL, -- shared/pm-capabilities.ts 的 capabilityKey：skill:<名>、mcp:<名>、connector:<厂商>:<编号>
  enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (pm_id, item_key)
) STRICT;
