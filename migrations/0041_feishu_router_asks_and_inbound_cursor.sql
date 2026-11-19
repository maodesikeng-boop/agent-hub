-- 0041_feishu_router_asks_and_inbound_cursor：
-- 1. feishu_posts.ref_kind 增加 router_ask、router_file，记录同步发往总助单聊的任务图检查点与门禁卡、user_blocker 提醒卡及其交付物附件；
-- 2. feishu_router_events 增加 ask_message_id 列与触发器 feishu_router_ask_insert，用 NATURAL LEFT JOIN 兼容从 0040 升级与回退重跑；
-- 3. 新增 feishu_inbound_cursors 记录各会话最近入站锚点，随 feishu_chats 级联删除。
DROP TABLE IF EXISTS feishu_posts_new;
CREATE TABLE feishu_posts_new (
  ref_kind    TEXT    NOT NULL CHECK (ref_kind IN ('message', 'file', 'router_item', 'router_ask', 'router_file', 'router_command', 'chat_policy', 'router_settings')),
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

DROP TRIGGER IF EXISTS feishu_router_item_insert;
DROP TRIGGER IF EXISTS feishu_router_command_insert;
DROP TRIGGER IF EXISTS feishu_router_command_complete;
DROP TRIGGER IF EXISTS feishu_router_ask_insert;
DROP TABLE IF EXISTS feishu_router_events_new;
CREATE TABLE feishu_router_events_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id        INTEGER REFERENCES router_items(id) ON DELETE CASCADE,
  command_id     INTEGER REFERENCES router_commands(id) ON DELETE CASCADE,
  ask_message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  CHECK (((item_id IS NOT NULL) + (command_id IS NOT NULL) + (ask_message_id IS NOT NULL)) = 1)
) STRICT;
INSERT INTO feishu_router_events_new (id, item_id, command_id, ask_message_id)
  SELECT id, item_id, command_id, ask_message_id
  FROM feishu_router_events NATURAL LEFT JOIN (SELECT NULL AS ask_message_id)
  ORDER BY id;
DROP TABLE feishu_router_events;
ALTER TABLE feishu_router_events_new RENAME TO feishu_router_events;
CREATE INDEX feishu_router_events_item ON feishu_router_events(item_id) WHERE item_id IS NOT NULL;
CREATE INDEX feishu_router_events_command ON feishu_router_events(command_id) WHERE command_id IS NOT NULL;
CREATE INDEX feishu_router_events_ask ON feishu_router_events(ask_message_id) WHERE ask_message_id IS NOT NULL;

CREATE TRIGGER feishu_router_item_insert AFTER INSERT ON router_items
WHEN EXISTS (SELECT 1 FROM feishu_chats WHERE target = 'router')
BEGIN
  INSERT INTO feishu_router_events(item_id) VALUES (NEW.id);
END;
CREATE TRIGGER feishu_router_command_insert AFTER INSERT ON router_commands
WHEN NEW.status IN ('answered', 'dispatched', 'failed') AND EXISTS (SELECT 1 FROM feishu_chats WHERE target = 'router')
BEGIN
  INSERT INTO feishu_router_events(command_id) VALUES (NEW.id);
END;
CREATE TRIGGER feishu_router_command_complete AFTER UPDATE OF status ON router_commands
WHEN NEW.status IN ('answered', 'dispatched', 'failed') AND OLD.status NOT IN ('answered', 'dispatched', 'failed')
 AND EXISTS (SELECT 1 FROM feishu_chats WHERE target = 'router')
BEGIN
  INSERT INTO feishu_router_events(command_id) VALUES (NEW.id);
END;
CREATE TRIGGER feishu_router_ask_insert AFTER INSERT ON messages
WHEN NEW.sender = 'agent' AND NEW.worker_id IS NULL AND NEW.kind = 'text' AND NEW.meta IS NOT NULL
 AND json_extract(NEW.meta, '$.needsUser') = 1
 AND (json_type(NEW.meta, '$.gateRef') IS NOT NULL OR json_type(NEW.meta, '$.blockerRef') IS NOT NULL)
 AND EXISTS (SELECT 1 FROM feishu_chats WHERE target = 'router')
BEGIN
  INSERT INTO feishu_router_events(ask_message_id) VALUES (NEW.id);
END;

CREATE TABLE IF NOT EXISTS feishu_inbound_cursors (
  chat_id          TEXT    PRIMARY KEY REFERENCES feishu_chats (chat_id) ON DELETE CASCADE,
  last_inbound_at  INTEGER NOT NULL,
  last_message_id  TEXT,
  updated_at       INTEGER NOT NULL
) STRICT;
