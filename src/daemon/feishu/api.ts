import { randomUUID } from "node:crypto";
import {
  parseFeishuCardId,
  parseFeishuChatId,
  parseFeishuMessageId,
  type FeishuCardId,
  type FeishuChatId,
  type FeishuMessageId,
  type FeishuOpenId,
} from "../../shared/feishu.ts";
import { FEISHU_CARD_MAX_BYTES, FEISHU_CHAT_SENDS_PER_SECOND } from "../../shared/limits.ts";
import type { FeishuCardJson } from "./cards.ts";
import { syncTransport } from "./connection.ts";
import { errorText, type FeishuContext } from "./context.ts";
import { FeishuSetupError } from "./setup.ts";
import {
  FEISHU_CARD_TOO_LARGE_CODE,
  FeishuApiError,
  FeishuAuthError,
  feishuDataOf,
  feishuStringField,
  isFeishuRejection,
  type FeishuMethod,
  type FeishuMethodArgs,
} from "./transport.ts";

type FeishuRecipient = { chatId: FeishuChatId } | { openId: FeishuOpenId };

const CHAT_GONE_CODES = new Set([232011, 232006, 232010]);

const isCardJson = (value: unknown): value is FeishuCardJson =>
  typeof value === "object" && value !== null && "schema" in value && value.schema === "2.0";

export const isChatGone = (error: unknown) => error instanceof FeishuApiError && CHAT_GONE_CODES.has(error.code);

function feishuErrorText(error: unknown): string {
  if (error instanceof FeishuSetupError) return error.message;
  if (error instanceof FeishuAuthError) return `飞书凭证失效（错误码 ${error.code}），请重新扫码或重填 App Secret`;
  if (error instanceof FeishuApiError) return `飞书拒绝了一次请求（错误码 ${error.code}），详情已记进日志`;
  return "连飞书时出了意外的错，详情已记进日志";
}

export function handleError(ctx: FeishuContext, error: unknown) {
  if (error instanceof FeishuAuthError) {
    ctx.link.authFailed = true;
    ctx.link.wsUp = false;
    ctx.options.lease?.refresh();
    void syncTransport(ctx);
  }
  ctx.link.lastError = feishuErrorText(error);
  ctx.log(`飞书：${errorText(error)}`);
}

export async function unlessRejected(ctx: FeishuContext, run: () => Promise<void>) {
  try {
    await run();
  } catch (error) {
    if (!isFeishuRejection(error)) throw error;
    handleError(ctx, error);
  }
}

export async function api<M extends FeishuMethod>(ctx: FeishuContext, method: M, args: FeishuMethodArgs[M]): Promise<Record<string, unknown>> {
  const transport = ctx.link.transport;
  if (transport === null) throw new Error("飞书没连上");
  return feishuDataOf(method, await transport.call(method, args));
}

// Bots in one Feishu chat share 5 QPS.
async function waitSendSlot(ctx: FeishuContext, chatId: string) {
  for (;;) {
    const current = ctx.now();
    const times = (ctx.sendTimes.get(chatId) ?? []).filter((t) => current - t < 1000);
    const oldest = times[0];
    if (times.length < FEISHU_CHAT_SENDS_PER_SECOND || oldest === undefined) {
      ctx.sendTimes.set(chatId, [...times, current]);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, oldest + 1000 - current));
  }
}

function serializeCard(card: FeishuCardJson) {
  const json = JSON.stringify(card);
  if (Buffer.byteLength(json) > FEISHU_CARD_MAX_BYTES) throw new FeishuApiError("card", FEISHU_CARD_TOO_LARGE_CODE, "飞书卡片超过体积上限");
  return json;
}

export async function sendMessage(
  ctx: FeishuContext,
  to: FeishuRecipient,
  msgType: FeishuMethodArgs["message.create"]["msg_type"],
  content: unknown,
  uuid: string,
): Promise<{ messageId: FeishuMessageId; chatId: FeishuChatId | null }> {
  const receive = "chatId" in to ? to.chatId : to.openId;
  await waitSendSlot(ctx, receive);
  const data = await api(ctx, "message.create", {
    receive_id_type: "chatId" in to ? "chat_id" : "open_id",
    receive_id: receive,
    msg_type: msgType,
    content: msgType === "interactive" && isCardJson(content) ? serializeCard(content) : JSON.stringify(content),
    uuid: uuid.slice(0, 50),
  });
  const messageId = parseFeishuMessageId(feishuStringField(data, "message_id"));
  if (messageId === null) throw new Error("飞书发消息没回消息编号");
  return { messageId, chatId: parseFeishuChatId(feishuStringField(data, "chat_id")) };
}

export async function postCardEntity(ctx: FeishuContext, chatId: FeishuChatId, card: FeishuCardJson, uuid: string) {
  const data = await api(ctx, "card.create", { type: "card_json", data: serializeCard(card) });
  const cardId = parseFeishuCardId(feishuStringField(data, "card_id"));
  if (cardId === null) throw new Error("飞书建卡片没回卡片编号");
  const { messageId } = await sendMessage(ctx, { chatId }, "interactive", { type: "card", data: { card_id: cardId } }, uuid);
  return { cardId, messageId };
}

export async function updateCard(ctx: FeishuContext, cardId: FeishuCardId, sequence: number, card: FeishuCardJson, uuid: string = randomUUID()) {
  await api(ctx, "card.update", { card_id: cardId, card: { type: "card_json", data: serializeCard(card) }, sequence, uuid });
}

export const sendText = (ctx: FeishuContext, to: FeishuRecipient, text: string) =>
  sendMessage(ctx, to, "text", { text }, `fusa-t-${randomUUID()}`);
