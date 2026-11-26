import type { PmId, TaskGraphId, TaskNodeKey, WorkerId } from "./domain.ts";
import type { PmWatchId, PmWatchStatus } from "./pm-watch.ts";

// Invariant: the agenda is computed from ledger rows on demand and never stored. A line's text never contains a
// relative age, so the passing of time alone is never a change; lines carry absolute start times instead.

export type AgendaStepState =
  | { kind: "running"; workerId: WorkerId | null; slot: string | null }
  | { kind: "waiting_pm"; reason: string }
  | { kind: "waiting_user"; reason: string }
  | { kind: "queued_slot"; slot: string; position: number; holder: { graphId: TaskGraphId; nodeKey: TaskNodeKey; workerId: WorkerId | null } };

export interface AgendaStepLine {
  key: TaskNodeKey;
  title: string;
  state: AgendaStepState;
  since: number;
}

export interface AgendaGraphBlock {
  graphId: TaskGraphId;
  title: string;
  stepCount: number;
  doneCount: number;
  pendingCount: number;
  /** Every step is done and the graph is still active: it waits for the PM to deliver. */
  readyToFinish: boolean;
  /** Running, waiting, and queued steps only; done and not-started steps are counted, not listed. */
  steps: AgendaStepLine[];
  watchId: PmWatchId | null;
  needsPm: boolean;
  oldestNeedsPmSince: number | null;
}

export type AgendaOutsideItem =
  | { kind: "worker_report"; workerId: WorkerId; title: string; outcome: "done" | "problem" | "gave_up" | "unparsed" | "turn_failed"; since: number }
  | { kind: "watch"; watchId: PmWatchId; body: string; status: PmWatchStatus; since: number; graphId: TaskGraphId | null; workerId: WorkerId | null };

export interface PmAgenda {
  pmId: PmId;
  at: number;
  /** Graphs that need the PM first, oldest wait first; then the rest by most recent change. */
  graphs: AgendaGraphBlock[];
  omittedGraphs: number;
  outside: AgendaOutsideItem[];
  userCards: number;
}

/** One line the PM reads, keyed for diffing. `ref` is stable per item and includes when its current state began. */
export interface AgendaLine {
  ref: string;
  needsPm: boolean;
  text: string;
}

export interface AgendaCounts {
  needsPm: number;
  running: number;
  queued: number;
  watching: number;
  userCards: number;
  oldestNeedsPmSince: number | null;
}

export type AgendaChange =
  | { op: "add"; line: AgendaLine }
  | { op: "change"; before: AgendaLine; after: AgendaLine }
  | { op: "remove"; line: AgendaLine };

/** What one PM session has already received; advanced only after the driver reports the message written. */
export interface AgendaCursor {
  version: number;
  lines: AgendaLine[];
  deltasSinceSnapshot: number;
  deliveredAt: number;
}

export type AgendaFooter =
  | { kind: "none" }
  | { kind: "snapshot"; version: number; lines: AgendaLine[]; text: string }
  | { kind: "delta"; version: number; lines: AgendaLine[]; changes: AgendaChange[]; text: string }
  | { kind: "unchanged"; version: number; lines: AgendaLine[]; text: string };

export const PM_AGENDA_PREAMBLE_HEADING = "## 该你做的（账本实时状态；和上面的交接或记录冲突时以这里为准）";

export const PM_AGENDA_BUSY_LINE = "【用户在你还在干活时发来这条；回复的最后一段直接回答它】";

/** Postcondition: one line per graph header, per listed step, and per outside item, in agenda order; text has no relative age. */
export function agendaLinesOf(_agenda: PmAgenda): AgendaLine[] {
  throw new Error("Not implemented");
}

export function agendaCountsOf(_agenda: PmAgenda): AgendaCounts {
  throw new Error("Not implemented");
}

/**
 * Postcondition: returns the changes that turn `before` into `after`, matched by `ref`: `add` for refs only in `after`,
 * `remove` for refs only in `before`, `change` when the text differs. Order follows `after`, then removals.
 * Identical inputs return an empty array.
 */
export function diffAgendaLines(_before: readonly AgendaLine[], _after: readonly AgendaLine[]): AgendaChange[] {
  throw new Error("Not implemented");
}

/**
 * Chooses what to append to the next message written to a PM session.
 * - `snapshot` when there is no cursor, the context was compacted since the cursor, the cursor reached
 *   `PM_AGENDA_DELTAS_PER_SNAPSHOT` change footers, or the changes exceed `PM_AGENDA_DELTA_LINES_MAX` lines.
 * - `delta` when some line changed; its text lists only the changes under a header with the next version and counts.
 * - `unchanged` when nothing changed and at least one line remains; one line with the current version and counts.
 * - `none` when nothing changed and the list is empty.
 * Postcondition: `version` is `cursor.version + 1` for `snapshot` and `delta`, and `cursor.version` for `unchanged`.
 */
export function nextAgendaFooter(
  _cursor: AgendaCursor | null,
  _agenda: PmAgenda,
  _opts: { now: number; compactedSinceCursor: boolean },
): AgendaFooter {
  throw new Error("Not implemented");
}

/** Postcondition: the whole per-graph list for `hub status` and the session preamble, capped by the agenda limits. */
export function formatPmAgenda(_agenda: PmAgenda, _now: number): string {
  throw new Error("Not implemented");
}

/** Postcondition: the notice sent once after a handover; lists only lines that need the PM. */
export function handoverAgendaNoticeText(_agenda: PmAgenda): string {
  throw new Error("Not implemented");
}
