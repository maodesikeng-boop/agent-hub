import { expect, it, vi } from "vitest";
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
