import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORKER_LIST_IDLE_HINT_MIN_MS, WORKER_SHOW_BACKGROUND_TASKS_MAX } from "../../shared/limits.ts";
import { formatBackgroundTasksSummary, formatWorkerState, lastTurnOutcomesBySession, type WorkerStateInput } from "./worker-state.ts";
import { workerOpsFixture } from "./test-helpers.ts";

const baseline: WorkerStateInput = {
  status: "open", notStarted: false, live: { activity: "idle" }, lastTurnOutcome: null, lastEventAt: 0, now: WORKER_LIST_IDLE_HINT_MIN_MS,
};

describe("Worker lifecycle labels", () => {
  it.each([
    [{ status: "ended", live: { activity: "working" } }, "已收工"],
    [{ live: { activity: "preparing" } }, "准备中"],
    [{ notStarted: true }, "准备中"],
    [{ live: { activity: "background" } }, "在等后台命令"],
    [{ live: { activity: "working" } }, "在干活"],
    [{ live: { activity: "stopping" } }, "在干活"],
    [{}, "空闲，还没开始第一轮"],
    [{ lastTurnOutcome: "ok" }, "空闲，等验收"],
    [{ lastTurnOutcome: "failed" }, "空闲，上一轮出错了"],
    [{ lastTurnOutcome: "interrupted" }, "空闲，上一轮被打断了"],
  ] satisfies Array<[Partial<WorkerStateInput>, string]>)("formats %o", (patch, label) => {
    expect(formatWorkerState({ ...baseline, ...patch })).toBe(label);
  });

  it("labels elapsed idle time only at or above the threshold", () => {
    const options = { includeIdleDuration: true };
    expect(formatWorkerState(baseline, options)).toBe("空闲，还没开始第一轮（1m 前有动静）");
    expect(formatWorkerState({ ...baseline, now: baseline.now - 1 }, options)).toBe("空闲，还没开始第一轮");
    expect(formatWorkerState({ ...baseline, status: "ended" }, options)).toBe("已收工");
  });

  it("formats command and elapsed duration, keeps unnamed tasks visible, and caps overflow", () => {
    const tasks = Array.from({ length: WORKER_SHOW_BACKGROUND_TASKS_MAX + 2 }, (_, i) => ({ id: String(i), label: i === 0 ? "build app" : "", startedAt: 20_000 }));
    const lines = formatBackgroundTasksSummary(tasks, 90_000);
    expect(lines.slice(0, 2)).toEqual(["- build app · 已运行 1m 10s", "- （没有描述） · 已运行 1m 10s"]);
    expect(lines).toHaveLength(WORKER_SHOW_BACKGROUND_TASKS_MAX + 1);
    expect(lines.at(-1)).toBe("…另有 2 个");
  });
});

describe("Worker inventory from the ledger", () => {
  let f: ReturnType<typeof workerOpsFixture>;
  beforeEach(() => { f = workerOpsFixture(); });
  afterEach(() => f.close());

  const start = (title: string, vendor: "claude" | "codex" = "claude") =>
    f.hub("worker.start", { title, task: "Review work", vendor, noWorktree: true }).data.worker.id;

  it("takes the latest finished outcome from each session and omits unstarted sessions", () => {
    const a = start("A"), b = start("B"), c = start("C");
    f.begin(a); f.end(a);
    f.hub("worker.send", { workerId: a, text: "Continue" });
    f.begin(a); f.end(a, { ok: false, interrupted: true });
    f.begin(b); f.end(b);
    expect(lastTurnOutcomesBySession(f.db, [a, b, c].map(f.sessionOf))).toEqual(new Map([[f.sessionOf(a), "interrupted"], [f.sessionOf(b), "ok"]]));
  });

  it("lists distinct states with vendor and agent settings and filters before returning rows", async () => {
    const working = start("Working", "codex"), idle = start("Idle"), failed = start("Failed");
    const interrupted = start("Interrupted"), waiting = start("Waiting"), ended = start("Ended");
    const preparing = f.ledger.hubCall(f.pm.sessionId, "worker.start", { title: "Preparing", task: "Work in a linked tree" }, {
      workspace: { kind: "ok", isRepoWithCommit: true, hasUncommittedChanges: false },
    }).data.worker.id;
    expect(f.hub("worker.show", { workerId: preparing }).text).toContain("准备中");
    f.begin(working);
    f.begin(idle); f.end(idle);
    f.begin(failed); f.end(failed, { ok: false, error: { subtype: "error", message: "429 quota exceeded" } });
    f.begin(interrupted); f.end(interrupted, { ok: false, interrupted: true });
    f.begin(waiting);
    f.emit(waiting, { type: "background.changed", count: 1, at: f.now() });
    f.end(waiting);
    f.hub("worker.end", { workerId: ended });
    f.db.run("UPDATE agent_sessions SET last_event_at = ? WHERE id = ?", f.now(), f.sessionOf(idle));
    f.advance(75_000);
    const text = f.hub("worker.list", {}).text;
    expect(text).toContain(`#${working} Working · 在干活`);
    expect(text).toContain(`#${idle} Idle · 空闲，等验收（1m 15s 前有动静）`);
    expect(text).toContain(`#${failed} Failed · 空闲，上一轮出错了`);
    expect(text).toContain(`#${interrupted} Interrupted · 空闲，上一轮被打断了`);
    expect(text).toContain(`#${waiting} Waiting · 在等后台命令`);
    expect(text).toContain(`#${ended} Ended · 已收工`);
    expect(text).toContain(`#${preparing} Preparing · 准备中`);
    const api = f.api();
    const filtered = await api("worker.list", { vendor: "codex" });
    expect(filtered.json()).toMatchObject({ ok: true, text: expect.stringMatching(/厂商 .*Codex.*模型 .*思考程度/), data: { workers: [expect.objectContaining({ id: working })] } });
    expect((await api("worker.list", { vendor: "unknown-provider" })).statusCode).toBe(400);
  });

  it("shows named running commands while waiting and clears them on removal and process exit", () => {
    const id = start("Background");
    f.begin(id);
    f.emit(id, {
      type: "background.changed", count: 2, at: f.now(),
      tasks: [{ id: "test", label: "test suite", startedAt: f.now() }, { id: "build", label: "build tools", startedAt: f.now() - 5_000 }],
    });
    f.end(id);
    f.advance(70_000);
    const show = () => f.hub("worker.show", { workerId: id }).text;
    expect(show()).toContain("在等后台命令");
    expect(show()).toContain("test suite · 已运行 1m 10s");
    expect(show()).toContain("build tools · 已运行 1m 15s");
    f.emit(id, { type: "background.changed", count: 1, tasks: [{ id: "build", label: "build tools", startedAt: f.now() - 75_000 }], at: f.now() });
    expect(show()).not.toContain("test suite");
    expect(show()).toContain("build tools");
    f.emit(id, { type: "session.exited", reason: "idle", exitCode: 0, signal: null, hadResult: true, messageIds: [], at: f.now() });
    expect(show()).not.toContain("build tools");
  });
});
