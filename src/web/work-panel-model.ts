import type { CompletedWorkItem, CompletedWorkPage, ConversationId, MessageId, TaskGraph, TaskNode } from "../shared/index.ts";
import type { WorkerEntry } from "./selectors.ts";

// Invariant: selectors here return the same object for the same input objects so memoized tab bodies skip rerenders.

export type WorkPanelTab = "active" | "completed" | "info";

export interface ActiveWork {
  /** Active graphs, those waiting on the user first, then by most recent update. */
  graphs: readonly TaskGraph[];
  /** Live Workers that no active graph step owns, running before idle. */
  workers: readonly WorkerEntry[];
  /** The `Active N` count: graphs plus standalone Workers. */
  count: number;
}

export interface CompletedDay {
  /** `Today`, `Yesterday`, or a short date such as `Nov 22`, in the viewer's time zone. */
  label: string;
  /** Local midnight of the day, used as the React key. */
  dayStart: number;
  items: readonly CompletedWorkItem[];
}

/** Where a click on an Active step goes. */
export type StepTarget =
  | { kind: "worker"; conversationId: ConversationId }
  | { kind: "ask"; messageId: MessageId }
  | { kind: "none" };

/**
 * Precondition: graphs are the project's active graphs; workers are the PM's Workers from workersOf.
 * Postcondition: drops ended Workers and Workers bound to any active graph step, keeps graph order from
 * sortActiveGraphs, and returns the same ActiveWork for the same two arrays.
 */
export function activeWorkOf(_graphs: readonly TaskGraph[], _workers: readonly WorkerEntry[]): ActiveWork {
  throw new Error("Not implemented");
}

/**
 * Precondition: pages are in fetch order and each page's items are newest first.
 * Postcondition: flattens the pages into day groups, newest day first, keeping item order; an item whose key already
 * appeared on an earlier page is dropped; returns the same array for the same pages array and the same `now` day.
 */
export function completedDaysOf(_pages: readonly CompletedWorkPage[], _now: number): readonly CompletedDay[] {
  throw new Error("Not implemented");
}

/** Postcondition: `graph:<id>` or `worker:<conversationId>`, unique across both kinds. */
export function completedKeyOf(_item: CompletedWorkItem): string {
  throw new Error("Not implemented");
}

/** Postcondition: `#437` for a GitHub-style pull request URL ending in a number, otherwise null. */
export function prLabelOf(_prUrl: string | null): string | null {
  throw new Error("Not implemented");
}

/**
 * Postcondition: a step with a live or most recent Worker opens that Worker; a step waiting on the user without a Worker
 * opens its ask card in the chat; any other step has no target.
 */
export function stepTargetOf(
  _node: Pick<TaskNode, "activeWorkerId" | "workerIds" | "gateAskMessageId" | "status" | "waitingFor">,
  _workers: readonly WorkerEntry[],
): StepTarget {
  throw new Error("Not implemented");
}
