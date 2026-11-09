// 动作表的读写（设计第 12.2 节）。登记由账本在自己的事务里调；状态由执行器改。
import { ACTION_STATUSES, ACTION_TYPES, actionDedupeKey } from "../../shared/actions.ts";
import type { ActionStatus, AnyActionRow, NewAction } from "../../shared/actions.ts";
import { isOneOf } from "../../shared/domain.ts";
import type { ActionId } from "../../shared/domain.ts";
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

/** 类型不认识、参数不是 JSON 时抛错。 */
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

// 写法照 migrations/0001_init.sql 里 actions 表的注释；SET 里的 status 读的是改之前的值。
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
  /** 新的一行，或者已结束的一行被重置成 pending；只更新了参数时是 false。 */
  enqueued: boolean;
}

/** 登记一个动作。调用方负责事务（账本把它和业务写入放在同一个事务里）。 */
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
