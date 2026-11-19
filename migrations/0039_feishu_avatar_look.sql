-- 0039_feishu_avatar_look：飞书群头像按形象认（docs/slime-cohesion-design.md）：造型 × 颜色，键是 shared/slimes.ts 的 lookKey（如 "persimmon:sky"）。
-- 1. feishu_avatars 的主键从水果换成形象键。这张表只是 image_key 的缓存，直接重建不搬数据（重建也让迁移能重复执行，改主键做不到）；
--    下一次对齐时每个用到的形象重传一次，已建的群原地换头像（画出来和原来一样，只是换一个 image_key）。
-- 2. feishu_chats.avatar_fruit 改记形象键。列名不改：重建 feishu_chats 要动 feishu_posts、feishu_uploads 的外键和 0034 的触发器，
--    不值得。原来记的水果（没有冒号的）清空，下一次对齐重设；已经是形象键的不动，重复执行不改。
DROP TABLE IF EXISTS feishu_avatars;
CREATE TABLE feishu_avatars (
  look           TEXT    PRIMARY KEY,
  image_key      TEXT    NOT NULL,
  content_sha256 TEXT    NOT NULL,
  uploaded_at    INTEGER NOT NULL
) STRICT;

UPDATE feishu_chats SET avatar_fruit = NULL WHERE avatar_fruit IS NOT NULL AND instr(avatar_fruit, ':') = 0;
