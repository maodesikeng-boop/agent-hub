import pLimit from "p-limit";
import type { FeishuChatId, FeishuChatTarget, FeishuMessageId, FeishuOpenId } from "../../shared/feishu.ts";
import {
  FEISHU_INBOUND_CATCHUP_CONCURRENCY,
  FEISHU_INBOUND_CATCHUP_MAX_MESSAGES,
  FEISHU_INBOUND_CATCHUP_MAX_PAGES,
  FEISHU_INBOUND_CATCHUP_OVERLAP_MS,
  FEISHU_INBOUND_CATCHUP_WINDOW_MS,
  FEISHU_INBOUND_GAP_PROBE_MAX_PAGES,
  FEISHU_MESSAGE_LIST_PAGE_SIZE,
} from "../../shared/limits.ts";
import { handleError, sendText } from "./api.ts";
import { ensureScopesChecked } from "./connection.ts";
import { errorText, owner, type FeishuContext } from "./context.ts";
import { feishuLocalStamp, handleInbound } from "./inbound-dispatch.ts";
import { parseFeishuEvent, type FeishuInbound } from "./inbound.ts";
import { inboundTask, laneOf, settleIdle, startLane } from "./lanes.ts";
import { activeTarget } from "./projection.ts";
import { FEISHU_GROUP_MSG_SCOPE } from "./scopes.ts";
import type { FeishuChatBinding } from "./store.ts";
import { FeishuApiError, FeishuAuthError, type FeishuRawMessageEvent, type FeishuTransport } from "./transport.ts";

type InboundMessage = Extract<FeishuInbound, { kind: "message" }>;

interface WindowGap {
  fromMs: number;
  toMs: number;
}

interface CatchUpWindow {
  chatId: FeishuChatId;
  chatType: "p2p" | "group";
  botOpenId: FeishuOpenId;
  sinceMs: number;
  startSec: number;
  endSec: number;
  gap: WindowGap | null;
}

interface MissedMessages {
  messages: InboundMessage[];
  unfetchedFrom: number | null;
}

const inboundTargetLabel = (chat: FeishuChatBinding) =>
  chat.target.kind === "router" ? "router" : `pm:${chat.target.pmId ?? "none"}`;

export function releaseInboundGate(ctx: FeishuContext, chatId: FeishuChatId, maxEpoch?: number) {
  const gateEpoch = ctx.catchUp.gateEpochs.get(chatId);
  if (gateEpoch === undefined) return;
  if (maxEpoch !== undefined && gateEpoch > maxEpoch) return;
  ctx.catchUp.gateEpochs.delete(chatId);
  const lane = ctx.inbound.lanes.get(chatId);
  if (lane !== undefined) startLane(ctx, ctx.inbound, chatId, lane);
}

export function releaseAllInboundGates(ctx: FeishuContext, maxEpoch?: number) {
  for (const chatId of [...ctx.catchUp.gateEpochs.keys()]) releaseInboundGate(ctx, chatId, maxEpoch);
}

const isCatchUpStale = (ctx: FeishuContext, runEpoch: number) =>
  ctx.life.closed || !ctx.link.wsUp || ctx.link.transport === null || ctx.catchUp.epoch !== runEpoch;

export function noteInboundQueueDrop(ctx: FeishuContext, chatId: FeishuChatId, at: number) {
  const prev = ctx.catchUp.cursorHold.get(chatId);
  ctx.catchUp.cursorHold.set(chatId, prev === undefined ? at : Math.min(prev, at));
}

function catchUpWindow(
  chat: FeishuChatBinding,
  target: FeishuChatTarget,
  botOpenId: FeishuOpenId,
  cursor: { chatCreatedAt: number; lastInboundAt: number },
  includeOverlap: boolean,
  catchUpNow: number,
): CatchUpWindow {
  const windowStartMs = catchUpNow - FEISHU_INBOUND_CATCHUP_WINDOW_MS;
  const anchorMs = includeOverlap ? cursor.lastInboundAt - FEISHU_INBOUND_CATCHUP_OVERLAP_MS : cursor.lastInboundAt;
  const sinceMs = Math.max(cursor.chatCreatedAt, windowStartMs, anchorMs);
  const gapFromMs = Math.max(cursor.chatCreatedAt, cursor.lastInboundAt);
  const startSec = Math.max(0, Math.floor(sinceMs / 1000));
  const endSec = Math.max(startSec + 1, Math.ceil(catchUpNow / 1000) + 60);
  return {
    chatId: chat.chatId,
    chatType: target.kind === "router" ? "p2p" : "group",
    botOpenId,
    sinceMs,
    startSec,
    endSec,
    gap: gapFromMs < windowStartMs ? { fromMs: gapFromMs, toMs: windowStartMs } : null,
  };
}

function unseenMessage(ctx: FeishuContext, raw: FeishuRawMessageEvent, botOpenId: FeishuOpenId, skipId: FeishuMessageId | null): InboundMessage | null {
  if (raw.messageId === skipId) return null;
  const parsed = parseFeishuEvent(raw, botOpenId);
  if (parsed === null || parsed.kind !== "message" || ctx.catchUp.seen.has(parsed.messageId)) return null;
  return parsed;
}

// Reads oldest first and caps only unseen messages, so a cap cuts the newest tail and the overlap re-read can never stall progress.
async function fetchMissedMessages(
  ctx: FeishuContext,
  transport: FeishuTransport,
  win: CatchUpWindow,
  skipId: FeishuMessageId | null,
  runEpoch: number,
): Promise<MissedMessages | null> {
  const messages: InboundMessage[] = [];
  let pageToken: string | undefined;
  let lastReadAt = win.sinceMs;
  for (let pages = 0; pages < FEISHU_INBOUND_CATCHUP_MAX_PAGES; pages++) {
    if (isCatchUpStale(ctx, runEpoch)) return null;
    const page = await transport.listMessages({
      chatId: win.chatId,
      chatType: win.chatType,
      botOpenId: win.botOpenId,
      startTimeSec: String(win.startSec),
      endTimeSec: String(win.endSec),
      sortType: "ByCreateTimeAsc",
      pageSize: FEISHU_MESSAGE_LIST_PAGE_SIZE,
      ...(pageToken !== undefined ? { pageToken } : {}),
    });
    if (isCatchUpStale(ctx, runEpoch)) return null;
    for (const raw of page.items) {
      const missed = raw.createTime >= win.sinceMs ? unseenMessage(ctx, raw, win.botOpenId, skipId) : null;
      if (missed === null) continue;
      if (messages.length >= FEISHU_INBOUND_CATCHUP_MAX_MESSAGES) return { messages, unfetchedFrom: missed.at };
      messages.push(missed);
    }
    if (!page.hasMore || page.pageToken === null) return { messages, unfetchedFrom: null };
    lastReadAt = page.items.at(-1)?.createTime ?? lastReadAt;
    pageToken = page.pageToken;
  }
  return { messages, unfetchedFrom: lastReadAt };
}

function isUnansweredAsk(ctx: FeishuContext, raw: FeishuRawMessageEvent, gap: WindowGap, botOpenId: FeishuOpenId, skipId: FeishuMessageId | null): boolean {
  if (raw.createTime < gap.fromMs || raw.createTime >= gap.toMs) return false;
  const message = unseenMessage(ctx, raw, botOpenId, skipId);
  return message !== null && (message.chatType === "p2p" || message.mentionedBot || message.senderOpenId === owner(ctx));
}

async function gapHasUnansweredAsk(
  ctx: FeishuContext,
  transport: FeishuTransport,
  win: CatchUpWindow,
  gap: WindowGap,
  skipId: FeishuMessageId | null,
  runEpoch: number,
): Promise<boolean | null> {
  let pageToken: string | undefined;
  for (let pages = 0; pages < FEISHU_INBOUND_GAP_PROBE_MAX_PAGES; pages++) {
    if (isCatchUpStale(ctx, runEpoch)) return null;
    const page = await transport.listMessages({
      chatId: win.chatId,
      chatType: win.chatType,
      botOpenId: win.botOpenId,
      startTimeSec: String(Math.floor(gap.fromMs / 1000)),
      endTimeSec: String(Math.floor((gap.toMs - 1) / 1000)),
      sortType: "ByCreateTimeDesc",
      pageSize: FEISHU_MESSAGE_LIST_PAGE_SIZE,
      ...(pageToken !== undefined ? { pageToken } : {}),
    });
    if (isCatchUpStale(ctx, runEpoch)) return null;
    if (page.items.some((raw) => isUnansweredAsk(ctx, raw, gap, win.botOpenId, skipId))) return true;
    if (!page.hasMore || page.pageToken === null) return false;
    pageToken = page.pageToken;
  }
  return true;
}

// Messages older than the window are never replayed, so the owner is asked to resend them, and the cursor skips the gap so the reminder fires once.
async function settleWindowGap(
  ctx: FeishuContext,
  transport: FeishuTransport,
  chat: FeishuChatBinding,
  win: CatchUpWindow,
  skipId: FeishuMessageId | null,
  runEpoch: number,
): Promise<boolean> {
  const gap = win.gap;
  if (gap === null) return true;
  const missedAsk = await gapHasUnansweredAsk(ctx, transport, win, gap, skipId, runEpoch);
  if (missedAsk === null) return false;
  if (missedAsk) {
    const minutes = FEISHU_INBOUND_CATCHUP_WINDOW_MS / 60_000;
    try {
      await sendText(ctx, { chatId: chat.chatId }, `电脑离线超过 ${minutes} 分钟，离线期间 ${feishuLocalStamp(gap.toMs)} 之前发的消息没收到。没得到回复的请重发。`);
    } catch (error) {
      if (error instanceof FeishuAuthError) throw error;
      ctx.log(`飞书：入站补拉超窗提醒没发出去 chatId=${chat.chatId} target=${inboundTargetLabel(chat)} reason=${errorText(error)}`);
      return !isCatchUpStale(ctx, runEpoch);
    }
    ctx.log(`飞书：入站补拉超出回溯窗口已提醒重发 chatId=${chat.chatId} target=${inboundTargetLabel(chat)} gapFrom=${gap.fromMs} windowStart=${gap.toMs}`);
  }
  if (isCatchUpStale(ctx, runEpoch)) return false;
  ctx.store.saveInboundCursor(chat.chatId, { lastInboundAt: gap.toMs, lastMessageId: null }, ctx.now());
  return true;
}

function queueMissedMessages(ctx: FeishuContext, chat: FeishuChatBinding, missed: InboundMessage[], unfetchedFrom: number | null) {
  const { inbound } = ctx;
  const available = Math.max(0, inbound.limit - inbound.count);
  const accepted = missed.slice(0, available);
  const dropped = missed.slice(available);
  if (accepted.length > 0) {
    const lane = laneOf(inbound, chat.chatId);
    lane.tasks.unshift(...accepted.map((ev) => inboundTask(() => handleInbound(ctx, ev, null))));
    inbound.count += accepted.length;
    startLane(ctx, inbound, chat.chatId, lane);
  }
  const firstDropped = dropped[0];
  const holdAt = firstDropped?.at ?? unfetchedFrom;
  if (holdAt === null) {
    ctx.catchUp.cursorHold.delete(chat.chatId);
    return;
  }
  if (holdAt > 0) noteInboundQueueDrop(ctx, chat.chatId, holdAt);
  ctx.directory.markAllStale();
  ctx.link.lastError = "飞书入站队列已满，请重发未收到回复的消息";
  ctx.log(
    `飞书：入站补拉队列已满 chatId=${chat.chatId} target=${inboundTargetLabel(chat)} dropped=${dropped.length} queued=${accepted.length} limit=${inbound.limit} firstDroppedId=${firstDropped?.messageId ?? "none"} unfetched=${unfetchedFrom !== null}`,
  );
}

async function catchUpInboundChat(ctx: FeishuContext, chat: FeishuChatBinding, includeOverlap: boolean, runEpoch: number) {
  const app = ctx.store.app();
  const target = activeTarget(ctx, chat);
  const transport = ctx.link.transport;
  if (app === null || target === null || transport === null || isCatchUpStale(ctx, runEpoch)) return;
  if (target.kind === "pm" && ctx.link.mentionOnly) {
    ctx.log(`飞书：入站补拉跳过项目群 chatId=${chat.chatId} pmId=${target.pmId} reason=missing_scope:${FEISHU_GROUP_MSG_SCOPE}`);
    return;
  }
  const catchUpNow = ctx.now();
  const cursor = ctx.store.inboundCursor(chat.chatId);
  if (cursor === null) return;
  if (cursor.lastInboundAt === null) {
    ctx.store.saveInboundCursor(chat.chatId, { lastInboundAt: catchUpNow, lastMessageId: null }, catchUpNow);
    return;
  }
  const win = catchUpWindow(chat, target, app.botOpenId, { chatCreatedAt: cursor.chatCreatedAt, lastInboundAt: cursor.lastInboundAt }, includeOverlap, catchUpNow);
  if (!(await settleWindowGap(ctx, transport, chat, win, cursor.lastMessageId, runEpoch))) return;
  const fetched = await fetchMissedMessages(ctx, transport, win, includeOverlap ? null : cursor.lastMessageId, runEpoch);
  if (fetched === null) return;
  queueMissedMessages(ctx, chat, fetched.messages, fetched.unfetchedFrom);
}

async function catchUpAllChats(ctx: FeishuContext, runEpoch: number, includeOverlap: boolean) {
  try {
    await ensureScopesChecked(ctx);
  } catch (error) {
    if (error instanceof FeishuAuthError) handleError(ctx, error);
    else ctx.log(`飞书：入站补拉前检查权限出错：${errorText(error)}`);
    return;
  }
  if (isCatchUpStale(ctx, runEpoch) || owner(ctx) === null || ctx.store.app() === null) return;
  const catchUpLimit = pLimit(FEISHU_INBOUND_CATCHUP_CONCURRENCY);
  let abortedByAuth = false;
  const catchUpChat = async (chat: FeishuChatBinding) => {
    if (isCatchUpStale(ctx, runEpoch) || abortedByAuth || activeTarget(ctx, chat) === null) {
      releaseInboundGate(ctx, chat.chatId, runEpoch);
      return;
    }
    try {
      await catchUpInboundChat(ctx, chat, includeOverlap, runEpoch);
    } catch (error) {
      if (error instanceof FeishuAuthError) {
        abortedByAuth = true;
        handleError(ctx, error);
        return;
      }
      const code = error instanceof FeishuApiError ? String(error.code) : "network";
      ctx.log(`飞书：入站补拉跳过会话 chatId=${chat.chatId} target=${inboundTargetLabel(chat)} code=${code} reason=${errorText(error)}`);
    } finally {
      releaseInboundGate(ctx, chat.chatId, runEpoch);
    }
  };
  await Promise.all(ctx.store.chats().map((chat) => catchUpLimit(() => catchUpChat(chat))));
  if (!isCatchUpStale(ctx, runEpoch) && !abortedByAuth) ctx.catchUp.hadLiveSession = true;
}

export function pumpInboundCatchUp(ctx: FeishuContext) {
  const { catchUp } = ctx;
  if (ctx.life.closed || !ctx.link.wsUp || catchUp.inflight !== null || catchUp.targetEpoch === 0) return;
  const runEpoch = catchUp.targetEpoch;
  catchUp.targetEpoch = 0;
  catchUp.inflight = catchUpAllChats(ctx, runEpoch, catchUp.hadLiveSession).finally(() => {
    releaseAllInboundGates(ctx, runEpoch);
    catchUp.inflight = null;
    if (catchUp.targetEpoch > 0 && ctx.link.wsUp && !ctx.life.closed) pumpInboundCatchUp(ctx);
    settleIdle(ctx);
  });
}
