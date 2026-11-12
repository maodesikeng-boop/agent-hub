// OpenAI Codex App-Server 驱动层：公共会话状态机（待发队列、用量节流、启动/空闲/打断定时器、前缀说明注入与回退等）继承自 BaseSessionDriver；
// 本文件负责 `codex app-server --listen stdio://` JSON-RPC 2.0 握手（initialize → initialized → thread/start 或 thread/resume 失败自动回退）、
// 轮次发送（turn/start）、流式事件映射（agent.thinking / agent.tool / agent.tool_result / agent.text 聚合）、
// 用量与限额更新、反向 RPC 审批拦截（Worker 记忆保护与只读模式）、一轮中途 turn/steer 与优雅打断（turn/interrupt）。
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
  parseCodexToolStarted,
  readCodexLaunchConfig,
  type CodexLaunchConfig,
  type CodexUsageCounts,
} from "./protocol.ts";
import { CODEX_RESUME_REBAKES, personaSeenAtStart } from "../../daemon/driver/persona-note.ts";
import { lineUuid } from "../../daemon/driver/protocol.ts";
import { spawnInWriteScope, type ScopedSpawn, type SpawnCommand } from "../../daemon/driver/write-scope.ts";

interface Batch extends BaseBatch {
  combinedText: string;
  /** 会话正忙时用 turn/steer 在一轮中途交给 codex 的（不是 turn/start 开一轮的那条）。 */
  midTurn: boolean;
  /** 出过它的 userMessage item：codex 取走了（模型看到了）。 */
  echoed: boolean;
  /** steer 的回执还没到时这一轮就结束了：回执来了也不算送达，退回待发队列。 */
  turnDone: boolean;
  /** steer 的回执还没到时用户点了停止：回执来了按停止处理（用户的标已取消，系统的退回待发队列、停止后照常发）。 */
  stopped: boolean;
}

/** 一次 turn/steer 的结果：written 收下了（已送达）；queued 没收下，已经放回待发队列最前面；cancelled 停止时被取消了。 */
type SteerOutcome = "written" | "queued" | "cancelled";

interface Steer {
  batch: Batch;
  entry: PendingEntry;
  resolve: (outcome: SteerOutcome) => void;
}

type RpcPhase = "initialize" | "skills_extra_roots" | "thread_resume" | "thread_start" | "turn_start" | "turn_interrupt" | "turn_steer";

interface Proc extends BaseProc<StartupOutcome> {
  launchConfig: CodexLaunchConfig;
  /** 会话没选模型时 thread/start、thread/resume 显式带的（CodexDriverOptions.defaultModel），null 不带。 */
  defaultModel: string | null;
  readonly: boolean;
  /** Worker 的可写范围（LaunchFiles.writeScope）：沙箱的 writableRoots 和审批按它；项目经理是 null。 */
  writeScope: WriteScope | null;
  /** 进程包进了 OS 沙箱（spawnInWriteScope）：turn 用 externalSandbox。 */
  osSandboxed: boolean;
  /**
   * fileChange 条目要改的文件（item/started 里的 changes），按条目编号记：codex 的 item/fileChange/requestApproval 只带 itemId、
   * 不带路径（app-server generate-ts 的 FileChangeRequestApprovalParams），审批时按它判断；item/completed 时删掉。
   */
  fileChangePaths: Map<string, string[]>;
  /** fileChange 条目状态行上已显示的文件路径（item/started 或 item/fileChange/patchUpdated 给的第一个），去重用；条目结束、轮末清掉，最多 MAX_STREAMING_TOOL_BLOCKS 条。 */
  fileChangePreviewPaths: Map<string, string>;
  threadId: string | null;
  pendingRpcs: Map<number | string, RpcPhase>;
  /** 在等回执的 turn/steer：请求编号 → 那一行、原来的待发项和交回结果（#settleSteer）。进程退出时都按没收下处理。 */
  steers: Map<number | string, Steer>;
}

interface SessionState extends BaseSessionState<Proc, Batch> {
  activeTurnId: string | null;
  /** 单调递增的轮次计数，保证跨轮或重启后即使 codex 复用 item.id，发出的事件 uuid 依然绝对唯一。 */
  turnSeq: number;
  interruptRequestId: number | string | null;
  usageThreadId: string | null;
  lastThreadTotal: CodexUsageCounts | null;
  turnUsageStepSeq: number;
  lastTurnResultUsage: CodexUsageCounts | null;
  lastTurnContext: number | null;
  /** 按 itemId 缓存当前轮的 agentMessage 增量文本，在 item/completed 或 turn/completed 时一次性发出完整 agent.text。 */
  agentMessageBuffers: Map<string, string>;
  /** 当前轮已经发过 agent.text 的 itemId 集合，避免重复发送。 */
  emittedMessageIds: Set<string>;
  /** 当前轮已经发过 agent.thinking 的 itemId 集合，避免每个 delta 刷屏。 */
  emittedThinkingIds: Set<string>;
}

export interface CodexDriverOptions extends Omit<DriverOptions, "executablePath"> {
  /** codex 可执行文件路径，默认 "codex"。 */
  executablePath?: string;
  /**
   * 会话没选模型（null = 默认）时 thread/start、thread/resume 显式带的模型：守护进程接模型名单里 codex 报的默认（有缓存）。
   * 不带的话 codex 用 ~/.codex/config.toml 里钉死的，那个模型可能这个账号用不了（实测 gpt-6-astra 报 model_not_found）。
   * 没传或回 null 就不带，交给 codex。不写进库：界面仍显示“默认”。
   */
  defaultModel?: () => Promise<string | null>;
  /** 厂商命令与输入拼装器，默认 composer.ts 的 codexComposerBase。 */
  composer?: VendorComposerBase;
  /** 按哪个系统落实 Worker 的可写范围（write-scope.ts 的 spawnInWriteScope），默认本机；测试用。 */
  platform?: NodeJS.Platform;
  /** Worker 的可写范围包装（默认 spawnInWriteScope）；测试可注入。 */
  writeScopeSpawn?: (base: SpawnCommand, scope: WriteScope | null) => ScopedSpawn;
}

export class CodexDriver extends BaseSessionDriver<Proc, Batch, SessionState> {
  readonly #codexPath: string;
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
      // 忙着：用 turn/steer 交给正在跑的这一轮；codex 不收（这一轮正好结束等）就退回待发队列
      const proc = st.proc;
      if (proc && this.#canSteer(st, proc, entry)) {
        const batch = this.#batchOf(st, entryParts(entry), ids, false, entry.source);
        batch.midTurn = true;
        const outcome = await this.#steer(st, proc, batch, entry);
        if (outcome === "written") return { kind: "written", midTurn: true };
        if (outcome === "cancelled") return { kind: "cancelled" };
        // queued：#settleSteer 已经放回待发队列了
      } else {
        st.pending.push(entry);
      }
    }
    await this.pump(st);
    return ids.every((id) => st.written.has(id)) ? { kind: "written" } : { kind: "queued" };
  }

  /**
   * 能不能 steer：线程起好了、有正在跑的轮（知道它的 id）、不在关闭、没在两轮之间重启、这一轮没点过停止、
   * 待发队列是空的（不插队）、不是命令。
   */
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

  /** 发 turn/steer，等回执（结果见 #settleSteer）。 */
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

  /**
   * steer 有结果了（回执、写失败、进程没了）。收下了、这一轮还没结束：已送达（停止时也一样，这一轮的 turn/completed interrupted
   * 会把没读到的标已取消）。没收下，或者回执到之前这一轮已经结束了（codex 不会再处理它）：等回执期间点过停止的，用户的标已取消；
   * 别的（包括停止时的系统消息）放回待发队列最前面，下一轮用 turn/start 发。
   */
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
    // 停止 = agent 还没看到的用户消息都取消：先丢掉自己队列里的（系统消息留着，停止后照常发）
    this.dropPendingUsers(st);
    const proc = st.proc;
    if (!proc || !this.busy(st) || proc.closing) return;
    st.stopRequested = true;
    st.turnInterrupted = true;
    // steer 了、回执还没到的：回执到了也按停止处理，不退回队列再发（#settleSteer）
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
    // 启动时已经放进去了（startup），空闲时写的是新的
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

  /** 这一轮结束后还在等 steer 的回执，现在等到了、不忙了：补上 turn/completed 时因为还忙没做的收尾。 */
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
    // Worker 的可写范围：包一层 OS 沙箱，turn 的 sandboxPolicy 换成 externalSandbox（write-scope.ts）；没有 OS 沙箱时直接报错拒绝启动。
    // 只读 Worker 不在这里包：codex 自己的 readOnly 沙箱已经什么都写不了，macOS 沙箱又不能嵌套
    const wrapScope = launchConfig.readonly ? null : (files.writeScope ?? null);
    const baseSpawn: SpawnCommand = { command: this.#codexPath, args: buildCodexArgs() };
    const launch = this.#writeScopeSpawn
      ? this.#writeScopeSpawn(baseSpawn, wrapScope)
      : spawnInWriteScope("codex", baseSpawn, wrapScope, this.opts.log, `session ${st.id}`, this.#platform);
    const child = await this.spawnDetachedChild(
      this.#codexPath,
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
    // 发送握手第 1 步：initialize
    const initId = ++this.requestSeq;
    proc.pendingRpcs.set(initId, "initialize");
    child.stdin.write(buildInitializeRequest(initId) + "\n");
    return proc;
  }

  /** 握手第 3 步：建立或恢复线程。 */
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

  // --- JSON-RPC 2.0 输出处理 ---

  protected onParsedLine(
    st: SessionState,
    proc: Proc,
    obj: Record<string, unknown>,
    line: string,
    at: number,
  ): void {
    const hasId = obj.id !== undefined && obj.id !== null;
    const hasMethod = typeof obj.method === "string" && obj.method !== "";

    // 1. 反向 RPC 请求（Server -> Client Request：带 id 与 method）
    if (hasId && hasMethod) {
      this.#onServerRequest(st, proc, obj.id as number | string, obj.method as string, obj.params, at);
      return;
    }

    // 2. 客户端请求的响应（Server -> Client Response：带 id，无 method）
    if (hasId && !hasMethod) {
      this.#onRpcResponse(st, proc, obj.id as number | string, obj, at);
      return;
    }

    // 3. 服务端通知（Server -> Client Notification：带 method，无 id）
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
        // 第 2 步：发 initialized 通知
        proc.child.stdin.write(buildInitializedNotification() + "\n");
        // 项目经理会话：先挂产品技能目录，回了再建线程（线程开头就看得到技能清单）
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
        // 挂不上（老版本 codex 没有这个实验接口）不拦启动：提示词里有技能文件的路径，agent 照样能读
        if (errorObj) {
          const message = typeof errorObj.message === "string" ? errorObj.message : JSON.stringify(errorObj);
          this.opts.log?.(`[codex] session ${st.id} skills/extraRoots/set 失败，任务图手册只能按路径读：${message}`);
        }
        this.#openThread(st, proc);
        return;
      }

      case "thread_resume": {
        if (errorObj) {
          // thread/resume 报错（如 not found / no rollout found）：自动回退发 thread/start 开启新线程
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
        // 没收下：no active turn to steer、turn id 对不上
        if (errorObj) this.logSession(st.id, `turn/steer 没收下：${String(errorObj.message ?? "")}`);
        this.#settleSteer(st, steer, !errorObj);
        // 这一轮已经结束、只在等这个回执：现在才算闲下来（end 在等、待发队列要接着发、停止要收尾）
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
    // 线程好了才定 agent 看到的性格设定：thread/start（包括 resume 失败退回的）是这次拼的；thread/resume 见 persona-note.ts
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
        // 模型还在生成补丁时 app-server 推结构化的 changes（FileChangePatchUpdatedNotification）：只拿第一个路径刷新状态行，
        // 不写进 fileChangePaths（那份是审批时判断写范围用的，必须是条目确定的全部路径，不能拿流式中途的一部分放行）
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
          if (id) this.emit(st.id, { type: "agent.tool_result", toolUseIds: [id], at });
        }
        return;
      }

      case "thread/tokenUsage/updated": {
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

  /**
   * userMessage item：codex 取走了一条用户输入（开这一轮的那条，或 steer 进来的，被取走时才出，不是写入时）。按文字对上是哪一条
   * （开这一轮的那条已经算处理中了），对不上就按先后取最早一条没出过的。steer 的那条从这一刻起算处理中。
   */
  #onUserMessage(st: SessionState, item: Record<string, unknown>, at: number): void {
    const text = codexUserMessageText(item);
    const waiting = st.inFlight.filter((b) => !b.echoed);
    const batch = waiting.find((b) => b.combinedText === text) ?? waiting[0];
    if (!batch) return;
    batch.echoed = true;
    if (batch.midTurn) this.markProcessing(st, batch, at);
  }

  /** 将当前轮序号与 turnId 拼进 itemId，保证跨轮或重启后即使 codex 复用 itemId，发出的 uuid 也永不冲突。 */
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

    // 若当前轮有未发 item/completed 的累积 agentMessage 增量，先兜底补发完整 agent.text
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

    // 这一轮结算：开这一轮的那条 + steer 进来、读到了的。steer 了没读到的：codex 不会再处理，停止的标已取消、否则收回重发；
    // steer 回执还没到的留着，回执到了退回待发队列（见 turn_steer）
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
      // steer 进去、codex 还没读到的（模型没看到过）和这一轮的分开
      const missed = batches.filter((b) => b.midTurn && !b.echoed);
      const taken = batches.filter((b) => !missed.includes(b));
      if (taken.length > 0 && reason === "crash") {
        st.crashNote = true;
        this.forgetWritten(st, taken);
      }
      // 点了停止、turn/interrupt 还没结果时进程没了（崩溃也算）：没读到的照停止处理，用户的不收回重发
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

/** 记下 fileChange 条目状态行上显示的路径：有界（MAX_STREAMING_TOOL_BLOCKS），满了挤掉最早的。 */
function rememberPreviewPath(proc: Proc, itemId: string, path: string): void {
  const paths = proc.fileChangePreviewPaths;
  if (!paths.has(itemId) && paths.size >= MAX_STREAMING_TOOL_BLOCKS) {
    const oldest = paths.keys().next().value;
    if (oldest !== undefined) paths.delete(oldest);
  }
  paths.set(itemId, path);
}
