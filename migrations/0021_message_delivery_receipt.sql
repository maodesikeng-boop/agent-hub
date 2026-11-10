-- Persist delivery independently of turn outcome. Historical execution errors were
-- emitted only after a turn started; do not infer receipt from action status (a
-- rejected send can also finish its action as done).
UPDATE messages SET meta = json_set(COALESCE(meta, '{}'), '$.deliveryConfirmed', json('true'))
WHERE status IN ('delivered', 'processing', 'replied')
   OR (status = 'failed' AND (failure_reason = 'turn_failed'
       OR failure_reason LIKE 'error: %'
       OR failure_reason LIKE 'error_during_execution: %'));
