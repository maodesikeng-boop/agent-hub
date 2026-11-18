-- 0034_feishu：接入飞书（docs/feishu-design.md）。App Secret 不在库里（state/feishu-secrets.json），这里只记绑定和投影。
-- 一个守护进程只接一个飞书应用：换应用时四张表一起清空重来。

-- 接的是哪个应用、机器人是谁、主人是谁。只有一行。
CREATE TABLE IF NOT EXISTS feishu_app (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  app_id              TEXT    NOT NULL,
  brand               TEXT    NOT NULL CHECK (brand IN ('feishu', 'lark')),
  bot_open_id         TEXT    NOT NULL,
  bot_name            TEXT    NOT NULL,
  owner_open_id       TEXT,                -- 手动接入、主人还没发绑定码时是 NULL
  enabled             INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
) STRICT;

-- 总助是主人和机器人的单聊，每个项目经理一个私有群。
-- 项目经理归档时群已解散，这一行留着（archived_at 记解散时间，取消归档重建群时换 chat_id）；
-- 项目经理删掉时 pm_id 置空，下一次对齐解散群（还没解散的话）后删掉这一行。
CREATE TABLE IF NOT EXISTS feishu_chats (
  chat_id               TEXT    PRIMARY KEY,
  target                TEXT    NOT NULL CHECK (target IN ('router', 'pm')),
  pm_id                 INTEGER REFERENCES pms (id) ON DELETE SET NULL,
  name                  TEXT    NOT NULL, -- 飞书里现在的群名
  label                 TEXT    NOT NULL, -- 上次对齐时项目经理的名字：改名时据此改群名
  avatar_fruit          TEXT,             -- 上次设成群头像的水果；和应有的不同时重设
  trigger_mode          TEXT    NOT NULL DEFAULT 'auto' CHECK (trigger_mode IN ('auto', 'mention_only')),
  guest_tier            TEXT    NOT NULL DEFAULT 'chat_only' CHECK (guest_tier IN ('chat_only', 'collaborator', 'observer')),
  archived_at           INTEGER,
  -- 已投影到这个会话的最大账本编号，重连后从这里往后补发
  last_message_id       INTEGER,
  last_router_item_id   INTEGER,
  last_router_command_id INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  CHECK (target = 'pm' OR pm_id IS NULL)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS feishu_chats_router ON feishu_chats (target) WHERE target = 'router';
CREATE UNIQUE INDEX IF NOT EXISTS feishu_chats_pm ON feishu_chats (pm_id) WHERE pm_id IS NOT NULL;

-- 账本里的东西发到飞书后是哪条消息、哪张卡片实体（都在主聊天流里，不发话题回复）：重发、定稿、改成已定案、补发都按它幂等。
CREATE TABLE IF NOT EXISTS feishu_posts (
  ref_kind    TEXT    NOT NULL CHECK (ref_kind IN ('message', 'file', 'router_item', 'router_command', 'chat_policy')),
  ref_id      INTEGER NOT NULL,       -- 消息编号、总助卡片编号、总助指令编号；chat_policy 是项目经理编号（群里那张“访客权限”卡）
  part        INTEGER NOT NULL,       -- 长消息拆成的第几张卡、第几个文件；没拆是 0
  chat_id     TEXT    NOT NULL REFERENCES feishu_chats (chat_id) ON DELETE CASCADE,
  message_id  TEXT    NOT NULL,
  card_id     TEXT,                   -- 卡片实体编号；纯图片、文件消息是 NULL
  sequence    INTEGER NOT NULL DEFAULT 0, -- 这张卡片实体上一次操作的序号，下一次必须更大
  state       TEXT    NOT NULL CHECK (state IN ('streaming', 'final', 'card_pending', 'card_settled')),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (ref_kind, ref_id, part)
) STRICT;
CREATE INDEX IF NOT EXISTS feishu_posts_message ON feishu_posts (message_id);
CREATE INDEX IF NOT EXISTS feishu_posts_retention ON feishu_posts (state, updated_at);

-- 水果头像上传一次得到的 image_key，各群共用。
CREATE TABLE IF NOT EXISTS feishu_avatars (
  fruit       TEXT    PRIMARY KEY,
  image_key   TEXT    NOT NULL,
  uploaded_at INTEGER NOT NULL
) STRICT;
