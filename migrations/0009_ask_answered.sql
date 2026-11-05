-- 0009_ask_answered：“等你确定”（hub ask）的“已回答”改由守护进程记在消息的 meta 里（meta.answered，见 shared/domain.ts 的 AskMeta），
-- 以前是网页按消息顺序算（之后用户发过消息就算处理了）加“知道了”按钮（meta.dismissed）。
-- 约定同 0001～0008。只改 meta：老数据里点过“知道了”的、之后同一个对话里用户发过消息的，都标成 answered；去掉 dismissed。
UPDATE messages
SET meta = json_remove(json_set(meta, '$.answered', json('true')), '$.dismissed')
WHERE sender = 'agent'
  AND json_extract(meta, '$.needsUser') = 1
  AND (
    json_extract(meta, '$.dismissed') = 1
    OR EXISTS (SELECT 1 FROM messages AS later WHERE later.conversation_id = messages.conversation_id AND later.sender = 'user' AND later.id > messages.id)
  );
