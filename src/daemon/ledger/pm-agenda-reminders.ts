import type { PmId } from "../../shared/domain.ts";
import type { Db } from "../store/index.ts";

export interface PmAgendaReminder {
  pmId: PmId;
  refs: string[];
}

/**
 * Postcondition: one reminder per PM whose session is idle with no queued input, outside quiet hours, with agenda
 * lines that need it, have no linked watch, and whose unchanged ref is due at 15, 30, 60, or 120 minutes after it was
 * first delivered; a ref already reminded `PM_AGENDA_REMINDERS_MAX` times is never due again.
 */
export function dueAgendaRemindersOf(_db: Db, _now: number): PmAgendaReminder[] {
  throw new Error("Not implemented");
}
