import type { ConversationId, PmId } from "../../shared/domain.ts";
import type { HubArgs, HubResult } from "../../shared/hub.ts";
import type { ScheduleId, ScheduleRecord, ScheduleRunSummary } from "../../shared/schedule.ts";
import type { Db } from "../store/index.ts";

// Invariant: schedule run reads are synchronous and bounded through the messages dedupe_key index.

/**
 * Precondition: limit is between 1 and SCHEDULE_SHOW_RUNS_MAX.
 * Postcondition: at most `limit` runs of this schedule in this conversation, newest first, found through the
 * `schedule.run` dedupe-key prefix so the cost does not grow with the conversation. A run whose message meta is
 * malformed is still listed from its dedupe key. replyPreview is at most SCHEDULE_RUN_REPLY_PREVIEW_CHARS characters.
 */
export function recentScheduleRuns(_db: Db, _conversationId: ConversationId, _scheduleId: ScheduleId, _limit: number): ScheduleRunSummary[] {
  throw new Error("Not implemented");
}

/**
 * Postcondition: when the schedule's last run is not among `runs` because its message is gone, returns `runs` with a
 * `cleaned` entry for that run in time order; otherwise returns `runs` unchanged.
 */
export function withCleanedLastRun(_schedule: ScheduleRecord, _runs: readonly ScheduleRunSummary[]): ScheduleRunSummary[] {
  throw new Error("Not implemented");
}

/**
 * Throws not_found when the schedule does not exist and forbidden when it belongs to another PM.
 * Postcondition: text holds the full prompt and recent runs from recentScheduleRuns (with withCleanedLastRun applied);
 * data carries the same schedule and runs. Reads only.
 */
export function scheduleShowIn(
  _db: Db,
  _caller: { pmId: PmId; conversationId: ConversationId | null },
  _args: HubArgs<"schedule.show">,
  _now: number,
): HubResult<"schedule.show"> {
  throw new Error("Not implemented");
}
