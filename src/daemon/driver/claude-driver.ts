// Claude 驱动层（设计第 7.2～7.4 节，按 M0 改过的做法）：每个会话一个官方 claude 进程，
// 我们这边管待发队列（一轮一条、忙时用户连发拼成一条、写入前校验）、打断、空闲关闭、--session-id / --resume。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  DriverError,
  IDLE_CLOSE_MS,
  INTERRUPT_GRACE_MS,
  RESEND_NOTE,
  RESTART_RECOVERY_NOTE,
  SHUTDOWN_GRACE_MS,
  START_TIMEOUT_MS,
  type AgentSessionPatch,
  type Driver,
  type DriverEvent,
  type DriverEventListener,
  type DriverOptions,
  type DriverSendInput,
  type DriverSendResult,
  type DriverStartOptions,
  type MessageId,
  type MessageSource,
  type SessionExitReason,
  type SessionId,
  type Unsubscribe,
} from "../../shared/index.ts";
import {
  buildChildEnv,
  buildClaudeArgs,
  buildInterruptLine,
  buildUserLine,
  checkUserLine,
  detectArgsConflict,
  isInterruptMarker,
  mergeUserTexts,
  parseAssistant,
  parseRateLimit,
} from "./protocol.ts";

/** 进程上一轮没等到 result 就退出了（崩溃）：加在下一条写进去的消息前面。 */
export const CRASH_RECOVERY_NOTE = "【系统】你的进程上一轮意外退出了，那一轮可能没做完。请先看一下工作区现在的状态，再接着做。";

/** lastEventAt 最多每秒写一次库。 */
const LAST_EVENT_WRITE_MS = 1_000;
/** 错误信息里带多少标准错误。 */
const STDERR_TAIL = 2_000;

interface PendingEntry {
  messageIds: MessageId[];
  source: MessageSource;
  text: string;
  resend: boolean;
}

/** 写进去（或正要写）的一行，等它的 result。 */
interface Batch {
  messageIds: MessageId[];
  line: string;
  notes: { recovery: boolean; crash: boolean };
  delivered: boolean;
  processing: boolean;
}

type StartupOutcome =
  | { ok: true }
  | {
      ok: false;
      exitCode: number | null;
      signal: string | null;
      stderr: string;
      conflict: ReturnType<typeof detectArgsConflict>;
      timedOut: boolean;
      shutdown: boolean;
    };

interface Proc {
  child: ChildProcessWithoutNullStreams;
  resume: boolean;
  initSeen: boolean;
  stderr: string;
  /** 我们自己让它退出的原因；null 表示没让它退。 */
  closing: "idle" | "interrupt" | "shutdown" | null;
  startTimedOut: boolean;
  /** 收到第一个 init，或者没等到 init 就退出了。 */
  ready: Promise<StartupOutcome>;
  resolveReady: (o: StartupOutcome) => void;
  exited: Promise<void>;
}

interface SessionState {
  id: SessionId;
  proc: Proc | null;
  inFlight: Batch | null;
  turnInterrupted: boolean;
  pending: PendingEntry[];
  /** 已经写进去（已送达）的消息。 */
  written: Set<MessageId>;
  recoveryNote: boolean;
  crashNote: boolean;
  starting: Promise<void> | null;
  startTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  interruptTimer: NodeJS.Timeout | null;
  interruptRequestId: string | null;
  interruptWaiters: Array<() => void>;
  lastEventWrite: number;
}

export class ClaudeDriver implements Driver {
  readonly #opts: Required<Pick<DriverOptions, "idleCloseMs" | "interruptGraceMs" | "startTimeoutMs" | "shutdownGraceMs">> &
    DriverOptions;
  readonly #sessions = new Map<SessionId, SessionState>();
  readonly #listeners = new Set<DriverEventListener>();
  #shuttingDown = false;
  #requestSeq = 0;

  constructor(options: DriverOptions) {
    this.#opts = {
      idleCloseMs: IDLE_CLOSE_MS,
      interruptGraceMs: INTERRUPT_GRACE_MS,
      startTimeoutMs: START_TIMEOUT_MS,
      shutdownGraceMs: SHUTDOWN_GRACE_MS,
      ...options,
    };
  }

  onEvent(listener: DriverEventListener): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(sessionId: SessionId, options: DriverStartOptions = {}): Promise<void> {
    this.#assertRunning();
    const st = this.#state(sessionId);
    if (options.recovery) st.recoveryNote = true;
    for (;;) {
      if (st.starting) return st.starting;
      if (st.proc?.closing) {
        await st.proc.exited;
        continue;
      }
      if (st.proc) return;
      const batch = this.#takeBatch(st, true);
      if (batch) return this.#runStartup(st, batch, null);
      // 没有要写的：只把进程起起来（M0 实测 init 在每轮开头才出，没消息就等不到 init）
      const spawning = this.#spawn(st, this.#store(st).hasCompletedTurn).then((proc) => this.#armIdle(st, proc));
      st.starting = spawning.finally(() => {
        st.starting = null;
      });
      return st.starting;
    }
  }

  async send(sessionId: SessionId, input: DriverSendInput): Promise<DriverSendResult> {
    this.#assertRunning();
    const st = this.#state(sessionId);
    const ids = input.messageIds;
    if (ids.length > 0 && ids.every((id) => st.written.has(id))) return { kind: "written" };
    const entry: PendingEntry = { messageIds: ids, source: input.source, text: input.text, resend: input.resend ?? false };
    const problem = checkUserLine(buildUserLine(entryText(entry)));
    if (problem) {
      this.#invalidInput(st, problem, ids);
      return { kind: "rejected" };
    }
    if (!this.#isPending(st, ids)) this.#enqueue(st, entry);
    await this.#pump(st);
    return ids.every((id) => st.written.has(id)) ? { kind: "written" } : { kind: "queued" };
  }

  /**
   * 只给测试用：跳过拼装，把一行原样交给写入函数（照样先校验）。会话要已经起来、空闲。
   */
  async writeUserLine(sessionId: SessionId, line: string, messageIds: MessageId[]): Promise<DriverSendResult> {
    const st = this.#state(sessionId);
    const problem = checkUserLine(line);
    if (problem) {
      this.#invalidInput(st, problem, messageIds);
      return { kind: "rejected" };
    }
    const proc = st.proc;
    if (!proc || !proc.initSeen || proc.closing || st.inFlight) throw new Error(`session ${sessionId} is not idle`);
    await this.#writeBatch(st, proc, { messageIds, line, notes: { recovery: false, crash: false }, delivered: false, processing: false });
    return { kind: "written" };
  }

  async interrupt(sessionId: SessionId): Promise<void> {
    const st = this.#sessions.get(sessionId);
    const proc = st?.proc;
    if (!st || !proc || !st.inFlight || proc.closing) return;
    const done = new Promise<void>((resolve) => st.interruptWaiters.push(resolve));
    if (st.interruptRequestId === null) {
      const requestId = `interrupt-${++this.#requestSeq}`;
      st.interruptRequestId = requestId;
      proc.child.stdin.write(buildInterruptLine(requestId) + "\n");
      st.interruptTimer = setTimeout(() => {
        st.interruptTimer = null;
        if (st.proc !== proc || proc.closing) return;
        // 控制消息没回应：SIGINT 会结束这一轮然后整个进程退出（M0 实测），下次 --resume。不用 SIGTERM。
        proc.closing = "interrupt";
        proc.child.kill("SIGINT");
      }, this.#opts.interruptGraceMs);
    }
    return done;
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
      if (proc.closing === "shutdown") continue;
      const wasIdle = proc.closing === "idle" || (!st.inFlight && proc.initSeen);
      proc.closing = "shutdown";
      if (wasIdle) proc.child.stdin.end();
      else proc.child.kill("SIGINT");
    }
    if (procs.length === 0) return;
    const all = Promise.all(procs.map((p) => p.exited));
    let timer: NodeJS.Timeout | undefined;
    const grace = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.#opts.shutdownGraceMs);
    });
    const winner = await Promise.race([all.then(() => "done" as const), grace]);
    clearTimeout(timer);
    if (winner === "timeout") {
      for (const p of procs) if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill("SIGKILL");
      await all;
    }
  }

  // --- 队列 ---

  #state(id: SessionId): SessionState {
    let st = this.#sessions.get(id);
    if (!st) {
      st = {
        id,
        proc: null,
        inFlight: null,
        turnInterrupted: false,
        pending: [],
        written: new Set(),
        recoveryNote: false,
        crashNote: false,
        starting: null,
        startTimer: null,
        idleTimer: null,
        interruptTimer: null,
        interruptRequestId: null,
        interruptWaiters: [],
        lastEventWrite: 0,
      };
      this.#sessions.set(id, st);
    }
    return st;
  }

  #isPending(st: SessionState, ids: MessageId[]): boolean {
    if (ids.length === 0) return false;
    return st.pending.some((e) => ids.every((id) => e.messageIds.includes(id)));
  }

  /** 用户的排在系统消息前面。 */
  #enqueue(st: SessionState, entry: PendingEntry): void {
    if (entry.source === "user") {
      const firstSystem = st.pending.findIndex((e) => e.source === "system");
      if (firstSystem >= 0) {
        st.pending.splice(firstSystem, 0, entry);
        return;
      }
    }
    st.pending.push(entry);
  }

  /**
   * 取下一行：队列里有用户消息就全部拼成一条；否则取一条系统消息。恢复说明加在最前面。
   * noteAlone：没有消息时，恢复说明单独写一条（start 的 recovery）。
   */
  #takeBatch(st: SessionState, noteAlone: boolean): Batch | null {
    let body: string | null = null;
    let messageIds: MessageId[] = [];
    const users = st.pending.filter((e) => e.source === "user");
    if (users.length > 0) {
      st.pending = st.pending.filter((e) => e.source !== "user");
      body = mergeUserTexts(users.map(entryText));
      messageIds = users.flatMap((e) => e.messageIds);
    } else if (st.pending.length > 0) {
      const entry = st.pending.shift()!;
      body = entryText(entry);
      messageIds = entry.messageIds;
    }
    const notes = { recovery: st.recoveryNote, crash: st.crashNote };
    if (body === null && !(noteAlone && notes.recovery)) return null;
    const parts = [notes.recovery ? RESTART_RECOVERY_NOTE : null, notes.crash ? CRASH_RECOVERY_NOTE : null, body].filter(
      (p): p is string => p !== null,
    );
    st.recoveryNote = false;
    st.crashNote = false;
    return { messageIds, line: buildUserLine(parts.join("\n\n")), notes, delivered: false, processing: false };
  }

  /** 没写成的一行：恢复说明留给下一行；消息本身不放回队列，由执行器重试 send 时再排。 */
  #dropBatch(st: SessionState, batch: Batch): void {
    if (st.inFlight === batch) st.inFlight = null;
    if (batch.notes.recovery) st.recoveryNote = true;
    if (batch.notes.crash) st.crashNote = true;
  }

  async #pump(st: SessionState): Promise<void> {
    for (;;) {
      this.#assertRunning();
      if (st.starting) return;
      const proc = st.proc;
      if (proc?.closing) {
        await proc.exited;
        continue;
      }
      if (proc && st.inFlight) return;
      const batch = this.#takeBatch(st, false);
      if (!batch) return;
      if (proc && proc.initSeen) return this.#writeBatch(st, proc, batch);
      return this.#runStartup(st, batch, proc);
    }
  }

  async #writeBatch(st: SessionState, proc: Proc, batch: Batch): Promise<void> {
    const problem = checkUserLine(batch.line);
    if (problem) {
      // 自己拼出来的不会不合格；万一不合格，不写，标失败，接着写下一条
      this.#invalidInput(st, problem, batch.messageIds);
      this.#afterTurn(st, proc);
      return;
    }
    this.#clearTimer(st, "idleTimer");
    st.inFlight = batch;
    st.turnInterrupted = false;
    await new Promise<void>((resolve) => {
      proc.child.stdin.write(batch.line + "\n", (err) => {
        if (!err) this.#markDelivered(st, batch);
        resolve();
      });
    });
  }

  #markDelivered(st: SessionState, batch: Batch): void {
    if (batch.delivered) return;
    batch.delivered = true;
    for (const id of batch.messageIds) st.written.add(id);
    if (batch.messageIds.length > 0) this.#emit(st.id, { type: "message.delivered", messageIds: batch.messageIds, at: Date.now() });
  }

  /** 一轮结束（或一行没写成）之后：有排队的就写下一条，没有就开始算空闲。 */
  #afterTurn(st: SessionState, proc: Proc): void {
    if (st.proc !== proc || proc.closing || this.#shuttingDown) return;
    const next = this.#takeBatch(st, false);
    if (next) void this.#writeBatch(st, proc, next);
    else this.#armIdle(st, proc);
  }

  #armIdle(st: SessionState, proc: Proc): void {
    this.#clearTimer(st, "idleTimer");
    st.idleTimer = setTimeout(() => {
      st.idleTimer = null;
      if (st.proc !== proc || proc.closing || st.inFlight || st.pending.length > 0 || st.starting) return;
      proc.closing = "idle";
      proc.child.stdin.end();
    }, this.#opts.idleCloseMs);
  }

  // --- 启动 ---

  /** 起进程（或用已经起来、还没 init 的进程）写第一行，等 init；参数选错换一个重试一次。 */
  #runStartup(st: SessionState, batch: Batch, existing: Proc | null): Promise<void> {
    st.inFlight = batch;
    st.turnInterrupted = false;
    const run = async () => {
      let proc = existing;
      let resume = proc?.resume ?? this.#store(st).hasCompletedTurn;
      try {
        for (let attempt = 0; ; attempt++) {
          if (!proc) proc = await this.#spawn(st, resume);
          this.#clearTimer(st, "idleTimer");
          st.inFlight = batch;
          proc.child.stdin.write(batch.line + "\n");
          this.#armStartTimer(st, proc);
          const outcome = await proc.ready;
          if (outcome.ok) return;
          proc = null;
          if (outcome.conflict && attempt === 0 && !outcome.shutdown && !outcome.timedOut) {
            resume = outcome.conflict === "session_in_use";
            this.#update(st, { hasCompletedTurn: resume });
            continue;
          }
          throw startupError(outcome, this.#opts.startTimeoutMs, attempt > 0);
        }
      } catch (error) {
        this.#dropBatch(st, batch);
        throw error;
      }
    };
    const promise = run().finally(() => {
      if (st.starting === promise) st.starting = null;
    });
    st.starting = promise;
    return promise;
  }

  #armStartTimer(st: SessionState, proc: Proc): void {
    if (st.startTimer || proc.initSeen) return;
    st.startTimer = setTimeout(() => {
      st.startTimer = null;
      if (st.proc !== proc || proc.initSeen) return;
      proc.startTimedOut = true;
      proc.child.kill("SIGKILL");
    }, this.#opts.startTimeoutMs);
  }

  async #spawn(st: SessionState, resume: boolean): Promise<Proc> {
    const row = this.#store(st);
    let files;
    try {
      files = await this.#opts.prepareLaunch(row);
    } catch (error) {
      throw new DriverError("spawn_failed", `prepareLaunch failed: ${errorMessage(error)}`);
    }
    this.#assertRunning();
    if (!existsSync(row.cwd)) throw new DriverError("spawn_failed", `working directory does not exist: ${row.cwd}`);
    const child = spawn(this.#opts.claudePath, buildClaudeArgs(row, files, resume), {
      cwd: row.cwd,
      env: buildChildEnv(process.env, this.#opts.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new DriverError("claude_not_found", `${this.#opts.claudePath}: ${errorMessage(error)}`);
      throw new DriverError("spawn_failed", `${this.#opts.claudePath}: ${errorMessage(error)}`);
    }
    let resolveReady!: (o: StartupOutcome) => void;
    let resolveExited!: () => void;
    const proc: Proc = {
      child,
      resume,
      initSeen: false,
      stderr: "",
      closing: null,
      startTimedOut: false,
      ready: new Promise((resolve) => (resolveReady = resolve)),
      resolveReady: (o) => resolveReady(o),
      exited: new Promise((resolve) => (resolveExited = resolve)),
    };
    st.proc = proc;
    this.#update(st, { pid: child.pid ?? null });
    child.on("error", () => {}); // 出错之后总会有 close
    child.stdin.on("error", () => {}); // 进程退了还在写：EPIPE，交给 close 处理
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      proc.stderr = (proc.stderr + chunk).slice(-STDERR_TAIL);
    });
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => this.#onLine(st, proc, line));
    child.on("close", (code, signal) => {
      this.#onClose(st, proc, code, signal);
      resolveExited();
    });
    return proc;
  }

  // --- 读输出 ---

  #onLine(st: SessionState, proc: Proc, line: string): void {
    this.#appendLog(st.id, line);
    if (line.trim() === "") return;
    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      obj = parsed as Record<string, unknown>;
    } catch {
      this.#emit(st.id, { type: "driver.error", code: "bad_output_line", message: `bad_output_line: ${line.slice(0, 200)}`, at: Date.now() });
      return;
    }
    const at = Date.now();
    this.#touch(st, at);
    switch (obj.type) {
      case "system":
        if (obj.subtype === "init") this.#onInit(st, proc, obj, at);
        return;
      case "user":
        if (isInterruptMarker(obj)) st.turnInterrupted = true;
        else if (obj.isReplay === true && st.inFlight) {
          const batch = st.inFlight;
          this.#markDelivered(st, batch);
          if (!batch.processing && batch.messageIds.length > 0) {
            batch.processing = true;
            this.#emit(st.id, { type: "message.processing", messageIds: batch.messageIds, at });
          }
        }
        return;
      case "assistant":
        for (const ev of parseAssistant(obj, line, at)) this.#emit(st.id, ev);
        return;
      case "rate_limit_event": {
        const info = parseRateLimit(obj.rate_limit_info);
        this.#update(st, { rateLimit: info });
        this.#emit(st.id, { type: "rate_limit", info, at });
        return;
      }
      case "control_response": {
        const response = obj.response as { request_id?: unknown } | undefined;
        if (response?.request_id !== undefined && response.request_id === st.interruptRequestId) {
          this.#clearTimer(st, "interruptTimer");
          this.#resolveInterrupt(st);
        }
        return;
      }
      case "result":
        this.#onResult(st, proc, obj, at);
        return;
    }
  }

  #onInit(st: SessionState, proc: Proc, obj: Record<string, unknown>, at: number): void {
    if (proc.initSeen) return;
    proc.initSeen = true;
    this.#clearTimer(st, "startTimer");
    const model = typeof obj.model === "string" ? obj.model : null;
    const tools = Array.isArray(obj.tools) ? obj.tools.filter((t): t is string => typeof t === "string") : [];
    this.#update(st, { status: "running", model, lastEventAt: at });
    this.#emit(st.id, { type: "session.started", resumed: proc.resume, model, tools, at });
    if (st.inFlight) this.#markDelivered(st, st.inFlight);
    proc.resolveReady({ ok: true });
  }

  #onResult(st: SessionState, proc: Proc, obj: Record<string, unknown>, at: number): void {
    // 没等到 init 就来的 result 是启动错误（如 No conversation found），不算一轮
    if (!proc.initSeen) return;
    const batch = st.inFlight;
    st.inFlight = null;
    const ok = obj.subtype === "success" && obj.is_error !== true;
    const subtype = typeof obj.subtype === "string" ? obj.subtype : "unknown";
    const event: DriverEvent = {
      type: "turn.ended",
      ok,
      interrupted: st.turnInterrupted,
      messageIds: batch?.messageIds ?? [],
      durationMs: typeof obj.duration_ms === "number" ? obj.duration_ms : null,
      at,
    };
    if (!ok) event.error = { subtype, message: resultMessage(obj, subtype) };
    st.turnInterrupted = false;
    if (!this.#store(st).hasCompletedTurn) this.#update(st, { hasCompletedTurn: true });
    this.#clearTimer(st, "interruptTimer");
    this.#emit(st.id, event);
    this.#resolveInterrupt(st);
    this.#afterTurn(st, proc);
  }

  #onClose(st: SessionState, proc: Proc, code: number | null, signal: NodeJS.Signals | null): void {
    if (st.proc === proc) st.proc = null;
    this.#clearTimer(st, "startTimer");
    this.#clearTimer(st, "idleTimer");
    this.#clearTimer(st, "interruptTimer");
    this.#update(st, { pid: null, status: "idle", lastEventAt: Date.now() });
    const at = Date.now();
    if (!proc.initSeen && proc.closing !== "shutdown") {
      const conflict = detectArgsConflict(proc.stderr);
      proc.resolveReady({ ok: false, exitCode: code, signal, stderr: proc.stderr, conflict, timedOut: proc.startTimedOut, shutdown: false });
      // 没人在等这次启动（只起了进程、还没写东西）：记下该用哪个参数，下次起就对了
      if (conflict && !st.inFlight) this.#update(st, { hasCompletedTurn: conflict === "session_in_use" });
      // 在途的那一行由抛出的 DriverError 交给执行器重试，这里不带 messageIds，免得账本提前标失败
      this.#emit(st.id, { type: "session.exited", reason: "startup_failed", exitCode: code, signal, hadResult: false, messageIds: [], at });
      this.#resolveInterrupt(st);
      return;
    }
    if (!proc.initSeen) {
      proc.resolveReady({ ok: false, exitCode: code, signal, stderr: proc.stderr, conflict: null, timedOut: false, shutdown: true });
    }
    const batch = proc.initSeen ? st.inFlight : null;
    st.inFlight = null;
    const reason: SessionExitReason = proc.closing ?? "crash";
    if (batch && reason === "crash") st.crashNote = true;
    st.interruptRequestId = null;
    this.#emit(st.id, {
      type: "session.exited",
      reason,
      exitCode: code,
      signal,
      hadResult: batch === null,
      messageIds: batch?.messageIds ?? [],
      at,
    });
    this.#resolveInterrupt(st);
  }

  // --- 小零件 ---

  #resolveInterrupt(st: SessionState): void {
    st.interruptRequestId = null;
    for (const w of st.interruptWaiters.splice(0)) w();
  }

  #invalidInput(st: SessionState, problem: string, messageIds: MessageId[]): void {
    this.#emit(st.id, { type: "driver.error", code: "invalid_input", message: `invalid_input: ${problem}`, messageIds, at: Date.now() });
  }

  #store(st: SessionState) {
    const row = this.#opts.store.get(st.id);
    if (!row) throw new DriverError("spawn_failed", `no agent session ${st.id}`);
    return row;
  }

  #update(st: SessionState, patch: AgentSessionPatch): void {
    if (patch.lastEventAt !== undefined && patch.lastEventAt !== null) st.lastEventWrite = patch.lastEventAt;
    this.#opts.store.update(st.id, patch);
  }

  #touch(st: SessionState, at: number): void {
    if (at - st.lastEventWrite >= LAST_EVENT_WRITE_MS) this.#update(st, { lastEventAt: at });
  }

  #clearTimer(st: SessionState, key: "startTimer" | "idleTimer" | "interruptTimer"): void {
    const timer = st[key];
    if (timer) clearTimeout(timer);
    st[key] = null;
  }

  #appendLog(sessionId: SessionId, line: string): void {
    mkdirSync(this.#opts.sessionLogsDir, { recursive: true });
    appendFileSync(join(this.#opts.sessionLogsDir, `${sessionId}.jsonl`), line + "\n");
  }

  #emit(sessionId: SessionId, event: DriverEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(sessionId, event);
      } catch {
        // 监听者出错不影响驱动层
      }
    }
  }

  #assertRunning(): void {
    if (this.#shuttingDown) throw new DriverError("spawn_failed", "driver is shutting down");
  }
}

export function createClaudeDriver(options: DriverOptions): ClaudeDriver {
  return new ClaudeDriver(options);
}

function entryText(entry: PendingEntry): string {
  return entry.resend ? `${RESEND_NOTE}\n\n${entry.text}` : entry.text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resultMessage(obj: Record<string, unknown>, subtype: string): string {
  if (typeof obj.result === "string" && obj.result !== "") return obj.result;
  if (Array.isArray(obj.errors) && obj.errors.length > 0) return obj.errors.map(String).join("; ");
  return subtype;
}

function startupError(outcome: Exclude<StartupOutcome, { ok: true }>, startTimeoutMs: number, retried: boolean): DriverError {
  if (outcome.shutdown) return new DriverError("spawn_failed", "driver is shutting down");
  if (outcome.timedOut) return new DriverError("start_timeout", `no system/init within ${startTimeoutMs} ms`);
  const how = outcome.signal ? `signal ${outcome.signal}` : `exit code ${outcome.exitCode}`;
  const stderr = outcome.stderr.trim();
  if (outcome.conflict) {
    return new DriverError("start_args_conflict", `${retried ? "after switching --session-id/--resume: " : ""}${stderr || how}`);
  }
  return new DriverError("spawn_failed", `claude exited before system/init (${how})${stderr ? `: ${stderr}` : ""}`);
}
