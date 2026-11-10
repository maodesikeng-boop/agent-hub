// 通用 ACP（Agent Client Protocol）常驻会话驱动底座（继承 BaseSessionDriver）：
// - 基于官方 @agentclientprotocol/sdk/unstable 建立双向 JSON-RPC 连接，复用 BaseSessionDriver 的行缓冲、排空与进程组清理；
// - 完整握手流：initialize -> 可选 authenticate -> session/load（支持吞历史重放）或 session/resume（缺失自动回退 session/new）-> session/set_mode -> session/set_config_option（模型与思考档位两段式联动）；
// - 完整对话生命周期：首轮系统提示词块注入、多轮复用、排队合并、session/cancel 正规打断（超时升级 SIGINT -> SIGKILL）、流式文本聚合、思考状态、工具调用生命周期、available_commands_update 命令同步、上下文与 token 用量更新、空闲关闭与残留清理；
// - 内存与上限安全：流式拼接按 MAX_MESSAGE_BYTES 分段冲刷，单轮工具表按 SESSION_STEPS_KEEP 封顶并在轮末与退出时清空，命令缓存按 MAX_COMMANDS 封顶，进程退出关闭连接释放全部挂起请求，零后台轮询定时器。
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  RequestError,
  client,
  methods,
  type AnyMessage,
  type ClientConnection,
  type InitializeResponse,
  type McpServer,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
  type Stream,
  type SystemPrompt,
  type ToolCall,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk/unstable";
import {
  BaseSessionDriver,
  NO_NOTES,
  clearKillTimer,
  createBaseSessionState,
  entryParts,
  errorMessage,
  type BaseBatch,
  type BaseProc,
  type BaseSessionState,
  type ClosingReason,
  type PendingEntry,
  type StartupOutcome,
} from "../../../daemon/driver/base-driver.ts";
import { personaSeenAtStart } from "../../../daemon/driver/persona-note.ts";
import { signalChild } from "../../../daemon/driver/process.ts";
import {
  WORKER_NEEDS_OS_SANDBOX_MESSAGE,
  scanSecretGlobs,
  spawnInWriteScope,
  wrapInReadonlyOsSandbox,
  type ReadonlySandboxInput,
  type ScopedSpawn,
  type SpawnCommand,
} from "../../../daemon/driver/write-scope.ts";
import {
  DriverError,
  MAX_MESSAGE_BYTES,
  PRODUCT_NAME,
  SESSION_STEPS_KEEP,
  vendorSpec,
  type AgentSessionPatch,
  type AgentSessionRow,
  type ComposerCommand,
  type Driver,
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
} from "../../../shared/index.ts";
import { createSpecComposerBase } from "../composer.ts";
import {
  KNOWN_ACP_SESSION_UPDATES,
  REPLAYED_HISTORY_SESSION_UPDATES,
  activeModelFromConfigOptions,
  applyAcpUsageUpdate,
  buildAcpPromptBlocks,
  checkAcpUserBlocks,
  decideAcpPermission,
  defaultClassifyAcpTurnError,
  defaultExtractAcpToolUse,
  defaultIsAcpSessionNotFoundError,
  identifyAcpStaleProcess,
  mergeAcpPromptUsage,
  normalizeAcpUserBlocks,
  parseAcpAvailableCommands,
  readAcpSystemPrompt,
  resolveEffortConfigUpdate,
  resolveModelConfigUpdate,
} from "./protocol.ts";
import type {
  AcpDriverConfig,
  AcpDriverOptions,
  AcpLaunchContext,
  AcpTrackedToolCall,
} from "./types.ts";

const ZERO_USAGE: TokenUsage = {
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  context: 0,
};

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

interface AcpBatch extends BaseBatch {
  userBlocks: Array<{ type: "text"; text: string }>;
}

interface AcpProc extends BaseProc<StartupOutcome> {
  acpConn: ClientConnection;
  acpReadableController: ReadableStreamDefaultController<AnyMessage> | null;
  streamEnded: boolean;
  processScope: string;
  readonlyPolicy: ReadonlyPolicy | null;
  initResponse: InitializeResponse | null;
  acpSessionId: string | null;
  modes: SessionModeState | null;
  configOptions: SessionConfigOption[];
  swallowingReplay: boolean;
  pendingSystemPromptBlock: string | null;
  baseUsage: TokenUsage;
  latestContextUsed: number | null;
  turnSeq: number;
  textSegmentSeq: number;
  thinkingSeq: number;
  textBuffer: string;
  textBufferBytes: number;
  textMessageId: string | null;
  inThinkingRun: boolean;
  activeTools: Map<string, AcpTrackedToolCall>;
  onPromptWritten: (() => void) | null;
}

interface AcpSessionState extends BaseSessionState<AcpProc, AcpBatch> {
  hasConversation: boolean;
  cancelSent: boolean;
  cachedCommands: ComposerCommand[] | null;
}

export class AcpSessionDriver extends BaseSessionDriver<AcpProc, AcpBatch, AcpSessionState> {
  readonly #config: AcpDriverConfig;
  readonly #executablePath: string;
  readonly #readonlySpawn: (base: SpawnCommand, input: ReadonlySandboxInput) => ScopedSpawn;

  constructor(config: AcpDriverConfig, options: AcpDriverOptions) {
    const { executablePath, composer, readonlySpawn, ...rest } = options;
    const timeouts = config.timeouts;
    super(config.vendor, {
      composer: composer ?? createSpecComposerBase(config.vendor),
      ...(timeouts?.idleCloseMs !== undefined ? { idleCloseMs: timeouts.idleCloseMs } : {}),
      ...(timeouts?.interruptGraceMs !== undefined ? { interruptGraceMs: timeouts.interruptGraceMs } : {}),
      ...(timeouts?.startTimeoutMs !== undefined ? { startTimeoutMs: timeouts.startTimeoutMs } : {}),
      ...(timeouts?.shutdownGraceMs !== undefined ? { shutdownGraceMs: timeouts.shutdownGraceMs } : {}),
      ...(timeouts?.commandsTimeoutMs !== undefined ? { commandsTimeoutMs: timeouts.commandsTimeoutMs } : {}),
      ...rest,
    });
    this.#config = config;
    this.#executablePath = executablePath;
    this.#readonlySpawn = readonlySpawn ?? ((base, input) => wrapInReadonlyOsSandbox(base, input));
  }

  protected createSessionState(id: SessionId): AcpSessionState {
    return {
      ...createBaseSessionState(id),
      hasConversation: false,
      cancelSent: false,
      cachedCommands: null,
    };
  }

  override end(sessionId: SessionId): Promise<void> {
    const st = this.sessions.get(sessionId);
    if (st) st.cachedCommands = null;
    return super.end(sessionId);
  }

  override queryCommands(sessionId: SessionId): Promise<ComposerCommand[] | null> {
    const st = this.sessions.get(sessionId);
    if (!st?.proc || st.proc.closing || st.cachedCommands === null) {
      return Promise.resolve(null);
    }
    return Promise.resolve([...st.cachedCommands]);
  }

  async send(sessionId: SessionId, input: DriverSendInput): Promise<DriverSendResult> {
    this.assertRunning();
    const st = this.state(sessionId);
    this.assertNotEnded(st);
    const ids = input.messageIds;
    if (ids.length === 0) {
      this.invalidInput(st, "messageIds must not be empty", ids);
      return { kind: "rejected" };
    }
    if (ids.every((id) => st.written.has(id))) {
      return { kind: "written" };
    }

    const entry: PendingEntry = {
      messageIds: [...ids],
      source: input.source,
      text: input.text,
      prefixes: [...(input.prefixes ?? [])],
      resend: input.resend ?? false,
    };
    const parts = entryParts(entry);
    const previewBlocks = normalizeAcpUserBlocks(this.composer.buildUserContent(parts.prefixes, parts.text));
    const problem = checkAcpUserBlocks(previewBlocks);
    if (problem) {
      this.invalidInput(st, problem, ids);
      return { kind: "rejected" };
    }

    if (!this.isPending(st, ids)) {
      const queuedBytes = st.pending.reduce(
        (n, e) => n + Buffer.byteLength(e.text) + e.prefixes.reduce((sum, p) => sum + Buffer.byteLength(p), 0),
        0,
      );
      const entryBytes = Buffer.byteLength(entry.text) + entry.prefixes.reduce((n, p) => n + Buffer.byteLength(p), 0);
      if (st.pending.length >= SESSION_STEPS_KEEP || queuedBytes + entryBytes > MAX_MESSAGE_BYTES) {
        this.invalidInput(st, "ACP pending queue limit exceeded", ids);
        return { kind: "rejected" };
      }
      st.pending.push(entry);
      if (input.recovery) st.recoveryNote = true;
    }
    await this.pump(st);
    return ids.every((id) => st.written.has(id)) ? { kind: "written" } : { kind: "queued" };
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
    if (!this.busy(st) && proc.initSeen) return;

    st.stopRequested = true;
    st.turnInterrupted = true;
    const done = new Promise<void>((resolve) => st.interruptWaiters.push(resolve));
    if (!st.cancelSent) {
      st.cancelSent = true;
      if (proc.acpSessionId) {
        void proc.acpConn.agent
          .notify(methods.agent.session.cancel, { sessionId: proc.acpSessionId })
          .catch(() => {});
      }
      this.clearTimer(st, "interruptTimer");
      st.interruptTimer = setTimeout(() => {
        st.interruptTimer = null;
        this.sigintForInterrupt(st, proc, "killTimer");
      }, this.opts.interruptGraceMs);
    }
    return done;
  }

  protected override closeStdin(st: AcpSessionState, proc: AcpProc, reason: ClosingReason): void {
    proc.closing = reason;
    if (
      reason === "idle" &&
      proc.initSeen &&
      proc.acpSessionId &&
      proc.initResponse?.agentCapabilities?.sessionCapabilities?.close &&
      !proc.child.stdin.destroyed &&
      !proc.child.stdin.writableEnded
    ) {
      void proc.acpConn.agent
        .request(methods.agent.session.close, { sessionId: proc.acpSessionId })
        .catch(() => {})
        .finally(() => {
          if (!proc.child.stdin.destroyed && !proc.child.stdin.writableEnded) {
            proc.child.stdin.end();
          }
        });
      const closeGrace = this.#config.timeouts?.closeSessionGraceMs ?? 200;
      const endStdinTimer = setTimeout(() => {
        if (!proc.child.stdin.destroyed && !proc.child.stdin.writableEnded) {
          proc.child.stdin.end();
        }
      }, closeGrace);
      endStdinTimer.unref();
    } else {
      proc.child.stdin.end();
    }

    const grace = this.opts.interruptGraceMs;
    clearKillTimer(proc);
    proc.killTimer = setTimeout(() => {
      signalChild(proc.child, "SIGINT");
      proc.killTimer = setTimeout(() => {
        proc.killTimer = null;
        this.forceKillProc(st, proc);
      }, grace);
    }, grace);
  }

  protected override filterStaleRow(row: AgentSessionRow): boolean {
    return row.vendor === this.vendor;
  }

  protected identifyStaleProcess(pid: number, row: AgentSessionRow): Promise<number | null> {
    const staticTokens = typeof this.#config.launchArgs === "function" ? [] : this.#config.launchArgs;
    return identifyAcpStaleProcess(
      pid,
      row,
      this.vendor,
      this.#executablePath,
      staticTokens,
      this.#config.staleProcess?.matchesCommand,
    );
  }

  protected resumeFor(st: AcpSessionState): boolean {
    if (st.resumeHint !== null) return st.resumeHint;
    const row = this.store(st);
    return (st.hasConversation || row.hasCompletedTurn) && row.vendorSessionId.trim() !== "";
  }

  protected takeBatch(st: AcpSessionState): AcpBatch | null {
    const taken = this.takePendingEntryBatch(st);
    if (!taken) return null;
    if (taken.command) {
      return {
        messageIds: taken.messageIds,
        userBlocks: normalizeAcpUserBlocks(this.composer.buildUserContent(taken.body.prefixes, taken.body.text)),
        notes: NO_NOTES,
        delivered: false,
        processing: false,
        source: "user",
      };
    }
    const injection = this.#config.session?.systemPromptInjection ?? "first_turn_new_session";
    const activeProc = st.proc && !st.proc.closing ? st.proc : null;
    const willRebakeOnSpawn =
      activeProc === null &&
      (injection === "every_process_first_turn" ||
        !this.resumeFor(st) ||
        Boolean(this.#config.continuation?.rebakesPersonaOnResume));
    const { notes, prefixes } = this.takeNotesPrefixes(st, {
      takePersona: !willRebakeOnSpawn,
      fromRowOnFirstPersonaCheck: !willRebakeOnSpawn,
    });
    return {
      messageIds: taken.messageIds,
      userBlocks: normalizeAcpUserBlocks(
        this.composer.buildUserContent([...prefixes, ...taken.body.prefixes], taken.body.text),
      ),
      notes,
      delivered: false,
      processing: false,
      source: taken.source,
    };
  }

  protected spawnIdleProcess(st: AcpSessionState, resume: boolean): Promise<AcpProc> {
    return this.#spawnAndAwaitReady(st, resume, null);
  }

  protected async startup(
    st: AcpSessionState,
    batch: AcpBatch,
    existing: AcpProc | null,
    files: LaunchFiles | null,
  ): Promise<void> {
    let proc = existing;
    if (!proc) {
      try {
        proc = await this.#spawn(st, this.resumeFor(st), files);
        this.abortIfStopped(st, proc);
      } catch (error) {
        this.dropBatch(st, batch);
        throw error;
      }
    }
    this.clearTimer(st, "idleTimer");
    if (!st.inFlight.includes(batch)) st.inFlight.push(batch);
    this.armStartTimer(st, proc);

    const outcome = await proc.ready;
    if (outcome.kind === "closed") {
      this.dropBatch(st, batch);
      if (st.ended) throw new DriverError("session_ended", `session ${st.id} has been ended`);
      if (outcome.reason === "interrupt") return;
      throw new DriverError(
        "spawn_failed",
        this.shuttingDown ? "driver is shutting down" : `closed before init (${outcome.reason})`,
      );
    }
    if (outcome.kind === "failed") {
      this.dropBatch(st, batch);
      await proc.exited;
      if (outcome.timedOut) {
        throw new DriverError("start_timeout", `timed out waiting for ACP session initialization (${st.id})`);
      }
      const detail =
        outcome.errorMessage ||
        outcome.stderr.trim() ||
        `ACP process exited before initialization (code=${outcome.exitCode}, signal=${outcome.signal})`;
      throw new DriverError("spawn_failed", detail);
    }

    if (st.ended || proc.closing || st.proc !== proc) {
      this.dropBatch(st, batch);
      if (st.ended) throw new DriverError("session_ended", `session ${st.id} has been ended`);
      return;
    }

    await this.writeBatch(st, proc, batch);
  }

  protected async writeBatch(st: AcpSessionState, proc: AcpProc, batch: AcpBatch): Promise<void> {
    const problem = checkAcpUserBlocks(batch.userBlocks);
    if (problem) {
      this.dropBatch(st, batch);
      this.invalidInput(st, problem, batch.messageIds);
      this.afterTurn(st, proc);
      return;
    }
    const acpSessionId = proc.acpSessionId;
    if (!acpSessionId) {
      this.dropBatch(st, batch);
      this.internalError(st.id, "missing ACP sessionId when writing batch");
      this.afterTurn(st, proc);
      return;
    }

    this.clearTimer(st, "idleTimer");
    if (!st.inFlight.includes(batch)) st.inFlight.push(batch);
    this.#resetTurnBuffers(st, proc);

    const systemBlock = proc.pendingSystemPromptBlock;
    proc.pendingSystemPromptBlock = null;
    const promptBlocks = buildAcpPromptBlocks(batch.userBlocks, systemBlock);

    const startedAt = Date.now();
    this.update(st, { status: "running", lastEventAt: startedAt });

    await new Promise<void>((resolve) => {
      const onWritten = () => {
        this.markDelivered(st, batch);
        resolve();
      };
      proc.onPromptWritten = onWritten;
      void this.#runPromptTurn(st, proc, batch, acpSessionId, promptBlocks, startedAt).finally(() => {
        if (proc.onPromptWritten === onWritten) proc.onPromptWritten = null;
        resolve();
      });
    });
  }

  async #spawnAndAwaitReady(
    st: AcpSessionState,
    resume: boolean,
    files: LaunchFiles | null,
  ): Promise<AcpProc> {
    const proc = await this.#spawn(st, resume, files);
    this.armStartTimer(st, proc);
    const outcome = await proc.ready;
    if (outcome.kind === "ok") return proc;
    if (outcome.kind === "closed") {
      if (st.ended) throw new DriverError("session_ended", `session ${st.id} has been ended`);
      throw new DriverError(
        "spawn_failed",
        this.shuttingDown ? "driver is shutting down" : `closed before init (${outcome.reason})`,
      );
    }
    await proc.exited;
    if (outcome.timedOut) {
      throw new DriverError("start_timeout", `timed out waiting for ACP session initialization (${st.id})`);
    }
    const detail =
      outcome.errorMessage ||
      outcome.stderr.trim() ||
      `ACP process exited before initialization (code=${outcome.exitCode}, signal=${outcome.signal})`;
    throw new DriverError("spawn_failed", detail);
  }

  #buildReadonlySandboxInput(row: AgentSessionRow, policy: ReadonlyPolicy): {
    input: ReadonlySandboxInput;
    cleanupTmp: () => void;
  } {
    const rawTmp = mkdtempSync(join(tmpdir(), "agent-hub-acp-ro-"));
    const tmpDir = realpathOrSelf(rawTmp);
    let cleaned = false;
    const cleanupTmp = () => {
      if (cleaned) return;
      cleaned = true;
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // 清理临时目录失败忽略
      }
    };

    const homeDir = realpathOrSelf(homedir());
    const realCwd = realpathOrSelf(row.cwd);
    const defaultCaches = [
      join(homeDir, ".cache"),
      join(homeDir, "Library", "Caches"),
      join(homeDir, ".npm"),
    ];
    const extraDirs = this.#config.readonlySandbox?.writableDirs?.(homeDir, realCwd) ?? [];
    const writableDirs = [
      ...new Set(
        [...defaultCaches, ...extraDirs]
          .filter((d) => existsSync(d))
          .map(realpathOrSelf),
      ),
    ];
    const writableFileGlobs = [
      ...(this.#config.readonlySandbox?.writableFileGlobs?.(homeDir, realCwd) ?? []),
    ];

    const secretPaths =
      process.platform === "linux"
        ? [
            ...new Set([
              ...policy.secretPaths.map(realpathOrSelf),
              ...scanSecretGlobs([realCwd, ...row.addDirs.map(realpathOrSelf)], policy.secretGlobs),
            ]),
          ]
        : policy.secretPaths.map(realpathOrSelf);

    return {
      input: {
        tmpDir,
        writableDirs,
        writableFileGlobs,
        writableFileRegexes: [],
        secretPaths,
        secretGlobs: [...policy.secretGlobs],
      },
      cleanupTmp,
    };
  }

  async #spawn(st: AcpSessionState, resume: boolean, prepared: LaunchFiles | null): Promise<AcpProc> {
    const { row, files } = await this.resolveLaunchFiles(st, prepared);
    const launchCtx: AcpLaunchContext = {
      row,
      files,
      resume,
      executablePath: this.#executablePath,
    };
    const rawLaunchArgs =
      typeof this.#config.launchArgs === "function"
        ? [...this.#config.launchArgs(launchCtx)]
        : [...this.#config.launchArgs];

    let cleanupReadonlyTmp: (() => void) | undefined;
    let spawnCmd: string;
    let spawnArgs: string[];
    const extraEnv: Record<string, string> = { ...files.env };

    if (files.readonly) {
      const { input, cleanupTmp } = this.#buildReadonlySandboxInput(row, files.readonly);
      cleanupReadonlyTmp = cleanupTmp;
      const ownOffArgs = vendorSpec(this.vendor).capabilities.ownSandboxOffArgs ?? [];
      const wrapped = this.#readonlySpawn(
        { command: this.#executablePath, args: [...ownOffArgs, ...rawLaunchArgs] },
        input,
      );
      if (!wrapped.osSandboxed) {
        cleanupTmp();
        throw new DriverError("spawn_failed", WORKER_NEEDS_OS_SANDBOX_MESSAGE);
      }
      spawnCmd = wrapped.command;
      spawnArgs = wrapped.args;
      extraEnv.TMPDIR = input.tmpDir;
    } else {
      const scoped = spawnInWriteScope(
        this.vendor,
        { command: this.#executablePath, args: rawLaunchArgs },
        files.writeScope ?? null,
        this.opts.log,
        String(st.id),
      );
      spawnCmd = scoped.command;
      spawnArgs = scoped.args;
    }

    const child = await this.spawnDetachedChild(
      this.#executablePath,
      spawnCmd,
      spawnArgs,
      row.cwd,
      extraEnv,
      cleanupReadonlyTmp,
    );

    const { baseProc, resolveExited } = this.createBaseProc<StartupOutcome>(child, resume, row, files);

    let readableController: ReadableStreamDefaultController<AnyMessage> | null = null;
    const readable = new ReadableStream<AnyMessage>({
      start(controller) {
        readableController = controller;
      },
      cancel() {
        readableController = null;
      },
    });
    const writable = new WritableStream<AnyMessage>({
      write: (message) => {
        if (child.stdin.destroyed || child.stdin.writableEnded) {
          this.forceKillProc(st, proc);
          throw new Error("ACP stdin is closed");
        }
        const serialized = JSON.stringify(message)
          .replaceAll("\u2028", "\\u2028")
          .replaceAll("\u2029", "\\u2029");
        return new Promise<void>((resolve, reject) => {
          child.stdin.write(`${serialized}\n`, (error) => {
            if (error) {
              this.forceKillProc(st, proc);
              reject(error);
              return;
            }
            if ("method" in message && message.method === "session/prompt") {
              proc.onPromptWritten?.();
              proc.onPromptWritten = null;
            }
            resolve();
          });
        });
      },
    });
    const stream: Stream = { readable, writable };

    const clientInfo = this.#config.clientInfo ?? { name: PRODUCT_NAME, version: "0.0.0" };
    let proc!: AcpProc;

    const app = client({ name: clientInfo.name })
      .onRequest(methods.client.session.requestPermission, async (ctx) => {
        const outcome = await decideAcpPermission(
          {
            request: ctx.params,
            readonlyPolicy: proc.readonlyPolicy,
            closing: proc.closing !== null || this.shuttingDown,
            signal: ctx.signal,
          },
          this.#config.permissions,
        );
        return { outcome };
      })
      .onRequest(methods.client.elicitation.create, async (ctx) => {
        if (this.#config.extensions?.onElicitation) {
          return this.#config.extensions.onElicitation(ctx.params, ctx.signal);
        }
        return { action: "decline" };
      })
      .onRequest("*", async (ctx) => {
        if (this.#config.extensions?.onBlockingRequest) {
          const result = await this.#config.extensions.onBlockingRequest({
            method: ctx.method,
            params: ctx.params,
            requestId: ctx.requestId,
            signal: ctx.signal,
            agent: ctx.agent,
            sessionId: proc.acpSessionId,
            readonlyPolicy: proc.readonlyPolicy,
          });
          if (result !== undefined) return result;
        }
        throw RequestError.methodNotFound(ctx.method);
      })
      .onNotification(methods.client.session.update, (ctx) => {
        this.#handleSessionUpdate(st, proc, ctx.params, Date.now());
      })
      .onNotification("*", (ctx) => {
        this.#config.extensions?.onNotification?.({
          method: ctx.method,
          params: ctx.params,
          sessionId: proc.acpSessionId,
        });
      });

    const acpConn = app.connect(stream);

    proc = {
      ...baseProc,
      acpConn,
      acpReadableController: readableController,
      streamEnded: false,
      processScope: randomUUID(),
      readonlyPolicy: files.readonly ?? null,
      initResponse: null,
      acpSessionId: null,
      modes: null,
      configOptions: [],
      swallowingReplay: false,
      pendingSystemPromptBlock: null,
      baseUsage: { ...(row.usage ?? ZERO_USAGE) },
      latestContextUsed: null,
      turnSeq: 0,
      textSegmentSeq: 0,
      thinkingSeq: 0,
      textBuffer: "",
      textBufferBytes: 0,
      textMessageId: null,
      inThinkingRun: false,
      activeTools: new Map(),
      onPromptWritten: null,
    };

    this.attachChildProcess(st, proc, resolveExited, cleanupReadonlyTmp);
    // 在公共行缓冲前检查协议帧，JSON 转义最多膨胀六倍，另留信封余量。
    // 复用共享消息上限，避免无换行输出让公共 buffered 永久增长。
    let partialLineBytes = 0;
    let overflowed = false;
    child.stdout.prependListener("data", (chunk: string) => {
      if (overflowed) return;
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf("\n", start);
        partialLineBytes += Buffer.byteLength(nl < 0 ? chunk.slice(start) : chunk.slice(start, nl));
        if (partialLineBytes > MAX_MESSAGE_BYTES * 8) {
          overflowed = true;
          child.stdout.destroy();
          this.reportError(st.id, "bad_output_line", "ACP protocol frame exceeds message limit");
          this.forceKillProc(st, proc);
          return;
        }
        if (nl < 0) break;
        partialLineBytes = 0;
        start = nl + 1;
      }
    });
    void this.#runHandshake(st, proc, launchCtx);
    return proc;
  }

  async #runHandshake(st: AcpSessionState, proc: AcpProc, launchCtx: AcpLaunchContext): Promise<void> {
    const { row, files } = launchCtx;
    const clientInfo = this.#config.clientInfo ?? { name: PRODUCT_NAME, version: "0.0.0" };
    try {
      const init = await proc.acpConn.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo,
        clientCapabilities: this.#config.clientCapabilities ?? {},
      });
      proc.initResponse = init;

      const authCfg = this.#config.authenticate;
      const shouldAuth =
        typeof authCfg?.enabled === "function"
          ? authCfg.enabled(init, launchCtx)
          : Boolean(authCfg?.enabled);
      if (shouldAuth) {
        const authMethods = init.authMethods ?? [];
        const methodId = authCfg?.selectMethodId
          ? authCfg.selectMethodId(authMethods, init, launchCtx)
          : authCfg?.preferredMethodId && authMethods.some((m) => m.id === authCfg.preferredMethodId)
            ? authCfg.preferredMethodId
            : (authCfg?.preferredMethodId ?? authMethods[0]?.id ?? null);
        if (methodId !== null) {
          await proc.acpConn.agent.request(methods.agent.authenticate, { methodId });
        }
      }

      const mcpServersCfg = this.#config.session?.mcpServers;
      const mcpServers: McpServer[] =
        typeof mcpServersCfg === "function"
          ? [...mcpServersCfg(launchCtx)]
          : mcpServersCfg
            ? [...mcpServersCfg]
            : [];
      const additionalDirectories = row.addDirs.length > 0 ? [...row.addDirs] : undefined;

      const injection = this.#config.session?.systemPromptInjection ?? "first_turn_new_session";
      const supportsNativeSystemPrompt = Boolean(
        this.#config.session?.preferNativeSystemPrompt &&
          init.agentCapabilities?.sessionCapabilities?.systemPrompt,
      );
      let nativeSystemPrompt: SystemPrompt | undefined;
      if (supportsNativeSystemPrompt && injection !== "never") {
        const rawText = readAcpSystemPrompt(files.promptFile, (s) => s);
        if (rawText) {
          nativeSystemPrompt = { mode: "append", content: [{ type: "text", text: rawText }] };
        }
      }

      let sessionId = "";
      let actuallyResumed = false;
      let modes: SessionModeState | null = null;
      let configOptions: SessionConfigOption[] = [];

      const continuation = this.#config.continuation;
      const wantResume = proc.resume && row.vendorSessionId.trim() !== "";
      if (wantResume) {
        const modeSetting = continuation?.mode ?? "auto";
        const useResumeRpc =
          modeSetting === "resume" ||
          (modeSetting === "auto" && Boolean(init.agentCapabilities?.sessionCapabilities?.resume));
        const swallowReplay = continuation?.swallowReplayOnLoad !== false;
        const loadSaved = async () => {
          proc.swallowingReplay = swallowReplay;
          try {
            const loaded = await proc.acpConn.agent.request(methods.agent.session.load, {
              sessionId: row.vendorSessionId,
              cwd: row.cwd,
              mcpServers,
              ...(additionalDirectories ? { additionalDirectories } : {}),
              ...(nativeSystemPrompt ? { systemPrompt: nativeSystemPrompt } : {}),
            });
            // 确保同一 stdout 分片内排队的重放通知微任务在关闭 swallowingReplay 前执行完毕
            await Promise.resolve();
            await Promise.resolve();
            if (!swallowReplay) {
              const replayAt = Date.now();
              this.#flushTextBuffer(st, proc, replayAt);
              this.#closeOpenTools(st, proc, replayAt);
            }
            sessionId = row.vendorSessionId;
            modes = loaded.modes ?? null;
            configOptions = [...(loaded.configOptions ?? [])];
            actuallyResumed = true;
          } finally {
            proc.swallowingReplay = false;
          }
        };
        try {
          if (useResumeRpc) {
            try {
              const resumed = await proc.acpConn.agent.request(methods.agent.session.resume, {
                sessionId: row.vendorSessionId,
                cwd: row.cwd,
                mcpServers,
                ...(additionalDirectories ? { additionalDirectories } : {}),
                ...(nativeSystemPrompt ? { systemPrompt: nativeSystemPrompt } : {}),
              });
              sessionId = row.vendorSessionId;
              modes = resumed.modes ?? null;
              configOptions = [...(resumed.configOptions ?? [])];
              actuallyResumed = true;
            } catch (error) {
              if (!(error instanceof RequestError) || error.code !== -32601 || !init.agentCapabilities?.loadSession) throw error;
              await loadSaved();
            }
          } else {
            await loadSaved();
          }
        } catch (contErr) {
          proc.swallowingReplay = false;
          if (proc.closing !== null || proc.streamEnded || this.shuttingDown) {
            throw contErr;
          }
          const isMissing = this.#config.errors?.isSessionNotFoundError ?? defaultIsAcpSessionNotFoundError;
          const unsupported = contErr instanceof RequestError && contErr.code === -32601;
          const allowFallback = continuation?.fallbackToNewOnFailure !== false && (isMissing(contErr) || unsupported);
          if (!allowFallback) {
            throw contErr;
          }
          this.logSession(
            st.id,
            `ACP 恢复会话 ${row.vendorSessionId} 失败（${errorMessage(contErr)}），回退新建会话`,
          );
        }
      }

      if (!actuallyResumed) {
        const created = await proc.acpConn.agent.request(methods.agent.session.new, {
          cwd: row.cwd,
          mcpServers,
          ...(additionalDirectories ? { additionalDirectories } : {}),
          ...(nativeSystemPrompt ? { systemPrompt: nativeSystemPrompt } : {}),
        });
        sessionId = created.sessionId;
        modes = created.modes ?? null;
        configOptions = [...(created.configOptions ?? [])];
      }

      proc.acpSessionId = sessionId;
      proc.modes = modes;
      proc.configOptions = configOptions;
      st.hasConversation = true;

      if (
        !supportsNativeSystemPrompt &&
        (injection === "every_process_first_turn" ||
          (injection === "first_turn_new_session" && !actuallyResumed))
      ) {
        proc.pendingSystemPromptBlock = readAcpSystemPrompt(
          files.promptFile,
          this.#config.session?.formatSystemPrompt,
        );
      }

      // 可选切换默认会话模式
      const modeCfg = this.#config.session?.defaultModeId;
      const targetModeId =
        typeof modeCfg === "function"
          ? modeCfg({
              row,
              files,
              resumed: actuallyResumed,
              sessionId,
              init,
              modes,
              configOptions: proc.configOptions,
            })
          : (modeCfg ?? null);
      if (
        targetModeId &&
        modes &&
        modes.currentModeId !== targetModeId &&
        modes.availableModes.some((m) => m.id === targetModeId)
      ) {
        await proc.acpConn.agent.request(methods.agent.session.setMode, {
          sessionId,
          modeId: targetModeId,
        });
      }

      // 设置模型与思考程度（两段式：切换模型后服务端可能返回新的思考档位列表）
      await this.#applyConfigOptions(proc, sessionId, row.model, row.effort);

      if (proc.streamEnded || st.proc !== proc) return;
      if (proc.closing !== null) {
        proc.resolveReady({ kind: "closed", reason: proc.closing });
        return;
      }

      if (st.stopRequested) {
        this.sigintForInterrupt(st, proc, "killTimer");
        proc.resolveReady({ kind: "closed", reason: "interrupt" });
        return;
      }
      this.clearTimer(st, "startTimer");
      proc.initSeen = true;
      st.resumeHint = true;
      this.markHealthy(st.id);

      const rebaked =
        injection === "every_process_first_turn" ||
        !actuallyResumed ||
        Boolean(this.#config.continuation?.rebakesPersonaOnResume);
      const seen = personaSeenAtStart(st, this.row(st), proc.personaLaunched, rebaked);
      this.setPersonaSeen(st, seen);

      const at = Date.now();
      this.update(st, { vendorSessionId: sessionId, status: "running", lastEventAt: at });
      const activeModel =
        activeModelFromConfigOptions(proc.configOptions, this.#config.configOptions) ??
        (row.model && row.model !== "" ? row.model : null);
      this.emit(st.id, {
        type: "session.started",
        resumed: actuallyResumed,
        model: activeModel,
        tools: [],
        at,
      });
      proc.resolveReady({ kind: "ok" });
    } catch (error) {
      if (proc.streamEnded) return;
      if (proc.closing !== null) {
        proc.resolveReady({ kind: "closed", reason: proc.closing });
        return;
      }
      proc.resolveReady({
        kind: "failed",
        exitCode: proc.child.exitCode,
        signal: proc.child.signalCode,
        stderr: proc.stderr,
        timedOut: proc.startTimedOut,
        errorMessage: errorMessage(error),
      });
      if (!proc.child.stdin.destroyed && !proc.child.stdin.writableEnded) {
        proc.child.stdin.end();
      }
      this.forceKillProc(st, proc);
    }
  }

  async #applyConfigOptions(
    proc: AcpProc,
    sessionId: string,
    requestedModel: string | null,
    requestedEffort: string | null,
  ): Promise<void> {
    const cfg = this.#config.configOptions;
    if (cfg?.combineModelAndEffort) {
      const combined = cfg.combineModelAndEffort({
        model: requestedModel,
        effort: requestedEffort,
        options: proc.configOptions,
      });
      if (combined !== null) {
        for (const item of combined) {
          const res = await proc.acpConn.agent.request(methods.agent.session.setConfigOption, {
            sessionId,
            configId: item.configId,
            value: item.value,
          });
          if (Array.isArray(res.configOptions)) {
            proc.configOptions = [...res.configOptions];
          }
        }
        return;
      }
    }

    const modelUpdate = resolveModelConfigUpdate(requestedModel, proc.configOptions, cfg);
    if (modelUpdate) {
      const res = await proc.acpConn.agent.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: modelUpdate.configId,
        value: modelUpdate.value,
      });
      if (Array.isArray(res.configOptions)) {
        proc.configOptions = [...res.configOptions];
      }
    }

    const effortUpdate = resolveEffortConfigUpdate(requestedEffort, proc.configOptions, cfg);
    if (effortUpdate) {
      const res = await proc.acpConn.agent.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: effortUpdate.configId,
        value: effortUpdate.value,
      });
      if (Array.isArray(res.configOptions)) {
        proc.configOptions = [...res.configOptions];
      }
    }
  }

  async #runPromptTurn(
    st: AcpSessionState,
    proc: AcpProc,
    batch: AcpBatch,
    acpSessionId: string,
    promptBlocks: ReturnType<typeof buildAcpPromptBlocks>,
    startedAt: number,
  ): Promise<void> {
    try {
      const res = await proc.acpConn.agent.request(methods.agent.session.prompt, {
        sessionId: acpSessionId,
        prompt: promptBlocks,
      });
      // 确保同一分片内的流式 session/update 通知先于轮末收尾落地
      await Promise.resolve();
      await Promise.resolve();
      if (proc.streamEnded || st.proc !== proc) return;

      const at = Date.now();
      this.markProcessing(st, batch, at);
      this.#flushTextBuffer(st, proc, at);
      this.#closeOpenTools(st, proc, at);

      const interrupted =
        res.stopReason === "cancelled" || st.turnInterrupted || st.stopRequested;
      const ok = !interrupted && res.stopReason !== "refusal";
      const error =
        !ok && !interrupted
          ? {
              subtype: res.stopReason,
              message: `ACP turn stopped with reason: ${res.stopReason}`,
            }
          : undefined;

      this.#finishTurn(st, proc, batch, {
        ok,
        interrupted,
        durationMs: Math.max(0, at - startedAt),
        usage: res.usage,
        error,
        at,
      });
    } catch (err) {
      await Promise.resolve();
      await Promise.resolve();
      if (proc.streamEnded || st.proc !== proc) return;

      const at = Date.now();
      this.#flushTextBuffer(st, proc, at);
      this.#closeOpenTools(st, proc, at);

      const isCancelledRpc =
        (err instanceof RequestError && err.code === -32800) ||
        st.turnInterrupted ||
        st.stopRequested;
      if (isCancelledRpc) {
        this.#finishTurn(st, proc, batch, {
          ok: false,
          interrupted: true,
          durationMs: Math.max(0, at - startedAt),
          usage: null,
          at,
        });
        return;
      }

      const classified =
        this.#config.errors?.classifyTurnError?.(err) ?? defaultClassifyAcpTurnError(err);
      this.#finishTurn(st, proc, batch, {
        ok: false,
        interrupted: false,
        durationMs: Math.max(0, at - startedAt),
        usage: null,
        error: classified,
        at,
      });
    }
  }

  #finishTurn(
    st: AcpSessionState,
    proc: AcpProc,
    batch: AcpBatch,
    outcome: {
      ok: boolean;
      interrupted: boolean;
      durationMs: number;
      usage?: Parameters<typeof mergeAcpPromptUsage>[2];
      error?: { subtype: string; message: string };
      at: number;
    },
  ): void {
    const settled = st.inFlight.length > 0 ? [...st.inFlight] : [batch];
    st.inFlight = [];
    st.selfTurn = false;
    st.turnInterrupted = false;
    st.stopRequested = false;
    st.cancelSent = false;

    const event: Extract<DriverEvent, { type: "turn.ended" }> = {
      type: "turn.ended",
      ok: outcome.ok,
      interrupted: outcome.interrupted,
      messageIds: settled.flatMap((b) => b.messageIds),
      durationMs: outcome.durationMs,
      ...(proc.closing === "shutdown" && (!outcome.ok || outcome.interrupted)
        ? { shutdown: true as const }
        : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      at: outcome.at,
    };

    if (!outcome.ok && !outcome.interrupted) {
      this.forgetWritten(st, settled);
    } else {
      this.markHealthy(st.id);
    }

    this.cancelUsagePush(st);
    const row = this.row(st);
    const mergedUsage = mergeAcpPromptUsage(
      row?.usage ?? ZERO_USAGE,
      proc.baseUsage,
      outcome.usage,
      proc.latestContextUsed,
      this.#config.usageMode ?? "turn",
    );
    const patch: AgentSessionPatch = {
      status: "idle",
      lastEventAt: outcome.at,
    };
    if (mergedUsage !== null) patch.usage = mergedUsage;
    if (row?.hasCompletedTurn === false) patch.hasCompletedTurn = true;
    this.update(st, patch);

    this.clearTimer(st, "interruptTimer");
    if (!proc.closing) clearKillTimer(proc);
    this.emit(st.id, event);
    this.resolveInterrupt(st);
    this.afterTurn(st, proc);
    this.settled(st);
  }

  #resetTurnBuffers(st: AcpSessionState, proc: AcpProc): void {
    proc.turnSeq += 1;
    proc.textSegmentSeq = 0;
    proc.thinkingSeq = 0;
    proc.textBuffer = "";
    proc.textBufferBytes = 0;
    proc.textMessageId = null;
    proc.inThinkingRun = false;
    proc.activeTools.clear();
    st.turnInterrupted = false;
    st.stopRequested = false;
    st.cancelSent = false;
  }

  #scopedUuid(proc: AcpProc, suffix: string): string {
    const sid = proc.acpSessionId ?? "acp";
    return `acp:${sid}:${proc.processScope}:t${proc.turnSeq}:${suffix}`;
  }

  #flushTextBuffer(st: AcpSessionState, proc: AcpProc, at: number): void {
    const text = proc.textBuffer;
    proc.textBuffer = "";
    proc.textBufferBytes = 0;
    proc.textMessageId = null;
    if (text === "") return;
    proc.textSegmentSeq += 1;
    this.emit(st.id, {
      type: "agent.text",
      uuid: this.#scopedUuid(proc, `m${proc.textSegmentSeq}`),
      text,
      at,
    });
  }

  #appendTextDelta(
    st: AcpSessionState,
    proc: AcpProc,
    delta: string,
    messageId: string | null,
    at: number,
  ): void {
    if (delta === "") return;
    proc.inThinkingRun = false;
    if (
      messageId !== null &&
      proc.textMessageId !== null &&
      messageId !== proc.textMessageId &&
      proc.textBuffer !== ""
    ) {
      this.#flushTextBuffer(st, proc, at);
    }
    const bytes = Buffer.from(delta, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      let end = Math.min(bytes.length, offset + MAX_MESSAGE_BYTES - proc.textBufferBytes);
      // UTF-8 续字节不能作为下一个分片的开头。
      while (end < bytes.length && end > offset && (bytes[end]! & 0xc0) === 0x80) end--;
      if (end === offset) {
        this.#flushTextBuffer(st, proc, at);
        continue;
      }
      proc.textBuffer += bytes.subarray(offset, end).toString("utf8");
      proc.textBufferBytes += end - offset;
      if (messageId !== null) proc.textMessageId = messageId;
      offset = end;
      if (proc.textBufferBytes >= MAX_MESSAGE_BYTES) this.#flushTextBuffer(st, proc, at);
    }
  }

  #closeOpenTools(st: AcpSessionState, proc: AcpProc, at: number): void {
    const unclosed: string[] = [];
    for (const tool of proc.activeTools.values()) {
      if (!tool.resultEmitted) {
        tool.resultEmitted = true;
        unclosed.push(tool.toolCallId);
      }
    }
    proc.activeTools.clear();
    if (unclosed.length > 0) {
      this.emit(st.id, { type: "agent.tool_result", toolUseIds: unclosed, at });
    }
  }

  #trackToolBounded(proc: AcpProc, entry: AcpTrackedToolCall): void {
    if (!proc.activeTools.has(entry.toolCallId) && proc.activeTools.size >= SESSION_STEPS_KEEP) {
      const oldestKey = proc.activeTools.keys().next().value;
      if (oldestKey !== undefined) proc.activeTools.delete(oldestKey);
    }
    proc.activeTools.set(entry.toolCallId, entry);
  }

  #handleToolUpdate(
    st: AcpSessionState,
    proc: AcpProc,
    toolCall: ToolCall | ToolCallUpdate,
    at: number,
  ): void {
    this.#flushTextBuffer(st, proc, at);
    proc.inThinkingRun = false;

    const toolCallId = toolCall.toolCallId;
    const existing = proc.activeTools.get(toolCallId);
    const extractor = this.#config.extractToolUse ?? defaultExtractAcpToolUse;
    const { name, input } = extractor(toolCall, existing);

    let tracked = existing;
    if (!tracked) {
      tracked = {
        toolCallId,
        name,
        input,
        kind: toolCall.kind ?? null,
        resultEmitted: false,
      };
      this.#trackToolBounded(proc, tracked);
      this.emit(st.id, {
        type: "agent.tool",
        uuid: this.#scopedUuid(proc, `tool:${toolCallId}`),
        toolUseId: toolCallId,
        name,
        input,
        at,
      });
    } else {
      tracked.name = name;
      tracked.input = input;
      if (toolCall.kind !== undefined) tracked.kind = toolCall.kind;
    }

    if (
      !tracked.resultEmitted &&
      (toolCall.status === "completed" || toolCall.status === "failed")
    ) {
      tracked.resultEmitted = true;
      this.emit(st.id, {
        type: "agent.tool_result",
        toolUseIds: [toolCallId],
        at,
      });
    }
  }

  #handleSessionUpdate(
    st: AcpSessionState,
    proc: AcpProc,
    notification: SessionNotification,
    at: number,
  ): void {
    if (st.proc !== proc || proc.streamEnded) return;
    const { update } = notification;
    if (notification.sessionId !== proc.acpSessionId && proc.initSeen) return;

    if (proc.swallowingReplay && REPLAYED_HISTORY_SESSION_UPDATES.has(update.sessionUpdate)) {
      return;
    }

    const batch = st.inFlight[0];
    if (proc.initSeen && batch) this.markProcessing(st, batch, at);

    switch (update.sessionUpdate) {
      case "available_commands_update": {
        const commands = parseAcpAvailableCommands(update.availableCommands);
        st.cachedCommands = commands;
        this.emit(st.id, { type: "commands.changed", commands, at });
        return;
      }
      case "config_option_update": {
        proc.configOptions = [...update.configOptions];
        return;
      }
      case "current_mode_update": {
        if (proc.modes) {
          proc.modes = { ...proc.modes, currentModeId: update.currentModeId };
        }
        return;
      }
      case "usage_update": {
        if (typeof update.used === "number" && Number.isFinite(update.used) && update.used >= 0) {
          proc.latestContextUsed = Math.floor(update.used);
          const current = this.row(st)?.usage ?? ZERO_USAGE;
          const next = applyAcpUsageUpdate(current, update);
          if (next !== null) this.pushUsage(st, next);
        }
        return;
      }
      case "agent_thought_chunk": {
        if (update.content.type === "text" && update.content.text === "") return;
        this.#flushTextBuffer(st, proc, at);
        if (!proc.inThinkingRun) {
          proc.inThinkingRun = true;
          proc.thinkingSeq += 1;
          this.emit(st.id, {
            type: "agent.thinking",
            uuid: this.#scopedUuid(proc, `th${proc.thinkingSeq}`),
            at,
          });
        }
        return;
      }
      case "agent_message_chunk": {
        if (update.content.type === "text") {
          this.#appendTextDelta(st, proc, update.content.text, update.messageId ?? null, at);
        }
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        this.#handleToolUpdate(st, proc, update, at);
        return;
      }
      case "compaction_update": {
        if ("status" in update && update.status === "completed") {
          this.#flushTextBuffer(st, proc, at);
          this.emit(st.id, {
            type: "context.compacted",
            uuid: this.#scopedUuid(proc, `compact:${at}`),
            trigger: null,
            preTokens: null,
            postTokens: null,
            at,
          });
        }
        return;
      }
      default:
        return;
    }
  }

  protected onParsedLine(
    st: AcpSessionState,
    proc: AcpProc,
    obj: Record<string, unknown>,
    rawLine: string,
    _at: number,
  ): void {
    if (proc.streamEnded) return;
    if (obj.jsonrpc !== "2.0") {
      this.reportError(st.id, "bad_output_line", `bad_output_line: ${rawLine.slice(0, 200)}`);
      return;
    }

    if (obj.method === "session/update" && obj.id === undefined) {
      const params = asRecord(obj.params);
      const update = asRecord(params?.update);
      const kind = typeof update?.sessionUpdate === "string" ? update.sessionUpdate : null;
      if (kind !== null && !KNOWN_ACP_SESSION_UPDATES.has(kind)) {
        this.#config.extensions?.onCustomSessionUpdate?.({
          sessionId: typeof params?.sessionId === "string" ? params.sessionId : proc.acpSessionId,
          sessionUpdate: kind,
          update: update!,
        });
        return;
      }
    }

    if (proc.acpReadableController) {
      try {
        if ((proc.acpReadableController.desiredSize ?? 0) <= -SESSION_STEPS_KEEP) {
          this.reportError(st.id, "bad_output_line", "ACP incoming queue limit exceeded");
          this.#closeAcpTransport(proc);
          this.forceKillProc(st, proc);
          return;
        }
        proc.acpReadableController.enqueue(obj as unknown as AnyMessage);
      } catch {
        // 连接已关闭时忽略尾随消息
      }
    }
  }

  #closeAcpTransport(proc: AcpProc): void {
    proc.streamEnded = true;
    proc.onPromptWritten = null;
    const ctrl = proc.acpReadableController;
    proc.acpReadableController = null;
    if (ctrl) {
      try {
        ctrl.close();
      } catch {
        // 已关闭则忽略
      }
    }
    try {
      proc.acpConn.close(new Error("ACP process closed"));
    } catch {
      // 已关闭则忽略
    }
  }

  protected onProcessClose(
    st: AcpSessionState,
    proc: AcpProc,
    code: number | null,
    signal: NodeJS.Signals | null,
    resolveExited: () => void,
  ): void {
    try {
      const now = Date.now();
      if (proc.initSeen && st.inFlight.length > 0) {
        this.#flushTextBuffer(st, proc, now);
      }
      proc.textBuffer = "";
      proc.textBufferBytes = 0;
      proc.activeTools.clear();
      this.#closeAcpTransport(proc);

      const at = this.beginProcessClose(st, proc);
      st.cancelSent = false;
      st.cachedCommands = null;

      if (!proc.initSeen) {
        if (proc.closing === null) {
          this.forgetWritten(st, st.inFlight);
          st.inFlight = [];
          proc.resolveReady({
            kind: "failed",
            exitCode: code,
            signal,
            stderr: proc.stderr,
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
        proc.resolveReady({ kind: "closed", reason: proc.closing });
      }

      const batches = proc.initSeen || proc.closing === "interrupt" ? [...st.inFlight] : [];
      st.inFlight = [];
      st.selfTurn = false;
      st.turnInterrupted = false;
      const stopped = proc.closing === "interrupt" || st.stopRequested;
      const reason: SessionExitReason = proc.closing ?? (stopped ? "interrupt" : "crash");
      st.stopRequested = false;

      if (batches.length > 0 && reason === "crash") {
        st.crashNote = true;
        this.forgetWritten(st, batches);
      }

      this.emit(st.id, {
        type: "session.exited",
        reason,
        exitCode: code,
        signal,
        hadResult: batches.length === 0,
        messageIds: batches.flatMap((b) => b.messageIds),
        at,
      });
    } finally {
      this.resolveInterrupt(st);
      resolveExited();
      this.settled(st);
    }
  }
}

/** 用厂商给定的 AcpDriverConfig 创建 ACP 会话驱动实例。 */
export function createAcpDriver(config: AcpDriverConfig, options: AcpDriverOptions): AcpSessionDriver {
  return new AcpSessionDriver(config, options);
}

/** 生成直接满足 VendorDaemon["createDriver"] 签名的工厂函数。 */
export function createAcpDriverFactory(config: AcpDriverConfig): (options: DriverOptions) => Driver {
  return (options) => createAcpDriver(config, options);
}
