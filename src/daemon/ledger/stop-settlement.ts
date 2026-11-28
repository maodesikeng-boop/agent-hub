// Invariant: every stop request carries a monotonic StopId, and stop settlement never clears a newer stop or an active turn.
import type { SessionActivity, SessionId } from "../../shared/domain.ts";
import type { StopId, StopSettlementState } from "../../shared/ledger.ts";

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
export function createStopSettlement(_deps: StopSettlementDeps): StopSettlementController {
  throw new Error("Not implemented");
}

/**
 * Precondition: called after insertAgentMessage attempts to record an agent.tool event.
 * Postcondition: returns false when a duplicate tool event (inserted is false) arrives on an already idle session so it cannot resurrect working state; returns true otherwise.
 */
export function shouldApplyLiveToolStart(_inserted: boolean, _currentActivity: SessionActivity): boolean {
  throw new Error("Not implemented");
}

/**
 * Precondition: called after message.delivered attempts to transition its messageIds.
 * Postcondition: returns false when messageCount > 0 and transitionedCount === 0 and no delivered/processing input remains active (for example, all ids were already cancelled by Stop); returns true otherwise.
 */
export function shouldApplyLiveDelivery(
  _messageCount: number,
  _transitionedCount: number,
  _hasActiveInput: boolean,
): boolean {
  throw new Error("Not implemented");
}
