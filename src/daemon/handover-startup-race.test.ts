import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_RENEW_CONTEXT_TOKENS,
  DriverError,
  type AgentSessionRow,
  type DriverSendInput,
  type DriverSendResult,
  type LaunchFiles,
  type MessageId,
  type SessionId,
  type TokenUsage,
} from "../shared/index.ts";
import { claudeComposerBase } from "../vendors/claude/composer.ts";
import { createActionExecutor, enqueueAction, getAction, listActions, setActionStatus } from "./actions/index.ts";
import { createSessionTokens } from "./agent-api/tokens.ts";
import {
  BaseSessionDriver,
  createBaseSessionState,
  type BaseBatch,
  type BaseDriverOptions,
  type BaseProc,
  type BaseSessionState,
} from "./driver/base-driver.ts";
import { createSessionEndHandler, createSessionSendHandler, createSessionStartHandler } from "./handlers.ts";
import { createLedger } from "./ledger/index.ts";
import { createSessionStore } from "./store/index.ts";
import { openTestDb } from "./store/test-helpers.ts";

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

const USAGE: TokenUsage = { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, context: 5 };
const REF = { forker: "fake-native", handle: { forkId: "fork-1", extra: { path: "/tmp/fork-1" } } };

interface TestBatch extends BaseBatch {
  text: string;
}

type TestProc = BaseProc;
type TestState = BaseSessionState<TestProc, TestBatch>;

function fakeChild(pid: number): ChildProcessWithoutNullStreams {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exited = false;
  const finishExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (exited) return;
    exited = true;
    (emitter as unknown as { exitCode: number | null }).exitCode = code;
    (emitter as unknown as { signalCode: NodeJS.Signals | null }).signalCode = signal;
    stdout.end();
    stderr.end();
    emitter.emit("exit", code, signal);
  };
  stdin.on("finish", () => finishExit(0, null));
  return Object.assign(emitter, {
    pid,
    stdin,
    stdout,
    stderr,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((sig?: NodeJS.Signals) => {
      finishExit(null, sig ?? "SIGTERM");
      return true;
    }),
  }) as unknown as ChildProcessWithoutNullStreams;
}

interface StartupHandle {
  sessionId: SessionId;
  messageIds: MessageId[];
  completeInit: () => void;
  failStartup: (error: Error) => void;
}

interface TurnHandle {
  sessionId: SessionId;
  messageIds: MessageId[];
  completeTurn: (replyText: string) => void;
}

class ControllableDriver extends BaseSessionDriver<TestProc, TestBatch, TestState> {
  #nextPid = 5000;
  readonly startedBatches: Array<{ sessionId: SessionId; messageIds: MessageId[]; text: string }> = [];
  readonly writtenBatches: Array<{ sessionId: SessionId; messageIds: MessageId[]; text: string }> = [];
  readonly activeTurns = new Map<string, TurnHandle>();
  readonly startupGates = new Map<string, Deferred<void>>();
  readonly startupEntered = new Map<string, Deferred<StartupHandle>>();
  readonly turnStarted = new Map<string, Deferred<TurnHandle>>();

  constructor(options: Omit<BaseDriverOptions, "composer">) {
    super("agy", { ...options, composer: claudeComposerBase });
  }

  gateStartup(sessionId: SessionId, messageId: MessageId): { entered: Promise<StartupHandle>; gate: Deferred<void> } {
    const key = `${sessionId}:${messageId}`;
    const gate = deferred<void>();
    const entered = deferred<StartupHandle>();
    this.startupGates.set(key, gate);
    this.startupEntered.set(key, entered);
    return { entered: entered.promise, gate };
  }

  waitForTurn(sessionId: SessionId, messageId: MessageId): Promise<TurnHandle> {
    const key = `${sessionId}:${messageId}`;
    const existing = this.activeTurns.get(key);
    if (existing) return Promise.resolve(existing);
    let d = this.turnStarted.get(key);
    if (!d) {
      d = deferred<TurnHandle>();
      this.turnStarted.set(key, d);
    }
    return d.promise;
  }

  protected createSessionState(id: SessionId): TestState {
    return createBaseSessionState(id);
  }

  protected takeBatch(st: TestState): TestBatch | null {
    const taken = this.takePendingEntryBatch(st);
    if (!taken) return null;
    const { notes, prefixes } = this.takeNotesPrefixes(st);
    return {
      messageIds: taken.messageIds,
      text: [...prefixes, ...taken.body.prefixes, taken.body.text].join("\n\n"),
      notes,
      delivered: false,
      processing: false,
      source: taken.source,
    };
  }

  async send(sessionId: SessionId, input: DriverSendInput): Promise<DriverSendResult> {
    this.assertRunning();
    const st = this.state(sessionId);
    this.assertNotEnded(st);
    if (input.messageIds.every((id) => st.written.has(id))) return { kind: "written" };
    if (!this.isPending(st, input.messageIds)) {
      st.pending.push({
        messageIds: [...input.messageIds],
        source: input.source,
        text: input.text,
        prefixes: [...(input.prefixes ?? [])],
        resend: input.resend ?? false,
      });
    }
    await this.pump(st);
    return input.messageIds.every((id) => st.written.has(id)) ? { kind: "written" } : { kind: "queued" };
  }

  override async interrupt(sessionId: SessionId): Promise<void> {
    const st = this.sessions.get(sessionId);
    if (!st) return;
    this.dropPendingUsers(st);
    const proc = st.proc;
    if (proc && !proc.closing) this.closeStdin(st, proc, "interrupt");
  }

  protected async spawnIdleProcess(st: TestState, resume: boolean): Promise<TestProc> {
    const { row, files } = await this.resolveLaunchFiles(st, null);
    const child = fakeChild(++this.#nextPid);
    const { baseProc, resolveExited } = this.createBaseProc(child, resume, row, files);
    this.attachChildProcess(st, baseProc, resolveExited);
    return baseProc;
  }

  protected async startup(st: TestState, batch: TestBatch, existing: TestProc | null, _files: LaunchFiles | null): Promise<void> {
    st.inFlight = [batch];
    const key = `${st.id}:${batch.messageIds[0]}`;
    this.startedBatches.push({ sessionId: st.id, messageIds: [...batch.messageIds], text: batch.text });
    try {
      const proc = existing ?? (await this.spawnIdleProcess(st, this.resumeFor(st)));
      this.abortIfStopped(st, proc);
      const gate = this.startupGates.get(key);
      if (gate) {
        const entered = this.startupEntered.get(key);
        entered?.resolve({
          sessionId: st.id,
          messageIds: [...batch.messageIds],
          completeInit: () => gate.resolve(),
          failStartup: (err) => gate.reject(err),
        });
        await gate.promise;
      }
      proc.initSeen = true;
      this.update(st, { status: "running", lastEventAt: Date.now() });
      this.emit(st.id, { type: "session.started", resumed: proc.resume, model: "test-model", tools: [], at: Date.now() });
      this.markDelivered(st, batch);
      this.#beginTurn(st, proc, batch);
    } catch (error) {
      this.dropBatch(st, batch);
      throw error;
    }
  }

  protected async writeBatch(st: TestState, proc: TestProc, batch: TestBatch): Promise<void> {
    st.inFlight = [batch];
    this.markDelivered(st, batch);
    this.#beginTurn(st, proc, batch);
  }

  #beginTurn(st: TestState, proc: TestProc, batch: TestBatch): void {
    this.writtenBatches.push({ sessionId: st.id, messageIds: [...batch.messageIds], text: batch.text });
    this.markProcessing(st, batch, Date.now());
    const handle: TurnHandle = {
      sessionId: st.id,
      messageIds: [...batch.messageIds],
      completeTurn: (replyText: string) => {
        const at = Date.now();
        this.emit(st.id, { type: "agent.text", uuid: `u-${st.id}-${batch.messageIds.join("-")}-${at}`, text: replyText, at });
        st.inFlight = [];
        st.selfTurn = false;
        this.update(st, { hasCompletedTurn: true, lastEventAt: at });
        this.emit(st.id, {
          type: "turn.ended",
          ok: true,
          interrupted: false,
          messageIds: [...batch.messageIds],
          durationMs: 1,
          at,
        });
        this.afterTurn(st, proc);
        this.settled(st);
      },
    };
    for (const id of batch.messageIds) {
      const key = `${st.id}:${id}`;
      this.activeTurns.set(key, handle);
      const waiter = this.turnStarted.get(key);
      if (waiter) {
        this.turnStarted.delete(key);
        waiter.resolve(handle);
      }
    }
  }

  protected resumeFor(st: TestState): boolean {
    return this.store(st).hasCompletedTurn;
  }

  protected identifyStaleProcess(): Promise<number | null> {
    return Promise.resolve(null);
  }

  protected onParsedLine(): void {}

  protected onProcessClose(
    st: TestState,
    proc: TestProc,
    code: number | null,
    signal: NodeJS.Signals | null,
    resolveExited: () => void,
  ): void {
    const at = this.beginProcessClose(st, proc);
    const batches = [...st.inFlight];
    st.inFlight = [];
    this.emit(st.id, {
      type: "session.exited",
      reason: proc.closing ?? "crash",
      exitCode: code,
      signal,
      hadResult: batches.length === 0,
      messageIds: batches.flatMap((b) => b.messageIds),
      at,
    });
    resolveExited();
    this.settled(st);
  }
}

interface Harness {
  db: ReturnType<typeof openTestDb>;
  home: string;
  ledger: ReturnType<typeof createLedger>;
  driver: ControllableDriver;
  executor: ReturnType<typeof createActionExecutor>;
  pmId: number;
  conversationId: number;
  s1: SessionId;
  post: (text: string) => MessageId;
  sessions: () => Array<{ id: number; generation: number; status: string }>;
  cleanup: () => Promise<void>;
}

const activeHarnesses: Harness[] = [];

afterEach(async () => {
  for (const h of activeHarnesses.splice(0)) await h.cleanup();
});

function createHarness(options: {
  prepareLaunch?: (session: AgentSessionRow) => Promise<LaunchFiles>;
  probeDiffNumstat?: () => Promise<readonly { file: string; added: number | null; deleted: number | null }[] | null>;
} = {}): Harness {
  const db = openTestDb();
  const home = mkdtempSync(join(tmpdir(), "agent-hub-race-"));
  const sessions = createSessionStore(db);
  const tokens = createSessionTokens();
  let driverRef: ControllableDriver | undefined;
  const ledger = createLedger(db, {
    pmHomeRoot: home,
    isSessionBusy: (id) => driverRef?.isBusy(id) ?? false,
  });
  const driver = new ControllableDriver({
    store: sessions,
    prepareLaunch:
      options.prepareLaunch ??
      (async (session) => ({
        promptFile: join(home, `prompt-${session.id}.md`),
        env: {},
        fingerprint: "fp-1",
      })),
    sessionPreamble: (id) => ledger.sessionPreamble(id),
    onSessionQuiescent: (id) => ledger.onSessionQuiescent?.(id),
    idleCloseMs: 60_000,
    startTimeoutMs: 60_000,
    interruptGraceMs: 500,
    shutdownGraceMs: 500,
  });
  driverRef = driver;

  const offDriver = driver.onEvent((sessionId, event) => ledger.applyDriverEvent(sessionId, event));
  const executor = createActionExecutor(db, ledger, { pollIntervalMs: 50 });
  const deps = {
    driver,
    ledger,
    sessions,
    tokens,
    ...(options.probeDiffNumstat ? { probeDiffNumstat: options.probeDiffNumstat } : {}),
  };
  executor.register("session.start", createSessionStartHandler(deps));
  executor.register("session.send", createSessionSendHandler(deps));
  executor.register("session.end", createSessionEndHandler(deps));

  const offAction = ledger.onActionEnqueued((action) => {
    if (action.type === "session.end") driver.markEnding(action.params.sessionId);
    executor.wake();
  });

  const created = ledger.createPm({ name: "PM", mode: "manage_only", persona: "", vendor: "agy" });
  executor.start();

  let seq = 0;
  const harness: Harness = {
    db,
    home,
    ledger,
    driver,
    executor,
    pmId: created.pm.id,
    conversationId: created.conversation.id,
    s1: created.sessionId,
    post: (text) => ledger.postUserMessage({ conversationId: created.conversation.id, clientId: `c-${++seq}`, text }).messageId,
    sessions: () =>
      db.all<{ id: number; generation: number; status: string }>(
        "SELECT id, generation, status FROM agent_sessions WHERE conversation_id = ? ORDER BY generation",
        created.conversation.id,
      ),
    cleanup: async () => {
      offAction();
      for (const gate of driver.startupGates.values()) gate.reject(new DriverError("session_ended", "cleanup"));
      await executor.stop();
      await driver.shutdown();
      await ledger.settleDriverEvents();
      offDriver();
      ledger.close();
      db.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
  activeHarnesses.push(harness);
  return harness;
}

function startBackgroundHandover(h: Harness): number {
  createSessionStore(h.db).update(h.s1, { usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, context: AUTO_RENEW_CONTEXT_TOKENS } });
  h.ledger.renewSession(h.pmId);
  const job = h.ledger.claimHandover()!;
  expect(job).not.toBeNull();
  expect(h.ledger.handoverForked(job.handoverId, { kind: "native", ref: REF })).toBe(true);
  return job.handoverId;
}

describe("handover vs driver startup concurrency races", () => {
  it("incident timeline: handoverWritten during slow cold startup defers switch until M1 finishes, then moves M2 to s2 without split-brain or stuck processing", async () => {
    const h = createHarness();
    const handoverId = startBackgroundHandover(h);

    const m1 = h.post("message-1-during-cold-start");
    const startup1 = h.driver.gateStartup(h.s1, m1);
    const handle1 = await startup1.entered;

    // M2 arrives while M1 is still waiting for init (pre-markDelivered blind spot).
    const m2 = h.post("message-2-hello");
    await flushMicrotasks();

    // Background handover finishes while M1 is mid-startup on s1.
    h.ledger.handoverWritten(handoverId, { text: "handover summary", usage: USAGE });

    // Must NOT switch while s1 is starting up with M1.
    expect(h.sessions()).toHaveLength(1);
    expect(h.ledger.getMessage(m1)).toMatchObject({ sessionId: h.s1, status: "queued" });
    expect(h.ledger.getMessage(m2)).toMatchObject({ sessionId: h.s1, status: "queued" });
    expect(h.ledger.waitsForHandover(m2)).toBe(true);

    // Finish s1 init -> M1 becomes processing on s1, M2 stays held for s2.
    handle1.completeInit();
    const turn1 = await h.driver.waitForTurn(h.s1, m1);
    expect(h.ledger.getMessage(m1)).toMatchObject({ sessionId: h.s1, status: "processing" });
    expect(h.sessions()).toHaveLength(1);

    // Complete M1 on s1 -> handover switches to s2, M2 moves to s2 and runs there only.
    turn1.completeTurn("reply-1-from-s1");
    await flushMicrotasks();

    const allSessions = h.sessions();
    expect(allSessions).toHaveLength(2);
    const s2 = allSessions[1]!.id;
    expect(h.ledger.getMessage(m1)).toMatchObject({ sessionId: h.s1, status: "replied" });
    expect(h.ledger.getMessage(m2)?.sessionId).toBe(s2);

    const turn2 = await h.driver.waitForTurn(s2, m2);
    turn2.completeTurn("reply-2-from-s2");
    await flushMicrotasks();

    expect(h.ledger.getMessage(m1)).toMatchObject({ sessionId: h.s1, status: "replied" });
    expect(h.ledger.getMessage(m2)).toMatchObject({ sessionId: s2, status: "replied" });
    // M1 ran ONLY on s1; M2 ran ONLY on s2.
    expect(h.driver.writtenBatches.filter((b) => b.messageIds.includes(m1)).map((b) => b.sessionId)).toEqual([h.s1]);
    expect(h.driver.writtenBatches.filter((b) => b.messageIds.includes(m2)).map((b) => b.sessionId)).toEqual([s2]);
  });

  it("message queued into driver st.pending while handover is writing is NOT double-run by old session afterTurn when turn.ended triggers switchIn", async () => {
    const h = createHarness();
    const handoverId = startBackgroundHandover(h);

    // M1 is running on s1.
    const m1 = h.post("m1-running");
    const turn1 = await h.driver.waitForTurn(h.s1, m1);

    // M2 arrives while handover is still 'writing' -> session.send(s1, m2) runs and puts m2 into s1's driver st.pending!
    const m2 = h.post("m2-buffered-in-driver-pending");
    await vi.waitFor(() => {
      const m2Actions = listActions(h.db).filter((a) => a.type === "session.send" && a.params.messageId === m2);
      expect(m2Actions[0]?.nextAttemptAt).toBeGreaterThan(m2Actions[0]!.createdAt);
    });

    // Handover finishes writing -> ready (deferred because s1 is processing M1).
    h.ledger.handoverWritten(handoverId, { text: "summary", usage: USAGE });
    expect(h.sessions()).toHaveLength(1);

    // M1 completes -> turn.ended switches s1 -> s2; s1's afterTurn MUST NOT deliver m2 from st.pending!
    turn1.completeTurn("reply-1");
    await flushMicrotasks();

    const allSessions = h.sessions();
    expect(allSessions).toHaveLength(2);
    const s2 = allSessions[1]!.id;

    const turn2 = await h.driver.waitForTurn(s2, m2);
    turn2.completeTurn("reply-2-from-s2");
    await flushMicrotasks();

    expect(h.ledger.getMessage(m2)).toMatchObject({ sessionId: s2, status: "replied" });
    expect(h.driver.writtenBatches.filter((b) => b.messageIds.includes(m2)).map((b) => b.sessionId)).toEqual([s2]);
  });

  it("afterTurn deliverNext already in prepareLaunch for M2 blocks handoverWritten until M2 finishes on s1", async () => {
    let prepareCalls = 0;
    const m2PrepareEntered = deferred<void>();
    const m2PrepareRelease = deferred<void>();
    const h = createHarness({
      prepareLaunch: async (session) => {
        prepareCalls++;
        if (session.id === h.s1 && prepareCalls === 2) {
          m2PrepareEntered.resolve();
          await m2PrepareRelease.promise;
        }
        return { promptFile: join(h.home, `prompt-${session.id}.md`), env: {}, fingerprint: "fp-1" };
      },
    });
    const handoverId = startBackgroundHandover(h);

    const m1 = h.post("m1");
    const turn1 = await h.driver.waitForTurn(h.s1, m1);

    // Buffer M2 in s1's st.pending while handover is still writing.
    const m2 = h.post("m2");
    await vi.waitFor(() => {
      const m2Actions = listActions(h.db).filter((a) => a.type === "session.send" && a.params.messageId === m2);
      expect(m2Actions[0]?.nextAttemptAt).toBeGreaterThan(m2Actions[0]!.createdAt);
    });

    // Complete M1 BEFORE handoverWritten -> afterTurn starts deliverNext(s1) for M2 (with NO running action row!).
    turn1.completeTurn("reply-1");
    await m2PrepareEntered.promise;

    // Now handover finishes while deliverNext(s1) is inside prepareLaunch for M2.
    h.ledger.handoverWritten(handoverId, { text: "summary", usage: USAGE });
    expect(h.sessions()).toHaveLength(1);

    // Release deliverNext -> M2 completes on s1, then s1 switches cleanly to s2.
    m2PrepareRelease.resolve();
    const turn2 = await h.driver.waitForTurn(h.s1, m2);
    turn2.completeTurn("reply-2-from-s1");
    await flushMicrotasks();

    expect(h.sessions()).toHaveLength(2);
    expect(h.ledger.getMessage(m2)).toMatchObject({ sessionId: h.s1, status: "replied" });
    expect(h.driver.writtenBatches.filter((b) => b.messageIds.includes(m2)).map((b) => b.sessionId)).toEqual([h.s1]);
  });

  it("cross-session session.send uses (sessionId, messageId) dedupe key and executor never marks superseded params done", async () => {
    const db = openTestDb();
    try {
      const home = mkdtempSync(join(tmpdir(), "agent-hub-dedupe-"));
      try {
        const ledger = createLedger(db, { pmHomeRoot: home });
        const first = enqueueAction(db, { type: "session.send", params: { sessionId: 1, messageId: 42, source: "user" } }, 1_000);
        setActionStatus(db, first.row.id, { status: "running", attempts: 2, lastError: "old-err", nextAttemptAt: 9_000 }, 2_000);

        // Enqueue same message for a new session while old session's action is still running.
        const second = enqueueAction(db, { type: "session.send", params: { sessionId: 2, messageId: 42, source: "user" } }, 3_000);
        expect(second.enqueued).toBe(true);
        expect(second.row.id).not.toBe(first.row.id);
        expect(second.row).toMatchObject({
          status: "pending",
          attempts: 0,
          lastError: null,
          nextAttemptAt: 3_000,
          params: { sessionId: 2, messageId: 42, source: "user" },
        });
        // Old running action was NOT overwritten.
        expect(getAction(db, first.row.id)).toMatchObject({
          status: "running",
          params: { sessionId: 1, messageId: 42, source: "user" },
        });

        // Also test same-key params mutation while running in ActionExecutor.
        const sameKey = enqueueAction(db, { type: "session.send", params: { sessionId: 5, messageId: 99, source: "user" } }, 1_000).row;
        const entered = deferred<void>();
        const release = deferred<void>();
        const seenParams: Array<Record<string, unknown>> = [];
        const executor = createActionExecutor(db, ledger, { pollIntervalMs: 50 });
        executor.register("session.send", async (action) => {
          seenParams.push({ ...action.params });
          if (action.id === sameKey.id && seenParams.length === 1) {
            entered.resolve();
            await release.promise;
          }
          return { kind: "done" };
        });
        // Mark the earlier test rows done so executor only runs sameKey.
        setActionStatus(db, first.row.id, { status: "done" }, 3_000);
        setActionStatus(db, second.row.id, { status: "done" }, 3_000);

        executor.start();
        await entered.promise;
        // Overwrite params while sameKey is running (e.g. adding resend: true).
        enqueueAction(db, { type: "session.send", params: { sessionId: 5, messageId: 99, source: "user", resend: true } }, 4_000);
        release.resolve();

        await vi.waitFor(() => {
          expect(seenParams).toHaveLength(2);
        });
        expect(seenParams[1]).toMatchObject({ sessionId: 5, messageId: 99, resend: true });
        await executor.stop();
        ledger.close();
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    } finally {
      db.close();
    }
  });

  it("stale session events and session_ended handler cannot mutate messages owned by a newer session", async () => {
    const db = openTestDb();
    const home = mkdtempSync(join(tmpdir(), "agent-hub-owner-"));
    try {
      const ledger = createLedger(db, { pmHomeRoot: home });
      const { pm, conversation, sessionId: s1 } = ledger.createPm({ name: "PM", mode: "manage_only", persona: "" });
      const m = ledger.postUserMessage({ conversationId: conversation.id, clientId: "c1", text: "question" }).messageId;

      // Renew session while m is queued -> m moves to s2.
      ledger.renewSession(pm.id);
      const job = ledger.claimHandover()!;
      ledger.handoverForked(job.handoverId, { kind: "native", ref: REF });
      ledger.handoverWritten(job.handoverId, { text: "handover", usage: USAGE });
      const s2 = db.all<{ id: number }>("SELECT id FROM agent_sessions WHERE conversation_id = ? ORDER BY generation", conversation.id)[1]!.id;
      expect(ledger.getMessage(m)).toMatchObject({ sessionId: s2, status: "queued" });

      // Stale s1 emits every message-mutating event -> m on s2 MUST remain queued!
      ledger.applyDriverEvent(s1, { type: "message.delivered", messageIds: [m], at: 100 });
      expect(ledger.getMessage(m)).toMatchObject({ sessionId: s2, status: "queued" });

      ledger.applyDriverEvent(s1, { type: "message.processing", messageIds: [m], at: 101 });
      expect(ledger.getMessage(m)).toMatchObject({ sessionId: s2, status: "queued" });

      ledger.applyDriverEvent(s1, { type: "message.cancelled", messageIds: [m], reason: "stop", at: 102 });
      expect(ledger.getMessage(m)).toMatchObject({ sessionId: s2, status: "queued" });

      ledger.applyDriverEvent(s1, { type: "driver.error", code: "internal_error", message: "old err", messageIds: [m], at: 103 });
      expect(ledger.getMessage(m)).toMatchObject({ sessionId: s2, status: "queued" });

      ledger.applyDriverEvent(s1, { type: "session.exited", reason: "crash", exitCode: 1, signal: null, hadResult: false, messageIds: [m], at: 104 });
      expect(ledger.getMessage(m)).toMatchObject({ sessionId: s2, status: "queued" });

      // Stale s1 action failure / session_ended handler must not fail or stop m on s2!
      const staleSendAction = {
        id: 999,
        type: "session.send" as const,
        dedupeKey: `${s1}:${m}`,
        params: { sessionId: s1, messageId: m, source: "user" as const },
        status: "running" as const,
        attempts: 3,
        nextAttemptAt: 0,
        lastError: null,
        createdAt: 0,
        updatedAt: 0,
      };
      ledger.onActionFailed(staleSendAction, "old session died");
      expect(ledger.getMessage(m)).toMatchObject({ sessionId: s2, status: "queued" });

      const sendHandler = createSessionSendHandler({
        driver: {
          start: async () => {},
          send: async () => {
            throw new DriverError("session_ended", `session ${s1} has been ended`);
          },
          end: async () => {},
        },
        ledger: {
          ...ledger,
          // Simulate race where getMessage returned s1 before send, then m moved to s2 while send threw session_ended.
          getMessage: vi
            .fn()
            .mockReturnValueOnce({ ...ledger.getMessage(m)!, sessionId: s1, status: "queued" })
            .mockReturnValueOnce(ledger.getMessage(m)),
        },
        sessions: createSessionStore(db),
        tokens: createSessionTokens(),
      });
      expect(await sendHandler(staleSendAction)).toEqual({ kind: "done" });
      expect(ledger.getMessage(m)).toMatchObject({ sessionId: s2, status: "queued" });

      // Now m is delivered/processing on s2; stale s1 message.requeued / stopMessage / session.exited must not touch it!
      ledger.applyDriverEvent(s2, { type: "message.delivered", messageIds: [m], at: 200 });
      ledger.applyDriverEvent(s1, { type: "message.requeued", messageIds: [m], at: 201 });
      expect(ledger.getMessage(m)).toMatchObject({ sessionId: s2, status: "delivered" });
      ledger.applyDriverEvent(s2, { type: "message.processing", messageIds: [m], at: 202 });
      ledger.applyDriverEvent(s1, { type: "session.exited", reason: "interrupt", exitCode: 0, signal: null, hadResult: false, messageIds: [m], at: 203 });
      expect(ledger.getMessage(m)).toMatchObject({ sessionId: s2, status: "processing" });

      ledger.close();
    } finally {
      db.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("switchVendorIn and claimHandover defer while session.send is starting, and startup failure switches immediately", async () => {
    const h = createHarness();
    // 1. claimHandover must not fork while M1 is starting up.
    createSessionStore(h.db).update(h.s1, { usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, context: AUTO_RENEW_CONTEXT_TOKENS } });
    h.ledger.renewSession(h.pmId);
    const m1 = h.post("m1-cold-start");
    const gate1 = h.driver.gateStartup(h.s1, m1);
    const handle1 = await gate1.entered;

    expect(h.ledger.claimHandover()).toBeNull();

    // 2. Vendor switch during cold startup must stay pending (not switch mid-startup).
    const switched = h.ledger.editPersona(h.pmId, { vendor: "codex" }, { kind: "user" });
    expect(switched.persona.switchingToVendor).toBe("codex");
    expect(h.sessions()).toHaveLength(1);

    // 3. Startup fails -> executor settles the failed attempt -> handover switches immediately to s2 (codex) and delivers M1 there!
    handle1.failStartup(new DriverError("spawn_failed", "old cli failed"));
    await vi.waitFor(() => {
      expect(h.sessions()).toHaveLength(2);
    });
    const s2 = h.sessions()[1]!.id;
    expect(createSessionStore(h.db).get(s2)?.vendor).toBe("codex");
    const turnOnS2 = await h.driver.waitForTurn(s2, m1);
    turnOnS2.completeTurn("reply-from-s2");
    await flushMicrotasks();
    expect(h.ledger.getMessage(m1)).toMatchObject({ sessionId: s2, status: "replied" });
  });

  it("probeDiffNumstat yielding while handover becomes ready defers send, switches immediately on settle, and delivers on s2", async () => {
    const probeEntered = deferred<void>();
    const probeRelease = deferred<void>();
    const h = createHarness({
      probeDiffNumstat: async () => {
        probeEntered.resolve();
        await probeRelease.promise;
        return [{ file: "src/a.ts", added: 3, deleted: 1 }];
      },
    });
    const handoverId = startBackgroundHandover(h);
    const t = Date.now();
    // Insert a delivery-note message with graphDeliveryProbeTarget so createSessionSendHandler awaits probeDiffNumstat.
    const msgId = h.db.get<{ id: number }>(
      `INSERT INTO messages (conversation_id, session_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, 'system', 'text', 'delivery note', '{}', 'delivery-probe-race', 'queued', ?, ?) RETURNING id`,
      h.conversationId,
      h.s1,
      t,
      t,
    )!.id;
    const origProbe = h.ledger.graphDeliveryProbeTarget;
    h.ledger.graphDeliveryProbeTarget = (id) =>
      id === msgId
        ? { graphId: 1, repoFolder: h.home, branches: [{ branch: "feat", cwd: h.home, baseCommit: null }] }
        : (origProbe?.(id) ?? null);
    enqueueAction(h.db, { type: "session.send", params: { sessionId: h.s1, messageId: msgId, source: "system" } }, t);
    h.executor.wake();

    await probeEntered.promise;
    // Handover finishes while session.send is awaiting probeDiffNumstat -> must NOT switch yet.
    h.ledger.handoverWritten(handoverId, { text: "summary", usage: USAGE });
    expect(h.sessions()).toHaveLength(1);

    // Release probe -> handler rechecks waitsForHandover -> returns later -> executor settles -> immediate switch to s2!
    probeRelease.resolve();
    await vi.waitFor(() => {
      expect(h.sessions()).toHaveLength(2);
    });
    const s2 = h.sessions()[1]!.id;
    const turnOnS2 = await h.driver.waitForTurn(s2, msgId);
    turnOnS2.completeTurn("handled-on-s2");
    await flushMicrotasks();

    expect(h.ledger.getMessage(msgId)).toMatchObject({ sessionId: s2, status: "replied" });
    expect(h.driver.writtenBatches.filter((b) => b.messageIds.includes(msgId)).map((b) => b.sessionId)).toEqual([s2]);
  });

  it("message.requeued right after turn.ended triggers deferred ready handover switch and preserves pm sender as user source", async () => {
    const db = openTestDb();
    const home = mkdtempSync(join(tmpdir(), "agent-hub-requeue-"));
    try {
      const ledger = createLedger(db, { pmHomeRoot: home });
      const created = ledger.createPm({ name: "PM", mode: "manage_only", persona: "", vendor: "codex" });
      const s1 = created.sessionId;
      const m1 = ledger.postUserMessage({ conversationId: created.conversation.id, clientId: "c1", text: "turn1" }).messageId;
      const m2 = ledger.postUserMessage({ conversationId: created.conversation.id, clientId: "c2", text: "midturn-missed" }).messageId;
      ledger.applyDriverEvent(s1, { type: "message.delivered", messageIds: [m1], at: 10 });
      ledger.applyDriverEvent(s1, { type: "message.processing", messageIds: [m1], at: 11 });
      // M2 arrived mid-turn and is delivered on s1 while handover finishes.
      ledger.applyDriverEvent(s1, { type: "message.delivered", messageIds: [m2], midTurn: true, at: 12 });
      createSessionStore(db).update(s1, { usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, context: AUTO_RENEW_CONTEXT_TOKENS } });
      ledger.renewSession(created.pm.id);
      const hRow = db.get<{ id: number }>("SELECT id FROM handovers ORDER BY id DESC LIMIT 1")!;
      db.run("UPDATE handovers SET status = 'ready', text = 'summary', ready_at = 13, updated_at = 13 WHERE id = ?", hRow.id);

      // M1 finishes; M2 is still delivered, so turn.ended defers the switch.
      ledger.applyDriverEvent(s1, { type: "turn.ended", ok: true, interrupted: false, messageIds: [m1], durationMs: 1, at: 14 });
      expect(db.all("SELECT id FROM agent_sessions WHERE conversation_id = ?", created.conversation.id)).toHaveLength(1);

      // Driver immediately emits message.requeued for missed M2 -> handover switches s1 -> s2 and moves M2 to s2!
      ledger.applyDriverEvent(s1, { type: "message.requeued", messageIds: [m2], at: 15 });
      const allSessions = db.all<{ id: number }>("SELECT id FROM agent_sessions WHERE conversation_id = ? ORDER BY generation", created.conversation.id);
      expect(allSessions).toHaveLength(2);
      const s2 = allSessions[1]!.id;
      expect(ledger.getMessage(m2)).toMatchObject({ sessionId: s2, status: "queued" });
      const pendingM2Sessions = listActions(db)
        .filter((a) => a.type === "session.send")
        .filter((a) => a.params.messageId === m2 && a.status === "pending")
        .map((a) => a.params.sessionId);
      expect(pendingM2Sessions).toEqual([s2]);

      // Verify message.requeued preserves source: "user" for sender = "pm".
      const t = 20;
      const pmMsgId = db.get<{ id: number }>(
        `INSERT INTO messages (conversation_id, session_id, sender, kind, text, dedupe_key, status, created_at, updated_at)
         VALUES (?, ?, 'pm', 'text', 'brief', 'pm-requeue', 'delivered', ?, ?) RETURNING id`,
        created.conversation.id,
        s2,
        t,
        t,
      )!.id;
      ledger.applyDriverEvent(s2, { type: "message.requeued", messageIds: [pmMsgId], at: 21 });
      expect(listActions(db).find((a) => a.type === "session.send" && a.params.messageId === pmMsgId)?.params).toMatchObject({
        sessionId: s2,
        messageId: pmMsgId,
        source: "user",
      });

      ledger.close();
    } finally {
      db.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("restart recovery and switchIn handle legacy messageId-only dedupe keys without duplicates or stranded queued messages", () => {
    const db = openTestDb();
    const home = mkdtempSync(join(tmpdir(), "agent-hub-legacy-"));
    try {
      const ledger = createLedger(db, { pmHomeRoot: home });
      const created = ledger.createPm({ name: "PM", mode: "manage_only", persona: "", vendor: "agy" });
      const s1 = created.sessionId;
      const mQueued = ledger.postUserMessage({ conversationId: created.conversation.id, clientId: "q1", text: "queued-legacy" }).messageId;
      const mDelivered = ledger.postUserMessage({ conversationId: created.conversation.id, clientId: "d1", text: "delivered-legacy" }).messageId;
      ledger.applyDriverEvent(s1, { type: "message.delivered", messageIds: [mDelivered], at: 10 });

      // Rewrite actions to pre-upgrade legacy dedupe_key = String(messageId) (including one left running at crash time).
      db.run("DELETE FROM actions WHERE type = 'session.send'");
      db.run(
        `INSERT INTO actions (type, dedupe_key, params, status, attempts, next_attempt_at, created_at, updated_at)
         VALUES ('session.send', ?, ?, 'running', 0, 1, 1, 1)`,
        String(mQueued),
        JSON.stringify({ sessionId: s1, messageId: mQueued, source: "user" }),
      );
      db.run(
        `INSERT INTO actions (type, dedupe_key, params, status, attempts, next_attempt_at, created_at, updated_at)
         VALUES ('session.send', ?, ?, 'pending', 0, 1, 1, 1)`,
        String(mDelivered),
        JSON.stringify({ sessionId: s1, messageId: mDelivered, source: "user" }),
      );

      // 1. recoverAfterRestart sees the legacy pending/running action for mQueued (does not duplicate it),
      //    and replaces the legacy pending action for mDelivered with a resend action under the new dedupe key.
      const recovered = ledger.recoverAfterRestart();
      expect(recovered.requeuedMessageIds).toEqual([]);
      expect(recovered.resentMessageIds).toEqual([mDelivered]);
      const deliveredSends = listActions(db).filter((a) => a.type === "session.send" && a.params.messageId === mDelivered);
      expect(deliveredSends).toHaveLength(1);
      expect(deliveredSends[0]).toMatchObject({ dedupeKey: `${s1}:${mDelivered}`, params: { sessionId: s1, messageId: mDelivered, resend: true } });

      // 2. Simulate executor.start() resetting the crashed running legacy action to pending, then finish mDelivered and switch s1 -> s2.
      db.run("UPDATE actions SET status = 'pending' WHERE status = 'running'");
      ledger.applyDriverEvent(s1, { type: "message.processing", messageIds: [mDelivered], at: 19 });
      ledger.applyDriverEvent(s1, { type: "turn.ended", ok: true, interrupted: false, messageIds: [mDelivered], durationMs: 1, at: 20 });
      ledger.editPersona(created.pm.id, { vendor: "codex" }, { kind: "user" });
      const sessions = db.all<{ id: number }>("SELECT id FROM agent_sessions WHERE conversation_id = ? ORDER BY generation", created.conversation.id);
      expect(sessions).toHaveLength(2);
      const s2 = sessions[1]!.id;

      // Legacy pending action for s1 must be deleted; only the fresh s2 action remains.
      const queuedSends = listActions(db).filter((a) => a.type === "session.send" && a.params.messageId === mQueued);
      expect(queuedSends).toHaveLength(1);
      expect(queuedSends[0]).toMatchObject({ dedupeKey: `${s2}:${mQueued}`, status: "pending", params: { sessionId: s2, messageId: mQueued } });

      ledger.close();
    } finally {
      db.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("shutdown boundary: onSessionQuiescent after ledger.close() does not touch the ledger or switch sessions", () => {
    const db = openTestDb();
    const home = mkdtempSync(join(tmpdir(), "agent-hub-close-"));
    try {
      let busy = true;
      const ledger = createLedger(db, { pmHomeRoot: home, isSessionBusy: () => busy });
      const created = ledger.createPm({ name: "PM", mode: "manage_only", persona: "", vendor: "agy" });
      const s1 = created.sessionId;
      ledger.editPersona(created.pm.id, { vendor: "codex" }, { kind: "user" });
      expect(db.all("SELECT id FROM agent_sessions WHERE conversation_id = ?", created.conversation.id)).toHaveLength(1);

      ledger.close();
      busy = false;
      expect(() => ledger.onSessionQuiescent?.(s1)).not.toThrow();
      expect(db.all("SELECT id FROM agent_sessions WHERE conversation_id = ?", created.conversation.id)).toHaveLength(1);
    } finally {
      db.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("async agent.text attachment copy defers handoverWritten and switches via onSessionDrained once copy finishes", async () => {
    const db = openTestDb();
    const home = mkdtempSync(join(tmpdir(), "agent-hub-drain-"));
    try {
      const ledger = createLedger(db, { pmHomeRoot: home, shareTmpDirs: [home] });
      const created = ledger.createPm({ name: "PM", mode: "manage_only", persona: "", vendor: "agy" });
      const s1 = created.sessionId;
      const sample = join(home, "report.txt");
      writeFileSync(sample, "hello attachment", "utf8");

      createSessionStore(db).update(s1, { usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, context: AUTO_RENEW_CONTEXT_TOKENS } });
      ledger.renewSession(created.pm.id);
      const job = ledger.claimHandover()!;
      expect(ledger.handoverForked(job.handoverId, { kind: "native", ref: REF })).toBe(true);

      // Emit an agent.text with a local file link, followed by turn.ended and a trailing non-trigger event (commands.changed).
      // While copyReply is running, handoverWritten must defer; when turn.ended runs, commands.changed is still behind it so it defers;
      // once commands.changed drains last, onSessionDrained switches s1 -> s2 immediately.
      ledger.applyDriverEvent(s1, { type: "agent.text", uuid: "u-link-1", text: `see [report](${sample})`, at: 10 });
      ledger.applyDriverEvent(s1, { type: "turn.ended", ok: true, interrupted: false, messageIds: [], durationMs: 1, at: 11 });
      ledger.applyDriverEvent(s1, { type: "commands.changed", commands: [], at: 12 });
      ledger.handoverWritten(job.handoverId, { text: "summary", usage: USAGE });
      expect(db.all("SELECT id FROM agent_sessions WHERE conversation_id = ?", created.conversation.id)).toHaveLength(1);

      await ledger.settleDriverEvents();
      expect(db.all("SELECT id FROM agent_sessions WHERE conversation_id = ?", created.conversation.id)).toHaveLength(2);

      ledger.close();
    } finally {
      db.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
