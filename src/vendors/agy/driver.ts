import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import {
  DriverError,
  type AgentSessionPatch,
  type AgentSessionRow,
  type DriverOptions,
  type DriverSendInput,
  type DriverSendResult,
  type LaunchFiles,
  type MessageId,
  type ReadonlyPolicy,
  type SessionExitReason,
  type SessionId,
} from "../../shared/index.ts";
import type { VendorComposerBase } from "../../daemon/vendors/types.ts";
import { agyComposerBase } from "./composer.ts";
import { createAgyConnectorResolver, createReadonlyProbeLauncher } from "./connectors.ts";
import {
  agyOfSession,
  buildAgyArgs,
  buildAgySessionStartedEvent,
  buildAgyUserLine,
  checkAgyUserLine,
  detectAgyArgsConflict,
} from "./protocol.ts";
import { agyRuleBudgetWarning, writeAgyPromptRules } from "./rules.ts";
import {
  NO_NOTES,
  createBaseSessionState,
  entryParts,
  errorMessage,
  type PendingEntry,
} from "../../daemon/driver/base-driver.ts";
import { personaSeenAtStart } from "../../daemon/driver/persona-note.ts";
import {
  EMPTY_AGY_CONNECTOR_CATALOG,
  READONLY_AGY_NEEDS_SANDBOX_MESSAGE,
  agyConnectorRules,
  agyReadonlySandboxInput,
  type AgyConnectorCatalog,
} from "./readonly.ts";
import {
  scanSecretGlobs,
  spawnInWriteScope,
  wrapInReadonlyOsSandbox,
  type ReadonlySandboxInput,
  type ScopedSpawn,
  type SpawnCommand,
} from "../../daemon/driver/write-scope.ts";
import { VendorSessionDriver } from "../_common/session-driver.ts";
import {
  clearStepTracking,
  extractAgyBackgroundTasks,
  startupError,
  type AgyDriverHost,
  type AgyStartupOutcome,
  type Batch,
  type Proc,
  type SessionState,
} from "./driver-state.ts";
import { onResult } from "./result.ts";
import { onReportedBackgroundTasks, onStepUpdate } from "./steps.ts";

export interface AgyDriverOptions extends Omit<DriverOptions, "executablePath"> {
  executablePath?: string | (() => string);
  composer?: VendorComposerBase;
  homeDir?: string;
  connectorCatalog?: () => Promise<AgyConnectorCatalog>;
  readonlySpawn?: (base: SpawnCommand, input: ReadonlySandboxInput) => ScopedSpawn;
}

export class AgyDriver extends VendorSessionDriver<Proc, Batch, SessionState> {
  readonly #agyPath: string | (() => string);
  readonly #homeDir?: string;
  readonly #customCatalog?: () => Promise<AgyConnectorCatalog>;
  readonly #readonlySpawn?: (base: SpawnCommand, input: ReadonlySandboxInput) => ScopedSpawn;
  #connectorCatalog: (() => Promise<AgyConnectorCatalog>) | null = null;
  #latestReadonlyPolicy: ReadonlyPolicy | null = null;
  readonly #host: AgyDriverHost;

  constructor(options: AgyDriverOptions) {
    super("agy", { ...options, composer: options.composer ?? agyComposerBase });
    this.#agyPath = options.executablePath ?? "agy";
    this.#homeDir = options.homeDir;
    this.#customCatalog = options.connectorCatalog;
    this.#readonlySpawn = options.readonlySpawn;
    this.#host = this.createHost();
  }

  #resolveAgyPath(): string {
    return typeof this.#agyPath === "function" ? this.#agyPath() : this.#agyPath;
  }

  protected createSessionState(id: SessionId): SessionState {
    return {
      ...createBaseSessionState<Proc, Batch>(id),
      policyViolation: null,
      deniedContinues: 0,
      hasConversation: false,
      vendorSessionId: "",
      stepTexts: new Map(),
      seenToolSteps: new Set(),
      previewedToolSteps: new Map(),
      completedToolSteps: new Set(),
      reportedTasks: new Map(),
      activeToolSteps: new Map(),
      seenThinkingSteps: new Set(),
      hasTextSinceLastTool: false,
      resultSeq: 0,
      eventSeq: 0,
      lastLiveUsage: null,
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
    const problem = checkAgyUserLine(buildAgyUserLine(parts.text, parts.prefixes, this.composer.buildUserContent));
    if (problem) {
      this.invalidInput(st, problem, ids);
      return { kind: "rejected" };
    }
    if (!this.isPending(st, ids)) {
      st.pending.push(entry);
      if (input.recovery) st.recoveryNote = true;
    }
    await this.pump(st);
    return ids.every((id) => st.written.has(id)) ? { kind: "written" } : { kind: "queued" };
  }

  // @internal Test-only: write a raw line after validation; the session must be up and idle.
  async writeUserLine(sessionId: SessionId, line: string, messageIds: MessageId[]): Promise<DriverSendResult> {
    const st = this.state(sessionId);
    const problem = checkAgyUserLine(line);
    if (problem) {
      this.invalidInput(st, problem, messageIds);
      return { kind: "rejected" };
    }
    const proc = st.proc;
    if (!proc || !proc.initSeen || proc.closing || st.inFlight.length > 0) {
      throw new Error(`session ${sessionId} is not idle`);
    }
    await this.writeBatch(st, proc, {
      messageIds,
      text: "",
      prefixes: [],
      rawLine: line,
      notes: NO_NOTES,
      delivered: false,
      processing: false,
      source: "user",
    });
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
    st.turnInterrupted = true;
    const done = new Promise<void>((resolve) => st.interruptWaiters.push(resolve));
    if (st.interruptTimer === null) {
      this.sigintForInterrupt(st, proc, "interruptTimer");
    }
    return done;
  }

  protected override filterStaleRow(row: AgentSessionRow): boolean {
    return row.vendor === "agy";
  }

  protected identifyStaleProcess(pid: number, row: AgentSessionRow): Promise<number | null> {
    return agyOfSession(pid, row.vendorSessionId);
  }

  protected takeBatch(st: SessionState): Batch | null {
    const taken = this.takePendingEntryBatch(st);
    if (!taken) return null;
    if (taken.command) {
      return {
        messageIds: taken.messageIds,
        text: taken.body.text,
        prefixes: taken.body.prefixes,
        notes: NO_NOTES,
        delivered: false,
        processing: false,
        source: "user",
      };
    }
    const proc = st.proc && !st.proc.closing ? st.proc : null;
    const { notes, prefixes } = this.takeNotesPrefixes(st, {
      takePersona: proc !== null,
      fromRowOnFirstPersonaCheck: false,
    });
    return {
      messageIds: taken.messageIds,
      text: taken.body.text,
      prefixes: [...prefixes, ...taken.body.prefixes],
      notes,
      delivered: false,
      processing: false,
      source: taken.source,
    };
  }

  #buildLineForProc(batch: Batch): string {
    if (batch.rawLine !== undefined) return batch.rawLine;
    return buildAgyUserLine(batch.text, batch.prefixes, this.composer.buildUserContent);
  }

  protected async writeBatch(st: SessionState, proc: Proc, batch: Batch): Promise<void> {
    const line = this.#buildLineForProc(batch);
    const problem = checkAgyUserLine(line);
    if (problem) {
      this.invalidInput(st, problem, batch.messageIds);
      this.afterTurn(st, proc);
      return;
    }
    this.clearTimer(st, "idleTimer");
    this.#resetTurnState(st, batch);
    await new Promise<void>((resolve) => {
      proc.child.stdin.write(line + "\n", (err) => {
        if (!err) this.markDelivered(st, batch);
        resolve();
      });
    });
  }

  #resetTurnState(st: SessionState, batch: Batch | null): void {
    st.inFlight = batch ? [batch] : [];
    st.turnInterrupted = false;
    st.stopRequested = false;
    st.policyViolation = null;
    st.deniedContinues = 0;
    clearStepTracking(st);
    st.lastLiveUsage = null;
  }

  protected resumeFor(st: SessionState): boolean {
    if (st.resumeHint !== null) return st.resumeHint;
    const row = this.store(st);
    return (st.hasConversation || row.hasCompletedTurn) && row.vendorSessionId.trim() !== "";
  }

  protected spawnIdleProcess(st: SessionState, resume: boolean): Promise<Proc> {
    return this.#spawn(st, resume, null);
  }

  protected startup(st: SessionState, batch: Batch, existing: Proc | null, files: LaunchFiles | null): Promise<void> {
    this.#resetTurnState(st, batch);
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
          const line = this.#buildLineForProc(batch);
          proc.child.stdin.write(line + "\n");
          this.armStartTimer(st, proc);
          const outcome = await proc.ready;
          if (outcome.kind === "ok") return;
          if (outcome.kind === "closed") {
            if (outcome.reason === "interrupt") return;
            throw new DriverError(
              "spawn_failed",
              this.shuttingDown ? "driver is shutting down" : `closed before init (${outcome.reason})`,
            );
          }
          proc = null;
          if (outcome.conflict === "no_conversation" && resume && attempt === 0 && !outcome.timedOut) {
            resume = false;
            st.hasConversation = false;
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

  async #catalogFor(policy: ReadonlyPolicy): Promise<AgyConnectorCatalog> {
    const homeDir = this.#homeDir ?? homedir();
    const wrap = this.#readonlySpawn ?? ((base, input) => wrapInReadonlyOsSandbox(base, input));
    this.#latestReadonlyPolicy = policy;
    this.#connectorCatalog ??=
      this.#customCatalog ??
      createAgyConnectorResolver({
        homeDir,
        launcher: (base, extraEnv) =>
          createReadonlyProbeLauncher({
            policy: this.#latestReadonlyPolicy ?? policy,
            homeDir,
            baseEnv: process.env,
            extraEnv: typeof this.opts.env === "function" ? this.opts.env() : this.opts.env,
            wrap,
          })(base, extraEnv),
      });
    try {
      return await this.#connectorCatalog();
    } catch (error) {
      this.log(`[agy] 问连接器清单失败，只读 Worker 靠兜底检查拦非只读的连接器：${errorMessage(error)}`);
      return EMPTY_AGY_CONNECTOR_CATALOG;
    }
  }

  async #spawn(st: SessionState, resume: boolean, prepared: LaunchFiles | null): Promise<Proc> {
    const { row, files } = await this.resolveLaunchFiles(st, prepared);
    // Rules under an --add-dir land in agy's <user_rules> system prompt section and survive compaction.
    const promptRulesDir = writeAgyPromptRules(files.promptFile, files.skillsDir);
    let warning: string | null;
    try {
      warning = agyRuleBudgetWarning(this.#homeDir ?? homedir(), [row.cwd, ...row.addDirs, ...(promptRulesDir === null ? [] : [promptRulesDir])]);
    } catch (error) {
      warning = `agy 规则预算检查失败：${errorMessage(error)}。无法确认规则是否会被截断。`;
    }
    if (warning !== null) this.emit(st.id, { type: "driver.warning", uuid: crypto.randomUUID(), message: warning, at: Date.now() });

    const readonlyPolicy: ReadonlyPolicy | undefined =
      files.readonly === undefined
        ? undefined
        : {
            ...files.readonly,
            secretPaths: [
              ...new Set([
                ...files.readonly.secretPaths,
                ...(await scanSecretGlobs([row.cwd, ...row.addDirs], files.readonly.secretGlobs)),
              ]),
            ],
          };
    const effectiveFiles: LaunchFiles = readonlyPolicy === undefined ? files : { ...files, readonly: readonlyPolicy };
    const catalog = readonlyPolicy === undefined ? null : await this.#catalogFor(readonlyPolicy);
    const args = buildAgyArgs(
      row,
      effectiveFiles,
      resume,
      readonlyPolicy === undefined || catalog === null ? undefined : agyConnectorRules(readonlyPolicy, catalog),
      promptRulesDir,
    );
    let tmpDir: string | null = null;
    let launch: ScopedSpawn;
    let childEnv: Record<string, string> = { ...files.env };
    const exePath = this.#resolveAgyPath();
    if (readonlyPolicy === undefined) {
      launch = spawnInWriteScope("agy", { command: exePath, args }, files.writeScope ?? null, this.opts.log, `session ${st.id}`);
    } else {
      if (!files.tmpDir) {
        throw new DriverError("spawn_failed", "readonly launch missing session tmpDir");
      }
      const home = realpathSync(this.#homeDir ?? homedir());
      const wrap = this.#readonlySpawn ?? ((base, input) => wrapInReadonlyOsSandbox(base, input));
      const privateTmp = realpathSync(files.tmpDir);
      launch = wrap(
        { command: exePath, args },
        agyReadonlySandboxInput({ homeDir: home, tmpDir: privateTmp, policy: readonlyPolicy }),
      );
      if (!launch.osSandboxed) {
        throw new DriverError("spawn_failed", READONLY_AGY_NEEDS_SANDBOX_MESSAGE);
      }
      if (launch.readonlyFallbackWarning) {
        this.log(launch.readonlyFallbackWarning);
        this.emit(st.id, {
          type: "driver.warning",
          uuid: crypto.randomUUID(),
          message: launch.readonlyFallbackWarning,
          at: Date.now(),
        });
      }
      tmpDir = privateTmp;
      childEnv = {
        ...childEnv,
        TMPDIR: privateTmp,
        ...(process.platform === "win32" ? { TEMP: privateTmp, TMP: privateTmp } : {}),
      };
    }
    const child = await this.spawnDetachedChild(
      exePath,
      launch.command,
      launch.args,
      row.cwd,
      childEnv,
    );
    const { baseProc, resolveExited } = this.createBaseProc<AgyStartupOutcome>(child, resume, row, files);
    const proc: Proc = {
      ...baseProc,
      readonly: readonlyPolicy === undefined || catalog === null ? null : { policy: readonlyPolicy, catalog },
      tmpDir,
      fallbackScope: readonlyPolicy === undefined && !launch.osSandboxed ? (files.writeScope ?? null) : null,
    };
    st.reportedTasks.clear();
    st.activeToolSteps.clear();
    this.attachChildProcess(st, proc, resolveExited);
    return proc;
  }

  protected onParsedLine(
    st: SessionState,
    proc: Proc,
    obj: Record<string, unknown>,
    _rawLine: string,
    at: number,
  ): void {
    const eventType = obj.event ?? obj.type;
    switch (eventType) {
      case "init":
        this.#onInit(st, proc, obj, at);
        return;
      case "step_update":
        onStepUpdate(this.#host, st, proc, obj, at);
        return;
      case "background_tasks_changed":
        onReportedBackgroundTasks(this.#host, st, proc, extractAgyBackgroundTasks(obj));
        return;
      case "system":
        if (obj.subtype === "background_tasks_changed") {
          onReportedBackgroundTasks(this.#host, st, proc, extractAgyBackgroundTasks(obj));
        }
        return;
      case "result":
        onResult(this.#host, st, proc, obj, at);
        return;
    }
  }

  #onInit(st: SessionState, proc: Proc, obj: Record<string, unknown>, at: number): void {
    const initObj =
      typeof obj.init === "object" && obj.init !== null ? (obj.init as Record<string, unknown>) : undefined;
    const rawConvId = initObj?.conversation_id ?? obj.conversation_id;
    const convId = typeof rawConvId === "string" && rawConvId.trim() !== "" ? rawConvId.trim() : "";
    if (proc.initSeen) {
      if (convId !== "" && convId !== st.vendorSessionId) {
        st.vendorSessionId = convId;
        st.hasConversation = true;
        this.update(st, { vendorSessionId: convId, lastEventAt: at });
      }
      if (st.inFlight.length === 0 && !st.selfTurn && st.proc === proc) {
        st.selfTurn = true;
        this.clearTimer(st, "idleTimer");
        this.emit(st.id, { type: "turn.started", at });
      }
      return;
    }
    proc.initSeen = true;
    this.markHealthy(st.id);
    this.clearTimer(st, "startTimer");
    const row = this.row(st);
    this.setPersonaSeen(st, personaSeenAtStart(st, row, proc.personaLaunched, true));
    const patch: AgentSessionPatch = { status: "running", lastEventAt: at };
    if (convId !== "") {
      patch.vendorSessionId = convId;
      st.vendorSessionId = convId;
      st.hasConversation = true;
    } else if (row?.vendorSessionId) {
      st.vendorSessionId = row.vendorSessionId;
    }
    if (row && row.hasCompletedTurn !== proc.resume) patch.hasCompletedTurn = proc.resume;
    st.resumeHint = null;
    this.update(st, patch);
    const startedEvent = buildAgySessionStartedEvent(obj, this.row(st) ?? row, proc.resume, at);
    this.emit(st.id, startedEvent);
    const first = st.inFlight[0];
    if (first) this.markDelivered(st, first);
    proc.resolveReady({ kind: "ok" });
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
      st.lastLiveUsage = null;
      st.reportedTasks.clear();
      st.activeToolSteps.clear();

      if (!proc.initSeen) {
        if (proc.closing === null) {
          const conflict = detectAgyArgsConflict(proc.stderr);
          if (conflict === "no_conversation" && st.inFlight.length === 0) {
            st.resumeHint = false;
            st.hasConversation = false;
          }
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
        if (proc.closing === "interrupt") for (const b of st.inFlight) this.markDelivered(st, b);
        proc.resolveReady({ kind: "closed", reason: proc.closing });
      }

      const hadInFlight = st.inFlight.length > 0;
      if (proc.initSeen && st.policyViolation !== null && st.inFlight.length > 0) {
        const batch = st.inFlight[0]!;
        const violation = st.policyViolation;
        st.inFlight = [];
        st.selfTurn = false;
        st.policyViolation = null;
        this.markProcessing(st, batch, at);
        this.forgetWritten(st, [batch]);
        this.emit(st.id, {
          type: "turn.ended",
          ok: false,
          interrupted: false,
          messageIds: batch.messageIds,
          durationMs: null,
          error: { subtype: "policy_violation", message: violation },
          at,
        });
      }

      const batch = proc.initSeen || proc.closing === "interrupt" ? (st.inFlight[0] ?? null) : null;
      if (hadInFlight) st.resultSeq++;
      st.inFlight = [];
      st.selfTurn = false;
      st.policyViolation = null;
      clearStepTracking(st);

      const reason: SessionExitReason = proc.closing ?? "crash";
      if (batch && reason === "crash") {
        st.crashNote = true;
        this.forgetWritten(st, [batch]);
      }
      st.stopRequested = false;
      const untaken = reason === "interrupt" && proc.initSeen && batch !== null && !batch.processing ? batch : null;
      const taken = untaken === null ? batch : null;
      this.emit(st.id, {
        type: "session.exited",
        reason,
        exitCode: code,
        signal,
        hadResult: taken === null,
        messageIds: taken?.messageIds ?? [],
        at,
      });
      if (untaken !== null) this.releaseOnStop(st, [untaken], at);
    } finally {
      this.resolveInterrupt(st);
      resolveExited();
      this.settled(st);
      if (st.pending.length > 0 && !this.shuttingDown && !st.ended) {
        void this.pump(st).catch(() => {});
      }
    }
  }
}

export function createAgyDriver(options: AgyDriverOptions): AgyDriver {
  return new AgyDriver(options);
}
