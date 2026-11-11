// Pi 常驻 RPC 驱动层（docs/vendors/pi.md 第 4、5 节）：每个会话一个 `pi --mode rpc --session-id <id>` 进程，
// 公共会话状态机继承自 BaseSessionDriver（底层按 `\n` 切分 JSONL，不使用 node:readline，天然避开 U+2028/U+2029 截断问题）；
// 本文件负责 Pi 专有协议：
// - 启动后 `get_state` 握手、会话 ID 持久化与恢复；
// - `--append-system-prompt`、`--no-approve` 与显式 `--skill <dir>/.agents/skills`（不传 `--approve`）；
// - 只读 Worker 附加 `--exclude-tools edit,write --no-mcp` 并包入外层只读 OS 沙箱；普通 Worker 包入 `spawnInWriteScope`；
// - 多轮对话、忙时中途插话（`prompt` 带 `streamingBehavior: "steer"`）、手动 `/compact` 走 RPC `compact`；
// - 优雅打断（先 `clear_queue` 再 `abort`，超时升级 SIGINT → SIGKILL 进程组）；
// - 流式思考、文本、工具事件去重，轮末通过 `get_session_stats` 对接累计用量与上下文换代阈值。
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
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
  type ReadonlyPolicy,
  type SessionExitReason,
  type SessionId,
  type TokenUsage,
  type WriteScope,
} from "../../shared/index.ts";
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
import { personaSeenAtStart } from "../../daemon/driver/persona-note.ts";
import { lineUuid } from "../../daemon/driver/protocol.ts";
import {
  scanSecretGlobs,
  spawnInWriteScope,
  wrapInReadonlyOsSandbox,
  type ReadonlySandboxInput,
  type ScopedSpawn,
  type SpawnCommand,
} from "../../daemon/driver/write-scope.ts";
import type { VendorComposerBase } from "../../daemon/vendors/types.ts";
import { piComposerBase } from "./composer.ts";
import { PI_SESSION_STATS_TIMEOUT_MS } from "./limits.ts";
import {
  addPiTokenCounts,
  buildAbortLine,
  buildBlockingExtensionUiCancelLine,
  buildClearQueueLine,
  buildCompactLine,
  buildGetCommandsLine,
  buildGetSessionStatsLine,
  buildGetStateLine,
  buildPiArgs,
  buildPromptLine,
  checkPiTurnText,
  combinePiTurnText,
  extractPiAssistantBlocks,
  extractPiUserMessageText,
  formatPiActiveModel,
  isValidPiSessionId,
  parsePiAutoRetry,
  parsePiCompactInput,
  parsePiSessionStats,
  parsePiTokenCounts,
  piOfSession,
  subtractPiTokenCounts,
  toClaudeStyleUsage,
  type PiRawTokenCounts,
} from "./protocol.ts";
import { READONLY_PI_NEEDS_SANDBOX_MESSAGE, piReadonlySandboxInput } from "./readonly.ts";
import { piTranscriptPath } from "./transcript.ts";

interface Batch extends BaseBatch {
  rawText: string;
  combinedText: string;
  /** 是否收到 Pi `message_start`（role === "user"）回显确认已被模型消费。 */
  echoed: boolean;
  /** 是否为在忙时中途通过 `streamingBehavior: "steer"` 写入的插话。 */
  midTurn: boolean;
  /** 插话回执尚未到达前用户点了停止。 */
  stopped: boolean;
  /** 插话回执尚未到达前当前轮已结束。 */
  turnDone: boolean;
  /** 本批次是否为手动 `/compact` RPC。 */
  isCompact: boolean;
}

type SteerResult = "written" | "queued" | "cancelled";

interface Steer {
  entry: PendingEntry;
  batch: Batch;
  resolve: (result: SteerResult) => void;
}

type PendingRpcKind =
  | { kind: "init_state" }
  | { kind: "init_stats" }
  | { kind: "prompt_open" }
  | { kind: "steer" }
  | { kind: "compact" }
  | { kind: "clear_queue" }
  | { kind: "abort" }
  | { kind: "turn_stats" }
  | { kind: "commands"; done: (commands: ComposerCommand[] | null) => void };

type PiStartupOutcome = StartupOutcome<null> & { errorMessage?: string };

interface Proc extends BaseProc<PiStartupOutcome> {
  sessionId: string;
  tmpDir: string | null;
  pendingRpcs: Map<string, PendingRpcKind>;
  steers: Map<string, Steer>;
  /** 上次 `get_session_stats` 汇报的会话累计 token（用于在无单条 message usage 时算差值兜底）。 */
  lastSessionTokens: PiRawTokenCounts;
}

interface SessionState extends BaseSessionState<Proc, Batch> {
  interruptSent: boolean;
  turnSeq: number;
  assistantMsgSeq: number;
  eventSeq: number;
  /** 当前轮按 `${assistantMsgSeq}:${contentIndex}` 缓存尚未结束的文本增量。 */
  textBuffers: Map<string, string>;
  /** 当前轮已发出过 `agent.text` 的键，防止流式与 `message_end` 重复发射。 */
  emittedTextKeys: Set<string>;
  /** 当前轮已发出过 `agent.thinking` 的键。 */
  emittedThinkingKeys: Set<string>;
  /** 当前轮已发出过 `agent.tool` 的 toolCallId。 */
  emittedToolIds: Set<string>;
  /** 当前轮已发出过 `agent.tool_result` 的 toolCallId。 */
  completedToolIds: Set<string>;
  /** 当前轮内是否已发出过 `context.compacted`（防止手动 `/compact` 在事件与回执重复记）。 */
  compactedInTurn: boolean;
  /** 当前轮通过 `message_end` 累计的 token 数（有值时优先作为本轮增量）。 */
  turnTokenTotals: PiRawTokenCounts;
  hasMessageUsageInTurn: boolean;
  /** 当前轮 assistant `stopReason === "error"` 报出的错误文本。 */
  turnErrorMessage: string | null;
  /** 正在跑手动 `/compact` RPC 时不接受中途 steer。 */
  runningCompact: boolean;
  /** 已收到 `agent_settled`，正等待 `get_session_stats` 回应做最终结算。 */
  awaitingStats: boolean;
  statsTimer: NodeJS.Timeout | null;
}

export interface PiDriverOptions extends Omit<DriverOptions, "executablePath"> {
  executablePath?: string;
  composer?: VendorComposerBase;
  homeDir?: string;
  writeScopeSpawn?: (base: SpawnCommand, scope: WriteScope | null) => ScopedSpawn;
  readonlySpawn?: (base: SpawnCommand, input: ReadonlySandboxInput) => ScopedSpawn;
}

const ZERO_RAW_COUNTS: PiRawTokenCounts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

export class PiDriver extends BaseSessionDriver<Proc, Batch, SessionState> {
  readonly #piPath: string;
  readonly #homeDir?: string;
  readonly #writeScopeSpawn?: (base: SpawnCommand, scope: WriteScope | null) => ScopedSpawn;
  readonly #readonlySpawn?: (base: SpawnCommand, input: ReadonlySandboxInput) => ScopedSpawn;

  constructor(options: PiDriverOptions) {
    super("pi", { ...options, composer: options.composer ?? piComposerBase });
    this.#piPath = options.executablePath ?? "pi";
    this.#homeDir = options.homeDir;
    this.#writeScopeSpawn = options.writeScopeSpawn;
    this.#readonlySpawn = options.readonlySpawn;
  }

  protected createSessionState(id: SessionId): SessionState {
    return {
      ...createBaseSessionState<Proc, Batch>(id),
      interruptSent: false,
      turnSeq: 0,
      assistantMsgSeq: 0,
      eventSeq: 0,
      textBuffers: new Map(),
      emittedTextKeys: new Set(),
      emittedThinkingKeys: new Set(),
      emittedToolIds: new Set(),
      completedToolIds: new Set(),
      compactedInTurn: false,
      turnTokenTotals: { ...ZERO_RAW_COUNTS },
      hasMessageUsageInTurn: false,
      turnErrorMessage: null,
      runningCompact: false,
      awaitingStats: false,
      statsTimer: null,
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
    const problem = checkPiTurnText(combinePiTurnText(parts.text, parts.prefixes, this.composer.buildUserContent));
    if (problem) {
      this.invalidInput(st, problem, ids);
      return { kind: "rejected" };
    }
    if (!this.isPending(st, ids)) {
      if (input.recovery) st.recoveryNote = true;
      const proc = st.proc;
      if (proc && this.#canSteer(st, proc, entry)) {
        const result = await this.#sendSteer(st, proc, entry);
        if (result === "written") return { kind: "written", midTurn: true };
        if (result === "cancelled") return { kind: "cancelled" };
      } else {
        st.pending.push(entry);
      }
    }
    await this.pump(st);
    return ids.every((id) => st.written.has(id)) ? { kind: "written" } : { kind: "queued" };
  }

  #canSteer(st: SessionState, proc: Proc, entry: PendingEntry): boolean {
    return (
      proc.initSeen &&
      !proc.closing &&
      !this.shuttingDown &&
      this.busy(st) &&
      !st.runningCompact &&
      !st.awaitingStats &&
      st.starting === null &&
      !st.stopRequested &&
      st.pending.length === 0 &&
      !this.composer.isCommand(entry.text)
    );
  }

  #sendSteer(st: SessionState, proc: Proc, entry: PendingEntry): Promise<SteerResult> {
    const batch = this.#batchOf(st, entryParts(entry), entry.messageIds, false, entry.source);
    batch.midTurn = true;
    st.inFlight.push(batch);
    this.clearTimer(st, "idleTimer");
    const reqId = `rpc-${++this.requestSeq}`;
    return new Promise<SteerResult>((resolve) => {
      const steer: Steer = { entry, batch, resolve };
      proc.steers.set(reqId, steer);
      proc.pendingRpcs.set(reqId, { kind: "steer" });
      proc.child.stdin.write(`${buildPromptLine(reqId, batch.combinedText, true)}\n`, (err) => {
        if (!err || !proc.steers.has(reqId)) return;
        proc.steers.delete(reqId);
        proc.pendingRpcs.delete(reqId);
        this.#settleSteer(st, steer, false);
        if (!this.busy(st)) this.#idleAfterSteer(st, proc);
      });
    });
  }

  #settleSteer(st: SessionState, steer: Steer, accepted: boolean): void {
    const { batch } = steer;
    if (accepted && !batch.turnDone) {
      this.markDelivered(st, batch);
      steer.resolve("written");
      return;
    }
    this.dropBatch(st, batch);
    if (batch.stopped && batch.source === "user") {
      this.emit(st.id, { type: "message.cancelled", messageIds: batch.messageIds, reason: "stop", at: Date.now() });
      steer.resolve("cancelled");
      return;
    }
    if (!st.ended) st.pending.unshift(steer.entry);
    steer.resolve("queued");
  }

  #idleAfterSteer(st: SessionState, proc: Proc): void {
    this.clearTimer(st, "interruptTimer");
    st.stopRequested = false;
    st.turnInterrupted = false;
    this.resolveInterrupt(st);
    this.afterTurn(st, proc);
    this.settled(st);
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
    st.turnInterrupted = true;
    for (const batch of st.inFlight) {
      if (batch.midTurn && !batch.delivered) batch.stopped = true;
    }
    const done = new Promise<void>((resolve) => st.interruptWaiters.push(resolve));
    if (!st.interruptSent) {
      st.interruptSent = true;
      const clearId = `rpc-${++this.requestSeq}`;
      const abortId = `rpc-${++this.requestSeq}`;
      proc.pendingRpcs.set(clearId, { kind: "clear_queue" });
      proc.pendingRpcs.set(abortId, { kind: "abort" });
      // 先清排队中的 steer / follow-up，再打断当前正在跑的轮次
      proc.child.stdin.write(`${buildClearQueueLine(clearId)}\n`);
      proc.child.stdin.write(`${buildAbortLine(abortId)}\n`);
      st.interruptTimer = setTimeout(() => {
        st.interruptTimer = null;
        this.sigintForInterrupt(st, proc, "killTimer");
      }, this.opts.interruptGraceMs);
    }
    return done;
  }

  override queryCommands(sessionId: SessionId): Promise<ComposerCommand[] | null> {
    const st = this.sessions.get(sessionId);
    const proc = st?.proc;
    if (!st || !proc || !proc.initSeen || proc.closing || this.shuttingDown) return Promise.resolve(null);
    const reqId = `rpc-${++this.requestSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(null), this.opts.commandsTimeoutMs);
      const done = (commands: ComposerCommand[] | null) => {
        clearTimeout(timer);
        proc.pendingRpcs.delete(reqId);
        resolve(commands);
      };
      proc.pendingRpcs.set(reqId, { kind: "commands", done });
      proc.child.stdin.write(`${buildGetCommandsLine(reqId)}\n`, (err) => {
        if (err) done(null);
      });
    });
  }

  protected override filterStaleRow(row: AgentSessionRow): boolean {
    return row.vendor === "pi";
  }

  protected identifyStaleProcess(pid: number, row: AgentSessionRow): Promise<number | null> {
    return piOfSession(pid, row.vendorSessionId);
  }

  protected override resolveInterrupt(st: SessionState): void {
    st.interruptSent = false;
    super.resolveInterrupt(st);
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
    if (command) {
      const combined = combinePiTurnText(body.text, body.prefixes, this.composer.buildUserContent);
      return newBatch(messageIds, body.text, combined, NO_NOTES, source, parsePiCompactInput(body.text) !== null);
    }
    const { notes, prefixes } = this.takeNotesPrefixes(st);
    const combined = combinePiTurnText(body.text, [...prefixes, ...body.prefixes], this.composer.buildUserContent);
    return newBatch(messageIds, body.text, combined, notes, source, false);
  }

  #clearTurnBuffers(st: SessionState): void {
    if (st.statsTimer !== null) {
      clearTimeout(st.statsTimer);
      st.statsTimer = null;
    }
    st.awaitingStats = false;
    st.assistantMsgSeq = 0;
    st.textBuffers.clear();
    st.emittedTextKeys.clear();
    st.emittedThinkingKeys.clear();
    st.emittedToolIds.clear();
    st.completedToolIds.clear();
    st.compactedInTurn = false;
    st.turnTokenTotals = { ...ZERO_RAW_COUNTS };
    st.hasMessageUsageInTurn = false;
    st.turnErrorMessage = null;
  }

  protected async writeBatch(st: SessionState, proc: Proc, batch: Batch): Promise<void> {
    const problem = checkPiTurnText(batch.combinedText);
    if (problem) {
      this.invalidInput(st, problem, batch.messageIds);
      this.afterTurn(st, proc);
      return;
    }
    this.clearTimer(st, "idleTimer");
    if (!st.inFlight.includes(batch)) st.inFlight.push(batch);
    st.turnSeq += 1;
    st.turnInterrupted = false;
    st.stopRequested = false;
    this.#clearTurnBuffers(st);

    const compact = batch.isCompact ? parsePiCompactInput(batch.rawText) : null;
    st.runningCompact = compact !== null;

    const reqId = `rpc-${++this.requestSeq}`;
    let line: string;
    if (compact !== null) {
      proc.pendingRpcs.set(reqId, { kind: "compact" });
      line = buildCompactLine(reqId, compact.customInstructions);
    } else {
      proc.pendingRpcs.set(reqId, { kind: "prompt_open" });
      line = buildPromptLine(reqId, batch.combinedText, false);
    }

    await new Promise<void>((resolve) => {
      proc.child.stdin.write(`${line}\n`, (err) => {
        if (!err) {
          this.markDelivered(st, batch);
          if (compact !== null) {
            batch.echoed = true;
            this.markProcessing(st, batch, Date.now());
          }
        }
        resolve();
      });
    });
  }

  protected resumeFor(st: SessionState): boolean {
    if (st.resumeHint !== null) return st.resumeHint;
    const row = this.store(st);
    return row.hasCompletedTurn && row.vendorSessionId.trim() !== "";
  }

  protected async spawnIdleProcess(st: SessionState, resume: boolean): Promise<Proc> {
    const proc = await this.#spawn(st, resume, null);
    this.armStartTimer(st, proc);
    const outcome = await proc.ready;
    if (outcome.kind === "ok") return proc;
    if (outcome.kind === "closed") {
      throw new DriverError(
        "spawn_failed",
        this.shuttingDown ? "driver is shutting down" : `closed before get_state (${outcome.reason})`,
      );
    }
    throw startupError(outcome, this.opts.startTimeoutMs);
  }

  protected startup(st: SessionState, batch: Batch, existing: Proc | null, files: LaunchFiles | null): Promise<void> {
    st.inFlight = [batch];
    st.turnInterrupted = false;
    st.stopRequested = false;
    const run = async () => {
      try {
        const resume = existing?.resume ?? this.resumeFor(st);
        const proc = existing ?? (await this.#spawn(st, resume, files));
        this.abortIfStopped(st, proc);
        this.clearTimer(st, "idleTimer");
        st.inFlight = [batch];
        this.armStartTimer(st, proc);
        const outcome = await proc.ready;
        if (outcome.kind === "ok") {
          await this.writeBatch(st, proc, batch);
          return;
        }
        if (outcome.kind === "closed") {
          if (outcome.reason === "interrupt") return;
          throw new DriverError(
            "spawn_failed",
            this.shuttingDown ? "driver is shutting down" : `closed before get_state (${outcome.reason})`,
          );
        }
        throw startupError(outcome, this.opts.startTimeoutMs);
      } catch (error) {
        this.dropBatch(st, batch);
        throw error;
      }
    };
    return run();
  }

  async #spawn(st: SessionState, resume: boolean, prepared: LaunchFiles | null): Promise<Proc> {
    const { row, files } = await this.resolveLaunchFiles(st, prepared);
    const existingId = row.vendorSessionId.trim();
    const sessionId = isValidPiSessionId(existingId) ? existingId : randomUUID();

    const readonlyPolicy: ReadonlyPolicy | undefined =
      files.readonly === undefined
        ? undefined
        : {
            ...files.readonly,
            secretPaths: [
              ...new Set([
                ...files.readonly.secretPaths,
                ...scanSecretGlobs([row.cwd, ...row.addDirs], files.readonly.secretGlobs),
              ]),
            ],
          };
    const effectiveFiles: LaunchFiles =
      readonlyPolicy === undefined ? files : { ...files, readonly: readonlyPolicy };

    const resumedTranscript = resume
      ? piTranscriptPath(
          { vendor: "pi", cwd: row.cwd, vendorSessionId: sessionId },
          { home: this.#homeDir, env: effectiveFiles.env },
        )
      : null;

    const args = buildPiArgs({
      row,
      files: effectiveFiles,
      sessionId,
      sessionFile: resumedTranscript,
    });

    let tmpDir: string | null = null;
    let launch: ScopedSpawn;
    let childEnv: Record<string, string> = { ...effectiveFiles.env };

    if (readonlyPolicy === undefined) {
      const wrapWriteScope =
        this.#writeScopeSpawn ??
        ((base, scope) => spawnInWriteScope("pi", base, scope, this.opts.log, `session ${st.id}`));
      launch = wrapWriteScope({ command: this.#piPath, args }, effectiveFiles.writeScope ?? null);
    } else {
      const home = realpathSync(this.#homeDir ?? homedir());
      const wrap = this.#readonlySpawn ?? ((base, input) => wrapInReadonlyOsSandbox(base, input));
      const privateTmp = mkdtempSync(join(realpathSync(tmpdir()), "agent-hub-ro-"));
      launch = wrap(
        { command: this.#piPath, args },
        piReadonlySandboxInput({
          homeDir: home,
          tmpDir: privateTmp,
          policy: readonlyPolicy,
          env: effectiveFiles.env,
        }),
      );
      if (!launch.osSandboxed) {
        rmSync(privateTmp, { recursive: true, force: true });
        throw new DriverError("spawn_failed", READONLY_PI_NEEDS_SANDBOX_MESSAGE);
      }
      tmpDir = privateTmp;
      childEnv = { ...childEnv, TMPDIR: privateTmp };
    }

    const removeTmp = () => {
      if (tmpDir !== null) rmSync(tmpDir, { recursive: true, force: true });
    };

    const child = await this.spawnDetachedChild(
      this.#piPath,
      launch.command,
      launch.args,
      row.cwd,
      childEnv,
      removeTmp,
    );

    const { baseProc, resolveExited } = this.createBaseProc<PiStartupOutcome>(child, resume, row, effectiveFiles);
    const proc: Proc = {
      ...baseProc,
      sessionId,
      tmpDir,
      pendingRpcs: new Map(),
      steers: new Map(),
      lastSessionTokens: { ...ZERO_RAW_COUNTS },
    };

    this.attachChildProcess(st, proc, resolveExited, removeTmp);

    const initReqId = `rpc-${++this.requestSeq}`;
    const statsReqId = `rpc-${++this.requestSeq}`;
    proc.pendingRpcs.set(initReqId, { kind: "init_state" });
    proc.pendingRpcs.set(statsReqId, { kind: "init_stats" });
    proc.child.stdin.write(`${buildGetStateLine(initReqId)}\n`);
    proc.child.stdin.write(`${buildGetSessionStatsLine(statsReqId)}\n`);

    return proc;
  }

  // ---- RPC 行解析 ----

  protected onParsedLine(
    st: SessionState,
    proc: Proc,
    obj: Record<string, unknown>,
    rawLine: string,
    at: number,
  ): void {
    const cancelUi = buildBlockingExtensionUiCancelLine(obj);
    if (cancelUi !== null) {
      proc.child.stdin.write(`${cancelUi}\n`);
      return;
    }

    switch (obj.type) {
      case "response":
        this.#onRpcResponse(st, proc, obj, at);
        return;
      case "agent_start":
        if (proc.initSeen && st.inFlight.length === 0 && !st.selfTurn && st.proc === proc) {
          st.selfTurn = true;
          this.clearTimer(st, "idleTimer");
          this.emit(st.id, { type: "turn.started", at });
        }
        return;
      case "message_start":
        this.#onMessageStart(st, obj, at);
        return;
      case "message_update":
        this.#onMessageUpdate(st, obj, at);
        return;
      case "message_end":
        this.#onMessageEnd(st, obj, at);
        return;
      case "tool_execution_start":
        this.#onToolExecutionStart(st, obj, at);
        return;
      case "tool_execution_end":
        this.#onToolExecutionEnd(st, obj, at);
        return;
      case "auto_retry_start": {
        const info = parsePiAutoRetry(obj, at);
        if (info) this.emit(st.id, { type: "api_retry", info, at });
        return;
      }
      case "compaction_end":
        this.#onCompactionEnd(st, obj, rawLine, at);
        return;
      case "agent_settled":
        this.#onAgentSettled(st, proc, obj, at);
        return;
    }
  }

  #onRpcResponse(st: SessionState, proc: Proc, obj: Record<string, unknown>, at: number): void {
    const id = typeof obj.id === "string" ? obj.id : typeof obj.id === "number" ? String(obj.id) : "";
    if (id === "") return;
    const rpc = proc.pendingRpcs.get(id);
    if (!rpc) return;
    proc.pendingRpcs.delete(id);

    const ok = obj.success !== false;
    const errText = typeof obj.error === "string" && obj.error !== "" ? obj.error : `${String(obj.command ?? "rpc")} failed`;
    const data = typeof obj.data === "object" && obj.data !== null ? (obj.data as Record<string, unknown>) : null;

    switch (rpc.kind) {
      case "init_state": {
        if (!ok) {
          proc.resolveReady({
            kind: "failed",
            exitCode: null,
            signal: null,
            stderr: proc.stderr,
            conflict: null,
            timedOut: false,
            errorMessage: errText,
          });
          this.forceKillProc(st, proc);
          return;
        }
        if (proc.initSeen) return;
        proc.initSeen = true;
        this.markHealthy(st.id);
        this.clearTimer(st, "startTimer");

        const reportedId = typeof data?.sessionId === "string" && data.sessionId.trim() !== "" ? data.sessionId.trim() : proc.sessionId;
        proc.sessionId = reportedId;
        const row = this.row(st);
        const model = formatPiActiveModel(data?.model) ?? row?.model ?? proc.launched.model;

        this.setPersonaSeen(st, personaSeenAtStart(st, row, proc.personaLaunched, !proc.resume));
        const patch: AgentSessionPatch = {
          status: "running",
          vendorSessionId: reportedId,
          lastEventAt: at,
        };
        if (row && row.hasCompletedTurn !== proc.resume) patch.hasCompletedTurn = proc.resume;
        st.resumeHint = null;
        this.update(st, patch);
        this.emit(st.id, { type: "session.started", resumed: proc.resume, model, tools: [], at });
        proc.resolveReady({ kind: "ok" });
        return;
      }

      case "init_stats": {
        if (ok) {
          const parsed = parsePiSessionStats(data);
          if (parsed.tokens) proc.lastSessionTokens = parsed.tokens;
        }
        return;
      }

      case "commands": {
        rpc.done(ok ? this.composer.parseCommands(data ?? { commands: [] }) : null);
        return;
      }

      case "steer": {
        const steer = proc.steers.get(id);
        proc.steers.delete(id);
        if (!steer) return;
        if (!ok) this.logSession(st.id, `pi steer 没收下：${errText}`);
        this.#settleSteer(st, steer, ok);
        if (!this.busy(st)) this.#idleAfterSteer(st, proc);
        return;
      }

      case "prompt_open": {
        if (!ok) {
          st.turnErrorMessage = errText;
          this.#finalizeTurn(st, proc, null, at);
          return;
        }
        const opening = st.inFlight.find((b) => !b.midTurn);
        if (opening) this.markProcessing(st, opening, at);
        if (data?.disposition === "handled") {
          // 扩展命令同步消费，不会触发 agent_settled，直接收尾本轮
          if (opening) opening.echoed = true;
          this.#finalizeTurn(st, proc, null, at);
        }
        return;
      }

      case "compact": {
        st.runningCompact = false;
        if (!ok) {
          st.turnErrorMessage = errText;
          this.#finalizeTurn(st, proc, null, at);
          return;
        }
        if (!st.compactedInTurn && data) {
          st.compactedInTurn = true;
          const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
          this.emit(st.id, {
            type: "context.compacted",
            uuid: this.#scopedUuid(st, `compact-${++st.eventSeq}`),
            trigger: "manual",
            preTokens: num(data.tokensBefore),
            postTokens: num(data.estimatedTokensAfter),
            at,
          });
        }
        this.#requestTurnStatsAndFinalize(st, proc, at);
        return;
      }

      case "turn_stats": {
        this.#finalizeTurn(st, proc, ok ? data : null, at);
        return;
      }

      case "clear_queue":
      case "abort":
        return;
    }
  }

  #onMessageStart(st: SessionState, obj: Record<string, unknown>, at: number): void {
    const message =
      typeof obj.message === "object" && obj.message !== null ? (obj.message as Record<string, unknown>) : null;
    if (!message) return;
    if (message.role === "user") {
      const text = extractPiUserMessageText(message);
      const waiting = st.inFlight.filter((b) => !b.echoed);
      const batch = waiting.find((b) => b.combinedText === text) ?? waiting[0];
      if (!batch) return;
      batch.echoed = true;
      this.markProcessing(st, batch, at);
      return;
    }
    if (message.role === "assistant") {
      st.assistantMsgSeq += 1;
    }
  }

  #onMessageUpdate(st: SessionState, obj: Record<string, unknown>, at: number): void {
    const opening = st.inFlight.find((b) => !b.midTurn);
    if (opening) this.markProcessing(st, opening, at);

    const message =
      typeof obj.message === "object" && obj.message !== null ? (obj.message as Record<string, unknown>) : null;
    const rawUsage = obj.usage ?? (message?.role === "assistant" ? message.usage : undefined);
    const counts = parsePiTokenCounts(rawUsage);
    if (counts) {
      const row = this.row(st);
      const msgId = `msg-${st.turnSeq}-${st.assistantMsgSeq || 1}`;
      const live = row
        ? st.turnUsage.observe({ message: { id: msgId, usage: toClaudeStyleUsage(counts) } }, row.usage)
        : null;
      if (live) this.pushUsage(st, live);
    }

    const ev =
      typeof obj.assistantMessageEvent === "object" && obj.assistantMessageEvent !== null
        ? (obj.assistantMessageEvent as Record<string, unknown>)
        : null;
    if (!ev) return;

    const msgSeq = st.assistantMsgSeq || 1;
    const contentIdx = typeof ev.contentIndex === "number" ? ev.contentIndex : 0;
    const blockKey = `${msgSeq}:${contentIdx}`;

    switch (ev.type) {
      case "thinking_start":
      case "thinking_delta": {
        this.#emitThinkingOnce(st, blockKey, at);
        return;
      }
      case "text_delta": {
        const delta = typeof ev.delta === "string" ? ev.delta : "";
        if (delta !== "") {
          const isNewBlock = !st.textBuffers.has(blockKey);
          st.textBuffers.set(blockKey, (st.textBuffers.get(blockKey) ?? "") + delta);
          this.emit(st.id, {
            type: "agent.text_delta",
            delta,
            ...(isNewBlock ? { reset: true } : {}),
            at,
          });
        }
        return;
      }
      case "text_end": {
        const fullText =
          typeof ev.content === "string" && ev.content !== "" ? ev.content : (st.textBuffers.get(blockKey) ?? "");
        st.textBuffers.delete(blockKey);
        this.#emitTextOnce(st, blockKey, fullText, at);
        return;
      }
      case "toolcall_start": {
        this.#flushBufferedTexts(st, at);
        return;
      }
      case "toolcall_end": {
        this.#flushBufferedTexts(st, at);
        const tc =
          typeof ev.toolCall === "object" && ev.toolCall !== null ? (ev.toolCall as Record<string, unknown>) : null;
        const toolId = typeof tc?.id === "string" && tc.id !== "" ? tc.id : null;
        if (toolId) {
          this.#emitToolOnce(
            st,
            toolId,
            typeof tc?.name === "string" ? tc.name : "",
            tc?.arguments ?? {},
            at,
          );
        }
        return;
      }
    }
  }

  #onMessageEnd(st: SessionState, obj: Record<string, unknown>, at: number): void {
    const message =
      typeof obj.message === "object" && obj.message !== null ? (obj.message as Record<string, unknown>) : null;
    if (!message || message.role !== "assistant") return;

    const msgSeq = st.assistantMsgSeq || 1;
    const blocks = extractPiAssistantBlocks(message);
    if (blocks.hasThinking) {
      const hasAnyForMsg = [...st.emittedThinkingKeys].some((k) => k.startsWith(`${msgSeq}:`));
      if (!hasAnyForMsg) this.#emitThinkingOnce(st, `${msgSeq}:0`, at);
    }
    for (const t of blocks.texts) {
      const key = `${msgSeq}:${t.index}`;
      st.textBuffers.delete(key);
      this.#emitTextOnce(st, key, t.text, at);
    }
    for (const tc of blocks.toolCalls) {
      this.#emitToolOnce(st, tc.id, tc.name, tc.arguments, at);
    }

    const counts = parsePiTokenCounts(message.usage);
    if (counts) {
      st.turnTokenTotals = addPiTokenCounts(st.turnTokenTotals, counts);
      st.hasMessageUsageInTurn = true;
      const row = this.row(st);
      const msgId = `msg-${st.turnSeq}-${msgSeq}`;
      const live = row
        ? st.turnUsage.observe({ message: { id: msgId, usage: toClaudeStyleUsage(counts) } }, row.usage)
        : null;
      if (live) this.pushUsage(st, live);
    }

    if (message.stopReason === "aborted") {
      st.turnInterrupted = true;
    } else if (message.stopReason === "error") {
      st.turnErrorMessage =
        typeof message.errorMessage === "string" && message.errorMessage.trim() !== ""
          ? message.errorMessage.trim()
          : "assistant error";
    }
  }

  #onToolExecutionStart(st: SessionState, obj: Record<string, unknown>, at: number): void {
    this.#flushBufferedTexts(st, at);
    const toolId = typeof obj.toolCallId === "string" && obj.toolCallId !== "" ? obj.toolCallId : null;
    if (!toolId) return;
    const name = typeof obj.toolName === "string" ? obj.toolName : "";
    this.#emitToolOnce(st, toolId, name, obj.args ?? {}, at);
  }

  #onToolExecutionEnd(st: SessionState, obj: Record<string, unknown>, at: number): void {
    const toolId = typeof obj.toolCallId === "string" && obj.toolCallId !== "" ? obj.toolCallId : null;
    if (!toolId || st.completedToolIds.has(toolId)) return;
    st.completedToolIds.add(toolId);
    this.emit(st.id, { type: "agent.tool_result", toolUseIds: [toolId], at });
  }

  #onCompactionEnd(st: SessionState, obj: Record<string, unknown>, rawLine: string, at: number): void {
    if (obj.aborted === true) return;
    if (typeof obj.errorMessage === "string" && obj.errorMessage !== "") return;
    const res =
      typeof obj.result === "object" && obj.result !== null ? (obj.result as Record<string, unknown>) : null;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const reason = typeof obj.reason === "string" ? obj.reason : null;
    st.compactedInTurn = true;
    this.emit(st.id, {
      type: "context.compacted",
      uuid: lineUuid(obj, rawLine),
      trigger: reason === "manual" ? "manual" : reason !== null ? "auto" : null,
      preTokens: num(res?.tokensBefore),
      postTokens: num(res?.estimatedTokensAfter),
      at,
    });
  }

  #onAgentSettled(st: SessionState, proc: Proc, obj: Record<string, unknown>, at: number): void {
    if (!proc.initSeen) return;
    if (obj.aborted === true) st.turnInterrupted = true;
    this.#requestTurnStatsAndFinalize(st, proc, at);
  }

  #requestTurnStatsAndFinalize(st: SessionState, proc: Proc, at: number): void {
    if (st.awaitingStats) return;
    if (proc.closing) {
      this.#finalizeTurn(st, proc, null, at);
      return;
    }
    st.awaitingStats = true;
    const statsId = `rpc-${++this.requestSeq}`;
    proc.pendingRpcs.set(statsId, { kind: "turn_stats" });
    st.statsTimer = setTimeout(() => {
      proc.pendingRpcs.delete(statsId);
      this.#finalizeTurn(st, proc, null, Date.now());
    }, PI_SESSION_STATS_TIMEOUT_MS);
    proc.child.stdin.write(`${buildGetSessionStatsLine(statsId)}\n`, (err) => {
      if (err && st.awaitingStats) {
        proc.pendingRpcs.delete(statsId);
        this.#finalizeTurn(st, proc, null, Date.now());
      }
    });
  }

  #finalizeTurn(st: SessionState, proc: Proc, statsData: Record<string, unknown> | null, at: number): void {
    if (!proc.initSeen) return;
    if (st.statsTimer !== null) {
      clearTimeout(st.statsTimer);
      st.statsTimer = null;
    }
    st.awaitingStats = false;
    st.runningCompact = false;

    this.#flushBufferedTexts(st, at);

    const settled = st.inFlight.filter((b) => !b.midTurn || b.echoed);
    const missed = st.inFlight.filter((b) => b.midTurn && !b.echoed && b.delivered);
    const unacked = st.inFlight.filter((b) => b.midTurn && !b.echoed && !b.delivered);
    st.inFlight = unacked;
    st.selfTurn = false;
    for (const batch of settled) this.markProcessing(st, batch, at);

    const interrupted = st.turnInterrupted || st.stopRequested;
    const ok = !interrupted && st.turnErrorMessage === null;
    for (const b of unacked) {
      b.turnDone = true;
      if (interrupted) b.stopped = true;
    }

    const event: DriverEvent = {
      type: "turn.ended",
      ok,
      interrupted,
      messageIds: settled.flatMap((b) => b.messageIds),
      durationMs: null,
      at,
    };
    if (proc.closing === "shutdown" && (!ok || interrupted)) event.shutdown = true;
    if (!ok) {
      if (!interrupted) {
        event.error = {
          subtype: "error_during_execution",
          message: st.turnErrorMessage ?? "turn_failed",
        };
      }
      this.forgetWritten(st, settled);
    } else {
      this.markHealthy(st.id);
    }

    const parsedStats = parsePiSessionStats(statsData);
    let deltaCounts: PiRawTokenCounts | null = null;
    if (st.hasMessageUsageInTurn) {
      deltaCounts = st.turnTokenTotals;
      if (parsedStats.tokens) proc.lastSessionTokens = parsedStats.tokens;
    } else if (parsedStats.tokens) {
      deltaCounts = subtractPiTokenCounts(parsedStats.tokens, proc.lastSessionTokens);
      proc.lastSessionTokens = parsedStats.tokens;
    }

    this.cancelUsagePush(st);
    const row = this.row(st);
    const patch: AgentSessionPatch = {};
    if (deltaCounts !== null || parsedStats.contextTokens !== null) {
      const finished: TokenUsage =
        deltaCounts !== null
          ? st.turnUsage.finish(row?.usage ?? EMPTY_TOKEN_USAGE, toClaudeStyleUsage(deltaCounts))
          : (() => {
              st.turnUsage.reset();
              return { ...(row?.usage ?? EMPTY_TOKEN_USAGE) };
            })();
      if (parsedStats.contextTokens !== null) {
        finished.context = parsedStats.contextTokens;
      }
      patch.usage = finished;
    } else {
      st.turnUsage.reset();
    }
    if (row?.hasCompletedTurn === false && ok) patch.hasCompletedTurn = true;
    if (Object.keys(patch).length > 0) this.update(st, patch);

    st.turnInterrupted = false;
    st.stopRequested = false;
    this.#clearTurnBuffers(st);

    this.clearTimer(st, "interruptTimer");
    this.emit(st.id, event);
    this.releaseUntaken(st, missed, interrupted, at);
    if (!this.busy(st)) {
      this.resolveInterrupt(st);
      this.afterTurn(st, proc);
      this.settled(st);
    }
  }

  #scopedUuid(st: SessionState, suffix: string): string {
    return `pi:${procSessionPrefix(st)}:t${st.turnSeq}:${suffix}`;
  }

  #emitThinkingOnce(st: SessionState, key: string, at: number): void {
    if (st.emittedThinkingKeys.has(key)) return;
    st.emittedThinkingKeys.add(key);
    this.emit(st.id, { type: "agent.thinking", uuid: this.#scopedUuid(st, `think-${key}`), at });
  }

  #emitTextOnce(st: SessionState, key: string, text: string, at: number): void {
    if (text.trim() === "" || st.emittedTextKeys.has(key)) return;
    st.emittedTextKeys.add(key);
    this.emit(st.id, { type: "agent.text", uuid: this.#scopedUuid(st, `text-${key}`), text, at });
  }

  #flushBufferedTexts(st: SessionState, at: number): void {
    for (const [key, buffered] of [...st.textBuffers.entries()]) {
      st.textBuffers.delete(key);
      this.#emitTextOnce(st, key, buffered, at);
    }
  }

  #emitToolOnce(st: SessionState, toolId: string, name: string, input: unknown, at: number): void {
    if (st.emittedToolIds.has(toolId)) return;
    st.emittedToolIds.add(toolId);
    this.emit(st.id, {
      type: "agent.tool",
      uuid: this.#scopedUuid(st, `tool-${toolId}`),
      toolUseId: toolId,
      name,
      input,
      at,
    });
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
      this.#clearTurnBuffers(st);
      st.runningCompact = false;

      for (const rpc of proc.pendingRpcs.values()) {
        if (rpc.kind === "commands") rpc.done(null);
      }
      proc.pendingRpcs.clear();

      const steers = [...proc.steers.values()];
      proc.steers.clear();
      for (const steer of steers) this.#settleSteer(st, steer, false);

      if (!proc.initSeen) {
        if (proc.closing === null) {
          this.forgetWritten(st, st.inFlight);
          proc.resolveReady({
            kind: "failed",
            exitCode: code,
            signal,
            stderr: proc.stderr,
            conflict: null,
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
        if (proc.closing === "interrupt") {
          for (const batch of st.inFlight) this.markDelivered(st, batch);
        }
        proc.resolveReady({ kind: "closed", reason: proc.closing });
      }

      const batches = proc.initSeen || proc.closing === "interrupt" ? st.inFlight : [];
      st.inFlight = [];
      st.selfTurn = false;
      const reason: SessionExitReason = proc.closing ?? "crash";
      const untaken = batches.filter((b) => b.midTurn && !b.echoed);
      const taken = batches.filter((b) => !untaken.includes(b));
      if (taken.length > 0 && reason === "crash") {
        st.crashNote = true;
        this.forgetWritten(st, taken);
      }
      const stopped = reason === "interrupt" || st.stopRequested;
      st.stopRequested = false;
      st.turnInterrupted = false;
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
      this.resolveInterrupt(st);
      resolveExited();
      this.settled(st);
    }
  }
}

export function createPiDriver(options: PiDriverOptions): PiDriver {
  return new PiDriver(options);
}

function procSessionPrefix(st: SessionState): string {
  return st.proc?.sessionId ?? String(st.id);
}

function startupError(outcome: Extract<PiStartupOutcome, { kind: "failed" }>, startTimeoutMs: number): DriverError {
  if (outcome.timedOut) return new DriverError("start_timeout", `no get_state response within ${startTimeoutMs} ms`);
  if (outcome.errorMessage) return new DriverError("spawn_failed", `pi get_state failed: ${outcome.errorMessage}`);
  const how = outcome.signal ? `signal ${outcome.signal}` : `exit code ${outcome.exitCode}`;
  const stderr = outcome.stderr.trim();
  return new DriverError("spawn_failed", `pi exited before get_state (${how})${stderr ? `: ${stderr}` : ""}`);
}

function newBatch(
  messageIds: MessageId[],
  rawText: string,
  combinedText: string,
  notes: BatchNotes,
  source: MessageSource,
  isCompact: boolean,
): Batch {
  return {
    messageIds,
    rawText,
    combinedText,
    notes,
    delivered: false,
    processing: false,
    echoed: false,
    midTurn: false,
    stopped: false,
    turnDone: false,
    isCompact,
    source,
  };
}
