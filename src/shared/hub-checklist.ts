import type { ChecklistItem, ChecklistUpdate } from "./checklist.ts";

// `hub checklist` gives vendors without a checklist tool the same list every other vendor keeps. Steps are
// addressed by their 1-based position in the session's current list, so the command works whichever tool wrote it.

export type HubChecklistRequest =
  | { kind: "set"; titles: string[] }
  | { kind: "start" | "done" | "cancel"; position: number };

export type HubChecklistParse = { ok: true; request: HubChecklistRequest } | { ok: false; error: string };

/** Chinese usage text shown in help and in every parse or position error. Uses only double-quoted positional arguments. */
export const HUB_CHECKLIST_USAGE: string = "";

/**
 * Parses the arguments after `hub checklist`.
 *
 * Postconditions:
 * - `set <title>...` with at least one non-blank title returns the trimmed, non-blank titles in order, each clipped to
 *   `CHECKLIST_TITLE_MAX_CHARS`. Arguments are taken verbatim, so CJK text and spaces inside one argument are kept.
 * - `start|done|cancel <n>` with a positive integer `n` returns that position.
 * - Anything else (no subcommand, unknown subcommand, `set` without titles, more than `CHECKLIST_MAX_ITEMS` titles,
 *   a missing, zero, negative, or non-integer position, extra arguments) returns `ok: false` with an error that
 *   contains `HUB_CHECKLIST_USAGE`.
 */
export function parseHubChecklistArgs(argv: readonly string[]): HubChecklistParse {
  throw new Error("Not implemented");
}

/**
 * Converts a request into an update of the session's `current` list.
 *
 * Postconditions:
 * - `set` returns a `replace` whose first item is `in_progress` and the rest `pending`, with null ids.
 * - `start` returns a `merge` setting that item `in_progress` and any other `in_progress` item back to `pending`.
 * - `done` returns a `merge` setting that item `completed` and, when the next item is `pending`, that one `in_progress`.
 * - `cancel` returns a `merge` setting that item `cancelled`.
 * - A position beyond `current.length` returns `ok: false` with an error naming the list length and the usage.
 */
export function hubChecklistUpdate(
  request: HubChecklistRequest,
  current: readonly ChecklistItem[],
): { ok: true; update: ChecklistUpdate } | { ok: false; error: string } {
  throw new Error("Not implemented");
}
