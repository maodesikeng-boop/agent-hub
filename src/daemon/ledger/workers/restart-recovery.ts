import type { MessageId } from "../../../shared/domain.ts";
import { CHECKLIST_REMINDER_SQL } from "../checklist-reminders.ts";
import type { Pending } from "../context.ts";
import { SHUTDOWN_INTERRUPTED_REASON } from "../steps.ts";
import { workerSession } from "./ctx.ts";
import { insertTurnFailed } from "./reports.ts";
import type { WorkersCtx } from "./types.ts";
import type { WorkerDbRow } from "../rows.ts";

const SHUTDOWN_TURN_NOT_RESENT = "守护进程重启打断了这一轮，重启后没能自动重发";

export function noticeUnresentShutdownTurnsIn(w: WorkersCtx, p: Pending): void {
  const workers = w.db.all<WorkerDbRow>(
    `SELECT w.* FROM workers w WHERE w.status = 'open'
      AND (w.workspace = 'main' OR w.base_commit IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM pm_archives a WHERE a.pm_id = w.pm_id)
      AND NOT EXISTS (SELECT 1 FROM worker_sandbox_approvals a WHERE a.worker_id = w.id AND a.status = 'pending')`,
  );
  for (const worker of workers) {
    const session = workerSession(w, worker);
    const turn = w.db.get<{ id: number; kind: string; summary: string | null }>(
      "SELECT id, kind, summary FROM session_steps WHERE session_id = ? AND kind IN ('turn_ended', 'turn_started') ORDER BY id DESC LIMIT 1",
      session.id,
    );
    if (turn?.kind !== "turn_ended" || turn.summary !== SHUTDOWN_INTERRUPTED_REASON) continue;
    if (w.db.get(`SELECT 1 FROM messages WHERE session_id = ? AND status IN ('queued', 'delivered', 'processing') AND NOT ${CHECKLIST_REMINDER_SQL} LIMIT 1`, session.id)) continue;
    const messageId = w.db.get<{ id: MessageId }>(
      "SELECT id FROM messages WHERE session_id = ? AND sender IN ('pm', 'user') ORDER BY id DESC LIMIT 1", session.id,
    )?.id;
    insertTurnFailed(w, p, worker, messageId ?? null, [], SHUTDOWN_TURN_NOT_RESENT);
    w.db.run("UPDATE session_steps SET summary = ? WHERE id = ?", SHUTDOWN_TURN_NOT_RESENT, turn.id);
  }
}
