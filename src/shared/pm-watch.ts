import type { TaskGraphId, WorkerId } from "./domain.ts";

// Invariant: a watch belongs to its PM, not to a session or vendor; it settles at most once per run and only while watching.

export type PmWatchId = number;

export const PM_WATCH_STATUSES = ["watching", "met", "failed", "expired", "closed"] as const;
export type PmWatchStatus = (typeof PM_WATCH_STATUSES)[number];

export type PmWatchCondition =
  | { kind: "once"; command: string }
  | { kind: "poll"; command: string; everyMs: number }
  | { kind: "timer"; afterMs: number };

export interface PmWatchInput {
  condition: PmWatchCondition;
  maxMs?: number;
  body: string;
  graphId?: TaskGraphId;
  workerId?: WorkerId;
}

export interface PmWatchRecord {
  id: PmWatchId;
  condition: PmWatchCondition;
  body: string;
  graphId: TaskGraphId | null;
  workerId: WorkerId | null;
  status: PmWatchStatus;
  runs: number;
  deadlineAt: number;
  exitCode: number | null;
  outputTail: string | null;
  createdAt: number;
  settledAt: number | null;
}

export type PmWatchOutcome = { kind: "met"; exitCode: number | null; outputTail: string } | { kind: "failed"; exitCode: number | null; outputTail: string } | { kind: "expired" };

/** Postcondition: the receipt for `hub watch add`, naming the watch and how to list and close it. */
export function pmWatchReceiptText(_watch: PmWatchRecord): string {
  throw new Error("Not implemented");
}

/** Postcondition: the settle notice, quoting the PM's body and the output tail. */
export function pmWatchSettledText(_watch: PmWatchRecord): string {
  throw new Error("Not implemented");
}
