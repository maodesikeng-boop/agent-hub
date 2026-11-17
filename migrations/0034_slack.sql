-- 0034_slack：接入 Slack（docs/slack-design.md）。令牌不在库里（state/slack-secrets.json），这里只记绑定和投影。
-- 一个守护进程最多接一个工作区：换工作区时三张表一起清空重来。

-- 接的是哪个工作区、机器人是谁、主人是谁。只有一行。
CREATE TABLE IF NOT EXISTS slack_workspace (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  team_id        TEXT    NOT NULL,
  team_name      TEXT    NOT NULL,
  bot_user_id    TEXT    NOT NULL,
  owner_user_id  TEXT,                -- 主人私聊机器人发绑定码之前是 NULL
  enabled        INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
) STRICT;

-- 总助和每个项目经理各一个私密频道。项目经理删除时行跟着删（归档时频道已在 Slack 里归档）。
CREATE TABLE IF NOT EXISTS slack_channels (
  channel_id            TEXT    PRIMARY KEY,
  target                TEXT    NOT NULL CHECK (target IN ('router', 'pm')),
  pm_id                 INTEGER REFERENCES pms (id) ON DELETE CASCADE,
  name                  TEXT    NOT NULL, -- Slack 里现在的频道名（用户在 Slack 里改了也跟着记）
  label                 TEXT    NOT NULL, -- 上次对齐时总助或项目经理的名字：项目经理改名时据此改频道名
  archived_at           INTEGER,
  -- 已投影到这个频道的最大账本编号，重连后从这里往后补发
  last_message_id       INTEGER,
  last_router_item_id   INTEGER,
  last_router_command_id INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  CHECK ((target = 'router') = (pm_id IS NULL))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS slack_channels_router ON slack_channels (target) WHERE target = 'router';
CREATE UNIQUE INDEX IF NOT EXISTS slack_channels_pm ON slack_channels (pm_id) WHERE pm_id IS NOT NULL;

-- 账本里的东西发到 Slack 后是哪条消息（都在频道主聊天流里，没有串）：重发、改成已定案、补发都按它幂等。
CREATE TABLE IF NOT EXISTS slack_posts (
  ref_kind    TEXT    NOT NULL CHECK (ref_kind IN ('message', 'file', 'router_item', 'router_command')),
  ref_id      INTEGER NOT NULL,       -- 消息编号、总助卡片编号或总助指令编号
  part        INTEGER NOT NULL,       -- 长消息拆成的第几段、第几个文件；没拆是 0
  channel_id  TEXT    NOT NULL REFERENCES slack_channels (channel_id) ON DELETE CASCADE,
  ts          TEXT    NOT NULL,
  state       TEXT    NOT NULL CHECK (state IN ('streaming', 'final', 'card_pending', 'card_settled')),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (ref_kind, ref_id, part)
) STRICT;
CREATE INDEX IF NOT EXISTS slack_posts_channel_ts ON slack_posts (channel_id, ts);
CREATE INDEX IF NOT EXISTS slack_posts_retention ON slack_posts (state, updated_at);
