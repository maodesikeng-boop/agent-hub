import { lookKey, type SlimeLook } from "../../shared/slimes.ts";
import type { PmId } from "../../shared/domain.ts";
import {
  feishuDisplayName,
  parseFeishuChatId,
  parseFeishuOpenId,
  type FeishuChatId,
  type FeishuImageKey,
  type FeishuMessageId,
  type FeishuOpenId,
} from "../../shared/feishu.ts";
import { FEISHU_PAGE_SIZE } from "../../shared/limits.ts";
import { api, handleError, isChatGone, sendMessage } from "./api.ts";
import { renderFeishuAvatar, type FeishuAvatarImage } from "./avatars.ts";
import { desiredFeishuChats, FEISHU_CHAT_MARKER_PATTERN, feishuChatCreateUuid, planFeishuChatSync, type FeishuChatOp } from "./chats.ts";
import { ackAllRouterEvents, broadcastPeerApp, notifyLocalChats } from "./connection.ts";
import { isCenter, isReady, owner, type FeishuContext } from "./context.ts";
import type { FeishuMember } from "./directory.ts";
import { releaseInboundGate } from "./inbound-catchup.ts";
import { requestControl } from "./lanes.ts";
import { conversationOfPm, latestMessageId } from "./projection.ts";
import { dropStream } from "./stream-cards.ts";
import { FeishuAuthError, feishuStringField, isFeishuRejection, type FeishuMethodArgs } from "./transport.ts";

type ChatSpec = Extract<FeishuChatOp, { kind: "create" }>["spec"];

export async function fetchMembers(ctx: FeishuContext, chatId: FeishuChatId): Promise<FeishuMember[]> {
  const members: FeishuMember[] = [];
  let pageToken: string | undefined;
  do {
    const data = await api(ctx, "chat.members", { chat_id: chatId, page_size: FEISHU_PAGE_SIZE, ...(pageToken ? { page_token: pageToken } : {}) });
    for (const item of (data.items as { member_id?: string; name?: string }[] | undefined) ?? []) {
      const openId = parseFeishuOpenId(item.member_id);
      if (openId !== null) members.push({ openId, name: item.name ?? "" });
    }
    pageToken = data.has_more === true ? (feishuStringField(data, "page_token") ?? undefined) : undefined;
  } while (pageToken !== undefined);
  const o = owner(ctx);
  const me = o === null ? undefined : members.find((m) => m.openId === o);
  if (me !== undefined && me.name !== "") ctx.app.ownerName = feishuDisplayName(me.name);
  return members;
}

async function uploadAvatar(ctx: FeishuContext, look: SlimeLook): Promise<FeishuImageKey> {
  const transport = ctx.link.transport;
  if (transport === null) throw new Error("飞书没连上");
  const { png } = await renderFeishuAvatar(look);
  const { imageKey } = await transport.uploadImage({ imageType: "avatar", data: png });
  return imageKey as FeishuImageKey;
}

async function markedChats(ctx: FeishuContext): Promise<Map<FeishuChatId, string>> {
  const marked = new Map<FeishuChatId, string>();
  let pageToken: string | undefined;
  do {
    const data = await api(ctx, "chat.list", { page_size: FEISHU_PAGE_SIZE, ...(pageToken ? { page_token: pageToken } : {}) });
    for (const item of (data.items as { chat_id?: string; description?: string }[] | undefined) ?? []) {
      const chatId = parseFeishuChatId(item.chat_id);
      const mark = FEISHU_CHAT_MARKER_PATTERN.exec(item.description ?? "")?.[0];
      if (chatId !== null && mark !== undefined) marked.set(chatId, mark);
    }
    pageToken = data.has_more === true ? (feishuStringField(data, "page_token") ?? undefined) : undefined;
  } while (pageToken !== undefined);
  return marked;
}

function clearChatRuntime(ctx: FeishuContext, chatId: FeishuChatId) {
  ctx.directory.forget(chatId);
  ctx.contexts.clear(chatId);
  ctx.sendTimes.delete(chatId);
  ctx.catchUp.cursorHold.delete(chatId);
  releaseInboundGate(ctx, chatId);
  for (const [id, slot] of ctx.streams) if (slot.chatId === chatId) dropStream(ctx, id, slot);
}

export async function deleteChat(ctx: FeishuContext, chatId: FeishuChatId) {
  try {
    await api(ctx, "chat.delete", { chat_id: chatId });
  } catch (error) {
    if (!isChatGone(error)) throw error;
  }
  clearChatRuntime(ctx, chatId);
}

async function updateChat(ctx: FeishuContext, args: FeishuMethodArgs["chat.update"]): Promise<boolean> {
  try {
    await api(ctx, "chat.update", args);
  } catch (error) {
    if (isChatGone(error)) return false;
    if (!isFeishuRejection(error)) throw error;
    handleError(ctx, error);
  }
  return true;
}

// Feishu dedupes chat.create by uuid for hours, so each rebuild needs a strictly newer generation.
function dissolvedAt(ctx: FeishuContext, pmId: PmId | null) {
  return Math.max(ctx.now(), (pmId === null ? 0 : (ctx.lastGeneration.get(pmId) ?? 0)) + 1);
}

function bindPmChat(ctx: FeishuContext, chatId: FeishuChatId, spec: ChatSpec) {
  const t = ctx.now();
  ctx.store.upsertChat({ chatId, target: { kind: "pm", pmId: spec.pmId }, name: spec.name, label: spec.label }, t);
  ctx.store.setChatAvatar(chatId, spec.look, t);
  ctx.inboundSync.seedLocalCursor(chatId, { lastInboundAt: t, lastMessageId: null });
  const conversationId = conversationOfPm(ctx, spec.pmId);
  ctx.store.advanceWatermark(chatId, { messageId: (conversationId === null ? null : latestMessageId(ctx, conversationId)) ?? 0 }, t);
}

export function bindRouterChat(ctx: FeishuContext, chatId: FeishuChatId, t = ctx.now(), cursor: { lastInboundAt: number; lastMessageId: FeishuMessageId | null } | null = { lastInboundAt: t, lastMessageId: null }) {
  ctx.store.upsertChat({ chatId, target: { kind: "router" }, name: "总助", label: "总助" }, t);
  if (cursor !== null) ctx.inboundSync.seedLocalCursor(chatId, cursor);
}

async function createPmChat(ctx: FeishuContext, op: Extract<FeishuChatOp, { kind: "create" }>, appId: string, ownerId: FeishuOpenId, avatar: string) {
  const data = await api(ctx, "chat.create", {
    uuid: feishuChatCreateUuid(appId, ctx.options.device.id, op.spec.pmId, op.generation),
    name: op.spec.name,
    description: op.spec.description,
    avatar,
    owner_id: ownerId,
    user_id_list: [ownerId],
    chat_type: "private",
    group_message_type: "chat",
    set_bot_manager: true,
    edit_permission: "only_owner",
  });
  const chatId = parseFeishuChatId(feishuStringField(data, "chat_id"));
  if (chatId === null) throw new Error("飞书建群没回群编号");
  ctx.lastGeneration.set(op.spec.pmId, op.generation);
  bindPmChat(ctx, chatId, op.spec);
}

async function applyChatOp(ctx: FeishuContext, op: FeishuChatOp, appId: string, ownerId: FeishuOpenId, avatarOf: (look: SlimeLook) => Promise<FeishuAvatarImage>): Promise<boolean> {
  const imageKeyOf = async (look: SlimeLook) => ctx.avatars.imageKeyOf(look, (await avatarOf(look)).sha256, (l) => uploadAvatar(ctx, l));
  switch (op.kind) {
    case "create":
      await createPmChat(ctx, op, appId, ownerId, await imageKeyOf(op.spec.look));
      return true;
    case "adopt": {
      const avatar = await imageKeyOf(op.spec.look);
      if (!(await updateChat(ctx, { chat_id: op.chatId, name: op.spec.name, avatar }))) return false;
      bindPmChat(ctx, op.chatId, op.spec);
      return true;
    }
    case "rename":
      if (await updateChat(ctx, { chat_id: op.chatId, name: op.name })) ctx.store.renameChat(op.chatId, op.name, op.label, ctx.now());
      else applyChatGone(ctx, op.chatId);
      return true;
    case "set_avatar":
      if (await updateChat(ctx, { chat_id: op.chatId, avatar: await imageKeyOf(op.look) })) ctx.store.setChatAvatar(op.chatId, op.look, ctx.now());
      else applyChatGone(ctx, op.chatId);
      return true;
    case "dissolve": {
      const chat = ctx.store.chatById(op.chatId);
      await deleteChat(ctx, op.chatId);
      ctx.store.setChatArchived(op.chatId, dissolvedAt(ctx, chat?.target.kind === "pm" ? chat.target.pmId : null), ctx.now());
      return true;
    }
    case "retire":
      if (!op.dissolved) await deleteChat(ctx, op.chatId);
      ctx.store.removeChat(op.chatId);
      return true;
  }
}

async function resetStaleAvatars(ctx: FeishuContext, looks: Iterable<SlimeLook>) {
  for (const look of looks) {
    if (ctx.store.avatarKey(look, (await renderFeishuAvatar(look)).sha256) === null) ctx.store.clearChatAvatars(look, ctx.now());
  }
}

export async function syncChats(ctx: FeishuContext): Promise<boolean> {
  const app = ctx.store.app();
  if (app === null || app.ownerOpenId === null) return true;
  if (ctx.link.transport === null || !isReady(ctx)) return false;
  const desired = desiredFeishuChats(ctx.ledger.snapshot().pms, ctx.options.device);
  await resetStaleAvatars(ctx, new Map(desired.filter((d) => !d.archived).map((d) => [lookKey(d.look), d.look] as const)).values());
  const bindings = ctx.store.chats().filter((c) => c.target.kind === "pm");
  const bound = new Set(bindings.flatMap((b) => (b.target.kind === "pm" && b.target.pmId !== null ? [b.target.pmId] : [])));
  const needsLookup = desired.some((d) => !d.archived && !bound.has(d.pmId));
  const marked = needsLookup ? await markedChats(ctx) : new Map<FeishuChatId, string>();
  let settled = true;
  for (const op of planFeishuChatSync(desired, bindings, marked, ctx.options.device.id)) {
    try {
      if (!(await applyChatOp(ctx, op, app.appId, app.ownerOpenId, renderFeishuAvatar))) settled = false;
    } catch (error) {
      if (error instanceof FeishuAuthError) throw error;
      handleError(ctx, error);
      if (!isFeishuRejection(error)) settled = false;
    }
  }
  notifyLocalChats(ctx);
  return settled;
}

export function adoptRouterChat(ctx: FeishuContext, chatId: FeishuChatId) {
  bindRouterChat(ctx, chatId, ctx.now(), null);
  ackAllRouterEvents(ctx);
}

// Any device binds the shared chat it learned from a peer; only the center opens it with a greeting.
export async function ensureRouterChat(ctx: FeishuContext) {
  const o = owner(ctx);
  if (o === null || ctx.store.chatOfTarget({ kind: "router" }) !== null) return;
  if (ctx.app.syncedRouterChatId !== null) {
    adoptRouterChat(ctx, ctx.app.syncedRouterChatId);
    return;
  }
  if (!isCenter(ctx)) return;
  const hello = "已接上飞书。在这里和总助说话；每个项目经理有自己的项目群。";
  const sent = await sendMessage(ctx, { openId: o }, "text", { text: hello }, `fusa-hello-${ctx.store.app()!.appId}`);
  if (sent.chatId !== null) {
    bindRouterChat(ctx, sent.chatId);
    broadcastPeerApp(ctx);
  }
}

export function applyChatGone(ctx: FeishuContext, chatId: FeishuChatId) {
  clearChatRuntime(ctx, chatId);
  const chat = ctx.store.chatById(chatId);
  if (chat === null || chat.archivedAt !== null) return;
  if (chat.target.kind === "router") {
    ctx.store.removeChat(chatId);
    return;
  }
  ctx.store.setChatArchived(chatId, dissolvedAt(ctx, chat.target.pmId), ctx.now());
  requestControl(ctx, "sync");
}
