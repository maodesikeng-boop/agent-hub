import type { DriverEvent } from "./driver.ts";
import { isHubChecklistCommand } from "./hub-checklist.ts";
import { TURN_CHECKLIST_COMMANDS_TRIGGER, TURN_CHECKLIST_EDITS_TRIGGER } from "./limits.ts";
import { toolAction } from "./step-labels.ts";

export interface TurnChecklistWatch {
  edits: number;
  commands: number;
  listed: boolean;
  reminded: boolean;
}

export function newTurnWatch(): TurnChecklistWatch {
  return { edits: 0, commands: 0, listed: false, reminded: false };
}

export function turnWatchStep(
  watch: TurnChecklistWatch | null,
  event: DriverEvent,
): { watch: TurnChecklistWatch | null; remind: boolean } {
  switch (event.type) {
    case "turn.started":
      return { watch: newTurnWatch(), remind: false };
    case "message.processing":
      return { watch: event.midTurn ? watch : newTurnWatch(), remind: false };
    case "turn.ended":
    case "session.exited":
      return { watch: null, remind: false };
    case "agent.checklist":
      return { watch: event.parentToolUseId === undefined ? { ...(watch ?? newTurnWatch()), listed: true } : watch, remind: false };
    case "agent.tool": {
      if (event.parentToolUseId !== undefined) break;
      const action = toolAction(event.name);
      if (action === "todo" || (action === "command" && isHubChecklistCommand(event.input))) {
        return { watch: { ...(watch ?? newTurnWatch()), listed: true }, remind: false };
      }
      if (action !== "edit" && action !== "write" && action !== "command") break;
      const next = { ...(watch ?? newTurnWatch()) };
      if (action === "command") next.commands++;
      else next.edits++;
      const remind = !next.listed && !next.reminded &&
        (next.edits >= TURN_CHECKLIST_EDITS_TRIGGER || next.commands >= TURN_CHECKLIST_COMMANDS_TRIGGER);
      if (remind) next.reminded = true;
      return { watch: next, remind };
    }
  }
  return { watch, remind: false };
}
