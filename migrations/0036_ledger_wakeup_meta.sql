-- 0036_ledger_wakeup_meta：账本代发给项目经理的唤醒（sender = 'user'）在 meta 里标 wakeup，和人在网页、飞书里打的字分开
-- （UserMessageMeta.wakeup，shared/attachments.ts 的 isLedgerWakeup 读；新写的由 enqueueWakeupUserMessageIn 标）。
-- 这里补标老数据：去重键是 userMessageDedupeKey 加 enqueueWakeupUserMessageIn 调用方的几种前缀。meta 不是合法 JSON 的行不动。
UPDATE messages SET meta = json_set(COALESCE(meta, '{}'), '$.wakeup', json('true'))
WHERE sender = 'user'
  AND (meta IS NULL OR json_valid(meta))
  AND (dedupe_key GLOB 'client:*:graph-turned:*'
    OR dedupe_key GLOB 'client:*:graph-autodispatch-failed:*'
    OR dedupe_key GLOB 'client:*:graph-user-blocked:*'
    OR dedupe_key GLOB 'client:*:graph-cancel:*'
    OR dedupe_key GLOB 'client:*:gate-decide:*'
    OR dedupe_key GLOB 'client:*:router-resolve:*');
