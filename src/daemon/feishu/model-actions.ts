import type { FeishuChatId } from "../../shared/feishu.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import { isAgentVendor, vendorLabel, type AgentVendor } from "../../shared/vendors.ts";
import { sendText, unlessRejected } from "./api.ts";
import { FEISHU_BUSY_TOAST, toast } from "./card-actions.ts";
import { errorText, type FeishuContext } from "./context.ts";
import { admitInbound } from "./lanes.ts";
import { resolvePmModelEdit, resolveRouterModelEdit } from "./model-picker.ts";
import { activeTarget } from "./projection.ts";
import type { FeishuActionRoute } from "./routing.ts";
import {
  isCatalogWarm,
  loadVendorCatalogs,
  peekCatalogs,
  pmAgentView,
  schedulePolicyCardRefresh,
  scheduleRouterSettingsCardRefresh,
} from "./settings-cards.ts";
import type { FeishuCardActionResponse } from "./transport.ts";

type PmModelRoute = Extract<FeishuActionRoute, { kind: "set_pm_model" }>;
type RouterModelRoute = Extract<FeishuActionRoute, { kind: "set_router_model" }>;

const LOADING_CATALOG = "正在读取模型目录…";

async function reportEditFailure(ctx: FeishuContext, chatId: FeishuChatId, error: unknown, who: string) {
  const message = error instanceof LedgerRequestError ? error.message : "修改模型设置出错了，去网页看看";
  if (!(error instanceof LedgerRequestError)) ctx.log(`飞书：异步改${who}模型出错：${errorText(error)}`);
  await unlessRejected(ctx, () => sendText(ctx, { chatId }, message).then(() => undefined));
}

async function editPmModelAfterLoad(ctx: FeishuContext, route: PmModelRoute, chatId: FeishuChatId, vendor: AgentVendor) {
  if (activeTarget(ctx, ctx.store.chatById(chatId))?.kind !== "pm") return;
  try {
    const catalogs = await loadVendorCatalogs(ctx, vendor);
    const resolved = resolvePmModelEdit(pmAgentView(ctx, route.pmId), catalogs, route.field, route.option);
    if (!resolved.ok) {
      await sendText(ctx, { chatId }, resolved.toast);
      schedulePolicyCardRefresh(ctx, chatId, route.pmId);
      return;
    }
    const res = ctx.ledger.editPersona(route.pmId, resolved.next, { kind: "user" });
    if (res.change === null) schedulePolicyCardRefresh(ctx, chatId, route.pmId);
  } catch (error) {
    await reportEditFailure(ctx, chatId, error, "项目经理");
    schedulePolicyCardRefresh(ctx, chatId, route.pmId);
  }
}

export function applySetPmModel(ctx: FeishuContext, route: PmModelRoute, chatId: FeishuChatId): FeishuCardActionResponse {
  const current = pmAgentView(ctx, route.pmId);
  const targetVendor = route.field === "vendor" && isAgentVendor(route.option) ? route.option : current.vendor;
  const switchingBlocked = route.field === "vendor" && current.switchingToVendor != null;
  if (!switchingBlocked && !isCatalogWarm(ctx, targetVendor)) {
    const admitted = admitInbound(ctx, chatId, () => editPmModelAfterLoad(ctx, route, chatId, targetVendor));
    return admitted ? toast("info", LOADING_CATALOG) : toast("warning", FEISHU_BUSY_TOAST);
  }
  const resolved = resolvePmModelEdit(current, peekCatalogs(ctx), route.field, route.option);
  if (!resolved.ok) {
    schedulePolicyCardRefresh(ctx, chatId, route.pmId);
    return toast("warning", resolved.toast);
  }
  let res;
  try {
    res = ctx.ledger.editPersona(route.pmId, resolved.next, { kind: "user" });
  } catch (error) {
    schedulePolicyCardRefresh(ctx, chatId, route.pmId);
    throw error;
  }
  if (res.change === null) schedulePolicyCardRefresh(ctx, chatId, route.pmId);
  return route.field === "vendor" && res.persona.switchingToVendor != null
    ? toast("info", `已设成 ${vendorLabel(res.persona.switchingToVendor)}，当前这一轮跑完切换`)
    : toast("success", "已改");
}

async function editRouterModelAfterLoad(ctx: FeishuContext, route: RouterModelRoute, chatId: FeishuChatId, vendor: AgentVendor) {
  if (activeTarget(ctx, ctx.store.chatById(chatId))?.kind !== "router") return;
  try {
    const catalogs = await loadVendorCatalogs(ctx, vendor);
    const resolved = resolveRouterModelEdit(ctx.ledger.getRouterSettings(), catalogs, route.field, route.option);
    if (!resolved.ok) {
      await sendText(ctx, { chatId }, resolved.toast);
      scheduleRouterSettingsCardRefresh(ctx, chatId);
      return;
    }
    ctx.ledger.updateRouterSettings(resolved.next);
  } catch (error) {
    await reportEditFailure(ctx, chatId, error, "总助");
    scheduleRouterSettingsCardRefresh(ctx, chatId);
  }
}

export function applySetRouterModel(ctx: FeishuContext, route: RouterModelRoute, chatId: FeishuChatId): FeishuCardActionResponse {
  const settings = ctx.ledger.getRouterSettings();
  const targetVendor = route.field === "vendor" ? (isAgentVendor(route.option) ? route.option : null) : settings.vendor;
  if (targetVendor !== null && !isCatalogWarm(ctx, targetVendor)) {
    const admitted = admitInbound(ctx, chatId, () => editRouterModelAfterLoad(ctx, route, chatId, targetVendor));
    return admitted ? toast("info", LOADING_CATALOG) : toast("warning", FEISHU_BUSY_TOAST);
  }
  const resolved = resolveRouterModelEdit(settings, peekCatalogs(ctx), route.field, route.option);
  if (!resolved.ok) {
    scheduleRouterSettingsCardRefresh(ctx, chatId);
    return toast("warning", resolved.toast);
  }
  try {
    ctx.ledger.updateRouterSettings(resolved.next);
  } catch (error) {
    scheduleRouterSettingsCardRefresh(ctx, chatId);
    throw error;
  }
  return toast("success", "已改");
}
