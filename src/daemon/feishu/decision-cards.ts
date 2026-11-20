import { askOf, type Message, type MessageId } from "../../shared/domain.ts";
import type { FeishuChatId, FeishuMessageId } from "../../shared/feishu.ts";
import type { RouterItem } from "../../shared/router.ts";
import { postCardEntity, unlessRejected, updateCard } from "./api.ts";
import { attachmentSlots, attachmentViews, followUpAttachments, prepareAttachments } from "./attachments.ts";
import {
  feishuCardRefOf,
  feishuCardStateOf,
  renderAskCard,
  renderReplyCard,
  renderRouterAskCard,
  renderRouterItem,
  renderTextCard,
  type FeishuCardJson,
  type FeishuCardRef,
  type FeishuCardState,
} from "./cards.ts";
import { displayOwner, type AttachmentScope, type AttachmentSlot, type FeishuContext, type HostCard } from "./context.ts";
import { splitFeishuMarkdown } from "./outbound.ts";
import { chatOfConversation, isActivePm, liveChatOfPm, pmNameOf, pmOfConversation, routerChat } from "./projection.ts";
import type { FeishuChatBinding, FeishuPostRecord, FeishuPostRef } from "./store.ts";
import { MIRROR_TITLE, mirrorText } from "./text-cards.ts";

export const decisionOf = (ctx: FeishuContext, ref: FeishuCardRef) => ctx.store.decision(ref);

function askStateOf(ctx: FeishuContext, message: Message): FeishuCardState {
  const ask = askOf(message);
  if (ask === null) return { kind: "closed" };
  return feishuCardStateOf(ask, decisionOf(ctx, feishuCardRefOf(message, ask))?.name ?? displayOwner(ctx));
}

function routerItemState(ctx: FeishuContext, item: RouterItem, ask: Message | null): FeishuCardState {
  if (ask !== null) return askStateOf(ctx, ask);
  if (item.kind === "report" || item.status === "pending") return { kind: "pending" };
  if (item.status === "superseded") return { kind: "closed" };
  return {
    kind: "answered",
    chosenOption: item.resolution?.chosenOption ?? null,
    note: item.resolution?.note ? item.resolution.note : null,
    byName: decisionOf(ctx, { kind: "router_item", itemId: item.id })?.name ?? displayOwner(ctx),
  };
}

function pmChatOfMessage(ctx: FeishuContext, message: Message) {
  const pmId = pmOfConversation(ctx, message.conversationId);
  return { pmId, pmChatId: (pmId === null ? null : liveChatOfPm(ctx, pmId))?.chatId ?? null };
}

function routerAskCard(ctx: FeishuContext, message: Message, state: FeishuCardState, slots: readonly AttachmentSlot[]): FeishuCardJson | null {
  const ask = askOf(message);
  if (ask === null) return null;
  const { pmId, pmChatId } = pmChatOfMessage(ctx, message);
  return renderRouterAskCard(message, ask, state, pmChatId, attachmentViews(slots), pmNameOf(ctx, pmId));
}

function pmHostCard(ctx: FeishuContext, message: Message): FeishuCardJson {
  const views = attachmentViews(attachmentSlots(ctx, message, false, "pm"));
  const ask = message.sender === "agent" ? askOf(message) : null;
  const lastChunk = splitFeishuMarkdown(message.sender === "user" ? mirrorText(message) : message.text).at(-1) ?? "";
  if (ask !== null) return renderAskCard(message, ask, askStateOf(ctx, message), views);
  if (message.sender === "user") return renderTextCard({ title: MIRROR_TITLE, text: lastChunk, template: "grey", attachments: views });
  return renderReplyCard({ conversationId: message.conversationId, text: lastChunk, streaming: false, withStop: false, attachments: views });
}

function hostCardOf(ctx: FeishuContext, post: FeishuPostRecord, message: Message): FeishuCardJson | null {
  if (post.ref.kind === "message") return pmHostCard(ctx, message);
  if (post.ref.kind === "router_ask") return routerAskCard(ctx, message, askStateOf(ctx, message), attachmentSlots(ctx, message, false, "router"));
  if (post.ref.kind !== "router_item") return null;
  const item = ctx.ledger.getRouterItem(post.ref.itemId);
  const ask = askOf(message);
  if (item === null || ask === null) return null;
  const views = attachmentViews(attachmentSlots(ctx, message, false, "router"));
  return renderRouterItem(item, { message, meta: ask }, routerItemState(ctx, item, message), liveChatOfPm(ctx, item.pmId)?.chatId ?? null, views);
}

export async function refreshHostCard(ctx: FeishuContext, message: Message, hostMessageId: FeishuMessageId) {
  const post = ctx.store.postByMessageId(hostMessageId);
  if (post === null || post.cardId === null) return;
  const card = hostCardOf(ctx, post, message);
  if (card === null) return;
  const cardId = post.cardId;
  await unlessRejected(ctx, () => updateCard(ctx, cardId, post.sequence + 1, card));
  if (ctx.store.chatById(post.chatId) !== null) ctx.store.savePost({ ...post, sequence: post.sequence + 1 }, ctx.now());
}

export async function postAskCard(ctx: FeishuContext, chatId: FeishuChatId, message: Message) {
  if (chatOfConversation(ctx, message.conversationId)?.chatId !== chatId) return;
  const ref: FeishuPostRef = { kind: "message", messageId: message.id, part: 0 };
  const existing = ctx.store.postOf(ref);
  let host: HostCard;
  let slots: AttachmentSlot[];
  if (existing === null) {
    const ask = askOf(message);
    if (ask === null) return;
    if (askStateOf(ctx, message).kind !== "pending") {
      ctx.store.advanceWatermark(chatId, { messageId: message.id }, ctx.now());
      return;
    }
    slots = await prepareAttachments(ctx, message);
    const card = renderAskCard(message, ask, askStateOf(ctx, message), attachmentViews(slots));
    const posted = await postCardEntity(ctx, chatId, card, `fusa-a-${message.id}`);
    if (chatOfConversation(ctx, message.conversationId)?.chatId !== chatId) return;
    ctx.store.savePost({ ref, chatId, messageId: posted.messageId, cardId: posted.cardId, sequence: 0, state: "card_pending" }, ctx.now());
    host = posted;
  } else {
    slots = attachmentSlots(ctx, message);
    host = { messageId: existing.messageId, cardId: existing.cardId };
  }
  await followUpAttachments(ctx, chatId, slots, host);
  ctx.store.advanceWatermark(chatId, { messageId: message.id }, ctx.now());
}

async function settlePost(ctx: FeishuContext, post: FeishuPostRecord, card: FeishuCardJson) {
  if (post.cardId === null) return;
  await unlessRejected(ctx, () => updateCard(ctx, post.cardId!, post.sequence + 1, card));
  if (ctx.store.chatById(post.chatId) !== null) ctx.store.savePost({ ...post, sequence: post.sequence + 1, state: "card_settled" }, ctx.now());
}

const closeMissingCard = (ctx: FeishuContext, post: FeishuPostRecord) =>
  settlePost(ctx, post, renderTextCard({ title: "已关闭", text: "这张拍板卡已关闭。" }));

export async function settleAskCard(ctx: FeishuContext, messageId: MessageId) {
  const post = ctx.store.postOf({ kind: "message", messageId, part: 0 });
  if (post?.state !== "card_pending" || post.cardId === null) return;
  const message = ctx.ledger.getMessage(messageId);
  if (message === null) return closeMissingCard(ctx, post);
  const ask = askOf(message);
  if (ask === null) return closeMissingCard(ctx, post);
  const state = askStateOf(ctx, message);
  if (state.kind === "pending") return;
  await settlePost(ctx, post, renderAskCard(message, ask, state, attachmentViews(attachmentSlots(ctx, message))));
}

export async function postRouterAskCard(ctx: FeishuContext, message: Message) {
  const chat = routerChat(ctx);
  const pmId = pmOfConversation(ctx, message.conversationId);
  if (chat === null || pmId === null || !isActivePm(ctx, pmId)) return;
  const ask = askOf(message);
  if (ask === null) return;
  const ref: FeishuPostRef = { kind: "router_ask", messageId: message.id };
  const existing = ctx.store.postOf(ref);
  const pmChatId = liveChatOfPm(ctx, pmId)?.chatId ?? null;
  const pmName = pmNameOf(ctx, pmId);
  if (existing === null) {
    if (askStateOf(ctx, message).kind !== "pending") return;
    const slots = await prepareAttachments(ctx, message, "router");
    const card = renderRouterAskCard(message, ask, askStateOf(ctx, message), pmChatId, attachmentViews(slots), pmName);
    const posted = await postCardEntity(ctx, chat.chatId, card, `fusa-ra-${message.id}`);
    if (routerChat(ctx)?.chatId !== chat.chatId) return;
    ctx.store.savePost({ ref, chatId: chat.chatId, messageId: posted.messageId, cardId: posted.cardId, sequence: 0, state: "card_pending" }, ctx.now());
    await followUpAttachments(ctx, chat.chatId, slots, posted, "router");
    return;
  }
  if (existing.state === "card_pending" && askStateOf(ctx, message).kind !== "pending") {
    await settleRouterAskCard(ctx, message.id);
    return;
  }
  const host = { messageId: existing.messageId, cardId: existing.cardId };
  await followUpAttachments(ctx, chat.chatId, attachmentSlots(ctx, message, false, "router"), host, "router");
}

async function settleRouterAskCard(ctx: FeishuContext, messageId: MessageId) {
  const post = ctx.store.postOf({ kind: "router_ask", messageId });
  if (post?.state !== "card_pending" || post.cardId === null) return;
  const message = ctx.ledger.getMessage(messageId);
  if (message === null || askOf(message) === null) return closeMissingCard(ctx, post);
  const state = askStateOf(ctx, message);
  if (state.kind === "pending") return;
  await settlePost(ctx, post, routerAskCard(ctx, message, state, attachmentSlots(ctx, message, false, "router"))!);
}

export async function refreshPendingAskCard(ctx: FeishuContext, messageId: MessageId, scope: AttachmentScope) {
  const post = ctx.store.postOf(scope === "router" ? { kind: "router_ask", messageId } : { kind: "message", messageId, part: 0 });
  if (post?.state !== "card_pending" || post.cardId === null) return;
  const message = ctx.ledger.getMessage(messageId);
  const ask = message === null ? null : askOf(message);
  if (message === null || ask === null || askStateOf(ctx, message).kind !== "pending") return;
  const slots = attachmentSlots(ctx, message, false, scope);
  const card = scope === "router" ? routerAskCard(ctx, message, { kind: "pending" }, slots)! : renderAskCard(message, ask, { kind: "pending" }, attachmentViews(slots));
  const nextSeq = post.sequence + 1;
  await unlessRejected(ctx, () => updateCard(ctx, post.cardId!, nextSeq, card));
  if (ctx.store.chatById(post.chatId) !== null) ctx.store.savePost({ ...post, sequence: nextSeq }, ctx.now());
}

function routerItemCard(ctx: FeishuContext, item: RouterItem, slots?: readonly AttachmentSlot[]) {
  const askMessage = item.kind === "decision" && item.askMessageId !== null ? ctx.ledger.getMessage(item.askMessageId) : null;
  const meta = askMessage === null ? null : askOf(askMessage);
  const state = routerItemState(ctx, item, meta === null ? null : askMessage);
  const pmChat = liveChatOfPm(ctx, item.pmId);
  const withAsk = askMessage !== null && meta !== null ? { message: askMessage, meta } : null;
  const views = withAsk !== null ? attachmentViews(slots ?? attachmentSlots(ctx, withAsk.message, false, "router")) : [];
  return {
    askMessage,
    card: renderRouterItem(item, withAsk, state, pmChat?.chatId ?? null, views),
    settled: state.kind !== "pending" || item.kind === "report",
  };
}

export async function postRouterItem(ctx: FeishuContext, item: RouterItem) {
  const chat = ctx.store.chatOfTarget({ kind: "router" });
  if (chat === null) return;
  const ref: FeishuPostRef = { kind: "router_item", itemId: item.id };
  const post = ctx.store.postOf(ref);
  const initialAsk = post === null && item.kind === "decision" && item.askMessageId !== null ? ctx.ledger.getMessage(item.askMessageId) : null;
  const slots = initialAsk !== null && askStateOf(ctx, initialAsk).kind === "pending" ? await prepareAttachments(ctx, initialAsk, "router") : undefined;
  const { askMessage, card, settled } = routerItemCard(ctx, item, slots);
  if (post === null) {
    if (item.kind === "decision" && settled) return;
    const posted = await postCardEntity(ctx, chat.chatId, card, `fusa-r-${item.id}`);
    if (ctx.store.chatById(chat.chatId) === null) return;
    const state = item.kind === "report" ? "final" : "card_pending";
    ctx.store.savePost({ ref, chatId: chat.chatId, messageId: posted.messageId, cardId: posted.cardId, sequence: 0, state }, ctx.now());
    if (askMessage !== null && slots !== undefined) await followUpAttachments(ctx, chat.chatId, slots, posted, "router");
    return;
  }
  if (post.state !== "card_pending" || !settled) return;
  await settlePost(ctx, post, card);
}

export async function settleRouterItem(ctx: FeishuContext, itemId: number) {
  const post = ctx.store.postOf({ kind: "router_item", itemId });
  if (post?.state !== "card_pending" || post.cardId === null) return;
  const item = ctx.ledger.getRouterItem(itemId);
  if (item !== null) await postRouterItem(ctx, item);
  else await closeMissingCard(ctx, post);
}

export async function settleRouterAsk(ctx: FeishuContext, messageId: MessageId) {
  await settleRouterAskCard(ctx, messageId);
  const row = ctx.db.get<{ id: number }>("SELECT id FROM router_items WHERE ask_message_id = ? ORDER BY id DESC LIMIT 1", messageId);
  if (row !== undefined) await settleRouterItem(ctx, row.id);
}

export async function settleRouterCards(ctx: FeishuContext, chat: FeishuChatBinding) {
  if (ctx.store.chatOfTarget({ kind: "router" })?.chatId !== chat.chatId) return;
  for (const post of ctx.store.pendingCards(null)) {
    if (post.ref.kind === "router_item") await settleRouterItem(ctx, post.ref.itemId);
    else if (post.ref.kind === "router_ask") await settleRouterAskCard(ctx, post.ref.messageId);
  }
}
