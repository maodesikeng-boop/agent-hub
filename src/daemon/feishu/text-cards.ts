import type { Message } from "../../shared/domain.ts";
import type { FeishuChatId } from "../../shared/feishu.ts";
import type { RouterCommandRecord } from "../../shared/router.ts";
import { postCardEntity, sendMessage } from "./api.ts";
import { attachmentViews, followUpAttachments, prepareAttachments } from "./attachments.ts";
import { renderTextCard } from "./cards.ts";
import type { FeishuContext, HostCard } from "./context.ts";
import { splitFeishuMarkdown } from "./outbound.ts";
import { activeTarget } from "./projection.ts";
import type { FeishuPostRef } from "./store.ts";

export const FEISHU_CLIENT_PREFIX = "feishu:";

export const MIRROR_TITLE = "网页上说";

export const mirrorText = (message: Message) => (message.text.trim() === "" ? "（发了文件）" : message.text);

const chatLive = (ctx: FeishuContext, chatId: FeishuChatId) => activeTarget(ctx, ctx.store.chatById(chatId)) !== null;

function routerReplyText(command: RouterCommandRecord): string {
  if (command.status === "failed") return `没办成：${command.error ?? "未知原因"}`;
  const reply = command.plan?.reply ?? "";
  if (reply !== "") return reply;
  const targets = (command.dispatched ?? []).map((d) => `${d.pmName ?? `项目经理 ${d.pmId}`}${d.ok ? "" : `（没送到：${d.error ?? "未知原因"}）`}`);
  return targets.length > 0 ? `已交给：${targets.join("、")}` : "好的。";
}

async function postTextChunks(ctx: FeishuContext, chatId: FeishuChatId, title: string, text: string, key: string, refForPart: (part: number) => FeishuPostRef) {
  for (const [part, chunk] of splitFeishuMarkdown(text).entries()) {
    if (!chatLive(ctx, chatId)) return;
    const ref = refForPart(part);
    if (ctx.store.postOf(ref) !== null) continue;
    const { messageId } = await sendMessage(ctx, { chatId }, "interactive", renderTextCard({ title, text: chunk }), `${key}-${part}`);
    if (!chatLive(ctx, chatId)) return;
    ctx.store.savePost({ ref, chatId, messageId, cardId: null, sequence: 0, state: "final" }, ctx.now());
  }
}

export async function postRouterCommand(ctx: FeishuContext, command: RouterCommandRecord) {
  const chat = ctx.store.chatOfTarget({ kind: "router" });
  if (chat === null) return;
  const fromFeishu = command.clientId.startsWith(FEISHU_CLIENT_PREFIX);
  const text = fromFeishu ? routerReplyText(command) : `**网页上说**：${command.inputText}\n\n${routerReplyText(command)}`;
  await postTextChunks(ctx, chat.chatId, "总助", text, `fusa-c-${command.id}`, (part) => ({ kind: "router_command", commandId: command.id, part }));
}

export async function mirrorUser(ctx: FeishuContext, chatId: FeishuChatId, message: Message) {
  const slots = await prepareAttachments(ctx, message);
  const chunks = splitFeishuMarkdown(mirrorText(message));
  let host: HostCard | null = null;
  for (const [part, chunk] of chunks.entries()) {
    if (!chatLive(ctx, chatId)) return;
    const ref: FeishuPostRef = { kind: "message", messageId: message.id, part };
    const existing = ctx.store.postOf(ref);
    if (existing !== null) {
      host = { messageId: existing.messageId, cardId: existing.cardId };
      continue;
    }
    const last = part === chunks.length - 1;
    const card = renderTextCard({ title: MIRROR_TITLE, text: chunk, template: "grey", attachments: last ? attachmentViews(slots) : [] });
    const uuid = `fusa-u-${message.id}-${part}`;
    host = slots.length > 0 && last
      ? await postCardEntity(ctx, chatId, card, uuid)
      : { messageId: (await sendMessage(ctx, { chatId }, "interactive", card, uuid)).messageId, cardId: null };
    if (!chatLive(ctx, chatId)) return;
    ctx.store.savePost({ ref, chatId, messageId: host.messageId, cardId: host.cardId, sequence: 0, state: "final" }, ctx.now());
  }
  if (host !== null) await followUpAttachments(ctx, chatId, slots, host);
  ctx.store.advanceWatermark(chatId, { messageId: message.id }, ctx.now());
}
