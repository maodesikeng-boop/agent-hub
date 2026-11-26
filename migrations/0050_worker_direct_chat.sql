CREATE TABLE IF NOT EXISTS worker_direct_chat_receipts (
  worker_id INTEGER PRIMARY KEY REFERENCES workers (id) ON DELETE CASCADE,
  seen_through INTEGER NOT NULL
) STRICT;

-- The old ledger already copied these messages into the PM conversation.
INSERT INTO worker_direct_chat_receipts (worker_id, seen_through)
SELECT w.id, max(CAST(substr(m.dedupe_key, length('worker:' || w.id || ':user_message:') + 1) AS INTEGER))
FROM workers w JOIN messages m ON m.worker_id = w.id
WHERE w.status = 'open' AND m.kind = 'worker' AND json_extract(m.meta, '$.event') = 'user_message'
GROUP BY w.id
ON CONFLICT (worker_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS worker_background_wait_details (
  session_id INTEGER PRIMARY KEY REFERENCES worker_background_waits (session_id) ON DELETE CASCADE,
  turn_end INTEGER NOT NULL,
  direct_chat INTEGER NOT NULL CHECK (direct_chat IN (0, 1))
) STRICT;
