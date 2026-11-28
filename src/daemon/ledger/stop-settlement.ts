// Invariant: every stop request carries a monotonic StopId, and stop settlement never clears a newer stop or an active turn.
import type { SessionActivity, SessionId } from "../../shared/domain.ts";
import type { StopId, StopSettlementState } from "../../shared/ledger.ts";
import { getAgentSession } from "../store/index.ts";
import type { LedgerContext } from "./context.ts";
import type { LedgerMessages } from "./messages.ts";
import type { LedgerSessions } from "./sessions.ts";
import type { LedgerTurnBackgroundWaits } from "./turn-background-waits.ts";
import type { LedgerTurns } from "./turns.ts";
import { TURN_STOPPED } from "./workers/text.ts";

export interface StopSettlementDeps {
  hasPendingDriverEvents(sessionId: SessionId): boolean;
  hasPendingTurnCompletions(sessionId: SessionId): boolean;
  settleNow(sessionId: SessionId, stopId: StopId): void;
}

export interface StopSettlementController {
  /** Allocates the next strictly increasing StopId. */
  nextStopId(): StopId;
  /**
   * Precondition: driver.interrupt(sessionId) for stopId has completed.
   * Postcondition: when driverBusy and setupActive are both false, settles immediately if no driver events or turn completions are pending, or defers settlement until onSessionDrained(sessionId) fires; otherwise leaves the session untouched.
   */
  settleStop(sessionId: SessionId, stopId: StopId, state: StopSettlementState): void;
  /** Runs any deferred stop settlement for sessionId once its driver event queue drains. */
  onSessionDrained(sessionId: SessionId): void;
  /** Removes any deferred settlement entry for sessionId when the session is forgotten. */
  forget(sessionId: SessionId): void;
  /** Clears all deferred settlement entries on ledger close. */
  close(): void;
  /** Number of sessions currently awaiting deferred stop settlement. */
  pendingCount(): number;
}

/**
 * Precondition: deps provides synchronous drain checks and transactional settlement.
 * Postcondition: returns a bounded per-session stop settlement coordinator that matches every settlement strictly by StopId.
 */
export function createStopSettlement(deps: StopSettlementDeps): StopSettlementController {
  let seq = 0;
  const pending = new Map<SessionId, StopId>();

  const settleStop = (sessionId: SessionId, stopId: StopId, state: StopSettlementState): void => {
    if (state.driverBusy || state.setupActive) return;
    const existing = pending.get(sessionId);
    if (existing !== undefined && existing > stopId) return;
    if (deps.hasPendingDriverEvents(sessionId) || deps.hasPendingTurnCompletions(sessionId)) {
      pending.set(sessionId, stopId);
      return;
    }
    pending.delete(sessionId);
    deps.settleNow(sessionId, stopId);
  };

  const onSessionDrained = (sessionId: SessionId): void => {
    const stopId = pending.get(sessionId);
    if (stopId === undefined) return;
    if (deps.hasPendingDriverEvents(sessionId) || deps.hasPendingTurnCompletions(sessionId)) return;
    pending.delete(sessionId);
    deps.settleNow(sessionId, stopId);
  };

  return {
    nextStopId: () => ++seq,
    settleStop,
    onSessionDrained,
    forget: (sessionId) => {
      pending.delete(sessionId);
    },
    close: () => {
      pending.clear();
    },
    pendingCount: () => pending.size,
  };
}

export function settleStoppedSession(
  ctx: Pick<LedgerContext, "db" | "now" | "write">,
  deps: {
    sessions: Pick<LedgerSessions, "liveOf">;
    messages: Pick<LedgerMessages, "settleTurn">;
    turns: Pick<LedgerTurns, "runningTurnOf" | "settleExit">;
    workers: { backgroundWaits: Pick<LedgerTurnBackgroundWaits, "waitOf" | "releaseIn"> };
  },
  sessionId: SessionId,
  stopId: StopId,
): void {
  ctx.write((p) => {
    const live = deps.sessions.liveOf(sessionId);
    if (live.activity !== "stopping" || live.stopId !== stopId) return;
    if (deps.workers.backgroundWaits.waitOf(sessionId) !== null) {
      deps.workers.backgroundWaits.releaseIn(p, sessionId, {
        kind: "process_exited",
        reason: "interrupt",
        failureReason: TURN_STOPPED,
      });
    }
    const session = getAgentSession(ctx.db, sessionId);
    if (session === null) return;
    if (deps.turns.runningTurnOf(sessionId) !== null) {
      deps.turns.settleExit(p, session, {
        type: "session.exited",
        reason: "interrupt",
        exitCode: null,
        signal: null,
        hadResult: false,
        messageIds: [],
        at: ctx.now(),
      });
    }
    deps.messages.settleTurn(p, session);
  });
}

/**
 * Precondition: called after insertAgentMessage attempts to record an agent.tool event.
 * Postcondition: returns false when a duplicate tool event (inserted is false) arrives on an already idle session so it cannot resurrect working state; returns true otherwise.
 */
export function shouldApplyLiveToolStart(inserted: boolean, currentActivity: SessionActivity): boolean {
  return inserted || currentActivity !== "idle";
}

/**
 * Precondition: called after message.delivered attempts to transition its messageIds.
 * Postcondition: returns false when messageCount > 0 and transitionedCount === 0 and no delivered/processing input remains active (for example, all ids were already cancelled by Stop); returns true otherwise.
 */
export function shouldApplyLiveDelivery(
  messageCount: number,
  transitionedCount: number,
  hasActiveInput: boolean,
): boolean {
  return messageCount === 0 || transitionedCount > 0 || hasActiveInput;
}
