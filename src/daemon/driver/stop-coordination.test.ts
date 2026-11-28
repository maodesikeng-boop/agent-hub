import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_VENDORS,
  EMPTY_TOKEN_USAGE,
  INTERRUPT_POST_ACK_GRACE_MS,
  type AgentSessionRow,
  type ConversationId,
  type DriverEvent,
  type LaunchFiles,
  type SessionId,
} from "../../shared/index.ts";
import { createAcpDriver, type AcpDriverConfig } from "../../vendors/_common/acp/index.ts";
import type { FakeAcpScript } from "../../vendors/_common/acp/fixtures/fake-acp-agent.ts";
import { ACP_TURN_SCOPED_SESSION_UPDATES, shouldProcessTurnSessionUpdate } from "../../vendors/_common/acp/turn-stream.ts";
import {
  armPostAckInterruptEscalation,
  consumePreWriteStop,
  coordinateSessionInterrupt,
  type StoppableSessionState,
} from "./stop-coordination.ts";
import { NO_NOTES, type BaseBatch, type BaseProc } from "./driver-helpers.ts";
import { makeHarness, MemorySessionStore, slowTurn, type Harness } from "./test-helpers.ts";

const FAKE_ACP_AGENT = fileURLToPath(new URL("../../vendors/_common/acp/fixtures/fake-acp-agent.ts", import.meta.url));

function makeAcpSessionRow(id: SessionId, cwd: string): AgentSessionRow {
  const now = Date.now();
  return {
    id,
    conversationId: id as unknown as ConversationId,
    role: "pm",
    pmId: null,
    workerId: null,
    vendor: "agy",
    vendorSessionId: "",
    cwd,
    addDirs: [],
    generation: 1,
    model: null,
    effort: null,
    pid: null,
    status: "idle",
    hasCompletedTurn: false,
    lastEventAt: null,
    rateLimit: null,
    usage: { ...EMPTY_TOKEN_USAGE },
    createdAt: now,
    updatedAt: now,
  };
}

function makeStubProc(overrides: Partial<BaseProc<unknown>> = {}): {
  proc: BaseProc<unknown>;
  resolveExited: () => void;
} {
  let resolveExited!: () => void;
  let resolveReady!: (o: unknown) => void;
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  const ready = new Promise<unknown>((resolve) => {
    resolveReady = resolve;
  });
  const proc: BaseProc<unknown> = {
    child: {} as BaseProc<unknown>["child"],
    resume: false,
    launched: { fingerprint: "fp", cwd: "/tmp", addDirs: [], model: null, effort: null },
    personaLaunched: null,
    backgroundHoldMaxMs: 60_000,
    initSeen: true,
    stderr: "",
    closing: null,
    startTimedOut: false,
    killTimer: null,
    ready,
    resolveReady,
    exited,
    ...overrides,
  };
  return { proc, resolveExited };
}

function makeStubBatch(id: number): BaseBatch {
  return {
    messageIds: [id],
    notes: NO_NOTES,
    delivered: false,
    processing: false,
    source: "user",
  };
}

describe("stop-coordination contracts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("latches stopRequested and awaits startup when interrupt runs before proc attaches", async () => {
    let finishStartup!: () => void;
    const starting = new Promise<void>((resolve) => {
      finishStartup = resolve;
    });
    const st: StoppableSessionState<BaseProc<unknown>, BaseBatch> = {
      proc: null,
      inFlight: [makeStubBatch(1)],
      stopRequested: false,
      turnInterrupted: false,
      starting,
      interruptTimer: null,
      interruptWaiters: [],
    };
    const dropPendingUsers = vi.fn();
    const sendInterrupt = vi.fn();

    const outcome: { settled: boolean; err: Error | null } = { settled: false, err: null };
    const interrupting = coordinateSessionInterrupt(st, {
      dropPendingUsers,
      stopIdleBackgroundTasks: () => null,
      isBusy: (s) => s.inFlight.length > 0,
      sendInterrupt,
    }).then(
      () => {
        outcome.settled = true;
      },
      (e: unknown) => {
        outcome.err = e instanceof Error ? e : new Error(String(e));
      },
    );

    await Promise.resolve();
    expect(outcome.err).toBeNull();
    expect(dropPendingUsers).toHaveBeenCalledWith(st);
    expect(st.stopRequested).toBe(true);
    expect(sendInterrupt).not.toHaveBeenCalled();
    expect(outcome.settled).toBe(false);

    finishStartup();
    await interrupting;
    expect(outcome.err).toBeNull();
    expect(outcome.settled).toBe(true);
  });

  it("awaits proc.exited instead of returning early when proc is already closing", async () => {
    const { proc, resolveExited } = makeStubProc({ closing: "interrupt" });
    const st: StoppableSessionState<BaseProc<unknown>, BaseBatch> = {
      proc,
      inFlight: [],
      stopRequested: true,
      turnInterrupted: true,
      starting: null,
      interruptTimer: null,
      interruptWaiters: [],
    };

    const outcome: { settled: boolean; err: Error | null } = { settled: false, err: null };
    const interrupting = coordinateSessionInterrupt(st, {
      dropPendingUsers: vi.fn(),
      stopIdleBackgroundTasks: () => null,
      isBusy: () => false,
      sendInterrupt: vi.fn(),
    }).then(
      () => {
        outcome.settled = true;
      },
      (e: unknown) => {
        outcome.err = e instanceof Error ? e : new Error(String(e));
      },
    );

    await Promise.resolve();
    expect(outcome.err).toBeNull();
    expect(outcome.settled).toBe(false);
    resolveExited();
    await interrupting;
    expect(outcome.err).toBeNull();
    expect(outcome.settled).toBe(true);
  });

  it("consumes a latched pre-write stop before writing a batch", () => {
    const batch = makeStubBatch(10);
    const st = { stopRequested: true, turnInterrupted: true, inFlight: [batch] };
    expect(consumePreWriteStop(st, batch)).toBe(true);
    expect(st.stopRequested).toBe(false);
    expect(st.turnInterrupted).toBe(false);
  });

  it("arms bounded post-ack escalation and invokes onEscalate only when proc is still live", () => {
    vi.useFakeTimers();
    const { proc } = makeStubProc();
    const st: { proc: BaseProc<unknown> | null; interruptTimer: NodeJS.Timeout | null } = {
      proc,
      interruptTimer: null,
    };
    const onEscalate = vi.fn();

    armPostAckInterruptEscalation(st, proc, INTERRUPT_POST_ACK_GRACE_MS, onEscalate);
    vi.advanceTimersByTime(INTERRUPT_POST_ACK_GRACE_MS - 1);
    expect(onEscalate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onEscalate).toHaveBeenCalledTimes(1);
    expect(onEscalate).toHaveBeenCalledWith(st, proc);
  });
});

describe("ACP post-turn notification gating (S1, S2, S8)", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  it("drops turn-scoped session/update kinds when initSeen is true and no turn is busy, while allowing metadata updates", () => {
    for (const kind of ACP_TURN_SCOPED_SESSION_UPDATES) {
      expect(
        shouldProcessTurnSessionUpdate({ sessionUpdate: kind, busy: false, initSeen: true, swallowingReplay: false }),
      ).toBe(false);
      expect(
        shouldProcessTurnSessionUpdate({ sessionUpdate: kind, busy: true, initSeen: true, swallowingReplay: false }),
      ).toBe(true);
    }
    expect(
      shouldProcessTurnSessionUpdate({
        sessionUpdate: "available_commands_update",
        busy: false,
        initSeen: true,
        swallowingReplay: false,
      }),
    ).toBe(true);
    expect(
      shouldProcessTurnSessionUpdate({
        sessionUpdate: "config_option_update",
        busy: false,
        initSeen: true,
        swallowingReplay: false,
      }),
    ).toBe(true);
    expect(
      shouldProcessTurnSessionUpdate({
        sessionUpdate: "usage_update",
        busy: false,
        initSeen: true,
        swallowingReplay: false,
      }),
    ).toBe(true);
  });

  it("ignores a late failed tool_call_update emitted after session/prompt resolves on cancel and keeps the resident process ready for turn 2", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "bellwood-acp-stop-")));
    const cwd = join(dir, "workspace");
    const logDir = join(dir, "logs");
    const stateDir = join(dir, "state");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(logDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });

    const scriptFile = join(logDir, "script.json");
    const logFile = join(logDir, "fake-acp.jsonl");
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, "Follow rules.", "utf8");
    const script: FakeAcpScript = {
      turns: [
        {
          toolCalls: [
            {
              toolCallId: "call_bg_331",
              name: "run_command",
              title: "sleep 60",
              kind: "execute",
              rawInput: { CommandLine: "sleep 60", WaitMsBeforeAsync: 500 },
            },
          ],
          textChunks: ["Started background command."],
          waitForCancel: true,
          postCancelToolUpdate: {
            toolCallId: "call_bg_331",
            name: "run_command",
            title: "sleep 60",
            kind: "execute",
            rawInput: { CommandLine: "sleep 60", WaitMsBeforeAsync: 500 },
            rawOutput: { output: "" },
          },
        },
        {
          textChunks: ["Turn 2 OK"],
          usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedReadTokens: 15_874, cachedWriteTokens: 0 },
        },
      ],
    };
    writeFileSync(scriptFile, JSON.stringify(script), "utf8");

    const store = new MemorySessionStore();
    const config: AcpDriverConfig = {
      vendor: "agy",
      launchArgs: [FAKE_ACP_AGENT],
      authenticate: { enabled: false },
    };
    const driver = createAcpDriver(config, {
      executablePath: process.execPath,
      store,
      env: {
        FAKE_ACP_SCRIPT: scriptFile,
        FAKE_ACP_LOG: logFile,
        FAKE_ACP_STATE: stateDir,
      },
      prepareLaunch: async (row: AgentSessionRow): Promise<LaunchFiles> => ({
        promptFile,
        env: {},
        fingerprint: `fp-${row.id}`,
      }),
      interruptGraceMs: 2_000,
      idleCloseMs: 60_000,
    });

    const events: DriverEvent[] = [];
    const waiters: Array<(e: DriverEvent) => void> = [];
    driver.onEvent((_id, ev) => {
      events.push(ev);
      for (const w of waiters) w(ev);
    });
    const waitForEvent = <T extends DriverEvent["type"]>(
      type: T,
      pred: (e: Extract<DriverEvent, { type: T }>) => boolean = () => true,
    ): Promise<Extract<DriverEvent, { type: T }>> => {
      const hit = events.find((e): e is Extract<DriverEvent, { type: T }> => e.type === type && pred(e as never));
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => {
        const check = (ev: DriverEvent) => {
          if (ev.type === type && pred(ev as never)) {
            const idx = waiters.indexOf(check);
            if (idx >= 0) waiters.splice(idx, 1);
            resolve(ev as Extract<DriverEvent, { type: T }>);
          }
        };
        waiters.push(check);
      });
    };

    cleanups.push(async () => {
      await driver.shutdown();
      rmSync(dir, { recursive: true, force: true });
    });

    const row = makeAcpSessionRow(901 as SessionId, cwd);
    store.add(row);

    await driver.send(row.id, { messageIds: [1], source: "user", text: "start background job" });
    await waitForEvent("agent.text_delta");

    await driver.interrupt(row.id);
    const firstEnd = await waitForEvent("turn.ended", (e) => e.messageIds.includes(1));
    expect(firstEnd.interrupted).toBe(true);

    await waitForEvent("commands.changed", (e) => e.commands.some((c) => c.name === "post-cancel-fence"));

    const toolEventsAfterTurn1 = events.slice(events.indexOf(firstEnd) + 1).filter(
      (e) => e.type === "agent.tool" || e.type === "agent.tool_result",
    );
    expect(toolEventsAfterTurn1).toEqual([]);
    expect(driver.isRunning(row.id)).toBe(true);
    expect(driver.isBusy(row.id)).toBe(false);

    await driver.send(row.id, { messageIds: [2], source: "user", text: "turn 2" });
    const secondEnd = await waitForEvent("turn.ended", (e) => e.messageIds.includes(2));
    expect(secondEnd.ok).toBe(true);
    expect(events.filter((e) => e.type === "session.exited")).toEqual([]);
  });

  it("aborts pre-spawn prepareLaunch without writing a turn when interrupt arrives before spawn", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "bellwood-acp-prespawn-")));
    const cwd = join(dir, "workspace");
    mkdirSync(cwd, { recursive: true });
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, "Follow rules.", "utf8");

    let releasePrepare!: () => void;
    let prepareStarted!: () => void;
    const prepareReady = new Promise<void>((resolve) => {
      prepareStarted = resolve;
    });
    const store = new MemorySessionStore();
    const driver = createAcpDriver(
      { vendor: "agy", launchArgs: [FAKE_ACP_AGENT], authenticate: { enabled: false } },
      {
        executablePath: process.execPath,
        store,
        prepareLaunch: async (row: AgentSessionRow): Promise<LaunchFiles> => {
          prepareStarted();
          await new Promise<void>((resolve) => {
            releasePrepare = resolve;
          });
          return { promptFile, env: {}, fingerprint: `fp-${row.id}` };
        },
      },
    );
    const events: DriverEvent[] = [];
    driver.onEvent((_id, ev) => events.push(ev));

    cleanups.push(async () => {
      await driver.shutdown();
      rmSync(dir, { recursive: true, force: true });
    });

    const row = makeAcpSessionRow(902 as SessionId, cwd);
    store.add(row);
    const sendPromise = driver.send(row.id, { messageIds: [11], source: "user", text: "cancelled before spawn" });
    await prepareReady;

    const interruptPromise = driver.interrupt(row.id);
    releasePrepare();
    await Promise.all([sendPromise, interruptPromise]);

    expect(events.some((e) => e.type === "message.delivered")).toBe(false);
    expect(events.some((e) => e.type === "message.cancelled" && e.messageIds.includes(11))).toBe(true);
    expect(driver.isBusy(row.id)).toBe(false);
  });
});

describe("Claude interrupt escalation and unchanged ack_only regression (S5, S9)", () => {
  let h: Harness | undefined;

  afterEach(async () => {
    await h?.cleanup();
    h = undefined;
  });

  it("escalates to SIGKILL when Claude ignores both interrupt control and SIGINT", async () => {
    h = makeHarness({
      driver: { interruptGraceMs: 80, shutdownGraceMs: 100 },
      script: { ignoreControl: true, ignoreSigint: true, turns: [slowTurn(30_000)] },
    });
    const s = h.addSession();
    await h.driver.send(s.id, { messageIds: [1], source: "user", text: "hang" });
    await h.waitFor("message.processing");

    await h.driver.interrupt(s.id);
    const exited = await h.waitFor("session.exited");
    expect(exited.reason).toBe("interrupt");
    expect(exited.signal).toBe("SIGKILL");
  }, 2_000);

  it("escalates to SIGINT/SIGKILL when Claude acknowledges interrupt but hangs past interruptPostAckGraceMs", async () => {
    h = makeHarness({
      driver: { interruptGraceMs: 80, interruptPostAckGraceMs: 140, shutdownGraceMs: 100 },
      script: { control: "ack_only", ignoreSigint: true, turns: [slowTurn(30_000)] },
    });
    const s = h.addSession();
    await h.driver.send(s.id, { messageIds: [1], source: "user", text: "hang after ack" });
    await h.waitFor("message.processing");

    await h.driver.interrupt(s.id);
    const exited = await h.waitFor("session.exited");
    expect(exited.reason).toBe("interrupt");
    expect(exited.signal).toBe("SIGKILL");
  }, 2_000);

  it("regression: preserves Claude ack_only grace without premature SIGINT before interruptPostAckGraceMs", async () => {
    h = makeHarness({
      driver: { interruptGraceMs: 120 },
      script: { control: "ack_only", turns: [slowTurn(350)] },
    });
    const s = h.addSession();
    await h.driver.send(s.id, { messageIds: [1], source: "user", text: "finishes cleanly after ack" });
    await h.waitFor("message.processing");

    await h.driver.interrupt(s.id);
    const ended = await h.waitFor("turn.ended");
    expect(ended).toMatchObject({ ok: true, interrupted: false, messageIds: [1] });
    expect(h.of("session.exited")).toEqual([]);
  });

  it("regression: covers all registered vendors in AGENT_VENDORS", () => {
    expect(AGENT_VENDORS).toContain("agy");
    expect(AGENT_VENDORS).toContain("claude");
    expect(AGENT_VENDORS).toContain("codex");
    expect(AGENT_VENDORS).toContain("pi");
    expect(AGENT_VENDORS).toContain("cursor");
    expect(AGENT_VENDORS).toContain("deepseek");
    expect(AGENT_VENDORS).toContain("kimi");
    expect(AGENT_VENDORS).toContain("opencode");
  });
});
