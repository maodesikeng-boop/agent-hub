import { isDeviceId, type DeviceId } from "../../shared/api.ts";
import { isLedgerWakeup } from "../../shared/attachments.ts";
import type { ConversationId, MessageId, PmId } from "../../shared/domain.ts";
import type { FeishuChatTarget } from "../../shared/feishu.ts";
import { isCenter, type FeishuContext } from "./context.ts";
import type { FeishuProjectionContext } from "./outbound.ts";
import type { FeishuChatBinding } from "./store.ts";

const AWAITING_REPLY: ReadonlySet<string> = new Set(["queued", "delivered", "processing"]);

export const pmOfConversation = (ctx: FeishuContext, conversationId: ConversationId): PmId | null =>
  ctx.db.get<{ pm_id: number | null }>("SELECT pm_id FROM conversations WHERE id = ? AND kind = 'pm'", conversationId)?.pm_id ?? null;

export const pmNameOf = (ctx: FeishuContext, pmId: PmId | null): string | undefined =>
  pmId === null ? undefined : ctx.db.get<{ name: string }>("SELECT name FROM pms WHERE id = ?", pmId)?.name;

export const conversationOfPm = (ctx: FeishuContext, pmId: PmId): ConversationId | null =>
  ctx.db.get<{ id: number }>("SELECT id FROM conversations WHERE kind = 'pm' AND pm_id = ? ORDER BY id LIMIT 1", pmId)?.id ?? null;

export const latestMessageId = (ctx: FeishuContext, conversationId: ConversationId): MessageId | null =>
  ctx.db.get<{ id: number | null }>("SELECT max(id) AS id FROM messages WHERE conversation_id = ?", conversationId)?.id ?? null;

export const isActivePm = (ctx: FeishuContext, pmId: PmId) =>
  ctx.db.get("SELECT 1 FROM pms WHERE id = ? AND NOT EXISTS (SELECT 1 FROM pm_archives WHERE pm_id = ?)", pmId, pmId) !== undefined;

export function activeTarget(ctx: FeishuContext, chat: FeishuChatBinding | null): FeishuChatTarget | null {
  if (chat === null || chat.archivedAt !== null) return null;
  if (chat.target.kind === "router") return chat.target;
  const pmId = chat.target.pmId;
  return pmId !== null && isActivePm(ctx, pmId) ? { kind: "pm", pmId } : null;
}

export function liveChatOfPm(ctx: FeishuContext, pmId: PmId): FeishuChatBinding | null {
  const chat = ctx.store.chatOfTarget({ kind: "pm", pmId });
  return activeTarget(ctx, chat) === null ? null : chat;
}

export function chatOfConversation(ctx: FeishuContext, conversationId: ConversationId): FeishuChatBinding | null {
  const pmId = pmOfConversation(ctx, conversationId);
  return pmId === null ? null : liveChatOfPm(ctx, pmId);
}

// Every device posts its own ledger's router cards to the shared chat; ledgers are not mirrored to the center.
export const routerChat = (ctx: FeishuContext): FeishuChatBinding | null =>
  ctx.store.app()?.ownerOpenId ? ctx.store.chatOfTarget({ kind: "router" }) : null;

export const centerRouterChat = (ctx: FeishuContext): FeishuChatBinding | null => (isCenter(ctx) ? routerChat(ctx) : null);

export const selfDeviceId = (ctx: FeishuContext): DeviceId | undefined => (isDeviceId(ctx.options.device.id) ? ctx.options.device.id : undefined);

// Feishu dedupes sends by uuid across the app, and every device numbers its ledger rows from 1.
export const devicePostUuid = (ctx: FeishuContext, kind: string, key: number | string) =>
  `fusa-${kind}-${ctx.options.device.id.replaceAll("-", "").slice(0, 12)}-${key}`;

function awaitingUser(ctx: FeishuContext, conversationId: ConversationId): boolean {
  // `sender != 'agent'` lets SQLite use the messages_conversation_non_agent partial index.
  const row = ctx.db.get<{ meta: string | null; status: string | null }>(
    "SELECT meta, status FROM messages WHERE conversation_id = ? AND sender != 'agent' AND sender = 'user' ORDER BY id DESC LIMIT 1",
    conversationId,
  );
  if (row === undefined || !AWAITING_REPLY.has(row.status ?? "")) return false;
  return !isLedgerWakeup({ sender: "user", meta: row.meta === null ? null : (JSON.parse(row.meta) as Record<string, unknown>) });
}

export const projectionOf = (ctx: FeishuContext): FeishuProjectionContext => ({
  chatOfConversation: (conversationId) => chatOfConversation(ctx, conversationId),
  routerChat: () => routerChat(ctx),
  pmOfConversation: (conversationId) => pmOfConversation(ctx, conversationId),
  awaitingUser: (conversationId) => awaitingUser(ctx, conversationId),
});
