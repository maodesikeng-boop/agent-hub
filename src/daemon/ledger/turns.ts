// Invariant: this module is the only writer of `turns` and `turn_inputs`, and once a turn has taken an input it is the only
// code that settles that input's `messages.status` projection. At most one running turn exists per session, and every
// duration is ended_at - started_at on the daemon clock.
import type { AgentSessionRow, ConversationId, Message, MessageId, MessageStatus, SessionId } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import type { StopSource, TurnCause, TurnId, TurnInputRole, TurnOutcome, TurnStatus, TurnSummary } from "../../shared/turn.ts";
import type { LedgerContext, Pending } from "./context.ts";
import type { TurnEndedEvent } from "./turn-completions.ts";

export interface TurnRecord {
  readonly id: TurnId;
  readonly sessionId: SessionId;
  readonly conversationId: ConversationId;
  readonly cause: TurnCause;
  readonly status: TurnStatus;
  readonly outcome: TurnOutcome | null;
  readonly stopSource: StopSource | null;
  readonly failureReason: string | null;
  readonly parentTurnId: TurnId | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly durationMs: number | null;
  readonly firstOutputId: MessageId | null;
  readonly lastOutputId: MessageId | null;
  readonly replyMessageId: MessageId | null;
}

export type InputOutcome = "replied" | "stopped" | "failed" | "interrupted";

export interface TurnInputRecord {
  readonly turnId: TurnId;
  readonly messageId: MessageId;
  readonly role: TurnInputRole;
  readonly afterMessageId: MessageId | null;
  readonly takenAt: number | null;
  readonly outcome: InputOutcome | null;
  readonly stopSource: StopSource | null;
}

export interface SettledTurn {
  readonly turn: TurnRecord;
  readonly inputs: readonly TurnInputRecord[];
  /** True when the turn produced no text, tool call, or checklist update. */
  readonly empty: boolean;
}

export interface RecoveryResend {
  readonly sessionId: SessionId;
  readonly messageId: MessageId;
  readonly interruptedTurnId: TurnId;
  /** 1 for the first resend of this input after a restart. */
  readonly attempt: number;
}

export interface TurnsDeps {
  /** Writes the `messages.status` projection for one input; supplied by the messages module, which owns the column. */
  projectInputStatus(p: Pending, messageId: MessageId, status: MessageStatus, reason: string | null): void;
}

export interface LedgerTurns {
  /**
   * Opens a turn on the first taken input or `turn.started` of an idle session, attaches later taken inputs as `mid_turn`,
   * and extends the running turn's output range on agent text, tool, and checklist messages.
   * Postcondition: events for a session with no running turn and no opening signal change nothing.
   */
  afterDriverEvent(p: Pending, session: AgentSessionRow, event: Exclude<DriverEvent, TurnEndedEvent>): void;
  /**
   * Ends the running turn from a durable `turn.ended` receipt in the receipt's transaction and settles every input the
   * turn took. A successful receipt settles its inputs as replied even when a stop was requested meanwhile; only a
   * receipt that reports interruption settles them as stopped, with the recorded stop source.
   * Postcondition: returns null for a duplicate receipt or a session with no running turn; never reopens an ended turn.
   */
  settle(p: Pending, session: AgentSessionRow, event: TurnEndedEvent, previousRun: boolean): SettledTurn | null;
  /** Ends the running turn when the process exits without a receipt; `startup_failed` before any turn opens a failed turn. */
  settleExit(p: Pending, session: AgentSessionRow, event: Extract<DriverEvent, { type: "session.exited" | "driver.error" }>): SettledTurn | null;
  /** Records why a stop was requested so the terminal receipt can name it; does not settle any input by itself. */
  requestStopIn(p: Pending, sessionId: SessionId, source: StopSource): void;
  runningTurnOf(sessionId: SessionId): TurnRecord | null;
  lastEndedTurnOf(sessionId: SessionId): TurnRecord | null;
  turnOf(id: TurnId): TurnRecord | null;
  /** The newest turn that took this input, or null when no turn has taken it yet. */
  turnTakingInput(messageId: MessageId): TurnRecord | null;
  /**
   * Postcondition: one summary per turn whose output range or inputs intersect `messages`, plus the session's running
   * turn, ordered by id and capped at TURN_SUMMARIES_PER_PAGE_MAX.
   */
  summariesFor(conversationId: ConversationId, messages: readonly Message[]): TurnSummary[];
  /**
   * Runs once at startup after every pending receipt settles and before any send. Ends each turn still running (the
   * previous process died without a receipt) as interrupted by `crash` and closes its open tools as unconfirmed. Returns one
   * resend per input that a turn interrupted by `shutdown` or `crash` took and that no later turn has taken, skipping inputs
   * already resent TURN_RECOVERY_MAX_ATTEMPTS times. Postcondition: a second call before any send returns nothing new.
   */
  recoverAfterRestartIn(p: Pending): RecoveryResend[];
}

export function createLedgerTurns(_ctx: LedgerContext, _deps: TurnsDeps): LedgerTurns {
  throw new Error("Not implemented");
}
