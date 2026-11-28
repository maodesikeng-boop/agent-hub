import type { UntakenReleaseCause } from "../../daemon/driver/stop-untaken.ts";
import {
  BaseSessionDriver,
  type BaseBatch,
  type BaseProc,
  type BaseSessionState,
} from "../../daemon/driver/base-driver.ts";
import type {
  AgentSessionPatch,
  AgentSessionRow,
  AgentVendor,
  DriverErrorCode,
  DriverEvent,
  MessageId,
  SessionId,
  TokenUsage,
} from "../../shared/index.ts";
import type { VendorComposerBase } from "../../daemon/vendors/types.ts";

type DriverTimerKey = "startTimer" | "idleTimer" | "interruptTimer";

export interface SessionDriverHost<
  TProc extends BaseProc<any>,
  TBatch extends BaseBatch,
  TState extends BaseSessionState<TProc, TBatch>,
> {
  readonly vendor: AgentVendor;
  readonly composer: VendorComposerBase;
  isShuttingDown(): boolean;
  nextRequestSeq(): number;
  log(line: string): void;
  logSession(sessionId: SessionId, detail: string): void;
  emit(sessionId: SessionId, event: DriverEvent): void;
  reportError(sessionId: SessionId, code: DriverErrorCode, message: string, messageIds?: MessageId[]): void;
  update(st: TState, patch: AgentSessionPatch): void;
  row(st: TState): AgentSessionRow | null;
  store(st: TState): AgentSessionRow;
  pushUsage(st: TState, usage: TokenUsage): void;
  cancelUsagePush(st: TState): void;
  busy(st: TState): boolean;
  markProcessing(st: TState, batch: TBatch, at: number): void;
  markDelivered(st: TState, batch: TBatch): void;
  dropBatch(st: TState, batch: TBatch): void;
  forgetWritten(st: TState, batches: Iterable<TBatch | null | undefined>): void;
  releaseUntaken(st: TState, batches: TBatch[], cause: UntakenReleaseCause, at: number): void;
  onBackgroundTasksChanged(st: TState, proc: TProc, rawTasks: unknown): void;
  markHealthy(sessionId: SessionId): void;
  setPersonaSeen(st: TState, revision: number | null): void;
  clearTimer(st: TState, key: DriverTimerKey): void;
  sigintForInterrupt(st: TState, proc: TProc): void;
  forceKillProc(st: TState, proc: TProc): void;
  resolveInterrupt(st: TState): void;
  afterTurn(st: TState, proc: TProc): void;
  settled(st: TState): void;
}

export abstract class VendorSessionDriver<
  TProc extends BaseProc<any>,
  TBatch extends BaseBatch,
  TState extends BaseSessionState<TProc, TBatch>,
> extends BaseSessionDriver<TProc, TBatch, TState> {
  protected createHost(): SessionDriverHost<TProc, TBatch, TState> {
    return {
      vendor: this.vendor,
      composer: this.composer,
      isShuttingDown: () => this.shuttingDown,
      nextRequestSeq: () => ++this.requestSeq,
      log: (line) => this.log(line),
      logSession: (sessionId, detail) => this.logSession(sessionId, detail),
      emit: (sessionId, event) => this.emit(sessionId, event),
      reportError: (sessionId, code, message, messageIds) => this.reportError(sessionId, code, message, messageIds),
      update: (st, patch) => this.update(st, patch),
      row: (st) => this.row(st),
      store: (st) => this.store(st),
      pushUsage: (st, usage) => this.pushUsage(st, usage),
      cancelUsagePush: (st) => this.cancelUsagePush(st),
      busy: (st) => this.busy(st),
      markProcessing: (st, batch, at) => this.markProcessing(st, batch, at),
      markDelivered: (st, batch) => this.markDelivered(st, batch),
      dropBatch: (st, batch) => this.dropBatch(st, batch),
      forgetWritten: (st, batches) => this.forgetWritten(st, batches),
      releaseUntaken: (st, batches, cause, at) => this.releaseUntaken(st, batches, cause, at),
      onBackgroundTasksChanged: (st, proc, rawTasks) => this.onBackgroundTasksChanged(st, proc, rawTasks),
      markHealthy: (sessionId) => this.markHealthy(sessionId),
      setPersonaSeen: (st, revision) => this.setPersonaSeen(st, revision),
      clearTimer: (st, key) => this.clearTimer(st, key),
      sigintForInterrupt: (st, proc) => this.sigintForInterrupt(st, proc),
      forceKillProc: (st, proc) => this.forceKillProc(st, proc),
      resolveInterrupt: (st) => this.resolveInterrupt(st),
      afterTurn: (st, proc) => this.afterTurn(st, proc),
      settled: (st) => this.settled(st),
    };
  }
}
