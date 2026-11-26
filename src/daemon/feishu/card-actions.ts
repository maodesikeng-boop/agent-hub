import { isDeepStrictEqual } from "node:util";
import { askOf, type MessageId, type PmId } from "../../shared/domain.ts";
import { feishuDisplayName, type FeishuChatId, type FeishuChatTarget, type FeishuOpenId } from "../../shared/feishu.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import { FEISHU_CARD_ACTION_DEADLINE_MS } from "../../shared/limits.ts";
import type { UserBlockerId } from "../../shared/user-blockers.ts";
import { sendText } from "./api.ts";
import { feishuAskOptions, feishuCardRefOf, type FeishuCardRef } from "./cards.ts";
import { displayOwner, errorText, owner, type FeishuContext } from "./context.ts";
import { decisionOf } from "./decision-cards.ts";
import { parseFeishuCardAction, type FeishuInboundAction } from "./inbound.ts";
import { admitInbound } from "./lanes.ts";
import { applySetPmModel, applySetRouterModel } from "./model-actions.ts";
import { activeTarget, conversationOfPm, isActivePm, pmOfConversation } from "./projection.ts";
import { routeFeishuAction, type FeishuActionRoute } from "./routing.ts";
import { offerPolicyCard } from "./settings-cards.ts";
import { setChatPolicy } from "./setup-service.ts";
import type { FeishuPostRecord } from "./store.ts";
import type { FeishuCardActionResponse, FeishuRawCardAction } from "./transport.ts";

type Route<K extends FeishuActionRoute["kind"]> = Extract<FeishuActionRoute, { kind: K }>;

const ALREADY_DECIDED = "已经定过了";
export const FEISHU_BUSY_TOAST = "飞书正忙，请再点一次";
const EXPIRED_CARD = "这张卡已过期，去网页看";
const STALE_POLICY_CARD = "这张设置卡已换新，在群里发 /群设置 叫出最新的";
const STALE_ROUTER_SETTINGS_CARD = "这张设置卡已换新，发 /设置 叫出最新的";

export const toast = (type: "success" | "info" | "warning" | "error", content: string): FeishuCardActionResponse => ({ toast: { type, content } });

function askRefOfMessage(ctx: FeishuContext, messageId: MessageId, pmId: PmId): FeishuCardRef | null {
  const message = ctx.ledger.getMessage(messageId);
  if (message === null || pmOfConversation(ctx, message.conversationId) !== pmId) return null;
  const ask = askOf(message);
  return ask === null ? null : feishuCardRefOf(message, ask);
}

function postedCardRef(ctx: FeishuContext, post: FeishuPostRecord, target: FeishuChatTarget): FeishuCardRef | null {
  const { ref } = post;
  if (post.state !== "card_pending" && post.state !== "card_settled") return null;
  if (ref.kind === "message" && ref.part === 0 && target.kind === "pm") return askRefOfMessage(ctx, ref.messageId, target.pmId);
  if (ref.kind === "router_ask" && target.kind === "router") {
    const message = ctx.ledger.getMessage(ref.messageId);
    const pmId = message === null ? null : pmOfConversation(ctx, message.conversationId);
    if (message === null || pmId === null || !isActivePm(ctx, pmId)) return null;
    const ask = askOf(message);
    return ask === null ? null : feishuCardRefOf(message, ask);
  }
  if (ref.kind !== "router_item" || target.kind !== "router") return null;
  const item = ctx.ledger.getRouterItem(ref.itemId);
  if (item?.kind !== "decision" || !isActivePm(ctx, item.pmId)) return null;
  if (item.askMessageId === null) return { kind: "router_item", itemId: item.id };
  return askRefOfMessage(ctx, item.askMessageId, item.pmId);
}

function cardRefStillLive(ctx: FeishuContext, ref: FeishuCardRef, action: FeishuInboundAction): boolean {
  if (ref.kind === "gate") {
    return ctx.db.get(`SELECT 1 FROM task_graphs g JOIN projects p ON p.id = g.project_id
      JOIN messages m ON m.id = ? AND m.conversation_id = g.conversation_id
      WHERE g.id = ? AND p.status = 'active'`, ref.askMessageId, ref.graphId) !== undefined;
  }
  if (ref.kind === "blocker") {
    return action.value.kind === "blocker_done" && ctx.db.get("SELECT 1 FROM user_blocker_cards WHERE message_id = ? AND blocker_id = ?", ref.askMessageId, ref.blockerId) !== undefined;
  }
  if (ref.kind === "router_item" || ref.kind === "ask") {
    const row = ref.kind === "router_item"
      ? ctx.db.get<{ active: number }>(`SELECT r.project_id IS NULL OR p.status = 'active' AS active
          FROM router_items r LEFT JOIN projects p ON p.id = r.project_id WHERE r.id = ?`, ref.itemId)
      : ctx.db.get<{ active: number }>(`SELECT r.project_id IS NULL OR p.status = 'active' AS active
          FROM router_items r LEFT JOIN projects p ON p.id = r.project_id WHERE r.ask_message_id = ? ORDER BY r.id DESC LIMIT 1`, ref.askMessageId);
    return row?.active === 1;
  }
  return true;
}

// Trust only our own send records and the ledger, never the ids carried in the button value.
function ownsAction(ctx: FeishuContext, action: FeishuInboundAction, target: FeishuChatTarget): boolean {
  const { value, chatId, messageId } = action;
  if (value.kind === "mesh_approval") {
    if (target.kind !== "router") return false;
    const tracked = ctx.approvalCards.get(value.requestId);
    return tracked !== undefined && !tracked.settled && tracked.messageId === messageId;
  }
  if (value.kind === "stop") {
    if (target.kind !== "pm" || pmOfConversation(ctx, value.conversationId) !== target.pmId) return false;
    const slot = ctx.streams.get(value.conversationId);
    return slot?.chatId === chatId && slot.state.phase === "live" && slot.posted?.messageId === messageId;
  }
  const post = ctx.store.postByMessageId(messageId);
  if (post === null || post.chatId !== chatId || post.cardId === null) return false;
  if (value.kind === "set_policy" || value.kind === "set_pm_model") {
    return target.kind === "pm" && post.ref.kind === "chat_policy" && post.ref.pmId === target.pmId && value.pmId === target.pmId;
  }
  if (value.kind === "set_router_model") return target.kind === "router" && post.ref.kind === "router_settings";
  const ref = postedCardRef(ctx, post, target);
  if (ref === null || !isDeepStrictEqual(ref, value.card)) return false;
  return cardRefStillLive(ctx, ref, action);
}

function staleCardToast(action: FeishuInboundAction): FeishuCardActionResponse {
  const kind = action.value.kind;
  if (kind === "set_router_model") return toast("warning", STALE_ROUTER_SETTINGS_CARD);
  return toast("warning", kind === "set_policy" || kind === "set_pm_model" ? STALE_POLICY_CARD : EXPIRED_CARD);
}

export function onRawCardAction(ctx: FeishuContext, raw: FeishuRawCardAction): FeishuCardActionResponse {
  const started = ctx.now();
  const action = parseFeishuCardAction(raw);
  const chat = action === null ? null : ctx.store.chatById(action.chatId);
  const target = activeTarget(ctx, chat);
  if (action === null || target === null || chat === null) return toast("warning", EXPIRED_CARD);
  const route = routeFeishuAction(action, { ownerOpenId: owner(ctx), binding: { target, archived: false }, guestTier: chat.guestTier });
  if (route.kind !== "ignore" && route.kind !== "reject" && !ownsAction(ctx, action, target)) return staleCardToast(action);
  const response = applyAction(ctx, route, action.operatorOpenId, action.chatId);
  if (ctx.now() - started > FEISHU_CARD_ACTION_DEADLINE_MS) ctx.log(`飞书：卡片点击处理了 ${ctx.now() - started} 毫秒，超过 ${FEISHU_CARD_ACTION_DEADLINE_MS}`);
  return response;
}

function applyMeshApproval(ctx: FeishuContext, route: Route<"mesh_approval">, chatId: FeishuChatId): FeishuCardActionResponse {
  const meshHooks = ctx.options.mesh;
  if (meshHooks === undefined) return toast("warning", EXPIRED_CARD);
  const admitted = admitInbound(ctx, chatId, async () => {
    try {
      if (route.step === "begin") await meshHooks.beginApproval(route.requestId);
      else await meshHooks.answerApproval(route.requestId, route.step === "match");
    } catch (error) {
      await sendText(ctx, { chatId }, `核对没成：${errorText(error)}`).catch(() => {});
    }
  });
  if (!admitted) return toast("warning", FEISHU_BUSY_TOAST);
  return toast("info", route.step === "begin" ? "正在生成核对码" : route.step === "match" ? "已确认一致" : "已拒绝");
}

function applySetPolicy(ctx: FeishuContext, route: Route<"set_policy">, chatId: FeishuChatId): FeishuCardActionResponse {
  const admitted = admitInbound(ctx, chatId, async () => {
    if (activeTarget(ctx, ctx.store.chatById(chatId)) === null) return;
    await setChatPolicy(ctx, { pmId: route.pmId, ...(route.triggerMode ? { triggerMode: route.triggerMode } : {}), ...(route.guestTier ? { guestTier: route.guestTier } : {}) });
  });
  return admitted ? toast("success", "已改") : toast("warning", FEISHU_BUSY_TOAST);
}

async function recheckBlocker(ctx: FeishuContext, chatId: FeishuChatId, blockerId: UserBlockerId) {
  const vendor = ctx.ledger.userBlockerVendor(blockerId);
  if (vendor !== null && ctx.options.models !== undefined) await ctx.options.models.list({ vendor, refresh: true });
  if (ctx.ledger.recheckUserBlocker(blockerId).resolved) return;
  if (activeTarget(ctx, ctx.store.chatById(chatId)) !== null) await sendText(ctx, { chatId }, "还不能用，卡先留着：在电脑上处理好再点一次「已处理」。");
}

// Rechecking runs the vendor CLI and can outlive Feishu's callback deadline, so it is queued after the toast.
function applyBlockerDone(ctx: FeishuContext, route: Route<"blocker_done">, chatId: FeishuChatId): FeishuCardActionResponse {
  const blockerId = route.card.blockerId;
  const askMsg = ctx.ledger.getMessage(route.card.askMessageId);
  if (ctx.ledger.userBlockerVendor(blockerId) === null || (askMsg !== null && askOf(askMsg)?.answered === true)) {
    return toast("info", ALREADY_DECIDED);
  }
  const admitted = admitInbound(ctx, chatId, () => recheckBlocker(ctx, chatId, blockerId));
  return admitted ? toast("info", "正在重查，能用了这张卡会自己改") : toast("warning", FEISHU_BUSY_TOAST);
}

function answerCard(ctx: FeishuContext, route: Route<"answer">, onDecisionWritten: () => void) {
  const { card, optionIndex, note, clientId } = route;
  if (card.kind === "router_item") {
    ctx.ledger.resolveRouterItem(card.itemId, { clientId, ...(optionIndex !== null ? { optionIndex } : {}), ...(note !== null ? { note } : {}) }, onDecisionWritten);
    return;
  }
  const message = ctx.ledger.getMessage(card.askMessageId);
  const ask = message === null ? null : askOf(message);
  if (ask === null) throw new LedgerRequestError("not_found", "这张卡已经不在了");
  if (card.kind === "blocker") throw new LedgerRequestError("invalid", "这张卡只能标记已处理");
  const choice = optionIndex === null ? null : (feishuAskOptions(ask)[optionIndex] ?? null);
  if (optionIndex !== null && choice === null) throw new LedgerRequestError("invalid", "选项不在有效范围内");
  if (card.kind === "gate") {
    if (ask.answered === true || ask.closed === true) throw new LedgerRequestError("conflict", ALREADY_DECIDED);
    ctx.ledger.decideTaskNode(card.graphId, card.nodeKey, { clientId, choice, note, askMessageId: card.askMessageId }, onDecisionWritten);
    return;
  }
  ctx.ledger.answerAsk(card.askMessageId, { clientId, choice, ...(note !== null ? { note } : {}) }, onDecisionWritten);
}

function applyAnswer(ctx: FeishuContext, route: Route<"answer">, operator: FeishuOpenId, chatId: FeishuChatId): FeishuCardActionResponse {
  const name = operator === owner(ctx) ? displayOwner(ctx) : (ctx.directory.peekMembers(chatId)?.find((m) => m.openId === operator)?.name || "访客");
  const previous = decisionOf(ctx, route.card);
  if (previous?.clientId === route.clientId) return toast("success", "已定案");
  answerCard(ctx, route, () => ctx.store.saveDecision(route.card, route.clientId, feishuDisplayName(name), ctx.now()));
  return toast("success", "已定案");
}

function dispatchAction(ctx: FeishuContext, route: FeishuActionRoute, operator: FeishuOpenId, chatId: FeishuChatId): FeishuCardActionResponse {
  switch (route.kind) {
    case "ignore":
      return {};
    case "reject":
      if (route.guestDenied === true) admitInbound(ctx, chatId, () => offerPolicyCard(ctx, chatId));
      return toast("warning", route.toast);
    case "stop": {
      if (route.target.kind !== "pm") return {};
      const conversationId = conversationOfPm(ctx, route.target.pmId);
      if (conversationId !== null) ctx.ledger.requestStop(conversationId);
      return toast("info", "正在停");
    }
    case "mesh_approval":
      return applyMeshApproval(ctx, route, chatId);
    case "set_policy":
      return applySetPolicy(ctx, route, chatId);
    case "set_pm_model":
      return applySetPmModel(ctx, route, chatId);
    case "set_router_model":
      return applySetRouterModel(ctx, route, chatId);
    case "blocker_done":
      return applyBlockerDone(ctx, route, chatId);
    case "answer":
      return applyAnswer(ctx, route, operator, chatId);
  }
}

function applyAction(ctx: FeishuContext, route: FeishuActionRoute, operator: FeishuOpenId, chatId: FeishuChatId): FeishuCardActionResponse {
  try {
    return dispatchAction(ctx, route, operator, chatId);
  } catch (error) {
    if (error instanceof LedgerRequestError && error.code === "conflict") return toast("info", ALREADY_DECIDED);
    if (error instanceof LedgerRequestError) return toast("warning", error.message);
    ctx.log(`飞书：处理卡片点击出错：${errorText(error)}`);
    return toast("error", "出错了，去网页看看");
  }
}
