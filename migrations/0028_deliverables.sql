-- 0028_deliverables：总助条目上挂的交付物（方案、验收结论、截图、录屏的副本，shared/deliverables.ts 的 Deliverable[] JSON）。
-- 单独一张表而不是给 router_items 加列：迁移要能重复执行（几个测试把 user_version 退回去重跑），SQLite 的 ADD COLUMN 做不到。
-- 没有行的条目当空列表；条目删掉时跟着删。
CREATE TABLE IF NOT EXISTS router_item_deliverables (
  item_id           INTEGER PRIMARY KEY REFERENCES router_items (id) ON DELETE CASCADE,
  deliverables_json TEXT    NOT NULL
) STRICT;
