-- 0044_capability_scopes: Router external capability policy plus per-Worker and per-step capability modes.
-- Router rows store only what differs from the Router default, which is every kind set to none.
CREATE TABLE IF NOT EXISTS router_capability_policies (
  kind       TEXT    PRIMARY KEY CHECK (kind IN ('skill', 'mcp', 'connector')),
  base       TEXT    NOT NULL CHECK (base IN ('all', 'none')),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS router_capability_overrides (
  item_key   TEXT    PRIMARY KEY,
  enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL
) STRICT;

-- Side tables instead of ADD COLUMN keep this migration re-runnable; a missing row means inherit the project's policy.
-- capabilities_json is {"mode":"none"} or {"mode":"custom","allow":[capability keys]}.
CREATE TABLE IF NOT EXISTS worker_capabilities (
  worker_id         INTEGER PRIMARY KEY REFERENCES workers (id) ON DELETE CASCADE,
  capabilities_json TEXT    NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS task_graph_step_capabilities (
  step_id           INTEGER PRIMARY KEY REFERENCES task_graph_steps (id) ON DELETE CASCADE,
  capabilities_json TEXT    NOT NULL
) STRICT;
