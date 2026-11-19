-- 0041_feishu_offline_inbox：全账号一个飞书机器人（docs/account-mesh-design.md「飞书：一个机器人，按群转给归属电脑」）。
-- 中心收到发给离线电脑的项目群消息时先存这里，那台上线后按 id 顺序转过去；过期删掉并在群里说一声。只在中心上有内容。
-- chat_id 是别的设备建的群，不在本机 feishu_chats 里，所以不加外键。
CREATE TABLE IF NOT EXISTS feishu_offline_inbox (
  id           INTEGER PRIMARY KEY,
  device_id    TEXT    NOT NULL,
  chat_id      TEXT    NOT NULL,
  message_id   TEXT    NOT NULL UNIQUE, -- 飞书消息编号：飞书重推同一条只存一次
  event_json   TEXT    NOT NULL,        -- 原始事件（FeishuRawEvent），送达时原样转过去
  received_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS feishu_offline_inbox_device ON feishu_offline_inbox (device_id, id);
CREATE INDEX IF NOT EXISTS feishu_offline_inbox_expiry ON feishu_offline_inbox (received_at);
