import {
  COMPLETED_WORK_PAGE_SIZE,
  askOf,
  type CompletedWorkItem,
  type CompletedWorkPage,
  type ConversationId,
  type Message,
  type MessageId,
  type TaskGraph,
  type TaskGraphId,
  type TaskNode,
} from "../shared/index.ts";
import { COMPLETED_WORK_MAX_PAGES } from "./limits.ts";
import { boundWorkerIdsOf, isWorkerBound, sortActiveGraphs, workersByWorkerId, type WorkerEntry } from "./selectors.ts";

// Invariant: selectors here return the same object for the same input objects so memoized tab bodies skip rerenders.

export type WorkPanelTab = "active" | "completed" | "info";

export interface ActiveWork {
  /** Active graphs, those waiting on the user first, then by most recent update. */
  graphs: readonly TaskGraph[];
  /** Live Workers that no active graph step owns, running before idle. */
  workers: readonly WorkerEntry[];
  /** The `Active N` count: graphs plus standalone Workers. */
  count: number;
}

export interface CompletedDay {
  /** `Today`, `Yesterday`, or a short date such as `Nov 22`, in the viewer's time zone. */
  label: string;
  /** Local midnight of the day, used as the React key. */
  dayStart: number;
  items: readonly CompletedWorkItem[];
}

/** Where a click on an Active step goes. */
export type StepTarget =
  | { kind: "worker"; conversationId: ConversationId }
  | { kind: "ask"; messageId: MessageId }
  | { kind: "none" };

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const MAX_COMPLETED_ITEMS = COMPLETED_WORK_MAX_PAGES * COMPLETED_WORK_PAGE_SIZE;
const IDLE_ACTIVITIES: ReadonlySet<string> = new Set(["idle", "stopping"]);

const activeWorkCache = new WeakMap<readonly TaskGraph[], WeakMap<readonly WorkerEntry[], ActiveWork>>();
const completedDaysCache = new WeakMap<readonly CompletedWorkPage[], { nowDayStart: number; days: readonly CompletedDay[] }>();

function isRunningWorker(worker: WorkerEntry): boolean {
  return !worker.ended && !IDLE_ACTIVITIES.has(worker.activity);
}

export function activeWorkOf(graphs: readonly TaskGraph[], workers: readonly WorkerEntry[]): ActiveWork {
  let byWorkers = activeWorkCache.get(graphs);
  if (byWorkers === undefined) {
    byWorkers = new WeakMap();
    activeWorkCache.set(graphs, byWorkers);
  }
  const hit = byWorkers.get(workers);
  if (hit !== undefined) return hit;

  const sortedGraphs = sortActiveGraphs(graphs);
  const boundIds = sortedGraphs.length > 0 ? boundWorkerIdsOf(sortedGraphs) : null;
  const liveStandalone = workers
    .filter((w) => !w.ended && (boundIds === null || !isWorkerBound(w, boundIds)))
    .toSorted((a, b) => Number(isRunningWorker(b)) - Number(isRunningWorker(a)));

  const result: ActiveWork = {
    graphs: sortedGraphs,
    workers: liveStandalone,
    count: sortedGraphs.length + liveStandalone.length,
  };
  byWorkers.set(workers, result);
  return result;
}

function localMidnight(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function dayLabelOf(dayStart: number, todayStart: number, yesterdayStart: number): string {
  if (dayStart === todayStart) return "Today";
  if (dayStart === yesterdayStart) return "Yesterday";
  const d = new Date(dayStart);
  return `${SHORT_MONTHS[d.getMonth()]!} ${d.getDate()}`;
}

export function completedKeyOf(item: CompletedWorkItem): string {
  return item.kind === "graph" ? `graph:${item.graphId}` : `worker:${item.conversationId}`;
}

export function completedDaysOf(pages: readonly CompletedWorkPage[], now: number): readonly CompletedDay[] {
  const nowDate = new Date(now);
  const todayStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
  const hit = completedDaysCache.get(pages);
  if (hit !== undefined && hit.nowDayStart === todayStart) return hit.days;

  const yesterdayStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - 1).getTime();
  const seen = new Set<string>();
  const groups = new Map<number, CompletedWorkItem[]>();
  let totalKept = 0;

  for (const page of pages) {
    for (const item of page.items) {
      if (totalKept >= MAX_COMPLETED_ITEMS) break;
      const key = completedKeyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      totalKept += 1;
      const dayStart = localMidnight(item.finishedAt);
      const list = groups.get(dayStart);
      if (list !== undefined) list.push(item);
      else groups.set(dayStart, [item]);
    }
    if (totalKept >= MAX_COMPLETED_ITEMS) break;
  }

  const days: CompletedDay[] = [...groups.entries()]
    .toSorted(([a], [b]) => b - a)
    .map(([dayStart, items]) => ({
      label: dayLabelOf(dayStart, todayStart, yesterdayStart),
      dayStart,
      items,
    }));

  completedDaysCache.set(pages, { nowDayStart: todayStart, days });
  return days;
}

const TRAILING_PR_NUMBER = /\/(\d+)\/?$/;

export function prLabelOf(prUrl: string | null): string | null {
  if (prUrl === null) return null;
  let url: URL;
  try {
    url = new URL(prUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const match = TRAILING_PR_NUMBER.exec(url.pathname);
  return match === null ? null : `#${match[1]!}`;
}

export function stepTargetOf(
  node: Pick<TaskNode, "activeWorkerId" | "workerIds" | "gateAskMessageId" | "status" | "waitingFor"> & {
    userBlocker?: TaskNode["userBlocker"];
    key?: TaskNode["key"];
  },
  workers: readonly WorkerEntry[],
  asks?: readonly Message[],
  graphId?: TaskGraphId,
): StepTarget {
  const byId = workersByWorkerId(workers);
  if (node.activeWorkerId !== null) {
    const active = byId.get(node.activeWorkerId);
    if (active !== undefined) return { kind: "worker", conversationId: active.conversationId };
  }
  for (let i = node.workerIds.length - 1; i >= 0; i--) {
    const worker = byId.get(node.workerIds[i]!);
    if (worker !== undefined) return { kind: "worker", conversationId: worker.conversationId };
  }
  if (node.status === "waiting" && node.waitingFor === "user") {
    if (node.gateAskMessageId !== null) return { kind: "ask", messageId: node.gateAskMessageId };
    if (asks !== undefined) {
      const match = asks.find((m) => {
        const meta = askOf(m);
        if (node.userBlocker != null) return meta?.blockerRef?.blockerId === node.userBlocker.id;
        return graphId !== undefined && node.key !== undefined && meta?.gateRef?.graphId === graphId && meta.gateRef.nodeKey === node.key;
      });
      if (match !== undefined) return { kind: "ask", messageId: match.id };
    }
  }
  return { kind: "none" };
}
