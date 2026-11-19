import type { UpdateRouterSettingsRequest } from "../../shared/api.ts";
import { FEISHU_SELECT_OPTIONS_MAX } from "../../shared/limits.ts";
import type { RouterSettings } from "../../shared/router.ts";
import { resolveRouterModelPreview, resolveVendorRouterPreset } from "../../shared/router-model.ts";
import {
  bundledModelCatalog,
  checkEffort,
  checkModel,
  defaultModelOption,
  effortLabel,
  effortsFor,
  isAgentVendor,
  isListed,
  isSelectable,
  modelLabel,
  modelShortLabel,
  splitModelEffort,
  vendorLabel,
  vendorSpec,
  type AgentSetting,
  type AgentVendor,
  type ModelCatalog,
} from "../../shared/vendors.ts";

/** 飞书 select_static 以空串 initial_option 表示未选中；模型名禁止以 - 开头，用 -default / -auto 作哨兵值不会冲突。 */
export const FEISHU_DEFAULT_OPTION = "-default";
export const FEISHU_AUTO_OPTION = "-auto";

export const FEISHU_MODEL_FIELDS = ["vendor", "model", "effort"] as const;
export type FeishuModelField = (typeof FEISHU_MODEL_FIELDS)[number];

export interface FeishuPmModelView {
  vendor: AgentVendor;
  model: string | null;
  effort: string | null;
  switchingToVendor?: AgentVendor | null;
}

export interface FeishuSelectOption {
  label: string;
  value: string;
}

export interface FeishuSelectField {
  field: FeishuModelField;
  label: string;
  initialOption: string;
  options: readonly FeishuSelectOption[];
}

export interface FeishuModelSectionView {
  summary: string;
  selects: readonly FeishuSelectField[];
  fixedEffortNote: string | null;
}

export type FeishuPmModelEditResult = { ok: true; next: AgentSetting } | { ok: false; toast: string };
export type FeishuRouterModelEditResult = { ok: true; next: UpdateRouterSettingsRequest } | { ok: false; toast: string };

const FIXED_EFFORT_NOTE = "思考程度：当前模型固定档位，不支持调节。";

function catalogForVendor(catalogs: readonly ModelCatalog[], vendor: AgentVendor): ModelCatalog {
  return catalogs.find((c) => c.vendor === vendor) ?? bundledModelCatalog(vendor);
}

function vendorOptionLabel(catalog: ModelCatalog): string {
  if (catalog.availability === "signed_out") return `${catalog.label}（未登录）`;
  if (catalog.availability === "not_installed") return `${catalog.label}（未安装）`;
  return catalog.label;
}

function unavailableVendorToast(catalog: ModelCatalog): string {
  if (catalog.availability === "not_installed") return `${catalog.label} 还没安装，先在电脑上安装再用`;
  return `${catalog.label} 还没登录，先在电脑上登录再用`;
}

function listedVendors(catalogs: readonly ModelCatalog[], current: AgentVendor | null): ModelCatalog[] {
  const full = current !== null && !catalogs.some((c) => c.vendor === current) ? [...catalogs, bundledModelCatalog(current)] : catalogs;
  return full.filter((c) => isListed(c.availability) || c.vendor === current);
}

function capOptions(options: FeishuSelectOption[], selectedValue: string): FeishuSelectOption[] {
  if (options.length <= FEISHU_SELECT_OPTIONS_MAX) return options;
  const head = options.slice(0, FEISHU_SELECT_OPTIONS_MAX);
  if (head.some((o) => o.value === selectedValue)) return head;
  const chosen = options.find((o) => o.value === selectedValue);
  return chosen === undefined ? head : [...head.slice(0, FEISHU_SELECT_OPTIONS_MAX - 1), chosen];
}

function resolveExplicitRouterChoice(
  vendor: AgentVendor,
  settings: RouterSettings,
  catalog: ModelCatalog,
): { model: string; effort: string | null } {
  const rawModel = settings.model?.trim() || null;
  const rawEffort = settings.effort?.trim() || null;
  if (rawModel !== null) {
    const split = splitModelEffort(vendor, rawModel, rawEffort, catalog);
    const model = split.model ?? rawModel;
    const supported = effortsFor(catalog, model);
    const effort =
      split.effort !== null && (supported.length === 0 || supported.includes(split.effort))
        ? split.effort
        : (supported[0] ?? null);
    return { model, effort };
  }
  const preset = resolveVendorRouterPreset(vendor, catalog);
  return { model: preset.model, effort: rawEffort ?? preset.effort };
}

export function buildPmModelSection(agent: FeishuPmModelView, catalogs: readonly ModelCatalog[]): FeishuModelSectionView {
  const catalog = catalogForVendor(catalogs, agent.vendor);
  const split = splitModelEffort(agent.vendor, agent.model, agent.effort, catalog);
  const vendors = listedVendors(catalogs, agent.vendor);
  const vendorSelect: FeishuSelectField = {
    field: "vendor",
    label: "厂商",
    initialOption: agent.vendor,
    options: vendors.map((c) => ({ label: vendorOptionLabel(c), value: c.vendor })),
  };

  const rawModels: FeishuSelectOption[] = [
    { label: defaultModelOption(catalog), value: FEISHU_DEFAULT_OPTION },
    ...catalog.models.map((m) => ({ label: m.label, value: m.id })),
  ];
  if (split.model !== null && !catalog.models.some((m) => m.id === split.model)) {
    rawModels.push({ label: `自定义：${split.model}`, value: split.model });
  }
  const modelInitial = split.model ?? FEISHU_DEFAULT_OPTION;
  const modelSelect: FeishuSelectField = {
    field: "model",
    label: "模型",
    initialOption: modelInitial,
    options: capOptions(rawModels, modelInitial),
  };

  const efforts = effortsFor(catalog, split.model);
  const selects: FeishuSelectField[] = [vendorSelect, modelSelect];
  let fixedEffortNote: string | null = FIXED_EFFORT_NOTE;
  if (efforts.length > 1) {
    const rawEfforts: FeishuSelectOption[] = [
      { label: "默认", value: FEISHU_DEFAULT_OPTION },
      ...efforts.map((e) => ({ label: e, value: e })),
    ];
    if (split.effort !== null && !efforts.includes(split.effort)) {
      rawEfforts.push({ label: split.effort, value: split.effort });
    }
    selects.push({
      field: "effort",
      label: "思考程度",
      initialOption: split.effort ?? FEISHU_DEFAULT_OPTION,
      options: rawEfforts,
    });
    fixedEffortNote = null;
  }

  const modelText = split.model === null ? defaultModelOption(catalog) : modelLabel(agent.vendor, split.model, catalog);
  const effortPart = efforts.length > 1 ? ` · **${effortLabel(split.effort)}**` : "";
  const switchNote = agent.switchingToVendor ? `\n正在切到 **${vendorLabel(agent.switchingToVendor)}**，当前这一轮跑完生效。` : "";
  return {
    summary: `当前：**${vendorLabel(agent.vendor)}** · **${modelText}**${effortPart}${switchNote}`,
    selects,
    fixedEffortNote,
  };
}

export function resolvePmModelEdit(
  current: AgentSetting,
  catalogs: readonly ModelCatalog[],
  field: FeishuModelField,
  option: string,
): FeishuPmModelEditResult {
  if (field === "vendor") {
    if (!isAgentVendor(option)) return { ok: false, toast: "不认识这家厂商" };
    const target = catalogForVendor(catalogs, option);
    if (option !== current.vendor && !isSelectable(target.availability)) {
      return { ok: false, toast: unavailableVendorToast(target) };
    }
    if (option === current.vendor) return { ok: true, next: current };
    return { ok: true, next: { vendor: option, model: null, effort: null } };
  }
  const catalog = catalogForVendor(catalogs, current.vendor);
  const split = splitModelEffort(current.vendor, current.model, current.effort, catalog);
  if (field === "model") {
    const nextModel = option === FEISHU_DEFAULT_OPTION ? null : option;
    const problem = checkModel(current.vendor, nextModel);
    if (problem !== null) return { ok: false, toast: problem };
    const nextEfforts = effortsFor(catalog, nextModel);
    const nextEffort = split.effort !== null && nextEfforts.length > 1 && nextEfforts.includes(split.effort) ? split.effort : null;
    return { ok: true, next: { vendor: current.vendor, model: nextModel, effort: nextEffort } };
  }
  const nextEffort = option === FEISHU_DEFAULT_OPTION ? null : option;
  const problem = checkEffort(current.vendor, nextEffort, catalog);
  if (problem !== null) return { ok: false, toast: problem };
  return { ok: true, next: { vendor: current.vendor, model: split.model, effort: nextEffort } };
}

export function buildRouterModelSection(settings: RouterSettings, catalogs: readonly ModelCatalog[]): FeishuModelSectionView {
  const vendors = listedVendors(catalogs, settings.vendor);
  const vendorSelect: FeishuSelectField = {
    field: "vendor",
    label: "厂商",
    initialOption: settings.vendor ?? FEISHU_AUTO_OPTION,
    options: [
      { label: "Auto（自动选可用快模型）", value: FEISHU_AUTO_OPTION },
      ...vendors.map((c) => ({ label: vendorOptionLabel(c), value: c.vendor })),
    ],
  };
  const preview = resolveRouterModelPreview(settings, catalogs);
  if (settings.vendor === null) {
    const summary = preview.ok
      ? `当前：**Auto（自动）** · 实际选用 **${vendorLabel(preview.vendor)} · ${modelShortLabel(preview.vendor, preview.model, catalogForVendor(catalogs, preview.vendor))} · ${preview.effort}**`
      : `当前：**Auto（自动）**\n${preview.message}`;
    return { summary, selects: [vendorSelect], fixedEffortNote: null };
  }

  const selectedCatalog = catalogForVendor(catalogs, settings.vendor);
  const choice = resolveExplicitRouterChoice(settings.vendor, settings, selectedCatalog);
  const rawModels: FeishuSelectOption[] = selectedCatalog.models.map((m) => ({ label: m.label, value: m.id }));
  if (!selectedCatalog.models.some((m) => m.id === choice.model)) {
    rawModels.push({ label: modelShortLabel(settings.vendor, choice.model, selectedCatalog), value: choice.model });
  }
  const modelSelect: FeishuSelectField = {
    field: "model",
    label: "模型",
    initialOption: choice.model,
    options: capOptions(rawModels, choice.model),
  };

  const supportedEfforts = effortsFor(selectedCatalog, choice.model);
  const selects: FeishuSelectField[] = [vendorSelect, modelSelect];
  let fixedEffortNote: string | null = FIXED_EFFORT_NOTE;
  if (supportedEfforts.length > 1 && choice.effort !== null) {
    selects.push({
      field: "effort",
      label: "思考程度",
      initialOption: choice.effort,
      options: supportedEfforts.map((e) => ({ label: e, value: e })),
    });
    fixedEffortNote = null;
  }
  const effortPart = supportedEfforts.length > 1 && choice.effort !== null ? ` · **${choice.effort}**` : "";
  const fallbackNote =
    preview.ok && preview.fallbackFromPreferred !== undefined
      ? `\n${vendorOptionLabel(selectedCatalog)} 暂不可用，当前自动回退到 **${vendorLabel(preview.vendor)}**。`
      : !preview.ok
        ? `\n${preview.message}`
        : "";
  return {
    summary: `当前：**${vendorLabel(settings.vendor)}** · **${modelLabel(settings.vendor, choice.model, selectedCatalog)}**${effortPart}${fallbackNote}`,
    selects,
    fixedEffortNote,
  };
}

export function resolveRouterModelEdit(
  settings: RouterSettings,
  catalogs: readonly ModelCatalog[],
  field: FeishuModelField,
  option: string,
): FeishuRouterModelEditResult {
  if (field === "vendor") {
    if (option === FEISHU_AUTO_OPTION) return { ok: true, next: { vendor: null, model: null, effort: null } };
    if (!isAgentVendor(option)) return { ok: false, toast: "不认识这家厂商" };
    const target = catalogForVendor(catalogs, option);
    if (option !== settings.vendor && !isSelectable(target.availability)) {
      return { ok: false, toast: unavailableVendorToast(target) };
    }
    if (option === settings.vendor) {
      const choice = resolveExplicitRouterChoice(option, settings, target);
      return { ok: true, next: { vendor: option, model: choice.model, effort: choice.effort } };
    }
    const preset = resolveVendorRouterPreset(option, target);
    return { ok: true, next: { vendor: option, model: preset.model, effort: preset.effort } };
  }
  if (settings.vendor === null) return { ok: false, toast: "当前是自动模式，先选一家厂商" };
  const selectedCatalog = catalogForVendor(catalogs, settings.vendor);
  const choice = resolveExplicitRouterChoice(settings.vendor, settings, selectedCatalog);
  if (field === "model") {
    const problem = checkModel(settings.vendor, option);
    if (problem !== null) return { ok: false, toast: problem };
    const nextSupported = effortsFor(selectedCatalog, option);
    const routerPreset = vendorSpec(settings.vendor).models.routerDefault;
    let nextEffort: string | null = choice.effort;
    if (nextSupported.length === 0) {
      nextEffort = null;
    } else if (nextEffort === null || !nextSupported.includes(nextEffort)) {
      nextEffort =
        option === routerPreset.model && nextSupported.includes(routerPreset.effort)
          ? routerPreset.effort
          : (nextSupported[0] ?? null);
    }
    return { ok: true, next: { vendor: settings.vendor, model: option, effort: nextEffort } };
  }
  const problem = checkEffort(settings.vendor, option, selectedCatalog);
  if (problem !== null) return { ok: false, toast: problem };
  return { ok: true, next: { vendor: settings.vendor, model: choice.model, effort: option } };
}
