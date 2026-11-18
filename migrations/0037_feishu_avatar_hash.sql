-- 0037_feishu_avatar_hash：群头像按图片内容认（docs/feishu-design.md「自动建群」）。
-- feishu_avatars 加 content_sha256：上传的那张图片文件内容的 SHA-256，图片换了（哈希对不上）就重传。
-- 这张表只是 image_key 的缓存，老行记的是已经删掉的旧头像，直接重建不搬数据（重建也让迁移能重复执行，ADD COLUMN 做不到）；
-- 下一次对齐时每个用到的水果重传一次，已建的群原地换头像。
DROP TABLE IF EXISTS feishu_avatars;
CREATE TABLE feishu_avatars (
  fruit          TEXT    PRIMARY KEY,
  image_key      TEXT    NOT NULL,
  content_sha256 TEXT    NOT NULL,
  uploaded_at    INTEGER NOT NULL
) STRICT;
