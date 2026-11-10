// Claude 驱动层（设计第 7.2～7.4 节，按 M0 改过的做法）：每个会话一个官方 claude 进程，
// 公共会话状态机（待发队列、用量节流、空闲/启动/打断定时器、前缀说明注入与回退、后台任务跟踪等）继承自 BaseSessionDriver；
// 本文件负责 Claude 专有协议：stream-json 行组装与解析、一轮中途写入（MID_TURN_CAPABILITIES + command_lifecycle 对账）、
// control_request / control_response（只读 Worker 审批、优雅打断与 queryCommands）。
import { randomUUID } from "node:crypto";
import {
  DriverError,
  EMPTY_TOKEN_USAGE,
   type AgentSessionPatch,
  type AgentSessionRow,
  type ComposerCommand,
  type DriverEvent,
  type DriverOptions,
  type DriverSendInput,
  type DriverSendResult,
  type LaunchFiles,
  type MessageId,
  type MessageSource,
  type SessionExitReason,
  type SessionId,
} from "../../shared/index.ts";
import type { VendorComposerBase } from "../../daemon/vendors/types.ts";
import { claudeComposerBase } from "./composer.ts";
import {
  BaseSessionDriver,
  NO_NOTES,
  createBaseSessionState,
  entryParts,
  type BaseBatch,
  type BaseProc,
  type BaseSessionState,
  type BatchNotes,
  type PendingEntry,
  type StartupOutcome,
} from "../../daemon/driver/base-driver.ts";
import { ClaudeReadonlyGate } from "./readonly.ts";
import { personaSeenAtStart } from "../../daemon/driver/persona-note.ts";
import {
  MID_TURN_CAPABILITIES,
  buildClaudeArgs,
  claudeOfSession,
  buildInitializeLine,
  buildInterruptLine,
  buildUserLine,
  checkUserLine,
  detectArgsConflict,
  interruptCancelled,
  isInterruptMarker,
  parseApiRetry,
  parseAssistant,
  parseCapabilities,
  parseLifecycle,
  parseRateLimit,
  parseToolResults,
} from "./protocol.ts";
import { lineUuid } from "../../daemon/driver/protocol.ts";
import { spawnInWriteScope } from "../../daemon/driver/write-scope.ts";

/** 写进去（或正要写）的一行，等它的 result。 */
interface Batch extends BaseBatch {
  line: string;
  /** 写在这一行里的 uuid：claude 的 command_lifecycle 用它（command_uuid）告诉我们这一行排着、被取走、做完、被取消。 */
  uuid: string;
  /** 收到这一行的 command_lifecycle started：claude 取走了（模型看到了）。 */
  started: boolean;
  /** 会话正忙时在一轮中途写进去的（不是开一轮的那条）。 */
  midTurn: boolean;
  /** 中途写的这一行写回调还没回来时用户点了停止：写失败（进程正好没了）的话按停止处理，用户的标已取消、不退回队列。 */
  stopped: boolean;
  /** 没取走就被收掉了（停止、进程没了）：cancelled = 已出 message.cancelled；requeued = 收回了，要重新写。写回调晚到时照这个办。 */
  released: "cancelled" | "requeued" | null;
}

/** 一轮中途写一行的结果：written 写成了；cancelled 停止时被取消了；retry 没写成，退回待发队列。 */
type MidTurnWrite = "written" | "cancelled" | "retry";

type ClaudeStartupOutcome = StartupOutcome<ReturnType<typeof detectArgsConflict>>;

interface Proc extends BaseProc<ClaudeStartupOutcome> {
  /** 只读 Worker（LaunchFiles.readonly）才有：回 claude 的 can_use_tool 批准请求（readonly.ts）。进程退出时 dispose。 */
  readonlyGate: ClaudeReadonlyGate | null;
  /** 第一个 system/init 里的 capabilities（MID_TURN_CAPABILITIES 等）；init 之前是空的。 */
  capabilities: Set<string>;
}

interface SessionState extends BaseSessionState<Proc, Batch> {
  interruptRequestId: string | null;
  /** 在等回应的命令列表请求（queryCommands）：request_id → 交回结果（null = 没问到）。进程退出时都交回 null。 */
  commandQueries: Map<string, (commands: ComposerCommand[] | null) => void>;
}

export interface ClaudeDriverOptions extends DriverOptions {
  /** 这个驱动对应的厂商实现（命令的认法、写给 agent 的 content 怎么拼、命令列表怎么解析），默认 composer.ts 的 claudeComposerBase。 */
  composer?: VendorComposerBase;
}

export class ClaudeDriver extends BaseSessionDriver<Proc, Batch, SessionState> {
  readonly #claudePath: string;

  constructor(options: ClaudeDriverOptions) {
    super("claude", { ...options, composer: options.composer ?? claudeComposerBase });
    this.#claudePath = options.executablePath;
  }

  protected createSessionState(id: SessionId): SessionState {
    return {
      ...createBaseSessionState<Proc, Batch>(id),
      interruptRequestId: null,
      commandQueries: new Map(),
    };
  }

  async send(sessionId: SessionId, input: DriverSendInput): Promise<DriverSendResult> {
    this.assertRunning();
    const st = this.state(sessionId);
    this.assertNotEnded(st);
    const ids = input.messageIds;
    if (ids.length === 0) {
      this.invalidInput(st, "messageIds 是空的", ids);
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
    const problem = checkUserLine(buildUserLine(parts.text, parts.prefixes, this.composer.buildUserContent));
    if (problem) {
      this.invalidInput(st, problem, ids);
      return { kind: "rejected" };
    }
    if (!this.isPending(st, ids)) {
      if (input.recovery) st.recoveryNote = true;
      // 忙着、但这个 claude 能在一轮中途收：直接写进去，不进待发队列
      const proc = st.proc;
      if (proc && this.#canWriteMidTurn(st, proc, entry)) {
        const batch = this.#batchOf(st, entryParts(entry), ids, false, entry.source);
        batch.midTurn = true;
        const outcome = await this.#writeMidTurn(st, proc, batch);
        if (outcome === "written") return { kind: "written", midTurn: true };
        if (outcome === "cancelled") return { kind: "cancelled" };
        // 没写成（进程正好没了）：退回待发队列，照旧等
        this.dropBatch(st, batch);
      }
      st.pending.push(entry);
    }
    await this.pump(st);
    return ids.every((id) => st.written.has(id)) ? { kind: "written" } : { kind: "queued" };
  }

  /**
   * 能不能在这一轮中途直接写（docs/mid-turn-messages.md 第 5.1 节）：进程 init 过、支持（MID_TURN_CAPABILITIES）、不在关闭、
   * 正忙（空闲时走 pump，写之前要比设置）、没在两轮之间重启（starting）、这一轮没点过停止（写进去会被一起取消）、
   * 待发队列是空的（前面还排着的话不插队）、不是命令（本地命令在轮中间的行为没测，也会丢前缀块，见 #76）。
   */
  #canWriteMidTurn(st: SessionState, proc: Proc, entry: PendingEntry): boolean {
    return (
      proc.initSeen &&
      midTurnCapable(proc) &&
      !proc.closing &&
      !this.shuttingDown &&
      this.busy(st) &&
      st.starting === null &&
      !st.stopRequested &&
      st.pending.length === 0 &&
      !this.composer.isCommand(entry.text)
    );
  }

  /** 一轮中途写一行：不重启、不调 prepareLaunch、不动这一轮的打断标记。 */
  async #writeMidTurn(st: SessionState, proc: Proc, batch: Batch): Promise<MidTurnWrite> {
    st.inFlight.push(batch);
    this.clearTimer(st, "idleTimer");
    return new Promise<MidTurnWrite>((resolve) => {
      proc.child.stdin.write(batch.line + "\n", (err) => {
        if (batch.released !== null) return resolve(batch.released === "cancelled" ? "cancelled" : "retry");
        if (!err) {
          this.markDelivered(st, batch);
          return resolve("written");
        }
        this.dropBatch(st, batch);
        if (batch.stopped && batch.source === "user") {
          this.emit(st.id, { type: "message.cancelled", messageIds: batch.messageIds, reason: "stop", at: Date.now() });
          return resolve("cancelled");
        }
        resolve("retry");
      });
    });
  }

  /**
   * @internal 只给测试用：跳过拼装，把一行原样交给写入函数（照样先校验）。会话要已经起来、空闲。
   */
  async writeUserLine(sessionId: SessionId, line: string, messageIds: MessageId[]): Promise<DriverSendResult> {
    const st = this.state(sessionId);
    const problem = checkUserLine(line);
    if (problem) {
      this.invalidInput(st, problem, messageIds);
      return { kind: "rejected" };
    }
    const proc = st.proc;
    if (!proc || !proc.initSeen || proc.closing || st.inFlight.length > 0) {
      throw new Error(`session ${sessionId} is not idle`);
    }
    await this.writeBatch(st, proc, newBatch(messageIds, line, randomUUID(), NO_NOTES, "user"));
    return { kind: "written" };
  }

  async interrupt(sessionId: SessionId): Promise<void> {
    const st = this.sessions.get(sessionId);
    if (!st) return;
    this.dropPendingUsers(st);
    const proc = st.proc;
    if (!proc || proc.closing) return;
    const stopBg = this.stopIdleBackgroundTasks(st, proc);
    if (stopBg) {
      await stopBg;
      return;
    }
    if (!this.busy(st)) return;
    st.stopRequested = true;
    for (const batch of st.inFlight) if (batch.midTurn && !batch.delivered) batch.stopped = true;
    const done = new Promise<void>((resolve) => st.interruptWaiters.push(resolve));
    if (st.interruptRequestId === null) {
      const requestId = `interrupt-${++this.requestSeq}`;
      st.interruptRequestId = requestId;
      proc.child.stdin.write(buildInterruptLine(requestId, proc.capabilities.has("interrupt_cancel_queued_v1")) + "\n");
      st.interruptTimer = setTimeout(() => {
        st.interruptTimer = null;
        this.sigintForInterrupt(st, proc);
      }, this.opts.interruptGraceMs);
    }
    return done;
  }

  override queryCommands(sessionId: SessionId): Promise<ComposerCommand[] | null> {
    const st = this.sessions.get(sessionId);
    const proc = st?.proc;
    if (!st || !proc || proc.closing || this.shuttingDown) return Promise.resolve(null);
    const requestId = `commands-${++this.requestSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(null), this.opts.commandsTimeoutMs);
      const done = (commands: ComposerCommand[] | null) => {
        clearTimeout(timer);
        st.commandQueries.delete(requestId);
        resolve(commands);
      };
      st.commandQueries.set(requestId, done);
      proc.child.stdin.write(buildInitializeLine(requestId) + "\n", (err) => {
        if (err) done(null);
      });
    });
  }

  protected identifyStaleProcess(pid: number, row: AgentSessionRow): Promise<number | null> {
    return claudeOfSession(pid, row.vendorSessionId);
  }

  protected takeBatch(st: SessionState): Batch | null {
    const taken = this.takePendingEntryBatch(st);
    if (!taken) return null;
    return this.#batchOf(st, taken.body, taken.messageIds, taken.command, taken.source);
  }

  #batchOf(
    st: SessionState,
    body: { prefixes: string[]; text: string },
    messageIds: MessageId[],
    command: boolean,
    source: MessageSource,
  ): Batch {
    const uuid = randomUUID();
    if (command) {
      return newBatch(messageIds, buildUserLine(body.text, body.prefixes, this.composer.buildUserContent, uuid), uuid, NO_NOTES, source);
    }
    const { notes, prefixes } = this.takeNotesPrefixes(st);
    return newBatch(
      messageIds,
      buildUserLine(body.text, [...prefixes, ...body.prefixes], this.composer.buildUserContent, uuid),
      uuid,
      notes,
      source,
    );
  }

  protected async writeBatch(st: SessionState, proc: Proc, batch: Batch): Promise<void> {
    const problem = checkUserLine(batch.line);
    if (problem) {
      this.invalidInput(st, problem, batch.messageIds);
      this.afterTurn(st, proc);
      return;
    }
    this.clearTimer(st, "idleTimer");
    st.inFlight.push(batch);
    st.turnInterrupted = false;
    st.stopRequested = false;
    await new Promise<void>((resolve) => {
      proc.child.stdin.write(batch.line + "\n", (err) => {
        if (!err) this.markDelivered(st, batch);
        resolve();
      });
    });
  }

  protected resumeFor(st: SessionState): boolean {
    return st.resumeHint ?? this.store(st).hasCompletedTurn;
  }

  protected spawnIdleProcess(st: SessionState, resume: boolean): Promise<Proc> {
    return this.#spawn(st, resume, null);
  }

  protected startup(st: SessionState, batch: Batch, existing: Proc | null, files: LaunchFiles | null): Promise<void> {
    st.inFlight = [batch];
    st.turnInterrupted = false;
    st.stopRequested = false;
    const run = async () => {
      let proc = existing;
      try {
        let resume = proc?.resume ?? this.resumeFor(st);
        for (let attempt = 0; ; attempt++) {
          if (!proc) {
            proc = await this.#spawn(st, resume, files);
            this.abortIfStopped(st, proc);
          }
          this.clearTimer(st, "idleTimer");
          st.inFlight = [batch];
          proc.child.stdin.write(batch.line + "\n");
          this.armStartTimer(st, proc);
          const outcome = await proc.ready;
          if (outcome.kind === "ok") return;
          if (outcome.kind === "closed") {
            if (outcome.reason === "interrupt") return;
            throw new DriverError(
              "spawn_failed",
              this.shuttingDown ? "driver is shutting down" : `closed before system/init (${outcome.reason})`,
            );
          }
          proc = null;
          if (outcome.conflict && attempt === 0 && !outcome.timedOut) {
            resume = outcome.conflict === "session_in_use";
            continue;
          }
          throw startupError(outcome, this.opts.startTimeoutMs, attempt > 0);
        }
      } catch (error) {
        this.dropBatch(st, batch);
        throw error;
      }
    };
    return run();
  }

  async #spawn(st: SessionState, resume: boolean, prepared: LaunchFiles | null): Promise<Proc> {
    const { row, files } = await this.resolveLaunchFiles(st, prepared);
    const launch = spawnInWriteScope(
      "claude",
      { command: this.#claudePath, args: buildClaudeArgs(row, files, resume) },
      files.writeScope ?? null,
      this.opts.log,
      `session ${st.id}`,
    );
    const child = await this.spawnDetachedChild(
      this.#claudePath,
      launch.command,
      launch.args,
      row.cwd,
      files.env,
    );
    const { baseProc, resolveExited } = this.createBaseProc<ClaudeStartupOutcome>(child, resume, row, files);
    const proc: Proc = {
      ...baseProc,
      readonlyGate: files.readonly
        ? new ClaudeReadonlyGate(files.readonly, (line) => child.stdin.write(line + "\n"))
        : null,
      capabilities: new Set(),
    };
    this.attachChildProcess(st, proc, resolveExited, () => proc.readonlyGate?.dispose());
    return proc;
  }

  // --- 读输出 ---

  protected onParsedLine(
    st: SessionState,
    proc: Proc,
    obj: Record<string, unknown>,
    line: string,
    at: number,
  ): void {
    switch (obj.type) {
      case "system":
        if (obj.subtype === "init") this.#onInit(st, proc, obj, at);
        else if (obj.subtype === "api_retry") this.#onApiRetry(st, obj, at);
        else if (obj.subtype === "commands_changed") this.#onCommandsChanged(st, obj, at);
        else if (obj.subtype === "background_tasks_changed") this.onBackgroundTasksChanged(st, proc, obj.tasks);
        else if (obj.subtype === "compact_boundary") this.#onCompactBoundary(st, obj, line, at);
        return;
      case "conversation_reset":
        this.logSession(
          st.id,
          `claude 出了 conversation_reset（${String(obj.trigger ?? "")}），会话 ID 可能换了，--resume 仍用原来的`,
        );
        return;
      case "command_lifecycle":
        this.#onLifecycle(st, proc, obj, at);
        return;
      case "user":
        if (isInterruptMarker(obj)) st.turnInterrupted = true;
        else if (obj.isReplay === true) {
          const first = st.inFlight[0];
          if (!proc.capabilities.has("msg_lifecycle_v1") && first) this.markProcessing(st, first, at);
        } else {
          const result = parseToolResults(obj, at);
          if (result) this.emit(st.id, result);
        }
        return;
      case "assistant": {
        const row = this.row(st);
        const live = row ? st.turnUsage.observe(obj, row.usage) : null;
        if (live) this.pushUsage(st, live);
        for (const ev of parseAssistant(obj, line, at)) this.emit(st.id, ev);
        return;
      }
      case "rate_limit_event": {
        const info = parseRateLimit(obj.rate_limit_info);
        if (!info) return;
        this.update(st, { rateLimit: info });
        this.emit(st.id, { type: "rate_limit", info, at });
        return;
      }
      case "control_request":
        proc.readonlyGate?.onControlRequest(obj);
        return;
      case "control_response": {
        if (proc.readonlyGate?.onControlResponse(obj)) return;
        const response = obj.response as { subtype?: unknown; request_id?: unknown; response?: unknown } | undefined;
        const query = typeof response?.request_id === "string" ? st.commandQueries.get(response.request_id) : undefined;
        if (query) {
          const body = response?.response as { commands?: unknown } | undefined;
          query(response?.subtype === "success" ? this.composer.parseCommands(body?.commands) : null);
          return;
        }
        if (response?.request_id === undefined || response.request_id !== st.interruptRequestId) return;
        this.clearTimer(st, "interruptTimer");
        if (response.subtype === "success") {
          const cancelled = new Set(interruptCancelled(response.response));
          this.#cancelBatches(st, proc, st.inFlight.filter((b) => !b.started && cancelled.has(b.uuid)), at);
          this.resolveInterrupt(st);
        } else this.sigintForInterrupt(st, proc);
        return;
      }
      case "result":
        this.#onResult(st, proc, obj, at);
        return;
    }
  }

  #onCommandsChanged(st: SessionState, obj: Record<string, unknown>, at: number): void {
    const commands = this.composer.parseCommands(obj.commands);
    if (commands) this.emit(st.id, { type: "commands.changed", commands, at });
  }

  #onCompactBoundary(st: SessionState, obj: Record<string, unknown>, rawLine: string, at: number): void {
    const meta = (
      typeof obj.compact_metadata === "object" && obj.compact_metadata !== null ? obj.compact_metadata : {}
    ) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    this.emit(st.id, {
      type: "context.compacted",
      uuid: lineUuid(obj, rawLine),
      trigger: typeof meta.trigger === "string" ? meta.trigger : null,
      preTokens: num(meta.pre_tokens),
      postTokens: num(meta.post_tokens),
      at,
    });
  }

  #onApiRetry(st: SessionState, obj: Record<string, unknown>, at: number): void {
    const info = parseApiRetry(obj, at);
    if (info) this.emit(st.id, { type: "api_retry", info, at });
  }

  #onLifecycle(st: SessionState, proc: Proc, obj: Record<string, unknown>, at: number): void {
    const event = parseLifecycle(obj);
    const batch = event ? st.inFlight.find((b) => b.uuid === event.uuid) : undefined;
    if (!event || !batch) return;
    if (event.state === "started") {
      batch.started = true;
      if (proc.initSeen) this.markProcessing(st, batch, at);
    } else if (event.state === "cancelled" && !batch.started) {
      this.#cancelBatches(st, proc, [batch], at);
    }
  }

  #cancelBatches(st: SessionState, proc: Proc, batches: Batch[], at: number): void {
    if (batches.length === 0) return;
    st.inFlight = st.inFlight.filter((b) => !batches.includes(b));
    this.releaseOnStop(st, batches, at);
    if (!this.busy(st)) {
      this.afterTurn(st, proc);
      this.settled(st);
    }
  }

  #onInit(st: SessionState, proc: Proc, obj: Record<string, unknown>, at: number): void {
    if (proc.initSeen) {
      if (st.inFlight.length === 0 && !st.selfTurn && st.proc === proc) {
        st.selfTurn = true;
        this.clearTimer(st, "idleTimer");
        this.emit(st.id, { type: "turn.started", at });
      }
      return;
    }
    proc.initSeen = true;
    this.markHealthy(st.id);
    this.setPersonaSeen(st, personaSeenAtStart(st, this.row(st), proc.personaLaunched, !proc.resume));
    proc.capabilities = parseCapabilities(obj);
    if (proc.capabilities.has("msg_lifecycle_v1") && !midTurnCapable(proc)) {
      this.logSession(st.id, "claude 不支持停止时取消排着的消息（没有 interrupt_cancel_queued_v1），忙时照旧排队");
    }
    this.clearTimer(st, "startTimer");
    const model = typeof obj.model === "string" ? obj.model : null;
    const tools = Array.isArray(obj.tools) ? obj.tools.filter((t): t is string => typeof t === "string") : [];
    const patch: AgentSessionPatch = { status: "running", lastEventAt: at };
    const row = this.row(st);
    if (row && row.hasCompletedTurn !== proc.resume) patch.hasCompletedTurn = proc.resume;
    st.resumeHint = null;
    this.update(st, patch);
    this.emit(st.id, { type: "session.started", resumed: proc.resume, model, tools, at });
    for (const batch of st.inFlight) {
      this.markDelivered(st, batch);
      if (batch.started) this.markProcessing(st, batch, at);
    }
    proc.resolveReady({ kind: "ok" });
  }

  #onResult(st: SessionState, proc: Proc, obj: Record<string, unknown>, at: number): void {
    if (!proc.initSeen) return;
    const batches = this.#takeSettled(st, proc);
    st.selfTurn = false;
    for (const batch of batches) this.markProcessing(st, batch, at);
    const ok = obj.subtype === "success" && obj.is_error !== true;
    const subtype = typeof obj.subtype === "string" ? obj.subtype : "unknown";
    const event: DriverEvent = {
      type: "turn.ended",
      ok,
      interrupted: st.turnInterrupted,
      messageIds: batches.flatMap((b) => b.messageIds),
      durationMs: typeof obj.duration_ms === "number" ? obj.duration_ms : null,
      at,
    };
    if (proc.closing === "shutdown" && (!ok || st.turnInterrupted)) event.shutdown = true;
    if (!ok) {
      event.error = { subtype, message: resultMessage(obj, subtype) };
      this.forgetWritten(st, batches);
    } else {
      this.markHealthy(st.id);
    }
    st.turnInterrupted = false;
    st.stopRequested = false;
    const row = this.row(st);
    this.cancelUsagePush(st);
    const patch: AgentSessionPatch = { usage: st.turnUsage.finish(row?.usage ?? EMPTY_TOKEN_USAGE, obj.usage) };
    if (row?.hasCompletedTurn === false) patch.hasCompletedTurn = true;
    this.update(st, patch);
    this.clearTimer(st, "interruptTimer");
    this.emit(st.id, event);
    this.resolveInterrupt(st);
    this.afterTurn(st, proc);
    this.settled(st);
  }

  #takeSettled(st: SessionState, proc: Proc): Batch[] {
    if (!proc.capabilities.has("msg_lifecycle_v1")) return st.inFlight.splice(0);
    let settled = st.inFlight.filter((b) => b.started);
    const first = st.inFlight[0];
    if (settled.length === 0 && !st.selfTurn && first && !first.midTurn) settled = [first];
    st.inFlight = st.inFlight.filter((b) => !settled.includes(b));
    return settled;
  }

  protected onProcessClose(
    st: SessionState,
    proc: Proc,
    code: number | null,
    signal: NodeJS.Signals | null,
    resolveExited: () => void,
  ): void {
    try {
      const at = this.beginProcessClose(st, proc);
      if (!proc.initSeen) {
        if (proc.closing === null) {
          const conflict = detectArgsConflict(proc.stderr);
          if (conflict && st.inFlight.length === 0) st.resumeHint = conflict === "session_in_use";
          this.forgetWritten(st, st.inFlight);
          proc.resolveReady({
            kind: "failed",
            exitCode: code,
            signal,
            stderr: proc.stderr,
            conflict,
            timedOut: proc.startTimedOut,
          });
          this.emit(st.id, {
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
        if (proc.closing === "interrupt") for (const batch of st.inFlight) this.markDelivered(st, batch);
        proc.resolveReady({ kind: "closed", reason: proc.closing });
      }
      const batches = proc.initSeen || proc.closing === "interrupt" ? st.inFlight : [];
      st.inFlight = [];
      st.selfTurn = false;
      const reason: SessionExitReason = proc.closing ?? "crash";
      const untaken = batches.filter((b) => b.midTurn && !b.started && proc.capabilities.has("msg_lifecycle_v1"));
      const taken = batches.filter((b) => !untaken.includes(b));
      if (taken.length > 0 && reason === "crash") {
        st.crashNote = true;
        this.forgetWritten(st, taken);
      }
      const stopped = reason === "interrupt" || st.stopRequested;
      st.interruptRequestId = null;
      st.stopRequested = false;
      this.emit(st.id, {
        type: "session.exited",
        reason,
        exitCode: code,
        signal,
        hadResult: taken.length === 0,
        messageIds: taken.flatMap((b) => b.messageIds),
        at,
      });
      this.releaseUntaken(st, untaken, stopped, at);
    } finally {
      for (const query of [...st.commandQueries.values()]) query(null);
      this.resolveInterrupt(st);
      resolveExited();
      this.settled(st);
    }
  }

  protected override resolveInterrupt(st: SessionState): void {
    st.interruptRequestId = null;
    super.resolveInterrupt(st);
  }
}

export function createClaudeDriver(options: ClaudeDriverOptions): ClaudeDriver {
  return new ClaudeDriver(options);
}

function resultMessage(obj: Record<string, unknown>, subtype: string): string {
  if (typeof obj.result === "string" && obj.result !== "") return obj.result;
  if (Array.isArray(obj.errors) && obj.errors.length > 0) return obj.errors.map(String).join("; ");
  return subtype;
}

function startupError(
  outcome: Extract<ClaudeStartupOutcome, { kind: "failed" }>,
  startTimeoutMs: number,
  retried: boolean,
): DriverError {
  if (outcome.timedOut) return new DriverError("start_timeout", `no system/init within ${startTimeoutMs} ms`);
  const how = outcome.signal ? `signal ${outcome.signal}` : `exit code ${outcome.exitCode}`;
  const stderr = outcome.stderr.trim();
  if (outcome.conflict) {
    return new DriverError(
      "start_args_conflict",
      `${retried ? "after switching --session-id/--resume: " : ""}${stderr || how}`,
    );
  }
  return new DriverError("spawn_failed", `claude exited before system/init (${how})${stderr ? `: ${stderr}` : ""}`);
}

function newBatch(
  messageIds: MessageId[],
  line: string,
  uuid: string,
  notes: BatchNotes,
  source: MessageSource,
): Batch {
  return {
    messageIds,
    line,
    uuid,
    notes,
    delivered: false,
    processing: false,
    started: false,
    midTurn: false,
    source,
    stopped: false,
    released: null,
  };
}

function midTurnCapable(proc: Proc): boolean {
  return MID_TURN_CAPABILITIES.every((c) => proc.capabilities.has(c));
}
