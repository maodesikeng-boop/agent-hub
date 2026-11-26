import { ACTION_STATUSES, ACTION_TYPES, actionDedupeKey } from "../../shared/actions.ts";
import type { ActionStatus, AnyActionRow, NewAction } from "../../shared/actions.ts";
import { isOneOf } from "../../shared/domain.ts";
import type { ActionId, MessageId, SessionId } from "../../shared/domain.ts";
import type { Db, SqlValue } from "../store/index.ts";

export interface ActionDbRow {
  id: number;
  type: string;
  dedupe_key: string;
  params: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export function toActionRow(row: ActionDbRow): AnyActionRow {
  if (!isOneOf(ACTION_TYPES, row.type)) throw new Error(`unknown action type ${row.type}`);
  if (!isOneOf(ACTION_STATUSES, row.status)) throw new Error(`unknown action status ${row.status}`);
  return {
    id: row.id,
    type: row.type,
    dedupeKey: row.dedupe_key,
    params: JSON.parse(row.params),
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as AnyActionRow;
}

const ENDED: readonly ActionStatus[] = ["done", "failed", "abandoned"];

const UPSERT = `
INSERT INTO actions (type, dedupe_key, params, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT (type, dedupe_key) DO UPDATE SET
  params          = excluded.params,
  status          = CASE WHEN status IN ('done', 'failed', 'abandoned') THEN 'pending' ELSE status END,
  attempts        = CASE WHEN status IN ('done', 'failed', 'abandoned') THEN 0 ELSE attempts END,
  last_error      = CASE WHEN status IN ('done', 'failed', 'abandoned') THEN NULL ELSE last_error END,
  next_attempt_at = CASE WHEN status IN ('done', 'failed', 'abandoned') THEN excluded.next_attempt_at ELSE next_attempt_at END,
  updated_at      = excluded.updated_at
RETURNING *`;

interface EnqueueResult {
  row: AnyActionRow;
  enqueued: boolean;
}

export function enqueueAction(db: Db, action: NewAction, now: number): EnqueueResult {
  const dedupeKey = actionDedupeKey(action);
  const before = db.get<{ status: string }>("SELECT status FROM actions WHERE type = ? AND dedupe_key = ?", action.type, dedupeKey);
  const row = db.get<ActionDbRow>(UPSERT, action.type, dedupeKey, JSON.stringify(action.params), now, now, now)!;
  const enqueued = before === undefined || (ENDED as readonly string[]).includes(before.status);
  return { row: toActionRow(row), enqueued };
}

export function getAction(db: Db, id: ActionId): AnyActionRow | null {
  const row = db.get<ActionDbRow>("SELECT * FROM actions WHERE id = ?", id);
  return row === undefined ? null : toActionRow(row);
}

export function listActions(db: Db): AnyActionRow[] {
  return db.all<ActionDbRow>("SELECT * FROM actions ORDER BY id").map(toActionRow);
}

interface ActionStatusPatch {
  status: ActionStatus;
  attempts?: number;
  nextAttemptAt?: number;
  lastError?: string | null;
}

export function setActionStatus(db: Db, id: ActionId, patch: ActionStatusPatch, now: number): void {
  const sets = ["status = ?", "updated_at = ?"];
  const values: SqlValue[] = [patch.status, now];
  if (patch.attempts !== undefined) {
    sets.push("attempts = ?");
    values.push(patch.attempts);
  }
  if (patch.nextAttemptAt !== undefined) {
    sets.push("next_attempt_at = ?");
    values.push(patch.nextAttemptAt);
  }
  if (patch.lastError !== undefined) {
    sets.push("last_error = ?");
    values.push(patch.lastError);
  }
  db.run(`UPDATE actions SET ${sets.join(", ")} WHERE id = ?`, ...values, id);
}

export function hasRunningSessionAction(db: Db, sessionId: SessionId): boolean {
  return (
    db.get(
      `SELECT 1 AS x FROM actions
       WHERE status = 'running' AND type IN ('session.send', 'session.start')
         AND json_extract(params, '$.sessionId') = ?
       LIMIT 1`,
      sessionId,
    ) !== undefined
  );
}

export function deletePendingSessionSend(db: Db, sessionId: SessionId, messageId: MessageId): void {
  db.run(
    `DELETE FROM actions
     WHERE type = 'session.send' AND status = 'pending'
       AND (dedupe_key = ? OR (dedupe_key = ? AND json_extract(params, '$.sessionId') = ?))`,
    `${sessionId}:${messageId}`,
    String(messageId),
    sessionId,
  );
}

export function deleteLegacyPendingSessionSend(db: Db, sessionId: SessionId, messageId: MessageId): void {
  db.run(
    `DELETE FROM actions
     WHERE type = 'session.send' AND status = 'pending'
       AND dedupe_key = ? AND json_extract(params, '$.sessionId') = ?`,
    String(messageId),
    sessionId,
  );
}
