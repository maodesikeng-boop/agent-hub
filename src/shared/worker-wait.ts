import type { WorkerId } from "./domain.ts";

// Invariant: start phases are derived purely from ledger rows and live session state, with no duplicated state machine.

export const WORKER_START_PHASES = [
  "creating_worktree",
  "running_setup",
  "waiting_worktree_lock",
  "spawning",
  "delivering",
  "started",
  "awaiting_sandbox_approval",
  "user_blocked",
  "failed",
  "ended",
  "unknown",
] as const;

export type WorkerStartPhase = (typeof WORKER_START_PHASES)[number];

export const WORKER_WAIT_SETTLED_PHASES: readonly WorkerStartPhase[] = [
  "started",
  "awaiting_sandbox_approval",
  "user_blocked",
  "failed",
  "ended",
  "unknown",
];

export interface WorkerStartStatus {
  workerId: WorkerId;
  phase: WorkerStartPhase;
  /** Milliseconds from Worker creation to started when settled as started, or elapsed so far. */
  elapsedMs: number;
  /** Failure or blocker detail when phase is failed, user_blocked, or ended. */
  detail: string | null;
}

export interface WorkerWaitResult {
  workers: WorkerStartStatus[];
  settled: boolean;
  timedOut: boolean;
}

/** Postcondition: true iff phase requires no further waiting (started, blocked on external action, failed, ended, or unknown). */
export function isWorkerStartSettled(_phase: WorkerStartPhase): boolean {
  throw new Error("Not implemented");
}

/**
 * Postcondition: formats one summary per Worker in Chinese (project-agnostic); started Workers report prep duration,
 * sandbox/blocker states say the Worker will not start on its own, failures show detail, unknown says undetermined,
 * and timed-out pending Workers show phase, elapsed time, and note that the PM may end the turn.
 */
export function formatWorkerWaitResult(_result: WorkerWaitResult): string {
  throw new Error("Not implemented");
}
