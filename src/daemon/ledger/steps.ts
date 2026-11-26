import type { DriverEvent } from "../../shared/driver.ts";
import type { AgentSessionRow, SessionId } from "../../shared/domain.ts";
import { SESSION_STEPS_KEEP, WORKER_STORED_STEP_SUMMARY_MAX_CHARS } from "../../shared/limits.ts";
import type { LedgerContext } from "./context.ts";
import { redactSecrets } from "./redact.ts";
import { oneLine } from "./tool-summary.ts";

export type StepRow =
  | { kind: "thinking"; at: number; summary: null }
  | { kind: "text"; at: number; summary: string | null };

export function storedStepSummary(text: string): string {
  const safe = redactSecrets(oneLine(text));
  const chars = [...safe];
  return chars.length > WORKER_STORED_STEP_SUMMARY_MAX_CHARS
    ? `${chars.slice(0, WORKER_STORED_STEP_SUMMARY_MAX_CHARS - 1).join("")}…`
    : safe;
}

export function createLedgerSteps({ db }: LedgerContext) {
  return {
    afterDriverEvent(session: AgentSessionRow, event: Extract<DriverEvent, { type: "agent.thinking" | "agent.text" }>) {
      if (session.role !== "worker" || event.parentToolUseId !== undefined) return;
      const kind = event.type === "agent.text" ? "text" : "thinking";
      db.run(
        `INSERT INTO session_steps (session_id, kind, at, summary, dedupe_key)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`,
        session.id, kind, event.at, event.type === "agent.text" ? storedStepSummary(event.text) : null, `step:${session.id}:${kind}:${event.uuid}`,
      );
    },
    trim(sessionId: SessionId) {
      db.run(
        `DELETE FROM session_steps WHERE session_id = ? AND id <= (
           SELECT id FROM session_steps WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?
         )`, sessionId, sessionId, SESSION_STEPS_KEEP,
      );
    },
    rows: (sessionId: SessionId, since?: number): StepRow[] => db.all<StepRow>(
      `SELECT kind, at, summary FROM session_steps
       WHERE session_id = ? AND kind IN ('thinking', 'text') ${since === undefined ? "" : "AND at >= ?"}
       ORDER BY id DESC LIMIT ?`, sessionId, ...(since === undefined ? [] : [since]), SESSION_STEPS_KEEP,
    ).reverse(),
  };
}

export type LedgerSteps = ReturnType<typeof createLedgerSteps>;
