import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WATCH_MAX_DEFAULT_MS } from "../../shared/limits.ts";
import { pmWatchSettledText } from "../../shared/pm-watch.ts";
import { createPmFrictionFixture, type PmFrictionFixture } from "./pm-friction-fixture.ts";
import { addPmWatch, closePmWatch, listPmWatches, settlePmWatch, watchingPmWatches } from "./pm-watches.ts";

describe("S5: a wait on outside work survives everything", () => {
  let f: PmFrictionFixture;

  beforeEach(() => {
    f = createPmFrictionFixture();
  });

  afterEach(() => {
    f.close();
  });

  const owner = () => ({ pmId: f.lin.pmId, conversationId: f.lin.conversationId });

  it("S5.1 and S5.3: a poll watch is stored with its default deadline and is listed again for recovery after a restart", () => {
    const watch = addPmWatch(f.db, owner(), { condition: { kind: "poll", command: "check-ready", everyMs: 15_000 }, body: "检查通过后交付" }, f.clock.now);
    expect(watch).toMatchObject({ status: "watching", runs: 0, deadlineAt: f.clock.now + WATCH_MAX_DEFAULT_MS, body: "检查通过后交付" });
    expect(listPmWatches(f.db, f.lin.pmId).map((w) => w.id)).toEqual([watch.id]);
    expect(watchingPmWatches(f.db)).toEqual([expect.objectContaining({ id: watch.id, deadlineAt: watch.deadlineAt })]);
  });

  it("S5.4: settling the current run stores the outcome once, and the notice quotes the body and the output tail", () => {
    const watch = addPmWatch(f.db, owner(), { condition: { kind: "once", command: "wait-for-checks" }, body: "检查通过后交付" }, f.clock.now);
    const settled = settlePmWatch(f.db, watch.id, 0, { kind: "met", exitCode: 0, outputTail: "all checks passed" }, f.clock.now + 1);
    expect(settled).toMatchObject({ status: "met", exitCode: 0 });
    expect(pmWatchSettledText(settled!)).toContain("检查通过后交付");
    expect(pmWatchSettledText(settled!)).toContain("all checks passed");
    expect(settlePmWatch(f.db, watch.id, 0, { kind: "failed", exitCode: 1, outputTail: "late" }, f.clock.now + 2)).toBeNull();
  });

  it("S5.6: a watch closed before it settles never settles", () => {
    const watch = addPmWatch(f.db, owner(), { condition: { kind: "timer", afterMs: 30 * 60_000 }, body: "明早再看" }, f.clock.now);
    expect(closePmWatch(f.db, f.lin.pmId, watch.id, f.clock.now + 1)).toBe(true);
    expect(settlePmWatch(f.db, watch.id, 0, { kind: "met", exitCode: null, outputTail: "" }, f.clock.now + 2)).toBeNull();
    expect(watchingPmWatches(f.db)).toEqual([]);
  });

  it("S5 validation: a poll faster than the minimum interval is refused", () => {
    expect(() => addPmWatch(f.db, owner(), { condition: { kind: "poll", command: "x", everyMs: 1_000 }, body: "太快" }, f.clock.now)).toThrow(/间隔/u);
  });
});
