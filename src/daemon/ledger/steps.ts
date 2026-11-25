import { turnFailureReason } from "../../shared/driver.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import type { AgentSessionRow, SessionId } from "../../shared/domain.ts";
import { SESSION_STEPS_KEEP } from "../../shared/limits.ts";
import { describeStep } from "../../shared/step-labels.ts";
import type { LedgerContext } from "./context.ts";
import { exitFailureReason } from "./messages.ts";
import { redactSecrets } from "./redact.ts";
import { oneLine, stepOfTool } from "./tool-summary.ts";

export type StepKind = "turn_started" | "thinking" | "tool" | "tool_result" | "text" | "turn_ended";
export type TurnOutcome = "ok" | "interrupted" | "failed";

export interface StepRow {
  id: number;
  session_id: SessionId;
  kind: StepKind;
  at: number;
  name: string | null;
  tool_use_id: string | null;
  summary: string | null;
  outcome: TurnOutcome | null;
  duration_ms: number | null;
}

const MAX_STORED_CHARS = 300;
const TURN_FAILED_REASON = "这一轮出错了";
const RESTART_INTERRUPTED_REASON = "进程重启，这一轮被打断了";

const clip = (text: string) => {
  const chars = [...text];
  return chars.length > MAX_STORED_CHARS ? `${chars.slice(0, MAX_STORED_CHARS - 1).join("")}…` : text;
};
const stored = (text: string) => clip(redactSecrets(oneLine(text)));

const PATH_KEYS = ["file_path", "notebook_path", "AbsolutePath", "TargetFile", "Path"];
const ARG_KEYS = ["command", "CommandLine", "pattern", "url", "query", "path", "SearchPath", "description", "prompt"];

function toolLine(name: string, input: unknown): string {
  const args = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const label = describeStep(stepOfTool(name, input));
  if (PATH_KEYS.some((key) => typeof args[key] === "string" && oneLine(args[key] as string) !== "")) return label;
  for (const key of ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string" && oneLine(value) !== "") return `${label}: ${oneLine(value)}`;
  }
  return label;
}

export type LedgerSteps = ReturnType<typeof createLedgerSteps>;

export function createLedgerSteps(ctx: LedgerContext) {
  const { db, now } = ctx;

  const insert = (
    sessionId: SessionId,
    row: { kind: StepKind; name?: string; toolUseId?: string; summary?: string | null; outcome?: TurnOutcome; durationMs?: number | null; dedupeKey?: string },
  ) => {
    db.run(
      `INSERT INTO session_steps (session_id, kind, at, name, tool_use_id, summary, outcome, duration_ms, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`,
      sessionId,
      row.kind,
      now(),
      row.name ?? null,
      row.toolUseId ?? null,
      row.summary ?? null,
      row.outcome ?? null,
      row.durationMs ?? null,
      row.dedupeKey ?? null,
    );
  };

  const lastBoundary = (sessionId: SessionId): StepRow | null =>
    db.get<StepRow>(
      "SELECT * FROM session_steps WHERE session_id = ? AND kind IN ('turn_started', 'turn_ended') ORDER BY id DESC LIMIT 1",
      sessionId,
    ) ?? null;

  const openTurn = (sessionId: SessionId): StepRow | null => {
    const last = lastBoundary(sessionId);
    return last?.kind === "turn_started" ? last : null;
  };

  const ensureTurn = (sessionId: SessionId) => {
    if (openTurn(sessionId) === null) insert(sessionId, { kind: "turn_started" });
  };

  const endTurn = (sessionId: SessionId, outcome: TurnOutcome, reason: string | null, durationMs: number | null) => {
    insert(sessionId, { kind: "turn_ended", outcome, summary: reason === null ? null : stored(reason), durationMs });
    db.run(
      `DELETE FROM session_steps WHERE session_id = ? AND id <= (SELECT id FROM session_steps WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
      sessionId,
      sessionId,
      SESSION_STEPS_KEEP,
    );
  };

  const afterDriverEvent = (session: AgentSessionRow, event: DriverEvent, openTools?: readonly { toolUseId: string }[]) => {
    if (session.role !== "worker") return;
    const sessionId = session.id;
    switch (event.type) {
      case "session.started":
        if (openTurn(sessionId) !== null) endTurn(sessionId, "interrupted", RESTART_INTERRUPTED_REASON, null);
        return;
      case "message.delivered":
      case "message.processing":
      case "turn.started":
        ensureTurn(sessionId);
        return;
      case "agent.thinking":
        if (event.parentToolUseId !== undefined) return;
        ensureTurn(sessionId);
        insert(sessionId, { kind: "thinking", dedupeKey: `step:${sessionId}:thinking:${event.uuid}` });
        return;
      case "agent.text":
        if (event.parentToolUseId !== undefined) return;
        ensureTurn(sessionId);
        insert(sessionId, { kind: "text", summary: stored(event.text), dedupeKey: `step:${sessionId}:text:${event.uuid}` });
        return;
      case "agent.tool":
        if (event.parentToolUseId !== undefined) return;
        ensureTurn(sessionId);
        insert(sessionId, {
          kind: "tool",
          name: event.name,
          toolUseId: event.toolUseId,
          summary: stored(toolLine(event.name, event.input)),
          dedupeKey: `step:${sessionId}:tool:${event.uuid}:${event.toolUseId}`,
        });
        return;
      case "agent.tool_result":
        if (event.parentToolUseId !== undefined) return;
        for (const { toolUseId } of openTools ?? []) {
          if (event.toolUseIds.includes(toolUseId)) insert(sessionId, { kind: "tool_result", toolUseId });
        }
        return;
      case "turn.ended": {
        const outcome: TurnOutcome = event.interrupted ? "interrupted" : event.ok ? "ok" : "failed";
        const reason = outcome === "failed" ? (event.error === undefined ? TURN_FAILED_REASON : turnFailureReason(event.error)) : null;
        endTurn(sessionId, outcome, reason, event.durationMs);
        return;
      }
      case "session.exited": {
        if (event.reason === "idle" || openTurn(sessionId) === null) return;
        const crashed = event.reason === "crash" || event.reason === "startup_failed";
        endTurn(sessionId, crashed ? "failed" : "interrupted", crashed ? exitFailureReason(event) : null, null);
        return;
      }
      default:
        return;
    }
  };

  const rows = (sessionId: SessionId): StepRow[] =>
    db.all<StepRow>("SELECT * FROM session_steps WHERE session_id = ? ORDER BY id DESC LIMIT ?", sessionId, SESSION_STEPS_KEEP).reverse();

  return { afterDriverEvent, rows, openTurn, lastBoundary };
}
