// Invariant: every interrupt request either settles through an active turn/exit, aborts pre-spawn startup, awaits an already-closing process, or returns immediately only when the session is already quiescent.
import type { BaseBatch, BaseProc } from "./driver-helpers.ts";

export type StoppableProc = Pick<BaseProc<never>, "closing" | "initSeen" | "exited">;

export interface StoppableSessionState<TProc extends StoppableProc, TBatch extends BaseBatch> {
  proc: TProc | null;
  inFlight: TBatch[];
  stopRequested: boolean;
  turnInterrupted: boolean;
  starting: Promise<void> | null;
  interruptTimer: NodeJS.Timeout | null;
  interruptWaiters: Array<() => void>;
}

export interface StopCoordinationCallbacks<TProc extends StoppableProc, TState> {
  dropPendingUsers(st: TState): void;
  stopIdleBackgroundTasks(st: TState, proc: TProc): Promise<void> | null;
  isBusy(st: TState): boolean;
  sendInterrupt(st: TState, proc: TProc): void;
  markMidTurnBatchesStopped?(st: TState): void;
}

export interface PostAckEscalationTarget<TProc extends StoppableProc> {
  proc: TProc | null;
  interruptTimer: NodeJS.Timeout | null;
}

/**
 * Precondition: called on a live session state from BaseSessionDriver.interrupt.
 * Postcondition: drops pending user messages; if startup is awaiting spawn before proc attaches, latches stopRequested and awaits startup; if proc is already closing, awaits proc.exited; if idle background tasks are active, closes the process and awaits exit; if busy or pre-init, latches stopRequested, invokes sendInterrupt once, and resolves when the turn ends or process exits; if already idle, returns without hanging.
 */
export async function coordinateSessionInterrupt<
  TProc extends StoppableProc,
  TBatch extends BaseBatch,
  TState extends StoppableSessionState<TProc, TBatch>,
>(
  st: TState,
  callbacks: StopCoordinationCallbacks<TProc, TState>,
): Promise<void> {
  callbacks.dropPendingUsers(st);
  for (;;) {
    const proc = st.proc;
    if (!proc) {
      if (st.starting !== null) {
        st.stopRequested = true;
        await st.starting.catch(() => {});
        if (st.proc === null) {
          st.stopRequested = false;
          return;
        }
        continue;
      }
      st.stopRequested = false;
      return;
    }
    if (proc.closing !== null) {
      await proc.exited;
      return;
    }
    const stopBg = callbacks.stopIdleBackgroundTasks(st, proc);
    if (stopBg !== null) {
      await stopBg;
      return;
    }
    if (!callbacks.isBusy(st) && proc.initSeen) {
      if (st.starting !== null) {
        const pendingStart = st.starting;
        await pendingStart.catch(() => {});
        if (st.proc !== proc || (st.starting !== null && st.starting !== pendingStart) || callbacks.isBusy(st) || proc.closing !== null) {
          continue;
        }
      }
      st.stopRequested = false;
      return;
    }
    st.stopRequested = true;
    callbacks.markMidTurnBatchesStopped?.(st);
    const done = new Promise<void>((resolve) => st.interruptWaiters.push(resolve));
    callbacks.sendInterrupt(st, proc);
    return done;
  }
}

/**
 * Precondition: called immediately before writing a batch to a child process stdin.
 * Postcondition: returns true and clears stopRequested/turnInterrupted when a stop was latched before the batch was written (signaling the caller to cancel or requeue the batch instead of writing it); returns false otherwise.
 */
export function consumePreWriteStop<TBatch extends BaseBatch>(
  st: { stopRequested: boolean; turnInterrupted: boolean; inFlight: TBatch[] },
  _batch: TBatch,
): boolean {
  if (!st.stopRequested) return false;
  st.stopRequested = false;
  st.turnInterrupted = false;
  return true;
}

/**
 * Precondition: the vendor acknowledged an interrupt request while the turn has not yet emitted its terminal event.
 * Postcondition: replaces any existing interruptTimer with a bounded postAckGraceMs timer that invokes onEscalate only if st.proc is still proc and not yet closing.
 */
export function armPostAckInterruptEscalation<
  TProc extends StoppableProc,
  TState extends PostAckEscalationTarget<TProc>,
>(
  st: TState,
  proc: TProc,
  postAckGraceMs: number,
  onEscalate: (st: TState, proc: TProc) => void,
  shouldEscalate?: (st: TState, proc: TProc) => boolean,
): void {
  if (st.interruptTimer) clearTimeout(st.interruptTimer);
  st.interruptTimer = setTimeout(() => {
    st.interruptTimer = null;
    if (st.proc !== proc || proc.closing !== null) return;
    if (shouldEscalate && !shouldEscalate(st, proc)) return;
    onEscalate(st, proc);
  }, postAckGraceMs);
}
