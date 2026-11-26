import type { ConversationId, MessageId, SessionId } from "./domain.ts";

export type TurnId = number;

export const TURN_CAUSES = ["input", "self", "recovery"] as const;
/** `input` opens on a taken input, `self` on a vendor-started turn (such as a background wake), `recovery` on a restart resend. */
export type TurnCause = (typeof TURN_CAUSES)[number];

export const TURN_STATUSES = ["running", "ended"] as const;
export type TurnStatus = (typeof TURN_STATUSES)[number];

export const TURN_OUTCOMES = ["ok", "interrupted", "failed", "empty_recovery"] as const;
export type TurnOutcome = (typeof TURN_OUTCOMES)[number];

export const STOP_SOURCES = ["user", "shutdown", "handover", "session_ended", "crash"] as const;
export type StopSource = (typeof STOP_SOURCES)[number];

export function isRecoveryStop(source: StopSource | null): boolean {
  return source === "shutdown" || source === "crash";
}

export const TURN_INPUT_ROLES = ["opening", "mid_turn"] as const;
export type TurnInputRole = (typeof TURN_INPUT_ROLES)[number];

export interface TurnInputSummary {
  readonly messageId: MessageId;
  readonly role: TurnInputRole;
  /** Last conversation message before the agent took this input; the web places a mid-turn input right after it. */
  readonly afterMessageId: MessageId | null;
}

export interface TurnBackgroundSummary {
  readonly activeCount: number;
  readonly waitingSince: number;
  readonly remindersSent: number;
}

/** Read projection of one turn row for the web, `hub`, and remote devices; older daemons omit it entirely. */
export interface TurnSummary {
  readonly id: TurnId;
  readonly sessionId: SessionId;
  readonly conversationId: ConversationId;
  readonly cause: TurnCause;
  readonly status: TurnStatus;
  readonly outcome: TurnOutcome | null;
  readonly stopSource: StopSource | null;
  readonly parentTurnId: TurnId | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  /** Set exactly when the turn has ended; equals endedAt - startedAt on the daemon clock. */
  readonly durationMs: number | null;
  readonly firstOutputId: MessageId | null;
  readonly lastOutputId: MessageId | null;
  readonly inputs: readonly TurnInputSummary[];
  /** Present while the model has replied but tracked background commands from this turn still run. */
  readonly background: TurnBackgroundSummary | null;
}
