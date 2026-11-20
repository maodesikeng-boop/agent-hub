import type { MessageId } from "../../shared/domain.ts";
import type { FeishuChatId } from "../../shared/feishu.ts";
import { FEISHU_CONTROL_RETRY_MS } from "../../shared/limits.ts";
import { handleError } from "./api.ts";
import { ensureRouterChat, syncChats } from "./chat-sync.ts";
import { ensureScopesChecked } from "./connection.ts";
import { isReady, owner, type FeishuContext, type Lane, type LaneQueue, type LaneTask } from "./context.ts";
import { scheduleApprovalCardsSync } from "./mesh-approvals.ts";
import { catchUp } from "./replay.ts";
import { FeishuAuthError, isFeishuRejection } from "./transport.ts";

interface EnqueueOptions {
  key?: string;
  preview?: boolean;
  mark?: MessageId;
}

function busy(ctx: FeishuContext): boolean {
  const { control } = ctx;
  return (
    ctx.life.connectingCount > 0 ||
    ctx.inbound.count > 0 ||
    ctx.outbound.count > 0 ||
    control.active !== null ||
    ctx.catchUp.inflight !== null ||
    (ctx.link.wsUp && ctx.catchUp.targetEpoch > 0) ||
    (isReady(ctx) && control.retry === null && (control.syncRequested || control.connectionRequested || control.dirty.size > 0))
  );
}

export function settleIdle(ctx: FeishuContext) {
  for (const waiter of ctx.life.idleWaiters.splice(0)) {
    if (busy(ctx) || (waiter.uploads && ctx.uploads.inFlight > 0)) ctx.life.idleWaiters.push(waiter);
    else waiter.resolve();
  }
}

export function whenIdle(ctx: FeishuContext, uploads: boolean): Promise<void> {
  if (!busy(ctx) && !(uploads && ctx.uploads.inFlight > 0)) return Promise.resolve();
  return new Promise<void>((resolve) => ctx.life.idleWaiters.push({ resolve, uploads }));
}

export function requestControl(ctx: FeishuContext, kind: "sync" | "connection") {
  if (kind === "sync") ctx.control.syncRequested = true;
  else ctx.control.connectionRequested = true;
  pumpControl(ctx);
}

function markDirty(ctx: FeishuContext, chatId: FeishuChatId) {
  ctx.control.dirty.add(chatId);
  pumpControl(ctx);
}

function scheduleRetry(ctx: FeishuContext) {
  if (!isReady(ctx) || ctx.life.closed || ctx.control.retry !== null) return;
  ctx.control.retry = setTimeout(() => {
    ctx.control.retry = null;
    pumpControl(ctx);
  }, FEISHU_CONTROL_RETRY_MS);
  ctx.control.retry.unref?.();
}

export function retrySyncLater(ctx: FeishuContext) {
  ctx.control.syncRequested = true;
  scheduleRetry(ctx);
}

async function runControl(ctx: FeishuContext, connection: boolean, sync: boolean, replaying: ReadonlySet<FeishuChatId>) {
  if (connection) await ensureScopesChecked(ctx);
  if (owner(ctx) === null) return;
  let syncSettled = true;
  if (sync) {
    try {
      await ensureRouterChat(ctx);
      scheduleApprovalCardsSync(ctx);
      syncSettled = await syncChats(ctx);
    } catch (error) {
      if (error instanceof FeishuAuthError) throw error;
      handleError(ctx, error);
      syncSettled = false;
    }
  }
  if (connection || replaying.size > 0) {
    const failed = await catchUp(ctx, connection, replaying);
    for (const chatId of failed) ctx.control.dirty.add(chatId);
    if (failed.size > 0) scheduleRetry(ctx);
  }
  if (!syncSettled) retrySyncLater(ctx);
}

export function pumpControl(ctx: FeishuContext) {
  const { control } = ctx;
  if (ctx.life.closed || !isReady(ctx) || control.active !== null || control.retry !== null || ctx.outbound.count > 0) return;
  const connection = control.connectionRequested;
  const sync = control.syncRequested || connection;
  const replaying = new Set(control.dirty);
  if (!sync && replaying.size === 0) return;
  control.connectionRequested = control.syncRequested = false;
  control.dirty.clear();
  control.active = { connection, replaying };
  void Promise.resolve()
    .then(() => runControl(ctx, connection, sync, replaying))
    .catch((error: unknown) => {
      handleError(ctx, error);
      control.connectionRequested ||= connection;
      control.syncRequested ||= sync;
      for (const chatId of replaying) control.dirty.add(chatId);
      scheduleRetry(ctx);
    })
    .finally(() => {
      control.active = null;
      for (const [name, lane] of ctx.outbound.lanes) startLane(ctx, ctx.outbound, name, lane);
      pumpControl(ctx);
      settleIdle(ctx);
    });
}

async function drain(ctx: FeishuContext, queue: LaneQueue, name: FeishuChatId, lane: Lane) {
  while (!queue.paused(name)) {
    const task = lane.tasks.shift();
    if (task === undefined) break;
    try {
      if (!ctx.life.closed && isReady(ctx)) await task.run();
    } catch (error) {
      handleError(ctx, error);
      if (queue === ctx.outbound && isFeishuRejection(error)) {
        if (task.mark !== null && ctx.store.chatById(name) !== null) ctx.store.advanceWatermark(name, { messageId: task.mark }, ctx.now());
      } else if (queue === ctx.outbound) {
        queue.count -= lane.tasks.length;
        lane.tasks.length = 0;
        ctx.control.dirty.add(name);
        scheduleRetry(ctx);
      }
    } finally {
      queue.count--;
    }
  }
  lane.running = false;
  if (lane.tasks.length === 0 && queue.lanes.get(name) === lane) queue.lanes.delete(name);
  else startLane(ctx, queue, name, lane);
  pumpControl(ctx);
  settleIdle(ctx);
}

export function startLane(ctx: FeishuContext, queue: LaneQueue, name: FeishuChatId, lane: Lane) {
  if (lane.running || lane.tasks.length === 0 || queue.paused(name)) return;
  lane.running = true;
  queueMicrotask(() => {
    void drain(ctx, queue, name, lane);
  });
}

export function laneOf(queue: LaneQueue, name: FeishuChatId): Lane {
  let lane = queue.lanes.get(name);
  if (lane === undefined) {
    lane = { tasks: [], running: false };
    queue.lanes.set(name, lane);
  }
  return lane;
}

export function admit(ctx: FeishuContext, queue: LaneQueue, name: FeishuChatId, task: LaneTask, limit = queue.limit): boolean {
  if (ctx.life.closed || !isReady(ctx)) return false;
  const last = queue.lanes.get(name)?.tasks.at(-1);
  if (task.key !== null && last?.key === task.key) {
    last.run = task.run;
    return true;
  }
  if (queue.count >= limit) return false;
  const lane = laneOf(queue, name);
  lane.tasks.push(task);
  queue.count++;
  startLane(ctx, queue, name, lane);
  return true;
}

export const inboundTask = (run: () => Promise<void>): LaneTask => ({ key: null, run, mark: null });

export function admitInbound(ctx: FeishuContext, chatId: FeishuChatId, run: () => Promise<void>, limit?: number): boolean {
  return admit(ctx, ctx.inbound, chatId, inboundTask(run), limit);
}

function awaitingReplay(ctx: FeishuContext, chatId: FeishuChatId) {
  const { control } = ctx;
  return control.connectionRequested || control.active?.connection === true || control.dirty.has(chatId) || control.active?.replaying.has(chatId) === true;
}

export function enqueue(ctx: FeishuContext, chatId: FeishuChatId, run: () => Promise<void>, opts: EnqueueOptions = {}) {
  const preview = opts.preview === true;
  if (awaitingReplay(ctx, chatId)) {
    if (!preview) markDirty(ctx, chatId);
    return;
  }
  if (admit(ctx, ctx.outbound, chatId, { key: opts.key ?? null, run, mark: opts.mark ?? null }) || preview) return;
  if (isReady(ctx) && !ctx.life.closed) ctx.link.lastError = "飞书出站队列已满，正在从账本补发";
  markDirty(ctx, chatId);
}
