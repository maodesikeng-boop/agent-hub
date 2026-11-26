import { expect, it, vi } from "vitest";
import { systemEventOf } from "../../shared/domain.ts";
import { SCHEDULE_SHOW_RUNS_MAX } from "../../shared/limits.ts";
import { createPmFrictionFixture } from "./pm-friction-fixture.ts";
import { recentScheduleRuns } from "./schedule-runs.ts";

it("uses the dedupe key range for the production schedule history query", () => {
  const f = createPmFrictionFixture();
  try {
    const all = vi.spyOn(f.db, "all");
    recentScheduleRuns(f.db, f.lin.conversationId, 1, SCHEDULE_SHOW_RUNS_MAX);
    const [sql, ...params] = all.mock.calls[0]!;
    const plan = f.db.all<{ detail: string }>("EXPLAIN QUERY PLAN " + sql, ...params);
    expect(plan.map((step) => step.detail).join("\n")).toMatch(/SEARCH messages USING INDEX .*dedupe_key>\? AND dedupe_key<\?/);
  } finally {
    f.close();
  }
});

it("keeps the first linked reply if a schedule run is processed again", () => {
  const f = createPmFrictionFixture();
  try {
    const { schedule } = f.ledger.hubCall(f.lin.sessionId, "schedule.add", {
      name: "巡检", prompt: "检查队列", everyMinutes: 60,
    }).data;
    f.clock.now = schedule.nextRunAt;
    f.ledger.runDueSchedules(f.clock.now);
    const run = f.pmSystemMessages().find((m) => systemEventOf(m)?.event === "schedule.run")!;
    f.pmReplyTo(run.id, "原来的回复");
    f.db.run("UPDATE messages SET status = 'processing' WHERE id = ?", run.id);
    f.pmReplyTo(run.id, "重放时的回复");
    const { runs } = f.ledger.hubCall(f.lin.sessionId, "schedule.show", { scheduleId: schedule.id }).data;
    expect(runs[0]).toMatchObject({ messageId: run.id, replyPreview: "原来的回复" });
  } finally {
    f.close();
  }
});
