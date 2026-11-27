import type { PmId, TaskGraphId } from "../../shared/domain.ts";
import type { HubArgs, HubResult } from "../../shared/hub.ts";
import { pmWatchListText, pmWatchReceiptText, pmWatchSettledText, type PmWatchCondition, type PmWatchId, type PmWatchOutcome, type PmWatchRecord } from "../../shared/pm-watch.ts";
import { fail, type LedgerContext, type Pending } from "./context.ts";
import type { LedgerPersona } from "./persona.ts";
import { enqueuePmNoticeIn } from "./pm-notices.ts";
import {
  addPmWatch, beginPmWatchRun, closePmWatch, deferPmWatchRun, getPmWatch, isWatchNoticeCurrent, listPmWatches, prunePmWatches,
  recoverPmWatches, settlePmWatch, watchingPmWatches, type PmWatchRunStart,
} from "./pm-watches.ts";
import type { LedgerSessions } from "./sessions.ts";

export type LedgerPmWatches = ReturnType<typeof createLedgerPmWatches>;

type WatchCommand = "watch.add" | "watch.list" | "watch.close";

/** The ledger side the watch runner calls; every method runs in its own write. */
export interface PmWatchRunnerLedger {
  now(): number;
  recover(nowMs?: number): number;
  watching(): PmWatchRecord[];
  beginRun(watchId: PmWatchId): PmWatchRunStart | null;
  deferRun(watchId: PmWatchId, run: number, nextRunAt: number, last: { exitCode: number | null; outputTail: string }): boolean;
  settle(watchId: PmWatchId, run: number, outcome: PmWatchOutcome): PmWatchRecord | null;
  prune(nowMs?: number): number;
}

function conditionOfArgs(args: HubArgs<"watch.add">): PmWatchCondition {
  const hasUntil = args.until !== undefined;
  if (hasUntil === (args.afterMs !== undefined)) throw fail("invalid", "条件写 --until <命令>（跑命令看退出码）或 --after <时长>（到点叫醒），二选一");
  if (args.afterMs !== undefined) {
    if (args.everyMs !== undefined) throw fail("invalid", "--every 只能配 --until");
    return { kind: "timer", afterMs: args.afterMs };
  }
  return args.everyMs === undefined ? { kind: "once", command: args.until! } : { kind: "poll", command: args.until!, everyMs: args.everyMs };
}

export function createLedgerPmWatches(
  ctx: LedgerContext, sessions: LedgerSessions, persona: LedgerPersona,
  publishGraph: (p: Pending, graphId: TaskGraphId) => void,
) {
  const { db, now, write } = ctx;

  const assertLinkOwned = (pmId: PmId, args: HubArgs<"watch.add">): void => {
    if (args.graphId !== undefined && args.workerId !== undefined) throw fail("invalid", "--graph 和 --worker 只能写一个");
    if (args.graphId !== undefined && db.get("SELECT 1 FROM task_graphs WHERE id = ? AND pm_id = ? AND status = 'active'", args.graphId, pmId) === undefined) {
      throw fail("not_found", `没有进行中的图 #${args.graphId}，或者它不是你的图`);
    }
    if (args.workerId !== undefined && db.get("SELECT 1 FROM workers WHERE id = ? AND pm_id = ? AND status = 'open'", args.workerId, pmId) === undefined) {
      throw fail("not_found", `没有在干活的 Worker #${args.workerId}，或者它不是你派的`);
    }
  };

  const addIn = (p: Pending, caller: { pmId: PmId }, args: HubArgs<"watch.add">): HubResult<"watch.add"> => {
    persona.assertPmNotArchived(caller.pmId);
    const condition = conditionOfArgs(args);
    if (condition.kind !== "timer" && !ctx.osSandboxed()) {
      throw fail("conflict", "这台电脑建不起只读沙箱，--until 的命令没法安全地跑；要定时叫醒自己就用 --after <时长>");
    }
    assertLinkOwned(caller.pmId, args);
    const conversationId = persona.privateConversation(caller.pmId)?.id;
    if (conversationId === undefined) throw new Error(`pm ${caller.pmId} has no conversation`);
    const watch = addPmWatch(db, { pmId: caller.pmId, conversationId }, {
      condition, body: args.body,
      ...(args.maxMs === undefined ? {} : { maxMs: args.maxMs }),
      ...(args.graphId === undefined ? {} : { graphId: args.graphId }),
      ...(args.workerId === undefined ? {} : { workerId: args.workerId }),
    }, now());
    if (watch.graphId !== null) publishGraph(p, watch.graphId);
    return { text: pmWatchReceiptText(watch, now()), data: { watch } };
  };

  const list = (caller: { pmId: PmId }): HubResult<"watch.list"> => {
    const watches = listPmWatches(db, caller.pmId);
    return { text: pmWatchListText(watches, now()), data: { watches } };
  };

  const closeIn = (p: Pending, caller: { pmId: PmId }, args: HubArgs<"watch.close">): HubResult<"watch.close"> => {
    const existing = getPmWatch(db, args.watchId);
    if (existing === null || existing.pmId !== caller.pmId) throw fail("not_found", `没有编号 #${args.watchId} 的在盯条件`);
    const closed = closePmWatch(db, caller.pmId, args.watchId, now());
    const watch = getPmWatch(db, args.watchId)!;
    if (closed && watch.graphId !== null) publishGraph(p, watch.graphId);
    return { text: closed ? `已关掉 #${watch.id}，不会再为它叫醒你。` : `#${watch.id} 之前已经关掉了。`, data: { watch } };
  };

  const settle = (watchId: PmWatchId, run: number, outcome: PmWatchOutcome): PmWatchRecord | null =>
    write((p) => {
      const watch = settlePmWatch(db, watchId, run, outcome, now());
      if (watch === null) return null;
      if (watch.graphId !== null) publishGraph(p, watch.graphId);
      const subject = { kind: "watch.settled" as const, watchId, run };
      const session = sessions.currentSession(watch.conversationId);
      const archived = db.get("SELECT 1 FROM pm_archives WHERE pm_id = ?", watch.pmId) !== undefined;
      if (session !== null && !archived && isWatchNoticeCurrent(db, subject, watch.conversationId)) {
        enqueuePmNoticeIn(ctx, p, session, { conversationId: watch.conversationId, subject, text: pmWatchSettledText(watch) });
      }
      return watch;
    });

  const runner: PmWatchRunnerLedger = {
    now,
    recover: (nowMs = now()) => write(() => recoverPmWatches(db, nowMs)),
    watching: () => watchingPmWatches(db),
    beginRun: (watchId) => write(() => beginPmWatchRun(db, watchId)),
    deferRun: (watchId, run, nextRunAt, last) => write(() => deferPmWatchRun(db, watchId, run, nextRunAt, last)),
    settle,
    prune: (nowMs = now()) => write(() => prunePmWatches(db, nowMs)),
  };

  const hubIn = (p: Pending, caller: { pmId: PmId }, command: WatchCommand, args: unknown): HubResult<WatchCommand> => {
    switch (command) {
      case "watch.add": return addIn(p, caller, args as HubArgs<"watch.add">);
      case "watch.list": return list(caller);
      case "watch.close": return closeIn(p, caller, args as HubArgs<"watch.close">);
    }
  };

  return { hubIn, runner };
}
