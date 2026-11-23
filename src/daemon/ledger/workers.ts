import type { LedgerContext } from "./context.ts";
import type { LedgerMessages } from "./messages.ts";
import type { LedgerPersona } from "./persona.ts";
import type { LedgerProjects } from "./projects.ts";
import type { LedgerSessions } from "./sessions.ts";
import { isWorkerCleanable, isWorktreeCleaned, listEndedWorktreeWorkers } from "./workers/cleanup.ts";
import { createWorkersCtx, ownWorker, workerSession } from "./workers/ctx.ts";
import { dispatchStepWorkerIn } from "./workers/dispatch.ts";
import { afterDriverEvent, settleTurn, turnFactsOf } from "./workers/driver-events.ts";
import {
  deliverToWorkerIn,
  endIn,
  endOpenWorkersIn,
  maxTimeIn,
  resumeUserBlockedWorkerIn,
  sendIn,
  stopWorkersIn,
} from "./workers/lifecycle.ts";
import { launchContextFor, list, status, workerPrTarget, workerStartFolder, workerTranscriptTarget } from "./workers/queries.ts";
import { recoverBackgroundWaits } from "./workers/reports.ts";
import { startIn } from "./workers/start.ts";
import { clearAllMaxTime, clearMaxTime, recoverTurnTimeouts, turnMaxTimeOf } from "./workers/timers.ts";
import type { LedgerWorkersOptions, WorkersCtx } from "./workers/types.ts";
import {
  actionFailedIn,
  getReviewVerifyTask,
  getWorktreeTask,
  onReviewVerified,
  onSetupStarted,
  onWorktreeCreated,
  recordReviewSnapshot,
  recoverWorktrees,
  waitsForFirstTurn,
} from "./workers/worktree.ts";

export { assertWorkerOpenForUser, notStarted } from "./workers/text.ts";
export type { EndedWorktreeCandidate, ReportMessage } from "./workers/types.ts";

export type LedgerWorkers = ReturnType<typeof createLedgerWorkers>;

export function createLedgerWorkers(
  ctx: LedgerContext,
  sessions: LedgerSessions,
  messages: LedgerMessages,
  persona: LedgerPersona,
  projects: LedgerProjects,
  options: LedgerWorkersOptions,
) {
  const w = createWorkersCtx(ctx, sessions, messages, persona, projects, options);
  const bind =
    <A extends unknown[], R>(fn: (w: WorkersCtx, ...args: A) => R) =>
    (...args: A): R =>
      fn(w, ...args);
  return {
    startIn: bind(startIn),
    dispatchStepWorkerIn: bind(dispatchStepWorkerIn),
    sendIn: bind(sendIn),
    maxTimeIn: bind(maxTimeIn),
    endIn: bind(endIn),
    stopWorkersIn: bind(stopWorkersIn),
    deliverToWorkerIn: bind(deliverToWorkerIn),
    resumeUserBlockedWorkerIn: bind(resumeUserBlockedWorkerIn),
    endOpenWorkersIn: bind(endOpenWorkersIn),
    list: bind(list),
    status: bind(status),
    afterDriverEvent: bind(afterDriverEvent),
    settleTurn: bind(settleTurn),
    turnFactsOf: bind(turnFactsOf),
    getWorktreeTask: bind(getWorktreeTask),
    onSetupStarted: bind(onSetupStarted),
    waitsForFirstTurn: bind(waitsForFirstTurn),
    onWorktreeCreated: bind(onWorktreeCreated),
    recordReviewSnapshot: bind(recordReviewSnapshot),
    getReviewVerifyTask: bind(getReviewVerifyTask),
    onReviewVerified: bind(onReviewVerified),
    recoverWorktrees: bind(recoverWorktrees),
    recoverBackgroundWaits: bind(recoverBackgroundWaits),
    actionFailedIn: bind(actionFailedIn),
    workerStartFolder: bind(workerStartFolder),
    workerPrTarget: bind(workerPrTarget),
    workerTranscriptTarget: bind(workerTranscriptTarget),
    ownWorker: bind(ownWorker),
    workerSession: bind(workerSession),
    launchContextFor: bind(launchContextFor),
    clearMaxTime: bind(clearMaxTime),
    clearAllMaxTime: bind(clearAllMaxTime),
    turnMaxTimeOf: bind(turnMaxTimeOf),
    recoverTurnTimeouts: bind(recoverTurnTimeouts),
    maxTimeTimers: w.maxTimeTimers,
    isWorktreeCleaned: bind(isWorktreeCleaned),
    listEndedWorktreeWorkers: bind(listEndedWorktreeWorkers),
    isWorkerCleanable: bind(isWorkerCleanable),
  };
}
