// Invariant: hub worker show and hub worker list share one state formatter and one background-task formatter so open, errored, waiting, and idle Workers always display consistent status.
import type { SessionId } from "../../shared/domain.ts";
import type { BackgroundTaskInfo } from "../../shared/driver.ts";
import type { Db } from "../store/index.ts";
import type { LiveSession } from "./sessions.ts";
import type { TurnOutcome } from "./steps.ts";

export interface WorkerStateInput {
  status: string;
  notStarted: boolean;
  live: LiveSession;
  lastTurnOutcome: TurnOutcome | null;
  lastEventAt: number | null;
  now: number;
}

export interface FormatWorkerStateOptions {
  includeIdleDuration?: boolean;
}

/**
 * Precondition: input reflects the current Worker row, live session state, and most recent turn_ended outcome (if any).
 * Postcondition: returns the canonical display label (ended, preparing, background, working, or idle reason); appends elapsed idle duration when includeIdleDuration is true, the Worker is open and idle, and idle time meets WORKER_LIST_IDLE_HINT_MIN_MS.
 */
export function formatWorkerState(_input: WorkerStateInput, _options?: FormatWorkerStateOptions): string {
  throw new Error("Not implemented");
}

/**
 * Precondition: sessionIds lists Worker session ids belonging to one PM query.
 * Postcondition: returns a map from each session id that has at least one turn_ended row in session_steps to its latest TurnOutcome in a single SQLite query.
 */
export function lastTurnOutcomesBySession(_db: Db, _sessionIds: readonly SessionId[]): ReadonlyMap<SessionId, TurnOutcome> {
  throw new Error("Not implemented");
}

/**
 * Precondition: tasks contains active background tasks tracked for a running Worker session; now is epoch ms.
 * Postcondition: returns formatted lines showing each task's clipped command or description and elapsed duration, capped at maxShown (defaulting to WORKER_SHOW_BACKGROUND_TASKS_MAX) with an overflow line when more tasks are active.
 */
export function formatBackgroundTasksSummary(
  _tasks: readonly BackgroundTaskInfo[],
  _now: number,
  _maxShown?: number,
): string[] {
  throw new Error("Not implemented");
}
