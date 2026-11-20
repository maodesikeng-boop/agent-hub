import {
  DriverError,
  EMPTY_TOKEN_USAGE,
  MAX_STREAMING_TOOL_BLOCKS,
  type AgentSessionPatch,
  type AgentSessionRow,
  type DriverEvent,
  type DriverOptions,
  type DriverSendInput,
  type DriverSendResult,
  type LaunchFiles,
  type MessageId,
  type MessageSource,
  type RateLimitInfo,
  type SessionExitReason,
  type SessionId,
  type WriteScope,
} from "../../shared/index.ts";
import type { VendorComposerBase } from "../../daemon/vendors/types.ts";
import { codexComposerBase } from "./composer.ts";
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
import {
  ZERO_CODEX_USAGE_COUNTS,
  buildCodexArgs,
  buildInitializeRequest,
  buildInitializedNotification,
  buildSkillsExtraRootsRequest,
  buildJsonRpcResponse,
  buildThreadResumeRequest,
  buildThreadStartRequest,
  buildTurnInterruptRequest,
  buildTurnStartRequest,
  buildTurnSteerRequest,
  checkCodexTurnText,
  codexOfSession,
  codexUserMessageText,
  combineCodexTurnText,
  decideCommandApproval,
  decideFileChangeApproval,
  decideMcpElicitation,
  exhaustCodexRateLimitOnTurnError,
  extractFileChangePaths,
  isCodexToolItemType,
  parseCodexRateLimits,
  parseCodexTokenUsage,
  parseCodexThreadTotal,
  parseCodexToolStarted,
  readCodexLaunchConfig,
  type CodexLaunchConfig,
  type CodexUsageCounts,
} from "./protocol.ts";
import { CODEX_RESUME_REBAKES, personaSeenAtStart } from "../../daemon/driver/persona-note.ts";
import { lineUuid } from "../../daemon/driver/protocol.ts";
import { spawnInWriteScope, type ScopedSpawn, type SpawnCommand } from "../../daemon/driver/write-scope.ts";
import { toolResultOutputs } from "../_common/tool-output.ts";

interface Batch extends BaseBatch {
  combinedText: string;
  midTurn: boolean;
  echoed: boolean;
  turnDone: boolean;
  stopped: boolean;
}

type SteerOutcome = "written" | "queued" | "cancelled";

interface Steer {
  batch: Batch;
  entry: PendingEntry;
  resolve: (outcome: SteerOutcome) => void;
}

type RpcPhase = "initialize" | "skills_extra_roots" | "thread_resume" | "thread_start" | "turn_start" | "turn_interrupt" | "turn_steer";

interface Proc extends BaseProc<StartupOutcome> {
  launchConfig: CodexLaunchConfig;
  defaultModel: string | null;
  readonly: boolean;
  writeScope: WriteScope | null;
  osSandboxed: boolean;
  // item/fileChange/requestApproval carries only itemId, so keep the paths from item/started.
  fileChangePaths: Map<string, string[]>;
  fileChangePreviewPaths: Map<string, string>;
  threadId: string | null;
  pendingRpcs: Map<number | string, RpcPhase>;
  steers: Map<number | string, Steer>;
}

interface SessionState extends BaseSessionState<Proc, Batch> {
  activeTurnId: string | null;
  turnSeq: number;
  interruptRequestId: number | string | null;
  usageThreadId: string | null;
  lastThreadTotal: CodexUsageCounts | null;
  turnUsageStepSeq: number;
  lastTurnResultUsage: CodexUsageCounts | null;
  lastTurnContext: number | null;
  agentMessageBuffers: Map<string, string>;
  emittedMessageIds: Set<string>;
  emittedThinkingIds: Set<string>;
}

export interface CodexDriverOptions extends Omit<DriverOptions, "executablePath"> {
  executablePath?: string | (() => string);
  // Without an explicit model codex uses config.toml's, which this account may lack (model_not_found).
  defaultModel?: () => Promise<string | null>;
  composer?: VendorComposerBase;
  platform?: NodeJS.Platform;
  writeScopeSpawn?: (base: SpawnCommand, scope: WriteScope | null) => ScopedSpawn;
}

export class CodexDriver extends BaseSessionDriver<Proc, Batch, SessionState> {
  readonly #codexPath: string | (() => string);
  readonly #platform: NodeJS.Platform;
  readonly #writeScopeSpawn?: (base: SpawnCommand, scope: WriteScope | null) => ScopedSpawn;
  readonly #defaultModel: () => Promise<string | null>;

  constructor({ executablePath, platform, writeScopeSpawn, defaultModel, composer, ...options }: CodexDriverOptions) {
    super("codex", { ...options, composer: composer ?? codexComposerBase });
    this.#defaultModel = defaultModel ?? (async () => null);
    this.#codexPath = executablePath ?? "codex";
    this.#platform = platform ?? process.platform;
    this.#writeScopeSpawn = writeScopeSpawn;
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
        const batch = this.#batchOf(st, entryParts(entry), ids, false, entry.source);
        batch.midTurn = true;
        const outcome = await this.#steer(st, proc, batch, entry);
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
        buildTurnSteerRequest(reqId, proc.threadId!, st.activeTurnId!, batch.combinedText) + "\n",
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
    return this.#batchOf(st, taken.body, taken.messageIds, taken.command, taken.source);
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
    return newBatch(messageIds, combineCodexTurnText(body.text, [...prefixes, ...body.prefixes]), notes, source);
  }

  protected async writeBatch(st: SessionState, proc: Proc, batch: Batch): Promise<void> {
    const problem = checkCodexTurnText(batch.combinedText);
    if (problem) {
      this.invalidInput(st, problem, batch.messageIds);
      this.afterTurn(st, proc);
      return;
    }
    const row = this.row(st);
    const threadId = proc.threadId ?? row?.vendorSessionId;
    if (!threadId) {
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
      combinedText: batch.combinedText,
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
          await this.writeBatch(st, proc, batch);
          return;
        }
        if (outcome.kind === "closed") {
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
    const wrapScope = launchConfig.readonly ? null : (files.writeScope ?? null);
    const exePath = this.#resolveCodexPath();
    const baseSpawn: SpawnCommand = { command: exePath, args: buildCodexArgs(files.capabilities) };
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
    const proc: Proc = {
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

  #openThread(st: SessionState, proc: Proc): void {
    const row = this.row(st);
    const sessionInfo = {
      vendorSessionId: row?.vendorSessionId ?? proc.threadId ?? "",
      cwd: row?.cwd ?? proc.launched.cwd,
      model: row?.model ?? proc.launched.model ?? proc.defaultModel,
    };
    const nextId = ++this.requestSeq;
    if (proc.resume) {
      proc.pendingRpcs.set(nextId, "thread_resume");
      proc.child.stdin.write(buildThreadResumeRequest(nextId, sessionInfo, proc.launchConfig) + "\n");
    } else {
      proc.pendingRpcs.set(nextId, "thread_start");
      proc.child.stdin.write(buildThreadStartRequest(nextId, sessionInfo, proc.launchConfig) + "\n");
    }
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
      this.#onServerRequest(st, proc, obj.id as number | string, obj.method as string, obj.params, at);
      return;
    }

    if (hasId && !hasMethod) {
      this.#onRpcResponse(st, proc, obj.id as number | string, obj, at);
      return;
    }

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
          this.forceKillProc(st, proc);
          return;
        }
        proc.child.stdin.write(buildInitializedNotification() + "\n");
        if (proc.launchConfig.skillRoots.length > 0) {
          const skillsId = ++this.requestSeq;
          proc.pendingRpcs.set(skillsId, "skills_extra_roots");
          proc.child.stdin.write(buildSkillsExtraRootsRequest(skillsId, proc.launchConfig.skillRoots) + "\n");
          return;
        }
        this.#openThread(st, proc);
        return;
      }

      case "skills_extra_roots": {
        // Older codex lacks skills/extraRoots/set; start without it.
        if (errorObj) {
          const message = typeof errorObj.message === "string" ? errorObj.message : JSON.stringify(errorObj);
          this.opts.log?.(`[codex] session ${st.id} skills/extraRoots/set 失败，任务图手册只能按路径读：${message}`);
        }
        this.#openThread(st, proc);
        return;
      }

      case "thread_resume": {
        if (errorObj) {
          // thread/resume fails when the rollout is missing; fall back to thread/start.
          proc.resume = false;
          proc.threadId = null;
          const row = this.row(st);
          const sessionInfo = {
            cwd: row?.cwd ?? proc.launched.cwd,
            model: row?.model ?? proc.launched.model ?? proc.defaultModel,
          };
          const startId = ++this.requestSeq;
          proc.pendingRpcs.set(startId, "thread_start");
          proc.child.stdin.write(buildThreadStartRequest(startId, sessionInfo, proc.launchConfig) + "\n");
          return;
        }
        const thread =
          typeof resultObj?.thread === "object" && resultObj.thread !== null
            ? (resultObj.thread as Record<string, unknown>)
            : null;
        const threadId = typeof thread?.id === "string" && thread.id !== "" ? thread.id : proc.threadId;
        const model =
          typeof thread?.model === "string" && thread.model !== ""
            ? thread.model
            : (this.row(st)?.model ?? proc.launched.model);
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
          this.forceKillProc(st, proc);
          return;
        }
        const thread =
          typeof resultObj?.thread === "object" && resultObj.thread !== null
            ? (resultObj.thread as Record<string, unknown>)
            : null;
        const threadId = typeof thread?.id === "string" && thread.id !== "" ? thread.id : proc.threadId;
        const model =
          typeof thread?.model === "string" && thread.model !== ""
            ? thread.model
            : (this.row(st)?.model ?? proc.launched.model);
        this.#completeThreadHandshake(st, proc, threadId, model, false, at);
        return;
      }

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
          return;
        }
        const turn =
          typeof resultObj?.turn === "object" && resultObj.turn !== null
            ? (resultObj.turn as Record<string, unknown>)
            : null;
        const turnId = typeof turn?.id === "string" && turn.id !== "" ? turn.id : null;
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

  #completeThreadHandshake(
    st: SessionState,
    proc: Proc,
    threadId: string | null,
    model: string | null,
    resumed: boolean,
    at: number,
  ): void {
    if (threadId) proc.threadId = threadId;
    if (proc.initSeen) return;
    proc.initSeen = true;
    proc.resume = resumed;
    if (!resumed) {
      st.usageThreadId = proc.threadId;
      st.lastThreadTotal = { ...ZERO_CODEX_USAGE_COUNTS };
    } else if (st.usageThreadId !== proc.threadId) {
      st.usageThreadId = proc.threadId;
      st.lastThreadTotal = null;
    }
    this.markHealthy(st.id);
    this.setPersonaSeen(st, personaSeenAtStart(st, this.row(st), proc.personaLaunched, !resumed || CODEX_RESUME_REBAKES));
    this.clearTimer(st, "startTimer");

    const patch: AgentSessionPatch = {
      status: "running",
      lastEventAt: at,
      ...(proc.threadId ? { vendorSessionId: proc.threadId } : {}),
    };
    const row = this.row(st);
    if (row && row.hasCompletedTurn !== resumed) patch.hasCompletedTurn = resumed;
    this.update(st, patch);
    this.emit(st.id, {
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
          this.update(st, { vendorSessionId: threadId });
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
        const opening = st.inFlight.find((b) => !b.midTurn);
        if (opening) {
          this.markProcessing(st, opening, at);
        } else if (!st.selfTurn && st.proc === proc) {
          st.selfTurn = true;
          st.turnSeq += 1;
          st.turnUsageStepSeq = 0;
          st.lastTurnResultUsage = null;
          st.lastTurnContext = null;
          this.clearTimer(st, "idleTimer");
          this.emit(st.id, { type: "turn.started", at });
        }
        return;
      }

      case "item/started": {
        const item =
          typeof params.item === "object" && params.item !== null
            ? (params.item as Record<string, unknown>)
            : null;
        if (!item) return;
        if (item.type === "userMessage") {
          this.#onUserMessage(st, item, at);
          return;
        }
        if (item.type === "reasoning") {
          const itemId = typeof item.id === "string" && item.id !== "" ? item.id : lineUuid(item, rawLine);
          this.#emitThinkingOnce(st, itemId, at);
          return;
        }
        if (item.type === "agentMessage") {
          const itemId = typeof item.id === "string" && item.id !== "" ? item.id : "agent-msg";
          if (!st.agentMessageBuffers.has(itemId)) st.agentMessageBuffers.set(itemId, "");
          return;
        }
        if (isCodexToolItemType(item.type)) {
          const rawId = typeof item.id === "string" && item.id !== "" ? item.id : null;
          if (item.type === "fileChange" && rawId) {
            const paths = extractFileChangePaths(item);
            proc.fileChangePaths.set(rawId, paths);
            if (paths[0] !== undefined) rememberPreviewPath(proc, rawId, paths[0]);
          }
          const toolEv = rawId ? parseCodexToolStarted(item, at, this.#scopedUuid(st, rawId)) : null;
          if (toolEv) this.emit(st.id, toolEv);
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
          const isFirstChunk = prev === "";
          st.agentMessageBuffers.set(itemId, prev + delta);
          this.emit(st.id, {
            type: "agent.text_delta",
            delta,
            ...(isFirstChunk ? { reset: true } : {}),
            at,
          });
        }
        return;
      }

      case "item/fileChange/patchUpdated": {
        // Streamed patch paths are partial; approvals must use the complete list from item/started.
        const itemId = typeof params.itemId === "string" && params.itemId !== "" ? params.itemId : null;
        if (!itemId || !Array.isArray(params.changes)) return;
        const firstPath = extractFileChangePaths({ changes: params.changes })[0];
        if (firstPath === undefined || proc.fileChangePreviewPaths.get(itemId) === firstPath) return;
        rememberPreviewPath(proc, itemId, firstPath);
        this.emit(st.id, {
          type: "agent.tool_preview",
          toolUseId: itemId,
          name: "fileChange",
          input: { file_path: firstPath },
          at,
        });
        return;
      }

      case "item/completed": {
        const item =
          typeof params.item === "object" && params.item !== null
            ? (params.item as Record<string, unknown>)
            : null;
        if (!item) return;
        if (item.type === "fileChange" && typeof item.id === "string") {
          proc.fileChangePaths.delete(item.id);
          proc.fileChangePreviewPaths.delete(item.id);
        }
        if (item.type === "agentMessage") {
          const itemId = typeof item.id === "string" && item.id !== "" ? item.id : "agent-msg";
          const buffered = st.agentMessageBuffers.get(itemId) ?? "";
          st.agentMessageBuffers.delete(itemId);
          const fullText = typeof item.text === "string" && item.text !== "" ? item.text : buffered;
          if (fullText.trim() !== "" && !st.emittedMessageIds.has(itemId)) {
            st.emittedMessageIds.add(itemId);
            this.emit(st.id, { type: "agent.text", uuid: this.#scopedUuid(st, itemId), text: fullText, at });
          }
          return;
        }
        if (isCodexToolItemType(item.type)) {
          const id = typeof item.id === "string" && item.id !== "" ? item.id : null;
          if (id) this.emit(st.id, { type: "agent.tool_result", toolUseIds: [id], ...toolResultOutputs(this.vendor, [[id, item]]), at });
        }
        return;
      }

      case "thread/tokenUsage/updated": {
        // After thread/resume, app-server replays the last token total under the previous turnId (codex-cli 0.167.1).
        if (typeof params.threadId === "string" && params.threadId !== "" && proc.threadId !== null && params.threadId !== proc.threadId) return;
        const notifTurnId = typeof params.turnId === "string" && params.turnId !== "" ? params.turnId : null;
        if (notifTurnId !== null ? notifTurnId !== st.activeTurnId : st.activeTurnId === null) {
          st.lastThreadTotal = parseCodexThreadTotal(params.tokenUsage) ?? st.lastThreadTotal;
          return;
        }
        const parsed = parseCodexTokenUsage(params.tokenUsage, st.activeTurnId, {
          lastThreadTotal: st.lastThreadTotal,
          turnResultUsage: st.lastTurnResultUsage,
          stepSeq: st.turnUsageStepSeq,
        });
        if (!parsed) return;
        st.lastThreadTotal = parsed.nextState.lastThreadTotal;
        st.lastTurnResultUsage = parsed.nextState.turnResultUsage;
        st.turnUsageStepSeq = parsed.nextState.stepSeq;
        if (parsed.duplicate) return;
        st.lastTurnContext = parsed.context;
        const row = this.row(st);
        const live = row ? st.turnUsage.observe(parsed.observeObj, row.usage) : null;
        if (live) this.pushUsage(st, { ...live, context: parsed.context });
        return;
      }

      case "account/rateLimits/updated": {
        const info = parseCodexRateLimits(params.rateLimits);
        if (!info) return;
        this.update(st, { rateLimit: info });
        this.emit(st.id, { type: "rate_limit", info, at });
        return;
      }

      case "turn/completed": {
        this.#onTurnCompleted(st, proc, params, at);
        return;
      }
    }
  }

  // userMessage items appear when codex consumes input, not when it is written.
  #onUserMessage(st: SessionState, item: Record<string, unknown>, at: number): void {
    const text = codexUserMessageText(item);
    const waiting = st.inFlight.filter((b) => !b.echoed);
    const batch = waiting.find((b) => b.combinedText === text) ?? waiting[0];
    if (!batch) return;
    batch.echoed = true;
    if (batch.midTurn) this.markProcessing(st, batch, at);
  }

  // codex can reuse item ids across turns and restarts.
  #scopedUuid(st: SessionState, itemId: string): string {
    const turnPrefix = st.activeTurnId ? `${st.activeTurnId}:${st.turnSeq}` : `turn-${st.turnSeq}`;
    return `${turnPrefix}:${itemId}`;
  }

  #emitThinkingOnce(st: SessionState, itemId: string, at: number): void {
    if (st.emittedThinkingIds.has(itemId)) return;
    st.emittedThinkingIds.add(itemId);
    this.emit(st.id, { type: "agent.thinking", uuid: this.#scopedUuid(st, itemId), at });
  }

  #onTurnCompleted(st: SessionState, proc: Proc, params: Record<string, unknown>, at: number): void {
    if (!proc.initSeen) return;

    for (const [itemId, bufferedText] of st.agentMessageBuffers.entries()) {
      if (bufferedText.trim() !== "" && !st.emittedMessageIds.has(itemId)) {
        st.emittedMessageIds.add(itemId);
        this.emit(st.id, { type: "agent.text", uuid: this.#scopedUuid(st, itemId), text: bufferedText, at });
      }
    }
    st.agentMessageBuffers.clear();
    st.emittedMessageIds.clear();
    st.emittedThinkingIds.clear();
    proc.fileChangePaths.clear();
    proc.fileChangePreviewPaths.clear();

    const settled = st.inFlight.filter((b) => !b.midTurn || b.echoed);
    const missed = st.inFlight.filter((b) => b.midTurn && !b.echoed && b.delivered);
    const unacked = st.inFlight.filter((b) => b.midTurn && !b.echoed && !b.delivered);
    st.inFlight = unacked;
    st.selfTurn = false;
    st.activeTurnId = null;
    for (const batch of settled) this.markProcessing(st, batch, at);

    const turn =
      typeof params.turn === "object" && params.turn !== null
        ? (params.turn as Record<string, unknown>)
        : {};
    const status = typeof turn.status === "string" ? turn.status : "completed";
    const ok = status === "completed";
    const interrupted = status === "interrupted" || st.turnInterrupted || st.stopRequested;
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
    const row = this.row(st);
    let exhaustedRateLimit: RateLimitInfo | null = null;
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
      exhaustedRateLimit = exhaustCodexRateLimitOnTurnError(row?.rateLimit ?? null, turnErr ?? errMsg);
      this.forgetWritten(st, settled);
    } else {
      this.markHealthy(st.id);
    }

    st.turnInterrupted = false;
    st.stopRequested = false;

    this.cancelUsagePush(st);
    const patch: AgentSessionPatch = {};
    if (st.lastTurnResultUsage) {
      const finished = st.turnUsage.finish(row?.usage ?? EMPTY_TOKEN_USAGE, st.lastTurnResultUsage);
      if (st.lastTurnContext !== null) finished.context = st.lastTurnContext;
      patch.usage = finished;
      st.lastTurnResultUsage = null;
      st.lastTurnContext = null;
      st.turnUsageStepSeq = 0;
    } else {
      st.turnUsage.reset();
      st.lastTurnContext = null;
      st.turnUsageStepSeq = 0;
    }
    if (row?.hasCompletedTurn === false) patch.hasCompletedTurn = true;
    if (exhaustedRateLimit !== null) patch.rateLimit = exhaustedRateLimit;
    if (Object.keys(patch).length > 0) this.update(st, patch);
    if (exhaustedRateLimit !== null) {
      this.emit(st.id, { type: "rate_limit", info: exhaustedRateLimit, at });
    }

    this.clearTimer(st, "interruptTimer");
    this.emit(st.id, event);
    this.releaseUntaken(st, missed, interrupted, at);
    this.resolveInterrupt(st);
    this.afterTurn(st, proc);
    this.settled(st);
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
    const row = this.row(st);
    const context = {
      readonly: proc.readonly,
      writeScope: proc.writeScope,
      cwd: row?.cwd ?? proc.launched.cwd,
    };

    switch (method) {
      case "item/commandExecution/requestApproval": {
        const decision = decideCommandApproval(params, context);
        proc.child.stdin.write(buildJsonRpcResponse(id, { decision }) + "\n");
        return;
      }
      case "item/fileChange/requestApproval": {
        const itemId = typeof params.itemId === "string" ? params.itemId : "";
        const decision = decideFileChangeApproval(
          { ...params, paths: [...extractFileChangePaths(params), ...(proc.fileChangePaths.get(itemId) ?? [])] },
          context,
        );
        proc.child.stdin.write(buildJsonRpcResponse(id, { decision }) + "\n");
        return;
      }
      case "mcpServer/elicitation/request": {
        const answer = decideMcpElicitation(params, {
          readonly: proc.readonly,
          policy: proc.launchConfig.readonlyPolicy,
        });
        proc.child.stdin.write(buildJsonRpcResponse(id, answer) + "\n");
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

  protected onProcessClose(
    st: SessionState,
    proc: Proc,
    code: number | null,
    signal: NodeJS.Signals | null,
    resolveExited: () => void,
  ): void {
    try {
      const at = this.beginProcessClose(st, proc);
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
      this.releaseUntaken(st, missed, stopped, at);
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

function newBatch(
  messageIds: MessageId[],
  combinedText: string,
  notes: BatchNotes,
  source: MessageSource,
): Batch {
  return {
    messageIds,
    combinedText,
    notes,
    delivered: false,
    processing: false,
    midTurn: false,
    echoed: false,
    turnDone: false,
    stopped: false,
    source,
  };
}

function startupError(outcome: Extract<StartupOutcome, { kind: "failed" }>, startTimeoutMs: number): DriverError {
  if (outcome.timedOut) return new DriverError("start_timeout", `no codex thread ready within ${startTimeoutMs} ms`);
  const how = outcome.signal ? `signal ${outcome.signal}` : `exit code ${outcome.exitCode}`;
  const detail = outcome.errorMessage ?? outcome.stderr.trim();
  return new DriverError("spawn_failed", `codex exited before thread ready (${how})${detail ? `: ${detail}` : ""}`);
}

function rememberPreviewPath(proc: Proc, itemId: string, path: string): void {
  const paths = proc.fileChangePreviewPaths;
  if (!paths.has(itemId) && paths.size >= MAX_STREAMING_TOOL_BLOCKS) {
    const oldest = paths.keys().next().value;
    if (oldest !== undefined) paths.delete(oldest);
  }
  paths.set(itemId, path);
}
