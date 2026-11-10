// 多厂商会话驱动公共底座：抽取 claude-driver / agy-driver / codex-driver 三家驱动共用的会话状态机与辅助机制：
// - 待发消息队列项（PendingEntry）与排队用户消息合并、命令拆分、停止时取消/收回结算；
// - 实时 token 用量节流上报器（USAGE_THROTTLE_MS 节流定时器、挂起刷新与取消）；
// - 启动超时（startTimer）、空闲关闭（idleTimer，支持后台任务兜底延长）、打断超时（interruptTimer）、强杀升级（killTimer）统一生命周期管理；
// - 会话首次轮次前缀组装与回退状态（personaSeen、preambleTaken、recoveryNote、crashNote、relaunchNote、killedNote）；
// - 后台任务状态跟踪与 background.changed 事件发射；
// - 驱动级健康状态报错（reportError / markHealthy）与通用日志包装、进程组收尾与残留清理。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import {
  BACKGROUND_TASKS_HOLD_MAX_MS,
  CRASH_RECOVERY_NOTE,
  DriverError,
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
  backgroundTasksKilledNote,
  notFoundCode,
  type AgentSessionPatch,
  type AgentSessionRow,
  type AgentVendor,
  type ComposerCommand,
  type Driver,
  type DriverErrorCode,
  type DriverEvent,
  type DriverEventListener,
  type DriverOptions,
  type DriverSendInput,
  type DriverSendResult,
  type LaunchFiles,
  type MessageId,
  type MessageSource,
  type SessionId,
  type TokenUsage,
  type Unsubscribe,
} from "../../shared/index.ts";
import { agyComposerBase } from "../vendors/agy.ts";
import { claudeComposerBase } from "../vendors/claude.ts";
import { codexComposerBase } from "../vendors/codex.ts";
import type { VendorComposerBase } from "../vendors/types.ts";
import { BackgroundTasks, idleDelayMs } from "./background-tasks.ts";
import { personaSeenFromRow, takePersonaNote, type PersonaNoteTaken } from "./persona-note.ts";
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
import { buildChildEnv, mergeUserTexts } from "./protocol.ts";
import { trackChild } from "../process-ledger.ts";
import { takeSessionPreamble, type PreambleTaken } from "./session-preamble.ts";
import { dropUserEntries, untakenOnStopEvents } from "./stop-untaken.ts";
import { TurnUsage } from "./usage.ts";

/** 实时 token 用量推送节流间隔（毫秒）。 */
export const USAGE_THROTTLE_MS = USAGE_PUSH_MS;

export interface PendingEntry {
  messageIds: MessageId[];
  source: MessageSource;
  /** 用户原文（DriverSendInput.text）。 */
  text: string;
  /** 调用方加的标签（DriverSendInput.prefixes）。 */
  prefixes: string[];
  resend: boolean;
}

/** 写进这一轮前附带的一次性系统说明，写失败或被停止未取走时按需回退。 */
export interface BatchNotes {
  recovery: boolean;
  crash: boolean;
  relaunch: boolean;
  killed: string | null;
  persona: PersonaNoteTaken | null;
  preamble: PreambleTaken | null;
}

/** 命令那一行不带恢复、崩溃、重启等说明（见 takePendingBatch）。 */
export const NO_NOTES: BatchNotes = {
  recovery: false,
  crash: false,
  relaunch: false,
  killed: null,
  persona: null,
  preamble: null,
};

export type ClosingReason = "idle" | "interrupt" | "shutdown";

export type StartupOutcome<TConflict = string | null> =
  | { kind: "ok" }
  /** 没等到 init/thread 就自己退出了（或启动超时被强制结束）。 */
  | {
      kind: "failed";
      exitCode: number | null;
      signal: string | null;
      stderr: string;
      conflict?: TConflict;
      timedOut: boolean;
      errorMessage?: string;
    }
  /** 没等到 init/thread，是我们主动让它退的。 */
  | { kind: "closed"; reason: ClosingReason };

/** 进程启动时的设置快照：两轮之间和当前会话行对比，变了就自动重启。 */
export interface LaunchSnapshot {
  fingerprint: string;
  cwd: string;
  addDirs: string[];
  /** 启动时会话那一行的 model（配置的模型，账本和界面写，驱动层只读）。 */
  model: string | null;
  /** 同上，思考程度。 */
  effort: string | null;
}

export interface BaseBatch {
  messageIds: MessageId[];
  notes: BatchNotes;
  delivered: boolean;
  processing: boolean;
  midTurn?: boolean;
  source: MessageSource;
  stopped?: boolean;
  released?: "cancelled" | "requeued" | null;
}

export interface BaseProc<TOutcome = StartupOutcome> {
  child: ChildProcessWithoutNullStreams;
  resume: boolean;
  launched: LaunchSnapshot;
  /** 这次拼进提示词的性格设定是哪一版（LaunchFiles.personaRevision）：第一个 init 时定 agent 看到的版本。 */
  personaLaunched: number | null;
  /** 有后台任务时最多不关多久：LaunchFiles.backgroundHoldMaxMs，没给用 DriverOptions.backgroundHoldMaxMs。 */
  backgroundHoldMaxMs: number;
  initSeen: boolean;
  stderr: string;
  /** 我们自己让它退出的原因；null 表示没让它退。 */
  closing: ClosingReason | null;
  startTimedOut: boolean;
  /** 空闲关闭或打断的升级定时器：关了标准输入还不退，先 SIGINT，再 SIGKILL。 */
  killTimer: NodeJS.Timeout | null;
  /** 收到第一个 init/thread，或者没等到就退出了。 */
  ready: Promise<TOutcome>;
  resolveReady: (o: TOutcome) => void;
  /** 进程退出、输出读完（或到点强制关掉）、收尾做完。一定会 resolve。 */
  exited: Promise<void>;
}

export interface BaseSessionState<TProc extends BaseProc<any>, TBatch extends BaseBatch> {
  id: SessionId;
  proc: TProc | null;
  /** 已经写给子进程（或正要写）、还没收尾的批次，按写入先后排列。 */
  inFlight: TBatch[];
  /** 子进程自己开的一轮在跑（后台任务完成等，没有我们写的消息）：和 inFlight 一样算忙。 */
  selfTurn: boolean;
  /** 会话里还在跑的后台任务：有就不算闲着，进程启动或退出时清空。 */
  background: BackgroundTasks;
  turnInterrupted: boolean;
  /** 这一轮用户点过停止（interrupt 调过、这一轮还没收尾）：关机碰上它，仍按停止收尾。 */
  stopRequested: boolean;
  pending: PendingEntry[];
  /** 已经写进去（已送达）、还没失败的消息；这一轮出错或进程崩溃时删掉，好让重发真的再写一次。 */
  written: Set<MessageId>;
  /** agent 已经看到的性格设定、模式是哪一版（写进会话那一行的 personaRevision）；null 不比。 */
  personaSeen: number | null;
  /** 换代后的开场说明这个进程里带过了（还没等到账本记读到）。 */
  preambleTaken: boolean;
  recoveryNote: boolean;
  crashNote: boolean;
  /** 两轮之间因为设置变了重启过：下一条写进去的前面加 RELAUNCH_NOTE。 */
  relaunchNote: boolean;
  /** 关进程时还有后台任务跟着被结束：存给 agent 的说明（backgroundTasksKilledNote），下一条写进去前加一次。 */
  killedNote: string | null;
  /** end 调过了（同步标上）：之后的 start、send 抛 session_ended。 */
  ended: boolean;
  /** end 的那个 promise，再调 end 返回同一个。 */
  ending: Promise<void> | null;
  /** 等“这一轮结束或进程退出”的回调队列（end 用）。 */
  settleWaiters: Array<() => void>;
  /** 起进程参数选错后，下次该用恢复（true）还是新建（false）；启动成功后才写库。 */
  resumeHint: boolean | null;
  starting: Promise<void> | null;
  startTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  interruptTimer: NodeJS.Timeout | null;
  interruptWaiters: Array<() => void>;
  lastEventWrite: number;
  /** 这一轮的实时 token 累计；推给库和网页的节流（最多每 USAGE_THROTTLE_MS 一次）。 */
  turnUsage: TurnUsage;
  usageLatest: TokenUsage | null;
  usagePushedAt: number;
  usageTimer: NodeJS.Timeout | null;
}

export type BaseDriverOptions = Omit<DriverOptions, "claudePath"> & {
  claudePath?: string;
  composer?: VendorComposerBase;
};

export type ResolvedBaseDriverOptions = Required<
  Pick<
    DriverOptions,
    | "idleCloseMs"
    | "backgroundHoldMaxMs"
    | "interruptGraceMs"
    | "startTimeoutMs"
    | "shutdownGraceMs"
    | "commandsTimeoutMs"
    | "log"
  >
> &
  BaseDriverOptions;

export interface PendingBatchParts {
  body: { prefixes: string[]; text: string };
  messageIds: MessageId[];
  command: boolean;
  source: MessageSource;
}

export interface DriverHealthSnapshot {
  healthy: boolean;
  lastError: Extract<DriverEvent, { type: "driver.error" }> | null;
}

/** 创建公共会话状态初值，供各厂商驱动在 createSessionState 中展开补充厂商私有字段。 */
export function createBaseSessionState<TProc extends BaseProc<any>, TBatch extends BaseBatch>(
  id: SessionId,
): BaseSessionState<TProc, TBatch> {
  return {
    id,
    proc: null,
    inFlight: [],
    selfTurn: false,
    background: new BackgroundTasks(),
    turnInterrupted: false,
    stopRequested: false,
    pending: [],
    written: new Set(),
    personaSeen: null,
    preambleTaken: false,
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
    interruptWaiters: [],
    lastEventWrite: 0,
    turnUsage: new TurnUsage(),
    usageLatest: null,
    usagePushedAt: 0,
    usageTimer: null,
  };
}

/** 单独写一行时：重发说明、调用方的标签各占一块，原文放最后。 */
export function entryParts(entry: PendingEntry): { prefixes: string[]; text: string } {
  return { prefixes: entry.resend ? [RESEND_NOTE, ...entry.prefixes] : entry.prefixes, text: entry.text };
}

/** 和别的用户消息拼成一条时的那一条（拼进“【用户连发了 N 条】”的一项）：标签和原文换行连着，重发说明空一行。 */
export function flatEntryText(entry: PendingEntry): string {
  const text = [...entry.prefixes, entry.text].join("\n");
  return entry.resend ? `${RESEND_NOTE}\n\n${text}` : text;
}

/**
 * 从待发队列取出下一批：
 * - 队列里有用户消息就拼成一条（以命令开头的不拼：排在最前面的是命令就只写它，否则拼到下一条命令之前，顺序不乱）；
 * - 否则取最早的一条系统消息。
 */
export function takePendingBatch(
  pending: PendingEntry[],
  isCommand: (text: string) => boolean,
): { remaining: PendingEntry[]; taken: PendingBatchParts } | null {
  let body: { prefixes: string[]; text: string } | null = null;
  let messageIds: MessageId[] = [];
  let command = false;
  let remaining = pending;
  const users = pending.filter((e) => e.source === "user");
  if (users.length > 0) {
    const firstCommand = users.findIndex((e) => isCommand(e.text));
    command = firstCommand === 0;
    const take = command ? users.slice(0, 1) : firstCommand === -1 ? users : users.slice(0, firstCommand);
    remaining = pending.filter((e) => !take.includes(e));
    body = take.length === 1 ? entryParts(take[0]!) : mergeUserTexts(take.map(flatEntryText));
    messageIds = take.flatMap((e) => e.messageIds);
  } else if (pending.length > 0) {
    const [entry, ...rest] = pending;
    remaining = rest;
    body = entryParts(entry!);
    messageIds = entry!.messageIds;
  }
  if (body === null) return null;
  return {
    remaining,
    taken: {
      body,
      messageIds,
      command,
      source: users.length > 0 ? "user" : "system",
    },
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function clearKillTimer(proc: { killTimer: NodeJS.Timeout | null }): void {
  if (proc.killTimer) clearTimeout(proc.killTimer);
  proc.killTimer = null;
}

/** 等 promise，最多 ms 毫秒。 */
export async function within(promise: Promise<unknown>, ms: number): Promise<"done" | "timeout"> {
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
export function launchChanged(launched: LaunchSnapshot, row: AgentSessionRow, fingerprint: string): boolean {
  return (
    launched.fingerprint !== fingerprint ||
    launched.cwd !== row.cwd ||
    launched.model !== row.model ||
    launched.effort !== row.effort ||
    launched.addDirs.length !== row.addDirs.length ||
    launched.addDirs.some((d, i) => d !== row.addDirs[i])
  );
}

/**
 * 多厂商公共会话驱动底座：管理会话状态表、待发队列、生命周期定时器、用量节流上报、健康状态报错与子进程收尾。
 */
export abstract class BaseSessionDriver<
  TProc extends BaseProc<any>,
  TBatch extends BaseBatch,
  TState extends BaseSessionState<TProc, TBatch>,
> implements Driver
{
  protected readonly vendor: AgentVendor;
  protected readonly opts: ResolvedBaseDriverOptions;
  protected readonly composer: VendorComposerBase;
  protected readonly sessions = new Map<SessionId, TState>();
  readonly #listeners = new Set<DriverEventListener>();
  readonly #health = new Map<SessionId, DriverHealthSnapshot>();
  protected shuttingDown = false;
  protected requestSeq = 0;
  /** 正在报监听者的错：这时监听者再抛错只打到标准错误，免得递归死循环。 */
  #reportingListenerError = false;

  protected constructor(vendor: AgentVendor, { composer, ...options }: BaseDriverOptions) {
    this.vendor = vendor;
    this.composer =
      composer ??
      ({ claude: claudeComposerBase, agy: agyComposerBase, codex: codexComposerBase } satisfies Record<
        AgentVendor,
        VendorComposerBase
      >)[vendor];
    this.opts = {
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

  /** 子类实现：创建指定会话的初始状态。 */
  protected abstract createSessionState(id: SessionId): TState;
  /** 子类实现：从待发队列取下一批并构造厂商批次。 */
  protected abstract takeBatch(st: TState): TBatch | null;
  /** 子类实现：启动子进程（或使用已起进程）并写入首个批次。 */
  protected abstract startup(
    st: TState,
    batch: TBatch,
    existing: TProc | null,
    files: LaunchFiles | null,
  ): Promise<void>;
  /** 子类实现：向已就绪进程写入一个批次。 */
  protected abstract writeBatch(st: TState, proc: TProc, batch: TBatch): Promise<void>;
  /** 子类实现：start() 在队列为空时仅拉起空闲进程。 */
  protected abstract spawnIdleProcess(st: TState, resume: boolean): Promise<TProc>;
  /** 子类实现：判断下次起进程是否用恢复模式。 */
  protected abstract resumeFor(st: TState): boolean;
  /** 子类实现：识别指定 PID 是否为本驱动对应会话的残留进程，返回其进程组号 pgid 或 null。 */
  protected abstract identifyStaleProcess(pid: number, row: AgentSessionRow): Promise<number | null>;
  /** 子类可选覆写：cleanupStale 时只筛本厂商的会话行。 */
  protected filterStaleRow?(row: AgentSessionRow): boolean;
  /** 子类实现：处理子进程标准输出的一行 JSON 对象。 */
  protected abstract onParsedLine(
    st: TState,
    proc: TProc,
    obj: Record<string, unknown>,
    rawLine: string,
    at: number,
  ): void;
  /** 子类实现：处理子进程退出与流排空后的收尾。 */
  protected abstract onProcessClose(
    st: TState,
    proc: TProc,
    code: number | null,
    signal: NodeJS.Signals | null,
    resolveExited: () => void,
  ): void;

  abstract send(sessionId: SessionId, input: DriverSendInput): Promise<DriverSendResult>;
  abstract interrupt(sessionId: SessionId): Promise<void>;

  onEvent(listener: DriverEventListener): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  isRunning(sessionId: SessionId): boolean {
    const proc = this.sessions.get(sessionId)?.proc;
    return Boolean(proc && !proc.closing);
  }

  async start(sessionId: SessionId): Promise<void> {
    this.assertRunning();
    const st = this.state(sessionId);
    this.assertNotEnded(st);
    for (;;) {
      if (st.starting) return st.starting;
      this.assertNotEnded(st);
      const proc = st.proc;
      if (proc?.closing) {
        await proc.exited;
        this.assertRunning();
        continue;
      }
      if (proc) {
        if (proc.initSeen || st.inFlight.length > 0) return;
        const batch = this.takeBatch(st);
        return batch ? this.runStartup(st, batch, proc) : undefined;
      }
      const batch = this.takeBatch(st);
      if (batch) return this.runStartup(st, batch, null);
      const promise: Promise<void> = this.spawnIdleProcess(st, this.resumeFor(st))
        .then((p) => {
          this.abortIfStopped(st, p);
          this.armIdle(st, p);
        })
        .finally(() => {
          if (st.starting === promise) st.starting = null;
        });
      st.starting = promise;
      return promise;
    }
  }

  end(sessionId: SessionId): Promise<void> {
    const st = this.state(sessionId);
    if (st.ending) return st.ending;
    // 同步标上：从这一刻起 start、send 抛 session_ended；待发队列里没写的丢掉
    st.ended = true;
    st.pending = [];
    st.recoveryNote = false;
    st.crashNote = false;
    st.relaunchNote = false;
    st.killedNote = null;
    this.clearTimer(st, "idleTimer");
    st.ending = this.#finishEnd(st);
    return st.ending;
  }

  /** 正在跑一轮就等它回完（不打断），然后关标准输入、等进程退出，最后写 ended。 */
  async #finishEnd(st: TState): Promise<void> {
    for (;;) {
      if (st.starting) {
        await st.starting.catch(() => {});
        continue;
      }
      const proc = st.proc;
      if (proc && this.busy(st) && !proc.closing) {
        await new Promise<void>((resolve) => st.settleWaiters.push(resolve));
        continue;
      }
      break;
    }
    const proc = st.proc;
    if (proc) {
      this.clearTimer(st, "idleTimer");
      if (!proc.closing) this.closeStdin(st, proc, "idle");
      await proc.exited;
    }
    this.update(st, { status: "ended", pid: null });
  }

  queryCommands(_sessionId: SessionId): Promise<ComposerCommand[] | null> {
    return Promise.resolve(null);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const procs: TProc[] = [];
    for (const st of this.sessions.values()) {
      this.clearTimer(st, "idleTimer");
      this.clearTimer(st, "interruptTimer");
      const proc = st.proc;
      if (!proc) continue;
      procs.push(proc);
      clearKillTimer(proc);
      if (proc.closing === "shutdown" || proc.closing === "interrupt") continue;
      // 用户的停止还没收尾：照停止处理，消息标已停止，不当关机打断留着重发
      if (st.stopRequested && this.busy(st)) {
        proc.closing = "interrupt";
        signalChild(proc.child, "SIGINT");
        continue;
      }
      const wasIdle = proc.closing === "idle" || (!this.busy(st) && proc.initSeen);
      proc.closing = "shutdown";
      if (wasIdle) proc.child.stdin.end();
      else signalChild(proc.child, "SIGINT");
    }
    if (procs.length > 0) {
      const all = Promise.all(procs.map((p) => p.exited));
      if ((await within(all, this.opts.shutdownGraceMs)) === "timeout") {
        await Promise.all(procs.map((p) => forceKill(p.child)));
        await within(all, KILL_WAIT_MS);
      }
    }
  }

  async cleanupStale(): Promise<void> {
    let rows: AgentSessionRow[];
    try {
      rows = this.opts.store.listWithProcess();
    } catch (error) {
      throw new DriverError("internal_error", `listWithProcess failed: ${errorMessage(error)}`);
    }
    const filtered = this.filterStaleRow ? rows.filter((row) => this.filterStaleRow!(row)) : rows;
    await Promise.all(filtered.map((row) => this.#cleanupStaleRow(row)));
  }

  async #cleanupStaleRow(row: AgentSessionRow): Promise<void> {
    const pid = row.pid;
    if (pid === null) return;
    // 这一次自己起的进程不算残留
    if (this.sessions.get(row.id)?.proc?.child.pid === pid) return;
    const pgid = await this.identifyStaleProcess(pid, row);
    if (pgid !== null) {
      const target = signalTarget(pid);
      if (target !== null) signalPid(target, "SIGINT");
      if (await waitForExit(pid, this.opts.interruptGraceMs)) {
        if (pgid === pid) termGroupAfterExit({ pid });
      } else {
        // 只有它自己是进程组长（我们 detached 起的）才按组杀；不是的话按组杀会连累同组的别的进程
        await forceKillTree(pid, pgid === pid);
        await waitForExit(pid, KILL_WAIT_MS);
      }
    }
    this.update(this.state(row.id), { pid: null, status: row.status === "ended" ? "ended" : "idle" });
  }

  // --- 会话状态与队列调度 ---

  protected state(id: SessionId): TState {
    let st = this.sessions.get(id);
    if (!st) {
      st = this.createSessionState(id);
      this.sessions.set(id, st);
    }
    return st;
  }

  /** 已经在待发队列里，或者就是正在途中的那一批。 */
  protected isPending(st: TState, ids: MessageId[]): boolean {
    const covers = (batchIds: MessageId[]) => ids.every((id) => batchIds.includes(id));
    if (st.inFlight.some((b) => covers(b.messageIds))) return true;
    return st.pending.some((e) => covers(e.messageIds));
  }

  /** 从 st.pending 取出下一批用户或系统消息并更新 st.pending。 */
  protected takePendingEntryBatch(st: TState): PendingBatchParts | null {
    const res = takePendingBatch(st.pending, (text) => this.composer.isCommand(text));
    if (!res) return null;
    st.pending = res.remaining;
    return res.taken;
  }

  /**
   * 组装非命令行的系统说明前缀（换代开场说明、重启恢复、崩溃恢复、设置变更重启、后台任务被结束、性格设定修改），
   * 并清空一次性状态标记。
   */
  protected takeNotesPrefixes(
    st: TState,
    options?: { takePersona?: boolean; fromRowOnFirstPersonaCheck?: boolean },
  ): { notes: BatchNotes; prefixes: string[] } {
    const preamble = this.takeSessionPreamble(st);
    const persona =
      options?.takePersona === false
        ? null
        : this.takePersonaNote(st, options?.fromRowOnFirstPersonaCheck ?? true);
    const notes: BatchNotes = {
      recovery: st.recoveryNote,
      crash: st.crashNote,
      relaunch: st.relaunchNote,
      killed: st.killedNote,
      persona,
      preamble,
    };
    const prefixes = [
      preamble?.note ?? null,
      notes.recovery ? RESTART_RECOVERY_NOTE : null,
      notes.crash ? CRASH_RECOVERY_NOTE : null,
      notes.relaunch ? RELAUNCH_NOTE : null,
      notes.killed,
      persona?.note ?? null,
    ].filter((p): p is string => p !== null);
    st.recoveryNote = false;
    st.crashNote = false;
    st.relaunchNote = false;
    st.killedNote = null;
    return { notes, prefixes };
  }

  /** 停止时：待发队列里用户的那几条丢掉、标已取消（系统消息留着，停止后照常发）。 */
  protected dropPendingUsers(st: TState): void {
    const { kept, dropped } = dropUserEntries(st.pending);
    st.pending = kept;
    if (dropped.length > 0) {
      this.emit(st.id, { type: "message.cancelled", messageIds: dropped, reason: "stop", at: Date.now() });
    }
  }

  /** 没写成的一批：恢复说明留给下一批；消息本身不放回队列，由调用方重试 send 时再排。 */
  protected dropBatch(st: TState, batch: TBatch): void {
    st.inFlight = st.inFlight.filter((b) => b !== batch);
    if (batch.notes.recovery) st.recoveryNote = true;
    if (batch.notes.crash) st.crashNote = true;
    if (batch.notes.relaunch) st.relaunchNote = true;
    if (batch.notes.killed !== null) st.killedNote = batch.notes.killed;
    batch.notes.persona?.restore();
    batch.notes.preamble?.restore();
  }

  protected takeSessionPreamble(st: TState): PreambleTaken | null {
    return takeSessionPreamble(this.opts.sessionPreamble, st.id, st, (error) =>
      this.internalError(st.id, `sessionPreamble failed, writing without it: ${errorMessage(error)}`),
    );
  }

  protected takePersonaNote(st: TState, fromRowOnFirstCheck = true): PersonaNoteTaken | null {
    if (fromRowOnFirstCheck && st.personaSeen === null) {
      st.personaSeen = personaSeenFromRow(this.row(st));
    }
    return takePersonaNote(
      this.opts.personaNote,
      st.id,
      st,
      (revision) => this.update(st, { personaRevision: revision }),
      (error) => this.internalError(st.id, `personaNote failed, writing without it: ${errorMessage(error)}`),
    );
  }

  protected setPersonaSeen(st: TState, revision: number | null): void {
    if (revision === null || revision === st.personaSeen) return;
    st.personaSeen = revision;
    this.update(st, { personaRevision: revision });
  }

  protected async pump(st: TState): Promise<void> {
    for (;;) {
      this.assertRunning();
      this.assertNotEnded(st);
      if (st.starting) return;
      const proc = st.proc;
      if (proc?.closing) {
        await proc.exited;
        continue;
      }
      if (proc && this.busy(st)) return;
      if (st.pending.length === 0) return;
      if (proc) {
        await this.deliverNext(st, proc);
        continue;
      }
      const batch = this.takeBatch(st);
      if (!batch) return;
      return this.runStartup(st, batch, null);
    }
  }

  /**
   * 往一个已经在跑、空闲的进程写下一批（“两轮之间自动重启”）：先调一次 prepareLaunch，设置和这个进程启动时一样就直接写；
   * 不一样就关标准输入、等它退出，用这次的结果恢复起一个新的，前面加 RELAUNCH_NOTE 再写。
   */
  protected deliverNext(st: TState, proc: TProc): Promise<void> {
    const run = async () => {
      this.clearTimer(st, "idleTimer");
      let files: LaunchFiles | null = null;
      try {
        files = await this.opts.prepareLaunch(this.store(st));
      } catch (error) {
        this.internalError(
          st.id,
          `prepareLaunch before writing failed, keeping the running process: ${errorMessage(error)}`,
        );
      }
      this.assertRunning();
      if (st.ended || st.proc !== proc || proc.closing || this.busy(st)) return;
      const row = files ? this.row(st) : null;
      if (files && row && launchChanged(proc.launched, row, files.fingerprint)) {
        if (st.background.active) {
          st.killedNote = backgroundTasksKilledNote("relaunch", st.background.descriptions());
        }
        this.closeStdin(st, proc, "idle");
        await proc.exited;
        this.assertRunning();
        if (st.ended) return;
        st.relaunchNote = true;
        const batch = this.takeBatch(st);
        if (batch) await this.startup(st, batch, null, files);
        return;
      }
      const batch = this.takeBatch(st);
      if (!batch) return;
      if (proc.initSeen) await this.writeBatch(st, proc, batch);
      else await this.startup(st, batch, proc, null);
    };
    const promise: Promise<void> = run().finally(() => {
      if (st.starting === promise) st.starting = null;
    });
    st.starting = promise;
    return promise;
  }

  protected runStartup(st: TState, batch: TBatch, existing: TProc | null): Promise<void> {
    const promise: Promise<void> = this.startup(st, batch, existing, null).finally(() => {
      if (st.starting === promise) st.starting = null;
    });
    st.starting = promise;
    return promise;
  }

  protected markDelivered(st: TState, batch: TBatch): void {
    if (batch.delivered) return;
    batch.delivered = true;
    for (const id of batch.messageIds) st.written.add(id);
    if (batch.messageIds.length === 0) return;
    this.emit(st.id, {
      type: "message.delivered",
      messageIds: batch.messageIds,
      ...(batch.midTurn ? { midTurn: true as const } : {}),
      at: Date.now(),
    });
  }

  protected markProcessing(st: TState, batch: TBatch, at: number): void {
    this.markDelivered(st, batch);
    if (batch.processing || batch.messageIds.length === 0) return;
    batch.processing = true;
    this.emit(st.id, {
      type: "message.processing",
      messageIds: batch.messageIds,
      ...(batch.notes.preamble ? { preamble: true as const } : {}),
      at,
    });
  }

  /** 这几批要重写（出错、崩溃、收回）：不再算写过；带着的性格设定和换代说明也退回去。 */
  protected forgetWritten(st: TState, batches: Iterable<TBatch | null | undefined>): void {
    for (const batch of batches) {
      if (!batch) continue;
      for (const id of batch.messageIds) st.written.delete(id);
      batch.notes.persona?.restore();
      batch.notes.preamble?.restore();
    }
  }

  /** 停止时 agent 还没取走的批次：用户的标已取消，不重发；系统的收回重发（stop-untaken.ts）。 */
  protected releaseOnStop(st: TState, batches: TBatch[], at: number): void {
    if (batches.length === 0) return;
    for (const b of batches) {
      b.released = b.source === "user" ? "cancelled" : "requeued";
      b.notes.persona?.restore();
      b.notes.preamble?.restore();
    }
    this.forgetWritten(
      st,
      batches.filter((b) => b.source === "system"),
    );
    for (const event of untakenOnStopEvents(batches, at)) this.emit(st.id, event);
  }

  /**
   * 已写入但本轮未取走（或进程退出未处理）的批次：
   * - 若因用户停止（stopped === true）：用户的标已取消、系统的收回；
   * - 否则（崩溃、关机、正常轮结束漏读）：全部收回让账本重新登记发送。
   */
  protected releaseUntaken(st: TState, batches: TBatch[], stopped: boolean, at: number): void {
    const messageIds = batches.flatMap((b) => b.messageIds);
    if (messageIds.length === 0) return;
    if (stopped) {
      this.releaseOnStop(st, batches, at);
      return;
    }
    for (const b of batches) b.released = "requeued";
    this.forgetWritten(st, batches);
    this.emit(st.id, { type: "message.requeued", messageIds, at });
  }

  protected afterTurn(st: TState, proc: TProc): void {
    if (st.proc !== proc || proc.closing || this.shuttingDown || st.ended || this.busy(st)) return;
    if (st.pending.length > 0) void this.deliverNext(st, proc).catch(() => {});
    else this.armIdle(st, proc);
  }

  protected busy(st: TState): boolean {
    return st.inFlight.length > 0 || st.selfTurn;
  }

  protected settled(st: TState): void {
    for (const w of st.settleWaiters.splice(0)) w();
  }

  /**
   * 后台任务名单更新：记录最新名单，若有变化则发射 background.changed；
   * 若“是否有任务”发生变化且当前正在空闲倒计时，则按新状态重新计时。
   */
  protected onBackgroundTasksChanged(st: TState, proc: TProc, rawTasks: unknown): void {
    if (st.proc !== proc) return;
    const wasActive = st.background.active;
    if (!st.background.replace(rawTasks)) return;
    this.emit(st.id, { type: "background.changed", count: st.background.count, at: Date.now() });
    if (st.background.active === wasActive || st.idleTimer === null) return;
    if (!proc.closing && !this.busy(st) && !st.ended) this.armIdle(st, proc);
  }

  /**
   * 空闲但只剩后台任务时调 interrupt()：直接关闭进程把后台任务一并停掉，并在下一条消息前附上说明。
   * 返回进程退出 Promise；若当前不适用则返回 null。
   */
  protected stopIdleBackgroundTasks(st: TState, proc: TProc): Promise<void> | null {
    if (this.busy(st) || !st.background.active) return null;
    this.logSession(st.id, `停止时只剩 ${st.background.count} 个后台任务，关掉进程把它们一起停掉`);
    st.killedNote = backgroundTasksKilledNote("stopped", st.background.descriptions());
    this.clearTimer(st, "idleTimer");
    this.closeStdin(st, proc, "interrupt");
    return proc.exited;
  }

  /**
   * 开始算空闲。有后台任务时计时放宽到这个进程的 backgroundHoldMaxMs（兜底，到点照常关）；
   * 任务清零时 onBackgroundTasksChanged 重新调这里，从头算 idleCloseMs。
   */
  protected armIdle(st: TState, proc: TProc): void {
    this.clearTimer(st, "idleTimer");
    st.idleTimer = setTimeout(() => {
      st.idleTimer = null;
      if (st.proc !== proc || proc.closing || this.busy(st) || st.pending.length > 0 || st.starting || st.ended) return;
      if (st.background.active) {
        this.logSession(
          st.id,
          `后台任务还有 ${st.background.count} 个没结束，已超过 ${proc.backgroundHoldMaxMs} ms，照常空闲关闭`,
        );
        st.killedNote = backgroundTasksKilledNote("hold_max", st.background.descriptions());
      }
      this.closeStdin(st, proc, "idle");
    }, idleDelayMs(st.background, this.opts.idleCloseMs, proc.backgroundHoldMaxMs));
  }

  /** 关标准输入让它正常退出；还不退：先给子进程本身 SIGINT，再强制结束（连同所有后代的进程组）。 */
  protected closeStdin(st: TState, proc: TProc, reason: ClosingReason): void {
    proc.closing = reason;
    proc.child.stdin.end();
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

  /**
   * 打断升级为向子进程发 SIGINT，并可按需设置超时强杀定时器。
   */
  protected sigintForInterrupt(
    st: TState,
    proc: TProc,
    escalateTimer: "none" | "interruptTimer" | "killTimer" = "none",
  ): void {
    if (st.proc !== proc || proc.closing) return;
    proc.closing = "interrupt";
    signalChild(proc.child, "SIGINT");
    if (escalateTimer === "interruptTimer") {
      this.clearTimer(st, "interruptTimer");
      st.interruptTimer = setTimeout(() => {
        st.interruptTimer = null;
        this.forceKillProc(st, proc);
      }, this.opts.interruptGraceMs);
    } else if (escalateTimer === "killTimer") {
      clearKillTimer(proc);
      proc.killTimer = setTimeout(() => {
        proc.killTimer = null;
        this.forceKillProc(st, proc);
      }, this.opts.interruptGraceMs);
    }
  }

  protected abortIfStopped(st: TState, proc: TProc): void {
    this.assertRunning();
    if (!st.ended) return;
    if (!proc.closing) this.closeStdin(st, proc, "idle");
    throw new DriverError("session_ended", `session ${st.id} has been ended`);
  }

  protected armStartTimer(st: TState, proc: TProc): void {
    if (st.startTimer || proc.initSeen) return;
    st.startTimer = setTimeout(() => {
      st.startTimer = null;
      if (st.proc !== proc || proc.initSeen) return;
      proc.startTimedOut = true;
      this.forceKillProc(st, proc);
    }, this.opts.startTimeoutMs);
  }

  // --- 子进程启动与输出绑定辅助 ---

  protected async resolveLaunchFiles(
    st: TState,
    prepared: LaunchFiles | null,
  ): Promise<{ row: AgentSessionRow; files: LaunchFiles }> {
    let row = this.store(st);
    let files = prepared;
    if (!files) {
      try {
        files = await this.opts.prepareLaunch(row);
      } catch (error) {
        if (error instanceof DriverError && error.code === "session_ended") throw error;
        throw new DriverError("spawn_failed", `prepareLaunch failed: ${errorMessage(error)}`);
      }
      row = this.store(st);
    }
    this.assertRunning();
    this.assertNotEnded(st);
    if (!existsSync(row.cwd)) {
      throw new DriverError("spawn_failed", `working directory does not exist: ${row.cwd}`);
    }
    return { row, files };
  }

  protected async spawnDetachedChild(
    binaryPath: string,
    command: string,
    args: string[],
    cwd: string,
    extraEnv: Record<string, string>,
    onCleanup?: () => void,
  ): Promise<ChildProcessWithoutNullStreams> {
    const child = spawn(command, args, {
      cwd,
      env: buildChildEnv(process.env, { ...this.opts.env, ...extraEnv }),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    trackChild(child, `agent:${this.vendor}`, { detached: true });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } catch (error) {
      onCleanup?.();
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new DriverError(notFoundCode(this.vendor), `${binaryPath}: ${errorMessage(error)}`);
      }
      throw new DriverError("spawn_failed", `${binaryPath}: ${errorMessage(error)}`);
    }
    if (this.shuttingDown) {
      killFreshGroup(child);
      onCleanup?.();
      this.assertRunning();
    }
    return child;
  }

  protected createBaseProc<TOutcome = StartupOutcome>(
    child: ChildProcessWithoutNullStreams,
    resume: boolean,
    row: AgentSessionRow,
    files: LaunchFiles,
  ): { baseProc: BaseProc<TOutcome>; resolveExited: () => void } {
    let resolveReady!: (o: TOutcome) => void;
    let resolveExited!: () => void;
    const baseProc: BaseProc<TOutcome> = {
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
      backgroundHoldMaxMs: files.backgroundHoldMaxMs ?? this.opts.backgroundHoldMaxMs,
      initSeen: false,
      stderr: "",
      closing: null,
      startTimedOut: false,
      killTimer: null,
      ready: new Promise((resolve) => (resolveReady = resolve)),
      resolveReady: (o) => resolveReady(o),
      exited: new Promise((resolve) => (resolveExited = resolve)),
    };
    return { baseProc, resolveExited: () => resolveExited() };
  }

  protected attachChildProcess(
    st: TState,
    proc: TProc,
    resolveExited: () => void,
    onExitCleanup?: () => void,
  ): void {
    const { child } = proc;
    st.proc = proc;
    st.background.clear();
    this.update(st, { pid: child.pid ?? null });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
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
        this.handleOutputLine(st, proc, line);
      }
    });
    // 用 exit 不用 close：agent 起的孙进程可能还占着标准输出，close 会一直等它
    const drained = Promise.all([streamClosed(child.stdout), streamClosed(child.stderr)]);
    child.once("exit", (code, signal) => {
      onExitCleanup?.();
      // 我们让它退的（空闲关闭、end、重启、关机，以及空闲时的停止）：确认退出这一刻给原来的进程组补信号，清掉它留下的子进程。
      // 关机也要补：Linux bwrap 下外层先退，namespace 的 PID 1 会被后台子进程拖住，不补就一直留着，下次启动 cleanupStale 也认不出来
      if (proc.closing === "idle" || proc.closing === "shutdown" || (proc.closing === "interrupt" && !this.busy(st))) {
        termGroupAfterExit(child);
      }
      const timer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, STDIO_DRAIN_MS);
      void drained.then(() => {
        clearTimeout(timer);
        if (buffered !== "") this.handleOutputLine(st, proc, buffered);
        buffered = "";
        this.onProcessClose(st, proc, code, signal, resolveExited);
      });
    });
  }

  protected handleOutputLine(st: TState, proc: TProc, rawLine: string): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    try {
      if (line.trim() === "") return;
      let obj: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("not an object");
        }
        obj = parsed as Record<string, unknown>;
      } catch {
        this.reportError(st.id, "bad_output_line", `bad_output_line: ${line.slice(0, 200)}`);
        return;
      }
      const at = Date.now();
      this.touch(st, at);
      this.onParsedLine(st, proc, obj, line, at);
    } catch (error) {
      this.internalError(st.id, `handling output line failed: ${errorMessage(error)}`);
    }
  }

  /** 子进程退出时的公共前置清理：清理当前 proc、后台任务、定时器、冲刷用量并更新会话行状态为 idle。 */
  protected beginProcessClose(st: TState, proc: TProc): number {
    if (st.proc === proc) {
      st.proc = null;
      st.background.clear();
    }
    clearKillTimer(proc);
    this.clearTimer(st, "startTimer");
    this.clearTimer(st, "idleTimer");
    this.clearTimer(st, "interruptTimer");
    this.flushUsage(st);
    st.turnUsage.reset();
    const at = Date.now();
    this.update(st, { pid: null, status: "idle", lastEventAt: at });
    return at;
  }

  // --- 健康状态、报错、日志与用量节流 ---

  /** 记录并上报驱动错误事件（driver.error），同时将该会话健康状态标为异常。 */
  protected reportError(
    sessionId: SessionId,
    code: DriverErrorCode,
    message: string,
    messageIds?: MessageId[],
  ): void {
    const event: Extract<DriverEvent, { type: "driver.error" }> = {
      type: "driver.error",
      code,
      message,
      ...(messageIds !== undefined ? { messageIds } : {}),
      at: Date.now(),
    };
    this.#health.set(sessionId, { healthy: false, lastError: event });
    this.emit(sessionId, event);
  }

  /** 标记该会话驱动状态健康（如收到 init 或成功完成一轮）。 */
  protected markHealthy(sessionId: SessionId): void {
    const prev = this.#health.get(sessionId);
    this.#health.set(sessionId, { healthy: true, lastError: prev?.lastError ?? null });
  }

  /** 查询会话当前的健康状态快照。 */
  getHealth(sessionId: SessionId): DriverHealthSnapshot {
    return this.#health.get(sessionId) ?? { healthy: true, lastError: null };
  }

  /** 通用日志输出。 */
  protected log(line: string): void {
    this.opts.log(line);
  }

  /** 带会话前缀的通用日志包装。 */
  protected logSession(sessionId: SessionId, detail: string): void {
    this.opts.log(`[driver] session ${sessionId}: ${detail}`);
  }

  protected resolveInterrupt(st: TState): void {
    for (const w of st.interruptWaiters.splice(0)) w();
  }

  protected invalidInput(st: TState, problem: string, messageIds: MessageId[]): void {
    this.reportError(st.id, "invalid_input", `invalid_input: ${problem}`, messageIds);
  }

  /** 不等结果的强制结束：出错不往上冒，记一条 internal_error。 */
  protected forceKillProc(st: TState, proc: TProc): void {
    forceKill(proc.child).catch((error: unknown) =>
      this.internalError(st.id, `force kill failed: ${errorMessage(error)}`),
    );
  }

  protected internalError(sessionId: SessionId, detail: string): void {
    this.reportError(sessionId, "internal_error", `internal_error: ${detail}`);
  }

  /** start、send、起进程时用：找不到那一行抛不可重试的错。 */
  protected store(st: TState): AgentSessionRow {
    let row: AgentSessionRow | null;
    try {
      row = this.opts.store.get(st.id);
    } catch (error) {
      throw new DriverError("internal_error", `reading agent session ${st.id} failed: ${errorMessage(error)}`);
    }
    if (!row) throw new DriverError("internal_error", `no agent session ${st.id}`);
    return row;
  }

  /** 处理输出时用：出错不往上冒，记一条 internal_error，返回 null。 */
  protected row(st: TState): AgentSessionRow | null {
    try {
      return this.store(st);
    } catch (error) {
      this.internalError(st.id, errorMessage(error));
      return null;
    }
  }

  protected update(st: TState, patch: AgentSessionPatch): void {
    if (patch.lastEventAt !== undefined && patch.lastEventAt !== null) st.lastEventWrite = patch.lastEventAt;
    try {
      this.opts.store.update(st.id, patch);
    } catch (error) {
      this.internalError(st.id, `updating agent session ${st.id} failed: ${errorMessage(error)}`);
    }
  }

  /** 实时的 token 累计：距上次推送够 USAGE_THROTTLE_MS 就马上推，不够就等到点推最新的。 */
  protected pushUsage(st: TState, usage: TokenUsage): void {
    st.usageLatest = usage;
    const wait = USAGE_THROTTLE_MS - (Date.now() - st.usagePushedAt);
    if (wait <= 0) this.flushUsage(st);
    else if (st.usageTimer === null) {
      st.usageTimer = setTimeout(() => this.flushUsage(st), wait);
      st.usageTimer.unref();
    }
  }

  protected flushUsage(st: TState): void {
    const usage = st.usageLatest;
    this.cancelUsagePush(st);
    if (usage === null) return;
    st.usagePushedAt = Date.now();
    this.update(st, { usage });
  }

  protected cancelUsagePush(st: TState): void {
    if (st.usageTimer) clearTimeout(st.usageTimer);
    st.usageTimer = null;
    st.usageLatest = null;
  }

  protected touch(st: TState, at: number): void {
    if (at - st.lastEventWrite >= LAST_EVENT_WRITE_MS) this.update(st, { lastEventAt: at });
  }

  protected clearTimer(st: TState, key: "startTimer" | "idleTimer" | "interruptTimer"): void {
    const timer = st[key];
    if (timer) clearTimeout(timer);
    st[key] = null;
  }

  protected emit(sessionId: SessionId, event: DriverEvent): void {
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
      this.internalError(sessionId, detail);
    } finally {
      this.#reportingListenerError = false;
    }
  }

  protected assertRunning(): void {
    if (this.shuttingDown) throw new DriverError("spawn_failed", "driver is shutting down");
  }

  /** end 调过了，或者库里已经是 ended（上次守护进程结束的）：抛 session_ended，不起进程、不调 prepareLaunch。 */
  protected assertNotEnded(st: TState): void {
    if (st.ended || this.store(st).status === "ended") {
      throw new DriverError("session_ended", `session ${st.id} has been ended`);
    }
  }
}
