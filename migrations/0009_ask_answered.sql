-- 0009_ask_answered：“等你确定”（hub ask）的“已回答”改由守护进程记在消息的 meta 里（meta.answered，见 shared/domain.ts 的 AskMeta），
-- 以前是网页按消息顺序算（之后用户发过消息就算处理了）加“知道了”按钮（meta.dismissed）。
-- 约定同 0001～0008。只给 meta 加 answered：老数据里点过“知道了”的、之后同一个对话里用户发过消息的，都标成 answered。
-- dismissed 留着不删：回滚到旧版本时，只靠“知道了”标掉的老提问也不会重新冒出来（askOf 两个都认）。
-- meta 不是合法 JSON 的行不碰（CASE 保证先判断 json_valid，再取字段），迁移不会因为一行脏数据失败。
UPDATE messages
SET meta = json_set(meta, '$.answered', json('true'))
WHERE sender = 'agent'
  AND CASE
    WHEN json_valid(meta) THEN
      json_extract(meta, '$.needsUser') = 1
      AND json_extract(meta, '$.answered') IS NULL
      AND (
        json_extract(meta, '$.dismissed') = 1
        OR EXISTS (SELECT 1 FROM messages AS later WHERE later.conversation_id = messages.conversation_id AND later.sender = 'user' AND later.id > messages.id)
      )
    ELSE 0
  END;
