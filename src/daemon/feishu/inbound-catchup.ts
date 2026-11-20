import pLimit from "p-limit";
import type { FeishuChatId, FeishuChatTarget, FeishuOpenId } from "../../shared/feishu.ts";
import {
  FEISHU_INBOUND_CATCHUP_CONCURRENCY,
  FEISHU_INBOUND_CATCHUP_MAX_MESSAGES,
  FEISHU_INBOUND_CATCHUP_MAX_PAGES,
  FEISHU_INBOUND_CATCHUP_OVERLAP_MS,
  FEISHU_INBOUND_CATCHUP_WINDOW_MS,
  FEISHU_MESSAGE_LIST_PAGE_SIZE,
} from "../../shared/limits.ts";
import { handleError } from "./api.ts";
import { ensureScopesChecked } from "./connection.ts";
import { errorText, owner, type FeishuContext } from "./context.ts";
import { handleInbound } from "./inbound-dispatch.ts";
import { parseFeishuEvent, type FeishuInbound } from "./inbound.ts";
import { inboundTask, laneOf, settleIdle, startLane } from "./lanes.ts";
import { activeTarget } from "./projection.ts";
import { FEISHU_GROUP_MSG_SCOPE } from "./scopes.ts";
import type { FeishuChatBinding } from "./store.ts";
import { FeishuApiError, FeishuAuthError, type FeishuRawMessageEvent, type FeishuTransport } from "./transport.ts";

type InboundMessage = Extract<FeishuInbound, { kind: "message" }>;

interface CatchUpWindow {
  chatId: FeishuChatId;
  chatType: "p2p" | "group";
  botOpenId: FeishuOpenId;
  sinceMs: number;
  startSec: number;
  endSec: number;
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

function catchUpWindow(chat: FeishuChatBinding, target: FeishuChatTarget, botOpenId: FeishuOpenId, chatCreatedAt: number, anchorMs: number, catchUpNow: number): CatchUpWindow {
  const windowFloorMs = Math.max(chatCreatedAt, catchUpNow - FEISHU_INBOUND_CATCHUP_WINDOW_MS);
  const sinceMs = Math.max(windowFloorMs, anchorMs);
  const startSec = Math.max(0, Math.floor(sinceMs / 1000));
  const endSec = Math.max(startSec + 1, Math.ceil(catchUpNow / 1000) + 60);
  return { chatId: chat.chatId, chatType: target.kind === "router" ? "p2p" : "group", botOpenId, sinceMs, startSec, endSec };
}

async function fetchRecentMessages(ctx: FeishuContext, transport: FeishuTransport, win: CatchUpWindow, runEpoch: number): Promise<FeishuRawMessageEvent[] | null> {
  const fetched: FeishuRawMessageEvent[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  while (pages < FEISHU_INBOUND_CATCHUP_MAX_PAGES && fetched.length < FEISHU_INBOUND_CATCHUP_MAX_MESSAGES) {
    if (isCatchUpStale(ctx, runEpoch)) return null;
    const page = await transport.listMessages({
      chatId: win.chatId,
      chatType: win.chatType,
      botOpenId: win.botOpenId,
      startTimeSec: String(win.startSec),
      endTimeSec: String(win.endSec),
      sortType: "ByCreateTimeDesc",
      pageSize: Math.min(FEISHU_MESSAGE_LIST_PAGE_SIZE, FEISHU_INBOUND_CATCHUP_MAX_MESSAGES - fetched.length),
      ...(pageToken !== undefined ? { pageToken } : {}),
    });
    if (isCatchUpStale(ctx, runEpoch)) return null;
    pages++;
    let reachedBeforeFloor = false;
    for (const raw of page.items) {
      if (raw.createTime < win.sinceMs) {
        reachedBeforeFloor = true;
        continue;
      }
      fetched.push(raw);
      if (fetched.length >= FEISHU_INBOUND_CATCHUP_MAX_MESSAGES) break;
    }
    if (!page.hasMore || page.pageToken === null || reachedBeforeFloor) break;
    pageToken = page.pageToken;
  }
  return fetched.reverse();
}

function queueMissedMessages(ctx: FeishuContext, chat: FeishuChatBinding, missed: InboundMessage[]) {
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
  if (firstDropped === undefined) {
    ctx.catchUp.cursorHold.delete(chat.chatId);
    return;
  }
  if (firstDropped.at > 0) noteInboundQueueDrop(ctx, chat.chatId, firstDropped.at);
  ctx.directory.markAllStale();
  ctx.link.lastError = "飞书入站队列已满，请重发未收到回复的消息";
  ctx.log(
    `飞书：入站补拉队列已满 chatId=${chat.chatId} target=${inboundTargetLabel(chat)} dropped=${dropped.length} queued=${accepted.length} limit=${inbound.limit} firstDroppedId=${firstDropped.messageId}`,
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
  const anchorMs = includeOverlap ? cursor.lastInboundAt - FEISHU_INBOUND_CATCHUP_OVERLAP_MS : cursor.lastInboundAt;
  const win = catchUpWindow(chat, target, app.botOpenId, cursor.chatCreatedAt, anchorMs, catchUpNow);
  const fetched = await fetchRecentMessages(ctx, transport, win, runEpoch);
  if (fetched === null) return;
  const missed: InboundMessage[] = [];
  for (const raw of fetched) {
    if (!includeOverlap && cursor.lastMessageId !== null && raw.messageId === cursor.lastMessageId) continue;
    const parsed = parseFeishuEvent(raw, app.botOpenId);
    if (parsed === null || parsed.kind !== "message") continue;
    if (ctx.catchUp.seen.has(parsed.messageId)) continue;
    missed.push(parsed);
  }
  if (isCatchUpStale(ctx, runEpoch)) return;
  if (missed.length === 0) {
    ctx.catchUp.cursorHold.delete(chat.chatId);
    return;
  }
  queueMissedMessages(ctx, chat, missed);
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
