// Claude 驱动层（设计第 7.2～7.4 节，按 M0 改过的做法）：每个会话一个官方 claude 进程，
// 我们这边管待发队列（一轮一条、忙时用户连发拼成一条、写入前校验）、打断、空闲关闭、--session-id / --resume。
// 驱动层自己出的错（写库、写日志、监听者抛错）不往上冒，记成 driver.error(internal_error)。
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  CRASH_RECOVERY_NOTE,
  DriverError,
  IDLE_CLOSE_MS,
  INTERRUPT_GRACE_MS,
  RESEND_NOTE,
  RESTART_RECOVERY_NOTE,
  SHUTDOWN_GRACE_MS,
  START_TIMEOUT_MS,
  type AgentSessionPatch,
  type AgentSessionRow,
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

/** lastEventAt 最多每秒写一次库。 */
const LAST_EVENT_WRITE_MS = 1_000;
/** 错误信息里带多少标准错误。 */
const STDERR_TAIL = 2_000;
/** 进程退出后最多等多久把标准输出、标准错误读完；孙进程占着管道时到点强制关掉。 */
const STDIO_DRAIN_MS = 300;
/** 发了 SIGKILL 之后最多再等多久。 */
const KILL_WAIT_MS = 2_000;
/** 清理残留进程时多久看一次它还在不在。 */
const STALE_POLL_MS = 50;

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

type ClosingReason = "idle" | "interrupt" | "shutdown";

type StartupOutcome =
  | { kind: "ok" }
  /** 没等到 init 就自己退出了（或启动超时被结束）。 */
  | {
      kind: "failed";
      exitCode: number | null;
      signal: string | null;
      stderr: string;
      conflict: ReturnType<typeof detectArgsConflict>;
      timedOut: boolean;
    }
  /** 没等到 init，是我们让它退的。 */
  | { kind: "closed"; reason: ClosingReason };

interface Proc {
  child: ChildProcessWithoutNullStreams;
  resume: boolean;
  initSeen: boolean;
  stderr: string;
  /** 我们自己让它退出的原因；null 表示没让它退。 */
  closing: ClosingReason | null;
  startTimedOut: boolean;
  /** 空闲关闭的升级：关了标准输入还不退，先 SIGINT，再 SIGKILL。 */
  killTimer: NodeJS.Timeout | null;
  /** 收到第一个 init，或者没等到 init 就退出了。 */
  ready: Promise<StartupOutcome>;
  resolveReady: (o: StartupOutcome) => void;
  /** 进程退出、输出读完（或到点强制关掉）、收尾做完。一定会 resolve。 */
  exited: Promise<void>;
}

interface SessionState {
  id: SessionId;
  proc: Proc | null;
  inFlight: Batch | null;
  turnInterrupted: boolean;
  pending: PendingEntry[];
  /** 已经写进去（已送达）、还没失败的消息；这一轮出错或进程崩溃时删掉，好让重发真的再写一次。 */
  written: Set<MessageId>;
  recoveryNote: boolean;
  crashNote: boolean;
  /** 只起进程那次参数选错，下次该用 --resume（true）还是 --session-id（false）；启动成功后才写库。 */
  resumeHint: boolean | null;
  starting: Promise<void> | null;
  startTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  interruptTimer: NodeJS.Timeout | null;
  interruptRequestId: string | null;
  interruptWaiters: Array<() => void>;
  lastEventWrite: number;
  /** logs/sessions/<会话>.jsonl 一直开着。 */
  logFd: number | null;
  /** 日志写不了：报过一次就不再写（下次起进程再试）。 */
  logBroken: boolean;
}

export class ClaudeDriver implements Driver {
  readonly #opts: Required<Pick<DriverOptions, "idleCloseMs" | "interruptGraceMs" | "startTimeoutMs" | "shutdownGraceMs">> &
    DriverOptions;
  readonly #sessions = new Map<SessionId, SessionState>();
  readonly #listeners = new Set<DriverEventListener>();
  #shuttingDown = false;
  #requestSeq = 0;
  /** 正在报监听者的错：这时监听者再抛错只打到标准错误，免得没完没了。 */
  #reportingListenerError = false;

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
    this.#store(st);
    if (options.recovery) st.recoveryNote = true;
    for (;;) {
      if (st.starting) return st.starting;
      const proc = st.proc;
      if (proc?.closing) {
        await proc.exited;
        this.#assertRunning();
        continue;
      }
      if (proc) {
        // 起好了还没写过东西（之前只起了进程）：有恢复说明就现在写，等到 init
        if (proc.initSeen || st.inFlight) return;
        const batch = this.#takeBatch(st, true);
        return batch ? this.#runStartup(st, batch, proc) : undefined;
      }
      const batch = this.#takeBatch(st, true);
      if (batch) return this.#runStartup(st, batch, null);
      // 没有要写的：只把进程起起来（M0 实测 init 在每轮开头才出，没消息就等不到 init）
      const promise: Promise<void> = this.#spawn(st, this.#resumeFor(st))
        .then((p) => this.#armIdle(st, p))
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
    this.#store(st);
    const ids = input.messageIds;
    if (ids.length === 0) {
      this.#invalidInput(st, "messageIds 是空的", ids);
      return { kind: "rejected" };
    }
    if (ids.every((id) => st.written.has(id))) return { kind: "written" };
    const entry: PendingEntry = { messageIds: ids, source: input.source, text: input.text, resend: input.resend ?? false };
    const problem = checkUserLine(buildUserLine(entryText(entry)));
    if (problem) {
      this.#invalidInput(st, problem, ids);
      return { kind: "rejected" };
    }
    // 排序只在 #takeBatch 里做（用户的拼成一条排在系统的前面），这里按到达顺序放
    if (!this.#isPending(st, ids)) st.pending.push(entry);
    await this.#pump(st);
    return ids.every((id) => st.written.has(id)) ? { kind: "written" } : { kind: "queued" };
  }

  /**
   * @internal 只给测试用：跳过拼装，把一行原样交给写入函数（照样先校验）。会话要已经起来、空闲。
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
        this.#sigintForInterrupt(st, proc);
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
      clearKillTimer(proc);
      if (proc.closing === "shutdown") continue;
      const wasIdle = proc.closing === "idle" || (!st.inFlight && proc.initSeen);
      proc.closing = "shutdown";
      if (wasIdle) proc.child.stdin.end();
      else proc.child.kill("SIGINT");
    }
    if (procs.length > 0) {
      const all = Promise.all(procs.map((p) => p.exited));
      if ((await within(all, this.#opts.shutdownGraceMs)) === "timeout") {
        for (const p of procs) if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill("SIGKILL");
        await within(all, KILL_WAIT_MS);
      }
    }
    for (const st of this.#sessions.values()) this.#closeLog(st);
  }

  async cleanupStale(): Promise<void> {
    let rows: AgentSessionRow[];
    try {
      rows = this.#opts.store.listWithProcess();
    } catch (error) {
      throw new DriverError("internal_error", `listWithProcess failed: ${errorMessage(error)}`);
    }
    await Promise.all(rows.map((row) => this.#cleanupStaleRow(row)));
  }

  async #cleanupStaleRow(row: AgentSessionRow): Promise<void> {
    const pid = row.pid;
    if (pid === null) return;
    // 这一次自己起的进程不算残留
    if (this.#sessions.get(row.id)?.proc?.child.pid === pid) return;
    if (await isClaudeOfSession(pid, row.vendorSessionId)) {
      signalPid(pid, "SIGINT");
      if (!(await waitForExit(pid, this.#opts.interruptGraceMs))) {
        signalPid(pid, "SIGKILL");
        await waitForExit(pid, KILL_WAIT_MS);
      }
    }
    this.#update(this.#state(row.id), { pid: null, status: "idle" });
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
        resumeHint: null,
        starting: null,
        startTimer: null,
        idleTimer: null,
        interruptTimer: null,
        interruptRequestId: null,
        interruptWaiters: [],
        lastEventWrite: 0,
        logFd: null,
        logBroken: false,
      };
      this.#sessions.set(id, st);
    }
    return st;
  }

  /** 已经在待发队列里，或者就是正在启动、还没写成的那一行。 */
  #isPending(st: SessionState, ids: MessageId[]): boolean {
    const covers = (batchIds: MessageId[]) => ids.every((id) => batchIds.includes(id));
    if (st.inFlight && covers(st.inFlight.messageIds)) return true;
    return st.pending.some((e) => covers(e.messageIds));
  }

  /**
   * 取下一行：队列里有用户消息就全部拼成一条；否则取最早的一条系统消息。恢复说明加在最前面。
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

  #forgetWritten(st: SessionState, batch: Batch | null): void {
    for (const id of batch?.messageIds ?? []) st.written.delete(id);
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
      // 关了标准输入还不退：先 SIGINT，再 SIGKILL
      const grace = this.#opts.interruptGraceMs;
      proc.killTimer = setTimeout(() => {
        proc.child.kill("SIGINT");
        proc.killTimer = setTimeout(() => {
          proc.killTimer = null;
          proc.child.kill("SIGKILL");
        }, grace);
      }, grace);
    }, this.#opts.idleCloseMs);
  }

  #sigintForInterrupt(st: SessionState, proc: Proc): void {
    if (st.proc !== proc || proc.closing) return;
    // SIGINT 会结束这一轮然后整个进程退出（M0 实测），下次 --resume。不用 SIGTERM。
    proc.closing = "interrupt";
    proc.child.kill("SIGINT");
  }

  // --- 启动 ---

  /** 下次起进程用不用 --resume。 */
  #resumeFor(st: SessionState): boolean {
    return st.resumeHint ?? this.#store(st).hasCompletedTurn;
  }

  /** 起进程（或用已经起来、还没 init 的进程）写第一行，等 init；参数选错换一个重试一次。 */
  #runStartup(st: SessionState, batch: Batch, existing: Proc | null): Promise<void> {
    st.inFlight = batch;
    st.turnInterrupted = false;
    const run = async () => {
      let proc = existing;
      try {
        let resume = proc?.resume ?? this.#resumeFor(st);
        for (let attempt = 0; ; attempt++) {
          if (!proc) proc = await this.#spawn(st, resume);
          this.#clearTimer(st, "idleTimer");
          st.inFlight = batch;
          proc.child.stdin.write(batch.line + "\n");
          this.#armStartTimer(st, proc);
          const outcome = await proc.ready;
          if (outcome.kind === "ok") return;
          if (outcome.kind === "closed") {
            // 启动阶段被打断：那一行已经算送达，由 session.exited(interrupt) 带着它，不当启动失败重试
            if (outcome.reason === "interrupt") return;
            throw new DriverError("spawn_failed", this.#shuttingDown ? "driver is shutting down" : `closed before system/init (${outcome.reason})`);
          }
          proc = null;
          if (outcome.conflict && attempt === 0 && !outcome.timedOut) {
            // 换一个参数重试；hasCompletedTurn 等这次启动成功（#onInit）再写库
            resume = outcome.conflict === "session_in_use";
            continue;
          }
          throw startupError(outcome, this.#opts.startTimeoutMs, attempt > 0);
        }
      } catch (error) {
        this.#dropBatch(st, batch);
        throw error;
      }
    };
    const promise: Promise<void> = run().finally(() => {
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
    // 等 spawn 的这一会儿可能已经开始关机：shutdown 看不到这个进程，自己结束它
    if (this.#shuttingDown) {
      child.kill("SIGKILL");
      this.#assertRunning();
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
      killTimer: null,
      ready: new Promise((resolve) => (resolveReady = resolve)),
      resolveReady: (o) => resolveReady(o),
      exited: new Promise((resolve) => (resolveExited = resolve)),
    };
    st.proc = proc;
    st.logBroken = false;
    this.#update(st, { pid: child.pid ?? null });
    child.on("error", () => {}); // 出错之后总会有 exit
    child.stdin.on("error", () => {}); // 进程退了还在写：EPIPE，交给 exit 处理
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      proc.stderr = (proc.stderr + chunk).slice(-STDERR_TAIL);
    });
    // 自己按 \n 切行：node:readline 还会在 U+2028 / U+2029 处断开，而 JSON 字符串里可以有这两个字符
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
    // 用 exit 不用 close：agent 起的孙进程可能还占着标准输出，close 会一直等它
    const drained = Promise.all([streamClosed(child.stdout), streamClosed(child.stderr)]);
    child.once("exit", (code, signal) => {
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
    return proc;
  }

  // --- 读输出 ---

  #handleLine(st: SessionState, proc: Proc, rawLine: string): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    try {
      this.#onLine(st, proc, line);
    } catch (error) {
      this.#internalError(st.id, `handling output line failed: ${errorMessage(error)}`);
    }
  }

  #onLine(st: SessionState, proc: Proc, line: string): void {
    this.#appendLog(st, line);
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
        else if (obj.isReplay === true && st.inFlight) this.#markProcessing(st, st.inFlight, at);
        return;
      case "assistant":
        for (const ev of parseAssistant(obj, line, at)) this.#emit(st.id, ev);
        return;
      case "rate_limit_event": {
        const info = parseRateLimit(obj.rate_limit_info);
        if (!info) return;
        this.#update(st, { rateLimit: info });
        this.#emit(st.id, { type: "rate_limit", info, at });
        return;
      }
      case "control_response": {
        const response = obj.response as { subtype?: unknown; request_id?: unknown } | undefined;
        if (response?.request_id === undefined || response.request_id !== st.interruptRequestId) return;
        this.#clearTimer(st, "interruptTimer");
        // 只有 success 才算打断收到了；回了 error 就不等了，直接 SIGINT
        if (response.subtype === "success") this.#resolveInterrupt(st);
        else this.#sigintForInterrupt(st, proc);
        return;
      }
      case "result":
        this.#onResult(st, proc, obj, at);
        return;
    }
  }

  #markProcessing(st: SessionState, batch: Batch, at: number): void {
    this.#markDelivered(st, batch);
    if (batch.processing || batch.messageIds.length === 0) return;
    batch.processing = true;
    this.#emit(st.id, { type: "message.processing", messageIds: batch.messageIds, at });
  }

  #onInit(st: SessionState, proc: Proc, obj: Record<string, unknown>, at: number): void {
    if (proc.initSeen) return;
    proc.initSeen = true;
    this.#clearTimer(st, "startTimer");
    const model = typeof obj.model === "string" ? obj.model : null;
    const tools = Array.isArray(obj.tools) ? obj.tools.filter((t): t is string => typeof t === "string") : [];
    const patch: AgentSessionPatch = { status: "running", model, lastEventAt: at };
    // 参数选错后换了一个才起来：这时才把用哪个参数写进库
    const row = this.#row(st);
    if (row && row.hasCompletedTurn !== proc.resume) patch.hasCompletedTurn = proc.resume;
    st.resumeHint = null;
    this.#update(st, patch);
    this.#emit(st.id, { type: "session.started", resumed: proc.resume, model, tools, at });
    if (st.inFlight) this.#markDelivered(st, st.inFlight);
    proc.resolveReady({ kind: "ok" });
  }

  #onResult(st: SessionState, proc: Proc, obj: Record<string, unknown>, at: number): void {
    // 没等到 init 就来的 result 是启动错误（如 No conversation found），不算一轮
    if (!proc.initSeen) return;
    const batch = st.inFlight;
    st.inFlight = null;
    // 没等到回显就结束了（比如回显前被打断）：先补一个 message.processing，账本才能从“已送达”往下走
    if (batch) this.#markProcessing(st, batch, at);
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
    if (!ok) {
      event.error = { subtype, message: resultMessage(obj, subtype) };
      this.#forgetWritten(st, batch);
    }
    st.turnInterrupted = false;
    if (this.#row(st)?.hasCompletedTurn === false) this.#update(st, { hasCompletedTurn: true });
    this.#clearTimer(st, "interruptTimer");
    this.#emit(st.id, event);
    this.#resolveInterrupt(st);
    this.#afterTurn(st, proc);
  }

  #onClose(st: SessionState, proc: Proc, code: number | null, signal: NodeJS.Signals | null, resolveExited: () => void): void {
    try {
      if (st.proc === proc) st.proc = null;
      clearKillTimer(proc);
      this.#clearTimer(st, "startTimer");
      this.#clearTimer(st, "idleTimer");
      this.#clearTimer(st, "interruptTimer");
      this.#update(st, { pid: null, status: "idle", lastEventAt: Date.now() });
      const at = Date.now();
      if (!proc.initSeen) {
        if (proc.closing === null) {
          const conflict = detectArgsConflict(proc.stderr);
          // 没人在等这次启动（只起了进程、还没写东西）：记下该用哪个参数，下次起就对了
          if (conflict && !st.inFlight) st.resumeHint = conflict === "session_in_use";
          this.#forgetWritten(st, st.inFlight);
          proc.resolveReady({ kind: "failed", exitCode: code, signal, stderr: proc.stderr, conflict, timedOut: proc.startTimedOut });
          // 在途的那一行由抛出的 DriverError 交给执行器重试，这里不带 messageIds，免得账本提前标失败
          this.#emit(st.id, { type: "session.exited", reason: "startup_failed", exitCode: code, signal, hadResult: false, messageIds: [], at });
          return;
        }
        // 启动阶段被打断：那一行已经写进标准输入，算送达，下面跟着 session.exited(interrupt) 标已停止
        if (proc.closing === "interrupt" && st.inFlight) this.#markDelivered(st, st.inFlight);
        proc.resolveReady({ kind: "closed", reason: proc.closing });
      }
      const batch = proc.initSeen || proc.closing === "interrupt" ? st.inFlight : null;
      st.inFlight = null;
      const reason: SessionExitReason = proc.closing ?? "crash";
      if (batch && reason === "crash") {
        st.crashNote = true;
        this.#forgetWritten(st, batch);
      }
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
    } finally {
      this.#resolveInterrupt(st);
      resolveExited();
    }
  }

  // --- 小零件 ---

  #resolveInterrupt(st: SessionState): void {
    st.interruptRequestId = null;
    for (const w of st.interruptWaiters.splice(0)) w();
  }

  #invalidInput(st: SessionState, problem: string, messageIds: MessageId[]): void {
    this.#emit(st.id, { type: "driver.error", code: "invalid_input", message: `invalid_input: ${problem}`, messageIds, at: Date.now() });
  }

  #internalError(sessionId: SessionId, detail: string): void {
    this.#emit(sessionId, { type: "driver.error", code: "internal_error", message: `internal_error: ${detail}`, at: Date.now() });
  }

  /** start、send、起进程时用：找不到那一行抛不可重试的错。 */
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

  /** 处理输出时用：出错不往上冒，记一条 internal_error，返回 null。 */
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

  #touch(st: SessionState, at: number): void {
    if (at - st.lastEventWrite >= LAST_EVENT_WRITE_MS) this.#update(st, { lastEventAt: at });
  }

  #clearTimer(st: SessionState, key: "startTimer" | "idleTimer" | "interruptTimer"): void {
    const timer = st[key];
    if (timer) clearTimeout(timer);
    st[key] = null;
  }

  #appendLog(st: SessionState, line: string): void {
    if (st.logBroken) return;
    try {
      if (st.logFd === null) {
        mkdirSync(this.#opts.sessionLogsDir, { recursive: true });
        st.logFd = openSync(join(this.#opts.sessionLogsDir, `${st.id}.jsonl`), "a");
      }
      writeSync(st.logFd, line + "\n");
    } catch (error) {
      st.logBroken = true;
      this.#closeLog(st);
      this.#internalError(st.id, `writing session log failed: ${errorMessage(error)}`);
    }
  }

  #closeLog(st: SessionState): void {
    if (st.logFd === null) return;
    try {
      closeSync(st.logFd);
    } catch {
      // 关不上也没什么可做的
    }
    st.logFd = null;
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

  /** 监听者出错不影响驱动层，但要留下记录：发一条 internal_error；报这条时再出错就只打到标准错误。 */
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

function startupError(outcome: Extract<StartupOutcome, { kind: "failed" }>, startTimeoutMs: number, retried: boolean): DriverError {
  if (outcome.timedOut) return new DriverError("start_timeout", `no system/init within ${startTimeoutMs} ms`);
  const how = outcome.signal ? `signal ${outcome.signal}` : `exit code ${outcome.exitCode}`;
  const stderr = outcome.stderr.trim();
  if (outcome.conflict) {
    return new DriverError("start_args_conflict", `${retried ? "after switching --session-id/--resume: " : ""}${stderr || how}`);
  }
  return new DriverError("spawn_failed", `claude exited before system/init (${how})${stderr ? `: ${stderr}` : ""}`);
}

function clearKillTimer(proc: Proc): void {
  if (proc.killTimer) clearTimeout(proc.killTimer);
  proc.killTimer = null;
}

function streamClosed(stream: Readable): Promise<void> {
  return new Promise((resolve) => {
    if (stream.closed) resolve();
    else stream.once("close", () => resolve());
  });
}

/** 等 promise，最多 ms 毫秒。 */
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

/** 用 ps 看这个 pid 的命令行：是 claude，并且带着这个会话的 ID（pid 可能已经被别的进程复用）。 */
function isClaudeOfSession(pid: number, vendorSessionId: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "command=", "-p", String(pid)], (error, stdout) => {
      if (error) return resolve(false); // 进程不在了：ps 退出码 1
      const command = stdout.trim();
      resolve(/claude/i.test(command) && command.includes(vendorSessionId));
    });
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // 已经不在了
  }
}

async function waitForExit(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, STALE_POLL_MS));
  }
  return true;
}
