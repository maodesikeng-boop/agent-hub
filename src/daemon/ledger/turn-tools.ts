import type { AgentSessionRow, SessionId } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import { TURN_TOOLS_MAX_PER_SESSION } from "../../shared/limits.ts";
import { describeStep } from "../../shared/step-labels.ts";
import type { TurnId } from "../../shared/turn.ts";
import type { LedgerContext } from "./context.ts";
import { storedStepSummary } from "./steps.ts";
import { oneLine, stepOfTool } from "./tool-summary.ts";

export type TurnToolStatus = "pending" | "running" | "done" | "unconfirmed";

export interface TurnToolRecord {
  readonly turnId: TurnId;
  readonly toolUseId: string;
  readonly name: string;
  readonly summary: string | null;
  readonly status: TurnToolStatus;
  readonly recordedAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
}

export type ToolEvent = Extract<DriverEvent, { type: "agent.tool" | "agent.tool_running" | "agent.tool_result" }>;

export interface LedgerTurnTools {
  afterDriverEvent(session: AgentSessionRow, runningTurnId: TurnId | null, event: ToolEvent): void;
  closeOpen(turnId: TurnId, at: number): void;
  trimSession(sessionId: SessionId): void;
  count(turnId: TurnId): number;
  lastActivityAt(turnId: TurnId): number | null;
  openToolsOf(turnId: TurnId): TurnToolRecord[];
  toolsOf(turnId: TurnId): TurnToolRecord[];
  sessionTools(sessionId: SessionId): TurnToolRecord[];
}

const COLUMNS = `tt.turn_id AS turnId, tt.tool_use_id AS toolUseId, tt.name, tt.summary, tt.status,
  tt.recorded_at AS recordedAt, tt.started_at AS startedAt, tt.ended_at AS endedAt`;
const OPEN = "status IN ('pending', 'running')";
const PATH_KEYS = ["file_path", "notebook_path", "AbsolutePath", "TargetFile", "Path"];
const ARG_KEYS = ["command", "CommandLine", "pattern", "url", "query", "path", "SearchPath", "description", "prompt"];

function toolLine(name: string, input: unknown): string {
  const valueOf = (key: string): unknown => input !== null && typeof input === "object" && !Array.isArray(input)
    ? Object.getOwnPropertyDescriptor(input, key)?.value : undefined;
  const label = describeStep(stepOfTool(name, input));
  if (PATH_KEYS.some((key) => {
    const value = valueOf(key);
    return typeof value === "string" && oneLine(value) !== "";
  })) return label;
  for (const key of ARG_KEYS) {
    const value = valueOf(key);
    if (typeof value === "string" && oneLine(value) !== "") return `${label}: ${oneLine(value)}`;
  }
  return label;
}

export function createLedgerTurnTools({ db }: LedgerContext): LedgerTurnTools {
  return {
    afterDriverEvent(session, runningTurnId, event) {
      if (event.parentToolUseId !== undefined) return;
      if (event.type === "agent.tool_result") {
        if (event.toolUseIds.length === 0) return;
        db.run(
          `UPDATE turn_tools SET status = 'done', ended_at = ?
           WHERE status <> 'done' AND (tool_use_id, turn_id) IN (
             SELECT ids.value, (
               SELECT tt.turn_id FROM turn_tools tt JOIN turns t ON t.id = tt.turn_id
               WHERE tt.tool_use_id = ids.value AND t.session_id = ? AND tt.recorded_at <= ?
               ORDER BY tt.turn_id DESC LIMIT 1
             ) FROM json_each(?) ids
           )`,
          event.at, session.id, event.at, JSON.stringify(event.toolUseIds),
        );
        return;
      }
      if (runningTurnId === null) return;
      if (event.type === "agent.tool_running") {
        db.run(
          `UPDATE turn_tools SET status = 'running', started_at = ?
           WHERE turn_id = ? AND tool_use_id = ? AND status = 'pending' AND recorded_at <= ?`,
          event.startedAt ?? event.at, runningTurnId, event.toolUseId, event.at,
        );
        return;
      }
      db.run(
        `INSERT INTO turn_tools (turn_id, tool_use_id, name, summary, status, recorded_at, started_at)
         SELECT ?, ?, ?, ?, ?, ?, ? FROM turns WHERE id = ? AND started_at <= ?
         ON CONFLICT (turn_id, tool_use_id) DO NOTHING`,
        runningTurnId, event.toolUseId, event.name, storedStepSummary(toolLine(event.name, event.input)),
        event.pending ? "pending" : "running", event.at, event.pending ? null : event.startedAt ?? event.at,
        runningTurnId, event.at,
      );
    },
    closeOpen(turnId, at) {
      db.run(`UPDATE turn_tools SET status = 'unconfirmed', ended_at = ? WHERE turn_id = ? AND ${OPEN}`, at, turnId);
    },
    trimSession(sessionId) {
      db.run(
        `DELETE FROM turn_tools WHERE rowid IN (
           SELECT tt.rowid FROM turns t JOIN turn_tools tt ON tt.turn_id = t.id
           WHERE t.session_id = ? AND t.status = 'ended'
           ORDER BY t.id DESC, tt.rowid DESC LIMIT -1 OFFSET ?
         )`,
        sessionId, TURN_TOOLS_MAX_PER_SESSION,
      );
    },
    count: (id) => db.get<{ n: number }>("SELECT count(*) AS n FROM turn_tools WHERE turn_id = ?", id)?.n ?? 0,
    lastActivityAt: (id) => db.get<{ at: number | null }>(
      "SELECT max(max(recorded_at, coalesce(started_at, recorded_at), coalesce(ended_at, recorded_at))) AS at FROM turn_tools WHERE turn_id = ?", id,
    )?.at ?? null,
    openToolsOf: (id) => db.all<TurnToolRecord>(
      `SELECT ${COLUMNS} FROM turn_tools tt WHERE tt.turn_id = ? AND ${OPEN} ORDER BY tt.rowid DESC LIMIT ?`,
      id, TURN_TOOLS_MAX_PER_SESSION,
    ).reverse(),
    toolsOf: (id) => db.all<TurnToolRecord>(
      `SELECT ${COLUMNS} FROM turn_tools tt WHERE tt.turn_id = ? ORDER BY tt.rowid DESC LIMIT ?`,
      id, TURN_TOOLS_MAX_PER_SESSION,
    ).reverse(),
    sessionTools: (id) => db.all<TurnToolRecord>(
      `SELECT ${COLUMNS} FROM turns t JOIN turn_tools tt ON tt.turn_id = t.id WHERE t.session_id = ?
       ORDER BY t.id DESC, tt.rowid DESC LIMIT ?`, id, TURN_TOOLS_MAX_PER_SESSION,
    ).reverse(),
  };
}
