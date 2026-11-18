-- 0035_feishu_uploads：附件和卡片同发（docs/feishu-design.md「交付与附件」）。
-- feishu_posts 加 media_key（嵌进卡片的图片编号、发出去的文件编号），state 加 uploading（卡已发、附件还在传，重启后接着补传）。
-- SQLite 改不了 CHECK，按标准做法重建表。
CREATE TABLE feishu_posts_new (
  ref_kind    TEXT    NOT NULL CHECK (ref_kind IN ('message', 'file', 'router_item', 'router_command', 'chat_policy')),
  ref_id      INTEGER NOT NULL,
  part        INTEGER NOT NULL,
  chat_id     TEXT    NOT NULL REFERENCES feishu_chats (chat_id) ON DELETE CASCADE,
  message_id  TEXT    NOT NULL,       -- file 行：紧跟卡发出去的文件记文件消息；挂在卡上的（嵌进卡的图片、补发后标已送达的文件、还在传的、没发出去的）记那张卡的消息
  card_id     TEXT,                   -- file 行：卡上列着这个附件的那张卡（传完要改它）；紧跟卡发出去的文件是 NULL
  sequence    INTEGER NOT NULL DEFAULT 0,
  state       TEXT    NOT NULL CHECK (state IN ('streaming', 'final', 'card_pending', 'card_settled', 'uploading')),
  media_key   TEXT,                   -- file 行：图片编号（img_）或文件编号；没传上是 NULL；uploading 行带编号表示传完、只差改卡
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (ref_kind, ref_id, part)
) STRICT;
INSERT INTO feishu_posts_new (ref_kind, ref_id, part, chat_id, message_id, card_id, sequence, state, updated_at)
  SELECT ref_kind, ref_id, part, chat_id, message_id, card_id, sequence, state, updated_at FROM feishu_posts;
DROP TABLE feishu_posts;
ALTER TABLE feishu_posts_new RENAME TO feishu_posts;
CREATE INDEX feishu_posts_message ON feishu_posts (message_id);
CREATE INDEX feishu_posts_pending ON feishu_posts (chat_id) WHERE state = 'card_pending';
CREATE INDEX feishu_posts_uploading ON feishu_posts (chat_id) WHERE state = 'uploading';
CREATE INDEX feishu_posts_retention ON feishu_posts (state, updated_at);
