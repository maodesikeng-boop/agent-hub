import type { LedgerContext } from "./context.ts";
import type { LedgerMessages } from "./messages.ts";
import type { LedgerPersona } from "./persona.ts";
import type { LedgerProjects } from "./projects.ts";
import type { LedgerRouter } from "./router.ts";
import type { LedgerSessions } from "./sessions.ts";
import { pushSlimGraphIn } from "./task-graphs/store.ts";
import { createIn } from "./task-graphs/create.ts";
import { enrichDeliveryNoteMessage, graphDeliveryProbeTarget, graphPrTargets } from "./task-graphs/delivery.ts";
import { askOnStepIn, closeStepAskIn, decideIn, decideNode } from "./task-graphs/gate.ts";
import { cancelGraph, cancelIn, doneIn, finishIn, list, show, skipIn, skipNode } from "./task-graphs/lifecycle.ts";
import {
  activeSnapshotGraphs,
  graphAutoDispatchVendors,
  graphNeedsCapabilityInventory,
  purgeExpiredBatch,
} from "./task-graphs/overview.ts";
import { patchIn } from "./task-graphs/patch.ts";
import { drainSlotsIn, graphsQueuedOn, queueWorkerStartIn, slotQueueLinesOf } from "./task-graphs/slot-queue.ts";
import { freeSlotsWithWaiters } from "./task-graphs/slots.ts";
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
  isWorkerSlotHeldElsewhere,
  workerGraphStatus,
  workerGraphUpstreamCommit,
  workerGraphWorkspacePlan,
} from "./task-graphs/worker-hooks.ts";

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
    modelShortLabel: ctx.modelShortLabel,
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
  let draining = false;
  let publishedQueues = new Map<string, string>();
  const changedQueues = (): string[] => {
    const lines = slotQueueLinesOf(g);
    const changed = [...new Set([...lines.keys(), ...publishedQueues.keys()])].filter((slot) => lines.get(slot) !== publishedQueues.get(slot));
    publishedQueues = lines;
    return changed;
  };
  // Commits made while draining re-enter here and return at once; the loop below rechecks after each of its writes instead.
  const drainSlotsAfterCommit = (): void => {
    if (draining) return;
    draining = true;
    try {
      let drained: string | null = null;
      for (;;) {
        const free = freeSlotsWithWaiters(g.db).join("\n");
        // A drain that left the same slots free made no progress, so repeating it would loop.
        if (free === "" || free === drained) break;
        drained = free;
        ctx.write((p) => drainSlotsIn(g, p));
      }
      const graphIds = graphsQueuedOn(g, changedQueues());
      if (graphIds.length > 0) ctx.write((p) => { for (const graphId of graphIds) pushSlimGraphIn(g, p, graphId); });
    } finally {
      draining = false;
    }
  };
  const bindDb =
    <A extends unknown[], R>(fn: (db: TaskGraphCtx["db"], ...args: A) => R) =>
    (...args: A): R =>
      fn(g.db, ...args);
  return {
    publishBranchChange: bind(pushSlimGraphIn),
    createIn: bind(createIn),
    show: bind(show),
    list: bind(list),
    askOnStepIn: bind(askOnStepIn),
    closeStepAskIn: bind(closeStepAskIn),
    patchIn: bind(patchIn),
    doneIn: bind(doneIn),
    decideIn: bind(decideIn),
    skipIn: bind(skipIn),
    cancelIn: bind(cancelIn),
    finishIn: bind(finishIn),
    graphPrTargets: bindDb(graphPrTargets),
    graphNeedsCapabilityInventory: bind(graphNeedsCapabilityInventory),
    graphAutoDispatchVendors: bind(graphAutoDispatchVendors),
    graphDeliveryProbeTarget: bindDb(graphDeliveryProbeTarget),
    enrichDeliveryNoteMessage: bind(enrichDeliveryNoteMessage),
    decideNode: bind(decideNode),
    skipNode: bind(skipNode),
    cancelGraph: bind(cancelGraph),
    prepareWorkerBind: bind(prepareWorkerBind),
    queueWorkerStartIn: bind(queueWorkerStartIn),
    drainSlotsAfterCommit,
    bindWorkerStartedIn: bind(bindWorkerStartedIn),
    onWorkerTurnReportIn: bind(onWorkerTurnReportIn),
    onWorkerFailedIn: bind(onWorkerFailedIn),
    onWorkerUserBlockedIn: bind(onWorkerUserBlockedIn),
    releaseUserBlockedStepsIn: bind(releaseUserBlockedStepsIn),
    isWorkerSlotHeldElsewhere: bind(isWorkerSlotHeldElsewhere),
    notifyUserBlockedStepsIn: bind(notifyUserBlockedStepsIn),
    onWorkerResumedIn: bind(onWorkerResumedIn),
    onWorkerEndedIn: bind(onWorkerEndedIn),
    workerGraphWorkspacePlan: bind(workerGraphWorkspacePlan),
    workerGraphUpstreamCommit: bind(workerGraphUpstreamCommit),
    workerGraphStatus: bind(workerGraphStatus),
    activeSnapshotGraphs: bind(activeSnapshotGraphs),
    purgeExpiredBatch: bind(purgeExpiredBatch),
  };
}
