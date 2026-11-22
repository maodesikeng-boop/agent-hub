import { randomUUID } from "node:crypto";
import type { ConversationId, Message } from "../../shared/domain.ts";
import { describeFailure } from "../../shared/errors.ts";
import type { FeishuCardId, FeishuChatId } from "../../shared/feishu.ts";
import { isAgentVendor } from "../../shared/vendors.ts";
import { api, handleError, postCardEntity, sendMessage, updateCard } from "./api.ts";
import { attachmentViews, followUpAttachments, prepareAttachments } from "./attachments.ts";
import { renderReplyCard, unrenderableReplyText, type FeishuAttachmentView } from "./cards.ts";
import type { FeishuContext, HostCard, StreamSlot } from "./context.ts";
import { enqueue } from "./lanes.ts";
import { splitFeishuMarkdown } from "./outbound.ts";
import { chatOfConversation, devicePostUuid } from "./projection.ts";
import type { FeishuPostRef } from "./store.ts";
import { stepFeishuStream, type FeishuStreamEffect, type FeishuStreamEvent, type FeishuTurnFailure } from "./stream.ts";
import { FeishuApiError, isFeishuRejection } from "./transport.ts";

type FinalizeEffect = Extract<FeishuStreamEffect, { kind: "finalize" }>;

const NO_REPLY_TEXT = "（这一轮没有文字回复）";

const stillBound = (ctx: FeishuContext, conversationId: ConversationId, chatId: FeishuChatId) =>
  chatOfConversation(ctx, conversationId)?.chatId === chatId;

export function segmentDone(ctx: FeishuContext, message: Message): FeishuStreamEvent {
  return { kind: "segment_done", messageId: message.id, text: message.text, turnActive: ctx.activeTurns.has(message.conversationId) };
}

export function turnFailureOf(ctx: FeishuContext, message: Message): FeishuTurnFailure {
  const vendor = message.sessionId === null ? undefined : ctx.db.get<{ vendor: string }>("SELECT vendor FROM agent_sessions WHERE id = ?", message.sessionId)?.vendor;
  const reason = describeFailure(message.failureReason ?? "", { unknown: "raw", ...(vendor !== undefined && isAgentVendor(vendor) ? { vendor } : {}) }).text;
  return { key: `${message.id}-${message.updatedAt}`, note: `没回成：${reason}` };
}

export function dropStream(ctx: FeishuContext, id: ConversationId, slot: StreamSlot) {
  if (slot.timer !== null) clearTimeout(slot.timer);
  if (ctx.streams.get(id) === slot) ctx.streams.delete(id);
}

async function closeReplyCard(
  ctx: FeishuContext,
  conversationId: ConversationId,
  cardId: FeishuCardId,
  sequence: number,
  text: string,
  uuid?: string,
  attachments: readonly FeishuAttachmentView[] = [],
): Promise<number> {
  try {
    await updateCard(ctx, cardId, sequence, renderReplyCard({ conversationId, text, streaming: false, withStop: false, attachments }), uuid);
    return sequence;
  } catch (error) {
    if (!(error instanceof FeishuApiError) || !isFeishuRejection(error)) throw error;
    handleError(ctx, error);
    const fallback = renderReplyCard({ conversationId, text: unrenderableReplyText(error.code), streaming: false, withStop: false, attachments });
    await updateCard(ctx, cardId, sequence + 1, fallback);
    return sequence + 1;
  }
}

async function sendReplyCard(
  ctx: FeishuContext,
  chatId: FeishuChatId,
  conversationId: ConversationId,
  text: string,
  uuid: string,
  attachments: readonly FeishuAttachmentView[] = [],
  entity = false,
): Promise<HostCard> {
  const send = async (body: string, key: string): Promise<HostCard> => {
    const card = renderReplyCard({ conversationId, text: body, streaming: false, withStop: false, attachments });
    if (entity) return postCardEntity(ctx, chatId, card, key);
    return { messageId: (await sendMessage(ctx, { chatId }, "interactive", card, key)).messageId, cardId: null };
  };
  try {
    return await send(text, uuid);
  } catch (error) {
    if (!(error instanceof FeishuApiError) || !isFeishuRejection(error)) throw error;
    handleError(ctx, error);
    return send(unrenderableReplyText(error.code), `${uuid}-x`);
  }
}

interface SegmentPart {
  chatId: FeishuChatId;
  conversationId: ConversationId;
  effect: FinalizeEffect;
  part: number;
  chunk: string;
  last: boolean;
  attachments: readonly FeishuAttachmentView[];
  hasFiles: boolean;
}

async function finalizePart(ctx: FeishuContext, p: SegmentPart, posted: StreamSlot["posted"]): Promise<HostCard | null> {
  const { chatId, conversationId, effect, part } = p;
  const ref: FeishuPostRef = { kind: "message", messageId: effect.messageId, part };
  let post = ctx.store.postOf(ref);
  if (post?.state === "final") return { messageId: post.messageId, cardId: post.cardId };
  if (part === 0 && posted !== null && post === null) {
    ctx.store.savePost({ ref, chatId, messageId: posted.messageId, cardId: posted.cardId, sequence: effect.sequence, state: "streaming" }, ctx.now());
    post = ctx.store.postOf(ref);
  } else if (post?.cardId) {
    post = { ...post, sequence: post.sequence + 1 };
    ctx.store.savePost(post, ctx.now());
  }
  if (post?.cardId) {
    let sequence = post.sequence;
    try {
      sequence = await closeReplyCard(ctx, conversationId, post.cardId, post.sequence, p.chunk, `fusa-final-${effect.messageId}-${post.sequence}`, p.attachments);
    } catch (error) {
      if (!isFeishuRejection(error)) throw error;
      handleError(ctx, error);
    }
    if (!stillBound(ctx, conversationId, chatId)) return null;
    ctx.store.savePost({ ...post, sequence, state: "final" }, ctx.now());
    return { messageId: post.messageId, cardId: post.cardId };
  }
  const host = await sendReplyCard(ctx, chatId, conversationId, p.chunk, `fusa-m-${effect.messageId}-${part}`, p.attachments, p.last && p.hasFiles);
  if (!stillBound(ctx, conversationId, chatId)) return null;
  ctx.store.savePost({ ref, chatId, messageId: host.messageId, cardId: host.cardId, sequence: 0, state: "final" }, ctx.now());
  return host;
}

export async function finalizeSegment(ctx: FeishuContext, chatId: FeishuChatId, conversationId: ConversationId, effect: FinalizeEffect, posted: StreamSlot["posted"] = null) {
  const message = ctx.ledger.getMessage(effect.messageId);
  const slots = message === null ? [] : await prepareAttachments(ctx, message);
  const views = attachmentViews(slots);
  const chunks = splitFeishuMarkdown(effect.text);
  if (chunks.length === 0 && slots.length > 0) chunks.push("");
  let host: HostCard | null = null;
  for (const [part, chunk] of chunks.entries()) {
    if (!stillBound(ctx, conversationId, chatId)) return;
    const last = part === chunks.length - 1;
    const segment = { chatId, conversationId, effect, part, chunk, last, attachments: last ? views : [], hasFiles: slots.length > 0 };
    host = await finalizePart(ctx, segment, posted);
    if (host === null) return;
  }
  if (host !== null) await followUpAttachments(ctx, chatId, slots, host);
  ctx.store.advanceWatermark(chatId, { messageId: effect.messageId }, ctx.now());
}

async function discardStatusCard(ctx: FeishuContext, id: ConversationId, effect: Extract<FeishuStreamEffect, { kind: "discard" }>) {
  try {
    await api(ctx, "message.delete", { message_id: effect.messageId });
  } catch (error) {
    if (!isFeishuRejection(error)) throw error;
    handleError(ctx, error);
    await closeReplyCard(ctx, id, effect.cardId, effect.sequence, NO_REPLY_TEXT);
  }
}

function scheduleTick(ctx: FeishuContext, id: ConversationId, slot: StreamSlot, at: number) {
  if (slot.timerAt !== null && slot.timerAt <= at) return;
  if (slot.timer !== null) clearTimeout(slot.timer);
  slot.timerAt = at;
  slot.timer = setTimeout(() => {
    slot.timer = null;
    slot.timerAt = null;
    if (ctx.streams.get(id) === slot) {
      enqueue(ctx, slot.chatId, () => feedStream(ctx, id, { kind: "tick" }, slot.chatId, slot), { key: `tick:${id}`, preview: true });
    }
  }, Math.max(0, at - ctx.now()));
  slot.timer.unref?.();
}

async function openStreamCard(ctx: FeishuContext, id: ConversationId, chatId: FeishuChatId, slot: StreamSlot, text: string) {
  const card = renderReplyCard({ conversationId: id, text, streaming: true, withStop: true });
  let opened: Awaited<ReturnType<typeof postCardEntity>>;
  try {
    opened = await postCardEntity(ctx, chatId, card, `fusa-s-${randomUUID()}`);
  } catch (error) {
    handleError(ctx, error);
    await feedStream(ctx, id, { kind: "open_failed" }, chatId, slot);
    return;
  }
  slot.posted = { ...opened, text };
  await feedStream(ctx, id, { kind: "opened", ...opened, sequence: 0 }, chatId, slot);
}

async function runStreamEffect(ctx: FeishuContext, id: ConversationId, chatId: FeishuChatId, slot: StreamSlot, effect: FeishuStreamEffect, posted: StreamSlot["posted"]) {
  switch (effect.kind) {
    case "open":
      return openStreamCard(ctx, id, chatId, slot, effect.text);
    case "push":
      await api(ctx, "card.element.content", { card_id: effect.cardId, element_id: "reply", content: effect.text, sequence: effect.sequence, uuid: randomUUID() });
      if (slot.posted !== null) slot.posted.text = effect.text;
      return;
    case "renew":
      await api(ctx, "card.settings", { card_id: effect.cardId, settings: JSON.stringify({ config: { streaming_mode: true } }), sequence: effect.sequence, uuid: randomUUID() });
      return;
    case "finalize":
      return finalizeSegment(ctx, chatId, id, effect, effect.cardId === null ? null : posted);
    case "abandon":
      await closeReplyCard(ctx, id, effect.cardId, effect.sequence, effect.text);
      return;
    case "discard":
      return discardStatusCard(ctx, id, effect);
    case "notice":
      await sendReplyCard(ctx, chatId, id, effect.failure.note, devicePostUuid(ctx, "fail", effect.failure.key));
      return;
    case "schedule_tick":
      scheduleTick(ctx, id, slot, effect.at);
      return;
  }
}

function slotFor(ctx: FeishuContext, id: ConversationId, event: FeishuStreamEvent, chatId: FeishuChatId, expected?: StreamSlot): StreamSlot | null {
  const slot = ctx.streams.get(id);
  if (expected !== undefined && slot !== expected) return null;
  if (!stillBound(ctx, id, chatId)) {
    if (slot?.chatId === chatId) dropStream(ctx, id, slot);
    return null;
  }
  if (slot?.chatId === chatId) return slot;
  if (slot !== undefined) dropStream(ctx, id, slot);
  if (event.kind !== "text" && event.kind !== "working" && event.kind !== "segment_done" && event.kind !== "turn_failed") return null;
  const fresh: StreamSlot = { state: { phase: "idle" }, chatId, timer: null, timerAt: null, posted: null };
  ctx.streams.set(id, fresh);
  return fresh;
}

export async function feedStream(ctx: FeishuContext, id: ConversationId, event: FeishuStreamEvent, chatId: FeishuChatId, expected?: StreamSlot) {
  const current = slotFor(ctx, id, event, chatId, expected);
  if (current === null) return;
  const step = stepFeishuStream(current.state, event, { conversationId: id, chatId }, ctx.now(), ctx.budget);
  current.state = step.state;
  const posted = current.posted;
  if (current.state.phase === "idle") dropStream(ctx, id, current);
  if (current.state.phase === "idle" || current.state.phase === "quiet" || current.state.phase === "failed") {
    if (current.timer !== null) clearTimeout(current.timer);
    current.timer = current.timerAt = null;
    current.posted = null;
  }
  for (const effect of step.effects) await runStreamEffect(ctx, id, chatId, current, effect, posted);
}
