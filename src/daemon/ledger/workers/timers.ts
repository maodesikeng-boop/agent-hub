import { randomUUID } from "node:crypto";
import { systemMessageDedupeKey } from "../../../shared/domain.ts";
import type { ConversationId, SystemMessageMeta, WorkerId } from "../../../shared/domain.ts";
import { DEFAULT_WORKER_MAX_TIME_MS } from "../../../shared/limits.ts";
import { HUB_COMMAND } from "../../../shared/names.ts";
import { formatDurationShort } from "../../../shared/schedule.ts";
import type { Pending } from "../context.ts";
import { toMessage } from "../rows.ts";
import type { MessageDbRow, WorkerDbRow } from "../rows.ts";
import { workerRow } from "./ctx.ts";
import { isWorkerInFlight } from "./lines.ts";
import { notStarted } from "./text.ts";
import type { WorkersCtx } from "./types.ts";

type TimedWorker = Pick<WorkerDbRow, "id" | "worker_conversation_id">;

function stopTimer(w: WorkersCtx, workerConversationId: ConversationId): void {
  const existing = w.maxTimeTimers.get(workerConversationId);
  if (existing !== undefined) {
    clearTimeout(existing.timer);
    w.maxTimeTimers.delete(workerConversationId);
  }
}

const deleteStoredMaxTime = (w: WorkersCtx, workerConversationId: ConversationId) =>
  w.db.run("DELETE FROM worker_turn_timeouts WHERE worker_id = (SELECT id FROM workers WHERE worker_conversation_id = ?)", workerConversationId);

export function clearMaxTime(w: WorkersCtx, workerConversationId: ConversationId): void {
  stopTimer(w, workerConversationId);
  deleteStoredMaxTime(w, workerConversationId);
}

/** Deletes the stored deadline in the transaction and stops the timer after commit, unless the same transaction armed a new one. */
export function clearMaxTimeIn(w: WorkersCtx, p: Pending, workerConversationId: ConversationId): void {
  const armed = w.maxTimeTimers.get(workerConversationId);
  deleteStoredMaxTime(w, workerConversationId);
  p.after.push(() => {
    if (armed !== undefined && w.maxTimeTimers.get(workerConversationId) === armed) stopTimer(w, workerConversationId);
  });
}

/** On daemon stop keep the stored timers so restart recovery can re-arm them. */
export function clearAllMaxTime(w: WorkersCtx): void {
  for (const entry of w.maxTimeTimers.values()) clearTimeout(entry.timer);
  w.maxTimeTimers.clear();
}

export const turnTimeoutOf = (w: WorkersCtx, workerId: WorkerId) =>
  w.db.get<{ max_time_ms: number; deadline_at: number; notified: number }>(
    "SELECT max_time_ms, deadline_at, notified FROM worker_turn_timeouts WHERE worker_id = ?",
    workerId,
  ) ?? null;

function insertMaxTimeNoticeIn(w: WorkersCtx, p: Pending, worker: WorkerDbRow, maxTimeMs: number, deadlineAt: number): void {
  const pmSession = w.sessions.currentSession(worker.pm_conversation_id);
  if (pmSession === null) return;
  const t = w.now();
  const label = formatDurationShort(maxTimeMs);
  const text =
    `【Worker #${worker.id} · ${worker.title} 已超过最大时间（${label}）】` +
    `该 Worker 当前一轮已运行 ${label} 仍未结束（仍在运行中，未被停止）。` +
    `请用 ${HUB_COMMAND} worker show ${worker.id} 和 ${HUB_COMMAND} worker log ${worker.id} --last 15 检查它是否在正常推进，并视情况告知用户、继续等待或停止换人。`;
  const meta: SystemMessageMeta = {
    event: "worker.max_time_exceeded",
    workerId: worker.id,
    workerConversationId: worker.worker_conversation_id,
    maxTimeMs,
    deadlineAt,
  };
  const row = w.db.get<MessageDbRow>(
    `INSERT INTO messages (conversation_id, session_id, worker_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
     VALUES (?, ?, ?, 'system', 'text', ?, ?, ?, 'queued', ?, ?)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
    worker.pm_conversation_id,
    pmSession.id,
    worker.id,
    text,
    JSON.stringify(meta),
    `${systemMessageDedupeKey(worker.pm_conversation_id, meta)}:${deadlineAt}:${randomUUID()}`,
    t,
    t,
  );
  w.db.run("UPDATE worker_turn_timeouts SET notified = 1 WHERE worker_id = ?", worker.id);
  if (row === undefined) return;
  p.changes.push({ type: "message.created", data: { message: toMessage(row) } });
  w.enqueue(p, { type: "session.send", params: { sessionId: pmSession.id, messageId: row.id, source: "system" } });
}

function onMaxTimeExceeded(
  w: WorkersCtx,
  workerId: WorkerId,
  workerConversationId: ConversationId,
  timer: ReturnType<typeof setTimeout>,
  maxTimeMs: number,
  deadlineAt: number,
): void {
  const current = w.maxTimeTimers.get(workerConversationId);
  if (current?.timer !== timer) return;
  stopTimer(w, workerConversationId);
  try {
    w.write((p) => {
      const worker = workerRow(w, workerId);
      if (worker === null) return;
      if (worker.status !== "open" || !isWorkerInFlight(w, worker)) {
        clearMaxTime(w, workerConversationId);
        return;
      }
      if (turnTimeoutOf(w, worker.id)?.notified === 1) return;
      insertMaxTimeNoticeIn(w, p, worker, maxTimeMs, deadlineAt);
    });
  } catch {
    // Writes fail during shutdown; do not retry, restart recovery re-arms timers from stored state.
  }
}

function armTimer(w: WorkersCtx, worker: TimedWorker, maxTimeMs: number, deadline: number): void {
  stopTimer(w, worker.worker_conversation_id);
  const startedAt = deadline - maxTimeMs;
  const timer = setTimeout(() => {
    onMaxTimeExceeded(w, worker.id, worker.worker_conversation_id, timer, maxTimeMs, deadline);
  }, Math.max(0, deadline - w.now()));
  timer.unref?.();
  w.maxTimeTimers.set(worker.worker_conversation_id, { timer, maxTimeMs, startedAt });
}

export function startMaxTime(w: WorkersCtx, worker: TimedWorker, maxTimeMs: number = DEFAULT_WORKER_MAX_TIME_MS): void {
  const deadline = w.now() + maxTimeMs;
  w.db.run(
    `INSERT INTO worker_turn_timeouts (worker_id, max_time_ms, deadline_at, notified) VALUES (?, ?, ?, 0)
     ON CONFLICT (worker_id) DO UPDATE SET max_time_ms = excluded.max_time_ms, deadline_at = excluded.deadline_at, notified = 0`,
    worker.id,
    maxTimeMs,
    deadline,
  );
  armTimer(w, worker, maxTimeMs, deadline);
}

export function turnMaxTimeOf(w: WorkersCtx, workerConversationId: ConversationId): { maxTimeMs: number; startedAt: number } | null {
  const row = w.db.get<{ max_time_ms: number; deadline_at: number }>(
    `SELECT t.max_time_ms, t.deadline_at FROM worker_turn_timeouts t JOIN workers w ON w.id = t.worker_id
      WHERE w.worker_conversation_id = ?`,
    workerConversationId,
  );
  return row === undefined ? null : { maxTimeMs: row.max_time_ms, startedAt: row.deadline_at - row.max_time_ms };
}

export function recoverTurnTimeouts(w: WorkersCtx): WorkerId[] {
  w.db.run("DELETE FROM worker_turn_timeouts WHERE worker_id IN (SELECT id FROM workers WHERE status = 'ended')");
  const rows = w.db.all<{ id: number; worker_conversation_id: number; max_time_ms: number; deadline_at: number; notified: number }>(
    `SELECT w.id, w.worker_conversation_id, t.max_time_ms, t.deadline_at, t.notified FROM worker_turn_timeouts t JOIN workers w ON w.id = t.worker_id
      WHERE w.status = 'open' ORDER BY w.id`,
  );
  const armed: WorkerId[] = [];
  for (const row of rows) {
    const worker = workerRow(w, row.id);
    if (worker === null || (!notStarted(worker) && !isWorkerInFlight(w, worker))) {
      clearMaxTime(w, row.worker_conversation_id);
      continue;
    }
    if (row.notified === 0) {
      armTimer(w, row, row.max_time_ms, row.deadline_at);
      armed.push(row.id);
    }
  }
  return armed;
}

export function ensureTurnMaxTime(w: WorkersCtx, workerId: WorkerId): void {
  const worker = workerRow(w, workerId);
  if (worker === null || worker.status !== "open") return;
  if (turnTimeoutOf(w, worker.id) === null) startMaxTime(w, worker, DEFAULT_WORKER_MAX_TIME_MS);
}
