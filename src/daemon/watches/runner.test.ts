import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { systemEventOf, type Message } from "../../shared/domain.ts";
import type { HubArgs } from "../../shared/hub.ts";
import { WATCHES_RUNNING_MAX } from "../../shared/limits.ts";
import { createPmFrictionFixture, type PmFrictionFixture } from "../ledger/pm-friction-fixture.ts";
import { createWatchRunner, type WatchRunJob, type WatchRunResult, type WatchRunner } from "./runner.ts";

const MINUTE = 60_000;

interface PendingRun {
  job: WatchRunJob;
  finish: (result: WatchRunResult) => void;
}

/** Each run waits until the test finishes it, or resolves as stopped when the runner aborts it. */
function scriptedRuns() {
  const runs: PendingRun[] = [];
  const run = (job: WatchRunJob): Promise<WatchRunResult> =>
    new Promise((resolve) => {
      runs.push({ job, finish: resolve });
      job.signal.addEventListener("abort", () => resolve({ kind: "stopped", outputTail: "" }), { once: true });
    });
  return { runs, run };
}

const watchNotices = (f: PmFrictionFixture): Message[] =>
  f.pmSystemMessages().filter((m) => {
    const event = systemEventOf(m);
    return event?.event === "pm.wakeup" && (event.subject as { kind?: string } | undefined)?.kind === "watch.settled";
  });

describe("S5: the watch runner", () => {
  let f: PmFrictionFixture;
  let runner: WatchRunner;
  let script: ReturnType<typeof scriptedRuns>;

  beforeEach(() => {
    f = createPmFrictionFixture();
    script = scriptedRuns();
    runner = createWatchRunner({ ledger: f.ledger, run: script.run, tickMs: 0 });
    runner.start();
  });

  afterEach(async () => {
    await runner.close();
    f.close();
  });

  const add = (args: HubArgs<"watch.add">) => f.ledger.hubCall(f.lin.sessionId, "watch.add", args).data.watch;

  it("S5.1 and S5.4: a poll watch runs in the project folder until the command exits 0 on its third run, then wakes the PM once", async () => {
    const watch = add({ until: "check-ready", everyMs: 15_000, body: "检查通过后交付" });
    for (const attempt of [1, 2]) {
      runner.tick();
      expect(script.runs).toHaveLength(attempt);
      expect(script.runs.at(-1)!.job).toMatchObject({ watchId: watch.id, run: attempt, command: "check-ready", cwd: f.repoDir });
      script.runs.at(-1)!.finish({ kind: "exited", exitCode: 1, outputTail: "pending" });
      await runner.idle();
      runner.tick();
      expect(script.runs).toHaveLength(attempt);
      f.clock.now += 15_000;
    }
    expect(watchNotices(f)).toEqual([]);
    runner.tick();
    expect(script.runs).toHaveLength(3);
    script.runs[2]!.finish({ kind: "exited", exitCode: 0, outputTail: "all green" });
    await runner.idle();

    const notices = watchNotices(f);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain("检查通过后交付");
    expect(notices[0]!.text).toContain("all green");
    runner.tick();
    expect(script.runs).toHaveLength(3);
  });

  it("S5.3: a restart mid-run starts the run again with the original deadline", async () => {
    const watch = add({ until: "check-ready", everyMs: 15_000, body: "检查通过后交付" });
    runner.tick();
    expect(script.runs).toHaveLength(1);
    await runner.close();
    expect(watchNotices(f)).toEqual([]);

    f.clock.now += 5 * MINUTE;
    runner = createWatchRunner({ ledger: f.ledger, run: script.run, tickMs: 0 });
    runner.start();
    expect(script.runs).toHaveLength(2);
    expect(script.runs[1]!.job.run).toBe(2);
    expect(f.ledger.watches.watching()[0]!.deadlineAt).toBe(watch.deadlineAt);
  });

  it("S5.5: a run-once failure notifies at once, and a poll past --max is stopped and expires", async () => {
    add({ until: "wait-for-checks", body: "失败就看日志" });
    runner.tick();
    script.runs[0]!.finish({ kind: "exited", exitCode: 3, outputTail: "check failed" });
    await runner.idle();
    expect(watchNotices(f).map((m) => m.text)).toEqual([expect.stringContaining("check failed")]);

    add({ until: "check-ready", everyMs: 15_000, maxMs: 10 * MINUTE, body: "超时就提醒用户" });
    runner.tick();
    expect(script.runs).toHaveLength(2);
    expect(script.runs[1]!.job.timeoutMs).toBeLessThanOrEqual(10 * MINUTE);
    f.clock.now += 10 * MINUTE;
    runner.tick();
    await runner.idle();
    const texts = watchNotices(f).map((m) => m.text);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain("超时就提醒用户");
  });

  it("S5.6: closing a watch mid-run stops the command and sends nothing", async () => {
    const watch = add({ until: "check-ready", everyMs: 15_000, body: "检查通过后交付" });
    runner.tick();
    f.ledger.hubCall(f.lin.sessionId, "watch.close", { watchId: watch.id });
    runner.tick();
    await runner.idle();
    expect(script.runs[0]!.job.signal.aborted).toBe(true);
    expect(watchNotices(f)).toEqual([]);
  });

  it("S5.7: --after 30m settles after 30 minutes without running anything", async () => {
    add({ afterMs: 30 * MINUTE, body: "明早再看" });
    runner.tick();
    expect(watchNotices(f)).toEqual([]);
    f.clock.now += 30 * MINUTE;
    runner.tick();
    await runner.idle();
    expect(script.runs).toEqual([]);
    expect(watchNotices(f).map((m) => m.text)).toEqual([expect.stringContaining("明早再看")]);
  });

  it("S8.2: a watch whose project folder was deleted fails with a readable reason", async () => {
    add({ until: "check-ready", body: "检查通过后交付" });
    rmSync(f.repoDir, { recursive: true, force: true });
    runner.tick();
    await runner.idle();
    expect(script.runs).toEqual([]);
    expect(watchNotices(f).map((m) => m.text)).toEqual([expect.stringContaining(f.repoDir)]);
  });

  it("bounds: at most WATCHES_RUNNING_MAX commands run at once", async () => {
    for (let i = 0; i <= WATCHES_RUNNING_MAX; i++) add({ until: `check-${i}`, everyMs: 15_000, body: `第 ${i} 个` });
    runner.tick();
    expect(script.runs).toHaveLength(WATCHES_RUNNING_MAX);
    script.runs[0]!.finish({ kind: "exited", exitCode: 1, outputTail: "" });
    await new Promise((resolve) => setImmediate(resolve));
    runner.tick();
    expect(script.runs).toHaveLength(WATCHES_RUNNING_MAX + 1);
  });

  it("shutdown: a run that ends after close never touches the ledger", async () => {
    add({ until: "check-ready", body: "检查通过后交付" });
    runner.tick();
    const pending = script.runs[0]!;
    await runner.close();
    pending.finish({ kind: "exited", exitCode: 0, outputTail: "late" });
    await Promise.resolve();
    expect(watchNotices(f)).toEqual([]);
    expect(f.ledger.watches.watching()).toHaveLength(1);
  });
});
