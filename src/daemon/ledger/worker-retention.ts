import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ConversationId, SessionId, WorkerId } from "../../shared/domain.ts";
import {
  WORKER_PURGE_BATCH_ROWS,
  WORKER_PURGE_CANDIDATES_PER_BATCH,
  WORKER_RETENTION_MAX_ENDED,
  WORKER_RETENTION_MS,
} from "../../shared/limits.ts";
import { removeSessionLaunchDir, workerSetupLogPath } from "../../shared/paths.ts";
import type { LedgerContext, LedgerFiles, Pending } from "./context.ts";

export interface WorkerPurgeBatch {
  rows: number;
  purged: WorkerId[];
  more: boolean;
}

interface Candidate {
  id: WorkerId;
  conv: ConversationId;
}

const IN_ACTIVE_GRAPH = `SELECT 1 FROM task_graphs g JOIN task_graph_steps n ON n.graph_id = g.id, json_each(n.worker_ids_json) j
             WHERE g.status = 'active' AND j.value = w.id`;

const placeholders = (ids: readonly number[]) => (ids.length === 0 ? "(NULL)" : `(${ids.map(() => "?").join(",")})`);

export function createLedgerWorkerRetention(ctx: LedgerContext, files: Pick<LedgerFiles, "launchDir" | "setupLogsDir">) {
  const { db, now, write } = ctx;

  const sessionIdsOf = (c: Candidate): SessionId[] =>
    db.all<{ id: number }>("SELECT id FROM agent_sessions WHERE role = 'worker' AND (worker_id = ? OR conversation_id = ?)", c.id, c.conv).map((r) => r.id);

  const busyWorkers = (): number[] => {
    const ids = new Set<number>();
    const workerOfSession = (id: unknown) =>
      typeof id === "number"
        ? db.get<{ worker_id: number | null }>(
            "SELECT COALESCE(s.worker_id, w.id) AS worker_id FROM agent_sessions s LEFT JOIN workers w ON w.worker_conversation_id = s.conversation_id WHERE s.id = ?",
            id,
          )?.worker_id
        : undefined;
    const workerOfMessage = (id: unknown) =>
      typeof id === "number"
        ? db.get<{ worker_id: number | null }>(
            "SELECT COALESCE(m.worker_id, w.id) AS worker_id FROM messages m LEFT JOIN workers w ON w.worker_conversation_id = m.conversation_id WHERE m.id = ?",
            id,
          )?.worker_id
        : undefined;
    for (const { params } of db.all<{ params: string }>("SELECT params FROM actions WHERE status IN ('pending', 'running') AND json_valid(params)")) {
      const a = JSON.parse(params) as { workerId?: unknown; sessionId?: unknown; messageId?: unknown };
      for (const id of [typeof a.workerId === "number" ? a.workerId : undefined, workerOfSession(a.sessionId), workerOfMessage(a.messageId)]) {
        if (id != null) ids.add(id);
      }
    }
    return [...ids];
  };

  const overflowAnchor = (): { updated_at: number; id: number } | undefined =>
    db.get<{ updated_at: number; id: number }>(
      `SELECT w.updated_at, w.id FROM workers w
        JOIN conversations c ON c.id = w.worker_conversation_id AND c.kind = 'worker'
        WHERE w.status = 'ended'
          AND w.worker_conversation_id != w.pm_conversation_id
          AND NOT EXISTS (SELECT 1 FROM conversation_purges x WHERE x.conversation_id = w.worker_conversation_id)
        ORDER BY w.updated_at DESC, w.id DESC LIMIT 1 OFFSET ?`,
      WORKER_RETENTION_MAX_ENDED,
    );

  const ageOrOverflowClause = (cutoff: number, anchor: { updated_at: number; id: number } | undefined): { sql: string; params: number[] } =>
    anchor === undefined
      ? { sql: "w.updated_at <= ?", params: [cutoff] }
      : {
          sql: "(w.updated_at <= ? OR w.updated_at < ? OR (w.updated_at = ? AND w.id <= ?))",
          params: [cutoff, anchor.updated_at, anchor.updated_at, anchor.id],
        };

  /** Cheap read-only check so the common case never opens a write transaction or scans actions. */
  const hasExpiredCandidate = (cutoff: number, anchor: { updated_at: number; id: number } | undefined): boolean => {
    const cond = ageOrOverflowClause(cutoff, anchor);
    return (
      db.get(
        `SELECT 1 AS x FROM workers w
          JOIN conversations c ON c.id = w.worker_conversation_id AND c.kind = 'worker'
          WHERE w.status = 'ended' AND ${cond.sql}
            AND w.worker_conversation_id != w.pm_conversation_id
            AND NOT EXISTS (SELECT 1 FROM conversation_purges x WHERE x.conversation_id = w.worker_conversation_id)
            AND NOT EXISTS (${IN_ACTIVE_GRAPH})
          LIMIT 1`,
        ...cond.params,
      ) !== undefined
    );
  };

  const eligible = (cutoff: number, anchor: { updated_at: number; id: number } | undefined, limit: number): Candidate[] => {
    const busy = busyWorkers();
    const cond = ageOrOverflowClause(cutoff, anchor);
    return db.all<{ id: number; conv: number }>(
      `SELECT w.id, w.worker_conversation_id AS conv FROM workers w
        JOIN conversations c ON c.id = w.worker_conversation_id AND c.kind = 'worker'
        WHERE w.status = 'ended' AND ${cond.sql}
          AND w.worker_conversation_id != w.pm_conversation_id
          AND NOT EXISTS (SELECT 1 FROM conversation_purges x WHERE x.conversation_id = w.worker_conversation_id)
          AND NOT EXISTS (${IN_ACTIVE_GRAPH})
          ${busy.length === 0 ? "" : `AND w.id NOT IN ${placeholders(busy)}`}
          AND NOT EXISTS (
            SELECT 1 FROM agent_sessions s
             WHERE (s.worker_id = w.id OR s.conversation_id = w.worker_conversation_id) AND (s.status = 'running' OR s.pid IS NOT NULL))
        ORDER BY w.updated_at, w.id LIMIT ?`,
      ...cond.params,
      ...busy,
      limit,
    );
  };

  const deleteChunk = (table: string, where: string, params: number[], limit: number): number =>
    db.run(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ?)`, ...params, limit).changes;

  const purgeOne = (p: Pending, c: Candidate, budget: number, purgedAt: number): { rows: number; finished: boolean } => {
    const sessionIds = sessionIdsOf(c);
    const heavy: Array<{ table: string; where: string; params: number[] }> = [
      {
        table: "actions",
        where: `status IN ('done', 'failed', 'abandoned') AND CASE WHEN json_valid(params) THEN
          json_extract(params, '$.sessionId') IN ${placeholders(sessionIds)} OR json_extract(params, '$.workerId') = ?
          OR json_extract(params, '$.messageId') IN (SELECT id FROM messages WHERE conversation_id = ?)
        ELSE 0 END`,
        params: [...sessionIds, c.id, c.conv],
      },
      { table: "messages", where: "conversation_id = ?", params: [c.conv] },
      { table: "session_steps", where: `session_id IN ${placeholders(sessionIds)}`, params: sessionIds },
      { table: "turn_tools", where: "turn_id IN (SELECT id FROM turns WHERE conversation_id = ?)", params: [c.conv] },
      { table: "hub_calls", where: `session_id IN ${placeholders(sessionIds)}`, params: sessionIds },
      {
        table: "handovers",
        where: `conversation_id = ? OR from_session_id IN ${placeholders(sessionIds)} OR to_session_id IN ${placeholders(sessionIds)}`,
        params: [c.conv, ...sessionIds, ...sessionIds],
      },
      { table: "worker_background_waits", where: `session_id IN ${placeholders(sessionIds)}`, params: sessionIds },
      { table: "worker_turn_timeouts", where: "worker_id = ?", params: [c.id] },
      { table: "session_persona_seen", where: `session_id IN ${placeholders(sessionIds)}`, params: sessionIds },
      { table: "session_preamble_seen", where: `session_id IN ${placeholders(sessionIds)}`, params: sessionIds },
    ];
    let rows = 0;
    let left = budget;
    for (const { table, where, params } of heavy) {
      if (left <= 0) return { rows, finished: false };
      const deleted = deleteChunk(table, where, params, left);
      rows += deleted;
      if (deleted >= left) return { rows, finished: false };
      left -= deleted;
    }
    db.run("INSERT INTO conversation_purges (conversation_id, purged_at) VALUES (?, ?)", c.conv, purgedAt);
    p.changes.push({ type: "conversation.purged", data: { conversationId: c.conv, purgedAt } });
    p.after.push(() => {
      if (files.launchDir !== undefined) for (const sid of sessionIds) removeSessionLaunchDir(files.launchDir, sid);
      if (files.setupLogsDir !== undefined) rmSync(workerSetupLogPath(files.setupLogsDir, c.id), { force: true });
    });
    return { rows, finished: true };
  };

  const sweepRetiredLaunchDirs = (): void => {
    const launchDir = files.launchDir;
    if (launchDir === undefined || !existsSync(launchDir)) return;
    let entries: string[];
    try {
      entries = readdirSync(launchDir);
    } catch {
      return;
    }
    const parsed: Array<{ entry: string; sid: number; legacy: boolean }> = [];
    for (const entry of entries) {
      const m = /^(session-)?([1-9]\d*)$/.exec(entry);
      if (m) parsed.push({ entry, sid: Number(m[2]), legacy: m[1] === "session-" });
    }
    if (parsed.length === 0) return;

    const keep = new Set<number>();
    for (const { id } of db.all<{ id: number }>(
      `SELECT s.id FROM agent_sessions s
        WHERE s.status != 'ended'
           OR s.pid IS NOT NULL
           OR (s.role = 'worker' AND (s.conversation_id IS NULL OR NOT EXISTS (
                 SELECT 1 FROM conversation_purges cp WHERE cp.conversation_id = s.conversation_id
               )))
           OR (s.role = 'pm' AND EXISTS (
                 SELECT 1 FROM handovers h
                  WHERE h.from_session_id = s.id AND h.status IN ('queued', 'forking', 'writing', 'ready')
               ))`,
    )) {
      keep.add(id);
    }
    for (const { params } of db.all<{ params: string }>("SELECT params FROM actions WHERE status IN ('pending', 'running') AND json_valid(params)")) {
      const a = JSON.parse(params) as { sessionId?: unknown };
      if (typeof a.sessionId === "number") keep.add(a.sessionId);
    }

    for (const { entry, sid, legacy } of parsed) {
      if (legacy || !keep.has(sid)) {
        rmSync(join(launchDir, entry), { recursive: true, force: true });
      }
    }
  };

  /** One transaction deletes at most maxRows rows to bound lock time. */
  const purgeBatch = (nowMs: number = now(), maxRows: number = WORKER_PURGE_BATCH_ROWS): WorkerPurgeBatch => {
    const cutoff = nowMs - WORKER_RETENTION_MS;
    const anchor = overflowAnchor();
    if (!hasExpiredCandidate(cutoff, anchor)) {
      sweepRetiredLaunchDirs();
      return { rows: 0, purged: [], more: false };
    }
    const budget = Math.max(1, Math.floor(maxRows));
    const { rows, purged, candidatesCount } = write((p) => {
      const candidates = eligible(cutoff, overflowAnchor(), WORKER_PURGE_CANDIDATES_PER_BATCH);
      let batchRows = 0;
      const batchPurged: WorkerId[] = [];
      for (const c of candidates) {
        if (batchRows >= budget) break;
        const one = purgeOne(p, c, budget - batchRows, nowMs);
        batchRows += one.rows;
        if (one.finished) batchPurged.push(c.id);
      }
      return { rows: batchRows, purged: batchPurged, candidatesCount: candidates.length };
    });
    sweepRetiredLaunchDirs();
    const more =
      candidatesCount === 0
        ? false
        : purged.length < candidatesCount
          ? true
          : candidatesCount < WORKER_PURGE_CANDIDATES_PER_BATCH
            ? false
            : eligible(cutoff, overflowAnchor(), 1).length > 0;
    return { rows, purged, more };
  };

  return { purgeBatch };
}
