// Invariant: schedule edits mutate the existing row in place inside one synchronous write transaction,
// preserving id, created_at, enabled state, and historical run metadata.
import type { PmId } from "../../shared/domain.ts";
import type { HubArgs, HubResult } from "../../shared/hub.ts";
import { planScheduleEdit, scheduleLabel, scheduledTimeText } from "../../shared/schedule.ts";
import type { Db } from "../store/index.ts";
import { fail, type Pending } from "./context.ts";
import { toSchedule, type ScheduleDbRow } from "./rows.ts";

export interface ScheduleEditDeps {
  db: Db;
  now: () => number;
  assertPmNotArchived: (pmId: PmId) => void;
}

/**
 * Precondition: called inside a synchronous ledger write transaction for an active PM session.
 * Throws conflict when the PM is archived, not_found when scheduleId does not exist, forbidden when owned by another PM,
 * and invalid when patch is empty or fails field or limit validation.
 * Postcondition: updates the existing schedules row in place without changing id, created_at, enabled, or last_* run history;
 * recomputes next_run_at if and only if frequency changed; emits a single `schedule.updated` change when any field changed
 * and emits no change on an exact no-op edit.
 */
export function scheduleEditIn(
  deps: ScheduleEditDeps,
  p: Pending,
  caller: { pmId: PmId },
  args: HubArgs<"schedule.edit">,
): HubResult<"schedule.edit"> {
  deps.assertPmNotArchived(caller.pmId);
  const row = deps.db.get<ScheduleDbRow>("SELECT * FROM schedules WHERE id = ?", args.scheduleId);
  if (row === undefined) throw fail("not_found", `没有编号 ${args.scheduleId} 的定时任务`);
  if (row.pm_id !== caller.pmId) throw fail("forbidden", `定时任务 #${args.scheduleId} 不是你建的，管不着`);
  const current = toSchedule(row);
  const t = deps.now();
  const planned = planScheduleEdit(
    current,
    {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
      ...(args.daily !== undefined ? { daily: args.daily } : {}),
      ...(args.everyMinutes !== undefined ? { everyMinutes: args.everyMinutes } : {}),
    },
    t,
  );
  if (!planned.ok) throw fail("invalid", planned.error);
  const { plan } = planned;
  if (!plan.changed) {
    return {
      text: `定时任务 #${current.id}“${current.name}”和现在一样，没有改动。`,
      data: { schedule: current },
    };
  }
  deps.db.run(
    `UPDATE schedules
     SET name = ?, kind = ?, at_time = ?, every_minutes = ?, prompt = ?, next_run_at = ?, updated_at = ?
     WHERE id = ?`,
    plan.name,
    plan.kind,
    plan.atTime,
    plan.everyMinutes,
    plan.prompt,
    plan.nextRunAt,
    t,
    current.id,
  );
  const updated = toSchedule(deps.db.get<ScheduleDbRow>("SELECT * FROM schedules WHERE id = ?", current.id)!);
  p.changes.push({ type: "schedule.updated", data: { schedule: updated } });
  const next = updated.enabled ? `下次 ${scheduledTimeText(updated.nextRunAt, t)}` : "已暂停";
  return {
    text: `已修改定时任务 #${updated.id}“${updated.name}”：${scheduleLabel(updated)}，${next}。`,
    data: { schedule: updated },
  };
}
