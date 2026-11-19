import type { UpdateRouterSettingsRequest } from "../../shared/api.ts";
import type { RouterSettings } from "../../shared/router.ts";
import type { AgentSetting, AgentVendor, ModelCatalog } from "../../shared/vendors.ts";

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

export function buildPmModelSection(_agent: FeishuPmModelView, _catalogs: readonly ModelCatalog[]): FeishuModelSectionView {
  return { summary: "", selects: [], fixedEffortNote: null };
}

export function resolvePmModelEdit(
  _current: AgentSetting,
  _catalogs: readonly ModelCatalog[],
  _field: FeishuModelField,
  _option: string,
): FeishuPmModelEditResult {
  return { ok: false, toast: "not_implemented" };
}

export function buildRouterModelSection(_settings: RouterSettings, _catalogs: readonly ModelCatalog[]): FeishuModelSectionView {
  return { summary: "", selects: [], fixedEffortNote: null };
}

export function resolveRouterModelEdit(
  _settings: RouterSettings,
  _catalogs: readonly ModelCatalog[],
  _field: FeishuModelField,
  _option: string,
): FeishuRouterModelEditResult {
  return { ok: false, toast: "not_implemented" };
}
