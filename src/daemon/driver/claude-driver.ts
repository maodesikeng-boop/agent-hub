// Claude 驱动层（设计第 7.2～7.4 节，按 M0 改过的做法）：每个会话一个官方 claude 进程，
// 我们这边管待发队列（一轮一条、忙时用户连发拼成一条、写入前校验）、打断、空闲关闭、--session-id / --resume。
// 一轮中途写入（docs/mid-turn-messages.md 第 5 节）：init 里有 MID_TURN_CAPABILITIES 时，忙着也直接把 user 行（带 uuid）写进去，
// claude 在当前工具跑完后同一轮读到；用 command_lifecycle 对账“被取走”（处理中），在途的是一个集合。待发队列只留写不了的情况。
// M2：每个会话自己的环境变量；两轮之间设置变了自动重启（--resume）；end；claude 起在自己的进程组里，强制结束连同它所有后代所在的进程组（process.ts 的 forceKill）。
// 驱动层自己出的错（写库、写日志、监听者抛错）不往上冒，记成 driver.error(internal_error)。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  BACKGROUND_TASKS_HOLD_MAX_MS,
  CRASH_RECOVERY_NOTE,
  DriverError,
  IDLE_CLOSE_MS,
  INTERRUPT_GRACE_MS,
  KILL_WAIT_MS,
  EMPTY_TOKEN_USAGE,
  LAST_EVENT_WRITE_MS,
  USAGE_PUSH_MS,
  RELAUNCH_NOTE,
  backgroundTasksKilledNote,
  RESEND_NOTE,
  RESTART_RECOVERY_NOTE,
  SHUTDOWN_GRACE_MS,
  STDERR_TAIL_CHARS,
  START_TIMEOUT_MS,
  STDIO_DRAIN_MS,
  RUNNING_COMMANDS_TIMEOUT_MS,
  NO_MID_TURN,
  type AgentSessionPatch,
  type ComposerCommand,
  type AgentSessionRow,
  type Driver,
  type DriverEvent,
  type TokenUsage,
  type DriverEventListener,
  type DriverOptions,
  type DriverSendInput,
  type DriverSendResult,
  type LaunchFiles,
  type MessageId,
  type MessageSource,
  type MidTurnSupport,
  type SessionExitReason,
  type SessionId,
  type Unsubscribe,
} from "../../shared/index.ts";
import {
  CLAUDE_MID_TURN,
  MID_TURN_CAPABILITIES,
  buildChildEnv,
  buildClaudeArgs,
  buildInitializeLine,
  buildInterruptLine,
  buildUserLine,
  checkUserLine,
  detectArgsConflict,
  interruptCancelled,
  isInterruptMarker,
  mergeUserTexts,
  parseApiRetry,
  parseAssistant,
  parseCapabilities,
  parseLifecycle,
  parseToolResults,
  parseRateLimit,
  lineUuid,
} from "./protocol.ts";
import { composerBaseOf, type VendorComposerBase } from "../vendors/index.ts";
import { TurnUsage } from "./usage.ts";
import { BackgroundTasks, idleDelayMs } from "./background-tasks.ts";
import { claudeOfSession, forceKill, forceKillTree, killFreshGroup, signalPid, streamClosed, termGroupAfterExit, waitForExit } from "./process.ts";

interface PendingEntry {
  messageIds: MessageId[];
  source: MessageSource;
  /** 用户原文（DriverSendInput.text）。 */
  text: string;
  /** 调用方加的标签（DriverSendInput.prefixes）。 */
  prefixes: string[];
  resend: boolean;
}

/** 写进去（或正要写）的一行，等它的 result。 */
interface Batch {
  messageIds: MessageId[];
  line: string;
  /** 写在这一行里的 uuid：claude 的 command_lifecycle 用它（command_uuid）告诉我们这一行排着、被取走、做完、被取消。 */
  uuid: string;
  notes: { recovery: boolean; crash: boolean; relaunch: boolean; killed: string | null };
  delivered: boolean;
  processing: boolean;
  /** 收到这一行的 command_lifecycle started：claude 取走了（模型看到了）。 */
  started: boolean;
  /** 会话正忙时在一轮中途写进去的（不是开一轮的那条）。 */
  midTurn: boolean;
}

type ClosingReason = "idle" | "interrupt" | "shutdown";

/** 这一行没带恢复、崩溃、重启说明（命令那一行，见 #takeBatch）。 */
const NO_NOTES: Batch["notes"] = { recovery: false, crash: false, relaunch: false, killed: null };

type StartupOutcome =
  | { kind: "ok" }
  /** 没等到 init 就自己退出了（或启动超时被结束）。 */
  | {
      kind: "failed";
      exitCode: number | null;
      signal: string | null;
      stderr: string;
      conflict: ReturnType<typeof detectArgsConflict>;
      timedOut: boolean;
    }
  /** 没等到 init，是我们让它退的。 */
  | { kind: "closed"; reason: ClosingReason };

/** 进程启动时的设置：两轮之间和现在的比，不一样就重启（driver.ts 的“两轮之间自动重启”）。 */
interface LaunchSnapshot {
  fingerprint: string;
  cwd: string;
  addDirs: string[];
  /** 启动时会话那一行的 model（配置的模型，账本和界面写，驱动层只读）。 */
  model: string | null;
  /** 同上，思考程度。 */
  effort: string | null;
}

interface Proc {
  child: ChildProcessWithoutNullStreams;
  resume: boolean;
  launched: LaunchSnapshot;
  initSeen: boolean;
  /** 第一个 system/init 里的 capabilities（MID_TURN_CAPABILITIES 等）；init 之前是空的。 */
  capabilities: Set<string>;
  stderr: string;
  /** 我们自己让它退出的原因；null 表示没让它退。 */
  closing: ClosingReason | null;
  startTimedOut: boolean;
  /** 空闲关闭的升级：关了标准输入还不退，先 SIGINT，再 SIGKILL。 */
  killTimer: NodeJS.Timeout | null;
  /** 收到第一个 init，或者没等到 init 就退出了。 */
  ready: Promise<StartupOutcome>;
  resolveReady: (o: StartupOutcome) => void;
  /** 进程退出、输出读完（或到点强制关掉）、收尾做完。一定会 resolve。 */
  exited: Promise<void>;
}

interface SessionState {
  id: SessionId;
  proc: Proc | null;
  /**
   * 已经写给 claude（或正要写）、还没收尾的行，按写入先后。空闲时写的开一轮；中途写的（midTurn）等 claude 取走。
   * 一轮的 result 只结算其中 started 过的（老 claude 没有 command_lifecycle：就是唯一那一行），没取走的留着等下一轮。
   */
  inFlight: Batch[];
  /**
   * claude 自己开的一轮在跑（后台任务完成等，没有我们写的消息）：和 inFlight 一样算忙，新消息排着、等它的 result 再写；
   * 空闲关闭、关机、打断、end 也都当有一轮在跑。
   */
  selfTurn: boolean;
  /** 会话里还在跑的后台任务（system/background_tasks_changed）：有就不算闲着，见 #armIdle。进程起来、退出时清空。 */
  background: BackgroundTasks;
  turnInterrupted: boolean;
  /** 这一轮用户点过停止（interrupt 调过、这一轮还没收尾）：关机碰上它，仍按停止收尾，不当关机打断。 */
  stopRequested: boolean;
  pending: PendingEntry[];
  /** 已经写进去（已送达）、还没失败的消息；这一轮出错或进程崩溃时删掉，好让重发真的再写一次。 */
  written: Set<MessageId>;
  recoveryNote: boolean;
  crashNote: boolean;
  /**
   * 两轮之间因为设置变了重启过：下一条写进去的前面加 RELAUNCH_NOTE。只有 #deliverNext 的重启会标；
   * 空闲退出或崩溃之后重新起进程不标（崩溃有自己的 CRASH_RECOVERY_NOTE），那时用的本来就是最新设置。
   */
  relaunchNote: boolean;
  /**
   * 我们关进程（两轮之间设置变了重启、后台任务超过兜底上限的空闲关闭）时会话里还有后台任务，它们跟着进程被结束了：
   * 这里存给 agent 的说明（backgroundTasksKilledNote），下一条写进去的前面加上，加一次。
   */
  killedNote: string | null;
  /** end 调过了（同步标上）：之后的 start、send 抛 session_ended。 */
  ended: boolean;
  /** end 的那个 promise，再调 end 返回同一个。 */
  ending: Promise<void> | null;
  /** 等“这一轮结束或进程退出”的（end 用）。 */
  settleWaiters: Array<() => void>;
  /** 只起进程那次参数选错，下次该用 --resume（true）还是 --session-id（false）；启动成功后才写库。 */
  resumeHint: boolean | null;
  starting: Promise<void> | null;
  startTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  interruptTimer: NodeJS.Timeout | null;
  interruptRequestId: string | null;
  interruptWaiters: Array<() => void>;
  lastEventWrite: number;
  /** 这一轮的实时 token 累计；推给库和网页的节流（最多每 USAGE_PUSH_MS 一次，中间的合并，到点推最新的）。 */
  turnUsage: TurnUsage;
  usageLatest: TokenUsage | null;
  usagePushedAt: number;
  usageTimer: NodeJS.Timeout | null;
  /** 在等回应的命令列表请求（queryCommands）：request_id → 交回结果（null = 没问到）。进程退出时都交回 null。 */
  commandQueries: Map<string, (commands: ComposerCommand[] | null) => void>;
  /** logs/sessions/<会话>.jsonl 一直开着。 */
  logFd: number | null;
  /** 日志写不了：报过一次就不再写（下次起进程再试）。 */
  logBroken: boolean;
}

export interface ClaudeDriverOptions extends DriverOptions {
  /** 这个驱动对应的厂商实现（命令的认法、写给 agent 的 content 怎么拼、命令列表怎么解析），默认 vendors/ 里 claude 那份。 */
  composer?: VendorComposerBase;
}

export class ClaudeDriver implements Driver {
  readonly #opts: Required<
    Pick<DriverOptions, "idleCloseMs" | "backgroundHoldMaxMs" | "interruptGraceMs" | "startTimeoutMs" | "shutdownGraceMs" | "commandsTimeoutMs" | "log">
  > &
    DriverOptions;
  readonly #composer: VendorComposerBase;
  readonly #sessions = new Map<SessionId, SessionState>();
  readonly #listeners = new Set<DriverEventListener>();
  #shuttingDown = false;
  #requestSeq = 0;
  /** 正在报监听者的错：这时监听者再抛错只打到标准错误，免得没完没了。 */
  #reportingListenerError = false;

  constructor({ composer, ...options }: ClaudeDriverOptions) {
    this.#composer = composer ?? composerBaseOf("claude")!;
    this.#opts = {
      idleCloseMs: IDLE_CLOSE_MS,
      backgroundHoldMaxMs: BACKGROUND_TASKS_HOLD_MAX_MS,
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

  midTurnSupport(sessionId: SessionId): MidTurnSupport {
    const proc = this.#sessions.get(sessionId)?.proc;
    // 还没 init 不知道这个 claude 支不支持：按声明的说（写的时候会再按 init 判断）
    if (!proc?.initSeen) return CLAUDE_MID_TURN;
    return midTurnCapable(proc) ? CLAUDE_MID_TURN : NO_MID_TURN;
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
        // 起好了还没写过东西（之前只起了进程）：有待发的就现在写，等到 init
        if (proc.initSeen || st.inFlight.length > 0) return;
        const batch = this.#takeBatch(st);
        return batch ? this.#runStartup(st, batch, proc) : undefined;
      }
      const batch = this.#takeBatch(st);
      if (batch) return this.#runStartup(st, batch, null);
      // 没有要写的：只把进程起起来（M0 实测 init 在每轮开头才出，没消息就等不到 init）
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
    const problem = checkUserLine(buildUserLine(parts.text, parts.prefixes, this.#composer.buildUserContent));
    if (problem) {
      this.#invalidInput(st, problem, ids);
      return { kind: "rejected" };
    }
    if (!this.#isPending(st, ids)) {
      if (input.recovery) st.recoveryNote = true;
      // 忙着、但这个 claude 能在一轮中途收：直接写进去，不进待发队列
      const proc = st.proc;
      if (proc && this.#canWriteMidTurn(st, proc, entry)) {
        const batch = this.#batchOf(st, entryParts(entry), ids, false);
        batch.midTurn = true;
        if (await this.#writeMidTurn(st, proc, batch)) return { kind: "written", midTurn: true };
        // 没写成（进程正好没了）：退回待发队列，照旧等
        this.#dropBatch(st, batch);
      }
      // 排序只在 #takeBatch 里做（用户的拼成一条排在系统的前面），这里按到达顺序放
      // 重启恢复的第一条：之后写进去的第一行前面加恢复说明（和消息同一行，不单独占一轮）
      st.pending.push(entry);
    }
    await this.#pump(st);
    return ids.every((id) => st.written.has(id)) ? { kind: "written" } : { kind: "queued" };
  }

  /**
   * 能不能在这一轮中途直接写（docs/mid-turn-messages.md 第 5.1 节）：进程 init 过、支持（MID_TURN_CAPABILITIES）、不在关闭、
   * 正忙（空闲时走 #pump，写之前要比设置）、没在两轮之间重启（starting）、这一轮没点过停止（写进去会被一起取消）、
   * 待发队列是空的（前面还排着的话不插队）、不是命令（本地命令在轮中间的行为没测，也会丢前缀块，见 #76）。
   */
  #canWriteMidTurn(st: SessionState, proc: Proc, entry: PendingEntry): boolean {
    return (
      proc.initSeen &&
      midTurnCapable(proc) &&
      !proc.closing &&
      !this.#shuttingDown &&
      this.#busy(st) &&
      st.starting === null &&
      !st.stopRequested &&
      st.pending.length === 0 &&
      !this.#composer.isCommand(entry.text)
    );
  }

  /** 一轮中途写一行：不重启、不调 prepareLaunch、不动这一轮的打断标记。写成了返回 true。 */
  async #writeMidTurn(st: SessionState, proc: Proc, batch: Batch): Promise<boolean> {
    st.inFlight.push(batch);
    this.#clearTimer(st, "idleTimer");
    return new Promise<boolean>((resolve) => {
      proc.child.stdin.write(batch.line + "\n", (err) => {
        if (!err) this.#markDelivered(st, batch);
        resolve(!err);
      });
    });
  }

  /**
   * @internal 只给测试用：跳过拼装，把一行原样交给写入函数（照样先校验）。会话要已经起来、空闲。
   */
  async writeUserLine(sessionId: SessionId, line: string, messageIds: MessageId[]): Promise<DriverSendResult> {
    const st = this.#state(sessionId);
    const problem = checkUserLine(line);
    if (problem) {
      this.#invalidInput(st, problem, messageIds);
      return { kind: "rejected" };
    }
    const proc = st.proc;
    if (!proc || !proc.initSeen || proc.closing || st.inFlight.length > 0) throw new Error(`session ${sessionId} is not idle`);
    await this.#writeBatch(st, proc, newBatch(messageIds, line, randomUUID(), NO_NOTES));
    return { kind: "written" };
  }

  end(sessionId: SessionId): Promise<void> {
    const st = this.#state(sessionId);
    if (st.ending) return st.ending;
    // 同步标上：从这一刻起 start、send 抛 session_ended；待发队列里没写的丢掉
    st.ended = true;
    st.pending = [];
    st.recoveryNote = false;
    st.crashNote = false;
    st.relaunchNote = false;
    st.killedNote = null;
    this.#clearTimer(st, "idleTimer");
    st.ending = this.#finishEnd(st);
    return st.ending;
  }

  /** 正在跑一轮就等它回完（不打断），然后关标准输入、等进程退出，最后写 ended。 */
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
    this.#closeLog(st);
  }

  async interrupt(sessionId: SessionId): Promise<void> {
    const st = this.#sessions.get(sessionId);
    const proc = st?.proc;
    if (!st || !proc || !this.#busy(st) || proc.closing) return;
    st.stopRequested = true;
    const done = new Promise<void>((resolve) => st.interruptWaiters.push(resolve));
    if (st.interruptRequestId === null) {
      const requestId = `interrupt-${++this.#requestSeq}`;
      st.interruptRequestId = requestId;
      // 写进去还没被取走的一并取消（不带的话 claude 打断之后会接着跑它们）；不支持的老 claude 不会有中途写进去的
      proc.child.stdin.write(buildInterruptLine(requestId, proc.capabilities.has("interrupt_cancel_queued_v1")) + "\n");
      st.interruptTimer = setTimeout(() => {
        st.interruptTimer = null;
        this.#sigintForInterrupt(st, proc);
      }, this.#opts.interruptGraceMs);
    }
    return done;
  }

  queryCommands(sessionId: SessionId): Promise<ComposerCommand[] | null> {
    const st = this.#sessions.get(sessionId);
    const proc = st?.proc;
    // 不为问命令起进程：没在跑、正在退出就让调用方另起一个问
    if (!st || !proc || proc.closing || this.#shuttingDown) return Promise.resolve(null);
    const requestId = `commands-${++this.#requestSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(null), this.#opts.commandsTimeoutMs);
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
      // 用户的停止还没收尾（控制消息没回应、或者回了还没等到 result）：照停止处理，消息标已停止，不当关机打断留着重发
      if (st.stopRequested && this.#busy(st)) {
        proc.closing = "interrupt";
        proc.child.kill("SIGINT");
        continue;
      }
      const wasIdle = proc.closing === "idle" || (!this.#busy(st) && proc.initSeen);
      proc.closing = "shutdown";
      if (wasIdle) proc.child.stdin.end();
      else proc.child.kill("SIGINT");
    }
    if (procs.length > 0) {
      const all = Promise.all(procs.map((p) => p.exited));
      if ((await within(all, this.#opts.shutdownGraceMs)) === "timeout") {
        await Promise.all(procs.map((p) => forceKill(p.child)));
        await within(all, KILL_WAIT_MS);
      }
    }
    for (const st of this.#sessions.values()) this.#closeLog(st);
  }

  async cleanupStale(): Promise<void> {
    let rows: AgentSessionRow[];
    try {
      rows = this.#opts.store.listWithProcess();
    } catch (error) {
      throw new DriverError("internal_error", `listWithProcess failed: ${errorMessage(error)}`);
    }
    await Promise.all(rows.map((row) => this.#cleanupStaleRow(row)));
  }

  async #cleanupStaleRow(row: AgentSessionRow): Promise<void> {
    const pid = row.pid;
    if (pid === null) return;
    // 这一次自己起的进程不算残留
    if (this.#sessions.get(row.id)?.proc?.child.pid === pid) return;
    const pgid = await claudeOfSession(pid, row.vendorSessionId);
    if (pgid !== null) {
      signalPid(pid, "SIGINT");
      if (!(await waitForExit(pid, this.#opts.interruptGraceMs))) {
        // 只有它自己是进程组长（我们 detached 起的）才按组杀；不是的话按组杀会连累同组的别的进程
        await forceKillTree(pid, pgid === pid);
        await waitForExit(pid, KILL_WAIT_MS);
      }
    }
    this.#update(this.#state(row.id), { pid: null, status: row.status === "ended" ? "ended" : "idle" });
  }

  // --- 队列 ---

  #state(id: SessionId): SessionState {
    let st = this.#sessions.get(id);
    if (!st) {
      st = {
        id,
        proc: null,
        inFlight: [],
        selfTurn: false,
        background: new BackgroundTasks(),
        turnInterrupted: false,
        stopRequested: false,
        pending: [],
        written: new Set(),
        recoveryNote: false,
        crashNote: false,
        relaunchNote: false,
        killedNote: null,
        ended: false,
        ending: null,
        settleWaiters: [],
        resumeHint: null,
        starting: null,
        startTimer: null,
        idleTimer: null,
        interruptTimer: null,
        interruptRequestId: null,
        interruptWaiters: [],
        lastEventWrite: 0,
        turnUsage: new TurnUsage(),
        usageLatest: null,
        usagePushedAt: 0,
        usageTimer: null,
        commandQueries: new Map(),
        logFd: null,
        logBroken: false,
      };
      this.#sessions.set(id, st);
    }
    return st;
  }

  /** 已经在待发队列里，或者就是正在启动、还没写成的那一行。 */
  #isPending(st: SessionState, ids: MessageId[]): boolean {
    const covers = (batchIds: MessageId[]) => ids.every((id) => batchIds.includes(id));
    if (st.inFlight.some((b) => covers(b.messageIds))) return true;
    return st.pending.some((e) => covers(e.messageIds));
  }

  /**
   * 取下一行：队列里有用户消息就拼成一条（以命令开头的不拼：排在最前面的是命令就只写它，否则拼到下一条命令之前，顺序不乱）；
   * 否则取最早的一条系统消息。恢复说明加在最前面，和消息写在同一行；我们加的字各占一个 text 块，原文放最后一块（driver.ts 的 prefixes）。
   * 写的是命令那一行时不带恢复、崩溃、重启说明，留给下一条不是命令的：/compact、/context 这类本地命令会把前面的 text 块整个丢掉
   * （#76 审查用真 claude 测过），带上了 agent 也看不到。
   */
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
    return this.#batchOf(st, body, messageIds, command);
  }

  /** 拼一行：不是命令的话把恢复、崩溃、重启、后台任务被结束的说明加在最前面（加一次就清掉）。 */
  #batchOf(st: SessionState, body: { prefixes: string[]; text: string }, messageIds: MessageId[], command: boolean): Batch {
    const uuid = randomUUID();
    if (command) {
      return newBatch(messageIds, buildUserLine(body.text, body.prefixes, this.#composer.buildUserContent, uuid), uuid, NO_NOTES);
    }
    const notes = { recovery: st.recoveryNote, crash: st.crashNote, relaunch: st.relaunchNote, killed: st.killedNote };
    const prefixes = [
      notes.recovery ? RESTART_RECOVERY_NOTE : null,
      notes.crash ? CRASH_RECOVERY_NOTE : null,
      notes.relaunch ? RELAUNCH_NOTE : null,
      notes.killed,
    ].filter((p): p is string => p !== null);
    st.recoveryNote = false;
    st.crashNote = false;
    st.relaunchNote = false;
    st.killedNote = null;
    return newBatch(messageIds, buildUserLine(body.text, [...prefixes, ...body.prefixes], this.#composer.buildUserContent, uuid), uuid, notes);
  }

  /** 没写成的一行：恢复说明留给下一行；消息本身不放回队列，由执行器重试 send 时再排。 */
  #dropBatch(st: SessionState, batch: Batch): void {
    st.inFlight = st.inFlight.filter((b) => b !== batch);
    if (batch.notes.recovery) st.recoveryNote = true;
    if (batch.notes.crash) st.crashNote = true;
    if (batch.notes.relaunch) st.relaunchNote = true;
    if (batch.notes.killed !== null) st.killedNote = batch.notes.killed;
  }

  async #pump(st: SessionState): Promise<void> {
    for (;;) {
      this.#assertRunning();
      // 等的这一会儿 end 了：这次 send 的消息已经随待发队列丢掉，不能再说“排着”
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
        // 往已经在跑、空闲的进程写之前先比设置；进程在这期间没了就再转一圈（重新起）
        await this.#deliverNext(st, proc);
        continue;
      }
      const batch = this.#takeBatch(st);
      if (!batch) return;
      return this.#runStartup(st, batch, null);
    }
  }

  /**
   * 往一个已经在跑、空闲的进程写下一条（driver.ts 的“两轮之间自动重启”）：先调一次 prepareLaunch，设置和这个进程
   * 启动时一样就直接写；不一样就关标准输入、等它退出，用这次的结果 --resume 起一个新的，前面加 RELAUNCH_NOTE 再写。
   * 期间占着 st.starting：别的 send 只排队，start 等它。prepareLaunch 出错不重启，照旧写进现在的进程。
   */
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
      // 等 prepareLaunch 的时候 claude 可能自己开了一轮：消息留在队列里，那一轮的 result 之后 #afterTurn 再发
      if (st.ended || st.proc !== proc || proc.closing || this.#busy(st)) return;
      const row = files ? this.#row(st) : null;
      if (files && row && launchChanged(proc.launched, row, files.fingerprint)) {
        // 重启会把后台任务一起结束：记下来，写下一条时告诉 agent
        if (st.background.active) st.killedNote = backgroundTasksKilledNote("relaunch", st.background.descriptions());
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
    const problem = checkUserLine(batch.line);
    if (problem) {
      // 自己拼出来的不会不合格；万一不合格，不写，标失败，接着写下一条
      this.#invalidInput(st, problem, batch.messageIds);
      this.#afterTurn(st, proc);
      return;
    }
    this.#clearTimer(st, "idleTimer");
    st.inFlight.push(batch);
    st.turnInterrupted = false;
    st.stopRequested = false;
    await new Promise<void>((resolve) => {
      proc.child.stdin.write(batch.line + "\n", (err) => {
        if (!err) this.#markDelivered(st, batch);
        resolve();
      });
    });
  }

  #markDelivered(st: SessionState, batch: Batch): void {
    if (batch.delivered) return;
    batch.delivered = true;
    for (const id of batch.messageIds) st.written.add(id);
    if (batch.messageIds.length === 0) return;
    this.#emit(st.id, { type: "message.delivered", messageIds: batch.messageIds, ...(batch.midTurn ? { midTurn: true as const } : {}), at: Date.now() });
  }

  #forgetWritten(st: SessionState, batches: Batch[]): void {
    for (const batch of batches) for (const id of batch.messageIds) st.written.delete(id);
  }

  /**
   * 一轮结束（或一行没写成）之后：有排队的就写下一条，没有就开始算空闲。
   * 还有中途写进去、claude 没取走的（这一轮没赶上）：它会自己另起一轮处理它们，等那一轮结束再说。
   */
  #afterTurn(st: SessionState, proc: Proc): void {
    if (st.proc !== proc || proc.closing || this.#shuttingDown || st.ended || this.#busy(st)) return;
    // 没人等这次写：出错的话消息不在队列里了，执行器下次 send 会重新排
    if (st.pending.length > 0) void this.#deliverNext(st, proc).catch(() => {});
    else this.#armIdle(st, proc);
  }

  /** 有一轮在跑（或马上要跑）：我们写进去、还没收尾的，或者 claude 自己开的。 */
  #busy(st: SessionState): boolean {
    return st.inFlight.length > 0 || st.selfTurn;
  }

  /** 这一轮结束或进程退出了：叫醒等着的 end。 */
  #settled(st: SessionState): void {
    for (const w of st.settleWaiters.splice(0)) w();
  }

  /**
   * 开始算空闲。有后台任务时计时放宽到 backgroundHoldMaxMs（兜底，到点照常关）；任务清零时 #onBackgroundTasksChanged 重新调这里，从头算 idleCloseMs。
   */
  #armIdle(st: SessionState, proc: Proc): void {
    this.#clearTimer(st, "idleTimer");
    st.idleTimer = setTimeout(() => {
      st.idleTimer = null;
      if (st.proc !== proc || proc.closing || this.#busy(st) || st.pending.length > 0 || st.starting || st.ended) return;
      if (st.background.active) {
        this.#opts.log(`[driver] session ${st.id}: 后台任务还有 ${st.background.count} 个没结束，已超过 ${this.#opts.backgroundHoldMaxMs} ms，照常空闲关闭`);
        st.killedNote = backgroundTasksKilledNote("hold_max", st.background.descriptions());
      }
      this.#closeStdin(st, proc, "idle");
    }, idleDelayMs(st.background, this.#opts.idleCloseMs, this.#opts.backgroundHoldMaxMs));
  }

  /** 关标准输入让它正常退出；还不退：先给 claude 本身 SIGINT，再强制结束（连同所有后代的进程组）。 */
  #closeStdin(st: SessionState, proc: Proc, reason: ClosingReason): void {
    proc.closing = reason;
    proc.child.stdin.end();
    const grace = this.#opts.interruptGraceMs;
    clearKillTimer(proc);
    proc.killTimer = setTimeout(() => {
      proc.child.kill("SIGINT");
      proc.killTimer = setTimeout(() => {
        proc.killTimer = null;
        this.#forceKill(st, proc);
      }, grace);
    }, grace);
  }

  #sigintForInterrupt(st: SessionState, proc: Proc): void {
    if (st.proc !== proc || proc.closing) return;
    // SIGINT 会结束这一轮然后整个进程退出（M0 实测），下次 --resume。不用 SIGTERM。
    proc.closing = "interrupt";
    proc.child.kill("SIGINT");
  }

  // --- 启动 ---

  /** 下次起进程用不用 --resume。 */
  #resumeFor(st: SessionState): boolean {
    return st.resumeHint ?? this.#store(st).hasCompletedTurn;
  }

  /** 起进程（或用已经起来、还没 init 的进程）写第一行，等 init；参数选错换一个重试一次。 */
  #runStartup(st: SessionState, batch: Batch, existing: Proc | null): Promise<void> {
    const promise: Promise<void> = this.#startup(st, batch, existing, null).finally(() => {
      if (st.starting === promise) st.starting = null;
    });
    st.starting = promise;
    return promise;
  }

  /** #runStartup 的本体，不碰 st.starting（#deliverNext 在自己占着的时候直接调）。files：已经调好的 prepareLaunch 结果。 */
  #startup(st: SessionState, batch: Batch, existing: Proc | null, files: LaunchFiles | null): Promise<void> {
    st.inFlight = [batch];
    st.turnInterrupted = false;
    st.stopRequested = false;
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
          st.inFlight = [batch];
          proc.child.stdin.write(batch.line + "\n");
          this.#armStartTimer(st, proc);
          const outcome = await proc.ready;
          if (outcome.kind === "ok") return;
          if (outcome.kind === "closed") {
            // 启动阶段被打断：那一行已经算送达，由 session.exited(interrupt) 带着它，不当启动失败重试
            if (outcome.reason === "interrupt") return;
            throw new DriverError("spawn_failed", this.#shuttingDown ? "driver is shutting down" : `closed before system/init (${outcome.reason})`);
          }
          proc = null;
          if (outcome.conflict && attempt === 0 && !outcome.timedOut) {
            // 换一个参数重试；hasCompletedTurn 等这次启动成功（#onInit）再写库
            resume = outcome.conflict === "session_in_use";
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

  /**
   * 刚 spawn 好、还没往里写东西的这一刻，end 或关机可能已经发生（等 spawn 的时候、写库时）：
   * end 了就关标准输入让它退出，抛 session_ended；关机了交给 shutdown（它已经看到这个进程），抛 spawn_failed。
   * 抛出去由外层 dropBatch，那一行没写。
   */
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

  /** prepared：两轮之间重启时已经调好的 prepareLaunch 结果（不再调第二次）；null 就现调。 */
  async #spawn(st: SessionState, resume: boolean, prepared: LaunchFiles | null): Promise<Proc> {
    let row = this.#store(st);
    let files = prepared;
    if (!files) {
      try {
        files = await this.#opts.prepareLaunch(row);
      } catch (error) {
        // session_ended（组装代码的令牌已作废）原样抛：不可重试，处理函数按“会话已结束”接
        if (error instanceof DriverError && error.code === "session_ended") throw error;
        throw new DriverError("spawn_failed", `prepareLaunch failed: ${errorMessage(error)}`);
      }
      row = this.#store(st);
    }
    this.#assertRunning();
    this.#assertNotEnded(st);
    if (!existsSync(row.cwd)) throw new DriverError("spawn_failed", `working directory does not exist: ${row.cwd}`);
    // detached：claude 在自己的进程组里（进程组号 = 它的 pid），强制结束时连它起的子进程一起结束
    const child = spawn(this.#opts.claudePath, buildClaudeArgs(row, files, resume), {
      cwd: row.cwd,
      env: buildChildEnv(process.env, { ...this.#opts.env, ...files.env }),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new DriverError("claude_not_found", `${this.#opts.claudePath}: ${errorMessage(error)}`);
      throw new DriverError("spawn_failed", `${this.#opts.claudePath}: ${errorMessage(error)}`);
    }
    // 等 spawn 的这一会儿可能已经开始关机：shutdown 看不到这个进程，自己结束它
    if (this.#shuttingDown) {
      killFreshGroup(child);
      this.#assertRunning();
    }
    let resolveReady!: (o: StartupOutcome) => void;
    let resolveExited!: () => void;
    const proc: Proc = {
      child,
      resume,
      launched: { fingerprint: files.fingerprint, cwd: row.cwd, addDirs: [...row.addDirs], model: row.model, effort: row.effort },
      initSeen: false,
      capabilities: new Set(),
      stderr: "",
      closing: null,
      startTimedOut: false,
      killTimer: null,
      ready: new Promise((resolve) => (resolveReady = resolve)),
      resolveReady: (o) => resolveReady(o),
      exited: new Promise((resolve) => (resolveExited = resolve)),
    };
    st.proc = proc;
    st.background.clear();
    st.logBroken = false;
    this.#update(st, { pid: child.pid ?? null });
    child.on("error", () => {}); // 出错之后总会有 exit
    child.stdin.on("error", () => {}); // 进程退了还在写：EPIPE，交给 exit 处理
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      proc.stderr = (proc.stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    // 自己按 \n 切行：node:readline 还会在 U+2028 / U+2029 处断开，而 JSON 字符串里可以有这两个字符
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
    // 用 exit 不用 close：agent 起的孙进程可能还占着标准输出，close 会一直等它
    const drained = Promise.all([streamClosed(child.stdout), streamClosed(child.stderr)]);
    child.once("exit", (code, signal) => {
      // 我们让它正常退的（end、两轮之间重启、空闲关闭）：给它原来的进程组补一个 SIGTERM，清掉它留下的子进程
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

  // --- 读输出 ---

  #handleLine(st: SessionState, proc: Proc, rawLine: string): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    try {
      this.#onLine(st, proc, line);
    } catch (error) {
      this.#internalError(st.id, `handling output line failed: ${errorMessage(error)}`);
    }
  }

  #onLine(st: SessionState, proc: Proc, line: string): void {
    this.#appendLog(st, line);
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
    switch (obj.type) {
      case "system":
        if (obj.subtype === "init") this.#onInit(st, proc, obj, at);
        else if (obj.subtype === "api_retry") this.#onApiRetry(st, obj, at);
        else if (obj.subtype === "commands_changed") this.#onCommandsChanged(st, obj, at);
        else if (obj.subtype === "background_tasks_changed") this.#onBackgroundTasksChanged(st, proc, obj);
        else if (obj.subtype === "compact_boundary") this.#onCompactBoundary(st, obj, line, at);
        return;
      case "conversation_reset":
        // /clear 换了会话 ID（实测 T7）：网页和账本都拦着 /clear，理论上不会出现；出现了只记日志，会话 ID 照旧
        this.#opts.log(`[driver] session ${st.id}: claude 出了 conversation_reset（${String(obj.trigger ?? "")}），会话 ID 可能换了，--resume 仍用原来的`);
        return;
      case "command_lifecycle":
        this.#onLifecycle(st, proc, obj, at);
        return;
      case "user":
        if (isInterruptMarker(obj)) st.turnInterrupted = true;
        else if (obj.isReplay === true) {
          // 有 command_lifecycle 就靠它对账（回显会把几条合成一个，只带最后一条的 uuid）；老 claude 靠回显，在途只有一行
          const first = st.inFlight[0];
          if (!proc.capabilities.has("msg_lifecycle_v1") && first) this.#markProcessing(st, first, at);
        } else {
          const result = parseToolResults(obj, at);
          if (result) this.#emit(st.id, result);
        }
        return;
      case "assistant": {
        const row = this.#row(st);
        const live = row ? st.turnUsage.observe(obj, row.usage) : null;
        if (live) this.#pushUsage(st, live);
        for (const ev of parseAssistant(obj, line, at)) this.#emit(st.id, ev);
        return;
      }
      case "rate_limit_event": {
        const info = parseRateLimit(obj.rate_limit_info);
        if (!info) return;
        this.#update(st, { rateLimit: info });
        this.#emit(st.id, { type: "rate_limit", info, at });
        return;
      }
      case "control_response": {
        const response = obj.response as { subtype?: unknown; request_id?: unknown; response?: unknown } | undefined;
        const query = typeof response?.request_id === "string" ? st.commandQueries.get(response.request_id) : undefined;
        if (query) {
          const body = response?.response as { commands?: unknown } | undefined;
          query(response?.subtype === "success" ? this.#composer.parseCommands(body?.commands) : null);
          return;
        }
        if (response?.request_id === undefined || response.request_id !== st.interruptRequestId) return;
        this.#clearTimer(st, "interruptTimer");
        // 只有 success 才算打断收到了；回了 error 就不等了，直接 SIGINT
        if (response.subtype === "success") {
          // 带 cancel_queued 时回执里列着它取消了的（写进去还没取走的）
          const cancelled = new Set(interruptCancelled(response.response));
          this.#cancelBatches(st, proc, st.inFlight.filter((b) => !b.started && cancelled.has(b.uuid)), at);
          this.#resolveInterrupt(st);
        } else this.#sigintForInterrupt(st, proc);
        return;
      }
      case "result":
        this.#onResult(st, proc, obj, at);
        return;
    }
  }

  /**
   * 后台任务名单变了（完整名单，见 docs/m0-report.md）：记下来。有没有任务这件事变了、而且正在算空闲，就按新的情况重新计时：
   * 来了任务 → 换成兜底时长；清零 → 从头算 idleCloseMs。一轮在跑时不动计时（那一轮结束 #afterTurn 会按当时的情况算）。
   */
  #onBackgroundTasksChanged(st: SessionState, proc: Proc, obj: Record<string, unknown>): void {
    if (st.proc !== proc) return;
    const wasActive = st.background.active;
    if (!st.background.replace(obj.tasks)) return;
    if (st.background.active === wasActive || st.idleTimer === null) return;
    if (!proc.closing && !this.#busy(st) && !st.ended) this.#armIdle(st, proc);
  }

  /** 命令列表变了（带完整名单）：换成通用形状交出去；认不出的跳过。 */
  #onCommandsChanged(st: SessionState, obj: Record<string, unknown>, at: number): void {
    const commands = this.#composer.parseCommands(obj.commands);
    if (commands) this.#emit(st.id, { type: "commands.changed", commands, at });
  }

  /** 压缩完了（/compact 或自动压缩，实测 T7）：前后那两条 type user 的事件（摘要、local-command-stdout）不是用户发的，照旧不显示。 */
  #onCompactBoundary(st: SessionState, obj: Record<string, unknown>, rawLine: string, at: number): void {
    const meta = (typeof obj.compact_metadata === "object" && obj.compact_metadata !== null ? obj.compact_metadata : {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    this.#emit(st.id, {
      type: "context.compacted",
      uuid: lineUuid(obj, rawLine),
      trigger: typeof meta.trigger === "string" ? meta.trigger : null,
      preTokens: num(meta.pre_tokens),
      postTokens: num(meta.post_tokens),
      at,
    });
  }

  /** claude 在自己重试（断网、过载）：残缺的跳过。只通知账本，不写库（重试信息只在内存里）。 */
  #onApiRetry(st: SessionState, obj: Record<string, unknown>, at: number): void {
    const info = parseApiRetry(obj, at);
    if (info) this.#emit(st.id, { type: "api_retry", info, at });
  }

  /**
   * command_lifecycle（docs/mid-turn-messages.md 第 2 节）：started → 这一行被 claude 取走了，处理中（第一行的 started 在 init 之前到，
   * 先记下，init 时再出，事件顺序和以前一样）；cancelled → 没取走就被取消了（停止时），已取消。
   * 已经取走的被 cancelled（打断那一轮，在 result 之后到）不管：那一轮的 result 已经按打断收尾了。queued、completed 不用：送达看写入，完成看 result。
   */
  #onLifecycle(st: SessionState, proc: Proc, obj: Record<string, unknown>, at: number): void {
    const event = parseLifecycle(obj);
    const batch = event ? st.inFlight.find((b) => b.uuid === event.uuid) : undefined;
    if (!event || !batch) return;
    if (event.state === "started") {
      batch.started = true;
      if (proc.initSeen) this.#markProcessing(st, batch, at);
    } else if (event.state === "cancelled" && !batch.started) {
      this.#cancelBatches(st, proc, [batch], at);
    }
  }

  /** 写进去还没被取走的这几行不会再被处理了（停止）：出 message.cancelled，不重发。没有别的在途了就算这一轮完了。 */
  #cancelBatches(st: SessionState, proc: Proc, batches: Batch[], at: number): void {
    if (batches.length === 0) return;
    st.inFlight = st.inFlight.filter((b) => !batches.includes(b));
    const messageIds = batches.flatMap((b) => b.messageIds);
    if (messageIds.length > 0) this.#emit(st.id, { type: "message.cancelled", messageIds, reason: "stop", at });
    if (!this.#busy(st)) {
      this.#afterTurn(st, proc);
      this.#settled(st);
    }
  }

  #markProcessing(st: SessionState, batch: Batch, at: number): void {
    this.#markDelivered(st, batch);
    if (batch.processing || batch.messageIds.length === 0) return;
    batch.processing = true;
    this.#emit(st.id, { type: "message.processing", messageIds: batch.messageIds, at });
  }

  #onInit(st: SessionState, proc: Proc, obj: Record<string, unknown>, at: number): void {
    if (proc.initSeen) {
      // 之后每一轮开头还会出 init：没有在途的消息，就是 claude 自己开的一轮（比如后台任务完成了）。
      // 中途写进去、上一轮没赶上的还在 inFlight 里：这一轮是 claude 为它们开的，不算自己开的
      if (st.inFlight.length === 0 && !st.selfTurn && st.proc === proc) {
        st.selfTurn = true;
        this.#clearTimer(st, "idleTimer");
        this.#emit(st.id, { type: "turn.started", at });
      }
      return;
    }
    proc.initSeen = true;
    proc.capabilities = parseCapabilities(obj);
    if (proc.capabilities.has("msg_lifecycle_v1") && !midTurnCapable(proc)) {
      this.#opts.log(`[driver] session ${st.id}: claude 不支持停止时取消排着的消息（没有 interrupt_cancel_queued_v1），忙时照旧排队`);
    }
    this.#clearTimer(st, "startTimer");
    const model = typeof obj.model === "string" ? obj.model : null;
    const tools = Array.isArray(obj.tools) ? obj.tools.filter((t): t is string => typeof t === "string") : [];
    // 报回来的模型只放进 session.started；会话那一行的 model 是配置的模型（可能是 opus 这种别名），驱动层不写
    const patch: AgentSessionPatch = { status: "running", lastEventAt: at };
    // 参数选错后换了一个才起来：这时才把用哪个参数写进库
    const row = this.#row(st);
    if (row && row.hasCompletedTurn !== proc.resume) patch.hasCompletedTurn = proc.resume;
    st.resumeHint = null;
    this.#update(st, patch);
    this.#emit(st.id, { type: "session.started", resumed: proc.resume, model, tools, at });
    for (const batch of st.inFlight) {
      this.#markDelivered(st, batch);
      if (batch.started) this.#markProcessing(st, batch, at);
    }
    proc.resolveReady({ kind: "ok" });
  }

  #onResult(st: SessionState, proc: Proc, obj: Record<string, unknown>, at: number): void {
    // 没等到 init 就来的 result 是启动错误（如 No conversation found），不算一轮
    if (!proc.initSeen) return;
    const batches = this.#takeSettled(st, proc);
    st.selfTurn = false;
    // 没等到回显就结束了（比如回显前被打断）：先补一个 message.processing，账本才能从“已送达”往下走
    for (const batch of batches) this.#markProcessing(st, batch, at);
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
    // 关机时被 SIGINT 结束的一轮才算：没理 SIGINT、正常做完的照常是回复
    if (proc.closing === "shutdown" && (!ok || st.turnInterrupted)) event.shutdown = true;
    if (!ok) {
      event.error = { subtype, message: resultMessage(obj, subtype) };
      this.#forgetWritten(st, batches);
    }
    st.turnInterrupted = false;
    st.stopRequested = false;
    const row = this.#row(st);
    this.#cancelUsagePush(st);
    const patch: AgentSessionPatch = { usage: st.turnUsage.finish(row?.usage ?? EMPTY_TOKEN_USAGE, obj.usage) };
    if (row?.hasCompletedTurn === false) patch.hasCompletedTurn = true;
    this.#update(st, patch);
    this.#clearTimer(st, "interruptTimer");
    this.#emit(st.id, event);
    this.#resolveInterrupt(st);
    this.#afterTurn(st, proc);
    this.#settled(st);
  }

  /**
   * 这一轮的 result 结算哪几行（docs/mid-turn-messages.md 第 5.2 节）：有 command_lifecycle 的是 started 过的（可能好几行）；
   * 没赶上的（中途写进去还没取走）留在 inFlight，claude 会另起一轮。老 claude（没有 msg_lifecycle_v1）在途只有一行，就是它。
   * 兜底：这一轮一行 started 都没有（claude 没出生命周期事件），开这一轮的那行（空闲时写的）照旧算这一轮的。
   */
  #takeSettled(st: SessionState, proc: Proc): Batch[] {
    if (!proc.capabilities.has("msg_lifecycle_v1")) return st.inFlight.splice(0);
    let settled = st.inFlight.filter((b) => b.started);
    const first = st.inFlight[0];
    if (settled.length === 0 && !st.selfTurn && first && !first.midTurn) settled = [first];
    st.inFlight = st.inFlight.filter((b) => !settled.includes(b));
    return settled;
  }

  #onClose(st: SessionState, proc: Proc, code: number | null, signal: NodeJS.Signals | null, resolveExited: () => void): void {
    try {
      if (st.proc === proc) {
        st.proc = null;
        st.background.clear();
      }
      clearKillTimer(proc);
      this.#clearTimer(st, "startTimer");
      this.#clearTimer(st, "idleTimer");
      this.#clearTimer(st, "interruptTimer");
      this.#flushUsage(st);
      st.turnUsage.reset();
      this.#update(st, { pid: null, status: "idle", lastEventAt: Date.now() });
      const at = Date.now();
      if (!proc.initSeen) {
        if (proc.closing === null) {
          const conflict = detectArgsConflict(proc.stderr);
          // 没人在等这次启动（只起了进程、还没写东西）：记下该用哪个参数，下次起就对了
          if (conflict && st.inFlight.length === 0) st.resumeHint = conflict === "session_in_use";
          this.#forgetWritten(st, st.inFlight);
          proc.resolveReady({ kind: "failed", exitCode: code, signal, stderr: proc.stderr, conflict, timedOut: proc.startTimedOut });
          // 在途的那一行由抛出的 DriverError 交给执行器重试，这里不带 messageIds，免得账本提前标失败
          this.#emit(st.id, { type: "session.exited", reason: "startup_failed", exitCode: code, signal, hadResult: false, messageIds: [], at });
          return;
        }
        // 启动阶段被打断：那一行已经写进标准输入，算送达，下面跟着 session.exited(interrupt) 标已停止
        if (proc.closing === "interrupt") for (const batch of st.inFlight) this.#markDelivered(st, batch);
        proc.resolveReady({ kind: "closed", reason: proc.closing });
      }
      const batches = proc.initSeen || proc.closing === "interrupt" ? st.inFlight : [];
      st.inFlight = [];
      st.selfTurn = false;
      const reason: SessionExitReason = proc.closing ?? "crash";
      // 中途写进去、claude 还没取走的（模型没看到过）和这一轮的分开（docs/mid-turn-messages.md 第 5.5 节）
      const untaken = batches.filter((b) => b.midTurn && !b.started && proc.capabilities.has("msg_lifecycle_v1"));
      const taken = batches.filter((b) => !untaken.includes(b));
      if (taken.length > 0 && reason === "crash") {
        st.crashNote = true;
        this.#forgetWritten(st, taken);
      }
      st.interruptRequestId = null;
      st.stopRequested = false;
      this.#emit(st.id, {
        type: "session.exited",
        reason,
        exitCode: code,
        signal,
        hadResult: taken.length === 0,
        messageIds: taken.flatMap((b) => b.messageIds),
        at,
      });
      const untakenIds = untaken.flatMap((b) => b.messageIds);
      if (untakenIds.length > 0) {
        if (reason === "interrupt") {
          // 用户点的停止（控制消息没回应才 SIGINT）：和带 cancel_queued 的停止一样标已取消，不重发
          this.#emit(st.id, { type: "message.cancelled", messageIds: untakenIds, reason: "stop", at });
        } else {
          // 崩溃、关机：进程没了，claude 里排着的也没了。放回去由账本重新登记发送（不加重发说明，模型没看到过）
          this.#forgetWritten(st, untaken);
          this.#emit(st.id, { type: "message.requeued", messageIds: untakenIds, at });
        }
      }
    } finally {
      for (const query of [...st.commandQueries.values()]) query(null);
      this.#resolveInterrupt(st);
      resolveExited();
      this.#settled(st);
    }
  }

  // --- 小零件 ---

  #resolveInterrupt(st: SessionState): void {
    st.interruptRequestId = null;
    for (const w of st.interruptWaiters.splice(0)) w();
  }

  #invalidInput(st: SessionState, problem: string, messageIds: MessageId[]): void {
    this.#emit(st.id, { type: "driver.error", code: "invalid_input", message: `invalid_input: ${problem}`, messageIds, at: Date.now() });
  }

  /** 不等结果的强制结束：出错不往上冒（免得成了没人接的 Promise 拒绝），记一条 internal_error。 */
  #forceKill(st: SessionState, proc: Proc): void {
    forceKill(proc.child).catch((error: unknown) => this.#internalError(st.id, `force kill failed: ${errorMessage(error)}`));
  }

  #internalError(sessionId: SessionId, detail: string): void {
    this.#emit(sessionId, { type: "driver.error", code: "internal_error", message: `internal_error: ${detail}`, at: Date.now() });
  }

  /** start、send、起进程时用：找不到那一行抛不可重试的错。 */
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

  /** 处理输出时用：出错不往上冒，记一条 internal_error，返回 null。 */
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

  /** 实时的 token 累计：距上次推送够一秒就马上推，不够就等到点推最新的。 */
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

  #appendLog(st: SessionState, line: string): void {
    if (st.logBroken) return;
    try {
      if (st.logFd === null) {
        mkdirSync(this.#opts.sessionLogsDir, { recursive: true, mode: 0o700 });
        st.logFd = openSync(join(this.#opts.sessionLogsDir, `${st.id}.jsonl`), "a", 0o600);
      }
      writeSync(st.logFd, line + "\n");
    } catch (error) {
      st.logBroken = true;
      this.#closeLog(st);
      this.#internalError(st.id, `writing session log failed: ${errorMessage(error)}`);
    }
  }

  #closeLog(st: SessionState): void {
    if (st.logFd === null) return;
    try {
      closeSync(st.logFd);
    } catch {
      // 关不上也没什么可做的
    }
    st.logFd = null;
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

  /** 监听者出错不影响驱动层，但要留下记录：发一条 internal_error；报这条时再出错就只打到标准错误。 */
  #listenerFailed(sessionId: SessionId, event: DriverEvent, error: unknown): void {
    const detail = `listener threw on ${event.type}: ${errorMessage(error)}`;
    if (this.#reportingListenerError) {
      console.error(`[driver] session ${sessionId}: ${detail}`);
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

  /** end 调过了，或者库里已经是 ended（上次守护进程结束的）：抛 session_ended，不起进程、不调 prepareLaunch。 */
  #assertNotEnded(st: SessionState): void {
    if (st.ended || this.#store(st).status === "ended") {
      throw new DriverError("session_ended", `session ${st.id} has been ended`);
    }
  }
}

export function createClaudeDriver(options: ClaudeDriverOptions): ClaudeDriver {
  return new ClaudeDriver(options);
}

/** 单独写一行时：重发说明、调用方的标签各占一块，原文放最后。 */
function entryParts(entry: PendingEntry): { prefixes: string[]; text: string } {
  return { prefixes: entry.resend ? [RESEND_NOTE, ...entry.prefixes] : entry.prefixes, text: entry.text };
}

/** 和别的用户消息拼成一条时的那一条（拼进“【用户连发了 N 条】”的一项）：标签和原文换行连着，重发说明空一行，和以前一样。 */
function flatEntryText(entry: PendingEntry): string {
  const text = [...entry.prefixes, entry.text].join("\n");
  return entry.resend ? `${RESEND_NOTE}\n\n${text}` : text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resultMessage(obj: Record<string, unknown>, subtype: string): string {
  if (typeof obj.result === "string" && obj.result !== "") return obj.result;
  if (Array.isArray(obj.errors) && obj.errors.length > 0) return obj.errors.map(String).join("; ");
  return subtype;
}

function startupError(outcome: Extract<StartupOutcome, { kind: "failed" }>, startTimeoutMs: number, retried: boolean): DriverError {
  if (outcome.timedOut) return new DriverError("start_timeout", `no system/init within ${startTimeoutMs} ms`);
  const how = outcome.signal ? `signal ${outcome.signal}` : `exit code ${outcome.exitCode}`;
  const stderr = outcome.stderr.trim();
  if (outcome.conflict) {
    return new DriverError("start_args_conflict", `${retried ? "after switching --session-id/--resume: " : ""}${stderr || how}`);
  }
  return new DriverError("spawn_failed", `claude exited before system/init (${how})${stderr ? `: ${stderr}` : ""}`);
}

function newBatch(messageIds: MessageId[], line: string, uuid: string, notes: Batch["notes"]): Batch {
  return { messageIds, line, uuid, notes, delivered: false, processing: false, started: false, midTurn: false };
}

/** 这个进程能在一轮中途写入：init 里 MID_TURN_CAPABILITIES 都有。 */
function midTurnCapable(proc: Proc): boolean {
  return MID_TURN_CAPABILITIES.every((c) => proc.capabilities.has(c));
}

function clearKillTimer(proc: Proc): void {
  if (proc.killTimer) clearTimeout(proc.killTimer);
  proc.killTimer = null;
}

/** 等 promise，最多 ms 毫秒。 */
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

/** 会话那一行（cwd、addDirs、model、effort）或 fingerprint 和进程启动时不一样。env 不算。 */
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
