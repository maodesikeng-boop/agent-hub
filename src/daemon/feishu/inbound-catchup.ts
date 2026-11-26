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
  if (parsed === null || parsed.kind !== "message" || ctx.inboundSync.isAlreadyExecuted(parsed.messageId)) return null;
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

async function probeWindowGap(
  ctx: FeishuContext,
  transport: FeishuTransport,
  win: CatchUpWindow,
  gap: WindowGap,
  skipId: FeishuMessageId | null,
  runEpoch: number,
): Promise<{ unanswered: boolean; held: InboundMessage[] } | null> {
  const held: InboundMessage[] = [];
  let unanswered = false;
  const startSec = Math.floor(gap.fromMs / 1000);
  const endSec = Math.max(startSec + 1, Math.ceil(gap.toMs / 1000));
  let pageToken: string | undefined;
  for (let pages = 0; pages < FEISHU_INBOUND_GAP_PROBE_MAX_PAGES; pages++) {
    if (isCatchUpStale(ctx, runEpoch)) return null;
    const page = await transport.listMessages({
      chatId: win.chatId,
      chatType: win.chatType,
      botOpenId: win.botOpenId,
      startTimeSec: String(startSec),
      endTimeSec: String(endSec),
      sortType: "ByCreateTimeDesc",
      pageSize: FEISHU_MESSAGE_LIST_PAGE_SIZE,
      ...(pageToken !== undefined ? { pageToken } : {}),
    });
    if (isCatchUpStale(ctx, runEpoch)) return null;
    for (const raw of page.items) {
      if (raw.createTime < gap.fromMs || raw.createTime >= gap.toMs) continue;
      const message = unseenMessage(ctx, raw, win.botOpenId, skipId);
      if (message === null) continue;
      if (ctx.inboundSync.receiptOf(message.messageId)?.phase === "held_offline") {
        if (win.chatType === "group") held.push(message);
      } else if (message.chatType === "p2p" || message.mentionedBot || message.senderOpenId === owner(ctx)) {
        unanswered = true;
      }
    }
    if (!page.hasMore || page.pageToken === null) return { unanswered, held: held.reverse() };
    pageToken = page.pageToken;
  }
  return { unanswered: true, held: held.reverse() };
}

// Only a persisted offline hold permits automatic replay outside the normal catch-up window.
async function settleWindowGap(
  ctx: FeishuContext,
  transport: FeishuTransport,
  chat: FeishuChatBinding,
  win: CatchUpWindow,
  skipId: FeishuMessageId | null,
  runEpoch: number,
): Promise<InboundMessage[] | null> {
  const gap = win.gap;
  if (gap === null) return [];
  const probe = await probeWindowGap(ctx, transport, win, gap, skipId, runEpoch);
  if (probe === null) return null;
  if (probe.unanswered) {
    const minutes = FEISHU_INBOUND_CATCHUP_WINDOW_MS / 60_000;
    try {
      await sendText(ctx, { chatId: chat.chatId }, `电脑离线超过 ${minutes} 分钟，离线期间 ${feishuLocalStamp(gap.toMs)} 之前发的消息没收到。没得到回复的请重发。`);
    } catch (error) {
      if (error instanceof FeishuAuthError) throw error;
      ctx.log(`飞书：入站补拉超窗提醒没发出去 chatId=${chat.chatId} target=${inboundTargetLabel(chat)} reason=${errorText(error)}`);
      return isCatchUpStale(ctx, runEpoch) ? null : probe.held;
    }
    ctx.log(`飞书：入站补拉超出回溯窗口已提醒重发 chatId=${chat.chatId} target=${inboundTargetLabel(chat)} gapFrom=${gap.fromMs} windowStart=${gap.toMs}`);
  }
  if (isCatchUpStale(ctx, runEpoch)) return null;
  if (probe.held.length === 0) {
    ctx.inboundSync.advanceCursor(chat.chatId, { lastInboundAt: gap.toMs, lastMessageId: null });
    void ctx.inboundSync.flush();
  }
  return probe.held;
}

function queueMissedMessages(ctx: FeishuContext, chat: FeishuChatBinding, missed: InboundMessage[], unfetchedFrom: number | null) {
  const { inbound } = ctx;
  const available = Math.max(0, inbound.limit - inbound.count);
  const accepted = missed.slice(0, available);
  const dropped = missed.slice(available);
  if (accepted.length > 0) {
    const lane = laneOf(inbound, chat.chatId);
    lane.tasks.unshift(...accepted.map((ev) => inboundTask(() =>
      handleInbound(ctx, ev, ctx.inboundSync.receiptOf(ev.messageId)?.phase === "held_offline" ? ev.at : null),
    )));
    inbound.count += accepted.length;
    startLane(ctx, inbound, chat.chatId, lane);
  }
  const firstDropped = dropped[0];
  const holdAt = firstDropped?.at ?? unfetchedFrom;
  // Each round re-reads from the stored cursor, so its hold supersedes an earlier round's hold rather than keeping the older minimum.
  if (holdAt !== null && holdAt > 0) ctx.catchUp.cursorHold.set(chat.chatId, holdAt);
  else ctx.catchUp.cursorHold.delete(chat.chatId);
  if (holdAt === null) return;
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
  const cursor = ctx.inboundSync.cursorOf(chat.chatId);
  const anchor = cursor?.lastInboundAt ?? chat.createdAt;
  const retryAt = ctx.inboundSync.retryFrom(chat.chatId, Math.max(1, catchUpNow - FEISHU_INBOUND_CATCHUP_WINDOW_MS));
  const rewind = retryAt !== null && retryAt <= anchor;
  const skipId = rewind ? null : cursor?.lastMessageId ?? null;
  const win = catchUpWindow(chat, target, app.botOpenId, {
    chatCreatedAt: target.kind === "router" ? Math.min(chat.createdAt, anchor) : chat.createdAt,
    lastInboundAt: rewind ? retryAt : anchor,
  }, includeOverlap, catchUpNow);
  const held = await settleWindowGap(ctx, transport, chat, win, skipId, runEpoch);
  if (held === null) return;
  const fetched = await fetchMissedMessages(ctx, transport, win, includeOverlap ? null : skipId, runEpoch);
  if (fetched === null) return;
  queueMissedMessages(ctx, chat, [...held, ...fetched.messages], fetched.unfetchedFrom);
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
