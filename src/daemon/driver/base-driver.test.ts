import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  CRASH_RECOVERY_NOTE,
  EMPTY_TOKEN_USAGE,
  RELAUNCH_NOTE,
  RESEND_NOTE,
  RESTART_RECOVERY_NOTE,
  backgroundTasksKilledNote,
  type AgentSessionPatch,
  type AgentSessionRow,
  type DriverEvent,
  type DriverSendInput,
  type DriverSendResult,
  type LaunchFiles,
  type SessionId,
} from "../../shared/index.ts";
import {
  BaseSessionDriver,
  NO_NOTES,
  USAGE_THROTTLE_MS,
  createBaseSessionState,
  entryParts,
  flatEntryText,
  launchChanged,
  takePendingBatch,
  within,
  type BaseBatch,
  type BaseDriverOptions,
  type BaseProc,
  type BaseSessionState,
  type PendingEntry,
} from "./base-driver.ts";

interface DummyBatch extends BaseBatch {
  text: string;
  prefixes: string[];
}

type DummyProc = BaseProc;
type DummyState = BaseSessionState<DummyProc, DummyBatch>;

function fakeChild(): ChildProcessWithoutNullStreams {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return Object.assign(emitter, {
    pid: 4242,
    stdin,
    stdout,
    stderr,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((sig?: NodeJS.Signals) => {
      (emitter as unknown as { signalCode: NodeJS.Signals | null }).signalCode = sig ?? "SIGTERM";
      stdout.end();
      stderr.end();
      emitter.emit("exit", null, sig ?? "SIGTERM");
      return true;
    }),
  }) as unknown as ChildProcessWithoutNullStreams;
}

class DummyDriver extends BaseSessionDriver<DummyProc, DummyBatch, DummyState> {
  constructor(options: BaseDriverOptions) {
    super("claude", options);
  }

  protected createSessionState(id: SessionId): DummyState {
    return createBaseSessionState(id);
  }

  protected takeBatch(st: DummyState): DummyBatch | null {
    const taken = this.takePendingEntryBatch(st);
    if (!taken) return null;
    if (taken.command) {
      return {
        messageIds: taken.messageIds,
        text: taken.body.text,
        prefixes: taken.body.prefixes,
        notes: NO_NOTES,
        delivered: false,
        processing: false,
        source: taken.source,
      };
    }
    const { notes, prefixes } = this.takeNotesPrefixes(st);
    return {
      messageIds: taken.messageIds,
      text: taken.body.text,
      prefixes: [...prefixes, ...taken.body.prefixes],
      notes,
      delivered: false,
      processing: false,
      source: taken.source,
    };
  }

  protected async startup(st: DummyState, batch: DummyBatch, existing: DummyProc | null): Promise<void> {
    const proc = existing ?? (await this.spawnIdleProcess(st, false));
    st.inFlight = [batch];
    this.markDelivered(st, batch);
    this.markProcessing(st, batch, Date.now());
    void proc;
  }

  protected async writeBatch(st: DummyState, _proc: DummyProc, batch: DummyBatch): Promise<void> {
    st.inFlight.push(batch);
    this.markDelivered(st, batch);
  }

  protected async spawnIdleProcess(st: DummyState, resume: boolean): Promise<DummyProc> {
    const row = this.store(st);
    const files: LaunchFiles = await this.opts.prepareLaunch(row);
    const child = fakeChild();
    const { baseProc, resolveExited } = this.createBaseProc(child, resume, row, files);
    baseProc.initSeen = true;
    baseProc.resolveReady({ kind: "ok" });
    this.attachChildProcess(st, baseProc, resolveExited);
    this.markHealthy(st.id);
    return baseProc;
  }

  protected resumeFor(st: DummyState): boolean {
    return this.store(st).hasCompletedTurn;
  }

  protected async identifyStaleProcess(): Promise<number | null> {
    return null;
  }

  protected onParsedLine(): void {}

  protected onProcessClose(
    st: DummyState,
    proc: DummyProc,
    code: number | null,
    signal: NodeJS.Signals | null,
    resolveExited: () => void,
  ): void {
    const at = this.beginProcessClose(st, proc);
    st.inFlight = [];
    st.selfTurn = false;
    this.emit(st.id, {
      type: "session.exited",
      reason: proc.closing ?? "crash",
      exitCode: code,
      signal,
      hadResult: true,
      messageIds: [],
      at,
    });
    this.resolveInterrupt(st);
    resolveExited();
    this.settled(st);
  }

  async send(sessionId: SessionId, input: DriverSendInput): Promise<DriverSendResult> {
    this.assertRunning();
    const st = this.state(sessionId);
    this.assertNotEnded(st);
    if (input.messageIds.length === 0) {
      this.invalidInput(st, "messageIds 是空的", input.messageIds);
      return { kind: "rejected" };
    }
    if (input. recovery) st.recoveryNote = true;
    st.pending.push({
      messageIds: input.messageIds,
      source: input.source,
      text: input.text,
      prefixes: input.prefixes ?? [],
      resend: input.resend ?? false,
    });
    await this.pump(st);
    return input.messageIds.every((id) => st.written.has(id)) ? { kind: "written" } : { kind: "queued" };
  }

  async interrupt(sessionId: SessionId): Promise<void> {
    const st = this.state(sessionId);
    this.dropPendingUsers(st);
    const proc = st.proc;
    if (!proc || proc.closing) return;
    const bgExit = this.stopIdleBackgroundTasks(st, proc);
    if (bgExit) {
      await bgExit;
      return;
    }
  }

  // 测试暴露包装
  exposeState(id: SessionId): DummyState {
    return this.state(id);
  }
  exposeTakeBatch(id: SessionId): DummyBatch | null {
    return this.takeBatch(this.state(id));
  }
  exposeDropBatch(id: SessionId, batch: DummyBatch): void {
    this.dropBatch(this.state(id), batch);
  }
  exposeReleaseUntaken(id: SessionId, batches: DummyBatch[], stopped: boolean, at: number): void {
    this.releaseUntaken(this.state(id), batches, stopped, at);
  }
  exposePushUsage(id: SessionId, input: number): void {
    this.pushUsage(this.state(id), { ...EMPTY_TOKEN_USAGE, input });
  }
  exposeFlushUsage(id: SessionId): void {
    this.flushUsage(this.state(id));
  }
  exposeBackgroundChanged(id: SessionId, tasks: unknown): void {
    const st = this.state(id);
    if (st.proc) this.onBackgroundTasksChanged(st, st.proc, tasks);
  }
  exposeReportError(id: SessionId, detail: string): void {
    this.internalError(id, detail);
  }
  exposeMarkHealthy(id: SessionId): void {
    this.markHealthy(id);
  }
  exposeEmit(id: SessionId, event: DriverEvent): void {
    this.emit(id, event);
  }
}

const dummyLaunchFiles = async (): Promise<LaunchFiles> => ({
  promptFile: "/tmp/prompt.md",
  settingsFile: "/tmp/settings.json",
  fingerprint: "fp",
  env: {},
});

function makeMemoryStore(initial?: Partial<AgentSessionRow>) {
  const rows = new Map<SessionId, AgentSessionRow>();
  const baseRow: AgentSessionRow = {
    id: 1,
    vendor: "claude",
    vendorSessionId: "sess-1",
    role: "worker",
    pmId: 1,
    workerId: 1,
    conversationId: 1,
    generation: 1,
    model: "claude-sonnet-4-6",
    effort: "medium",
    cwd: process.cwd(),
    addDirs: [],
    status: "idle",
    pid: null,
    hasCompletedTurn: false,
    personaRevision: 1,
    usage: { ...EMPTY_TOKEN_USAGE },
    rateLimit: null,
    lastEventAt: 1000,
    createdAt: 1000,
    updatedAt: 1000,
    ...initial,
  };
  rows.set(baseRow.id, baseRow);
  return {
    rows,
    store: {
      get: (id: SessionId) => rows.get(id) ?? null,
      update: (id: SessionId, patch: AgentSessionPatch) => {
        const cur = rows.get(id) ?? baseRow;
        const next = { ...cur, ...patch };
        rows.set(id, next);
        return next;
      },
      listWithProcess: () => [...rows.values()].filter((r) => r.pid !== null),
    },
  };
}

describe("base-driver 纯函数与队列合并", () => {
  it("entryParts 与 flatEntryText：正确处理 resend 说明与调用方前缀", () => {
    const normal: PendingEntry = { messageIds: [1], source: "user", text: "你好", prefixes: ["【标签】"], resend: false };
    expect(entryParts(normal)).toEqual({ prefixes: ["【标签】"], text: "你好" });
    expect(flatEntryText(normal)).toBe("【标签】\n你好");

    const resent: PendingEntry = { ...normal, resend: true };
    expect(entryParts(resent)).toEqual({ prefixes: [RESEND_NOTE, "【标签】"], text: "你好" });
    expect(flatEntryText(resent)).toBe(`${RESEND_NOTE}\n\n【标签】\n你好`);
  });

  it("takePendingBatch：多条用户消息合并、命令拆分、用户优先于系统消息", () => {
    const isCmd = (t: string) => t.startsWith("/");
    const pending: PendingEntry[] = [
      { messageIds: [1], source: "system", text: "系统通知", prefixes: [], resend: false },
      { messageIds: [2], source: "user", text: "第一句", prefixes: [], resend: false },
      { messageIds: [3], source: "user", text: "第二句", prefixes: [], resend: false },
      { messageIds: [4], source: "user", text: "/compact", prefixes: [], resend: false },
      { messageIds: [5], source: "user", text: "第三句", prefixes: [], resend: false },
    ];

    // 1. 先合并第一条命令前的用户消息（2, 3）
    const step1 = takePendingBatch(pending, isCmd)!;
    expect(step1.taken.messageIds).toEqual([2, 3]);
    expect(step1.taken.command).toBe(false);
    expect(step1.taken.source).toBe("user");
    expect(step1.taken.body.prefixes[0]).toContain("【用户连发了 2 条】");
    expect(step1.taken.body.text).toBe("2. 第二句");

    // 2. 接着单独取出命令（4）
    const step2 = takePendingBatch(step1.remaining, isCmd)!;
    expect(step2.taken.messageIds).toEqual([4]);
    expect(step2.taken.command).toBe(true);
    expect(step2.taken.body.text).toBe("/compact");

    // 3. 再取出命令后的用户消息（5）
    const step3 = takePendingBatch(step2.remaining, isCmd)!;
    expect(step3.taken.messageIds).toEqual([5]);
    expect(step3.taken.command).toBe(false);

    // 4. 用户消息取空后才取系统消息（1）
    const step4 = takePendingBatch(step3.remaining, isCmd)!;
    expect(step4.taken.messageIds).toEqual([1]);
    expect(step4.taken.source).toBe("system");
    expect(step4.remaining).toEqual([]);
  });

  it("launchChanged 与 within：检测启动快照差异及超时竞速", async () => {
    const snap = { fingerprint: "fp1", cwd: "/a", addDirs: ["/b"], model: "m1", effort: "high" };
    const { store } = makeMemoryStore({ cwd: "/a", addDirs: ["/b"], model: "m1", effort: "high" });
    const row = store.get(1)!;
    expect(launchChanged(snap, row, "fp1")).toBe(false);
    expect(launchChanged(snap, row, "fp2")).toBe(true);
    expect(launchChanged(snap, { ...row, model: "m2" }, "fp1")).toBe(true);
    expect(launchChanged(snap, { ...row, addDirs: ["/b", "/c"] }, "fp1")).toBe(true);

    expect(await within(Promise.resolve("ok"), 100)).toBe("done");
    expect(await within(new Promise((r) => setTimeout(r, 200)), 20)).toBe("timeout");
  });
});

describe("BaseSessionDriver 公共状态机", () => {
  it("首次轮次前缀组装与 dropBatch 回退：恢复、崩溃、重启、后台任务被杀、换代开场与性格设定说明", () => {
    let preambleRestored = false;
    let personaRestored = false;
    const { store } = makeMemoryStore({ personaRevision: 1 });
    const driver = new DummyDriver({
      store,
      prepareLaunch: dummyLaunchFiles,
      sessionPreamble: () => "【换代说明】",
      personaNote: () => ({ revision: 2, note: "【性格更新】" }),
    });

    const st = driver.exposeState(1);
    st.recoveryNote = true;
    st.crashNote = true;
    st.relaunchNote = true;
    st.killedNote = backgroundTasksKilledNote("relaunch", ["sleep 10"]);
    st.pending.push({ messageIds: [10], source: "user", text: "干活", prefixes: ["【用户前缀】"], resend: false });

    const batch = driver.exposeTakeBatch(1)!;
    expect(batch.prefixes).toEqual([
      "【换代说明】",
      RESTART_RECOVERY_NOTE,
      CRASH_RECOVERY_NOTE,
      RELAUNCH_NOTE,
      backgroundTasksKilledNote("relaunch", ["sleep 10"]),
      "【性格更新】",
      "【用户前缀】",
    ]);
    expect(st.recoveryNote).toBe(false);
    expect(st.crashNote).toBe(false);
    expect(st.relaunchNote).toBe(false);
    expect(st.killedNote).toBeNull();
    expect(st.preambleTaken).toBe(true);
    expect(st.personaSeen).toBe(2);

    // 钩住 restore 验证回退
    const origPreambleRestore = batch.notes.preamble!.restore;
    batch.notes.preamble!.restore = () => {
      preambleRestored = true;
      origPreambleRestore();
    };
    const origPersonaRestore = batch.notes.persona!.restore;
    batch.notes.persona!.restore = () => {
      personaRestored = true;
      origPersonaRestore();
    };

    driver.exposeDropBatch(1, batch);
    expect(st.recoveryNote).toBe(true);
    expect(st.crashNote).toBe(true);
    expect(st.relaunchNote).toBe(true);
    expect(st.killedNote).toBe(backgroundTasksKilledNote("relaunch", ["sleep 10"]));
    expect(preambleRestored).toBe(true);
    expect(personaRestored).toBe(true);
    expect(st.preambleTaken).toBe(false);
    expect(st.personaSeen).toBe(1);
  });

  it("停止与未取走批次结算：用户消息标 message.cancelled，系统消息标 message.requeued 并从 written 移除", () => {
    const { store } = makeMemoryStore();
    const events: DriverEvent[] = [];
    const driver = new DummyDriver({
      store,
      prepareLaunch: dummyLaunchFiles,
    });
    driver.onEvent((_id, ev) => events.push(ev));

    const st = driver.exposeState(1);
    st.written.add(101);
    st.written.add(102);

    const batches: DummyBatch[] = [
      { messageIds: [101], text: "u", prefixes: [], notes: NO_NOTES, delivered: true, processing: false, source: "user" },
      { messageIds: [102], text: "s", prefixes: [], notes: NO_NOTES, delivered: true, processing: false, source: "system" },
    ];

    driver.exposeReleaseUntaken(1, batches, true, 5000);
    expect(events).toEqual([
      { type: "message.cancelled", messageIds: [101], reason: "stop", at: 5000 },
      { type: "message.requeued", messageIds: [102], at: 5000 },
    ]);
    expect(st.written.has(101)).toBe(true);
    expect(st.written.has(102)).toBe(false);
  });

  it("用量实时节流上报：USAGE_THROTTLE_MS 内合并推送，flushUsage 立即落库", () => {
    vi.useFakeTimers();
    try {
      const { store, rows } = makeMemoryStore();
      const driver = new DummyDriver({
        store,
        prepareLaunch: dummyLaunchFiles,
      });

      driver.exposePushUsage(1, 100);
      expect(rows.get(1)!.usage.input).toBe(100);

      // 同一节流窗口内连续推送，不会立即写库，到点写入最新值
      driver.exposePushUsage(1, 200);
      driver.exposePushUsage(1, 350);
      expect(rows.get(1)!.usage.input).toBe(100);

      vi.advanceTimersByTime(USAGE_THROTTLE_MS);
      expect(rows.get(1)!.usage.input).toBe(350);
    } finally {
      vi.useRealTimers();
    }
  });

  it("后台任务跟踪与空闲关闭延长、停止时清理", async () => {
    const { store } = makeMemoryStore();
    const events: DriverEvent[] = [];
    const driver = new DummyDriver({
      store,
      idleCloseMs: 60,
      backgroundHoldMaxMs: 400,
      interruptGraceMs: 30,
      prepareLaunch: dummyLaunchFiles,
    });
    driver.onEvent((_id, ev) => events.push(ev));

    await driver.start(1);
    expect(driver.isRunning(1)).toBe(true);

    // 注入后台任务：发射 background.changed，且超过 idleCloseMs 仍不关闭
    driver.exposeBackgroundChanged(1, [{ task_id: "bg-1", description: "后台构建" }]);
    expect(events.filter((e) => e.type === "background.changed")).toMatchObject([{ type: "background.changed", count: 1 }]);

    await new Promise((r) => setTimeout(r, 120));
    expect(driver.isRunning(1)).toBe(true);

    // 空闲但只剩后台任务时调用 interrupt()：立即关闭进程并记录 stopped 说明
    await driver.interrupt(1);
    expect(driver.isRunning(1)).toBe(false);
    expect(driver.exposeState(1).killedNote).toBe(backgroundTasksKilledNote("stopped", ["后台构建"]));
  });

  it("驱动健康状态报错（reportError / markHealthy）与监听者异常隔离", () => {
    const { store } = makeMemoryStore();
    const events: DriverEvent[] = [];
    const driver = new DummyDriver({
      store,
      prepareLaunch: dummyLaunchFiles,
    });

    expect(driver.getHealth(1)).toEqual({ healthy: true, lastError: null });

    driver.exposeReportError(1, "boom");
    const healthAfterErr = driver.getHealth(1);
    expect(healthAfterErr.healthy).toBe(false);
    expect(healthAfterErr.lastError).toMatchObject({
      type: "driver.error",
      code: "internal_error",
      message: "internal_error: boom",
    });

    driver.exposeMarkHealthy(1);
    expect(driver.getHealth(1).healthy).toBe(true);
    expect(driver.getHealth(1).lastError).toMatchObject({ code: "internal_error" });

    // 监听者抛错时隔离为 internal_error 事件，不向外抛出
    driver.onEvent((_id, ev) => {
      events.push(ev);
      if (ev.type === "turn.started") throw new Error("listener crashed");
    });
    expect(() => driver.exposeEmit(1, { type: "turn.started", at: 123 })).not.toThrow();
    expect(events.map((e) => e.type)).toEqual(["turn.started", "driver.error"]);
  });
});
