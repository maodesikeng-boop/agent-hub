// Antigravity (agy) 驱动层：每个会话一个 agy 进程（--input-format stream-json --output-format stream-json --print ""），
// 公共会话状态机（待发队列合并与取消、用量节流、启动/空闲/打断定时器、前缀说明注入与回退、后台任务跟踪与空闲保活等）继承自 BaseSessionDriver；
// 本文件负责 agy 专有协议：首条消息系统提示词注入、init 会话 ID 持久化与 --conversation 恢复、step_update 流式事件与后台任务状态映射、
// 只读 Worker 连接器拦截与沙箱包装、被拒后自动补一轮。
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DriverError,
  EMPTY_TOKEN_USAGE,
  MAX_STREAMING_TOOL_BLOCKS,
  STDERR_TAIL_CHARS,
  type AgentSessionPatch,
  type AgentSessionRow,
  type DriverEvent,
  type DriverOptions,
  type DriverSendInput,
  type DriverSendResult,
  type LaunchFiles,
  type MessageId,
  type ReadonlyPolicy,
  type SessionExitReason,
  type SessionId,
  type TokenUsage,
  type WriteScope,
} from "../../shared/index.ts";
import { AGY_DENIED_CONTINUE_MAX } from "./limits.ts";
import type { VendorComposerBase } from "../../daemon/vendors/types.ts";
import { agyComposerBase } from "./composer.ts";
import { createAgyConnectorResolver, createReadonlyProbeLauncher } from "./connectors.ts";
import {
  agyOfSession,
  buildAgyArgs,
  buildAgySessionStartedEvent,
  buildAgyUserLine,
  checkAgyUserLine,
  checkWorkerToolViolation,
  detectAgyArgsConflict,
  finishAgyUsage,
  observeAgyUsage,
} from "./protocol.ts";
import { writeAgyPromptRules } from "./rules.ts";
import {
  BaseSessionDriver,
  NO_NOTES,
  createBaseSessionState,
  entryParts,
  errorMessage,
  type BaseBatch,
  type BaseProc,
  type BaseSessionState,
  type PendingEntry,
  type StartupOutcome,
} from "../../daemon/driver/base-driver.ts";
import { personaSeenAtStart } from "../../daemon/driver/persona-note.ts";
import { pickStepInput, toolStepSignature } from "../../daemon/driver/protocol.ts";
import {
  EMPTY_AGY_CONNECTOR_CATALOG,
  READONLY_AGY_NEEDS_SANDBOX_MESSAGE,
  agyConnectorRules,
  agyReadonlySandboxInput,
  checkAgyConnectorCall,
  deniedActionsOf,
  deniedContinueText,
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

interface Batch extends BaseBatch {
  text: string;
  prefixes: string[];
  rawLine?: string;
}

type AgyStartupOutcome = StartupOutcome<ReturnType<typeof detectAgyArgsConflict>>;

interface Proc extends BaseProc<AgyStartupOutcome> {
  /** 只读 Worker 的统一定义和这次启动时问到的连接器清单（兜底检查 checkAgyConnectorCall 用）；不是只读 null。 */
  readonly: { policy: ReadonlyPolicy; catalog: AgyConnectorCatalog } | null;
  /** 只读 Worker 的会话私有临时目录（进程退出时删）；不是只读 null。 */
  tmpDir: string | null;
  /** 没有 OS 沙箱时要兜底检查的可写范围（checkWorkerToolViolation）；包进了沙箱、或项目经理是 null。 */
  fallbackScope: WriteScope | null;
}

/** agy 工具 step_update 的终态（含 CortexStepStatus CANCELED 单 L 与 CANCELLED 双 L 拼写）。 */
const AGY_TERMINAL_TOOL_STATES = new Set(["DONE", "FAILED", "CANCELLED", "CANCELED", "ERROR"]);

interface TrackedToolStep {
  task_id: string;
  description: string;
  /** 是否已作为后台任务上报（显式后台命令或轮结束时仍未 DONE 的工具步骤）。 */
  promoted: boolean;
}

interface SessionState extends BaseSessionState<Proc, Batch> {
  /** Worker 触发可写范围兜底或只读连接器违规时的错误原因。 */
  policyViolation: string | null;
  /** 这一轮因为“被拒”没回复，已经自动补了几轮（AGY_DENIED_CONTINUE_MAX；用户发新消息重新数）。 */
  deniedContinues: number;
  /** 内存里记录是否已经从 agy 收到过可恢复的 conversation_id。 */
  hasConversation: boolean;
  vendorSessionId: string;
  /** 当前轮按 step_id 累积的流式文本切片。 */
  stepTexts: Map<string, string>;
  /** 当前轮已经发出过 ACTIVE 事件的工具 step_id。 */
  seenToolSteps: Set<string>;
  /** 当前轮尚未闭合的工具 step_id → 最近一次 step 签名（用于早期 GENERATING/PENDING 预览与 ACTIVE 参数补齐去重，终态与轮末清理）。 */
  previewedToolSteps: Map<string, string>;
  /** 当前轮已经发出过 agent.tool_result 的工具 step_id（防止重复终态事件二次发射）。 */
  completedToolSteps: Set<string>;
  /** agy 通过 background_tasks_changed 等事件显式上报的后台任务（task_id → 任务项）。 */
  reportedTasks: Map<string, { task_id: string; description: string }>;
  /** 正在运行、尚未收到终态的工具步骤（用于跟踪跨轮/后台命令并与 reportedTasks 取并集同步到 background）。 */
  activeToolSteps: Map<string, TrackedToolStep>;
  /** 当前轮已经发出过 thinking 事件的 step_id。 */
  seenThinkingSteps: Set<string>;
  /** 自上一次工具调用（或轮开始）以来是否已经发出过 agent.text。 */
  hasTextSinceLastTool: boolean;
  /** 已完成的轮次计数（当前轮次为 resultSeq + 1），防止跨轮/重启后 step_index 复位的 UUID 冲突。 */
  resultSeq: number;
  /** 会话内单调递增的事件序号。 */
  eventSeq: number;
  lastLiveUsage: TokenUsage | null;
}

export interface AgyDriverOptions extends Omit<DriverOptions, "executablePath"> {
  /** agy 可执行文件路径，默认 "agy"。 */
  executablePath?: string;
  /** 这个驱动对应的厂商实现，默认 composer.ts 的 agyComposerBase。 */
  composer?: VendorComposerBase;
  /** 用户主目录（找 agy 的运行时目录和 MCP 配置），默认 os.homedir()。 */
  homeDir?: string;
  /** 只读 Worker：现在有哪些连接器、哪些工具标了只读（connectors.ts）。默认读 agy 的 MCP 配置、向每个服务器问 tools/list；测试可以替换。 */
  connectorCatalog?: () => Promise<AgyConnectorCatalog>;
  /** 只读 Worker：把进程包进外层只读沙箱（默认 write-scope.ts 的 wrapInReadonlyOsSandbox，支持 macOS seatbelt 与 Linux bubblewrap）；测试可以替换。 */
  readonlySpawn?: (base: SpawnCommand, input: ReadonlySandboxInput) => ScopedSpawn;
}

export class AgyDriver extends BaseSessionDriver<Proc, Batch, SessionState> {
  readonly #agyPath: string;
  readonly #homeDir?: string;
  readonly #customCatalog?: () => Promise<AgyConnectorCatalog>;
  readonly #readonlySpawn?: (base: SpawnCommand, input: ReadonlySandboxInput) => ScopedSpawn;
  #connectorCatalog: (() => Promise<AgyConnectorCatalog>) | null = null;
  #latestReadonlyPolicy: ReadonlyPolicy | null = null;

  constructor(options: AgyDriverOptions) {
    super("agy", { ...options, composer: options.composer ?? agyComposerBase });
    this.#agyPath = options.executablePath ?? "agy";
    this.#homeDir = options.homeDir;
    this.#customCatalog = options.connectorCatalog;
    this.#readonlySpawn = options.readonlySpawn;
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

  /**
   * @internal 只给测试用：跳过拼装，把一行原样交给写入函数（照样先校验）。会话要已经起来、空闲。
   */
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
    // 性格设定改了的说明只和现在这个进程比（没有进程、正在关的不比：新起的进程按最新的拼系统指令）
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

  /** 为指定进程构造要写入 stdin 的 NDJSON 行。产品提示词不拼进消息：起进程时写成规则目录走 agy 的系统提示词（rules.ts）。 */
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
    st.stepTexts.clear();
    st.seenToolSteps.clear();
    st.previewedToolSteps.clear();
    st.completedToolSteps.clear();
    st.seenThinkingSteps.clear();
    st.hasTextSinceLastTool = false;
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
            extraEnv: this.opts.env,
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
    // 产品提示词写成规则目录、--add-dir 进 agy 的系统提示词（<user_rules>），压缩后还在；每次起进程按最新的 prompt.md 重写
    const promptRulesDir = writeAgyPromptRules(files.promptFile);

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
    if (readonlyPolicy === undefined) {
      launch = spawnInWriteScope("agy", { command: this.#agyPath, args }, files.writeScope ?? null, this.opts.log, `session ${st.id}`);
    } else {
      const home = realpathSync(this.#homeDir ?? homedir());
      const wrap = this.#readonlySpawn ?? ((base, input) => wrapInReadonlyOsSandbox(base, input));
      const privateTmp = mkdtempSync(join(realpathSync(tmpdir()), "agent-hub-ro-"));
      launch = wrap(
        { command: this.#agyPath, args },
        agyReadonlySandboxInput({ homeDir: home, tmpDir: privateTmp, policy: readonlyPolicy }),
      );
      if (!launch.osSandboxed) {
        rmSync(privateTmp, { recursive: true, force: true });
        throw new DriverError("spawn_failed", READONLY_AGY_NEEDS_SANDBOX_MESSAGE);
      }
      tmpDir = privateTmp;
      childEnv = { ...childEnv, TMPDIR: privateTmp };
    }
    const removeTmp = () => {
      if (tmpDir !== null) rmSync(tmpDir, { recursive: true, force: true });
    };
    const child = await this.spawnDetachedChild(
      this.#agyPath,
      launch.command,
      launch.args,
      row.cwd,
      childEnv,
      removeTmp,
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
    this.attachChildProcess(st, proc, resolveExited, removeTmp);
    return proc;
  }

  // --- 输出解析 ---

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
        this.#onStepUpdate(st, proc, obj, at);
        return;
      case "background_tasks_changed":
        this.#onReportedBackgroundTasks(st, proc, extractAgyBackgroundTasks(obj));
        return;
      case "system":
        if (obj.subtype === "background_tasks_changed") {
          this.#onReportedBackgroundTasks(st, proc, extractAgyBackgroundTasks(obj));
        }
        return;
      case "result":
        this.#onResult(st, proc, obj, at);
        return;
    }
  }

  #onReportedBackgroundTasks(st: SessionState, proc: Proc, rawTasks: unknown): void {
    if (!Array.isArray(rawTasks)) return;
    const next = new Map<string, { task_id: string; description: string }>();
    for (const t of rawTasks) {
      if (typeof t !== "object" || t === null) continue;
      const { task_id: id, ambient, description } = t as {
        task_id?: unknown;
        ambient?: unknown;
        description?: unknown;
      };
      if (typeof id === "string" && id !== "" && ambient !== true) {
        next.set(id, { task_id: id, description: typeof description === "string" ? description : "" });
      }
    }
    st.reportedTasks = next;
    this.#syncBackgroundTasks(st, proc);
  }

  #syncBackgroundTasks(st: SessionState, proc: Proc): void {
    const merged = new Map<string, { task_id: string; description: string }>(st.reportedTasks);
    for (const step of st.activeToolSteps.values()) {
      if (step.promoted && !merged.has(step.task_id)) {
        merged.set(step.task_id, { task_id: step.task_id, description: step.description });
      }
    }
    this.onBackgroundTasksChanged(st, proc, [...merged.values()]);
  }

  #conversationIdOf(st: SessionState): string {
    if (st.vendorSessionId !== "") return st.vendorSessionId;
    return this.row(st)?.vendorSessionId ?? String(st.id);
  }

  /** 将某个（或全部）step_id 累积的文本作为单条 agent.text 发出。 */
  #flushStepTexts(st: SessionState, at: number, exceptStepId?: string): void {
    const convId = this.#conversationIdOf(st);
    const turnNo = st.resultSeq + 1;
    for (const [stepId, text] of [...st.stepTexts.entries()]) {
      if (exceptStepId !== undefined && stepId === exceptStepId) continue;
      st.stepTexts.delete(stepId);
      if (text.trim() !== "") {
        st.hasTextSinceLastTool = true;
        this.emit(st.id, {
          type: "agent.text",
          uuid: `agy-step-${convId}-${turnNo}-${stepId}-${++st.eventSeq}`,
          text,
          at,
        });
      }
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

  #onStepUpdate(st: SessionState, proc: Proc, obj: Record<string, unknown>, at: number): void {
    const su =
      typeof obj.step_update === "object" && obj.step_update !== null
        ? (obj.step_update as Record<string, unknown>)
        : obj;
    const rawStepId = su.step_index ?? su.step_id ?? obj.step_index ?? obj.step_id;
    const stepId = typeof rawStepId === "number" || typeof rawStepId === "string" ? String(rawStepId) : "0";
    const stepType = su.step_type;
    const turnNo = st.resultSeq + 1;
    const inFlight = st.inFlight[0] ?? null;

    if (
      stepType === "background_tasks" ||
      stepType === "background_tasks_changed" ||
      "tasks" in su ||
      "background_tasks" in su
    ) {
      this.#onReportedBackgroundTasks(st, proc, extractAgyBackgroundTasks(su));
      if (stepType === "background_tasks" || stepType === "background_tasks_changed") return;
    }

    if (stepType === "user_input") {
      if (su.state === "DONE" && inFlight) {
        this.markProcessing(st, inFlight, at);
      }
      return;
    }

    if (stepType === "agent_response") {
      if (inFlight) this.markProcessing(st, inFlight, at);
      this.#flushStepTexts(st, at, stepId);

      let appendedDelta = "";
      let reset = false;
      if (typeof su.text_delta === "string" && su.text_delta !== "") {
        st.stepTexts.set(stepId, (st.stepTexts.get(stepId) ?? "") + su.text_delta);
        appendedDelta = su.text_delta;
      } else if (typeof su.text === "string" && su.text !== "" && !st.stepTexts.has(stepId)) {
        st.stepTexts.set(stepId, su.text);
        appendedDelta = su.text;
        reset = true;
      }

      if (typeof su.usage === "object" && su.usage !== null) {
        const row = this.row(st);
        const live = row ? observeAgyUsage(st.turnUsage, stepId, su.usage, row.usage) : null;
        if (live) {
          st.lastLiveUsage = live;
          this.pushUsage(st, live);
        }
      }

      if (su.state === "DONE") {
        this.#flushStepTexts(st, at);
      } else if (appendedDelta !== "") {
        this.emit(st.id, { type: "agent.text_delta", delta: appendedDelta, ...(reset ? { reset: true } : {}), at });
      }
      return;
    }

    if (stepType === "thinking") {
      if (inFlight) this.markProcessing(st, inFlight, at);
      if (!st.seenThinkingSteps.has(stepId)) {
        st.seenThinkingSteps.add(stepId);
        this.emit(st.id, {
          type: "agent.thinking",
          uuid: `agy-thinking-${this.#conversationIdOf(st)}-${turnNo}-${stepId}-${++st.eventSeq}`,
          at,
        });
      }
      return;
    }

    if (stepType === "tool") {
      if (inFlight) this.markProcessing(st, inFlight, at);
      this.#flushStepTexts(st, at);
      st.hasTextSinceLastTool = false;

      const toolInfo =
        typeof su.tool_info === "object" && su.tool_info !== null
          ? (su.tool_info as Record<string, unknown>)
          : undefined;
      const toolName =
        typeof su.tool_name === "string"
          ? su.tool_name
          : typeof toolInfo?.tool_name === "string"
            ? toolInfo.tool_name
            : typeof toolInfo?.name === "string"
              ? toolInfo.name
              : "";
      const parameters = toolInfo?.parameters ?? su.parameters ?? null;
      const toolUseId = `tool-${turnNo}-${stepId}`;
      const isTerminal = typeof su.state === "string" && AGY_TERMINAL_TOOL_STATES.has(su.state);
      const isFormalState = su.state === "ACTIVE" || isTerminal || su.state === undefined;

      const setBoundedPreviewSig = (sig: string) => {
        if (!st.previewedToolSteps.has(stepId) && st.previewedToolSteps.size >= MAX_STREAMING_TOOL_BLOCKS) {
          const oldest = st.previewedToolSteps.keys().next().value;
          if (oldest !== undefined) st.previewedToolSteps.delete(oldest);
        }
        st.previewedToolSteps.set(stepId, sig);
      };

      if (!st.seenToolSteps.has(stepId) && isFormalState) {
        st.seenToolSteps.add(stepId);
        setBoundedPreviewSig(toolStepSignature(toolName, parameters));
        const convId = this.#conversationIdOf(st);

        this.emit(st.id, {
          type: "agent.tool",
          uuid: `agy-tool-${convId}-${turnNo}-${stepId}-${++st.eventSeq}`,
          toolUseId,
          name: toolName,
          input: parameters,
          at,
        });
      } else if (!isTerminal && toolName !== "") {
        const sig = toolStepSignature(toolName, parameters);
        if (st.previewedToolSteps.get(stepId) !== sig) {
          setBoundedPreviewSig(sig);
          this.emit(st.id, {
            type: "agent.tool_preview",
            toolUseId,
            name: toolName,
            input: pickStepInput(parameters),
            at,
          });
        }
      }

      if (!isTerminal || !st.completedToolSteps.has(stepId)) {
        const row = this.row(st);
        if (row?.role === "worker") {
          const violation =
            checkWorkerToolViolation({ toolName, parameters, fallbackScope: proc.fallbackScope, cwd: row.cwd }) ??
            (proc.readonly === null
              ? null
              : checkAgyConnectorCall(toolName, parameters, proc.readonly.policy, proc.readonly.catalog));
          if (violation !== null) {
            st.policyViolation = violation;
            this.sigintForInterrupt(st, proc, "interruptTimer");
            return;
          }
        }
      }

      if (su.state === "ACTIVE") {
        const promoted = isExplicitBackgroundToolStep(su, toolName, parameters);
        st.activeToolSteps.set(stepId, {
          task_id: stepId,
          description: extractToolDescription(toolName, parameters),
          promoted,
        });
        if (promoted) {
          this.#syncBackgroundTasks(st, proc);
        }
      }

      if (isTerminal) {
        st.previewedToolSteps.delete(stepId);
        const removed = st.activeToolSteps.get(stepId);
        st.activeToolSteps.delete(stepId);
        if (removed?.promoted) {
          this.#syncBackgroundTasks(st, proc);
        }
        if (!st.completedToolSteps.has(stepId)) {
          st.completedToolSteps.add(stepId);
          this.emit(st.id, {
            type: "agent.tool_result",
            toolUseIds: [toolUseId],
            at,
          });
        }
      }
    }
  }

  #onResult(st: SessionState, proc: Proc, obj: Record<string, unknown>, at: number): void {
    const res =
      typeof obj.result === "object" && obj.result !== null
        ? (obj.result as Record<string, unknown>)
        : obj;
    if (!proc.initSeen) {
      const preInitErr =
        typeof res.error === "string" ? res.error : typeof obj.error === "string" ? obj.error : "";
      if (preInitErr !== "") proc.stderr = (proc.stderr + "\n" + preInitErr).slice(-STDERR_TAIL_CHARS);
      return;
    }

    const rawConvId = res.conversation_id ?? obj.conversation_id;
    const convId = typeof rawConvId === "string" && rawConvId.trim() !== "" ? rawConvId.trim() : "";
    if (convId !== "" && convId !== st.vendorSessionId) {
      st.vendorSessionId = convId;
      st.hasConversation = true;
    }

    if ("tasks" in res || "background_tasks" in res) {
      this.#onReportedBackgroundTasks(st, proc, extractAgyBackgroundTasks(res));
    }

    const finishedReason = typeof res.finished_reason === "string" ? res.finished_reason : null;
    const rawInterrupted = finishedReason === "interrupted" || st.turnInterrupted || st.stopRequested;
    if (!rawInterrupted && this.#continueAfterDenial(st, proc, res, obj, at)) return;
    const written = st.inFlight[0] ?? null;
    st.inFlight = [];
    st.selfTurn = false;
    const untaken = rawInterrupted && written !== null && !written.processing ? written : null;
    const batch = untaken === null ? written : null;
    if (batch) this.markProcessing(st, batch, at);

    this.#flushStepTexts(st, at);
    const hadFinalText = st.hasTextSinceLastTool || (typeof res.response === "string" && res.response.trim() !== "");

    const turnNo = ++st.resultSeq;
    if (
      !st.hasTextSinceLastTool &&
      st.policyViolation === null &&
      typeof res.response === "string" &&
      res.response.trim() !== ""
    ) {
      this.emit(st.id, {
        type: "agent.text",
        uuid: `agy-result-${this.#conversationIdOf(st)}-${turnNo}-${++st.eventSeq}`,
        text: res.response,
        at,
      });
    }

    const violation = st.policyViolation;
    st.policyViolation = null;

    if (rawInterrupted && proc.closing === null) {
      proc.closing = "interrupt";
    }

    const interrupted = violation !== null ? false : rawInterrupted;
    const status = typeof res.status === "string" ? res.status : "SUCCESS";
    const ok = violation === null && !interrupted && (status === "SUCCESS" || (finishedReason === null && hadFinalText));

    // 轮结束时仍有 ACTIVE 且未 DONE 的工具步骤（如 run_command 转后台运行）：同步为后台任务
    if (ok && st.activeToolSteps.size > 0) {
      let newlyPromoted = false;
      for (const step of st.activeToolSteps.values()) {
        if (!step.promoted) {
          step.promoted = true;
          newlyPromoted = true;
        }
      }
      if (newlyPromoted) {
        this.#syncBackgroundTasks(st, proc);
      }
    } else if (!ok && st.activeToolSteps.size > 0) {
      let hadPromoted = false;
      for (const step of st.activeToolSteps.values()) {
        if (step.promoted) hadPromoted = true;
      }
      st.activeToolSteps.clear();
      if (hadPromoted) {
        this.#syncBackgroundTasks(st, proc);
      }
    }

    const event: DriverEvent = {
      type: "turn.ended",
      ok,
      interrupted,
      messageIds: batch?.messageIds ?? [],
      durationMs: typeof res.duration_ms === "number" ? res.duration_ms : null,
      at,
    };
    if (proc.closing === "shutdown" && (!ok || interrupted)) event.shutdown = true;
    if (!ok) {
      if (violation !== null) {
        event.error = { subtype: "policy_violation", message: violation };
      } else {
        const subtype = finishedReason ?? (status === "ERROR" ? "error_during_execution" : status.toLowerCase());
        event.error = { subtype, message: resultErrorMessage(res, obj, subtype) };
      }
      this.forgetWritten(st, [batch]);
    } else {
      this.markHealthy(st.id);
    }

    st.turnInterrupted = false;
    st.stopRequested = false;
    st.stepTexts.clear();
    st.seenToolSteps.clear();
    st.previewedToolSteps.clear();
    st.completedToolSteps.clear();
    st.seenThinkingSteps.clear();
    st.hasTextSinceLastTool = false;

    this.#settleUsage(st, res, obj);

    this.clearTimer(st, "interruptTimer");
    this.emit(st.id, event);
    if (untaken !== null) this.releaseOnStop(st, [untaken], at);
    this.resolveInterrupt(st);
    this.afterTurn(st, proc);
    this.settled(st);
  }

  #settleUsage(st: SessionState, res: Record<string, unknown>, obj: Record<string, unknown>): void {
    const row = this.row(st);
    this.cancelUsagePush(st);
    const finalUsage = finishAgyUsage(
      st.turnUsage,
      row?.usage ?? EMPTY_TOKEN_USAGE,
      res.usage ?? obj.usage,
      st.lastLiveUsage,
    );
    st.lastLiveUsage = null;
    const patch: AgentSessionPatch = { usage: finalUsage };
    if (row?.hasCompletedTurn === false) patch.hasCompletedTurn = true;
    this.update(st, patch);
  }

  #continueAfterDenial(
    st: SessionState,
    proc: Proc,
    res: Record<string, unknown>,
    obj: Record<string, unknown>,
    at: number,
  ): boolean {
    const denied = deniedActionsOf(res);
    const status = typeof res.status === "string" ? res.status : "SUCCESS";
    const blank = typeof res.response !== "string" || res.response.trim() === "";
    if (denied.length === 0 || !blank || status !== "SUCCESS" || st.policyViolation !== null) return false;
    if (st.inFlight.length === 0 || st.ended || proc.closing !== null || st.proc !== proc || this.shuttingDown) {
      return false;
    }
    if (st.deniedContinues >= AGY_DENIED_CONTINUE_MAX) return false;
    const line = buildAgyUserLine(deniedContinueText(denied), [], this.composer.buildUserContent);
    if (checkAgyUserLine(line) !== null) return false;
    st.deniedContinues++;
    this.#flushStepTexts(st, at);
    st.resultSeq++;
    this.#settleUsage(st, res, obj);
    st.stepTexts.clear();
    st.seenToolSteps.clear();
    st.previewedToolSteps.clear();
    st.completedToolSteps.clear();
    st.seenThinkingSteps.clear();
    st.hasTextSinceLastTool = false;
    proc.child.stdin.write(line + "\n");
    return true;
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
      st.stepTexts.clear();
      st.seenToolSteps.clear();
      st.previewedToolSteps.clear();
      st.completedToolSteps.clear();
      st.seenThinkingSteps.clear();
      st.hasTextSinceLastTool = false;

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

function extractAgyBackgroundTasks(obj: Record<string, unknown>): unknown {
  if ("tasks" in obj) return obj.tasks;
  if ("background_tasks" in obj) {
    const bg = obj.background_tasks;
    if (typeof bg === "object" && bg !== null && !Array.isArray(bg) && "tasks" in bg) {
      return (bg as Record<string, unknown>).tasks;
    }
    return bg;
  }
  return undefined;
}

function isExplicitBackgroundToolStep(
  su: Record<string, unknown>,
  toolName: string,
  parameters: unknown,
): boolean {
  if (su.background === true) return true;
  if (toolName === "run_command" && typeof parameters === "object" && parameters !== null) {
    const p = parameters as Record<string, unknown>;
    if (p.IsDaemon === true || p.run_in_background === true) return true;
  }
  return false;
}

function extractToolDescription(toolName: string, parameters: unknown): string {
  if (typeof parameters === "object" && parameters !== null) {
    const p = parameters as Record<string, unknown>;
    for (const key of ["CommandLine", "command", "toolSummary", "description"]) {
      if (typeof p[key] === "string" && p[key].trim() !== "") return p[key].trim();
    }
  }
  return toolName;
}

function resultErrorMessage(res: Record<string, unknown>, obj: Record<string, unknown>, subtype: string): string {
  if (typeof res.error === "string" && res.error !== "") return res.error;
  if (typeof obj.error === "string" && obj.error !== "") return obj.error;
  if (typeof res.response === "string" && res.response !== "") return res.response;
  return subtype;
}

function startupError(
  outcome: Extract<AgyStartupOutcome, { kind: "failed" }>,
  startTimeoutMs: number,
  retried: boolean,
): DriverError {
  if (outcome.timedOut) return new DriverError("start_timeout", `no init within ${startTimeoutMs} ms`);
  const how = outcome.signal ? `signal ${outcome.signal}` : `exit code ${outcome.exitCode}`;
  const stderr = outcome.stderr.trim();
  if (outcome.conflict) {
    return new DriverError(
      "start_args_conflict",
      `${retried ? "after retrying without --conversation: " : ""}${stderr || how}`,
    );
  }
  return new DriverError("spawn_failed", `agy exited before init (${how})${stderr ? `: ${stderr}` : ""}`);
}
