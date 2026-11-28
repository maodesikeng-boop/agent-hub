// Invariant: every interrupt request either settles through an active turn/exit, aborts pre-spawn startup, awaits an already-closing process, or returns immediately only when the session is already quiescent.
import type { BaseBatch, BaseProc } from "./driver-helpers.ts";

export interface StoppableSessionState<TProc extends BaseProc<unknown>, TBatch extends BaseBatch> {
  proc: TProc | null;
  inFlight: TBatch[];
  stopRequested: boolean;
  turnInterrupted: boolean;
  starting: Promise<void> | null;
  interruptTimer: NodeJS.Timeout | null;
  interruptWaiters: Array<() => void>;
}

export interface StopCoordinationCallbacks<TProc extends BaseProc<unknown>, TState> {
  dropPendingUsers(st: TState): void;
  stopIdleBackgroundTasks(st: TState, proc: TProc): Promise<void> | null;
  isBusy(st: TState): boolean;
  sendInterrupt(st: TState, proc: TProc): void;
  markMidTurnBatchesStopped?(st: TState): void;
}

export interface PostAckEscalationTarget<TProc extends BaseProc<unknown>> {
  proc: TProc | null;
  interruptTimer: NodeJS.Timeout | null;
}

/**
 * Precondition: called on a live session state from BaseSessionDriver.interrupt.
 * Postcondition: drops pending user messages; if startup is awaiting spawn before proc attaches, latches stopRequested and awaits startup; if proc is already closing, awaits proc.exited; if idle background tasks are active, closes the process and awaits exit; if busy or pre-init, latches stopRequested, invokes sendInterrupt once, and resolves when the turn ends or process exits; if already idle, returns without hanging.
 */
export async function coordinateSessionInterrupt<
  TProc extends BaseProc<unknown>,
  TBatch extends BaseBatch,
  TState extends StoppableSessionState<TProc, TBatch>,
>(
  _st: TState,
  _callbacks: StopCoordinationCallbacks<TProc, TState>,
): Promise<void> {
  throw new Error("Not implemented");
}

/**
 * Precondition: called immediately before writing a batch to a child process stdin.
 * Postcondition: returns true and clears stopRequested/turnInterrupted when a stop was latched before the batch was written (signaling the caller to cancel or requeue the batch instead of writing it); returns false otherwise.
 */
export function consumePreWriteStop<TBatch extends BaseBatch>(
  _st: { stopRequested: boolean; turnInterrupted: boolean; inFlight: TBatch[] },
  _batch: TBatch,
): boolean {
  throw new Error("Not implemented");
}

/**
 * Precondition: the vendor acknowledged an interrupt request while the turn has not yet emitted its terminal event.
 * Postcondition: replaces any existing interruptTimer with a bounded postAckGraceMs timer that invokes onEscalate only if st.proc is still proc and not yet closing.
 */
export function armPostAckInterruptEscalation<
  TProc extends BaseProc<unknown>,
  TState extends PostAckEscalationTarget<TProc>,
>(
  _st: TState,
  _proc: TProc,
  _postAckGraceMs: number,
  _onEscalate: (st: TState, proc: TProc) => void,
): void {
  throw new Error("Not implemented");
}
