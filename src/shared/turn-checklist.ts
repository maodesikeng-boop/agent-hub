import type { DriverEvent } from "./driver.ts";

// One trigger rule shared by the prompt wording and the daemon reminder: a turn that edits a file or runs a
// second command must update its checklist. Only top-level events count; subagent events never do.

export interface TurnChecklistWatch {
  edits: number;
  commands: number;
  listed: boolean;
  reminded: boolean;
}

/** Postcondition: a fresh, mutable watch with zero counts and both flags false. */
export function newTurnWatch(): TurnChecklistWatch {
  throw new Error("Not implemented");
}

/**
 * Feeds one driver event to the watch of a session. `watch` is null when no turn is open.
 *
 * Postconditions:
 * - `turn.started`, and `message.processing` without `midTurn`, return a fresh watch.
 * - `turn.ended` and `session.exited` return a null watch.
 * - A top-level `agent.tool` whose action is `edit` or `write` counts as an edit, and `command` as a command;
 *   every other action, an unknown tool name, and any event with `parentToolUseId` leave the counts unchanged.
 * - A top-level `agent.checklist` marks the turn as listed.
 * - A counted event (tool or checklist) with a null watch first opens a fresh watch, so a turn that was already
 *   running when the daemon started is still judged.
 * - `remind` is true exactly once per turn: on the first event after which edits reach
 *   `TURN_CHECKLIST_EDITS_TRIGGER` or commands reach `TURN_CHECKLIST_COMMANDS_TRIGGER` while the turn is not listed.
 * - Never throws on any `DriverEvent`.
 */
export function turnWatchStep(
  _watch: TurnChecklistWatch | null,
  _event: DriverEvent,
): { watch: TurnChecklistWatch | null; remind: boolean } {
  throw new Error("Not implemented");
}
