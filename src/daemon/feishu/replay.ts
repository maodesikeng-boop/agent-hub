import type { Change } from "../../shared/api.ts";
import type { ConversationId, MessageId, PmId } from "../../shared/domain.ts";
import type { FeishuChatId } from "../../shared/feishu.ts";
import { FEISHU_CATCHUP_MAX_MESSAGES, FEISHU_CLOSE_DRAIN_MS, FEISHU_PAGE_SIZE } from "../../shared/limits.ts";
import { handleError, sendText, unlessRejected } from "./api.ts";
import { resumeUploads, startUploadsOf } from "./attachments.ts";
import { ackAllRouterEvents } from "./connection.ts";
import { errorText, isCenter, isReady, owner, type FeishuContext } from "./context.ts";
import {
  postAskCard,
  postRouterAskCard,
  postRouterItem,
  refreshPendingAskCard,
  settleAskCard,
  settleRouterAsk,
  settleRouterCards,
  settleRouterItem,
} from "./decision-cards.ts";
import { admit, enqueue, requestControl, whenIdle } from "./lanes.ts";
import { catchUpIntents, projectFeishuChange, type FeishuOutboundIntent } from "./outbound.ts";
import { activeTarget, chatOfConversation, conversationOfPm, latestMessageId, liveChatOfPm, projectionOf, routerChat } from "./projection.ts";
import { refreshPolicyCard, refreshRouterSettingsCard, schedulePolicyCardRefresh, scheduleRouterSettingsCardRefresh } from "./settings-cards.ts";
import type { FeishuChatBinding } from "./store.ts";
import { feedStream, finalizeSegment, segmentDone } from "./stream-cards.ts";
import { mirrorUser, postRouterCommand } from "./text-cards.ts";
import { FeishuAuthError } from "./transport.ts";

type PmIntent = Extract<FeishuOutboundIntent, { kind: "stream" | "working" | "agent_text" | "turn_end" | "mirror_user" | "ask_card" }>;

const replayRouterLater = (ctx: FeishuContext, chat: FeishuChatBinding) =>
  enqueue(ctx, chat.chatId, () => replayRouterEvents(ctx, chat, false), { key: "router-events" });

function runPmIntent(ctx: FeishuContext, intent: PmIntent) {
  const chat = chatOfConversation(ctx, intent.conversationId);
  if (chat === null) return;
  const id = intent.conversationId;
  const chatId = chat.chatId;
  switch (intent.kind) {
    case "stream":
      return enqueue(ctx, chatId, () => feedStream(ctx, id, { kind: "text", text: intent.text }, chatId), { key: `stream:${id}`, preview: true });
    case "working":
      return enqueue(ctx, chatId, () => feedStream(ctx, id, { kind: "working", status: intent.status }, chatId), { key: `working:${id}`, preview: true });
    case "agent_text": {
      startUploadsOf(ctx, intent.message);
      // Turn activity is sampled when the segment lands, not when the lane reaches it.
      const done = segmentDone(ctx, intent.message);
      const run = async () => {
        if ((ctx.store.chatById(chatId)?.lastMessageId ?? 0) >= intent.message.id) return;
        await feedStream(ctx, id, done, chatId);
      };
      return enqueue(ctx, chatId, run, { mark: intent.message.id });
    }
    case "turn_end":
      return enqueue(ctx, chatId, () => feedStream(ctx, id, { kind: "turn_end" }, chatId));
    case "mirror_user":
      startUploadsOf(ctx, intent.message);
      return enqueue(ctx, chatId, () => mirrorUser(ctx, chatId, intent.message), { mark: intent.message.id });
    case "ask_card":
      startUploadsOf(ctx, intent.message);
      return enqueue(ctx, chatId, () => postAskCard(ctx, chatId, intent.message), { mark: intent.message.id });
  }
}

function runIntent(ctx: FeishuContext, intent: FeishuOutboundIntent) {
  switch (intent.kind) {
    case "sync_chats":
      return requestControl(ctx, "sync");
    case "stream":
    case "working":
    case "agent_text":
    case "turn_end":
    case "mirror_user":
    case "ask_card":
      return runPmIntent(ctx, intent);
    case "ask_settled": {
      const chat = chatOfConversation(ctx, intent.conversationId);
      if (chat !== null) enqueue(ctx, chat.chatId, () => settleAskCard(ctx, intent.message.id));
      const router = routerChat(ctx);
      if (router !== null) enqueue(ctx, router.chatId, () => settleRouterAsk(ctx, intent.message.id));
      return;
    }
    case "ask_updated": {
      const chat = chatOfConversation(ctx, intent.conversationId);
      if (chat !== null) enqueue(ctx, chat.chatId, () => refreshPendingAskCard(ctx, intent.message.id, "pm"));
      const router = routerChat(ctx);
      if (router !== null) enqueue(ctx, router.chatId, () => refreshPendingAskCard(ctx, intent.message.id, "router"));
      return;
    }
    case "router_ask": {
      startUploadsOf(ctx, intent.message);
      const chat = routerChat(ctx);
      if (chat !== null) replayRouterLater(ctx, chat);
      else if (!isCenter(ctx)) ackAllRouterEvents(ctx);
      return;
    }
    case "router_item": {
      const chat = routerChat(ctx);
      if (chat === null) return;
      replayRouterLater(ctx, chat);
      if (intent.item.kind === "decision" && intent.item.status !== "pending") enqueue(ctx, chat.chatId, () => settleRouterItem(ctx, intent.item.id));
      return;
    }
    case "router_command": {
      const chat = routerChat(ctx);
      if (chat !== null) replayRouterLater(ctx, chat);
      return;
    }
    case "refresh_policy_card": {
      const chat = liveChatOfPm(ctx, intent.pmId);
      if (chat !== null) schedulePolicyCardRefresh(ctx, chat.chatId, intent.pmId);
      return;
    }
    case "refresh_router_settings_card": {
      const chat = routerChat(ctx);
      if (chat !== null) scheduleRouterSettingsCardRefresh(ctx, chat.chatId);
      return;
    }
  }
}

export function onLedgerChange(ctx: FeishuContext, change: Change) {
  if (change.type === "session.status") {
    const { conversationId, status, activity } = change.data.session;
    if (conversationId !== null) {
      if (status === "running" && activity !== "idle") ctx.activeTurns.add(conversationId);
      else ctx.activeTurns.delete(conversationId);
    }
  }
  if (!isCenter(ctx) && (change.type === "router.item.created" || change.type === "router.item.updated" || change.type === "router.command.updated")) {
    ackAllRouterEvents(ctx);
    return;
  }
  if (ctx.link.transport === null || !isReady(ctx) || owner(ctx) === null) return;
  try {
    for (const intent of projectFeishuChange(change, projectionOf(ctx))) runIntent(ctx, intent);
  } catch (error) {
    ctx.log(`飞书：投影账本变化出错：${errorText(error)}`);
  }
}

async function replayPmIntent(ctx: FeishuContext, chatId: FeishuChatId, intent: FeishuOutboundIntent) {
  if (intent.kind === "agent_text") await feedStream(ctx, intent.conversationId, segmentDone(ctx, intent.message), chatId);
  else if (intent.kind === "mirror_user") await mirrorUser(ctx, chatId, intent.message);
  else if (intent.kind === "ask_card") await postAskCard(ctx, chatId, intent.message);
}

async function replayChat(ctx: FeishuContext, chat: FeishuChatBinding, recent: boolean, router: FeishuChatBinding | null) {
  if (chat.target.kind === "pm") return replayPmChat(ctx, chat, recent);
  if (chat.chatId !== router?.chatId) return;
  await settleRouterCards(ctx, chat);
  await replayRouterEvents(ctx, chat, recent);
  await resumeUploads(ctx, chat);
  if (ctx.store.postOf({ kind: "router_settings" })?.cardId != null) {
    await unlessRejected(ctx, () => refreshRouterSettingsCard(ctx));
  }
}

export async function catchUp(ctx: FeishuContext, recent: boolean, replaying: ReadonlySet<string>): Promise<Set<FeishuChatId>> {
  const failed = new Set<FeishuChatId>();
  const router = routerChat(ctx);
  for (const chat of ctx.store.chats()) {
    if (!recent && !replaying.has(chat.chatId)) continue;
    if (!isReady(ctx) || ctx.life.closed) {
      failed.add(chat.chatId);
      continue;
    }
    try {
      await replayChat(ctx, chat, recent, router);
    } catch (error) {
      if (error instanceof FeishuAuthError) throw error;
      handleError(ctx, error);
      failed.add(chat.chatId);
    }
  }
  for (const [id, slot] of ctx.streams) {
    if (ctx.activeTurns.has(id) || failed.has(slot.chatId) || !(recent || replaying.has(slot.chatId))) continue;
    await unlessRejected(ctx, () => feedStream(ctx, id, { kind: "turn_end" }, slot.chatId, slot));
  }
  return failed;
}

async function replayLedgerPages(ctx: FeishuContext, chat: FeishuChatBinding, conversationId: ConversationId, recent: boolean) {
  let after: MessageId = chat.lastMessageId ?? latestMessageId(ctx, conversationId) ?? 0;
  let skipped = 0;
  let tail: FeishuOutboundIntent[] = [];
  let scanned = after;
  for (;;) {
    const page = ctx.ledger.messagesAfter(conversationId, after, FEISHU_PAGE_SIZE);
    if (page.length === 0) break;
    if (!isReady(ctx) || ctx.life.closed) throw new Error("飞书断开了，补发没做完");
    if (recent) {
      const batch = catchUpIntents(conversationId, page);
      const combined = [...tail, ...batch.intents];
      tail = combined.slice(-FEISHU_CATCHUP_MAX_MESSAGES);
      skipped += batch.omitted + combined.length - tail.length;
    } else {
      const batch = catchUpIntents(conversationId, page, FEISHU_PAGE_SIZE);
      for (const intent of batch.intents) await unlessRejected(ctx, () => replayPmIntent(ctx, chat.chatId, intent));
      if (batch.lastMessageId !== null) ctx.store.advanceWatermark(chat.chatId, { messageId: batch.lastMessageId }, ctx.now());
    }
    scanned = after = page.at(-1)!.id;
    if (page.length < FEISHU_PAGE_SIZE) break;
  }
  if (!recent) return;
  if (skipped > 0) await sendText(ctx, { chatId: chat.chatId }, `离线期间还有 ${skipped} 条，去网页看。`);
  for (const intent of tail) await unlessRejected(ctx, () => replayPmIntent(ctx, chat.chatId, intent));
  if (scanned > (chat.lastMessageId ?? 0)) ctx.store.advanceWatermark(chat.chatId, { messageId: scanned }, ctx.now());
}

async function finalizeStreamingPosts(ctx: FeishuContext, chat: FeishuChatBinding, conversationId: ConversationId) {
  for (const post of ctx.store.streamingPosts(chat.chatId, FEISHU_PAGE_SIZE)) {
    if (post.ref.kind !== "message" || post.cardId === null) continue;
    const message = ctx.ledger.getMessage(post.ref.messageId);
    const text = message === null ? "（这段回复已经删了）" : message.text;
    const effect = { kind: "finalize", cardId: post.cardId, sequence: post.sequence, messageId: post.ref.messageId, text } as const;
    await unlessRejected(ctx, () => finalizeSegment(ctx, chat.chatId, conversationId, effect));
  }
}

async function replayPmChat(ctx: FeishuContext, chat: FeishuChatBinding, recent: boolean) {
  if (chat.target.kind !== "pm" || chat.target.pmId === null || activeTarget(ctx, chat) === null) return;
  const pmId: PmId = chat.target.pmId;
  const conversationId = conversationOfPm(ctx, pmId);
  if (conversationId === null) return;
  for (const post of ctx.store.pendingCards(pmId)) {
    if (post.ref.kind === "message") await settleAskCard(ctx, post.ref.messageId);
  }
  if (chat.lastMessageId === null) ctx.store.advanceWatermark(chat.chatId, { messageId: latestMessageId(ctx, conversationId) ?? 0 }, ctx.now());
  await replayLedgerPages(ctx, chat, conversationId, recent);
  await finalizeStreamingPosts(ctx, chat, conversationId);
  await resumeUploads(ctx, chat);
  if (ctx.store.postOf({ kind: "chat_policy", pmId })?.cardId != null) {
    await unlessRejected(ctx, () => refreshPolicyCard(ctx, pmId));
  }
}

async function replayRouterEvent(ctx: FeishuContext, event: ReturnType<FeishuContext["store"]["routerEventsAfter"]>[number]) {
  if (event.item_id !== null) {
    const item = ctx.ledger.getRouterItem(event.item_id);
    if (item !== null) await postRouterItem(ctx, item);
  } else if (event.ask_message_id !== null) {
    const message = ctx.ledger.getMessage(event.ask_message_id);
    if (message !== null) await postRouterAskCard(ctx, message);
  } else if (event.command_id !== null) {
    const command = ctx.ledger.getRouterCommand(event.command_id);
    if (command !== null && (command.status === "answered" || command.status === "dispatched" || command.status === "failed")) await postRouterCommand(ctx, command);
  }
}

async function replayRouterEvents(ctx: FeishuContext, chat: FeishuChatBinding, recent: boolean) {
  const current = ctx.store.chatOfTarget({ kind: "router" });
  if (current?.chatId !== chat.chatId) return;
  let after = current.lastRouterEventId ?? 0;
  if (recent) {
    const backlog = ctx.store.routerEventBacklog(after, FEISHU_CATCHUP_MAX_MESSAGES);
    if (backlog !== null) {
      await sendText(ctx, { chatId: chat.chatId }, `离线期间还有 ${backlog.skipped} 条，去网页看。`);
      ctx.store.ackRouterEvent(chat.chatId, backlog.lastSkippedId, ctx.now());
      after = backlog.lastSkippedId;
    }
  }
  for (;;) {
    if (!isReady(ctx) || ctx.life.closed || ctx.store.chatById(chat.chatId) === null) return;
    const page = ctx.store.routerEventsAfter(after, FEISHU_PAGE_SIZE);
    for (const event of page) {
      await unlessRejected(ctx, () => replayRouterEvent(ctx, event));
      after = event.id;
      ctx.store.ackRouterEvent(chat.chatId, after, ctx.now());
    }
    if (page.length < FEISHU_PAGE_SIZE) return;
  }
}

export async function drainBeforeClose(ctx: FeishuContext) {
  if (!isReady(ctx)) return;
  const drained = (async () => {
    await whenIdle(ctx, false);
    for (const [id, slot] of ctx.streams) {
      admit(ctx, ctx.outbound, slot.chatId, { key: null, run: () => feedStream(ctx, id, { kind: "turn_end" }, slot.chatId, slot), mark: null }, Infinity);
    }
    await whenIdle(ctx, false);
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([drained, new Promise((resolve) => { timer = setTimeout(resolve, FEISHU_CLOSE_DRAIN_MS); })]);
  clearTimeout(timer);
}
