// Invariant: a wait exists only after the model of a `backgroundWake` vendor replied while tracked background commands from
// that turn still ran. It never keeps a turn running, holds at most one report draft, and is deleted when it releases.
import type { MessageId, SessionId } from "../../shared/domain.ts";
import type { BackgroundChangedEvent, BackgroundTaskInfo } from "../../shared/driver.ts";
import type { TurnId } from "../../shared/turn.ts";
import type { LedgerContext, Pending } from "./context.ts";
import type { TurnRecord } from "./turns.ts";

export interface BackgroundWaitRecord {
  readonly turnId: TurnId;
  readonly sessionId: SessionId;
  readonly draftMessageId: MessageId | null;
  readonly directChat: boolean;
  readonly tasks: readonly BackgroundTaskInfo[];
  readonly activeCount: number;
  readonly waitingSince: number;
  /** When the active count last reached zero; the wait then gives the vendor WORKER_BACKGROUND_WAKE_GRACE_MS to continue. */
  readonly drainedAt: number | null;
  readonly remindersSent: number;
  readonly nextRemindAt: number | null;
}

export type WaitRelease =
  | { readonly kind: "continued"; readonly continuationTurnId: TurnId }
  | { readonly kind: "drained" }
  | { readonly kind: "process_exited"; readonly reason: "interrupt" | "crash" | "startup_failed" | "shutdown" | "idle" }
  | { readonly kind: "restart" }
  | { readonly kind: "worker_ended" };

export interface WaitEntry {
  readonly draftMessageId: MessageId | null;
  readonly directChat: boolean;
  readonly tasks: readonly BackgroundTaskInfo[];
  readonly activeCount: number;
}

export interface TurnBackgroundWaitsDeps {
  /** Delivers the held draft as the Worker report exactly once, with a note when the background work did not finish cleanly. */
  deliverHeldReportIn(p: Pending, wait: BackgroundWaitRecord, release: WaitRelease): void;
}

export interface LedgerTurnBackgroundWaits {
  /**
   * Precondition: `turn` just ended ok and its vendor declares `backgroundWake`.
   * Postcondition: one wait row for the turn's session with the first reminder due at waiting_since + WORKER_BACKGROUND_REMIND_AT_MS[0].
   */
  enterIn(p: Pending, turn: TurnRecord, entry: WaitEntry): BackgroundWaitRecord;
  /** Persists the task list and count; a count of zero starts the wake grace instead of releasing. */
  onBackgroundChangedIn(p: Pending, sessionId: SessionId, event: BackgroundChangedEvent): void;
  /** Deletes the session's wait and hands its draft to `deliverHeldReportIn` unless a continuation turn replaces it. */
  releaseIn(p: Pending, sessionId: SessionId, release: WaitRelease): BackgroundWaitRecord | null;
  waitOf(sessionId: SessionId): BackgroundWaitRecord | null;
  /**
   * Enqueues each due reminder as one `worker.background_wait` PM notice and releases waits whose wake grace has passed.
   * Postcondition: at most WORKER_BACKGROUND_REMIND_AT_MS.length reminders per wait; returns how many notices were enqueued.
   */
  runDue(nowMs: number): number;
  /** True only while the reminder's wait still exists for the same turn and still has an active background command. */
  isReminderCurrent(messageId: MessageId): boolean;
}

export function createLedgerTurnBackgroundWaits(_ctx: LedgerContext, _deps: TurnBackgroundWaitsDeps): LedgerTurnBackgroundWaits {
  throw new Error("Not implemented");
}
