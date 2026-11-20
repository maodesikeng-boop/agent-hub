import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PmId } from "../../shared/domain.ts";
import type { FeishuChatId, FeishuChatTarget, FeishuMessageId } from "../../shared/feishu.ts";
import { AGENT_VENDORS, bundledModelCatalog, type AgentVendor, type ModelCatalog } from "../../shared/vendors.ts";
import { api, postCardEntity, updateCard } from "./api.ts";
import { renderChatPolicyCard, renderRouterSettingsCard, type FeishuCardJson } from "./cards.ts";
import { errorText, isReady, type FeishuContext, type HostCard } from "./context.ts";
import { enqueue } from "./lanes.ts";
import type { FeishuPmModelView } from "./model-picker.ts";
import { activeTarget, liveChatOfPm, routerChat } from "./projection.ts";
import type { FeishuChatBinding, FeishuPostRecord, FeishuPostRef } from "./store.ts";

const bundledCatalogs = AGENT_VENDORS.map(bundledModelCatalog);

export function peekCatalogs(ctx: FeishuContext): readonly ModelCatalog[] {
  const m = ctx.options.models;
  if (!m?.current && !m?.availability) return bundledCatalogs;
  return AGENT_VENDORS.map((vendor) => m.current?.(vendor) ?? { ...bundledModelCatalog(vendor), availability: m.availability?.(vendor) ?? "unknown" });
}

export async function loadVendorCatalogs(ctx: FeishuContext, vendor: AgentVendor): Promise<readonly ModelCatalog[]> {
  const models = ctx.options.models;
  if (!models) return bundledCatalogs;
  const listed = await models.list({ vendor });
  const byVendor = new Map(listed.map((c) => [c.vendor, c]));
  return peekCatalogs(ctx).map((c) => byVendor.get(c.vendor) ?? c);
}

export function isCatalogWarm(ctx: FeishuContext, vendor: AgentVendor) {
  const models = ctx.options.models;
  return models === undefined || models.current === undefined || models.current(vendor) !== null;
}

export function pmAgentView(ctx: FeishuContext, pmId: PmId): FeishuPmModelView {
  const persona = ctx.ledger.getPersona(pmId);
  return { vendor: persona.vendor, model: persona.model, effort: persona.effort, switchingToVendor: persona.switchingToVendor };
}

function policyCard(ctx: FeishuContext, chat: FeishuChatBinding, pmId: PmId): FeishuCardJson {
  return renderChatPolicyCard({
    pmId,
    agent: pmAgentView(ctx, pmId),
    catalogs: peekCatalogs(ctx),
    triggerMode: chat.triggerMode,
    guestTier: chat.guestTier,
    mentionOnlyForced: ctx.link.mentionOnly,
  });
}

const routerSettingsCard = (ctx: FeishuContext) => renderRouterSettingsCard({ settings: ctx.ledger.getRouterSettings(), catalogs: peekCatalogs(ctx) });

async function pinQuietly(ctx: FeishuContext, method: "pin.create" | "pin.delete", messageId: FeishuMessageId) {
  try {
    await api(ctx, method, { message_id: messageId });
  } catch (error) {
    ctx.log(`飞书：${method === "pin.create" ? "置顶" : "取消置顶"}设置卡没成，卡照常可用：${errorText(error)}`);
  }
}

async function repinSettingsCard(ctx: FeishuContext, chat: FeishuChatBinding, ref: FeishuPostRef, posted: HostCard, previous: FeishuPostRecord | null) {
  const { messageId, cardId } = posted;
  ctx.store.savePost({ ref, chatId: chat.chatId, messageId, cardId, sequence: previous?.sequence ?? 0, state: "final" }, ctx.now());
  await pinQuietly(ctx, "pin.create", messageId);
  if (previous !== null && previous.messageId !== messageId) await pinQuietly(ctx, "pin.delete", previous.messageId);
}

export async function postPolicyCard(ctx: FeishuContext, chat: FeishuChatBinding, uuid = `fusa-p-${randomUUID()}`) {
  const target = activeTarget(ctx, chat);
  if (target?.kind !== "pm") return;
  const ref: FeishuPostRef = { kind: "chat_policy", pmId: target.pmId };
  const previous = ctx.store.postOf(ref);
  ctx.directory.notePolicyCard(chat.chatId, ctx.now());
  const posted = await postCardEntity(ctx, chat.chatId, policyCard(ctx, chat, target.pmId), uuid);
  if (activeTarget(ctx, ctx.store.chatById(chat.chatId)) === null) return;
  await repinSettingsCard(ctx, chat, ref, posted, previous);
}

export async function refreshPolicyCard(ctx: FeishuContext, pmId: PmId) {
  const chat = liveChatOfPm(ctx, pmId);
  const post = ctx.store.postOf({ kind: "chat_policy", pmId });
  if (chat === null || post === null || post.cardId === null || ctx.link.transport === null) return;
  const nextSeq = post.sequence + 1;
  ctx.store.savePost({ ...post, sequence: nextSeq }, ctx.now());
  await updateCard(ctx, post.cardId, nextSeq, policyCard(ctx, chat, pmId));
}

export async function postRouterSettingsCard(ctx: FeishuContext, chat: FeishuChatBinding, uuid = `fusa-rs-${randomUUID()}`) {
  if (activeTarget(ctx, chat)?.kind !== "router") return;
  const ref: FeishuPostRef = { kind: "router_settings" };
  const previous = ctx.store.postOf(ref);
  const posted = await postCardEntity(ctx, chat.chatId, routerSettingsCard(ctx), uuid);
  if (activeTarget(ctx, ctx.store.chatById(chat.chatId))?.kind !== "router") return;
  await repinSettingsCard(ctx, chat, ref, posted, previous);
}

export async function refreshRouterSettingsCard(ctx: FeishuContext) {
  const chat = ctx.store.chatOfTarget({ kind: "router" });
  const post = ctx.store.postOf({ kind: "router_settings" });
  if (chat === null || post === null || post.cardId === null || ctx.link.transport === null) return;
  const nextSeq = post.sequence + 1;
  ctx.store.savePost({ ...post, sequence: nextSeq }, ctx.now());
  await updateCard(ctx, post.cardId, nextSeq, routerSettingsCard(ctx));
}

export function schedulePolicyCardRefresh(ctx: FeishuContext, chatId: FeishuChatId, pmId: PmId) {
  if (ctx.store.postOf({ kind: "chat_policy", pmId })?.cardId != null) {
    enqueue(ctx, chatId, () => refreshPolicyCard(ctx, pmId), { key: `policy_card:${pmId}` });
  }
}

export function scheduleRouterSettingsCardRefresh(ctx: FeishuContext, chatId: FeishuChatId) {
  if (ctx.store.postOf({ kind: "router_settings" })?.cardId != null) {
    enqueue(ctx, chatId, () => refreshRouterSettingsCard(ctx), { key: "router_settings_card" });
  }
}

export async function offerPolicyCard(ctx: FeishuContext, chatId: FeishuChatId) {
  const chat = ctx.store.chatById(chatId);
  if (chat === null || activeTarget(ctx, chat)?.kind !== "pm" || !ctx.directory.policyCardDue(chatId, ctx.now())) return;
  await postPolicyCard(ctx, chat);
}

const refreshStopped = (ctx: FeishuContext) => ctx.life.closed || ctx.life.closing !== null || !isReady(ctx);

function refreshCardsAfterCatalogChange(ctx: FeishuContext, before: readonly ModelCatalog[]) {
  if (refreshStopped(ctx) || isDeepStrictEqual(peekCatalogs(ctx), before)) return;
  for (const pmId of ctx.catalogRefresh.pms) {
    const chat = liveChatOfPm(ctx, pmId);
    if (chat !== null) schedulePolicyCardRefresh(ctx, chat.chatId, pmId);
  }
  if (ctx.catalogRefresh.router) {
    const chat = routerChat(ctx);
    if (chat !== null) scheduleRouterSettingsCardRefresh(ctx, chat.chatId);
  }
}

export function refreshCatalogsInBackground(ctx: FeishuContext, target: FeishuChatTarget) {
  const models = ctx.options.models;
  const pending = ctx.catalogRefresh;
  if (!models || refreshStopped(ctx)) return;
  if (target.kind === "pm") pending.pms.add(target.pmId);
  else pending.router = true;
  if (pending.inflight !== null) return;
  const before = peekCatalogs(ctx);
  pending.inflight = models
    .list({ refresh: "unusable" })
    .then(() => refreshCardsAfterCatalogChange(ctx, before))
    .catch((error: unknown) => {
      if (!ctx.life.closed) ctx.log(`飞书：后台刷新模型目录出错：${errorText(error)}`);
    })
    .finally(() => {
      pending.pms.clear();
      pending.router = false;
      pending.inflight = null;
    });
}
