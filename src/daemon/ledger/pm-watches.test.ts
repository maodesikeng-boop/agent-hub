import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { systemEventOf, type Message } from "../../shared/domain.ts";
import type { HubArgs } from "../../shared/hub.ts";
import { WATCH_EVERY_MIN_MS, WATCH_MAX_DEFAULT_MS, WATCHES_OPEN_PER_PM_MAX, WATCHES_RETAIN_MS } from "../../shared/limits.ts";
import { isGraphReadyNotice } from "../../shared/pm-notice.ts";
import { pmWatchSettledText } from "../../shared/pm-watch.ts";
import { pmAgendaOf } from "./pm-agenda.ts";
import { createPmFrictionFixture, reportBlock, type PmFrictionFixture } from "./pm-friction-fixture.ts";
import { addPmWatch, closePmWatch, getPmWatch, listPmWatches, settlePmWatch, watchingPmWatches } from "./pm-watches.ts";

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

const MINUTE = 60_000;

async function readyGraph(f: PmFrictionFixture, title: string): Promise<number> {
  const graph = f.createGraph({ title, steps: [{ key: "impl", title: "实现", brief: "实现" }] }).data.graph;
  const wid = f.showGraph(graph.id).nodes[0]!.activeWorkerId!;
  await f.startWorktree(wid);
  f.workerTurn(wid, reportBlock({ status: "做完了", summary: "实现好了" }));
  return graph.id;
}

const watchNotices = (f: PmFrictionFixture): Message[] =>
  f.pmSystemMessages().filter((m) => {
    const event = systemEventOf(m);
    return event?.event === "pm.wakeup" && (event.subject as { kind?: string } | undefined)?.kind === "watch.settled";
  });

describe("S5 through hub watch and the runner side of the ledger", () => {
  let f: PmFrictionFixture;

  beforeEach(() => {
    f = createPmFrictionFixture();
  });

  afterEach(() => {
    f.close();
  });

  const add = (args: HubArgs<"watch.add">) => f.ledger.hubCall(f.lin.sessionId, "watch.add", args);

  it("S5.1: watch add names the watch, links it to the graph, and the graph line shows it instead of waiting for the PM", async () => {
    const graphId = await readyGraph(f, "检查后交付");
    const result = add({ until: "check-ready", everyMs: 15_000, graphId, body: "检查通过后交付" });
    const watch = result.data.watch;
    expect(result.text).toContain(`已开始盯 #${watch.id}`);
    expect(result.text).toContain(`hub watch close ${watch.id}`);
    expect(watch).toMatchObject({ status: "watching", runs: 0, graphId, deadlineAt: f.clock.now + WATCH_MAX_DEFAULT_MS });

    const agenda = pmAgendaOf(f.db, f.lin.pmId, f.clock.now);
    expect(agenda.graphs[0]).toMatchObject({ graphId, watchId: watch.id, needsPm: false });
    expect(agenda.outside).toEqual([expect.objectContaining({ kind: "watch", watchId: watch.id, status: "watching", graphId })]);
    const status = f.ledger.hubCall(f.lin.sessionId, "status", {}).text;
    expect(status).toContain(`在盯 #${watch.id}`);

    const shown = f.ledger.hubCall(f.lin.sessionId, "graph.show", { graphId });
    expect(shown.text).toContain(`[在等] 交付：在等 #${watch.id}「检查通过后交付」`);
    expect(f.showGraph(graphId).deliveryWatch).toEqual({ watchId: watch.id, body: "检查通过后交付" });

    const list = f.ledger.hubCall(f.lin.sessionId, "watch.list", {});
    expect(list.data.watches.map((w) => w.id)).toEqual([watch.id]);
    expect(list.text).toContain("检查通过后交付");
  });

  it("S5.1: the delivery note tells the PM how to hand an outside wait to the daemon", async () => {
    await readyGraph(f, "全勾了");
    const note = f.pmSystemMessages().find(isGraphReadyNotice)!;
    expect(note.text).toContain("hub watch add");
  });

  it("S5.2: a vendor switch keeps the watch, and its notice reaches the new session", () => {
    const watch = add({ until: "check-ready", everyMs: 15_000, body: "检查通过后交付" }).data.watch;
    f.ledger.editPersona(f.lin.pmId, { vendor: "codex", model: "gpt-6-luna" }, { kind: "user" });
    const sessions = f.db.all<{ id: number }>("SELECT id FROM agent_sessions WHERE conversation_id = ? ORDER BY generation", f.lin.conversationId);
    expect(sessions).toHaveLength(2);
    expect(f.ledger.watches.watching().map((w) => w.id)).toEqual([watch.id]);

    const run = f.ledger.watches.beginRun(watch.id)!;
    f.ledger.watches.settle(watch.id, run.run, { kind: "met", exitCode: 0, outputTail: "green" });
    const notices = watchNotices(f);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.sessionId).toBe(sessions[1]!.id);
  });

  it("S5.3: after a restart an interrupted run is due again and keeps its original deadline", () => {
    const watch = add({ until: "check-ready", everyMs: 15_000, body: "检查通过后交付" }).data.watch;
    const begun = f.ledger.watches.beginRun(watch.id)!;
    expect(begun).toMatchObject({ run: 1, cwd: f.repoDir });
    expect(f.ledger.watches.watching()[0]!.nextRunAt).toBeNull();

    f.clock.now += 5 * MINUTE;
    expect(f.ledger.watches.recover()).toBe(1);
    expect(f.ledger.watches.watching()).toEqual([
      expect.objectContaining({ id: watch.id, nextRunAt: f.clock.now, deadlineAt: watch.deadlineAt, runs: 1 }),
    ]);
    expect(f.ledger.watches.beginRun(watch.id)).toMatchObject({ run: 2 });
  });

  it("S5.4: settling the current run stores the outcome once, and one notice quotes the body and the output tail", () => {
    const watch = add({ until: "wait-for-checks", body: "检查通过后交付" }).data.watch;
    const { run } = f.ledger.watches.beginRun(watch.id)!;
    const settled = f.ledger.watches.settle(watch.id, run, { kind: "met", exitCode: 0, outputTail: "all checks passed" });
    expect(settled).toMatchObject({ status: "met", exitCode: 0 });
    expect(f.ledger.watches.settle(watch.id, run, { kind: "failed", exitCode: 1, outputTail: "late" })).toBeNull();

    const notices = watchNotices(f);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain("检查通过后交付");
    expect(notices[0]!.text).toContain("all checks passed");
    expect(f.ledger.isSystemMessageCurrent!(notices[0]!.id)).toBe(true);
    expect(pmAgendaOf(f.db, f.lin.pmId, f.clock.now).outside).toEqual([]);
  });

  it("S5.4: a result from an older run never settles a newer one", () => {
    const watch = add({ until: "check-ready", everyMs: 15_000, body: "检查通过后交付" }).data.watch;
    const first = f.ledger.watches.beginRun(watch.id)!;
    f.ledger.watches.deferRun(watch.id, first.run, f.clock.now + 15_000, { exitCode: 1, outputTail: "pending" });
    const second = f.ledger.watches.beginRun(watch.id)!;
    expect(f.ledger.watches.settle(watch.id, first.run, { kind: "met", exitCode: 0, outputTail: "stale" })).toBeNull();
    expect(f.ledger.watches.settle(watch.id, second.run, { kind: "met", exitCode: 0, outputTail: "fresh" })).toMatchObject({ outputTail: "fresh" });
  });

  it("S5.5: a failed run-once watch and an expired watch each send their own notice", () => {
    const once = add({ until: "wait-for-checks", body: "失败就看日志" }).data.watch;
    const { run } = f.ledger.watches.beginRun(once.id)!;
    f.ledger.watches.settle(once.id, run, { kind: "failed", exitCode: 2, outputTail: "check failed" });
    const poll = add({ until: "check-ready", everyMs: 15_000, maxMs: 10 * MINUTE, body: "超时就提醒用户" }).data.watch;
    f.ledger.watches.settle(poll.id, 0, { kind: "expired", exitCode: null, outputTail: "" });

    const texts = watchNotices(f).map((m) => m.text);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("失败");
    expect(texts[0]).toContain("失败就看日志");
    expect(texts[1]).toContain("超时");
    expect(texts[1]).toContain("超时就提醒用户");
  });

  it("S5.6: closing the watch or finishing its graph before the notice is written drops it", async () => {
    const graphId = await readyGraph(f, "检查后交付");
    const closed = add({ until: "check-ready", everyMs: 15_000, body: "关掉的" }).data.watch;
    const linked = add({ until: "check-ready", everyMs: 15_000, graphId, body: "图结束了" }).data.watch;

    expect(f.ledger.hubCall(f.lin.sessionId, "watch.close", { watchId: closed.id }).data.watch).toMatchObject({ status: "closed" });
    expect(f.ledger.watches.settle(closed.id, 0, { kind: "met", exitCode: 0, outputTail: "" })).toBeNull();

    f.ledger.watches.settle(linked.id, 0, { kind: "met", exitCode: 0, outputTail: "" });
    const notice = watchNotices(f)[0]!;
    expect(f.ledger.isSystemMessageCurrent!(notice.id)).toBe(true);
    f.ledger.hubCall(f.lin.sessionId, "graph.cancel", { graphId, reason: "不做了" });
    expect(f.ledger.isSystemMessageCurrent!(notice.id)).toBe(false);
  });

  it("S5.6: finishing or cancelling the linked graph, or ending the linked Worker, closes its watches in the same write", async () => {
    const finished = await readyGraph(f, "结束的图");
    const poll = add({ until: "check-ready", everyMs: 15_000, graphId: finished, body: "图结束后不该再轮询" }).data.watch;
    const timer = add({ afterMs: 3_000, graphId: finished, body: "图结束后不该触发的定时" }).data.watch;
    const cancelled = f.createGraph({ title: "取消的图", steps: [{ key: "a", title: "甲", brief: "甲" }] }).data.graph.id;
    const onCancelled = add({ until: "check-ready", everyMs: 15_000, graphId: cancelled, body: "图取消后不该再轮询" }).data.watch;
    const solo = f.ledger.hubCall(f.lin.sessionId, "worker.start", { title: "等发布", task: "等发布", noWorktree: true }).data.worker;
    const onWorker = add({ until: "check-release", everyMs: 15_000, workerId: solo.id, body: "Worker 收工后不该再轮询" }).data.watch;
    const other = add({ until: "check-ready", everyMs: 15_000, body: "不挂图的" }).data.watch;
    f.ledger.watches.beginRun(poll.id);

    f.ledger.hubCall(f.lin.sessionId, "graph.finish", { graphId: finished, summary: "交付了", unmergedOk: true });
    f.ledger.hubCall(f.lin.sessionId, "graph.cancel", { graphId: cancelled, reason: "不做了" });
    f.ledger.hubCall(f.lin.sessionId, "worker.end", { workerId: solo.id });

    for (const watch of [poll, timer, onCancelled, onWorker]) {
      expect(getPmWatch(f.db, watch.id)).toMatchObject({ status: "closed", nextRunAt: null, closedAt: expect.any(Number) });
    }
    expect(f.ledger.watches.watching().map((w) => w.id)).toEqual([other.id]);
    expect(f.ledger.hubCall(f.lin.sessionId, "watch.list", {}).data.watches.map((w) => w.id)).toEqual([other.id]);
    f.clock.now += MINUTE;
    expect(f.ledger.watches.settle(timer.id, 0, { kind: "met", exitCode: null, outputTail: "" })).toBeNull();
    expect(watchNotices(f)).toEqual([]);
  });

  it("S5.7: a timer watch runs nothing and is due once its time passes", () => {
    const watch = add({ afterMs: 30 * MINUTE, body: "明早再看" }).data.watch;
    expect(watch).toMatchObject({ condition: { kind: "timer", afterMs: 30 * MINUTE }, deadlineAt: f.clock.now + 30 * MINUTE, nextRunAt: null });
    expect(f.ledger.watches.beginRun(watch.id)).toBeNull();
  });

  it("S5.8: without an OS sandbox --until is refused and --after still works", () => {
    f.ledger.close();
    f.db.close();
    f = createPmFrictionFixture({ osSandboxed: false });
    expect(() => add({ until: "check-ready", body: "检查通过后交付" })).toThrow(/沙箱/u);
    expect(add({ afterMs: 30 * MINUTE, body: "明早再看" }).data.watch.status).toBe("watching");
  });

  it("S5.8: where the read-only sandbox relies on a vendor tool layer (Windows without MXC), --until is refused and --after still works", () => {
    f.ledger.close();
    f.db.close();
    f = createPmFrictionFixture({ readonlyKernelSandboxed: false });
    expect(() => add({ until: "check-ready", body: "检查通过后交付" })).toThrow(/沙箱/u);
    expect(add({ afterMs: 30 * MINUTE, body: "明早再看" }).data.watch.status).toBe("watching");
    expect(f.ledger.hubCall(f.lin.sessionId, "worker.start", { title: "照常派", task: "照常派", noWorktree: true }).data.worker.status).toBe("open");
  });

  it("S5 validation: refused inputs name the problem", async () => {
    expect(() => add({ until: "x", everyMs: 1_000, body: "太快" })).toThrow(/间隔/u);
    expect(() => add({ until: "x", afterMs: MINUTE, body: "两个都写" })).toThrow(/--until.*--after|--after.*--until/u);
    expect(() => add({ until: "x", body: "  " })).toThrow(/正文/u);
    expect(() => add({ until: "x", body: "图不存在", graphId: 9_999 })).toThrow(/9999/u);
    for (let i = 0; i < WATCHES_OPEN_PER_PM_MAX; i++) add({ afterMs: MINUTE, body: `第 ${i} 个` });
    expect(() => add({ afterMs: MINUTE, body: "多了" })).toThrow(new RegExp(`${WATCHES_OPEN_PER_PM_MAX}`, "u"));
    expect(WATCH_EVERY_MIN_MS).toBe(15_000);
  });

  it("retention: settled and closed rows past the age or count cap are deleted, watching rows are kept", () => {
    const old = add({ afterMs: MINUTE, body: "旧的" }).data.watch;
    f.ledger.watches.settle(old.id, 0, { kind: "met", exitCode: null, outputTail: "" });
    const open = add({ afterMs: 30 * MINUTE, body: "还在盯" }).data.watch;
    f.clock.now += WATCHES_RETAIN_MS + MINUTE;
    expect(f.ledger.watches.prune()).toBe(1);
    expect(f.db.all<{ id: number }>("SELECT id FROM pm_watches").map((r) => r.id)).toEqual([open.id]);
  });
});
