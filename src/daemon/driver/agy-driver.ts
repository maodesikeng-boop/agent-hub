// Antigravity (agy) 驱动层：每个会话一个 agy 进程（--input-format stream-json --output-format stream-json --print ""），
// 管理待发队列（一轮一条、忙时用户连发合并、写入前校验）、首条消息系统提示词注入、init 会话 ID 持久化与 --conversation 恢复、
// SIGINT 打断、没有 OS 沙箱时的可写范围兜底、只读 Worker 的连接器拦截、被拒后自动补一轮、空闲关闭与残留清理。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  CRASH_RECOVERY_NOTE,
  DriverError,
  AGY_DENIED_CONTINUE_MAX,
  EMPTY_TOKEN_USAGE,
  IDLE_CLOSE_MS,
  INTERRUPT_GRACE_MS,
  KILL_WAIT_MS,
  LAST_EVENT_WRITE_MS,
  RELAUNCH_NOTE,
  RESEND_NOTE,
  RESTART_RECOVERY_NOTE,
  RUNNING_COMMANDS_TIMEOUT_MS,
  SHUTDOWN_GRACE_MS,
  START_TIMEOUT_MS,
  STDERR_TAIL_CHARS,
  STDIO_DRAIN_MS,
  USAGE_PUSH_MS,
  type AgentSessionPatch,
  type AgentSessionRow,
  type ComposerCommand,
  type Driver,
  type DriverEvent,
  type DriverEventListener,
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
  type Unsubscribe,
  type WriteScope,
  notFoundCode,
} from "../../shared/index.ts";
import { composerBaseOf, type VendorComposerBase } from "../vendors/index.ts";
import {
  agyOfSession,
  buildAgyArgs,
  buildAgySessionStartedEvent,
  buildAgyUserLine,
  buildChildEnv,
  checkAgyUserLine,
  checkWorkerToolViolation,
  detectAgyArgsConflict,
  finishAgyUsage,
  mergeUserTexts,
  observeAgyUsage,
  readSystemInstructions,
} from "./agy-protocol.ts";
import {
  forceKill,
  forceKillTree,
  killFreshGroup,
  signalChild,
  signalPid,
  signalTarget,
  streamClosed,
  termGroupAfterExit,
  waitForExit,
} from "./process.ts";
import { createAgyConnectorResolver, createReadonlyProbeLauncher } from "./agy-connectors.ts";
import {
  EMPTY_AGY_CONNECTOR_CATALOG,
  READONLY_AGY_NEEDS_SANDBOX_MESSAGE,
  agyConnectorRules,
  agyReadonlySandboxInput,
  checkAgyConnectorCall,
  deniedActionsOf,
  deniedContinueText,
  type AgyConnectorCatalog,
} from "./readonly-agy.ts";
import {
  scanSecretGlobs,
  spawnInWriteScope,
  wrapInReadonlyOsSandbox,
  type ReadonlySandboxInput,
  type ScopedSpawn,
  type SpawnCommand,
} from "./write-scope.ts";
import { personaSeenAtStart, takePersonaNote, type PersonaNoteTaken } from "./persona-note.ts";
import { takeSessionPreamble, type PreambleTaken } from "./session-preamble.ts";
import { dropUserEntries, untakenOnStopEvents } from "./stop-untaken.ts";
import { TurnUsage } from "./usage.ts";

interface PendingEntry {
  messageIds: MessageId[];
  source: MessageSource;
  text: string;
  prefixes: string[];
  resend: boolean;
}

interface Batch {
  messageIds: MessageId[];
  text: string;
  prefixes: string[];
  rawLine?: string;
  /** persona：性格设定、模式改了的说明（persona-note.ts），没写成时退回去。 */
  notes: { recovery: boolean; crash: boolean; relaunch: boolean; persona: PersonaNoteTaken | null; preamble: PreambleTaken | null };
  delivered: boolean;
  processing: boolean;
  /** 用户的（几条拼成一条的也是）还是系统的；不写是用户的（测试直接写的那行）。停止时没取走的，用户的取消、系统的收回。 */
  source?: MessageSource;
}

type ClosingReason = "idle" | "interrupt" | "shutdown";

const NO_NOTES: Batch["notes"] = { recovery: false, crash: false, relaunch: false, persona: null, preamble: null };

type StartupOutcome =
  | { kind: "ok" }
  | {
      kind: "failed";
      exitCode: number | null;
      signal: string | null;
      stderr: string;
      conflict: ReturnType<typeof detectAgyArgsConflict>;
      timedOut: boolean;
    }
  | { kind: "closed"; reason: ClosingReason };

interface LaunchSnapshot {
  fingerprint: string;
  cwd: string;
  addDirs: string[];
  model: string | null;
  effort: string | null;
}

interface Proc {
  child: ChildProcessWithoutNullStreams;
  resume: boolean;
  launched: LaunchSnapshot;
  /** 这次拼进系统指令的性格设定是哪一版（LaunchFiles.personaRevision）：第一个 init 时定 agent 看到的版本（persona-note.ts）。 */
  personaLaunched: number | null;
  /** 新进程第一条消息前面带的系统指令（agy 没有系统提示词参数），里面的性格设定是 personaRevision 那一版。 */
  systemPrompt: string | null;
  promptSent: boolean;
  /** 只读 Worker 的统一定义和这次启动时问到的连接器清单（兜底检查 checkAgyConnectorCall 用）；不是只读 null。 */
  readonly: { policy: ReadonlyPolicy; catalog: AgyConnectorCatalog } | null;
  /** 只读 Worker 的会话私有临时目录（进程退出时删）；不是只读 null。 */
  tmpDir: string | null;
  /** 没有 OS 沙箱时要兜底检查的可写范围（checkWorkerToolViolation）；包进了沙箱、或项目经理是 null。 */
  fallbackScope: WriteScope | null;
  initSeen: boolean;
  stderr: string;
  closing: ClosingReason | null;
  startTimedOut: boolean;
  killTimer: NodeJS.Timeout | null;
  ready: Promise<StartupOutcome>;
  resolveReady: (o: StartupOutcome) => void;
  exited: Promise<void>;
}

interface SessionState {
  id: SessionId;
  proc: Proc | null;
  inFlight: Batch | null;
  selfTurn: boolean;
  turnInterrupted: boolean;
  stopRequested: boolean;
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
  /** 当前轮已經发出过 thinking 事件的 step_id。 */
  seenThinkingSteps: Set<string>;
  /** 自上一次工具调用（或轮开始）以来是否已经发出过 agent.text。 */
  hasTextSinceLastTool: boolean;
  /** 已完成的轮次计数（当前轮次为 resultSeq + 1），防止跨轮/重启后 step_index 复位的 UUID 冲突。 */
  resultSeq: number;
  /** 会话内单调递增的事件序号。 */
  eventSeq: number;
  pending: PendingEntry[];
  written: Set<MessageId>;
  /** agent 已经看到的性格设定、模式是哪一版（写进会话那一行的 personaRevision）；null 不比（persona-note.ts）。 */
  personaSeen: number | null;
  /** 换代后的开场说明这个进程里带过了（还没等到账本记读到）；session-preamble.ts。 */
  preambleTaken: boolean;
  recoveryNote: boolean;
  crashNote: boolean;
  relaunchNote: boolean;
  ended: boolean;
  ending: Promise<void> | null;
  settleWaiters: Array<() => void>;
  resumeHint: boolean | null;
  starting: Promise<void> | null;
  startTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  interruptTimer: NodeJS.Timeout | null;
  interruptWaiters: Array<() => void>;
  lastEventWrite: number;
  turnUsage: TurnUsage;
  lastLiveUsage: TokenUsage | null;
  usageLatest: TokenUsage | null;
  usagePushedAt: number;
  usageTimer: NodeJS.Timeout | null;
}

export interface AgyDriverOptions extends Omit<DriverOptions, "claudePath"> {
  /** agy 可执行文件路径（优先取 agyPath，兼容传 claudePath，默认 "agy"）。 */
  agyPath?: string;
  claudePath?: string;
  /** 这个驱动对应的厂商实现，默认 vendors/ 里 agy 那份。 */
  composer?: VendorComposerBase;
  /** 用户主目录（找 agy 的运行时目录和 MCP 配置），默认 os.homedir()。 */
  homeDir?: string;
  /** 只读 Worker：现在有哪些连接器、哪些工具标了只读（agy-connectors.ts）。默认读 agy 的 MCP 配置、向每个服务器问 tools/list；测试可以替换。 */
  connectorCatalog?: () => Promise<AgyConnectorCatalog>;
  /** 只读 Worker：把进程包进外层只读沙箱（默认 write-scope.ts 的 wrapInReadonlyOsSandbox，支持 macOS seatbelt 与 Linux bubblewrap）；测试可以替换。 */
  readonlySpawn?: (base: SpawnCommand, input: ReadonlySandboxInput) => ScopedSpawn;
}

export class AgyDriver implements Driver {
  readonly #agyPath: string;
  readonly #opts: Required<
    Pick<DriverOptions, "idleCloseMs" | "interruptGraceMs" | "startTimeoutMs" | "shutdownGraceMs" | "commandsTimeoutMs" | "log">
  > &
    AgyDriverOptions;
  readonly #composer: VendorComposerBase;
  #connectorCatalog: (() => Promise<AgyConnectorCatalog>) | null = null;
  #latestReadonlyPolicy: ReadonlyPolicy | null = null;
  readonly #sessions = new Map<SessionId, SessionState>();
  readonly #listeners = new Set<DriverEventListener>();
  #shuttingDown = false;
  #reportingListenerError = false;

  constructor({ composer, ...options }: AgyDriverOptions) {
    this.#composer = composer ?? composerBaseOf("agy")!;
    this.#agyPath = options.agyPath ?? options.claudePath ?? "agy";
    this.#opts = {
      idleCloseMs: IDLE_CLOSE_MS,
      interruptGraceMs: INTERRUPT_GRACE_MS,
      startTimeoutMs: START_TIMEOUT_MS,
      shutdownGraceMs: SHUTDOWN_GRACE_MS,
      commandsTimeoutMs: RUNNING_COMMANDS_TIMEOUT_MS,
      log: (line: string) => console.error(line),
      ...options,
    };
  }

  onEvent(listener: DriverEventListener): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  isRunning(sessionId: SessionId): boolean {
    const proc = this.#sessions.get(sessionId)?.proc;
    return Boolean(proc && !proc.closing);
  }

  async start(sessionId: SessionId): Promise<void> {
    this.#assertRunning();
    const st = this.#state(sessionId);
    this.#assertNotEnded(st);
    for (;;) {
      if (st.starting) return st.starting;
      this.#assertNotEnded(st);
      const proc = st.proc;
      if (proc?.closing) {
        await proc.exited;
        this.#assertRunning();
        continue;
      }
      if (proc) {
        if (proc.initSeen || st.inFlight) return;
        const batch = this.#takeBatch(st);
        return batch ? this.#runStartup(st, batch, proc) : undefined;
      }
      const batch = this.#takeBatch(st);
      if (batch) return this.#runStartup(st, batch, null);
      const promise: Promise<void> = this.#spawn(st, this.#resumeFor(st), null)
        .then((p) => {
          this.#abortIfStopped(st, p);
          this.#armIdle(st, p);
        })
        .finally(() => {
          if (st.starting === promise) st.starting = null;
        });
      st.starting = promise;
      return promise;
    }
  }

  async send(sessionId: SessionId, input: DriverSendInput): Promise<DriverSendResult> {
    this.#assertRunning();
    const st = this.#state(sessionId);
    this.#assertNotEnded(st);
    const ids = input.messageIds;
    if (ids.length === 0) {
      this.#invalidInput(st, "messageIds 是空的", ids);
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
    const problem = checkAgyUserLine(buildAgyUserLine(parts.text, parts.prefixes, this.#composer.buildUserContent));
    if (problem) {
      this.#invalidInput(st, problem, ids);
      return { kind: "rejected" };
    }
    if (!this.#isPending(st, ids)) {
      st.pending.push(entry);
      if (input.recovery) st.recoveryNote = true;
    }
    await this.#pump(st);
    return ids.every((id) => st.written.has(id)) ? { kind: "written" } : { kind: "queued" };
  }

  /**
   * @internal 只给测试用：跳过拼装，把一行原样交给写入函数（照样先校验）。会话要已经起来、空闲。
   */
  async writeUserLine(sessionId: SessionId, line: string, messageIds: MessageId[]): Promise<DriverSendResult> {
    const st = this.#state(sessionId);
    const problem = checkAgyUserLine(line);
    if (problem) {
      this.#invalidInput(st, problem, messageIds);
      return { kind: "rejected" };
    }
    const proc = st.proc;
    if (!proc || !proc.initSeen || proc.closing || st.inFlight) throw new Error(`session ${sessionId} is not idle`);
    await this.#writeBatch(st, proc, {
      messageIds,
      text: "",
      prefixes: [],
      rawLine: line,
      notes: NO_NOTES,
      delivered: false,
      processing: false,
    });
    return { kind: "written" };
  }

  end(sessionId: SessionId): Promise<void> {
    const st = this.#state(sessionId);
    if (st.ending) return st.ending;
    st.ended = true;
    st.pending = [];
    st.recoveryNote = false;
    st.crashNote = false;
    st.relaunchNote = false;
    this.#clearTimer(st, "idleTimer");
    st.ending = this.#finishEnd(st);
    return st.ending;
  }

  async #finishEnd(st: SessionState): Promise<void> {
    for (;;) {
      if (st.starting) {
        await st.starting.catch(() => {});
        continue;
      }
      const proc = st.proc;
      if (proc && this.#busy(st) && !proc.closing) {
        await new Promise<void>((resolve) => st.settleWaiters.push(resolve));
        continue;
      }
      break;
    }
    const proc = st.proc;
    if (proc) {
      this.#clearTimer(st, "idleTimer");
      if (!proc.closing) this.#closeStdin(st, proc, "idle");
      await proc.exited;
    }
    this.#update(st, { status: "ended", pid: null });
  }

  async interrupt(sessionId: SessionId): Promise<void> {
    const st = this.#sessions.get(sessionId);
    if (!st) return;
    // 停止 = agent 还没看到的用户消息都取消：先丢掉自己队列里的（系统消息留着，停止后照常发）
    const { kept, dropped } = dropUserEntries(st.pending);
    st.pending = kept;
    if (dropped.length > 0) this.#emit(st.id, { type: "message.cancelled", messageIds: dropped, reason: "stop", at: Date.now() });
    const proc = st.proc;
    if (!proc || !this.#busy(st) || proc.closing) return;
    st.stopRequested = true;
    st.turnInterrupted = true;
    const done = new Promise<void>((resolve) => st.interruptWaiters.push(resolve));
    if (st.interruptTimer === null) {
      this.#sigintForInterrupt(st, proc);
    }
    return done;
  }

  queryCommands(_sessionId: SessionId): Promise<ComposerCommand[] | null> {
    return Promise.resolve(null);
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    const procs: Proc[] = [];
    for (const st of this.#sessions.values()) {
      this.#clearTimer(st, "idleTimer");
      this.#clearTimer(st, "interruptTimer");
      const proc = st.proc;
      if (!proc) continue;
      procs.push(proc);
      clearKillTimer(proc);
      if (proc.closing === "shutdown" || proc.closing === "interrupt") continue;
      if (st.stopRequested && this.#busy(st)) {
        proc.closing = "interrupt";
        signalChild(proc.child, "SIGINT");
        continue;
      }
      const wasIdle = proc.closing === "idle" || (!this.#busy(st) && proc.initSeen);
      proc.closing = "shutdown";
      if (wasIdle) proc.child.stdin.end();
      else signalChild(proc.child, "SIGINT");
    }
    if (procs.length > 0) {
      const all = Promise.all(procs.map((p) => p.exited));
      if ((await within(all, this.#opts.shutdownGraceMs)) === "timeout") {
        await Promise.all(procs.map((p) => forceKill(p.child)));
        await within(all, KILL_WAIT_MS);
      }
    }
  }

  async cleanupStale(): Promise<void> {
    let rows: AgentSessionRow[];
    try {
      rows = this.#opts.store.listWithProcess();
    } catch (error) {
      throw new DriverError("internal_error", `listWithProcess failed: ${errorMessage(error)}`);
    }
    await Promise.all(rows.filter((row) => row.vendor === "agy").map((row) => this.#cleanupStaleRow(row)));
  }

  async #cleanupStaleRow(row: AgentSessionRow): Promise<void> {
    const pid = row.pid;
    if (pid === null) return;
    if (this.#sessions.get(row.id)?.proc?.child.pid === pid) return;
    const pgid = await agyOfSession(pid, row.vendorSessionId);
    if (pgid !== null) {
      const target = signalTarget(pid);
      if (target !== null) signalPid(target, "SIGINT");
      if (await waitForExit(pid, this.#opts.interruptGraceMs)) {
        if (pgid === pid) termGroupAfterExit({ pid });
      } else {
        await forceKillTree(pid, pgid === pid);
        await waitForExit(pid, KILL_WAIT_MS);
      }
    }
    this.#update(this.#state(row.id), { pid: null, status: row.status === "ended" ? "ended" : "idle" });
  }

  // --- 队列与批次 ---

  #state(id: SessionId): SessionState {
    let st = this.#sessions.get(id);
    if (!st) {
      st = {
        id,
        proc: null,
        inFlight: null,
        selfTurn: false,
        turnInterrupted: false,
        stopRequested: false,
        policyViolation: null,
        deniedContinues: 0,
        hasConversation: false,
        vendorSessionId: "",
        stepTexts: new Map(),
        seenToolSteps: new Set(),
        seenThinkingSteps: new Set(),
        hasTextSinceLastTool: false,
        resultSeq: 0,
        eventSeq: 0,
        pending: [],
        written: new Set(),
        personaSeen: null,
        preambleTaken: false,
        recoveryNote: false,
        crashNote: false,
        relaunchNote: false,
        ended: false,
        ending: null,
        settleWaiters: [],
        resumeHint: null,
        starting: null,
        startTimer: null,
        idleTimer: null,
        interruptTimer: null,
        interruptWaiters: [],
        lastEventWrite: 0,
        turnUsage: new TurnUsage(),
        lastLiveUsage: null,
        usageLatest: null,
        usagePushedAt: 0,
        usageTimer: null,
      };
      this.#sessions.set(id, st);
    }
    return st;
  }

  #isPending(st: SessionState, ids: MessageId[]): boolean {
    const covers = (batchIds: MessageId[]) => ids.every((id) => batchIds.includes(id));
    if (st.inFlight && covers(st.inFlight.messageIds)) return true;
    return st.pending.some((e) => covers(e.messageIds));
  }

  #takeBatch(st: SessionState): Batch | null {
    let body: { prefixes: string[]; text: string } | null = null;
    let messageIds: MessageId[] = [];
    let command = false;
    const users = st.pending.filter((e) => e.source === "user");
    if (users.length > 0) {
      const isCommand = (e: PendingEntry) => this.#composer.isCommand(e.text);
      const firstCommand = users.findIndex(isCommand);
      command = firstCommand === 0;
      const take = command ? users.slice(0, 1) : firstCommand === -1 ? users : users.slice(0, firstCommand);
      st.pending = st.pending.filter((e) => !take.includes(e));
      body = take.length === 1 ? entryParts(take[0]!) : mergeUserTexts(take.map(flatEntryText));
      messageIds = take.flatMap((e) => e.messageIds);
    } else if (st.pending.length > 0) {
      const entry = st.pending.shift()!;
      body = entryParts(entry);
      messageIds = entry.messageIds;
    }
    if (body === null) return null;
    if (command) {
      return {
        messageIds,
        text: body.text,
        prefixes: body.prefixes,
        notes: NO_NOTES,
        delivered: false,
        processing: false,
        source: "user",
      };
    }
    // 性格设定改了的说明只和现在这个进程比（没有进程、正在关的不比：新起的进程按最新的拼系统指令）
    const proc = st.proc && !st.proc.closing ? st.proc : null;
    const preamble = this.#takeSessionPreamble(st);
    const persona = proc ? this.#takePersonaNote(st) : null;
    const notes = { recovery: st.recoveryNote, crash: st.crashNote, relaunch: st.relaunchNote, persona, preamble };
    const notePrefixes = [
      preamble?.note ?? null,
      notes.recovery ? RESTART_RECOVERY_NOTE : null,
      notes.crash ? CRASH_RECOVERY_NOTE : null,
      notes.relaunch ? RELAUNCH_NOTE : null,
      persona?.note ?? null,
    ].filter((p): p is string => p !== null);
    st.recoveryNote = false;
    st.crashNote = false;
    st.relaunchNote = false;
    return {
      messageIds,
      text: body.text,
      prefixes: [...notePrefixes, ...body.prefixes],
      notes,
      delivered: false,
      processing: false,
      source: users.length > 0 ? "user" : "system",
    };
  }

  #dropBatch(st: SessionState, batch: Batch): void {
    if (st.inFlight === batch) st.inFlight = null;
    if (batch.notes.recovery) st.recoveryNote = true;
    if (batch.notes.crash) st.crashNote = true;
    if (batch.notes.relaunch) st.relaunchNote = true;
    batch.notes.persona?.restore();
    batch.notes.preamble?.restore();
  }

  #takeSessionPreamble(st: SessionState): PreambleTaken | null {
    return takeSessionPreamble(this.#opts.sessionPreamble, st.id, st, (error) =>
      this.#internalError(st.id, `sessionPreamble failed, writing without it: ${errorMessage(error)}`),
    );
  }

  #takePersonaNote(st: SessionState): PersonaNoteTaken | null {
    return takePersonaNote(
      this.#opts.personaNote,
      st.id,
      st,
      (revision) => this.#update(st, { personaRevision: revision }),
      (error) => this.#internalError(st.id, `personaNote failed, writing without it: ${errorMessage(error)}`),
    );
  }

  #setPersonaSeen(st: SessionState, revision: number | null): void {
    if (revision === null || revision === st.personaSeen) return;
    st.personaSeen = revision;
    this.#update(st, { personaRevision: revision });
  }

  /** 为指定进程构造要写入 stdin 的 NDJSON 行（若为该进程第一条消息，则在 prefixes 最前面注入系统提示词）。 */
  #buildLineForProc(proc: Proc, batch: Batch): string {
    if (batch.rawLine !== undefined) return batch.rawLine;
    const includePrompt = !proc.promptSent && proc.systemPrompt !== null;
    const prefixes = includePrompt ? [proc.systemPrompt!, ...batch.prefixes] : batch.prefixes;
    return buildAgyUserLine(batch.text, prefixes, this.#composer.buildUserContent);
  }

  async #pump(st: SessionState): Promise<void> {
    for (;;) {
      this.#assertRunning();
      this.#assertNotEnded(st);
      if (st.starting) return;
      const proc = st.proc;
      if (proc?.closing) {
        await proc.exited;
        continue;
      }
      if (proc && this.#busy(st)) return;
      if (st.pending.length === 0) return;
      if (proc) {
        await this.#deliverNext(st, proc);
        continue;
      }
      const batch = this.#takeBatch(st);
      if (!batch) return;
      return this.#runStartup(st, batch, null);
    }
  }

  #deliverNext(st: SessionState, proc: Proc): Promise<void> {
    const run = async () => {
      this.#clearTimer(st, "idleTimer");
      let files: LaunchFiles | null = null;
      try {
        files = await this.#opts.prepareLaunch(this.#store(st));
      } catch (error) {
        this.#internalError(st.id, `prepareLaunch before writing failed, keeping the running process: ${errorMessage(error)}`);
      }
      this.#assertRunning();
      if (st.ended || st.proc !== proc || proc.closing || this.#busy(st)) return;
      const row = files ? this.#row(st) : null;
      if (files && row && launchChanged(proc.launched, row, files.fingerprint)) {
        this.#closeStdin(st, proc, "idle");
        await proc.exited;
        this.#assertRunning();
        if (st.ended) return;
        st.relaunchNote = true;
        const batch = this.#takeBatch(st);
        if (batch) await this.#startup(st, batch, null, files);
        return;
      }
      const batch = this.#takeBatch(st);
      if (!batch) return;
      if (proc.initSeen) await this.#writeBatch(st, proc, batch);
      else await this.#startup(st, batch, proc, null);
    };
    const promise: Promise<void> = run().finally(() => {
      if (st.starting === promise) st.starting = null;
    });
    st.starting = promise;
    return promise;
  }

  async #writeBatch(st: SessionState, proc: Proc, batch: Batch): Promise<void> {
    const line = this.#buildLineForProc(proc, batch);
    const problem = checkAgyUserLine(line);
    if (problem) {
      this.#invalidInput(st, problem, batch.messageIds);
      this.#afterTurn(st, proc);
      return;
    }
    this.#clearTimer(st, "idleTimer");
    this.#resetTurnState(st, batch);
    proc.promptSent = true;
    await new Promise<void>((resolve) => {
      proc.child.stdin.write(line + "\n", (err) => {
        if (!err) this.#markDelivered(st, batch);
        resolve();
      });
    });
  }

  #resetTurnState(st: SessionState, batch: Batch | null): void {
    st.inFlight = batch;
    st.turnInterrupted = false;
    st.stopRequested = false;
    st.policyViolation = null;
    st.deniedContinues = 0;
    st.stepTexts.clear();
    st.seenToolSteps.clear();
    st.seenThinkingSteps.clear();
    st.hasTextSinceLastTool = false;
    st.lastLiveUsage = null;
  }

  #markDelivered(st: SessionState, batch: Batch): void {
    if (batch.delivered) return;
    batch.delivered = true;
    for (const id of batch.messageIds) st.written.add(id);
    if (batch.messageIds.length > 0) this.#emit(st.id, { type: "message.delivered", messageIds: batch.messageIds, at: Date.now() });
  }

  /** 这条要重发：不再算写过；带着的性格设定说明也退回去（新进程会重新带系统指令的话，restore 发现版本已经变了就不退）。 */
  #forgetWritten(st: SessionState, batch: Batch | null): void {
    for (const id of batch?.messageIds ?? []) st.written.delete(id);
    batch?.notes.persona?.restore();
    batch?.notes.preamble?.restore();
  }

  #afterTurn(st: SessionState, proc: Proc): void {
    if (st.proc !== proc || proc.closing || this.#shuttingDown || st.ended) return;
    if (st.pending.length > 0) void this.#deliverNext(st, proc).catch(() => {});
    else this.#armIdle(st, proc);
  }

  #busy(st: SessionState): boolean {
    return st.inFlight !== null || st.selfTurn;
  }

  #settled(st: SessionState): void {
    for (const w of st.settleWaiters.splice(0)) w();
  }

  #armIdle(st: SessionState, proc: Proc): void {
    this.#clearTimer(st, "idleTimer");
    st.idleTimer = setTimeout(() => {
      st.idleTimer = null;
      if (st.proc !== proc || proc.closing || this.#busy(st) || st.pending.length > 0 || st.starting || st.ended) return;
      this.#closeStdin(st, proc, "idle");
    }, this.#opts.idleCloseMs);
  }

  #closeStdin(st: SessionState, proc: Proc, reason: ClosingReason): void {
    proc.closing = reason;
    proc.child.stdin.end();
    const grace = this.#opts.interruptGraceMs;
    clearKillTimer(proc);
    proc.killTimer = setTimeout(() => {
      signalChild(proc.child, "SIGINT");
      proc.killTimer = setTimeout(() => {
        proc.killTimer = null;
        this.#forceKill(st, proc);
      }, grace);
    }, grace);
  }

  #sigintForInterrupt(st: SessionState, proc: Proc): void {
    if (st.proc !== proc || proc.closing) return;
    proc.closing = "interrupt";
    signalChild(proc.child, "SIGINT");
    this.#clearTimer(st, "interruptTimer");
    st.interruptTimer = setTimeout(() => {
      st.interruptTimer = null;
      this.#forceKill(st, proc);
    }, this.#opts.interruptGraceMs);
  }

  // --- 启动 ---

  /** 是否应当传 --conversation <vendorSessionId> 恢复会话。 */
  #resumeFor(st: SessionState): boolean {
    if (st.resumeHint !== null) return st.resumeHint;
    const row = this.#store(st);
    return (st.hasConversation || row.hasCompletedTurn) && row.vendorSessionId.trim() !== "";
  }

  #runStartup(st: SessionState, batch: Batch, existing: Proc | null): Promise<void> {
    const promise: Promise<void> = this.#startup(st, batch, existing, null).finally(() => {
      if (st.starting === promise) st.starting = null;
    });
    st.starting = promise;
    return promise;
  }

  #startup(st: SessionState, batch: Batch, existing: Proc | null, files: LaunchFiles | null): Promise<void> {
    this.#resetTurnState(st, batch);
    const run = async () => {
      let proc = existing;
      try {
        let resume = proc?.resume ?? this.#resumeFor(st);
        for (let attempt = 0; ; attempt++) {
          if (!proc) {
            proc = await this.#spawn(st, resume, files);
            this.#abortIfStopped(st, proc);
          }
          this.#clearTimer(st, "idleTimer");
          st.inFlight = batch;
          const line = this.#buildLineForProc(proc, batch);
          proc.promptSent = true;
          proc.child.stdin.write(line + "\n");
          this.#armStartTimer(st, proc);
          const outcome = await proc.ready;
          if (outcome.kind === "ok") return;
          if (outcome.kind === "closed") {
            if (outcome.reason === "interrupt") return;
            throw new DriverError("spawn_failed", this.#shuttingDown ? "driver is shutting down" : `closed before init (${outcome.reason})`);
          }
          proc = null;
          if (outcome.conflict === "no_conversation" && resume && attempt === 0 && !outcome.timedOut) {
            // --conversation 找不到对话：回退为不带 --conversation 重新启动一次
            resume = false;
            st.hasConversation = false;
            continue;
          }
          throw startupError(outcome, this.#opts.startTimeoutMs, attempt > 0);
        }
      } catch (error) {
        this.#dropBatch(st, batch);
        throw error;
      }
    };
    return run();
  }

  #abortIfStopped(st: SessionState, proc: Proc): void {
    this.#assertRunning();
    if (!st.ended) return;
    if (!proc.closing) this.#closeStdin(st, proc, "idle");
    throw new DriverError("session_ended", `session ${st.id} has been ended`);
  }

  #armStartTimer(st: SessionState, proc: Proc): void {
    if (st.startTimer || proc.initSeen) return;
    st.startTimer = setTimeout(() => {
      st.startTimer = null;
      if (st.proc !== proc || proc.initSeen) return;
      proc.startTimedOut = true;
      this.#forceKill(st, proc);
    }, this.#opts.startTimeoutMs);
  }

  /** 只读 Worker 起进程前问的连接器清单；问崩了（不该发生）当空清单：规则里没有 mcp 的拒绝，全靠工具开始调用时的兜底检查（清单里查不到的都当非只读，打断）。 */
  async #catalogFor(policy: ReadonlyPolicy): Promise<AgyConnectorCatalog> {
    // 问清单要起 stdio 服务器：和 Worker 同样包外层只读沙箱、用 Worker 的环境（去掉 HUB_*），没有 OS 沙箱就不问
    const homeDir = this.#opts.homeDir ?? homedir();
    const wrap = this.#opts.readonlySpawn ?? ((base, input) => wrapInReadonlyOsSandbox(base, input));
    this.#latestReadonlyPolicy = policy;
    this.#connectorCatalog ??=
      this.#opts.connectorCatalog ??
      createAgyConnectorResolver({
        homeDir,
        launcher: (base, extraEnv) =>
          createReadonlyProbeLauncher({
            policy: this.#latestReadonlyPolicy ?? policy,
            homeDir,
            baseEnv: process.env,
            extraEnv: this.#opts.env,
            wrap,
          })(base, extraEnv),
      });
    try {
      return await this.#connectorCatalog();
    } catch (error) {
      this.#opts.log(`[agy] 问连接器清单失败，只读 Worker 靠兜底检查拦非只读的连接器：${errorMessage(error)}`);
      return EMPTY_AGY_CONNECTOR_CATALOG;
    }
  }

  async #spawn(st: SessionState, resume: boolean, prepared: LaunchFiles | null): Promise<Proc> {
    let row = this.#store(st);
    let files = prepared;
    if (!files) {
      try {
        files = await this.#opts.prepareLaunch(row);
      } catch (error) {
        if (error instanceof DriverError && error.code === "session_ended") throw error;
        throw new DriverError("spawn_failed", `prepareLaunch failed: ${errorMessage(error)}`);
      }
      row = this.#store(st);
    }
    this.#assertRunning();
    this.#assertNotEnded(st);
    if (!existsSync(row.cwd)) throw new DriverError("spawn_failed", `working directory does not exist: ${row.cwd}`);

    const systemPrompt = readSystemInstructions(files.promptFile);

    // 只读 Worker：先扫描一次 [row.cwd, ...row.addDirs] 下的 secretGlobs 并入 secretPaths（连接器探测与 agyReadonlySandboxInput 复用同一次结果），
    // 再问清连接器哪些只读（拒绝规则要写进 --settings），最后包外层只读沙箱（没有 OS 沙箱直接报错，设计第 8 节第 5 条）
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
    );
    let tmpDir: string | null = null;
    let launch: ScopedSpawn;
    let childEnv = { ...this.#opts.env, ...files.env };
    if (readonlyPolicy === undefined) {
      // Worker 的可写范围：包一层 OS 沙箱（write-scope.ts），编辑工具和 shell 都在里面；没有 OS 沙箱直接报错拒绝启动
      launch = spawnInWriteScope("agy", { command: this.#agyPath, args }, files.writeScope ?? null, this.#opts.log, `session ${st.id}`);
    } else {
      const home = realpathSync(this.#opts.homeDir ?? homedir());
      const wrap = this.#opts.readonlySpawn ?? ((base, input) => wrapInReadonlyOsSandbox(base, input));
      // 每个会话一个私有临时目录（TMPDIR 指到这，进程退出时删）：git、编译器、shell 要用，其余地方都不能写
      const privateTmp = mkdtempSync(join(realpathSync(tmpdir()), "agent-hub-ro-"));
      launch = wrap({ command: this.#agyPath, args }, agyReadonlySandboxInput({ homeDir: home, tmpDir: privateTmp, policy: readonlyPolicy }));
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
    const child = spawn(launch.command, launch.args, {
      cwd: row.cwd,
      env: buildChildEnv(process.env, childEnv),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } catch (error) {
      removeTmp();
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new DriverError(notFoundCode("agy"), `${this.#agyPath}: ${errorMessage(error)}`);
      throw new DriverError("spawn_failed", `${this.#agyPath}: ${errorMessage(error)}`);
    }
    if (this.#shuttingDown) {
      killFreshGroup(child);
      removeTmp();
      this.#assertRunning();
    }

    let resolveReady!: (o: StartupOutcome) => void;
    let resolveExited!: () => void;
    const proc: Proc = {
      child,
      resume,
      launched: {
        fingerprint: files.fingerprint,
        cwd: row.cwd,
        addDirs: [...row.addDirs],
        model: row.model,
        effort: row.effort,
      },
      personaLaunched: files.personaRevision ?? null,
      systemPrompt,
      promptSent: false,
      readonly: readonlyPolicy === undefined || catalog === null ? null : { policy: readonlyPolicy, catalog },
      tmpDir,
      fallbackScope: readonlyPolicy === undefined && !launch.osSandboxed ? (files.writeScope ?? null) : null,
      initSeen: false,
      stderr: "",
      closing: null,
      startTimedOut: false,
      killTimer: null,
      ready: new Promise((resolve) => (resolveReady = resolve)),
      resolveReady: (o) => resolveReady(o),
      exited: new Promise((resolve) => (resolveExited = resolve)),
    };
    st.proc = proc;
    this.#update(st, { pid: child.pid ?? null });

    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      proc.stderr = (proc.stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });

    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      for (let nl = buffered.indexOf("\n"); nl >= 0; nl = buffered.indexOf("\n")) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        this.#handleLine(st, proc, line);
      }
    });

    const drained = Promise.all([streamClosed(child.stdout), streamClosed(child.stderr)]);
    child.once("exit", (code, signal) => {
      removeTmp();
      if (proc.closing === "idle") termGroupAfterExit(child);
      const timer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, STDIO_DRAIN_MS);
      void drained.then(() => {
        clearTimeout(timer);
        if (buffered !== "") this.#handleLine(st, proc, buffered);
        buffered = "";
        this.#onClose(st, proc, code, signal, resolveExited);
      });
    });
    return proc;
  }

  // --- 输出解析 ---

  #handleLine(st: SessionState, proc: Proc, rawLine: string): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    try {
      this.#onLine(st, proc, line);
    } catch (error) {
      this.#internalError(st.id, `handling output line failed: ${errorMessage(error)}`);
    }
  }

  #onLine(st: SessionState, proc: Proc, line: string): void {
    if (line.trim() === "") return;
    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      obj = parsed as Record<string, unknown>;
    } catch {
      this.#emit(st.id, { type: "driver.error", code: "bad_output_line", message: `bad_output_line: ${line.slice(0, 200)}`, at: Date.now() });
      return;
    }
    const at = Date.now();
    this.#touch(st, at);

    const eventType = obj.event ?? obj.type;
    switch (eventType) {
      case "init":
        this.#onInit(st, proc, obj, at);
        return;
      case "step_update":
        this.#onStepUpdate(st, proc, obj, at);
        return;
      case "result":
        this.#onResult(st, proc, obj, at);
        return;
    }
  }

  #markProcessing(st: SessionState, batch: Batch, at: number): void {
    this.#markDelivered(st, batch);
    if (batch.processing || batch.messageIds.length === 0) return;
    batch.processing = true;
    this.#emit(st.id, { type: "message.processing", messageIds: batch.messageIds, ...(batch.notes.preamble ? { preamble: true as const } : {}), at });
  }

  #conversationIdOf(st: SessionState): string {
    if (st.vendorSessionId !== "") return st.vendorSessionId;
    return this.#row(st)?.vendorSessionId ?? String(st.id);
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
        this.#emit(st.id, {
          type: "agent.text",
          uuid: `agy-step-${convId}-${turnNo}-${stepId}-${++st.eventSeq}`,
          text,
          at,
        });
      }
    }
  }

  #onInit(st: SessionState, proc: Proc, obj: Record<string, unknown>, at: number): void {
    const initObj = typeof obj.init === "object" && obj.init !== null ? (obj.init as Record<string, unknown>) : undefined;
    const rawConvId = initObj?.conversation_id ?? obj.conversation_id;
    const convId = typeof rawConvId === "string" && rawConvId.trim() !== "" ? rawConvId.trim() : "";
    if (proc.initSeen) {
      if (convId !== "" && convId !== st.vendorSessionId) {
        st.vendorSessionId = convId;
        st.hasConversation = true;
        this.#update(st, { vendorSessionId: convId, lastEventAt: at });
      }
      if (!st.inFlight && !st.selfTurn && st.proc === proc) {
        st.selfTurn = true;
        this.#clearTimer(st, "idleTimer");
        this.#emit(st.id, { type: "turn.started", at });
      }
      return;
    }
    proc.initSeen = true;
    this.#clearTimer(st, "startTimer");
    const row = this.#row(st);
    // 新进程第一条消息前面重新带系统指令，里面就是这次拼的性格设定（persona-note.ts）；真起来了才算数
    this.#setPersonaSeen(st, personaSeenAtStart(st, row, proc.personaLaunched, true));
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
    this.#update(st, patch);
    const startedEvent = buildAgySessionStartedEvent(obj, this.#row(st) ?? row, proc.resume, at);
    this.#emit(st.id, startedEvent);
    if (st.inFlight) this.#markDelivered(st, st.inFlight);
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

    if (stepType === "user_input") {
      if (su.state === "DONE" && st.inFlight) {
        this.#markProcessing(st, st.inFlight, at);
      }
      return;
    }

    if (stepType === "agent_response") {
      if (st.inFlight) this.#markProcessing(st, st.inFlight, at);
      // 如果切换到新的 step_id，先把之前 step_id 累积的文字发出去
      this.#flushStepTexts(st, at, stepId);

      if (typeof su.text_delta === "string" && su.text_delta !== "") {
        st.stepTexts.set(stepId, (st.stepTexts.get(stepId) ?? "") + su.text_delta);
      } else if (typeof su.text === "string" && su.text !== "" && !st.stepTexts.has(stepId)) {
        st.stepTexts.set(stepId, su.text);
      }

      if (typeof su.usage === "object" && su.usage !== null) {
        const row = this.#row(st);
        const live = row ? observeAgyUsage(st.turnUsage, stepId, su.usage, row.usage) : null;
        if (live) {
          st.lastLiveUsage = live;
          this.#pushUsage(st, live);
        }
      }

      if (su.state === "DONE") {
        this.#flushStepTexts(st, at);
      }
      return;
    }

    if (stepType === "thinking") {
      if (st.inFlight) this.#markProcessing(st, st.inFlight, at);
      if (!st.seenThinkingSteps.has(stepId)) {
        st.seenThinkingSteps.add(stepId);
        this.#emit(st.id, {
          type: "agent.thinking",
          uuid: `agy-thinking-${this.#conversationIdOf(st)}-${turnNo}-${stepId}-${++st.eventSeq}`,
          at,
        });
      }
      return;
    }

    if (stepType === "tool") {
      if (st.inFlight) this.#markProcessing(st, st.inFlight, at);
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

      if (su.state === "ACTIVE" || !st.seenToolSteps.has(stepId)) {
        st.seenToolSteps.add(stepId);
        const row = this.#row(st);
        const convId = this.#conversationIdOf(st);

        this.#emit(st.id, {
          type: "agent.tool",
          uuid: `agy-tool-${convId}-${turnNo}-${stepId}-${++st.eventSeq}`,
          toolUseId,
          name: toolName,
          input: parameters,
          at,
        });

        if (row?.role === "worker") {
          // 连接器兜底：只读 Worker 调了不在放行范围的 MCP 工具，马上打断（规则是第一道，这里管规则没拦住的）
          const violation =
            checkWorkerToolViolation({ toolName, parameters, fallbackScope: proc.fallbackScope, cwd: row.cwd }) ??
            (proc.readonly === null ? null : checkAgyConnectorCall(toolName, parameters, proc.readonly.policy, proc.readonly.catalog));
          if (violation !== null) {
            st.policyViolation = violation;
            this.#sigintForInterrupt(st, proc);
            return;
          }
        }
      }

      if (su.state === "DONE") {
        this.#emit(st.id, {
          type: "agent.tool_result",
          toolUseIds: [toolUseId],
          at,
        });
      }
    }
  }

  #onResult(st: SessionState, proc: Proc, obj: Record<string, unknown>, at: number): void {
    const res =
      typeof obj.result === "object" && obj.result !== null
        ? (obj.result as Record<string, unknown>)
        : obj;
    if (!proc.initSeen) {
      const preInitErr = typeof res.error === "string" ? res.error : typeof obj.error === "string" ? obj.error : "";
      if (preInitErr !== "") proc.stderr = (proc.stderr + "\n" + preInitErr).slice(-STDERR_TAIL_CHARS);
      return;
    }

    const rawConvId = res.conversation_id ?? obj.conversation_id;
    const convId = typeof rawConvId === "string" && rawConvId.trim() !== "" ? rawConvId.trim() : "";
    if (convId !== "" && convId !== st.vendorSessionId) {
      st.vendorSessionId = convId;
      st.hasConversation = true;
    }

    const finishedReason = typeof res.finished_reason === "string" ? res.finished_reason : null;
    const rawInterrupted = finishedReason === "interrupted" || st.turnInterrupted || st.stopRequested;
    if (!rawInterrupted && this.#continueAfterDenial(st, proc, res, obj, at)) return;
    const written = st.inFlight;
    st.inFlight = null;
    st.selfTurn = false;
    // 停止时 agy 还没取走（没出 user_input）：agent 没看到过，标已取消，不算这一轮的
    const untaken = rawInterrupted && written !== null && !written.processing ? written : null;
    const batch = untaken === null ? written : null;
    if (batch) this.#markProcessing(st, batch, at);

    // 先把残余的 step_update 文本冲刷出去
    this.#flushStepTexts(st, at);

    // 如果这一步还没有发出过最终回复文字且 result.response 非空，补发一条 agent.text
    const turnNo = ++st.resultSeq;
    if (!st.hasTextSinceLastTool && st.policyViolation === null && typeof res.response === "string" && res.response.trim() !== "") {
      this.#emit(st.id, {
        type: "agent.text",
        uuid: `agy-result-${this.#conversationIdOf(st)}-${turnNo}-${++st.eventSeq}`,
        text: res.response,
        at,
      });
    }

    const violation = st.policyViolation;
    st.policyViolation = null;

    if (rawInterrupted && proc.closing === null) {
      // agy 在输出 finished_reason: "interrupted" 后会退出（exit code 1），标为 interrupt 避免当成 crash
      proc.closing = "interrupt";
    }

    const interrupted = violation !== null ? false : rawInterrupted;
    const status = typeof res.status === "string" ? res.status : "SUCCESS";
    const ok = violation === null && status === "SUCCESS" && !interrupted;

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
      this.#forgetWritten(st, batch);
    }

    st.turnInterrupted = false;
    st.stopRequested = false;
    st.stepTexts.clear();
    st.seenToolSteps.clear();
    st.seenThinkingSteps.clear();
    st.hasTextSinceLastTool = false;

    this.#settleUsage(st, res, obj);

    this.#clearTimer(st, "interruptTimer");
    this.#emit(st.id, event);
    if (untaken !== null) this.#releaseOnStop(st, untaken, at);
    this.#resolveInterrupt(st);
    this.#afterTurn(st, proc);
    this.#settled(st);
  }

  /** 一次 result 的用量结算：更新会话的累计、标记完成过一轮。 */
  #settleUsage(st: SessionState, res: Record<string, unknown>, obj: Record<string, unknown>): void {
    const row = this.#row(st);
    this.#cancelUsagePush(st);
    const finalUsage = finishAgyUsage(st.turnUsage, row?.usage ?? EMPTY_TOKEN_USAGE, res.usage ?? obj.usage, st.lastLiveUsage);
    st.lastLiveUsage = null;
    const patch: AgentSessionPatch = { usage: finalUsage };
    if (row?.hasCompletedTurn === false) patch.hasCompletedTurn = true;
    this.#update(st, patch);
  }

  /**
   * agy 无头模式下遇到“要批准”的操作会自动拒绝，常常整轮直接结束、回复为空（result.denied_actions 非空）。
   * 这时不结束这一轮：往同一个进程补发一条“上一步被拒了，换办法继续”，还是原来那条消息的这一轮（最多 AGY_DENIED_CONTINUE_MAX 次，用户发新消息重新数）。
   * 返回 true 表示已经补发、result 不再当这一轮的结束处理。
   */
  #continueAfterDenial(st: SessionState, proc: Proc, res: Record<string, unknown>, obj: Record<string, unknown>, at: number): boolean {
    const denied = deniedActionsOf(res);
    const status = typeof res.status === "string" ? res.status : "SUCCESS";
    const blank = typeof res.response !== "string" || res.response.trim() === "";
    if (denied.length === 0 || !blank || status !== "SUCCESS" || st.policyViolation !== null) return false;
    if (st.inFlight === null || st.ended || proc.closing !== null || st.proc !== proc || this.#shuttingDown) return false;
    if (st.deniedContinues >= AGY_DENIED_CONTINUE_MAX) return false;
    const line = buildAgyUserLine(deniedContinueText(denied), [], this.#composer.buildUserContent);
    if (checkAgyUserLine(line) !== null) return false;
    st.deniedContinues++;
    this.#flushStepTexts(st, at);
    st.resultSeq++;
    this.#settleUsage(st, res, obj);
    st.stepTexts.clear();
    st.seenToolSteps.clear();
    st.seenThinkingSteps.clear();
    st.hasTextSinceLastTool = false;
    proc.child.stdin.write(line + "\n");
    return true;
  }

  #onClose(st: SessionState, proc: Proc, code: number | null, signal: NodeJS.Signals | null, resolveExited: () => void): void {
    try {
      if (st.proc === proc) st.proc = null;
      clearKillTimer(proc);
      this.#clearTimer(st, "startTimer");
      this.#clearTimer(st, "idleTimer");
      this.#clearTimer(st, "interruptTimer");
      this.#flushUsage(st);
      st.turnUsage.reset();
      st.lastLiveUsage = null;
      this.#update(st, { pid: null, status: "idle", lastEventAt: Date.now() });
      const at = Date.now();

      if (!proc.initSeen) {
        if (proc.closing === null) {
          const conflict = detectAgyArgsConflict(proc.stderr);
          if (conflict === "no_conversation" && !st.inFlight) {
            st.resumeHint = false;
            st.hasConversation = false;
          }
          this.#forgetWritten(st, st.inFlight);
          proc.resolveReady({ kind: "failed", exitCode: code, signal, stderr: proc.stderr, conflict, timedOut: proc.startTimedOut });
          this.#emit(st.id, { type: "session.exited", reason: "startup_failed", exitCode: code, signal, hadResult: false, messageIds: [], at });
          return;
        }
        if (proc.closing === "interrupt" && st.inFlight) this.#markDelivered(st, st.inFlight);
        proc.resolveReady({ kind: "closed", reason: proc.closing });
      }

      // 如果因为 Worker 权限违规发了 SIGINT，且进程在发出 result 前就直接退出了，补发一条失败的 turn.ended
      const hadInFlight = st.inFlight !== null;
      if (proc.initSeen && st.policyViolation !== null && st.inFlight !== null) {
        const batch = st.inFlight;
        const violation = st.policyViolation;
        st.inFlight = null;
        st.selfTurn = false;
        st.policyViolation = null;
        this.#markProcessing(st, batch, at);
        this.#forgetWritten(st, batch);
        this.#emit(st.id, {
          type: "turn.ended",
          ok: false,
          interrupted: false,
          messageIds: batch.messageIds,
          durationMs: null,
          error: { subtype: "policy_violation", message: violation },
          at,
        });
      }

      const batch = proc.initSeen || proc.closing === "interrupt" ? st.inFlight : null;
      if (hadInFlight) st.resultSeq++;
      st.inFlight = null;
      st.selfTurn = false;
      st.policyViolation = null;
      st.stepTexts.clear();
      st.seenToolSteps.clear();
      st.seenThinkingSteps.clear();
      st.hasTextSinceLastTool = false;

      const reason: SessionExitReason = proc.closing ?? "crash";
      if (batch && reason === "crash") {
        st.crashNote = true;
        this.#forgetWritten(st, batch);
      }
      st.stopRequested = false;
      // 用户点停止、进程退出时 agy 还没取走（没出 user_input）：agent 没看到过，和别家一样标已取消（不是“这一轮被打断”）
      const untaken = reason === "interrupt" && proc.initSeen && batch !== null && !batch.processing ? batch : null;
      const taken = untaken === null ? batch : null;
      this.#emit(st.id, {
        type: "session.exited",
        reason,
        exitCode: code,
        signal,
        hadResult: taken === null,
        messageIds: taken?.messageIds ?? [],
        at,
      });
      if (untaken !== null) this.#releaseOnStop(st, untaken, at);
    } finally {
      this.#resolveInterrupt(st);
      resolveExited();
      this.#settled(st);
      if (st.pending.length > 0 && !this.#shuttingDown && !st.ended) {
        void this.#pump(st).catch(() => {});
      }
    }
  }

  /** 停止时 agy 还没取走的那条：用户的标已取消，不重发；系统的收回，账本重新登记发送（stop-untaken.ts）。 */
  #releaseOnStop(st: SessionState, batch: Batch, at: number): void {
    const source = batch.source ?? "user";
    if (source === "system") this.#forgetWritten(st, batch);
    // 用户的那条标已取消、不重发，但带着的换代开场说明 agent 没看到：退回去，下一行再带
    else batch.notes.preamble?.restore();
    for (const event of untakenOnStopEvents([{ messageIds: batch.messageIds, source }], at)) this.#emit(st.id, event);
  }

  // --- 辅助方法 ---

  #resolveInterrupt(st: SessionState): void {
    for (const w of st.interruptWaiters.splice(0)) w();
  }

  #invalidInput(st: SessionState, problem: string, messageIds: MessageId[]): void {
    this.#emit(st.id, { type: "driver.error", code: "invalid_input", message: `invalid_input: ${problem}`, messageIds, at: Date.now() });
  }

  #forceKill(st: SessionState, proc: Proc): void {
    forceKill(proc.child).catch((error: unknown) => this.#internalError(st.id, `force kill failed: ${errorMessage(error)}`));
  }

  #internalError(sessionId: SessionId, detail: string): void {
    this.#emit(sessionId, { type: "driver.error", code: "internal_error", message: `internal_error: ${detail}`, at: Date.now() });
  }

  #store(st: SessionState): AgentSessionRow {
    let row: AgentSessionRow | null;
    try {
      row = this.#opts.store.get(st.id);
    } catch (error) {
      throw new DriverError("internal_error", `reading agent session ${st.id} failed: ${errorMessage(error)}`);
    }
    if (!row) throw new DriverError("internal_error", `no agent session ${st.id}`);
    return row;
  }

  #row(st: SessionState): AgentSessionRow | null {
    try {
      return this.#store(st);
    } catch (error) {
      this.#internalError(st.id, errorMessage(error));
      return null;
    }
  }

  #update(st: SessionState, patch: AgentSessionPatch): void {
    if (patch.lastEventAt !== undefined && patch.lastEventAt !== null) st.lastEventWrite = patch.lastEventAt;
    try {
      this.#opts.store.update(st.id, patch);
    } catch (error) {
      this.#internalError(st.id, `updating agent session ${st.id} failed: ${errorMessage(error)}`);
    }
  }

  #pushUsage(st: SessionState, usage: TokenUsage): void {
    st.usageLatest = usage;
    const wait = USAGE_PUSH_MS - (Date.now() - st.usagePushedAt);
    if (wait <= 0) this.#flushUsage(st);
    else if (st.usageTimer === null) {
      st.usageTimer = setTimeout(() => this.#flushUsage(st), wait);
      st.usageTimer.unref();
    }
  }

  #flushUsage(st: SessionState): void {
    const usage = st.usageLatest;
    this.#cancelUsagePush(st);
    if (usage === null) return;
    st.usagePushedAt = Date.now();
    this.#update(st, { usage });
  }

  #cancelUsagePush(st: SessionState): void {
    if (st.usageTimer) clearTimeout(st.usageTimer);
    st.usageTimer = null;
    st.usageLatest = null;
  }

  #touch(st: SessionState, at: number): void {
    if (at - st.lastEventWrite >= LAST_EVENT_WRITE_MS) this.#update(st, { lastEventAt: at });
  }

  #clearTimer(st: SessionState, key: "startTimer" | "idleTimer" | "interruptTimer"): void {
    const timer = st[key];
    if (timer) clearTimeout(timer);
    st[key] = null;
  }

  #emit(sessionId: SessionId, event: DriverEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(sessionId, event);
      } catch (error) {
        this.#listenerFailed(sessionId, event, error);
      }
    }
  }

  #listenerFailed(sessionId: SessionId, event: DriverEvent, error: unknown): void {
    const detail = `listener threw on ${event.type}: ${errorMessage(error)}`;
    if (this.#reportingListenerError) {
      console.error(`[agy-driver] session ${sessionId}: ${detail}`);
      return;
    }
    this.#reportingListenerError = true;
    try {
      this.#internalError(sessionId, detail);
    } finally {
      this.#reportingListenerError = false;
    }
  }

  #assertRunning(): void {
    if (this.#shuttingDown) throw new DriverError("spawn_failed", "driver is shutting down");
  }

  #assertNotEnded(st: SessionState): void {
    if (st.ended || this.#store(st).status === "ended") {
      throw new DriverError("session_ended", `session ${st.id} has been ended`);
    }
  }
}

export function createAgyDriver(options: AgyDriverOptions): AgyDriver {
  return new AgyDriver(options);
}

function entryParts(entry: PendingEntry): { prefixes: string[]; text: string } {
  return { prefixes: entry.resend ? [RESEND_NOTE, ...entry.prefixes] : entry.prefixes, text: entry.text };
}

function flatEntryText(entry: PendingEntry): string {
  const text = [...entry.prefixes, entry.text].join("\n");
  return entry.resend ? `${RESEND_NOTE}\n\n${text}` : text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resultErrorMessage(res: Record<string, unknown>, obj: Record<string, unknown>, subtype: string): string {
  if (typeof res.error === "string" && res.error !== "") return res.error;
  if (typeof obj.error === "string" && obj.error !== "") return obj.error;
  if (typeof res.response === "string" && res.response !== "") return res.response;
  return subtype;
}

function startupError(outcome: Extract<StartupOutcome, { kind: "failed" }>, startTimeoutMs: number, retried: boolean): DriverError {
  if (outcome.timedOut) return new DriverError("start_timeout", `no init within ${startTimeoutMs} ms`);
  const how = outcome.signal ? `signal ${outcome.signal}` : `exit code ${outcome.exitCode}`;
  const stderr = outcome.stderr.trim();
  if (outcome.conflict) {
    return new DriverError("start_args_conflict", `${retried ? "after retrying without --conversation: " : ""}${stderr || how}`);
  }
  return new DriverError("spawn_failed", `agy exited before init (${how})${stderr ? `: ${stderr}` : ""}`);
}

function clearKillTimer(proc: Proc): void {
  if (proc.killTimer) clearTimeout(proc.killTimer);
  proc.killTimer = null;
}

async function within(promise: Promise<unknown>, ms: number): Promise<"done" | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([promise.then(() => "done" as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function launchChanged(launched: LaunchSnapshot, row: AgentSessionRow, fingerprint: string): boolean {
  return (
    launched.fingerprint !== fingerprint ||
    launched.cwd !== row.cwd ||
    launched.model !== row.model ||
    launched.effort !== row.effort ||
    launched.addDirs.length !== row.addDirs.length ||
    launched.addDirs.some((d, i) => d !== row.addDirs[i])
  );
}
