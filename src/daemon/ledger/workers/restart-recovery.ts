import { workerMessageDedupeKey, type MessageId } from "../../../shared/domain.ts";
import { isRecoveryStop } from "../../../shared/turn.ts";
import { CHECKLIST_REMINDER_SQL } from "../checklist-reminders.ts";
import type { Pending } from "../context.ts";
import type { WorkerDbRow } from "../rows.ts";
import { SHUTDOWN_INTERRUPTED_REASON, type LedgerTurns } from "../turns.ts";
import { workerSession } from "./ctx.ts";
import { insertTurnFailed } from "./reports.ts";
import type { WorkersCtx } from "./types.ts";

const SHUTDOWN_TURN_NOT_RESENT = "守护进程重启打断了这一轮，重启后没能自动重发";

export function noticeUnresentShutdownTurnsIn(w: WorkersCtx, p: Pending, turns: LedgerTurns): void {
  const workers = w.db.all<WorkerDbRow>(
    `SELECT w.* FROM workers w WHERE w.status = 'open'
      AND (w.workspace = 'main' OR w.base_commit IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM pm_archives a WHERE a.pm_id = w.pm_id)
      AND NOT EXISTS (SELECT 1 FROM worker_sandbox_approvals a WHERE a.worker_id = w.id AND a.status = 'pending')`,
  );
  for (const worker of workers) {
    const session = workerSession(w, worker);
    if (turns.runningTurnOf(session.id) !== null) continue;
    const turn = turns.lastEndedTurnOf(session.id);
    const legacy = turn === null && w.db.get<{ id: number; kind: string; summary: string | null }>(
      "SELECT id, kind, summary FROM session_steps WHERE session_id = ? AND kind IN ('turn_ended', 'turn_started') ORDER BY id DESC LIMIT 1",
      session.id,
    );
    if (turn === null ? !legacy || legacy.kind !== "turn_ended" || legacy.summary !== SHUTDOWN_INTERRUPTED_REASON
      : turn.outcome !== "interrupted" || !isRecoveryStop(turn.stopSource)) continue;
    if (w.db.get(`SELECT 1 FROM messages WHERE session_id = ? AND status IN ('queued', 'delivered', 'processing') AND NOT ${CHECKLIST_REMINDER_SQL} LIMIT 1`, session.id)) continue;
    const messageId = (turn === null
      ? w.db.get<{ id: MessageId }>("SELECT id FROM messages WHERE session_id = ? AND sender IN ('pm', 'user') ORDER BY id DESC LIMIT 1", session.id)
      : w.db.get<{ id: MessageId }>(
        `SELECT m.id FROM turn_inputs i JOIN messages m ON m.id = i.message_id WHERE i.turn_id = ?
         AND m.sender IN ('pm', 'user') ORDER BY i.message_id DESC LIMIT 1`, turn.id,
      ))?.id ?? null;
    if (w.db.get("SELECT 1 FROM messages WHERE dedupe_key = ?", workerMessageDedupeKey(worker.id, "turn_failed", messageId))) continue;
    insertTurnFailed(w, p, worker, messageId, [], SHUTDOWN_TURN_NOT_RESENT);
  }
}
