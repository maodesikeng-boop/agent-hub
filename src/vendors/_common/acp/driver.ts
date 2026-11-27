import { checklistLaunchArgs } from "../checklist.ts";
import { randomUUID } from "node:crypto";
import { methods, type AnyMessage, type ClientCapabilities } from "@agentclientprotocol/sdk/unstable";
import {
  NO_NOTES,
  clearKillTimer,
  createBaseSessionState,
  entryParts,
  errorMessage,
  type ClosingReason,
  type PendingEntry,
  type StartupOutcome,
} from "../../../daemon/driver/base-driver.ts";
import { signalChild } from "../../../daemon/driver/process.ts";
import {
  WORKER_NEEDS_OS_SANDBOX_MESSAGE,
  spawnInWriteScope,
  wrapInReadonlyOsSandbox,
  type ReadonlySandboxInput,
  type ScopedSpawn,
  type SpawnCommand,
} from "../../../daemon/driver/write-scope.ts";
import {
  ACP_FIRST_TURN_SYSTEM_PROMPT_RESERVE_BYTES,
  DriverError,
  MAX_MESSAGE_BYTES,
  SESSION_STEPS_KEEP,
  handoverMaxSingleMessageBytesOf,
  vendorSpec,
  type AgentSessionRow,
  type ComposerCommand,
  type Driver,
  type DriverOptions,
  type DriverSendInput,
  type DriverSendResult,
  type LaunchFiles,
  type SessionExitReason,
  type SessionId,
} from "../../../shared/index.ts";
import { createSpecComposerBase } from "../composer.ts";
import { VendorSessionDriver } from "../session-driver.ts";
import {
  ZERO_USAGE,
  type AcpBatch,
  type AcpDriverHost,
  type AcpProc,
  type AcpSessionState,
  type AcpSystemPromptInjection,
} from "./driver-state.ts";
import { runAcpHandshake } from "./handshake.ts";
import {
  KNOWN_ACP_SESSION_UPDATES,
  buildAcpPromptBlocks,
  checkAcpUserBlocks,
  identifyAcpStaleProcess,
  normalizeAcpUserBlocks,
  readAcpSystemPrompt,
} from "./protocol.ts";
import { buildAcpReadonlySandboxInput, createAcpClientApp, createAcpStdioStream, guardAcpFrameSize } from "./transport.ts";
import { runAcpPromptTurn } from "./turn.ts";
import { emitAcpChecklist, flushTextBuffer, handleSessionUpdate, resetTurnBuffers } from "./turn-stream.ts";
import type { AcpDriverConfig, AcpDriverOptions, AcpLaunchContext } from "./types.ts";

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}


export class AcpSessionDriver extends VendorSessionDriver<AcpProc, AcpBatch, AcpSessionState> {
  readonly #config: AcpDriverConfig;
  readonly #executablePath: string | (() => string);
  readonly #readonlySpawn: (base: SpawnCommand, input: ReadonlySandboxInput) => ScopedSpawn;
  readonly #host: AcpDriverHost;

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
    this.#host = this.#createHost();
    this.#executablePath = executablePath;
    this.#readonlySpawn = readonlySpawn ?? ((base, input) => wrapInReadonlyOsSandbox(base, input));
  }

  #resolveExecutablePath(): string {
    return typeof this.#executablePath === "function" ? this.#executablePath() : this.#executablePath;
  }

  #systemPromptInjection(): AcpSystemPromptInjection {
    const configured = this.#config.session?.systemPromptInjection;
    if (configured !== undefined) return configured;
    return vendorSpec(this.vendor).capabilities.systemPrompt === "resident" ? "never" : "first_turn_new_session";
  }

  #createHost(): AcpDriverHost {
    return {
      ...this.createHost(),
      config: this.#config,
      systemPromptInjection: () => this.#systemPromptInjection(),
      clientCapabilities: () => this.#clientCapabilities(),
      reinjectAfterCompaction: (st, proc) => this.#reinjectAfterCompaction(st, proc),
    };
  }


  // ACP agents send compaction_update only when the client declares session.compaction.
  #clientCapabilities(): ClientCapabilities {
    const base = this.#config.clientCapabilities ?? {};
    if (this.#systemPromptInjection() === "never") return base;
    return { ...base, session: { ...base.session, compaction: base.session?.compaction ?? {} } };
  }

  #reinjectAfterCompaction(st: AcpSessionState, proc: AcpProc): void {
    if (proc.reinjectPromptFile === null || st.reinjectPending) return;
    st.reinjectPending = true;
    this.logSession(st.id, "厂商压缩了上下文，下一条消息前重新拼产品提示词");
  }

  #takeReinjectBlock(st: AcpSessionState, proc: AcpProc): string | null {
    if (!st.reinjectPending || proc.reinjectPromptFile === null) return null;
    try {
      return readAcpSystemPrompt(proc.reinjectPromptFile, this.#config.session?.formatSystemPrompt);
    } catch (error) {
      this.logSession(st.id, `要重新拼产品提示词，但读不到提示词文件：${errorMessage(error)}`);
      return null;
    }
  }

  protected createSessionState(id: SessionId): AcpSessionState {
    return {
      ...createBaseSessionState(id),
      hasConversation: false,
      cancelSent: false,
      cachedCommands: null,
      reinjectPending: false,
    };
  }

  override markEnding(sessionId: SessionId): void {
    const st = this.sessions.get(sessionId);
    if (st) st.cachedCommands = null;
    super.markEnding(sessionId);
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
      ...(input.rider ? { rider: true } : {}),
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
      this.#resolveExecutablePath(),
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
    const injection = this.#systemPromptInjection();
    const activeProc = st.proc && !st.proc.closing ? st.proc : null;
    const willRebakeOnSpawn =
      activeProc === null &&
      (injection === "every_process_first_turn" ||
        !this.resumeFor(st) ||
        Boolean(this.#config.continuation?.rebakesPersonaOnResume));
    const needsColdSystemPromptReserve =
      activeProc === null &&
      (injection === "every_process_first_turn" || (injection === "first_turn_new_session" && !this.resumeFor(st)));
    const { notes, prefixes } = this.takeNotesPrefixes(st, {
      takePersona: !willRebakeOnSpawn,
      fromRowOnFirstPersonaCheck: !willRebakeOnSpawn,
      turnBody: taken.body,
      systemPrompt: activeProc?.pendingSystemPromptBlock ?? null,
      ...(needsColdSystemPromptReserve ? { extraReserveBytes: ACP_FIRST_TURN_SYSTEM_PROMPT_RESERVE_BYTES } : {}),
    });
    const hasPreambleBlock = notes.preamble?.note != null && notes.preamble.note.trim() !== "";
    return {
      messageIds: taken.messageIds,
      userBlocks: normalizeAcpUserBlocks(
        this.composer.buildUserContent([...prefixes, ...taken.body.prefixes], taken.body.text),
      ),
      ...(hasPreambleBlock ? { hasPreambleBlock: true as const } : {}),
      notes,
      delivered: false,
      processing: false,
      source: taken.source,
      includeDeliverySuffix: true,
      riders: taken.riders,
      entries: taken.entries,
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
    if (!st.inFlight.includes(batch)) st.inFlight.push(batch);
    let proc = existing;
    try {
      if (!proc) proc = await this.#spawn(st, this.resumeFor(st), files);
      this.abortIfStopped(st, proc);
    } catch (error) {
      this.dropBatch(st, batch);
      throw error;
    }
    this.clearTimer(st, "idleTimer");
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
    if (this.discardStaleSystemBatch(st, proc, batch)) return;
    const vendorCap = handoverMaxSingleMessageBytesOf(this.vendor);
    const systemBlock = proc.pendingSystemPromptBlock ?? this.#takeReinjectBlock(st, proc);
    const systemBytes = systemBlock !== null && systemBlock.trim() !== "" ? Buffer.byteLength(systemBlock, "utf8") : 0;
    let suffix = batch.includeDeliverySuffix !== true ? "" : this.takeDeliverySuffix(st, batch);
    let baseBlocks = batch.userBlocks;
    const blocksBytes = (blocks: ReadonlyArray<{ type: "text"; text: string }>, tail: string): number =>
      blocks.reduce((sum, b) => sum + Buffer.byteLength(b.text, "utf8"), 0) +
      (tail === "" ? 0 : Buffer.byteLength(tail, "utf8"));

    if (batch.hasPreambleBlock && blocksBytes(baseBlocks, suffix) + systemBytes > vendorCap) {
      const withoutPreamble = baseBlocks.slice(1);
      const restBytes = blocksBytes(withoutPreamble, suffix);
      const exactReserved = restBytes + systemBytes + (suffix === "" ? 0 : 2) + (systemBytes === 0 ? 0 : 2);
      let refit: string | null = null;
      if (this.opts.sessionPreamble) {
        try {
          refit = this.opts.sessionPreamble(st.id, { reservedBytes: exactReserved });
        } catch (error) {
          this.internalError(st.id, `sessionPreamble refit failed, writing without it: ${errorMessage(error)}`);
        }
      }
      if (refit !== null && refit.trim() !== "" && Buffer.byteLength(refit, "utf8") + restBytes + systemBytes <= vendorCap) {
        baseBlocks = [{ type: "text", text: refit }, ...withoutPreamble];
        if (batch.notes.preamble) batch.notes.preamble = { ...batch.notes.preamble, note: refit };
      } else {
        baseBlocks = withoutPreamble;
        if (batch.notes.preamble) batch.notes.preamble = { ...batch.notes.preamble, note: null };
      }
    }

    if (suffix !== "" && blocksBytes(baseBlocks, suffix) + systemBytes > vendorCap && blocksBytes(baseBlocks, "") <= vendorCap) {
      suffix = "";
      delete batch.agenda;
    }

    const userBlocks = suffix === "" ? baseBlocks : [...baseBlocks, { type: "text" as const, text: suffix }];
    const problem = checkAcpUserBlocks(userBlocks, vendorCap);
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
    resetTurnBuffers(st, proc);

    proc.pendingSystemPromptBlock = null;
    st.reinjectPending = false;
    const promptBlocks = buildAcpPromptBlocks(userBlocks, systemBlock);

    const startedAt = Date.now();
    this.update(st, { status: "running", lastEventAt: startedAt });

    await new Promise<void>((resolve) => {
      const onWritten = () => {
        this.markDelivered(st, batch);
        resolve();
      };
      proc.onPromptWritten = onWritten;
      void runAcpPromptTurn(this.#host, st, proc, batch, acpSessionId, promptBlocks, startedAt).finally(() => {
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

  async #wrapLaunch(
    st: AcpSessionState,
    launchCtx: AcpLaunchContext,
    rawLaunchArgs: string[],
  ): Promise<{ spawnCmd: string; spawnArgs: string[]; extraEnv: Record<string, string> }> {
    const { files, executablePath: exePath } = launchCtx;
    const extraEnv: Record<string, string> = { ...files.env };
    if (!files.readonly) {
      const scoped = spawnInWriteScope(
        this.vendor,
        { command: exePath, args: rawLaunchArgs },
        files.writeScope ?? null,
        this.opts.log,
        String(st.id),
      );
      return { spawnCmd: scoped.command, spawnArgs: scoped.args, extraEnv };
    }
    const { input } = await buildAcpReadonlySandboxInput(this.#config.readonlySandbox, launchCtx, files.readonly, files.tmpDir);
    const ownOffArgs = vendorSpec(this.vendor).capabilities.ownSandboxOffArgs ?? [];
    const wrapped = this.#readonlySpawn(
      { command: exePath, args: [...ownOffArgs, ...rawLaunchArgs] },
      input,
    );
    if (!wrapped.osSandboxed) {
      throw new DriverError("spawn_failed", WORKER_NEEDS_OS_SANDBOX_MESSAGE);
    }
    if (wrapped.readonlyFallbackWarning) {
      this.log(wrapped.readonlyFallbackWarning);
      this.emit(st.id, {
        type: "driver.warning",
        uuid: randomUUID(),
        message: wrapped.readonlyFallbackWarning,
        at: Date.now(),
      });
    }
    extraEnv.TMPDIR = input.tmpDir;
    if (process.platform === "win32") {
      extraEnv.TEMP = input.tmpDir;
      extraEnv.TMP = input.tmpDir;
    }
    return { spawnCmd: wrapped.command, spawnArgs: wrapped.args, extraEnv };
  }

  async #spawn(st: AcpSessionState, resume: boolean, prepared: LaunchFiles | null): Promise<AcpProc> {
    const { row, files } = await this.resolveLaunchFiles(st, prepared);
    const exePath = this.#resolveExecutablePath();
    const launchCtx: AcpLaunchContext = {
      row,
      files,
      resume,
      executablePath: exePath,
    };
    const rawLaunchArgs =
      typeof this.#config.launchArgs === "function"
        ? [...this.#config.launchArgs(launchCtx)]
        : [...this.#config.launchArgs];
    const { spawnCmd, spawnArgs, extraEnv } = await this.#wrapLaunch(st, launchCtx, [...checklistLaunchArgs(vendorSpec(this.vendor)), ...rawLaunchArgs]);
    this.assertRunning();
    this.assertNotEnded(st);

    const child = await this.spawnDetachedChild(
      exePath,
      spawnCmd,
      spawnArgs,
      row.cwd,
      extraEnv,
    );

    const { baseProc, resolveExited } = this.createBaseProc<StartupOutcome>(child, resume, row, files);
    let proc!: AcpProc;
    const { stream, readableController } = createAcpStdioStream(child, {
      onWriteFailure: () => this.forceKillProc(st, proc),
      onPromptWritten: () => {
        proc.onPromptWritten?.();
        proc.onPromptWritten = null;
      },
    });
    const app = createAcpClientApp(this.#config, {
      proc: () => proc,
      isShuttingDown: () => this.shuttingDown,
      onSessionUpdate: (params) => handleSessionUpdate(this.#host, st, proc, params, Date.now()),
      onChecklist: (update) => {
        if (st.proc === proc && !proc.streamEnded && !proc.swallowingReplay) {
          emitAcpChecklist(this.#host, st, proc, update, Date.now());
        }
      },
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
      reinjectPromptFile: null,
      baseUsage: { ...(row.usage ?? ZERO_USAGE) },
      latestContextUsed: null,
      turnSeq: 0,
      textSegmentSeq: 0,
      thinkingSeq: 0,
      checklistSeq: 0,
      textBuffer: "",
      textBufferBytes: 0,
      textMessageId: null,
      inThinkingRun: false,
      activeTools: new Map(),
      onPromptWritten: null,
    };

    this.attachChildProcess(st, proc, resolveExited);
    guardAcpFrameSize(child, () => {
      this.reportError(st.id, "bad_output_line", "ACP protocol frame exceeds message limit");
      this.forceKillProc(st, proc);
    });
    void runAcpHandshake(this.#host, st, proc, launchCtx);
    return proc;
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
      }
    }
    try {
      proc.acpConn.close(new Error("ACP process closed"));
    } catch {
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
        flushTextBuffer(this.#host, st, proc, now);
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

export function createAcpDriver(config: AcpDriverConfig, options: AcpDriverOptions): AcpSessionDriver {
  return new AcpSessionDriver(config, options);
}
