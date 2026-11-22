import type { LedgerContext } from "./context.ts";
import type { LedgerMessages } from "./messages.ts";
import type { LedgerPersona } from "./persona.ts";
import type { LedgerProjects } from "./projects.ts";
import type { LedgerRouter } from "./router.ts";
import type { LedgerSessions } from "./sessions.ts";
import { createIn } from "./task-graphs/create.ts";
import { enrichDeliveryNoteMessage, graphDeliveryProbeTarget, graphPrTargets } from "./task-graphs/delivery.ts";
import { askOnStepIn, decideIn, decideNode } from "./task-graphs/gate.ts";
import { cancelGraph, cancelIn, doneIn, finishIn, list, listProjectHistory, show, skipIn, skipNode } from "./task-graphs/lifecycle.ts";
import {
  activeSnapshotGraphs,
  graphAutoDispatchVendors,
  liveHandoverSection,
  pmStatusGraphs,
  purgeExpiredBatch,
} from "./task-graphs/overview.ts";
import { patchIn } from "./task-graphs/patch.ts";
import { recordReviewStampIn } from "./task-graphs/review-stamp.ts";
import { onWorkerTurnReportIn } from "./task-graphs/turn-report.ts";
import type { TaskGraphCtx, TaskGraphOptions } from "./task-graphs/types.ts";
import {
  bindWorkerStartedIn,
  notifyUserBlockedStepsIn,
  onWorkerEndedIn,
  onWorkerFailedIn,
  onWorkerResumedIn,
  onWorkerUserBlockedIn,
  prepareWorkerBind,
  releaseUserBlockedStepsIn,
  workerGraphForkBase,
  workerGraphStatus,
} from "./task-graphs/worker-hooks.ts";

export { validateDagAndOrder } from "./task-graphs/spec.ts";
export type { StepWorkspacePlan, TaskGraphWorkersBridge, WorkerBindTarget } from "./task-graphs/types.ts";

export type LedgerTaskGraphs = ReturnType<typeof createLedgerTaskGraphs>;

export function createLedgerTaskGraphs(
  ctx: LedgerContext,
  sessions: LedgerSessions,
  messages: LedgerMessages,
  persona: LedgerPersona,
  projects: LedgerProjects,
  router: Pick<LedgerRouter, "reportIn">,
  options: TaskGraphOptions = { launchDir: "" },
) {
  const g: TaskGraphCtx = {
    db: ctx.db,
    now: ctx.now,
    write: ctx.write,
    enqueue: ctx.enqueue,
    modelCatalog: ctx.modelCatalog,
    sessions,
    messages,
    persona,
    projects,
    router,
    options,
  };
  const bind =
    <A extends unknown[], R>(fn: (g: TaskGraphCtx, ...args: A) => R) =>
    (...args: A): R =>
      fn(g, ...args);
  const bindDb =
    <A extends unknown[], R>(fn: (db: TaskGraphCtx["db"], ...args: A) => R) =>
    (...args: A): R =>
      fn(g.db, ...args);
  return {
    createIn: bind(createIn),
    show: bind(show),
    list: bind(list),
    askOnStepIn: bind(askOnStepIn),
    patchIn: bind(patchIn),
    doneIn: bind(doneIn),
    decideIn: bind(decideIn),
    skipIn: bind(skipIn),
    cancelIn: bind(cancelIn),
    finishIn: bind(finishIn),
    graphPrTargets: bindDb(graphPrTargets),
    graphAutoDispatchVendors: bind(graphAutoDispatchVendors),
    graphDeliveryProbeTarget: bindDb(graphDeliveryProbeTarget),
    enrichDeliveryNoteMessage: bind(enrichDeliveryNoteMessage),
    decideNode: bind(decideNode),
    skipNode: bind(skipNode),
    cancelGraph: bind(cancelGraph),
    listProjectHistory: bind(listProjectHistory),
    prepareWorkerBind: bind(prepareWorkerBind),
    bindWorkerStartedIn: bind(bindWorkerStartedIn),
    onWorkerTurnReportIn: bind(onWorkerTurnReportIn),
    onWorkerFailedIn: bind(onWorkerFailedIn),
    onWorkerUserBlockedIn: bind(onWorkerUserBlockedIn),
    releaseUserBlockedStepsIn: bind(releaseUserBlockedStepsIn),
    notifyUserBlockedStepsIn: bind(notifyUserBlockedStepsIn),
    onWorkerResumedIn: bind(onWorkerResumedIn),
    onWorkerEndedIn: bind(onWorkerEndedIn),
    workerGraphForkBase: bind(workerGraphForkBase),
    workerGraphStatus: bind(workerGraphStatus),
    recordReviewStampIn: bind(recordReviewStampIn),
    activeSnapshotGraphs: bind(activeSnapshotGraphs),
    pmStatusGraphs: bind(pmStatusGraphs),
    liveHandoverSection: bind(liveHandoverSection),
    purgeExpiredBatch: bind(purgeExpiredBatch),
  };
}
