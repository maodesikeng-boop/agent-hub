// Shared session state machine for vendor drivers in src/vendors/<vendor>/driver.ts.
import { type ChildProcessWithoutNullStreams } from "node:child_process";
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
import type { VendorComposerBase } from "../vendors/types.ts";
import { BackgroundTasks, idleDelayMs } from "./background-tasks.ts";
import { withPmMemoryAddDir } from "./pm-memory-dirs.ts";
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
import { spawnOwnedProcess } from "../platform/index.ts";
import { trackChild } from "../process-ledger.ts";
import { takeSessionPreamble, type PreambleTaken } from "./session-preamble.ts";
import { dropUserEntries, untakenOnStopEvents } from "./stop-untaken.ts";
import { TurnUsage } from "./usage.ts";

export const USAGE_THROTTLE_MS = USAGE_PUSH_MS;

export interface PendingEntry {
  messageIds: MessageId[];
  source: MessageSource;
  text: string;
  prefixes: string[];
  resend: boolean;
}

export interface BatchNotes {
  recovery: boolean;
  crash: boolean;
  relaunch: boolean;
  killed: string | null;
  persona: PersonaNoteTaken | null;
  preamble: PreambleTaken | null;
}

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
  | {
      kind: "failed";
      exitCode: number | null;
      signal: string | null;
      stderr: string;
      conflict?: TConflict;
      timedOut: boolean;
      errorMessage?: string;
    }
  | { kind: "closed"; reason: ClosingReason };

export interface LaunchSnapshot {
  fingerprint: string;
  cwd: string;
  addDirs: string[];
  model: string | null;
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
  personaLaunched: number | null;
  backgroundHoldMaxMs: number;
  initSeen: boolean;
  stderr: string;
  closing: ClosingReason | null;
  startTimedOut: boolean;
  /** Escalation when the CLI ignores a closed stdin: SIGINT first, then SIGKILL. */
  killTimer: NodeJS.Timeout | null;
  ready: Promise<TOutcome>;
  resolveReady: (o: TOutcome) => void;
  exited: Promise<void>;
}

export interface BaseSessionState<TProc extends BaseProc<any>, TBatch extends BaseBatch> {
  id: SessionId;
  proc: TProc | null;
  inFlight: TBatch[];
  selfTurn: boolean;
  background: BackgroundTasks;
  turnInterrupted: boolean;
  /** A user stop in progress still finishes as a stop even if shutdown arrives. */
  stopRequested: boolean;
  pending: PendingEntry[];
  /** Removed when a turn errors or the process crashes so the message can be resent. */
  written: Set<MessageId>;
  personaSeen: number | null;
  preambleTaken: boolean;
  recoveryNote: boolean;
  crashNote: boolean;
  relaunchNote: boolean;
  killedNote: string | null;
  ended: boolean;
  ending: Promise<void> | null;
  settleWaiters: Array<() => void>;
  /** Persist resume versus fresh only after a successful start, in case the chosen launch args were wrong. */
  resumeHint: boolean | null;
  starting: Promise<void> | null;
  startTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  interruptTimer: NodeJS.Timeout | null;
  interruptWaiters: Array<() => void>;
  lastEventWrite: number;
  turnUsage: TurnUsage;
  usageLatest: TokenUsage | null;
  usagePushedAt: number;
  usageTimer: NodeJS.Timeout | null;
}

export type BaseDriverOptions = Omit<DriverOptions, "executablePath"> & {
  composer: VendorComposerBase;
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
  Omit<BaseDriverOptions, "composer">;

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

export function entryParts(entry: PendingEntry): { prefixes: string[]; text: string } {
  return { prefixes: entry.resend ? [RESEND_NOTE, ...entry.prefixes] : entry.prefixes, text: entry.text };
}

export function flatEntryText(entry: PendingEntry): string {
  const text = [...entry.prefixes, entry.text].join("\n");
  return entry.resend ? `${RESEND_NOTE}\n\n${text}` : text;
}

/** Queued user messages merge into one batch, but never across a command so ordering is preserved. */
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
  /** Listener errors raised while reporting a listener error go to stderr only, to avoid infinite recursion. */
  #reportingListenerError = false;

  protected constructor(vendor: AgentVendor, { composer, ...options }: BaseDriverOptions) {
    this.vendor = vendor;
    this.composer = composer;
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

  protected abstract createSessionState(id: SessionId): TState;
  protected abstract takeBatch(st: TState): TBatch | null;
  protected abstract startup(
    st: TState,
    batch: TBatch,
    existing: TProc | null,
    files: LaunchFiles | null,
  ): Promise<void>;
  protected abstract writeBatch(st: TState, proc: TProc, batch: TBatch): Promise<void>;
  protected abstract spawnIdleProcess(st: TState, resume: boolean): Promise<TProc>;
  protected abstract resumeFor(st: TState): boolean;
  protected abstract identifyStaleProcess(pid: number, row: AgentSessionRow): Promise<number | null>;
  protected filterStaleRow?(row: AgentSessionRow): boolean;
  protected abstract onParsedLine(
    st: TState,
    proc: TProc,
    obj: Record<string, unknown>,
    rawLine: string,
    at: number,
  ): void;
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
      // A pending user stop wins over shutdown, so the message is marked stopped instead of kept for replay.
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
    if (this.sessions.get(row.id)?.proc?.child.pid === pid) return;
    const pgid = await this.identifyStaleProcess(pid, row);
    if (pgid !== null) {
      const target = signalTarget(pid);
      if (target !== null) signalPid(target, "SIGINT");
      if (await waitForExit(pid, this.opts.interruptGraceMs)) {
        if (pgid === pid) termGroupAfterExit({ pid });
      } else {
        // Kill by group only when the child leads its own group (we spawned it detached); otherwise unrelated group members would die.
        await forceKillTree(pid, pgid === pid);
        await waitForExit(pid, KILL_WAIT_MS);
      }
    }
    this.update(this.state(row.id), { pid: null, status: row.status === "ended" ? "ended" : "idle" });
  }

  protected state(id: SessionId): TState {
    let st = this.sessions.get(id);
    if (!st) {
      st = this.createSessionState(id);
      this.sessions.set(id, st);
    }
    return st;
  }

  protected isPending(st: TState, ids: MessageId[]): boolean {
    const covers = (batchIds: MessageId[]) => ids.every((id) => batchIds.includes(id));
    if (st.inFlight.some((b) => covers(b.messageIds))) return true;
    return st.pending.some((e) => covers(e.messageIds));
  }

  protected takePendingEntryBatch(st: TState): PendingBatchParts | null {
    const res = takePendingBatch(st.pending, (text) => this.composer.isCommand(text));
    if (!res) return null;
    st.pending = res.remaining;
    return res.taken;
  }

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

  /** On stop, queued user messages are cancelled but system messages stay queued. */
  protected dropPendingUsers(st: TState): void {
    const { kept, dropped } = dropUserEntries(st.pending);
    st.pending = kept;
    if (dropped.length > 0) {
      this.emit(st.id, { type: "message.cancelled", messageIds: dropped, reason: "stop", at: Date.now() });
    }
  }

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

  protected forgetWritten(st: TState, batches: Iterable<TBatch | null | undefined>): void {
    for (const batch of batches) {
      if (!batch) continue;
      for (const id of batch.messageIds) st.written.delete(id);
      batch.notes.persona?.restore();
      batch.notes.preamble?.restore();
    }
  }

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

  /** Untaken batches after a user stop are cancelled; otherwise (crash, shutdown, normal end) user messages are re-queued. */
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

  protected onBackgroundTasksChanged(st: TState, proc: TProc, rawTasks: unknown): void {
    if (st.proc !== proc) return;
    const wasActive = st.background.active;
    if (!st.background.replace(rawTasks)) return;
    this.emit(st.id, { type: "background.changed", count: st.background.count, at: Date.now() });
    if (st.background.active === wasActive || st.idleTimer === null) return;
    if (!proc.closing && !this.busy(st) && !st.ended) this.armIdle(st, proc);
  }

  /** Interrupting while only background tasks remain closes the process and stops them too. */
  protected stopIdleBackgroundTasks(st: TState, proc: TProc): Promise<void> | null {
    if (this.busy(st) || !st.background.active) return null;
    this.logSession(st.id, `停止时只剩 ${st.background.count} 个后台任务，关掉进程把它们一起停掉`);
    st.killedNote = backgroundTasksKilledNote("stopped", st.background.descriptions());
    this.clearTimer(st, "idleTimer");
    this.closeStdin(st, proc, "interrupt");
    return proc.exited;
  }

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
    let spawned: { child: ChildProcessWithoutNullStreams; detached: boolean };
    try {
      const resolvedDriverEnv = typeof this.opts.env === "function" ? this.opts.env() : this.opts.env;
      spawned = spawnOwnedProcess(command, args, {
        cwd,
        env: buildChildEnv(process.env, { ...resolvedDriverEnv, ...extraEnv }),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      onCleanup?.();
      throw new DriverError("spawn_failed", `${binaryPath}: ${errorMessage(error)}`);
    }
    const { child, detached } = spawned;
    trackChild(child, `agent:${this.vendor}`, { detached });
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
    // Split on \n manually because node:readline also breaks on U+2028 and U+2029, which may appear inside JSON strings.
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
    // Use exit, not close; grandchildren may hold stdout open and close would wait forever.
    const drained = Promise.all([streamClosed(child.stdout), streamClosed(child.stderr)]);
    child.once("exit", (code, signal) => {
      onExitCleanup?.();
      // Whatever the exit reason, signal the original process group once more to reap orphaned children.
      termGroupAfterExit(child);
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

  protected markHealthy(sessionId: SessionId): void {
    const prev = this.#health.get(sessionId);
    this.#health.set(sessionId, { healthy: true, lastError: prev?.lastError ?? null });
  }

  getHealth(sessionId: SessionId): DriverHealthSnapshot {
    return this.#health.get(sessionId) ?? { healthy: true, lastError: null };
  }

  protected log(line: string): void {
    this.opts.log(line);
  }

  protected logSession(sessionId: SessionId, detail: string): void {
    this.opts.log(`[driver] session ${sessionId}: ${detail}`);
  }

  protected resolveInterrupt(st: TState): void {
    for (const w of st.interruptWaiters.splice(0)) w();
  }

  protected invalidInput(st: TState, problem: string, messageIds: MessageId[]): void {
    this.reportError(st.id, "invalid_input", `invalid_input: ${problem}`, messageIds);
  }

  protected forceKillProc(st: TState, proc: TProc): void {
    forceKill(proc.child).catch((error: unknown) =>
      this.internalError(st.id, `force kill failed: ${errorMessage(error)}`),
    );
  }

  protected internalError(sessionId: SessionId, detail: string): void {
    this.reportError(sessionId, "internal_error", `internal_error: ${detail}`);
  }

  protected store(st: TState): AgentSessionRow {
    let row: AgentSessionRow | null;
    try {
      row = this.opts.store.get(st.id);
    } catch (error) {
      throw new DriverError("internal_error", `reading agent session ${st.id} failed: ${errorMessage(error)}`);
    }
    if (!row) throw new DriverError("internal_error", `no agent session ${st.id}`);
    return withPmMemoryAddDir(row, this.opts.pmMemoryDir);
  }

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

  /** Throttle live usage pushes to USAGE_THROTTLE_MS but always deliver the latest value. */
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

  /** Listener errors must not break the driver, but they are logged as internal_error. */
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

  protected assertNotEnded(st: TState): void {
    if (st.ended || this.store(st).status === "ended") {
      throw new DriverError("session_ended", `session ${st.id} has been ended`);
    }
  }
}
