import { pruneSandboxApprovalsIn } from "./sandbox-approvals.ts";
// Invariant: every table retention batch deletes at most maxRows rows in a single synchronous SQLite transaction and never deletes active-session state or user/PM text history.
import type { SessionId } from "../../shared/domain.ts";
import {
  ACTIONS_TERMINAL_MAX_ROWS,
  ACTIONS_TERMINAL_RETENTION_MS,
  ENDED_WORKER_STEPS_KEEP,
  HANDOVERS_MAX_PER_CONV,
  HANDOVERS_RETENTION_MS,
  HUB_CALLS_MAX_ROWS,
  HUB_CALLS_RETENTION_MS,
  PERSONA_CHANGES_LIMIT,
  PM_TOOL_MESSAGES_MAX_PER_CONV,
  PM_TOOL_MESSAGE_RETENTION_MS,
  ROUTER_AUDIT_LOG_MAX_ROWS,
  ROUTER_AUDIT_LOG_RETENTION_MS,
  ROUTER_COMMANDS_RETENTION_MAX,
  ROUTER_COMMANDS_RETENTION_MS,
  ROUTER_ITEMS_TERMINAL_MAX_ROWS,
  ROUTER_ITEM_RETENTION_MS,
} from "../../shared/limits.ts";
import type { Db } from "../store/index.ts";
import type { LedgerContext } from "./context.ts";

export interface TableRetentionBatch {
  readonly rows: number;
  readonly more: boolean;
}

export interface DbTableRetention {
  /**
   * Precondition: maxRows >= 1.
   * Postcondition: deletes PM conversation kind='tool' messages older than PM_TOOL_MESSAGE_RETENTION_MS or beyond the newest PM_TOOL_MESSAGES_MAX_PER_CONV per conversation, never deleting non-tool rows.
   */
  purgePmToolMessagesBatch(nowMs: number, maxRows: number): TableRetentionBatch;

  /**
   * Precondition: maxRows >= 1.
   * Postcondition: deletes terminal actions (done, failed, abandoned) older than ACTIONS_TERMINAL_RETENTION_MS or beyond ACTIONS_TERMINAL_MAX_ROWS, never touching pending or running rows.
   */
  purgeTerminalActionsBatch(nowMs: number, maxRows: number): TableRetentionBatch;

  /**
   * Precondition: maxRows >= 1.
   * Postcondition: deletes hub_calls rows older than HUB_CALLS_RETENTION_MS or beyond HUB_CALLS_MAX_ROWS.
   */
  purgeHubCallsBatch(nowMs: number, maxRows: number): TableRetentionBatch;

  /**
   * Precondition: maxRows >= 1.
   * Postcondition: clears consumed preamble and skills_section blobs and deletes terminal handovers older than HANDOVERS_RETENTION_MS or beyond HANDOVERS_MAX_PER_CONV per conversation while preserving active handovers and the latest switched anchor.
   */
  purgeHandoversBatch(nowMs: number, maxRows: number): TableRetentionBatch;

  /**
   * Precondition: maxRows >= 1.
   * Postcondition: deletes per-PM persona_changes rows beyond PERSONA_CHANGES_LIMIT after nulling revert_of references to deleted rows.
   */
  prunePersonaChangesBatch(maxRows: number): TableRetentionBatch;

  /**
   * Precondition: sessionId belongs to an ended Worker session.
   * Postcondition: trims session_steps for sessionId down to at most ENDED_WORKER_STEPS_KEEP newest rows and returns the deleted count.
   */
  trimEndedWorkerSteps(sessionId: SessionId): number;

  /**
   * Precondition: sessionId has already received its handover preamble.
   * Postcondition: sets preamble and skills_section to NULL on switched handovers targeting sessionId and returns the updated count.
   */
  clearConsumedHandoverBlobs(sessionId: SessionId): number;

  /**
   * Precondition: maxRows >= 1.
   * Postcondition: runs one bounded retention pass across growing ledger tables and ended-worker step trimming.
   */
  purgeAllBatch(nowMs: number, maxRows: number): TableRetentionBatch;
}

const normalizeBudget = (maxRows: number): number => Math.max(1, Math.floor(maxRows));
const placeholders = (ids: readonly number[]): string => `(${ids.map(() => "?").join(",")})`;

function deleteByIds(db: Db, table: string, ids: readonly number[]): number {
  if (ids.length === 0) return 0;
  return db.run(`DELETE FROM ${table} WHERE id IN ${placeholders(ids)}`, ...ids).changes;
}

export function clearConsumedHandoverBlobsIn(db: Db, sessionId: SessionId): number {
  return db.run(
    `UPDATE handovers
        SET preamble = NULL, skills_section = NULL
      WHERE to_session_id = ?
        AND status = 'switched'
        AND (preamble IS NOT NULL OR skills_section IS NOT NULL)`,
    sessionId,
  ).changes;
}

export function trimEndedWorkerStepsIn(db: Db, sessionId: SessionId): number {
  const cutoff = db.get<{ id: number }>(
    "SELECT id FROM session_steps WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?",
    sessionId,
    ENDED_WORKER_STEPS_KEEP,
  );
  if (cutoff === undefined) return 0;
  return db.run("DELETE FROM session_steps WHERE session_id = ? AND id <= ?", sessionId, cutoff.id).changes;
}

export function purgeRouterExpiredIn(db: Db, nowMs: number, maxRows: number): number {
  if (maxRows <= 0) return 0;
  let deleted = 0;

  const itemsRem = maxRows - deleted;
  if (itemsRem > 0) {
    const itemCutoff = nowMs - ROUTER_ITEM_RETENTION_MS;
    const threshold = db.get<{ id: number }>(
      `SELECT id FROM router_items
        WHERE status IN ('resolved', 'superseded', 'archived')
        ORDER BY updated_at DESC, id DESC LIMIT 1 OFFSET ?`,
      ROUTER_ITEMS_TERMINAL_MAX_ROWS,
    );
    const maxKeepId = threshold?.id ?? 0;
    deleted += db.run(
      `DELETE FROM router_items
        WHERE id IN (
          SELECT id FROM router_items
           WHERE status IN ('resolved', 'superseded', 'archived')
             AND (updated_at <= ? OR id <= ?)
           ORDER BY updated_at ASC, id ASC
           LIMIT ?
        )`,
      itemCutoff,
      maxKeepId,
      itemsRem,
    ).changes;
  }

  const cmdsRem = maxRows - deleted;
  if (cmdsRem > 0) {
    const cmdCutoff = nowMs - ROUTER_COMMANDS_RETENTION_MS;
    const thresholdRow = db.get<{ id: number }>(
      "SELECT id FROM router_commands ORDER BY id DESC LIMIT 1 OFFSET ?",
      ROUTER_COMMANDS_RETENTION_MAX,
    );
    const maxKeepId = thresholdRow?.id ?? 0;
    deleted += db.run(
      `DELETE FROM router_commands
        WHERE id IN (
          SELECT id FROM router_commands
           WHERE status IN ('dispatched', 'answered', 'failed', 'cancelled')
             AND (updated_at <= ? OR id <= ?)
           LIMIT ?
        )`,
      cmdCutoff,
      maxKeepId,
      cmdsRem,
    ).changes;
  }

  const auditRem = maxRows - deleted;
  if (auditRem > 0) {
    const auditCutoff = nowMs - ROUTER_AUDIT_LOG_RETENTION_MS;
    deleted += db.run(
      `DELETE FROM router_audit_log
        WHERE id IN (
          SELECT id FROM router_audit_log
           WHERE created_at <= ?
              OR id <= COALESCE((SELECT id FROM router_audit_log ORDER BY id DESC LIMIT 1 OFFSET ?), 0)
           LIMIT ?
        )`,
      auditCutoff,
      ROUTER_AUDIT_LOG_MAX_ROWS,
      auditRem,
    ).changes;
  }

  return deleted;
}

function purgePmToolMessagesIn(db: Db, nowMs: number, budget: number): TableRetentionBatch {
  const cutoff = nowMs - PM_TOOL_MESSAGE_RETENTION_MS;
  const pmConvs = db.all<{ id: number }>("SELECT id FROM conversations WHERE kind = 'pm' ORDER BY id");
  let deleted = 0;
  let hasMore = false;
  for (const { id: convId } of pmConvs) {
    const threshold = db.get<{ id: number }>(
      "SELECT id FROM messages WHERE conversation_id = ? AND kind = 'tool' ORDER BY id DESC LIMIT 1 OFFSET ?",
      convId,
      PM_TOOL_MESSAGES_MAX_PER_CONV,
    );
    const maxKeepId = threshold?.id ?? 0;
    const remaining = budget - deleted;
    if (remaining <= 0) {
      const extra = db.get<{ id: number }>(
        "SELECT id FROM messages WHERE conversation_id = ? AND kind = 'tool' AND (created_at <= ? OR id <= ?) LIMIT 1",
        convId,
        cutoff,
        maxKeepId,
      );
      if (extra !== undefined) {
        hasMore = true;
        break;
      }
      continue;
    }
    const rows = db.all<{ id: number }>(
      `SELECT id FROM messages
        WHERE conversation_id = ? AND kind = 'tool' AND (created_at <= ? OR id <= ?)
        ORDER BY id ASC LIMIT ?`,
      convId,
      cutoff,
      maxKeepId,
      remaining + 1,
    );
    if (rows.length > remaining) hasMore = true;
    deleted += deleteByIds(db, "messages", rows.slice(0, remaining).map((r) => r.id));
  }
  return { rows: deleted, more: hasMore };
}

function purgeTerminalActionsIn(db: Db, nowMs: number, budget: number): TableRetentionBatch {
  const cutoff = nowMs - ACTIONS_TERMINAL_RETENTION_MS;
  const threshold = db.get<{ id: number }>(
    "SELECT id FROM actions WHERE status IN ('done', 'failed', 'abandoned') ORDER BY id DESC LIMIT 1 OFFSET ?",
    ACTIONS_TERMINAL_MAX_ROWS,
  );
  const maxKeepId = threshold?.id ?? 0;
  const rows = db.all<{ id: number }>(
    `SELECT id FROM actions
      WHERE status IN ('done', 'failed', 'abandoned') AND (updated_at <= ? OR id <= ?)
      ORDER BY id ASC LIMIT ?`,
    cutoff,
    maxKeepId,
    budget + 1,
  );
  return { rows: deleteByIds(db, "actions", rows.slice(0, budget).map((r) => r.id)), more: rows.length > budget };
}

function purgeHubCallsIn(db: Db, nowMs: number, budget: number): TableRetentionBatch {
  const cutoff = nowMs - HUB_CALLS_RETENTION_MS;
  const threshold = db.get<{ id: number }>(
    "SELECT id FROM hub_calls ORDER BY id DESC LIMIT 1 OFFSET ?",
    HUB_CALLS_MAX_ROWS,
  );
  const maxKeepId = threshold?.id ?? 0;
  const rows = db.all<{ id: number }>(
    "SELECT id FROM hub_calls WHERE created_at <= ? OR id <= ? ORDER BY id ASC LIMIT ?",
    cutoff,
    maxKeepId,
    budget + 1,
  );
  return { rows: deleteByIds(db, "hub_calls", rows.slice(0, budget).map((r) => r.id)), more: rows.length > budget };
}

function purgeHandoversIn(db: Db, nowMs: number, budget: number): TableRetentionBatch {
  const cutoff = nowMs - HANDOVERS_RETENTION_MS;
  let touched = 0;
  let hasMore = false;

  const blobRows = db.all<{ id: number }>(
    `SELECT id FROM handovers
      WHERE status = 'switched'
        AND to_session_id IS NOT NULL
        AND (preamble IS NOT NULL OR skills_section IS NOT NULL)
        AND (
          to_session_id IN (SELECT session_id FROM session_preamble_seen)
          OR to_session_id NOT IN (SELECT id FROM agent_sessions WHERE status != 'ended')
        )
      ORDER BY id ASC LIMIT ?`,
    budget + 1,
  );
  if (blobRows.length > budget) hasMore = true;
  const blobIds = blobRows.slice(0, budget).map((r) => r.id);
  if (blobIds.length > 0) {
    touched += db.run(`UPDATE handovers SET preamble = NULL, skills_section = NULL WHERE id IN ${placeholders(blobIds)}`, ...blobIds).changes;
  }

  const convs = db.all<{ conversation_id: number }>("SELECT DISTINCT conversation_id FROM handovers ORDER BY conversation_id");
  for (const { conversation_id: convId } of convs) {
    const latestSwitched = db.get<{ id: number }>(
      "SELECT id FROM handovers WHERE conversation_id = ? AND status = 'switched' ORDER BY id DESC LIMIT 1",
      convId,
    )?.id ?? -1;
    const threshold = db.get<{ id: number }>(
      `SELECT id FROM handovers
        WHERE conversation_id = ? AND status IN ('switched', 'failed', 'abandoned')
        ORDER BY id DESC LIMIT 1 OFFSET ?`,
      convId,
      HANDOVERS_MAX_PER_CONV,
    );
    const maxKeepId = threshold?.id ?? 0;
    const remaining = budget - touched;
    if (remaining <= 0) {
      const extra = db.get<{ id: number }>(
        `SELECT id FROM handovers
          WHERE conversation_id = ? AND status IN ('switched', 'failed', 'abandoned')
            AND id != ? AND (updated_at <= ? OR id <= ?) LIMIT 1`,
        convId,
        latestSwitched,
        cutoff,
        maxKeepId,
      );
      if (extra !== undefined) {
        hasMore = true;
        break;
      }
      continue;
    }
    const rows = db.all<{ id: number }>(
      `SELECT id FROM handovers
        WHERE conversation_id = ? AND status IN ('switched', 'failed', 'abandoned')
          AND id != ? AND (updated_at <= ? OR id <= ?)
        ORDER BY id ASC LIMIT ?`,
      convId,
      latestSwitched,
      cutoff,
      maxKeepId,
      remaining + 1,
    );
    if (rows.length > remaining) hasMore = true;
    touched += deleteByIds(db, "handovers", rows.slice(0, remaining).map((r) => r.id));
  }
  return { rows: touched, more: hasMore };
}

function prunePersonaChangesIn(db: Db, budget: number): TableRetentionBatch {
  const pms = db.all<{ pm_id: number }>(
    "SELECT pm_id FROM persona_changes GROUP BY pm_id HAVING count(*) > ? ORDER BY pm_id",
    PERSONA_CHANGES_LIMIT,
  );
  let deleted = 0;
  let hasMore = false;
  for (const { pm_id: pmId } of pms) {
    const threshold = db.get<{ id: number }>(
      "SELECT id FROM persona_changes WHERE pm_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?",
      pmId,
      PERSONA_CHANGES_LIMIT,
    );
    if (threshold === undefined) continue;
    const remaining = budget - deleted;
    if (remaining <= 0) {
      hasMore = true;
      break;
    }
    const rows = db.all<{ id: number }>(
      "SELECT id FROM persona_changes WHERE pm_id = ? AND id <= ? ORDER BY id ASC LIMIT ?",
      pmId,
      threshold.id,
      remaining + 1,
    );
    if (rows.length > remaining) hasMore = true;
    const ids = rows.slice(0, remaining).map((r) => r.id);
    if (ids.length > 0) {
      db.run(`UPDATE persona_changes SET revert_of = NULL WHERE revert_of IN ${placeholders(ids)}`, ...ids);
      deleted += deleteByIds(db, "persona_changes", ids);
    }
  }
  return { rows: deleted, more: hasMore };
}

function trimOversizedEndedWorkerStepsIn(db: Db, budget: number): TableRetentionBatch {
  const sessions = db.all<{ session_id: number }>(
    `SELECT ss.session_id FROM session_steps ss
      JOIN agent_sessions s ON s.id = ss.session_id
      WHERE s.role = 'worker' AND s.status = 'ended' AND s.pid IS NULL
      GROUP BY ss.session_id HAVING count(*) > ?
      ORDER BY ss.session_id LIMIT 20`,
    ENDED_WORKER_STEPS_KEEP,
  );
  let deleted = 0;
  let hasMore = false;
  for (const { session_id: sid } of sessions) {
    const remaining = budget - deleted;
    if (remaining <= 0) {
      hasMore = true;
      break;
    }
    const cutoff = db.get<{ id: number }>(
      "SELECT id FROM session_steps WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?",
      sid,
      ENDED_WORKER_STEPS_KEEP,
    );
    if (cutoff === undefined) continue;
    const rows = db.all<{ id: number }>(
      "SELECT id FROM session_steps WHERE session_id = ? AND id <= ? ORDER BY id ASC LIMIT ?",
      sid,
      cutoff.id,
      remaining + 1,
    );
    if (rows.length > remaining) hasMore = true;
    deleted += deleteByIds(db, "session_steps", rows.slice(0, remaining).map((r) => r.id));
  }
  return { rows: deleted, more: hasMore || sessions.length >= 20 };
}

/**
 * Precondition: ctx holds an open migrated database.
 * Postcondition: returns a DbTableRetention controller enforcing dual time and count caps across growing ledger tables.
 */
export function createDbTableRetention(ctx: LedgerContext): DbTableRetention {
  const { db, write } = ctx;
  const purgePmToolMessagesBatch = (nowMs: number, maxRows: number) =>
    write(() => purgePmToolMessagesIn(db, nowMs, normalizeBudget(maxRows)));
  const purgeTerminalActionsBatch = (nowMs: number, maxRows: number) =>
    write(() => purgeTerminalActionsIn(db, nowMs, normalizeBudget(maxRows)));
  const purgeHubCallsBatch = (nowMs: number, maxRows: number) =>
    write(() => purgeHubCallsIn(db, nowMs, normalizeBudget(maxRows)));
  const purgeHandoversBatch = (nowMs: number, maxRows: number) =>
    write(() => purgeHandoversIn(db, nowMs, normalizeBudget(maxRows)));
  const prunePersonaChangesBatch = (maxRows: number) =>
    write(() => prunePersonaChangesIn(db, normalizeBudget(maxRows)));
  const trimEndedWorkerSteps = (sessionId: SessionId) => write(() => trimEndedWorkerStepsIn(db, sessionId));
  const clearConsumedHandoverBlobs = (sessionId: SessionId) => write(() => clearConsumedHandoverBlobsIn(db, sessionId));

  const purgeAllBatch = (nowMs: number, maxRows: number): TableRetentionBatch => {
    const budget = normalizeBudget(maxRows);
    const steps: Array<(rem: number) => TableRetentionBatch> = [
      (rem) => purgePmToolMessagesBatch(nowMs, rem),
      (rem) => purgeTerminalActionsBatch(nowMs, rem),
      (rem) => purgeHubCallsBatch(nowMs, rem),
      (rem) => purgeHandoversBatch(nowMs, rem),
      (rem) => write(() => {
        const rows = pruneSandboxApprovalsIn(db, nowMs, rem);
        return { rows, more: rows >= rem };
      }),
      (rem) => prunePersonaChangesBatch(rem),
      (rem) => write(() => trimOversizedEndedWorkerStepsIn(db, rem)),
    ];
    let total = 0;
    for (const run of steps) {
      const remaining = budget - total;
      if (remaining <= 0) return { rows: total, more: true };
      const res = run(remaining);
      total += res.rows;
      if (res.more) return { rows: total, more: true };
    }
    return { rows: total, more: false };
  };

  return {
    purgePmToolMessagesBatch,
    purgeTerminalActionsBatch,
    purgeHubCallsBatch,
    purgeHandoversBatch,
    prunePersonaChangesBatch,
    trimEndedWorkerSteps,
    clearConsumedHandoverBlobs,
    purgeAllBatch,
  };
}
