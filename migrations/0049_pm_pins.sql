-- 0049_pm_pins: PMs pinned on this computer, ordered by pinned_at. At most one row per PM; no row means not pinned.
-- A side table like 0038 pm_looks, so CREATE TABLE IF NOT EXISTS reruns safely and pms is never rebuilt.
CREATE TABLE IF NOT EXISTS pm_pins (
  pm_id     INTEGER PRIMARY KEY REFERENCES pms (id) ON DELETE CASCADE,
  pinned_at INTEGER NOT NULL
) STRICT;
