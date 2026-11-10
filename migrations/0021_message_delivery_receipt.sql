-- 消息送达回执（meta.deliveryConfirmed）：送达后这一轮才出错的消息，网页不画“没发出去”。
-- 只改下面三类，别的失败原因（spawn_failed、invalid_input、动作失败、crash 前没送达……）保持原样，网页照旧标“没发出去”。可重复执行。
--
-- 1. 用户消息出错的那一轮最后一条 agent 消息是一段话（不是停在工具调用上）：用户已经看到回复，改成已回复。
--    （turn.ended 出错只会发生在 agent 开始处理之后；新代码在 turn.ended 里按同一条规则直接标 replied，见 ledger/messages.ts）
-- 2. 其余失败消息，只认两类送达证据：原因是 turn.ended 才会写的（turn_failed、error_during_execution: …），
--    或这条消息之后、下一条输入之前 agent 说过话、调过工具。不按“error: ”这类原文前缀猜：没有任何写入点产生它，
--    换了写法的原文（claude 重试用完时 failure_reason 就是 result 原文）也会误判。
-- 3. 迁移时还在 delivered、processing 的消息：状态已经说明送了，补回执（之后再失败不会丢）。已回复的不用补，网页只在 failed 时读这个字段。

CREATE TEMP TABLE _receipt_failed AS
SELECT m.id,
       (SELECT a.kind FROM messages a
         WHERE a.session_id = m.session_id AND a.sender = 'agent' AND a.id > m.id
           AND a.id < COALESCE((SELECT MIN(n.id) FROM messages n
                                 WHERE n.session_id = m.session_id AND n.sender IN ('user', 'system') AND n.status IS NOT NULL AND n.id > m.id), 9223372036854775807)
         ORDER BY a.id DESC LIMIT 1) AS last_kind,
       (m.failure_reason = 'turn_failed' OR m.failure_reason LIKE 'error_during_execution: %') AS turn_reason
FROM messages m
WHERE m.sender = 'user' AND m.status = 'failed' AND m.session_id IS NOT NULL;

UPDATE messages
SET status = 'replied', failure_reason = NULL, meta = json_set(COALESCE(meta, '{}'), '$.deliveryConfirmed', json('true'))
WHERE id IN (SELECT id FROM _receipt_failed WHERE last_kind = 'text');

UPDATE messages
SET meta = json_set(COALESCE(meta, '{}'), '$.deliveryConfirmed', json('true'))
WHERE id IN (SELECT id FROM _receipt_failed WHERE last_kind IS NOT NULL OR turn_reason = 1);

UPDATE messages
SET meta = json_set(COALESCE(meta, '{}'), '$.deliveryConfirmed', json('true'))
WHERE status IN ('delivered', 'processing');

DROP TABLE _receipt_failed;
