// Invariant: self-reload busy descriptions name specific active sessions and running background commands,
// bounded by SELF_RELOAD_BUSY_ITEMS_MAX so large workloads never flood hub status or reload receipts.

import type { AgentRole, SessionId, WorkerId } from "../shared/domain.ts";
import type { BackgroundTaskInfo } from "../shared/driver.ts";

export interface BusyBackgroundCommand {
  readonly label: string;
  readonly startedAt: number;
}

export interface BusySessionSnapshot {
  readonly sessionId: SessionId;
  readonly role: AgentRole;
  readonly activity: string;
  readonly workerId?: WorkerId;
  readonly workerTitle?: string;
  readonly pmName?: string;
  readonly backgroundTasks?: readonly Pick<BackgroundTaskInfo, "label" | "startedAt">[];
}

/**
 * Precondition: sessions contains only currently busy (non-idle, non-ended, non-broken) sessions.
 * Postcondition: returns up to SELF_RELOAD_BUSY_ITEMS_MAX human-readable Chinese reason strings prioritizing Workers with
 * running background commands (showing command labels and elapsed durations), followed by an overflow summary when more sessions are busy.
 */
export function describeBusySessionsForReload(_sessions: readonly BusySessionSnapshot[], _now: number): string[] {
  throw new Error("Not implemented");
}
