import { createCodexAppApprovalState } from "./app-approval.ts";
import { untakenReleaseCause } from "../../daemon/driver/stop-untaken.ts";
import { checklistLaunchArgs } from "../_common/checklist.ts";
import codexSpec from "./spec.ts";
import {
  DriverError,
  type AgentSessionRow,
  type DriverOptions,
  type DriverSendInput,
  type DriverSendResult,
  type LaunchFiles,
  type MessageId,
  type MessageSource,
  type SessionExitReason,
  type SessionId,
  type WriteScope,
} from "../../shared/index.ts";
import type { VendorComposerBase } from "../../daemon/vendors/types.ts";
import { codexComposerBase } from "./composer.ts";
import {
  NO_NOTES,
  createBaseSessionState,
  entryParts,
  type PendingEntry,
  type StartupOutcome,
} from "../../daemon/driver/base-driver.ts";
import {
  buildCodexArgs,
  buildInitializeRequest,
  buildTurnInterruptRequest,
  buildTurnStartRequest,
  buildTurnSteerRequest,
  checkCodexTurnText,
  codexOfSession,
  combineCodexTurnText,
  readCodexLaunchConfig,
} from "./protocol.ts";
import { spawnInWriteScope, type ScopedSpawn, type SpawnCommand } from "../../daemon/driver/write-scope.ts";
import { VendorSessionDriver } from "../_common/session-driver.ts";
import {
  asObject,
  newBatch,
  nonEmptyString,
  startupError,
  type Batch,
  type CodexDriverHost,
  type Proc,
  type SessionState,
  type Steer,
  type SteerOutcome,
} from "./driver-state.ts";
import { isHandshakePhase, onHandshakeResponse } from "./handshake.ts";
import { onNotification } from "./notifications.ts";
import { answerServerRequest } from "./server-requests.ts";

export interface CodexDriverOptions extends Omit<DriverOptions, "executablePath"> {
  executablePath?: string | (() => string);
  // Without an explicit model codex uses config.toml's, which this account may lack (model_not_found).
  defaultModel?: () => Promise<string | null>;
  composer?: VendorComposerBase;
  platform?: NodeJS.Platform;
  writeScopeSpawn?: (base: SpawnCommand, scope: WriteScope | null) => ScopedSpawn;
}

export class CodexDriver extends VendorSessionDriver<Proc, Batch, SessionState> {
  readonly #codexPath: string | (() => string);
  readonly #platform: NodeJS.Platform;
  readonly #writeScopeSpawn?: (base: SpawnCommand, scope: WriteScope | null) => ScopedSpawn;
  readonly #defaultModel: () => Promise<string | null>;
  readonly #host: CodexDriverHost;

  constructor({ executablePath, platform, writeScopeSpawn, defaultModel, composer, ...options }: CodexDriverOptions) {
    super("codex", { ...options, composer: composer ?? codexComposerBase });
    this.#defaultModel = defaultModel ?? (async () => null);
    this.#codexPath = executablePath ?? "codex";
    this.#platform = platform ?? process.platform;
    this.#writeScopeSpawn = writeScopeSpawn;
    this.#host = this.createHost();
  }

  #resolveCodexPath(): string {
    return typeof this.#codexPath === "function" ? this.#codexPath() : this.#codexPath;
  }

  protected createSessionState(id: SessionId): SessionState {
    return {
      ...createBaseSessionState<Proc, Batch>(id),
      activeTurnId: null,
      turnSeq: 0,
      interruptRequestId: null,
      usageThreadId: null,
      lastThreadTotal: null,
      turnUsageStepSeq: 0,
      lastTurnResultUsage: null,
      lastTurnContext: null,
      agentMessageBuffers: new Map(),
      emittedMessageIds: new Set(),
      emittedThinkingIds: new Set(),
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
      ...(input.rider ? { rider: true } : {}),
    };
    const parts = entryParts(entry);
    const problem = checkCodexTurnText(combineCodexTurnText(parts.text, parts.prefixes));
    if (problem) {
      this.invalidInput(st, problem, ids);
      return { kind: "rejected" };
    }
    if (!this.isPending(st, ids)) {
      if (input.recovery) st.recoveryNote = true;
      const proc = st.proc;
      if (proc && this.#canSteer(st, proc, entry)) {
        const outcome = await this.steerWithCurrentCapabilities(st, proc, entry, () => this.#canSteer(st, proc, entry), () => {
          const batch = this.#batchOf(st, entryParts(entry), ids, false, entry.source);
          batch.midTurn = true;
          return this.#steer(st, proc, batch, entry);
        });
        if (outcome === "written") return { kind: "written", midTurn: true };
        if (outcome === "cancelled") return { kind: "cancelled" };
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
      proc.threadId !== null &&
      st.activeTurnId !== null &&
      !proc.closing &&
      !this.shuttingDown &&
      this.busy(st) &&
      st.starting === null &&
      !st.stopRequested &&
      st.pending.length === 0 &&
      !this.composer.isCommand(entry.text)
    );
  }

  #steer(st: SessionState, proc: Proc, batch: Batch, entry: PendingEntry): Promise<SteerOutcome> {
    const reqId = ++this.requestSeq;
    st.inFlight.push(batch);
    this.clearTimer(st, "idleTimer");
    return new Promise<SteerOutcome>((resolve) => {
      const steer: Steer = { batch, entry, resolve };
      proc.steers.set(reqId, steer);
      proc.pendingRpcs.set(reqId, "turn_steer");
      proc.child.stdin.write(
        buildTurnSteerRequest(reqId, proc.threadId!, st.activeTurnId!, this.withDeliverySuffix(st, batch, batch.combinedText)) + "\n",
        (err) => {
          if (!err || !proc.steers.has(reqId)) return;
          proc.steers.delete(reqId);
          proc.pendingRpcs.delete(reqId);
          this.#settleSteer(st, steer, false);
        },
      );
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

  async interrupt(sessionId: SessionId): Promise<void> {
    const st = this.sessions.get(sessionId);
    if (!st) return;
    this.dropPendingUsers(st);
    const proc = st.proc;
    if (!proc || !this.busy(st) || proc.closing) return;
    st.stopRequested = true;
    st.turnInterrupted = true;
    for (const batch of st.inFlight) if (batch.midTurn && !batch.delivered) batch.stopped = true;
    const done = new Promise<void>((resolve) => st.interruptWaiters.push(resolve));
    if (st.interruptRequestId === null) {
      const reqId = ++this.requestSeq;
      st.interruptRequestId = reqId;
      if (proc.threadId && st.activeTurnId) {
        proc.pendingRpcs.set(reqId, "turn_interrupt");
        proc.child.stdin.write(buildTurnInterruptRequest(reqId, proc.threadId, st.activeTurnId) + "\n");
      }
      st.interruptTimer = setTimeout(() => {
        st.interruptTimer = null;
        this.sigintForInterrupt(st, proc, "killTimer");
      }, this.opts.interruptGraceMs);
    }
    return done;
  }

  protected override filterStaleRow(row: AgentSessionRow): boolean {
    return row.vendor === "codex";
  }

  protected identifyStaleProcess(pid: number, _row: AgentSessionRow): Promise<number | null> {
    return codexOfSession(pid);
  }

  protected takeBatch(st: SessionState): Batch | null {
    const taken = this.takePendingEntryBatch(st);
    if (!taken) return null;
    const batch = this.#batchOf(st, taken.body, taken.messageIds, taken.command, taken.source);
    batch.riders = taken.riders;
    batch.entries = taken.entries;
    return batch;
  }

  #batchOf(
    st: SessionState,
    body: { prefixes: string[]; text: string },
    messageIds: MessageId[],
    command: boolean,
    source: MessageSource,
  ): Batch {
    if (command) return newBatch(messageIds, combineCodexTurnText(body.text, body.prefixes), NO_NOTES, source);
    const { notes, prefixes } = this.takeNotesPrefixes(st);
    return { ...newBatch(messageIds, combineCodexTurnText(body.text, [...prefixes, ...body.prefixes]), notes, source), includeDeliverySuffix: true };
  }

  protected async writeBatch(st: SessionState, proc: Proc, batch: Batch): Promise<void> {
    if (this.discardStaleSystemBatch(st, proc, batch)) return;
    const combinedText = batch.includeDeliverySuffix !== true ? batch.combinedText : this.withDeliverySuffix(st, batch, batch.combinedText);
    const problem = checkCodexTurnText(combinedText);
    if (problem) {
      st.inFlight = st.inFlight.filter((b) => b !== batch);
      this.invalidInput(st, problem, batch.messageIds);
      this.afterTurn(st, proc);
      return;
    }
    const row = this.row(st);
    const threadId = proc.threadId ?? row?.vendorSessionId;
    if (!threadId) {
      st.inFlight = st.inFlight.filter((b) => b !== batch);
      this.invalidInput(st, "缺少 threadId", batch.messageIds);
      this.afterTurn(st, proc);
      return;
    }
    this.clearTimer(st, "idleTimer");
    if (!st.inFlight.includes(batch)) st.inFlight.push(batch);
    st.turnSeq += 1;
    st.turnInterrupted = false;
    st.stopRequested = false;
    st.agentMessageBuffers.clear();
    st.emittedMessageIds.clear();
    st.emittedThinkingIds.clear();
    proc.fileChangePaths.clear();
    proc.fileChangePreviewPaths.clear();
    st.turnUsageStepSeq = 0;
    st.lastTurnResultUsage = null;
    st.lastTurnContext = null;

    const reqId = ++this.requestSeq;
    proc.pendingRpcs.set(reqId, "turn_start");
    const line = buildTurnStartRequest(reqId, {
      threadId,
      combinedText,
      session: {
        cwd: row?.cwd ?? proc.launched.cwd,
        addDirs: row?.addDirs ?? proc.launched.addDirs,
        model: row?.model ?? proc.launched.model ?? proc.defaultModel,
        effort: row?.effort ?? proc.launched.effort,
      },
      readonly: proc.readonly,
      writeScope: proc.writeScope,
      osSandboxed: proc.osSandboxed,
    });
    await new Promise<void>((resolve) => {
      proc.child.stdin.write(line + "\n", (err) => {
        if (!err) this.markDelivered(st, batch);
        resolve();
      });
    });
  }

  #idleAfterSteer(st: SessionState, proc: Proc): void {
    this.clearTimer(st, "interruptTimer");
    st.stopRequested = false;
    st.turnInterrupted = false;
    this.resolveInterrupt(st);
    this.afterTurn(st, proc);
    this.settled(st);
  }

  protected override resolveInterrupt(st: SessionState): void {
    st.interruptRequestId = null;
    super.resolveInterrupt(st);
  }

  protected resumeFor(st: SessionState): boolean {
    return this.store(st).hasCompletedTurn;
  }

  protected spawnIdleProcess(st: SessionState, resume: boolean): Promise<Proc> {
    return this.#spawnAndHandshake(st, resume, null);
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
          if (st.ended || proc.closing || st.proc !== proc) {
            this.dropBatch(st, batch);
            if (st.ended) throw new DriverError("session_ended", `session ${st.id} has been ended`);
            return;
          }
          await this.writeBatch(st, proc, batch);
          return;
        }
        if (outcome.kind === "closed") {
          if (st.ended) throw new DriverError("session_ended", `session ${st.id} has been ended`);
          if (outcome.reason === "interrupt") return;
          throw new DriverError(
            "spawn_failed",
            this.shuttingDown ? "driver is shutting down" : `closed before thread ready (${outcome.reason})`,
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

  async #spawnAndHandshake(st: SessionState, resume: boolean, prepared: LaunchFiles | null): Promise<Proc> {
    const proc = await this.#spawn(st, resume, prepared);
    this.armStartTimer(st, proc);
    const outcome = await proc.ready;
    if (outcome.kind === "ok") return proc;
    if (outcome.kind === "closed") {
      throw new DriverError(
        "spawn_failed",
        this.shuttingDown ? "driver is shutting down" : `closed before thread ready (${outcome.reason})`,
      );
    }
    throw startupError(outcome, this.opts.startTimeoutMs);
  }

  async #spawn(st: SessionState, resume: boolean, prepared: LaunchFiles | null): Promise<Proc> {
    const { row, files } = await this.resolveLaunchFiles(st, prepared);
    const launchConfig = readCodexLaunchConfig(files);
    const defaultModel = row.model === null ? await this.#defaultModel().catch(() => null) : null;
    this.assertRunning();
    this.assertNotEnded(st);
    // macOS sandboxes cannot nest; read-only codex relies on its own readOnly sandbox instead.
    const wrapScope = launchConfig.readonly || files.outerSandbox === "vendor_only" ? null : (files.writeScope ?? null);
    const exePath = this.#resolveCodexPath();
    const args = [...checklistLaunchArgs(codexSpec), ...buildCodexArgs(files.capabilities)];
    const baseSpawn: SpawnCommand = { command: exePath, args };
    const launch = this.#writeScopeSpawn
      ? this.#writeScopeSpawn(baseSpawn, wrapScope)
      : spawnInWriteScope("codex", baseSpawn, wrapScope, this.opts.log, `session ${st.id}`, this.#platform);
    const child = await this.spawnDetachedChild(
      exePath,
      launch.command,
      launch.args,
      row.cwd,
      files.env,
    );
    const { baseProc, resolveExited } = this.createBaseProc<StartupOutcome>(child, resume, row, files);
    const gate = this.opts.appApprovals;
    const computerUseServers = row.role === "worker" && !launchConfig.readonly && files.outerSandbox === "vendor_only" && gate !== undefined
      ? (files.capabilities?.allow.mcp ?? []).filter((name) => codexSpec.capabilities.builtInSandbox?.computerUseCapabilities.includes(`mcp:${name}`))
      : [];
    const proc: Proc = {
      appApprovals: gate !== undefined && computerUseServers.length > 0 ? { gate, computerUseServers, state: createCodexAppApprovalState() } : null,
      ...baseProc,
      launchConfig,
      defaultModel,
      readonly: launchConfig.readonly,
      writeScope: files.writeScope ?? null,
      osSandboxed: launch.osSandboxed,
      fileChangePaths: new Map(),
      fileChangePreviewPaths: new Map(),
      threadId: resume ? row.vendorSessionId : null,
      pendingRpcs: new Map(),
      steers: new Map(),
    };
    this.attachChildProcess(st, proc, resolveExited);
    const initId = ++this.requestSeq;
    proc.pendingRpcs.set(initId, "initialize");
    child.stdin.write(buildInitializeRequest(initId) + "\n");
    return proc;
  }

  protected onParsedLine(
    st: SessionState,
    proc: Proc,
    obj: Record<string, unknown>,
    line: string,
    at: number,
  ): void {
    const hasId = obj.id !== undefined && obj.id !== null;
    const hasMethod = typeof obj.method === "string" && obj.method !== "";

    if (hasId && hasMethod) {
      answerServerRequest(this.#host, st, proc, obj.id as number | string, obj.method as string, obj.params);
      return;
    }

    if (hasId && !hasMethod) {
      this.#onRpcResponse(st, proc, obj.id as number | string, obj, at);
      return;
    }

    if (hasMethod) {
      onNotification(this.#host, st, proc, obj.method as string, obj.params, line, at);
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

    const errorObj = asObject(obj.error);
    const resultObj = asObject(obj.result);
    if (isHandshakePhase(phase)) {
      onHandshakeResponse(this.#host, st, proc, phase, errorObj, resultObj, at);
      return;
    }

    switch (phase) {
      case "turn_steer": {
        const steer = proc.steers.get(id);
        proc.steers.delete(id);
        if (!steer) return;
        // Rejected with 'no active turn to steer' or a turn id mismatch.
        if (errorObj) this.logSession(st.id, `turn/steer 没收下：${String(errorObj.message ?? "")}`);
        this.#settleSteer(st, steer, !errorObj);
        if (!this.busy(st)) this.#idleAfterSteer(st, proc);
        return;
      }

      case "turn_start": {
        if (errorObj) {
          this.#failTurnStart(st, proc, errorObj, at);
          return;
        }
        const turnId = nonEmptyString(asObject(resultObj?.turn)?.id);
        if (turnId) st.activeTurnId = turnId;
        const opening = st.inFlight.find((b) => !b.midTurn);
        if (opening) this.markProcessing(st, opening, at);
        return;
      }

      case "turn_interrupt": {
        if (errorObj) {
          this.clearTimer(st, "interruptTimer");
          this.sigintForInterrupt(st, proc, "killTimer");
        }
        return;
      }
    }
  }

  #failTurnStart(st: SessionState, proc: Proc, errorObj: Record<string, unknown>, at: number): void {
    const batches = st.inFlight.splice(0);
    for (const batch of batches) this.markProcessing(st, batch, at);
    this.forgetWritten(st, batches);
    const errMsg = typeof errorObj.message === "string" ? errorObj.message : "turn/start failed";
    this.emit(st.id, {
      type: "turn.ended",
      ok: false,
      interrupted: false,
      messageIds: batches.flatMap((b) => b.messageIds),
      durationMs: null,
      error: { subtype: "turn_start_error", message: errMsg },
      at,
    });
    this.afterTurn(st, proc);
    this.settled(st);
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
      if (proc.appApprovals !== null) {
        const { gate, state } = proc.appApprovals;
        for (const wait of state.waits.values()) wait.abort();
        gate.processEnded(st.id, state.processKey);
      }
      st.turnUsageStepSeq = 0;
      st.lastTurnResultUsage = null;
      st.lastTurnContext = null;
      st.agentMessageBuffers.clear();
      st.emittedMessageIds.clear();
      st.emittedThinkingIds.clear();
      proc.fileChangePaths.clear();
      proc.fileChangePreviewPaths.clear();
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
      st.activeTurnId = null;
      const reason: SessionExitReason = proc.closing ?? "crash";
      const missed = batches.filter((b) => b.midTurn && !b.echoed);
      const taken = batches.filter((b) => !missed.includes(b));
      if (taken.length > 0 && reason === "crash") {
        st.crashNote = true;
        this.forgetWritten(st, taken);
      }
      const cause = untakenReleaseCause(reason, st.stopRequested);
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
      this.releaseUntaken(st, missed, cause, at);
    } finally {
      this.resolveInterrupt(st);
      resolveExited();
      this.settled(st);
    }
  }
}

export function createCodexDriver(options: CodexDriverOptions): CodexDriver {
  return new CodexDriver(options);
}
