import { untakenReleaseCause } from "../../daemon/driver/stop-untaken.ts";
import { armPostAckInterruptEscalation } from "../../daemon/driver/stop-coordination.ts";
import { claudeChecklistFromToolResult, claudeChecklistFromToolUse, createClaudeChecklistState } from "./checklist.ts";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
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
  type PendingEntry,
} from "../../daemon/driver/base-driver.ts";
import { ClaudeReadonlyGate } from "./readonly.ts";
import {
  midTurnCapable,
  newBatch,
  resultMessage,
  startupError,
  type Batch,
  type ClaudeStartupOutcome,
  type MidTurnWrite,
  type Proc,
  type SessionState,
} from "./driver-state.ts";
import { ensureClaudeSkillPlugin } from "./skills.ts";
import { personaSeenAtStart } from "../../daemon/driver/persona-note.ts";
import {
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
  parseStreamEvent,
  parseToolResults,
} from "./protocol.ts";
import { StreamingToolPreviewTracker, lineUuid } from "../../daemon/driver/protocol.ts";
import {
  WORKER_NEEDS_OS_SANDBOX_MESSAGE,
  scanSecretGlobs,
  spawnInWriteScope,
  wrapInReadonlyOsSandbox,
  type ReadonlySandboxInput,
  type ScopedSpawn,
  type SpawnCommand,
} from "../../daemon/driver/write-scope.ts";

export interface ClaudeDriverOptions extends DriverOptions {
  composer?: VendorComposerBase;
  readonlySpawn?: (base: SpawnCommand, input: ReadonlySandboxInput) => ScopedSpawn;
  platform?: NodeJS.Platform;
}

export class ClaudeDriver extends BaseSessionDriver<Proc, Batch, SessionState> {
  readonly #claudePath: string | (() => string);
  readonly #readonlySpawn?: (base: SpawnCommand, input: ReadonlySandboxInput) => ScopedSpawn;
  readonly #platform: NodeJS.Platform;

  constructor(options: ClaudeDriverOptions) {
    super("claude", { ...options, composer: options.composer ?? claudeComposerBase });
    this.#claudePath = options.executablePath;
    this.#readonlySpawn = options.readonlySpawn;
    this.#platform = options.platform ?? process.platform;
  }

  #resolveClaudePath(): string {
    return typeof this.#claudePath === "function" ? this.#claudePath() : this.#claudePath;
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
      ...(input.rider ? { rider: true } : {}),
    };
    const parts = entryParts(entry);
    const problem = checkUserLine(buildUserLine(parts.text, parts.prefixes, this.composer.buildUserContent));
    if (problem) {
      this.invalidInput(st, problem, ids);
      return { kind: "rejected" };
    }
    if (!this.isPending(st, ids)) {
      if (input.recovery) st.recoveryNote = true;
      const proc = st.proc;
      if (proc && this.#canWriteMidTurn(st, proc, entry)) {
        const outcome = await this.steerWithCurrentCapabilities(st, proc, entry, () => this.#canWriteMidTurn(st, proc, entry), async () => {
          const batch = this.#batchOf(st, entryParts(entry), ids, false, entry.source);
          batch.midTurn = true;
          const result = await this.#writeMidTurn(st, proc, batch);
          if (result === "retry") {
            this.dropBatch(st, batch);
            if (!st.ended) st.pending.unshift(entry);
          }
          return result;
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

  // Commands are excluded: local commands mid-turn are untested and drop prefix blocks (#76).
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

  #lineForWrite(st: SessionState, batch: Batch): string {
    return batch.renderLine?.((text) => this.withDeliverySuffix(st, batch, text)) ?? batch.line;
  }

  async #writeMidTurn(st: SessionState, proc: Proc, batch: Batch): Promise<MidTurnWrite> {
    st.inFlight.push(batch);
    this.clearTimer(st, "idleTimer");
    return new Promise<MidTurnWrite>((resolve) => {
      proc.child.stdin.write(this.#lineForWrite(st, batch) + "\n", (err) => {
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

  // @internal Test-only: write a raw line after validation; the session must be up and idle.
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

  protected override markMidTurnBatchesStopped(st: SessionState): void {
    for (const batch of st.inFlight) if (batch.midTurn && !batch.delivered) batch.stopped = true;
  }

  protected override sendInterrupt(st: SessionState, proc: Proc): void {
    if (st.interruptRequestId !== null) return;
    const requestId = `interrupt-${++this.requestSeq}`;
    st.interruptRequestId = requestId;
    proc.child.stdin.write(buildInterruptLine(requestId, proc.capabilities.has("interrupt_cancel_queued_v1")) + "\n");
    st.interruptTimer = setTimeout(() => {
      st.interruptTimer = null;
      this.sigintForInterrupt(st, proc);
    }, this.opts.interruptGraceMs);
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
    const uuid = randomUUID();
    if (command) {
      return newBatch(messageIds, buildUserLine(body.text, body.prefixes, this.composer.buildUserContent, uuid), uuid, NO_NOTES, source);
    }
    const { notes, prefixes } = this.takeNotesPrefixes(st, { turnBody: body });
    const buildLine = (transform: (original: string) => string) =>
      buildUserLine(transform(body.text), [...prefixes, ...body.prefixes], this.composer.buildUserContent, uuid);
    return { ...newBatch(messageIds, buildLine((text) => text), uuid, notes, source), renderLine: buildLine };
  }

  protected async writeBatch(st: SessionState, proc: Proc, batch: Batch): Promise<void> {
    if (this.discardStaleSystemBatch(st, proc, batch)) return;
    if (this.consumeStoppedBatch(st, batch, proc)) return;
    const line = this.#lineForWrite(st, batch);
    const problem = checkUserLine(line);
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
      proc.child.stdin.write(line + "\n", (err) => {
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
    const run = async () => {
      let proc = existing;
      try {
        let resume = proc?.resume ?? this.resumeFor(st);
        for (let attempt = 0; ; attempt++) {
          if (!proc) {
            const resolved = files ?? (await this.resolveLaunchFiles(st, null)).files;
            if (this.consumeStoppedBatch(st, batch)) return;
            proc = await this.#spawn(st, resume, resolved);
          }
          this.abortIfStopped(st, proc);
          if (this.consumeStoppedBatch(st, batch, proc)) return;
          if (this.discardStaleSystemBatch(st, proc, batch)) return;
          this.clearTimer(st, "idleTimer");
          st.inFlight = [batch];
          st.turnInterrupted = false;
          st.stopRequested = false;
          const line = this.#lineForWrite(st, batch);
          const problem = checkUserLine(line);
          if (problem) {
            this.dropBatch(st, batch);
            this.invalidInput(st, problem, batch.messageIds);
            this.afterTurn(st, proc);
            return;
          }
          proc.child.stdin.write(line + "\n");
          this.armStartTimer(st, proc);
          const outcome = await proc.ready;
          if (outcome.kind === "ok") return;
          if (outcome.kind === "closed") {
            if (st.ended) throw new DriverError("session_ended", `session ${st.id} has been ended`);
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
    if (files.skillsDir) ensureClaudeSkillPlugin(files.skillsDir);
    const claudeArgs = buildClaudeArgs(row, files, resume);
    let launch: ScopedSpawn;
    let childEnv: Record<string, string> = { ...files.env };

    if (files.readonly && this.#platform === "win32") {
      const realOrSelf = (p: string) => {
        try {
          return realpathSync(p);
        } catch {
          return p;
        }
      };
      const privateTmp = realOrSelf(files.tmpDir);
      const home = realOrSelf(homedir());
      const claudeDirs = [join(home, ".claude"), join(home, ".cache"), join(home, ".npm")].filter((d) => existsSync(d)).map(realOrSelf);
      const roProtectedRoots = files.writeScope?.protectedRoots ?? files.readonly.protectedRoots;
      const roInput: ReadonlySandboxInput = {
        tmpDir: privateTmp,
        ...(files.readonly.stateDir ? { stateDir: files.readonly.stateDir } : {}),
        ...(roProtectedRoots ? { protectedRoots: roProtectedRoots } : {}),
        writableDirs: claudeDirs,
        writableFileRegexes: [],
        secretPaths: [
          ...new Set([
            ...files.readonly.secretPaths.map(realOrSelf),
            ...(await scanSecretGlobs([row.cwd, ...row.addDirs], files.readonly.secretGlobs)),
          ]),
        ],
        secretGlobs: [...files.readonly.secretGlobs],
        ...(files.readonly.dataDirScope ? { dataDirScope: files.readonly.dataDirScope } : {}),
      };
      const wrap = this.#readonlySpawn ?? ((base, input) => wrapInReadonlyOsSandbox(base, input, this.#platform));
      const exePath = this.#resolveClaudePath();
      launch = wrap({ command: exePath, args: claudeArgs }, roInput);
      if (!launch.osSandboxed) {
        throw new DriverError("spawn_failed", WORKER_NEEDS_OS_SANDBOX_MESSAGE);
      }
      if (launch.readonlyFallbackWarning) {
        this.log(launch.readonlyFallbackWarning);
        this.emit(st.id, {
          type: "driver.warning",
          uuid: randomUUID(),
          message: launch.readonlyFallbackWarning,
          at: Date.now(),
        });
      }
      childEnv = { ...childEnv, TMPDIR: privateTmp, TEMP: privateTmp, TMP: privateTmp };
    } else {
      const exePath = this.#resolveClaudePath();
      launch = spawnInWriteScope(
        "claude",
        { command: exePath, args: claudeArgs },
        files.writeScope ?? null,
        this.opts.log,
        `session ${st.id}`,
        this.#platform,
      );
    }
    this.assertRunning();
    this.assertNotEnded(st);
    const child = await this.spawnDetachedChild(
      this.#resolveClaudePath(),
      launch.command,
      launch.args,
      row.cwd,
      childEnv,
    );
    const { baseProc, resolveExited } = this.createBaseProc<ClaudeStartupOutcome>(child, resume, row, files);
    const proc: Proc = {
      ...baseProc,
      readonlyGate: files.readonly
        ? new ClaudeReadonlyGate(files.readonly, (line) => child.stdin.write(line + "\n"))
        : null,
      capabilities: new Set(),
      toolPreviews: new StreamingToolPreviewTracker(),
      checklist: createClaudeChecklistState(),
    };
    this.attachChildProcess(st, proc, resolveExited, () => {
      proc.readonlyGate?.dispose();
      proc.toolPreviews.clear();
    });
    return proc;
  }

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
          if (result) {
            if (result.parentToolUseId === undefined) {
              const toolUseResult = result.toolUseIds.length === 1 ? obj.tool_use_result : undefined;
              for (const toolUseId of result.toolUseIds) {
                const update = claudeChecklistFromToolResult(proc.checklist, toolUseId, toolUseResult);
                if (update) this.emit(st.id, { type: "agent.checklist", uuid: `${lineUuid(obj, line)}:${toolUseId}`, update, at });
              }
            }
            this.emit(st.id, result);
          }
        }
        return;
      case "stream_event": {
        const delta = parseStreamEvent(obj, at, proc.toolPreviews);
        if (delta) this.emit(st.id, delta);
        return;
      }
      case "assistant": {
        // claude emits one assistant event per content block, possibly between streamed tool args or from subagents; do not clear toolPreviews here.
        const row = this.row(st);
        const live = row ? st.turnUsage.observe(obj, row.usage) : null;
        if (live) this.pushUsage(st, live);
        for (const ev of parseAssistant(obj, line, at)) {
          if (ev.type === "agent.tool" && ev.parentToolUseId === undefined) {
            const update = claudeChecklistFromToolUse(proc.checklist, ev);
            if (update) this.emit(st.id, { type: "agent.checklist", uuid: `${ev.uuid}:${ev.toolUseId}`, update, at });
          }
          this.emit(st.id, ev);
        }
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
          // Wait for command_lifecycle(cancelled) when receiptWithoutCancelled omits cancelled uuids for unstarted batches.
          const awaitingUnstartedCancel =
            proc.capabilities.has("msg_lifecycle_v1") &&
            !st.selfTurn &&
            st.inFlight.length > 0 &&
            st.inFlight.every((b) => !b.started);
          if (this.busy(st)) {
            armPostAckInterruptEscalation(
              st,
              proc,
              this.opts.interruptPostAckGraceMs,
              (s, p) => this.sigintForInterrupt(s, p),
              (s) => this.busy(s) && s.stopRequested,
            );
          }
          if (!awaitingUnstartedCancel) this.resolveInterrupt(st);
        } else this.sigintForInterrupt(st, proc);
        return;
      }
      case "result":
        proc.checklist.pending.clear();
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
      const midTurn = batch.midTurn && (st.selfTurn || st.inFlight.some((other) => other !== batch && other.started));
      batch.started = true;
      if (proc.initSeen) this.markProcessing(st, batch, at, midTurn);
    } else if (event.state === "cancelled" && !batch.started) {
      this.#cancelBatches(st, proc, [batch], at);
    }
  }

  #cancelBatches(st: SessionState, proc: Proc, batches: Batch[], at: number): void {
    if (batches.length === 0) return;
    st.inFlight = st.inFlight.filter((b) => !batches.includes(b));
    this.releaseUntaken(st, batches, untakenReleaseCause(proc.closing, true), at);
    if (!this.busy(st)) {
      this.clearTimer(st, "interruptTimer");
      st.stopRequested = false;
      st.turnInterrupted = false;
      this.resolveInterrupt(st);
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
    proc.toolPreviews.clear();
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
      this.releaseUntaken(st, untaken, cause, at);
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
