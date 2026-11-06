// OpenAI Codex App-Server 驱动层：管理 `codex app-server --listen stdio://` 子进程生命周期、
// JSON-RPC 2.0 握手（initialize → initialized → thread/start 或 thread/resume 失败自动回退）、
// 轮次发送（turn/start）、流式事件映射（agent.thinking / agent.tool / agent.tool_result / agent.text 聚合）、
// 用量与限额更新、反向 RPC 审批拦截（Worker 记忆保护与只读模式）以及优雅打断（turn/interrupt）。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import {
  CRASH_RECOVERY_NOTE,
  DriverError,
  EMPTY_TOKEN_USAGE,
  IDLE_CLOSE_MS,
  INTERRUPT_GRACE_MS,
  KILL_WAIT_MS,
  LAST_EVENT_WRITE_MS,
  RELAUNCH_NOTE,
  RESEND_NOTE,
  RESTART_RECOVERY_NOTE,
  RUNNING_COMMANDS_TIMEOUT_MS,
  SHUTDOWN_GRACE_MS,
  START_TIMEOUT_MS,
  STDERR_TAIL_CHARS,
  STDIO_DRAIN_MS,
  USAGE_PUSH_MS,
  type AgentSessionPatch,
  type AgentSessionRow,
  type ComposerCommand,
  type Driver,
  type DriverEvent,
  type DriverEventListener,
  type DriverOptions,
  type DriverSendInput,
  type DriverSendResult,
  type LaunchFiles,
  type MessageId,
  type MessageSource,
  type SessionExitReason,
  type SessionId,
  type TokenUsage,
  type Unsubscribe,
} from "../../shared/index.ts";
import { composerBaseOf, type VendorComposerBase } from "../vendors/index.ts";
import {
  buildCodexArgs,
  buildInitializeRequest,
  buildInitializedNotification,
  buildJsonRpcResponse,
  buildThreadResumeRequest,
  buildThreadStartRequest,
  buildTurnInterruptRequest,
  buildTurnStartRequest,
  checkCodexTurnText,
  codexOfSession,
  combineCodexTurnText,
  decideCommandApproval,
  decideFileChangeApproval,
  isCodexToolItemType,
  parseCodexRateLimits,
  parseCodexTokenUsage,
  parseCodexToolStarted,
  readCodexLaunchConfig,
  type CodexLaunchConfig,
} from "./codex-protocol.ts";
import {
  forceKill,
  forceKillTree,
  killFreshGroup,
  signalPid,
  streamClosed,
  termGroupAfterExit,
  waitForExit,
} from "./process.ts";
import { buildChildEnv, lineUuid, mergeUserTexts } from "./protocol.ts";
import { TurnUsage } from "./usage.ts";

interface PendingEntry {
  messageIds: MessageId[];
  source: MessageSource;
  text: string;
  prefixes: string[];
  resend: boolean;
}

interface Batch {
  messageIds: MessageId[];
  combinedText: string;
  notes: { recovery: boolean; crash: boolean; relaunch: boolean };
  delivered: boolean;
  processing: boolean;
}

type ClosingReason = "idle" | "interrupt" | "shutdown";

const NO_NOTES: Batch["notes"] = { recovery: false, crash: false, relaunch: false };

type StartupOutcome =
  | { kind: "ok" }
  | {
      kind: "failed";
      exitCode: number | null;
      signal: string | null;
      stderr: string;
      timedOut: boolean;
      errorMessage?: string;
    }
  | { kind: "closed"; reason: ClosingReason };

interface LaunchSnapshot {
  fingerprint: string;
  cwd: string;
  addDirs: string[];
  model: string | null;
  effort: string | null;
}

type RpcPhase = "initialize" | "thread_resume" | "thread_start" | "turn_start" | "turn_interrupt";

interface Proc {
  child: ChildProcessWithoutNullStreams;
  resume: boolean;
  launched: LaunchSnapshot;
  launchConfig: CodexLaunchConfig;
  readonly: boolean;
  threadId: string | null;
  initSeen: boolean;
  stderr: string;
  closing: ClosingReason | null;
  startTimedOut: boolean;
  killTimer: NodeJS.Timeout | null;
  pendingRpcs: Map<number | string, RpcPhase>;
  ready: Promise<StartupOutcome>;
  resolveReady: (o: StartupOutcome) => void;
  exited: Promise<void>;
}

interface SessionState {
  id: SessionId;
  proc: Proc | null;
  inFlight: Batch | null;
  selfTurn: boolean;
  activeTurnId: string | null;
  /** 单调递增的轮次计数，保证跨轮或重启后即使 codex 复用 item.id，发出的事件 uuid 依然绝对唯一。 */
  turnSeq: number;
  turnInterrupted: boolean;
  stopRequested: boolean;
  pending: PendingEntry[];
  written: Set<MessageId>;
  recoveryNote: boolean;
  crashNote: boolean;
  relaunchNote: boolean;
  ended: boolean;
  ending: Promise<void> | null;
  settleWaiters: Array<() => void>;
  starting: Promise<void> | null;
  startTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  interruptTimer: NodeJS.Timeout | null;
  interruptRequestId: number | string | null;
  interruptWaiters: Array<() => void>;
  lastEventWrite: number;
  turnUsage: TurnUsage;
  lastTurnResultUsage: Record<string, number> | null;
  usageLatest: TokenUsage | null;
  usagePushedAt: number;
  usageTimer: NodeJS.Timeout | null;
  /** 按 itemId 缓存当前轮的 agentMessage 增量文本，在 item/completed 或 turn/completed 时一次性发出完整 agent.text。 */
  agentMessageBuffers: Map<string, string>;
  /** 当前轮已经发过 agent.text 的 itemId 集合，避免重复发送。 */
  emittedMessageIds: Set<string>;
  /** 当前轮已经发过 agent.thinking 的 itemId 集合，避免每个 delta 刷屏。 */
  emittedThinkingIds: Set<string>;
}

export interface CodexDriverOptions extends Omit<DriverOptions, "claudePath"> {
  /** codex 可执行文件路径，默认 "codex"（若未传但传了 claudePath 则回退 claudePath）。 */
  codexPath?: string;
  claudePath?: string;
  /** 厂商命令与输入拼装器，默认 vendors/ 里的 codex。 */
  composer?: VendorComposerBase;
}

export class CodexDriver implements Driver {
  readonly #codexPath: string;
  readonly #stateDir: string;
  readonly #opts: Required<
    Pick<
      DriverOptions,
      "idleCloseMs" | "interruptGraceMs" | "startTimeoutMs" | "shutdownGraceMs" | "commandsTimeoutMs" | "log"
    >
  > &
    Omit<DriverOptions, "claudePath">;
  readonly #composer: VendorComposerBase;
  readonly #sessions = new Map<SessionId, SessionState>();
  readonly #listeners = new Set<DriverEventListener>();
  #shuttingDown = false;
  #requestSeq = 0;
  #reportingListenerError = false;

  constructor({ codexPath, claudePath, composer, ...options }: CodexDriverOptions) {
    this.#codexPath = codexPath ?? claudePath ?? "codex";
    this.#stateDir = options.stateDir;
    this.#composer = composer ?? composerBaseOf("codex")!;
    this.#opts = {
      idleCloseMs: IDLE_CLOSE_MS,
      interruptGraceMs: INTERRUPT_GRACE_MS,
      startTimeoutMs: START_TIMEOUT_MS,
      shutdownGraceMs: SHUTDOWN_GRACE_MS,
      commandsTimeoutMs: RUNNING_COMMANDS_TIMEOUT_MS,
      log: (line: string) => console.error(line),
      ...options,
    };
  }

  onEvent(listener: DriverEventListener): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  isRunning(sessionId: SessionId): boolean {
    const proc = this.#sessions.get(sessionId)?.proc;
    return Boolean(proc && !proc.closing);
  }

  async start(sessionId: SessionId): Promise<void> {
    this.#assertRunning();
    const st = this.#state(sessionId);
    this.#assertNotEnded(st);
    for (;;) {
      if (st.starting) return st.starting;
      this.#assertNotEnded(st);
      const proc = st.proc;
      if (proc?.closing) {
        await proc.exited;
        this.#assertRunning();
        continue;
      }
      if (proc) {
        if (proc.initSeen || st.inFlight) return;
        const batch = this.#takeBatch(st);
        return batch ? this.#runStartup(st, batch, proc) : undefined;
      }
      const batch = this.#takeBatch(st);
      if (batch) return this.#runStartup(st, batch, null);
      const promise: Promise<void> = this.#spawnAndHandshake(st, this.#resumeFor(st), null)
        .then((p) => {
          this.#abortIfStopped(st, p);
          this.#armIdle(st, p);
        })
        .finally(() => {
          if (st.starting === promise) st.starting = null;
        });
      st.starting = promise;
      return promise;
    }
  }

  async send(sessionId: SessionId, input: DriverSendInput): Promise<DriverSendResult> {
    this.#assertRunning();
    const st = this.#state(sessionId);
    this.#assertNotEnded(st);
    const ids = input.messageIds;
    if (ids.length === 0) {
      this.#invalidInput(st, "messageIds 是空的", ids);
      return { kind: "rejected" };
    }
    if (ids.every((id) => st.written.has(id))) return { kind: "written" };
    const entry: PendingEntry = {
      messageIds: ids,
      source: input.source,
      text: input.text,
      prefixes: input.prefixes ?? [],
      resend: input.resend ?? false,
    };
    const parts = entryParts(entry);
    const problem = checkCodexTurnText(combineCodexTurnText(parts.text, parts.prefixes));
    if (problem) {
      this.#invalidInput(st, problem, ids);
      return { kind: "rejected" };
    }
    if (!this.#isPending(st, ids)) {
      st.pending.push(entry);
      if (input.recovery) st.recoveryNote = true;
    }
    await this.#pump(st);
    return ids.every((id) => st.written.has(id)) ? { kind: "written" } : { kind: "queued" };
  }

  end(sessionId: SessionId): Promise<void> {
    const st = this.#state(sessionId);
    if (st.ending) return st.ending;
    st.ended = true;
    st.pending = [];
    st.recoveryNote = false;
    st.crashNote = false;
    st.relaunchNote = false;
    this.#clearTimer(st, "idleTimer");
    st.ending = this.#finishEnd(st);
    return st.ending;
  }

  async #finishEnd(st: SessionState): Promise<void> {
    for (;;) {
      if (st.starting) {
        await st.starting.catch(() => {});
        continue;
      }
      const proc = st.proc;
      if (proc && this.#busy(st) && !proc.closing) {
        await new Promise<void>((resolve) => st.settleWaiters.push(resolve));
        continue;
      }
      break;
    }
    const proc = st.proc;
    if (proc) {
      this.#clearTimer(st, "idleTimer");
      if (!proc.closing) this.#closeStdin(st, proc, "idle");
      await proc.exited;
    }
    this.#update(st, { status: "ended", pid: null });
  }

  async interrupt(sessionId: SessionId): Promise<void> {
    const st = this.#sessions.get(sessionId);
    const proc = st?.proc;
    if (!st || !proc || !this.#busy(st) || proc.closing) return;
    st.stopRequested = true;
    st.turnInterrupted = true;
    const done = new Promise<void>((resolve) => st.interruptWaiters.push(resolve));
    if (st.interruptRequestId === null) {
      const reqId = ++this.#requestSeq;
      st.interruptRequestId = reqId;
      if (proc.threadId && st.activeTurnId) {
        proc.pendingRpcs.set(reqId, "turn_interrupt");
        proc.child.stdin.write(buildTurnInterruptRequest(reqId, proc.threadId, st.activeTurnId) + "\n");
      }
      st.interruptTimer = setTimeout(() => {
        st.interruptTimer = null;
        this.#sigintForInterrupt(st, proc);
      }, this.#opts.interruptGraceMs);
    }
    return done;
  }

  queryCommands(_sessionId: SessionId): Promise<ComposerCommand[] | null> {
    return Promise.resolve([]);
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    const procs: Proc[] = [];
    for (const st of this.#sessions.values()) {
      this.#clearTimer(st, "idleTimer");
      this.#clearTimer(st, "interruptTimer");
      const proc = st.proc;
      if (!proc) continue;
      procs.push(proc);
      clearKillTimer(proc);
      if (proc.closing === "shutdown" || proc.closing === "interrupt") continue;
      if (st.stopRequested && this.#busy(st)) {
        proc.closing = "interrupt";
        proc.child.kill("SIGINT");
        continue;
      }
      const wasIdle = proc.closing === "idle" || (!this.#busy(st) && proc.initSeen);
      proc.closing = "shutdown";
      if (wasIdle) proc.child.stdin.end();
      else proc.child.kill("SIGINT");
    }
    if (procs.length > 0) {
      const all = Promise.all(procs.map((p) => p.exited));
      if ((await within(all, this.#opts.shutdownGraceMs)) === "timeout") {
        await Promise.all(procs.map((p) => forceKill(p.child)));
        await within(all, KILL_WAIT_MS);
      }
    }
  }

  async cleanupStale(): Promise<void> {
    let rows: AgentSessionRow[];
    try {
      rows = this.#opts.store.listWithProcess();
    } catch (error) {
      throw new DriverError("internal_error", `listWithProcess failed: ${errorMessage(error)}`);
    }
    const codexRows = rows.filter((row) => row.vendor === "codex");
    await Promise.all(codexRows.map((row) => this.#cleanupStaleRow(row)));
  }

  async #cleanupStaleRow(row: AgentSessionRow): Promise<void> {
    if (row.vendor !== "codex") return;
    const pid = row.pid;
    if (pid === null) return;
    if (this.#sessions.get(row.id)?.proc?.child.pid === pid) return;
    const pgid = await codexOfSession(pid);
    if (pgid !== null) {
      signalPid(pid, "SIGINT");
      if (!(await waitForExit(pid, this.#opts.interruptGraceMs))) {
        await forceKillTree(pid, pgid === pid);
        await waitForExit(pid, KILL_WAIT_MS);
      }
    }
    this.#update(this.#state(row.id), { pid: null, status: row.status === "ended" ? "ended" : "idle" });
  }

  // --- 队列与批次调度 ---

  #state(id: SessionId): SessionState {
    let st = this.#sessions.get(id);
    if (!st) {
      st = {
        id,
        proc: null,
        inFlight: null,
        selfTurn: false,
        activeTurnId: null,
        turnSeq: 0,
        turnInterrupted: false,
        stopRequested: false,
        pending: [],
        written: new Set(),
        recoveryNote: false,
        crashNote: false,
        relaunchNote: false,
        ended: false,
        ending: null,
        settleWaiters: [],
        starting: null,
        startTimer: null,
        idleTimer: null,
        interruptTimer: null,
        interruptRequestId: null,
        interruptWaiters: [],
        lastEventWrite: 0,
        turnUsage: new TurnUsage(),
        lastTurnResultUsage: null,
        usageLatest: null,
        usagePushedAt: 0,
        usageTimer: null,
        agentMessageBuffers: new Map(),
        emittedMessageIds: new Set(),
        emittedThinkingIds: new Set(),
      };
      this.#sessions.set(id, st);
    }
    return st;
  }

  #isPending(st: SessionState, ids: MessageId[]): boolean {
    const covers = (batchIds: MessageId[]) => ids.every((id) => batchIds.includes(id));
    if (st.inFlight && covers(st.inFlight.messageIds)) return true;
    return st.pending.some((e) => covers(e.messageIds));
  }

  #takeBatch(st: SessionState): Batch | null {
    let body: { prefixes: string[]; text: string } | null = null;
    let messageIds: MessageId[] = [];
    let command = false;
    const users = st.pending.filter((e) => e.source === "user");
    if (users.length > 0) {
      const isCommand = (e: PendingEntry) => this.#composer.isCommand(e.text);
      const firstCommand = users.findIndex(isCommand);
      command = firstCommand === 0;
      const take = command ? users.slice(0, 1) : firstCommand === -1 ? users : users.slice(0, firstCommand);
      st.pending = st.pending.filter((e) => !take.includes(e));
      body = take.length === 1 ? entryParts(take[0]!) : mergeUserTexts(take.map(flatEntryText));
      messageIds = take.flatMap((e) => e.messageIds);
    } else if (st.pending.length > 0) {
      const entry = st.pending.shift()!;
      body = entryParts(entry);
      messageIds = entry.messageIds;
    }
    if (body === null) return null;
    if (command) {
      return {
        messageIds,
        combinedText: combineCodexTurnText(body.text, body.prefixes),
        notes: NO_NOTES,
        delivered: false,
        processing: false,
      };
    }
    const notes = { recovery: st.recoveryNote, crash: st.crashNote, relaunch: st.relaunchNote };
    const prefixes = [
      notes.recovery ? RESTART_RECOVERY_NOTE : null,
      notes.crash ? CRASH_RECOVERY_NOTE : null,
      notes.relaunch ? RELAUNCH_NOTE : null,
    ].filter((p): p is string => p !== null);
    st.recoveryNote = false;
    st.crashNote = false;
    st.relaunchNote = false;
    return {
      messageIds,
      combinedText: combineCodexTurnText(body.text, [...prefixes, ...body.prefixes]),
      notes,
      delivered: false,
      processing: false,
    };
  }

  #dropBatch(st: SessionState, batch: Batch): void {
    if (st.inFlight === batch) st.inFlight = null;
    if (batch.notes.recovery) st.recoveryNote = true;
    if (batch.notes.crash) st.crashNote = true;
    if (batch.notes.relaunch) st.relaunchNote = true;
  }

  async #pump(st: SessionState): Promise<void> {
    for (;;) {
      this.#assertRunning();
      this.#assertNotEnded(st);
      if (st.starting) return;
      const proc = st.proc;
      if (proc?.closing) {
        await proc.exited;
        continue;
      }
      if (proc && this.#busy(st)) return;
      if (st.pending.length === 0) return;
      if (proc) {
        await this.#deliverNext(st, proc);
        continue;
      }
      const batch = this.#takeBatch(st);
      if (!batch) return;
      return this.#runStartup(st, batch, null);
    }
  }

  #deliverNext(st: SessionState, proc: Proc): Promise<void> {
    const run = async () => {
      this.#clearTimer(st, "idleTimer");
      let files: LaunchFiles | null = null;
      try {
        files = await this.#opts.prepareLaunch(this.#store(st));
      } catch (error) {
        this.#internalError(
          st.id,
          `prepareLaunch before writing failed, keeping the running process: ${errorMessage(error)}`,
        );
      }
      this.#assertRunning();
      if (st.ended || st.proc !== proc || proc.closing || this.#busy(st)) return;
      const row = files ? this.#row(st) : null;
      if (files && row && launchChanged(proc.launched, row, files.fingerprint)) {
        this.#closeStdin(st, proc, "idle");
        await proc.exited;
        this.#assertRunning();
        if (st.ended) return;
        st.relaunchNote = true;
        const batch = this.#takeBatch(st);
        if (batch) await this.#startup(st, batch, null, files);
        return;
      }
      const batch = this.#takeBatch(st);
      if (!batch) return;
      if (proc.initSeen) await this.#writeBatch(st, proc, batch);
      else await this.#startup(st, batch, proc, null);
    };
    const promise: Promise<void> = run().finally(() => {
      if (st.starting === promise) st.starting = null;
    });
    st.starting = promise;
    return promise;
  }

  async #writeBatch(st: SessionState, proc: Proc, batch: Batch): Promise<void> {
    const problem = checkCodexTurnText(batch.combinedText);
    if (problem) {
      this.#invalidInput(st, problem, batch.messageIds);
      this.#afterTurn(st, proc);
      return;
    }
    const row = this.#row(st);
    const threadId = proc.threadId ?? row?.vendorSessionId;
    if (!threadId) {
      this.#invalidInput(st, "缺少 threadId", batch.messageIds);
      this.#afterTurn(st, proc);
      return;
    }
    this.#clearTimer(st, "idleTimer");
    st.inFlight = batch;
    st.turnSeq += 1;
    st.turnInterrupted = false;
    st.stopRequested = false;
    st.agentMessageBuffers.clear();
    st.emittedMessageIds.clear();
    st.emittedThinkingIds.clear();
    st.lastTurnResultUsage = null;

    const reqId = ++this.#requestSeq;
    proc.pendingRpcs.set(reqId, "turn_start");
    const line = buildTurnStartRequest(reqId, {
      threadId,
      combinedText: batch.combinedText,
      session: {
        cwd: row?.cwd ?? proc.launched.cwd,
        addDirs: row?.addDirs ?? proc.launched.addDirs,
        model: row?.model ?? proc.launched.model,
        effort: row?.effort ?? proc.launched.effort,
      },
      readonly: proc.readonly,
    });
    await new Promise<void>((resolve) => {
      proc.child.stdin.write(line + "\n", (err) => {
        if (!err) this.#markDelivered(st, batch);
        resolve();
      });
    });
  }

  #markDelivered(st: SessionState, batch: Batch): void {
    if (batch.delivered) return;
    batch.delivered = true;
    for (const id of batch.messageIds) st.written.add(id);
    if (batch.messageIds.length > 0) {
      this.#emit(st.id, { type: "message.delivered", messageIds: batch.messageIds, at: Date.now() });
    }
  }

  #markProcessing(st: SessionState, batch: Batch, at: number): void {
    this.#markDelivered(st, batch);
    if (batch.processing || batch.messageIds.length === 0) return;
    batch.processing = true;
    this.#emit(st.id, { type: "message.processing", messageIds: batch.messageIds, at });
  }

  #forgetWritten(st: SessionState, batch: Batch | null): void {
    for (const id of batch?.messageIds ?? []) st.written.delete(id);
  }

  #afterTurn(st: SessionState, proc: Proc): void {
    if (st.proc !== proc || proc.closing || this.#shuttingDown || st.ended) return;
    if (st.pending.length > 0) void this.#deliverNext(st, proc).catch(() => {});
    else this.#armIdle(st, proc);
  }

  #busy(st: SessionState): boolean {
    return st.inFlight !== null || st.selfTurn;
  }

  #settled(st: SessionState): void {
    for (const w of st.settleWaiters.splice(0)) w();
  }

  #armIdle(st: SessionState, proc: Proc): void {
    this.#clearTimer(st, "idleTimer");
    st.idleTimer = setTimeout(() => {
      st.idleTimer = null;
      if (st.proc !== proc || proc.closing || this.#busy(st) || st.pending.length > 0 || st.starting || st.ended) return;
      this.#closeStdin(st, proc, "idle");
    }, this.#opts.idleCloseMs);
  }

  #closeStdin(st: SessionState, proc: Proc, reason: ClosingReason): void {
    proc.closing = reason;
    proc.child.stdin.end();
    const grace = this.#opts.interruptGraceMs;
    clearKillTimer(proc);
    proc.killTimer = setTimeout(() => {
      proc.child.kill("SIGINT");
      proc.killTimer = setTimeout(() => {
        proc.killTimer = null;
        this.#forceKill(st, proc);
      }, grace);
    }, grace);
  }

  #sigintForInterrupt(st: SessionState, proc: Proc): void {
    if (st.proc !== proc || proc.closing) return;
    proc.closing = "interrupt";
    proc.child.kill("SIGINT");
    clearKillTimer(proc);
    proc.killTimer = setTimeout(() => {
      proc.killTimer = null;
      this.#forceKill(st, proc);
    }, this.#opts.interruptGraceMs);
  }

  // --- 启动与握手 ---

  #resumeFor(st: SessionState): boolean {
    return this.#store(st).hasCompletedTurn;
  }

  #runStartup(st: SessionState, batch: Batch, existing: Proc | null): Promise<void> {
    const promise: Promise<void> = this.#startup(st, batch, existing, null).finally(() => {
      if (st.starting === promise) st.starting = null;
    });
    st.starting = promise;
    return promise;
  }

  #startup(st: SessionState, batch: Batch, existing: Proc | null, files: LaunchFiles | null): Promise<void> {
    st.inFlight = batch;
    st.turnInterrupted = false;
    st.stopRequested = false;
    const run = async () => {
      try {
        const resume = existing?.resume ?? this.#resumeFor(st);
        const proc = existing ?? (await this.#spawn(st, resume, files));
        this.#abortIfStopped(st, proc);
        this.#clearTimer(st, "idleTimer");
        st.inFlight = batch;
        this.#armStartTimer(st, proc);
        const outcome = await proc.ready;
        if (outcome.kind === "ok") {
          await this.#writeBatch(st, proc, batch);
          return;
        }
        if (outcome.kind === "closed") {
          if (outcome.reason === "interrupt") return;
          throw new DriverError(
            "spawn_failed",
            this.#shuttingDown ? "driver is shutting down" : `closed before thread ready (${outcome.reason})`,
          );
        }
        throw startupError(outcome, this.#opts.startTimeoutMs);
      } catch (error) {
        this.#dropBatch(st, batch);
        throw error;
      }
    };
    return run();
  }

  async #spawnAndHandshake(st: SessionState, resume: boolean, prepared: LaunchFiles | null): Promise<Proc> {
    const proc = await this.#spawn(st, resume, prepared);
    this.#armStartTimer(st, proc);
    const outcome = await proc.ready;
    if (outcome.kind === "ok") return proc;
    if (outcome.kind === "closed") {
      throw new DriverError(
        "spawn_failed",
        this.#shuttingDown ? "driver is shutting down" : `closed before thread ready (${outcome.reason})`,
      );
    }
    throw startupError(outcome, this.#opts.startTimeoutMs);
  }

  #abortIfStopped(st: SessionState, proc: Proc): void {
    this.#assertRunning();
    if (!st.ended) return;
    if (!proc.closing) this.#closeStdin(st, proc, "idle");
    throw new DriverError("session_ended", `session ${st.id} has been ended`);
  }

  #armStartTimer(st: SessionState, proc: Proc): void {
    if (st.startTimer || proc.initSeen) return;
    st.startTimer = setTimeout(() => {
      st.startTimer = null;
      if (st.proc !== proc || proc.initSeen) return;
      proc.startTimedOut = true;
      this.#forceKill(st, proc);
    }, this.#opts.startTimeoutMs);
  }

  async #spawn(st: SessionState, resume: boolean, prepared: LaunchFiles | null): Promise<Proc> {
    let row = this.#store(st);
    let files = prepared;
    if (!files) {
      try {
        files = await this.#opts.prepareLaunch(row);
      } catch (error) {
        if (error instanceof DriverError && error.code === "session_ended") throw error;
        throw new DriverError("spawn_failed", `prepareLaunch failed: ${errorMessage(error)}`);
      }
      row = this.#store(st);
    }
    this.#assertRunning();
    this.#assertNotEnded(st);
    if (!existsSync(row.cwd)) throw new DriverError("spawn_failed", `working directory does not exist: ${row.cwd}`);

    const launchConfig = readCodexLaunchConfig(files);
    const child = spawn(this.#codexPath, buildCodexArgs(), {
      cwd: row.cwd,
      env: buildChildEnv(process.env, { ...this.#opts.env, ...files.env }),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new DriverError("claude_not_found", `${this.#codexPath}: ${errorMessage(error)}`);
      }
      throw new DriverError("spawn_failed", `${this.#codexPath}: ${errorMessage(error)}`);
    }
    if (this.#shuttingDown) {
      killFreshGroup(child);
      this.#assertRunning();
    }

    let resolveReady!: (o: StartupOutcome) => void;
    let resolveExited!: () => void;
    const proc: Proc = {
      child,
      resume,
      launched: {
        fingerprint: files.fingerprint,
        cwd: row.cwd,
        addDirs: [...row.addDirs],
        model: row.model,
        effort: row.effort,
      },
      launchConfig,
      readonly: launchConfig.readonly,
      threadId: resume ? row.vendorSessionId : null,
      initSeen: false,
      stderr: "",
      closing: null,
      startTimedOut: false,
      killTimer: null,
      pendingRpcs: new Map(),
      ready: new Promise((resolve) => (resolveReady = resolve)),
      resolveReady: (o) => resolveReady(o),
      exited: new Promise((resolve) => (resolveExited = resolve)),
    };
    st.proc = proc;
    this.#update(st, { pid: child.pid ?? null });

    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      proc.stderr = (proc.stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });

    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      for (let nl = buffered.indexOf("\n"); nl >= 0; nl = buffered.indexOf("\n")) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        this.#handleLine(st, proc, line);
      }
    });

    const drained = Promise.all([streamClosed(child.stdout), streamClosed(child.stderr)]);
    child.once("exit", (code, signal) => {
      if (proc.closing === "idle") termGroupAfterExit(child);
      const timer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, STDIO_DRAIN_MS);
      void drained.then(() => {
        clearTimeout(timer);
        if (buffered !== "") this.#handleLine(st, proc, buffered);
        buffered = "";
        this.#onClose(st, proc, code, signal, resolveExited);
      });
    });

    // 发送握手第 1 步：initialize
    const initId = ++this.#requestSeq;
    proc.pendingRpcs.set(initId, "initialize");
    child.stdin.write(buildInitializeRequest(initId) + "\n");

    return proc;
  }

  // --- JSON-RPC 2.0 输出处理 ---

  #handleLine(st: SessionState, proc: Proc, rawLine: string): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    try {
      this.#onLine(st, proc, line);
    } catch (error) {
      this.#internalError(st.id, `handling output line failed: ${errorMessage(error)}`);
    }
  }

  #onLine(st: SessionState, proc: Proc, line: string): void {
    if (line.trim() === "") return;
    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      obj = parsed as Record<string, unknown>;
    } catch {
      this.#emit(st.id, {
        type: "driver.error",
        code: "bad_output_line",
        message: `bad_output_line: ${line.slice(0, 200)}`,
        at: Date.now(),
      });
      return;
    }

    const at = Date.now();
    this.#touch(st, at);

    const hasId = obj.id !== undefined && obj.id !== null;
    const hasMethod = typeof obj.method === "string" && obj.method !== "";

    // 1. 反向 RPC 请求（Server -> Client Request：带 id 与 method）
    if (hasId && hasMethod) {
      this.#onServerRequest(st, proc, obj.id as number | string, obj.method as string, obj.params, at);
      return;
    }

    // 2. 客户端请求的响应（Server -> Client Response：带 id，无 method）
    if (hasId && !hasMethod) {
      this.#onRpcResponse(st, proc, obj.id as number | string, obj, at);
      return;
    }

    // 3. 服务端通知（Server -> Client Notification：带 method，无 id）
    if (hasMethod) {
      this.#onNotification(st, proc, obj.method as string, obj.params, line, at);
    }
  }

  #onRpcResponse(
    st: SessionState,
    proc: Proc,
    id: number | string,
    obj: Record<string, unknown>,
    at: number,
  ): void {
    const phase = proc.pendingRpcs.get(id);
    if (!phase) return;
    proc.pendingRpcs.delete(id);

    const errorObj = typeof obj.error === "object" && obj.error !== null ? (obj.error as Record<string, unknown>) : null;
    const resultObj =
      typeof obj.result === "object" && obj.result !== null ? (obj.result as Record<string, unknown>) : null;

    switch (phase) {
      case "initialize": {
        if (errorObj) {
          proc.resolveReady({
            kind: "failed",
            exitCode: null,
            signal: null,
            stderr: proc.stderr,
            timedOut: false,
            errorMessage: typeof errorObj.message === "string" ? errorObj.message : "initialize failed",
          });
          this.#forceKill(st, proc);
          return;
        }
        // 第 2 步：发 initialized 通知
        proc.child.stdin.write(buildInitializedNotification() + "\n");
        // 第 3 步：建立或恢复线程
        const row = this.#row(st);
        const sessionInfo = {
          vendorSessionId: row?.vendorSessionId ?? proc.threadId ?? "",
          cwd: row?.cwd ?? proc.launched.cwd,
          model: row?.model ?? proc.launched.model,
        };
        const nextId = ++this.#requestSeq;
        if (proc.resume) {
          proc.pendingRpcs.set(nextId, "thread_resume");
          proc.child.stdin.write(buildThreadResumeRequest(nextId, sessionInfo, proc.launchConfig) + "\n");
        } else {
          proc.pendingRpcs.set(nextId, "thread_start");
          proc.child.stdin.write(buildThreadStartRequest(nextId, sessionInfo, proc.launchConfig) + "\n");
        }
        return;
      }

      case "thread_resume": {
        if (errorObj) {
          // thread/resume 报错（如 not found / no rollout found）：自动回退发 thread/start 开启新线程
          proc.resume = false;
          proc.threadId = null;
          const row = this.#row(st);
          const sessionInfo = {
            cwd: row?.cwd ?? proc.launched.cwd,
            model: row?.model ?? proc.launched.model,
          };
          const startId = ++this.#requestSeq;
          proc.pendingRpcs.set(startId, "thread_start");
          proc.child.stdin.write(buildThreadStartRequest(startId, sessionInfo, proc.launchConfig) + "\n");
          return;
        }
        const thread =
          typeof resultObj?.thread === "object" && resultObj.thread !== null
            ? (resultObj.thread as Record<string, unknown>)
            : null;
        const threadId =
          typeof thread?.id === "string" && thread.id !== "" ? thread.id : proc.threadId;
        const model =
          typeof thread?.model === "string" && thread.model !== ""
            ? thread.model
            : (this.#row(st)?.model ?? proc.launched.model);
        this.#completeThreadHandshake(st, proc, threadId, model, true, at);
        return;
      }

      case "thread_start": {
        if (errorObj) {
          proc.resolveReady({
            kind: "failed",
            exitCode: null,
            signal: null,
            stderr: proc.stderr,
            timedOut: false,
            errorMessage: typeof errorObj.message === "string" ? errorObj.message : "thread/start failed",
          });
          this.#forceKill(st, proc);
          return;
        }
        const thread =
          typeof resultObj?.thread === "object" && resultObj.thread !== null
            ? (resultObj.thread as Record<string, unknown>)
            : null;
        const threadId =
          typeof thread?.id === "string" && thread.id !== "" ? thread.id : proc.threadId;
        const model =
          typeof thread?.model === "string" && thread.model !== ""
            ? thread.model
            : (this.#row(st)?.model ?? proc.launched.model);
        this.#completeThreadHandshake(st, proc, threadId, model, false, at);
        return;
      }

      case "turn_start": {
        if (errorObj) {
          const batch = st.inFlight;
          st.inFlight = null;
          if (batch) {
            this.#markProcessing(st, batch, at);
            this.#forgetWritten(st, batch);
          }
          const errMsg = typeof errorObj.message === "string" ? errorObj.message : "turn/start failed";
          this.#emit(st.id, {
            type: "turn.ended",
            ok: false,
            interrupted: false,
            messageIds: batch?.messageIds ?? [],
            durationMs: null,
            error: { subtype: "turn_start_error", message: errMsg },
            at,
          });
          this.#afterTurn(st, proc);
          this.#settled(st);
          return;
        }
        const turn =
          typeof resultObj?.turn === "object" && resultObj.turn !== null
            ? (resultObj.turn as Record<string, unknown>)
            : null;
        const turnId = typeof turn?.id === "string" && turn.id !== "" ? turn.id : null;
        if (turnId) st.activeTurnId = turnId;
        if (st.inFlight) this.#markProcessing(st, st.inFlight, at);
        return;
      }

      case "turn_interrupt": {
        if (errorObj) {
          this.#clearTimer(st, "interruptTimer");
          this.#sigintForInterrupt(st, proc);
        }
        return;
      }
    }
  }

  #completeThreadHandshake(
    st: SessionState,
    proc: Proc,
    threadId: string | null,
    model: string | null,
    resumed: boolean,
    at: number,
  ): void {
    if (threadId) {
      proc.threadId = threadId;
    }
    if (proc.initSeen) return;
    proc.initSeen = true;
    proc.resume = resumed;
    this.#clearTimer(st, "startTimer");

    const patch: AgentSessionPatch = {
      status: "running",
      lastEventAt: at,
      ...(proc.threadId ? { vendorSessionId: proc.threadId } : {}),
    };
    const row = this.#row(st);
    if (row && row.hasCompletedTurn !== resumed) {
      patch.hasCompletedTurn = resumed;
    }
    this.#update(st, patch);
    this.#emit(st.id, {
      type: "session.started",
      resumed,
      model,
      tools: [],
      at,
    });
    proc.resolveReady({ kind: "ok" });
  }

  #onNotification(
    st: SessionState,
    proc: Proc,
    method: string,
    rawParams: unknown,
    rawLine: string,
    at: number,
  ): void {
    const params =
      typeof rawParams === "object" && rawParams !== null ? (rawParams as Record<string, unknown>) : {};

    switch (method) {
      case "thread/started": {
        const thread =
          typeof params.thread === "object" && params.thread !== null
            ? (params.thread as Record<string, unknown>)
            : null;
        const threadId = typeof thread?.id === "string" && thread.id !== "" ? thread.id : null;
        if (threadId) {
          proc.threadId = threadId;
          this.#update(st, { vendorSessionId: threadId });
        }
        return;
      }

      case "turn/started": {
        const turn =
          typeof params.turn === "object" && params.turn !== null
            ? (params.turn as Record<string, unknown>)
            : null;
        const turnId = typeof turn?.id === "string" && turn.id !== "" ? turn.id : null;
        if (turnId) st.activeTurnId = turnId;
        if (st.inFlight) {
          this.#markProcessing(st, st.inFlight, at);
        } else if (!st.selfTurn && st.proc === proc) {
          st.selfTurn = true;
          st.turnSeq += 1;
          this.#clearTimer(st, "idleTimer");
          this.#emit(st.id, { type: "turn.started", at });
        }
        return;
      }

      case "item/started": {
        const item =
          typeof params.item === "object" && params.item !== null
            ? (params.item as Record<string, unknown>)
            : null;
        if (!item) return;
        if (item.type === "reasoning") {
          const itemId = typeof item.id === "string" && item.id !== "" ? item.id : lineUuid(item, rawLine);
          this.#emitThinkingOnce(st, itemId, at);
          return;
        }
        if (item.type === "agentMessage") {
          const itemId = typeof item.id === "string" && item.id !== "" ? item.id : "agent-msg";
          if (!st.agentMessageBuffers.has(itemId)) {
            st.agentMessageBuffers.set(itemId, "");
          }
          return;
        }
        if (isCodexToolItemType(item.type)) {
          const rawId = typeof item.id === "string" && item.id !== "" ? item.id : null;
          const toolEv = rawId ? parseCodexToolStarted(item, at, this.#scopedUuid(st, rawId)) : null;
          if (toolEv) this.#emit(st.id, toolEv);
        }
        return;
      }

      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const itemId =
          typeof params.itemId === "string" && params.itemId !== ""
            ? params.itemId
            : lineUuid(params, rawLine);
        this.#emitThinkingOnce(st, itemId, at);
        return;
      }

      case "item/agentMessage/delta": {
        const itemId = typeof params.itemId === "string" && params.itemId !== "" ? params.itemId : "agent-msg";
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (delta !== "") {
          const prev = st.agentMessageBuffers.get(itemId) ?? "";
          st.agentMessageBuffers.set(itemId, prev + delta);
        }
        return;
      }

      case "item/completed": {
        const item =
          typeof params.item === "object" && params.item !== null
            ? (params.item as Record<string, unknown>)
            : null;
        if (!item) return;
        if (item.type === "agentMessage") {
          const itemId = typeof item.id === "string" && item.id !== "" ? item.id : "agent-msg";
          const buffered = st.agentMessageBuffers.get(itemId) ?? "";
          st.agentMessageBuffers.delete(itemId);
          const fullText = typeof item.text === "string" && item.text !== "" ? item.text : buffered;
          if (fullText.trim() !== "" && !st.emittedMessageIds.has(itemId)) {
            st.emittedMessageIds.add(itemId);
            this.#emit(st.id, { type: "agent.text", uuid: this.#scopedUuid(st, itemId), text: fullText, at });
          }
          return;
        }
        if (isCodexToolItemType(item.type)) {
          const id = typeof item.id === "string" && item.id !== "" ? item.id : null;
          if (id) {
            this.#emit(st.id, { type: "agent.tool_result", toolUseIds: [id], at });
          }
        }
        return;
      }

      case "thread/tokenUsage/updated": {
        const parsed = parseCodexTokenUsage(params.tokenUsage, st.activeTurnId);
        if (!parsed) return;
        st.lastTurnResultUsage = parsed.resultUsage;
        const row = this.#row(st);
        const live = row ? st.turnUsage.observe(parsed.observeObj, row.usage) : null;
        if (live) this.#pushUsage(st, live);
        return;
      }

      case "account/rateLimits/updated": {
        const info = parseCodexRateLimits(params.rateLimits);
        if (!info) return;
        this.#update(st, { rateLimit: info });
        this.#emit(st.id, { type: "rate_limit", info, at });
        return;
      }

      case "turn/completed": {
        this.#onTurnCompleted(st, proc, params, at);
        return;
      }
    }
  }

  /** 将当前轮序号与 turnId 拼进 itemId，保证跨轮或重启后即使 codex 复用 itemId，发出的 uuid 也永不冲突。 */
  #scopedUuid(st: SessionState, itemId: string): string {
    const turnPrefix = st.activeTurnId ? `${st.activeTurnId}:${st.turnSeq}` : `turn-${st.turnSeq}`;
    return `${turnPrefix}:${itemId}`;
  }

  #emitThinkingOnce(st: SessionState, itemId: string, at: number): void {
    if (st.emittedThinkingIds.has(itemId)) return;
    st.emittedThinkingIds.add(itemId);
    this.#emit(st.id, { type: "agent.thinking", uuid: this.#scopedUuid(st, itemId), at });
  }

  #onTurnCompleted(st: SessionState, proc: Proc, params: Record<string, unknown>, at: number): void {
    if (!proc.initSeen) return;

    // 若当前轮有未发 item/completed 的累积 agentMessage 增量，先兜底补发完整 agent.text
    for (const [itemId, bufferedText] of st.agentMessageBuffers.entries()) {
      if (bufferedText.trim() !== "" && !st.emittedMessageIds.has(itemId)) {
        st.emittedMessageIds.add(itemId);
        this.#emit(st.id, { type: "agent.text", uuid: this.#scopedUuid(st, itemId), text: bufferedText, at });
      }
    }
    st.agentMessageBuffers.clear();
    st.emittedMessageIds.clear();
    st.emittedThinkingIds.clear();

    const batch = st.inFlight;
    st.inFlight = null;
    st.selfTurn = false;
    st.activeTurnId = null;
    if (batch) this.#markProcessing(st, batch, at);

    const turn =
      typeof params.turn === "object" && params.turn !== null
        ? (params.turn as Record<string, unknown>)
        : {};
    const status = typeof turn.status === "string" ? turn.status : "completed";
    const ok = status === "completed";
    const interrupted = status === "interrupted" || st.turnInterrupted || st.stopRequested;

    const event: DriverEvent = {
      type: "turn.ended",
      ok,
      interrupted,
      messageIds: batch?.messageIds ?? [],
      durationMs: null,
      at,
    };
    if (proc.closing === "shutdown" && (!ok || interrupted)) {
      event.shutdown = true;
    }
    if (!ok) {
      const turnErr =
        typeof turn.error === "object" && turn.error !== null
          ? (turn.error as Record<string, unknown>)
          : null;
      const errMsg =
        typeof turnErr?.message === "string" && turnErr.message !== ""
          ? turnErr.message
          : status;
      event.error = { subtype: status, message: errMsg };
      this.#forgetWritten(st, batch);
    }

    st.turnInterrupted = false;
    st.stopRequested = false;

    const row = this.#row(st);
    this.#cancelUsagePush(st);
    const patch: AgentSessionPatch = {};
    if (st.lastTurnResultUsage) {
      patch.usage = st.turnUsage.finish(row?.usage ?? EMPTY_TOKEN_USAGE, st.lastTurnResultUsage);
      st.lastTurnResultUsage = null;
    } else {
      st.turnUsage.reset();
    }
    if (row?.hasCompletedTurn === false) {
      patch.hasCompletedTurn = true;
    }
    if (Object.keys(patch).length > 0) {
      this.#update(st, patch);
    }

    this.#clearTimer(st, "interruptTimer");
    this.#emit(st.id, event);
    this.#resolveInterrupt(st);
    this.#afterTurn(st, proc);
    this.#settled(st);
  }

  #onServerRequest(
    st: SessionState,
    proc: Proc,
    id: number | string,
    method: string,
    rawParams: unknown,
    _at: number,
  ): void {
    const params =
      typeof rawParams === "object" && rawParams !== null ? (rawParams as Record<string, unknown>) : {};
    const row = this.#row(st);
    const context = {
      role: row?.role ?? "worker",
      readonly: proc.readonly,
      stateDir: this.#stateDir,
      cwd: row?.cwd ?? proc.launched.cwd,
    };

    switch (method) {
      case "item/commandExecution/requestApproval": {
        const decision = decideCommandApproval(params, context);
        proc.child.stdin.write(buildJsonRpcResponse(id, { decision }) + "\n");
        return;
      }
      case "item/fileChange/requestApproval": {
        const decision = decideFileChangeApproval(params, context);
        proc.child.stdin.write(buildJsonRpcResponse(id, { decision }) + "\n");
        return;
      }
      case "item/tool/requestUserInput": {
        proc.child.stdin.write(buildJsonRpcResponse(id, { answers: {} }) + "\n");
        return;
      }
      default: {
        proc.child.stdin.write(buildJsonRpcResponse(id, { decision: "decline" }) + "\n");
        return;
      }
    }
  }

  #onClose(
    st: SessionState,
    proc: Proc,
    code: number | null,
    signal: NodeJS.Signals | null,
    resolveExited: () => void,
  ): void {
    try {
      if (st.proc === proc) st.proc = null;
      clearKillTimer(proc);
      this.#clearTimer(st, "startTimer");
      this.#clearTimer(st, "idleTimer");
      this.#clearTimer(st, "interruptTimer");
      this.#flushUsage(st);
      st.turnUsage.reset();
      st.lastTurnResultUsage = null;
      st.agentMessageBuffers.clear();
      st.emittedMessageIds.clear();
      st.emittedThinkingIds.clear();
      this.#update(st, { pid: null, status: "idle", lastEventAt: Date.now() });
      const at = Date.now();
      if (!proc.initSeen) {
        if (proc.closing === null) {
          this.#forgetWritten(st, st.inFlight);
          proc.resolveReady({
            kind: "failed",
            exitCode: code,
            signal,
            stderr: proc.stderr,
            timedOut: proc.startTimedOut,
          });
          this.#emit(st.id, {
            type: "session.exited",
            reason: "startup_failed",
            exitCode: code,
            signal,
            hadResult: false,
            messageIds: [],
            at,
          });
          return;
        }
        if (proc.closing === "interrupt" && st.inFlight) this.#markDelivered(st, st.inFlight);
        proc.resolveReady({ kind: "closed", reason: proc.closing });
      }
      const batch = proc.initSeen || proc.closing === "interrupt" ? st.inFlight : null;
      st.inFlight = null;
      st.selfTurn = false;
      st.activeTurnId = null;
      const reason: SessionExitReason = proc.closing ?? "crash";
      if (batch && reason === "crash") {
        st.crashNote = true;
        this.#forgetWritten(st, batch);
      }
      st.interruptRequestId = null;
      st.stopRequested = false;
      this.#emit(st.id, {
        type: "session.exited",
        reason,
        exitCode: code,
        signal,
        hadResult: batch === null,
        messageIds: batch?.messageIds ?? [],
        at,
      });
    } finally {
      this.#resolveInterrupt(st);
      resolveExited();
      this.#settled(st);
    }
  }

  // --- 内部辅助 ---

  #resolveInterrupt(st: SessionState): void {
    st.interruptRequestId = null;
    for (const w of st.interruptWaiters.splice(0)) w();
  }

  #invalidInput(st: SessionState, problem: string, messageIds: MessageId[]): void {
    this.#emit(st.id, {
      type: "driver.error",
      code: "invalid_input",
      message: `invalid_input: ${problem}`,
      messageIds,
      at: Date.now(),
    });
  }

  #forceKill(st: SessionState, proc: Proc): void {
    forceKill(proc.child).catch((error: unknown) =>
      this.#internalError(st.id, `force kill failed: ${errorMessage(error)}`),
    );
  }

  #internalError(sessionId: SessionId, detail: string): void {
    this.#emit(sessionId, {
      type: "driver.error",
      code: "internal_error",
      message: `internal_error: ${detail}`,
      at: Date.now(),
    });
  }

  #store(st: SessionState): AgentSessionRow {
    let row: AgentSessionRow | null;
    try {
      row = this.#opts.store.get(st.id);
    } catch (error) {
      throw new DriverError("internal_error", `reading agent session ${st.id} failed: ${errorMessage(error)}`);
    }
    if (!row) throw new DriverError("internal_error", `no agent session ${st.id}`);
    return row;
  }

  #row(st: SessionState): AgentSessionRow | null {
    try {
      return this.#store(st);
    } catch (error) {
      this.#internalError(st.id, errorMessage(error));
      return null;
    }
  }

  #update(st: SessionState, patch: AgentSessionPatch): void {
    if (patch.lastEventAt !== undefined && patch.lastEventAt !== null) st.lastEventWrite = patch.lastEventAt;
    try {
      this.#opts.store.update(st.id, patch);
    } catch (error) {
      this.#internalError(st.id, `updating agent session ${st.id} failed: ${errorMessage(error)}`);
    }
  }

  #pushUsage(st: SessionState, usage: TokenUsage): void {
    st.usageLatest = usage;
    const wait = USAGE_PUSH_MS - (Date.now() - st.usagePushedAt);
    if (wait <= 0) this.#flushUsage(st);
    else if (st.usageTimer === null) {
      st.usageTimer = setTimeout(() => this.#flushUsage(st), wait);
      st.usageTimer.unref();
    }
  }

  #flushUsage(st: SessionState): void {
    const usage = st.usageLatest;
    this.#cancelUsagePush(st);
    if (usage === null) return;
    st.usagePushedAt = Date.now();
    this.#update(st, { usage });
  }

  #cancelUsagePush(st: SessionState): void {
    if (st.usageTimer) clearTimeout(st.usageTimer);
    st.usageTimer = null;
    st.usageLatest = null;
  }

  #touch(st: SessionState, at: number): void {
    if (at - st.lastEventWrite >= LAST_EVENT_WRITE_MS) this.#update(st, { lastEventAt: at });
  }

  #clearTimer(st: SessionState, key: "startTimer" | "idleTimer" | "interruptTimer"): void {
    const timer = st[key];
    if (timer) clearTimeout(timer);
    st[key] = null;
  }

  #emit(sessionId: SessionId, event: DriverEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(sessionId, event);
      } catch (error) {
        this.#listenerFailed(sessionId, event, error);
      }
    }
  }

  #listenerFailed(sessionId: SessionId, event: DriverEvent, error: unknown): void {
    const detail = `listener threw on ${event.type}: ${errorMessage(error)}`;
    if (this.#reportingListenerError) {
      console.error(`[driver] session ${sessionId}: ${detail}`);
      return;
    }
    this.#reportingListenerError = true;
    try {
      this.#internalError(sessionId, detail);
    } finally {
      this.#reportingListenerError = false;
    }
  }

  #assertRunning(): void {
    if (this.#shuttingDown) throw new DriverError("spawn_failed", "driver is shutting down");
  }

  #assertNotEnded(st: SessionState): void {
    if (st.ended || this.#store(st).status === "ended") {
      throw new DriverError("session_ended", `session ${st.id} has been ended`);
    }
  }
}

export function createCodexDriver(options: CodexDriverOptions): CodexDriver {
  return new CodexDriver(options);
}

function entryParts(entry: PendingEntry): { prefixes: string[]; text: string } {
  return { prefixes: entry.resend ? [RESEND_NOTE, ...entry.prefixes] : entry.prefixes, text: entry.text };
}

function flatEntryText(entry: PendingEntry): string {
  const text = [...entry.prefixes, entry.text].join("\n");
  return entry.resend ? `${RESEND_NOTE}\n\n${text}` : text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function startupError(outcome: Extract<StartupOutcome, { kind: "failed" }>, startTimeoutMs: number): DriverError {
  if (outcome.timedOut) return new DriverError("start_timeout", `no codex thread ready within ${startTimeoutMs} ms`);
  const how = outcome.signal ? `signal ${outcome.signal}` : `exit code ${outcome.exitCode}`;
  const detail = outcome.errorMessage ?? outcome.stderr.trim();
  return new DriverError("spawn_failed", `codex exited before thread ready (${how})${detail ? `: ${detail}` : ""}`);
}

function clearKillTimer(proc: Proc): void {
  if (proc.killTimer) clearTimeout(proc.killTimer);
  proc.killTimer = null;
}

async function within(promise: Promise<unknown>, ms: number): Promise<"done" | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([promise.then(() => "done" as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function launchChanged(launched: LaunchSnapshot, row: AgentSessionRow, fingerprint: string): boolean {
  return (
    launched.fingerprint !== fingerprint ||
    launched.cwd !== row.cwd ||
    launched.model !== row.model ||
    launched.effort !== row.effort ||
    launched.addDirs.length !== row.addDirs.length ||
    launched.addDirs.some((d, i) => d !== row.addDirs[i])
  );
}
