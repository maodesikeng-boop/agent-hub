-- 0061_feishu_guest_tier_default: change feishu_chats.guest_tier default to 'observer' and tighten every non-'collaborator' row (including legacy 'chat_only' and malformed tiers) to 'observer'.
DROP TRIGGER IF EXISTS feishu_router_item_insert;
DROP TRIGGER IF EXISTS feishu_router_command_insert;
DROP TRIGGER IF EXISTS feishu_router_command_complete;
DROP TRIGGER IF EXISTS feishu_router_ask_insert;

DROP TABLE IF EXISTS feishu_chats_new;
CREATE TABLE feishu_chats_new (
  chat_id               TEXT    PRIMARY KEY,
  target                TEXT    NOT NULL CHECK (target IN ('router', 'pm')),
  pm_id                 INTEGER REFERENCES pms (id) ON DELETE SET NULL,
  name                  TEXT    NOT NULL,
  label                 TEXT    NOT NULL,
  avatar_fruit          TEXT,
  trigger_mode          TEXT    NOT NULL DEFAULT 'auto' CHECK (trigger_mode IN ('auto', 'mention_only')),
  guest_tier            TEXT    NOT NULL DEFAULT 'observer' CHECK (guest_tier IN ('chat_only', 'collaborator', 'observer')),
  archived_at           INTEGER,
  last_message_id       INTEGER,
  last_router_event_id  INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  CHECK (target = 'pm' OR pm_id IS NULL)
) STRICT;

INSERT INTO feishu_chats_new (
  chat_id, target, pm_id, name, label, avatar_fruit, trigger_mode, guest_tier,
  archived_at, last_message_id, last_router_event_id, created_at, updated_at
)
  SELECT
    chat_id, target, pm_id, name, label, avatar_fruit, trigger_mode,
    CASE WHEN guest_tier = 'collaborator' THEN 'collaborator' ELSE 'observer' END,
    archived_at, last_message_id, last_router_event_id, created_at, updated_at
  FROM feishu_chats;

DROP TABLE feishu_chats;
ALTER TABLE feishu_chats_new RENAME TO feishu_chats;
CREATE UNIQUE INDEX feishu_chats_router ON feishu_chats (target) WHERE target = 'router';
CREATE UNIQUE INDEX feishu_chats_pm ON feishu_chats (pm_id) WHERE pm_id IS NOT NULL;

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
