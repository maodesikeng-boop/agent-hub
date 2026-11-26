// Invariant: a tool row belongs to exactly one turn, keyed by (turn, vendor tool id), and its completion is written from
// the persisted row alone, never from in-memory session state. Subtask tools (with a parent tool id) are not stored.
import type { AgentSessionRow } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import type { TurnId } from "../../shared/turn.ts";
import type { LedgerContext } from "./context.ts";

export type TurnToolStatus = "pending" | "running" | "done" | "unconfirmed";

export interface TurnToolRecord {
  readonly turnId: TurnId;
  readonly toolUseId: string;
  readonly name: string;
  readonly summary: string | null;
  readonly status: TurnToolStatus;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
}

export type ToolEvent = Extract<DriverEvent, { type: "agent.tool" | "agent.tool_running" | "agent.tool_result" }>;

export interface LedgerTurnTools {
  /**
   * `agent.tool` inserts into the running turn; `agent.tool_result` marks the matching tool done in the newest turn of the
   * session that holds that tool id, including an ended turn, and never in a later turn that reused the id.
   * Postcondition: a repeated result changes nothing; a result for an unknown id changes nothing.
   */
  afterDriverEvent(session: AgentSessionRow, runningTurnId: TurnId | null, event: ToolEvent): void;
  /** Marks every still-pending or running tool of the turn `unconfirmed` at `at`. */
  closeOpen(turnId: TurnId, at: number): void;
  openToolsOf(turnId: TurnId): TurnToolRecord[];
  toolsOf(turnId: TurnId): TurnToolRecord[];
}

export function createLedgerTurnTools(_ctx: LedgerContext): LedgerTurnTools {
  throw new Error("Not implemented");
}
