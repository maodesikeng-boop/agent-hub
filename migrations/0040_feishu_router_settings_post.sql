-- 0040_feishu_router_settings_post：总助单聊里的模型设置卡（docs/feishu-design.md）。
-- feishu_posts.ref_kind 增加 router_settings（ref_id = 1, part = 0），记总助单聊最新那张设置卡。
DROP TABLE IF EXISTS feishu_posts_new;
CREATE TABLE feishu_posts_new (
  ref_kind    TEXT    NOT NULL CHECK (ref_kind IN ('message', 'file', 'router_item', 'router_command', 'chat_policy', 'router_settings')),
  ref_id      INTEGER NOT NULL,
  part        INTEGER NOT NULL,
  chat_id     TEXT    NOT NULL REFERENCES feishu_chats (chat_id) ON DELETE CASCADE,
  message_id  TEXT    NOT NULL,
  card_id     TEXT,
  sequence    INTEGER NOT NULL DEFAULT 0,
  state       TEXT    NOT NULL CHECK (state IN ('streaming', 'final', 'card_pending', 'card_settled', 'uploading')),
  media_key   TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (ref_kind, ref_id, part)
) STRICT;
INSERT INTO feishu_posts_new (ref_kind, ref_id, part, chat_id, message_id, card_id, sequence, state, media_key, updated_at)
  SELECT ref_kind, ref_id, part, chat_id, message_id, card_id, sequence, state, media_key, updated_at FROM feishu_posts;
DROP TABLE feishu_posts;
ALTER TABLE feishu_posts_new RENAME TO feishu_posts;
CREATE INDEX feishu_posts_message ON feishu_posts (message_id);
CREATE INDEX feishu_posts_pending ON feishu_posts (chat_id) WHERE state = 'card_pending';
CREATE INDEX feishu_posts_uploading ON feishu_posts (chat_id) WHERE state = 'uploading';
CREATE INDEX feishu_posts_retention ON feishu_posts (state, updated_at);
