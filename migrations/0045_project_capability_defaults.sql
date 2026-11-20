-- 0045_project_capability_defaults: Project defaults, the capability policy every project inherits.
-- Rows store only what differs from the built-in default, which is every kind set to all, so a fresh install has no rows.
-- pm_capability_policies and pm_capability_overrides now hold a project's own choices on top of these defaults: a missing
-- pm base row means "inherit the default", which keeps every existing project's effective policy unchanged.
CREATE TABLE IF NOT EXISTS default_capability_policies (
  kind       TEXT    PRIMARY KEY CHECK (kind IN ('skill', 'mcp', 'connector')),
  base       TEXT    NOT NULL CHECK (base IN ('all', 'none')),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS default_capability_overrides (
  item_key   TEXT    PRIMARY KEY,
  enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL
) STRICT;
