import { VENDOR_LIST, type AgentVendor } from "../vendors/registry.ts";
import type { FailureKind, VendorSpec } from "../vendors/types.ts";
import { HANDOVER_TOKEN_THRESHOLD, MAX_MODEL_CHARS } from "./limits.ts";

export type { AgentVendor } from "../vendors/registry.ts";
export type { FailureKind, FetchedQuotaSpec, VendorSpec } from "../vendors/types.ts";

type IdsOf<L extends readonly unknown[]> = { readonly [K in keyof L]: L[K] extends { id: infer Id } ? Id : never };

export const AGENT_VENDORS = VENDOR_LIST.map((spec) => spec.id) as unknown as IdsOf<typeof VENDOR_LIST>;
export const DEFAULT_AGENT_VENDOR: AgentVendor = VENDOR_LIST[0].id;

type SpecOf<V extends AgentVendor> = Extract<(typeof VENDOR_LIST)[number], { id: V }>;

const SPECS = Object.fromEntries(VENDOR_LIST.map((spec) => [spec.id, spec])) as Readonly<Record<AgentVendor, VendorSpec<AgentVendor>>>;

export function vendorSpec<V extends AgentVendor>(vendor: V): SpecOf<V>;
export function vendorSpec(vendor: AgentVendor): VendorSpec<AgentVendor>;
export function vendorSpec(vendor: AgentVendor): VendorSpec<AgentVendor> {
  return SPECS[vendor];
}

export const QUOTA_WINDOWS = {
  five_hour: { durationMins: 300, short: "5h" },
  seven_day: { durationMins: 7 * 24 * 60, short: "7d" },
  thirty_day: { durationMins: 30 * 24 * 60, short: "30d" },
} as const;
export type QuotaWindowKey = keyof typeof QUOTA_WINDOWS;

export function windowKeyByMinutes(mins: number | null | undefined): QuotaWindowKey | null {
  const hit = (Object.keys(QUOTA_WINDOWS) as QuotaWindowKey[]).find((key) => QUOTA_WINDOWS[key].durationMins === mins);
  return hit ?? null;
}

export interface AgentSetting {
  vendor: AgentVendor;
  model: string | null;
  effort: string | null;
}

const MODEL_NAME = /^[A-Za-z0-9._:/@[\]][A-Za-z0-9._:/@[\]-]*$/;
export const MODEL_NAME_RULE = "模型名只能用字母、数字和 . _ - : / @ [ ]，不能以 - 开头";

export function isAgentVendor(value: unknown): value is AgentVendor {
  return typeof value === "string" && (AGENT_VENDORS as readonly string[]).includes(value);
}

export const ALL_EFFORTS: readonly string[] = [...new Set(VENDOR_LIST.flatMap((spec) => spec.models.efforts))];

export function checkModel(vendor: AgentVendor, model: string | null): string | null {
  if (model === null) return null;
  if ([...model].length > MAX_MODEL_CHARS) return `模型名最多 ${MAX_MODEL_CHARS} 个字`;
  const { bundled, customModel } = SPECS[vendor].models;
  if (bundled.some((m) => m.id === model)) return null;
  if (!customModel) return `模型只能是 ${bundled.map((m) => m.id).join("、")}`;
  return MODEL_NAME.test(model) ? null : MODEL_NAME_RULE;
}

export function mergeCatalogEfforts(
  baseEfforts: readonly string[],
  models: readonly { efforts: readonly string[] | null }[],
  defaultEfforts: readonly string[] | null = null,
): string[] {
  const out = [...baseEfforts];
  const add = (list: readonly string[] | null | undefined) => {
    if (!list) return;
    for (const effort of list) {
      if (effort !== "" && !out.includes(effort)) out.push(effort);
    }
  };
  add(defaultEfforts);
  for (const model of models) add(model.efforts);
  return out;
}

function allowedEffortsOf(vendor: AgentVendor, catalog?: ModelCatalog | null): readonly string[] {
  const base = SPECS[vendor].models.efforts;
  if (!catalog) return base;
  return mergeCatalogEfforts([...base, ...catalog.efforts], catalog.models, catalog.defaultEfforts);
}

export function checkEffort(vendor: AgentVendor, effort: string | null, catalog?: ModelCatalog | null): string | null {
  const allowed = allowedEffortsOf(vendor, catalog);
  if (effort === null || allowed.includes(effort)) return null;
  return `思考程度只能是 ${allowed.join("、")}`;
}

export function splitModelEffort(
  vendor: AgentVendor,
  model: string | null,
  effort: string | null,
  catalog?: ModelCatalog | null,
): { model: string | null; effort: string | null } {
  const spec = (SPECS[vendor] as VendorSpec | undefined)?.models;
  if (!spec?.effortInModelId || model === null) return { model, effort };
  const efforts = catalog ? allowedEffortsOf(vendor, catalog) : spec.efforts;
  const split = splitEffortSuffix(model, efforts);
  return split === null ? { model, effort } : { model: split.base, effort: split.effort };
}

export function splitEffortSuffix(id: string, efforts: readonly string[]): { base: string; effort: string } | null {
  const dash = id.lastIndexOf("-");
  if (dash <= 0) return null;
  const effort = id.slice(dash + 1);
  return efforts.includes(effort) ? { base: id.slice(0, dash), effort } : null;
}

export function modelEffortsOf(vendor: AgentVendor, model: string | null, catalog?: ModelCatalog | null): readonly string[] | null {
  if (model === null) return catalog?.defaultEfforts ?? null;
  const listed = catalog?.models.find((entry) => entry.id === model);
  if (listed !== undefined) return listed.efforts;
  return SPECS[vendor].models.bundled.find((entry) => entry.id === model)?.efforts ?? null;
}

export function checkModelEffort(
  vendor: AgentVendor,
  model: string | null,
  effort: string | null,
  catalog?: ModelCatalog | null,
): string | null {
  const split = splitModelEffort(vendor, model, effort, catalog);
  if (effort !== null && split.effort !== effort) {
    return `模型 ${model} 已经带了思考程度 ${split.effort}，和 ${effort} 对不上；请用不带档位的 ${split.model} 再选思考程度，或者去掉思考程度`;
  }
  if (split.model === null || split.effort === null) return null;
  const allowed = modelEffortsOf(vendor, split.model, catalog);
  if (allowed === null || allowed.includes(split.effort)) return null;
  const options = allowed.length > 0 ? `可选：${allowed.join("、")}` : "请选择默认思考程度";
  return `模型 ${split.model} 不支持思考程度 ${split.effort}，${options}`;
}

export function checkAgentSetting(
  setting: { vendor: unknown; model: string | null; effort: string | null },
  catalog?: ModelCatalog | null,
): string | null {
  if (!isAgentVendor(setting.vendor)) return `厂商只能是 ${AGENT_VENDORS.join("、")}`;
  return (
    checkModel(setting.vendor, setting.model) ??
    checkEffort(setting.vendor, setting.effort, catalog) ??
    checkModelEffort(setting.vendor, setting.model, setting.effort, catalog)
  );
}

export function agentLaunchArgs(setting: AgentSetting): string[] {
  const models = (SPECS[setting.vendor] as VendorSpec | undefined)?.models;
  const flags = models?.flags;
  if (!flags) return [];
  const args: string[] = [];
  const hasModel = setting.model !== null && setting.model !== "";
  const hasEffort = setting.effort !== null && setting.effort !== "";
  if (models.effortInModelId && hasModel) {
    const { model, effort } = splitModelEffort(setting.vendor, setting.model, hasEffort ? setting.effort : null);
    args.push(flags.model, effort === null ? model! : `${model}-${effort}`);
    return args;
  }
  if (hasModel) args.push(flags.model, setting.model!);
  if (hasEffort) args.push(flags.effort, setting.effort!);
  return args;
}

export const CUSTOM_MODEL = "-custom";

export interface CatalogModel {
  id: string;
  label: string;
  description: string | null;
  efforts: readonly string[] | null;
}

export interface ModelCatalog {
  vendor: AgentVendor;
  label: string;
  source: "vendor" | "bundled";
  availability: VendorAvailability;
  models: readonly CatalogModel[];
  defaultEfforts: readonly string[] | null;
  defaultEffort?: string | null;
  defaultModel: string | null;
  defaultModelId: string | null;
  efforts: readonly string[];
  readonly effortLabels?: Readonly<Record<string, string>>;
  customModelExample: string | null;
}

export function bundledModelCatalog(vendor: AgentVendor): ModelCatalog {
  const resolved = isAgentVendor(vendor) ? vendor : DEFAULT_AGENT_VENDOR;
  const spec = SPECS[resolved];
  const { bundled, efforts, effortLabels, customModel, customModelExample } = spec.models;
  const models = bundled.map((m) => ({ id: m.id, label: m.label, description: null, efforts: m.efforts ?? null }));
  return {
    vendor: resolved,
    label: spec.label,
    source: "bundled",
    availability: "unknown",
    models,
    defaultEfforts: null,
    defaultModel: null,
    defaultModelId: null,
    efforts,
    ...(effortLabels !== undefined ? { effortLabels } : {}),
    customModelExample: customModel ? customModelExample : null,
  };
}

export function effortsFor(catalog: ModelCatalog, model: string | null): readonly string[] {
  const all = catalog.efforts;
  const listed = model === null ? catalog.defaultEfforts : (catalog.models.find((m) => m.id === model)?.efforts ?? null);
  if (listed === null) return all;
  const known = isAgentVendor(catalog.vendor) ? SPECS[catalog.vendor].models.efforts : all;
  return [...all.filter((e) => listed.includes(e)), ...listed.filter((e) => !all.includes(e) && !known.includes(e))];
}

export function modelChoiceOf(model: string | null): string {
  return model ?? "";
}

export function modelLabel(vendor: AgentVendor, model: string | null, catalog: ModelCatalog = bundledModelCatalog(vendor)): string {
  if (model === null) return "默认";
  const listed = catalog.models.find((m) => m.id === model);
  if (listed) return listed.label;
  const bare = splitModelEffort(vendor, model, null, catalog).model!;
  return catalog.models.find((m) => m.id === bare)?.label ?? model;
}

export function defaultModelOption(catalog: ModelCatalog): string {
  return catalog.defaultModel === null ? "默认" : `${catalog.defaultModel}（默认）`;
}

export function modelShortLabel(vendor: AgentVendor, model: string | null, catalog: ModelCatalog = bundledModelCatalog(vendor)): string {
  if (model === null) return catalog.defaultModel ?? "默认";
  const bare = splitModelEffort(vendor, model, null, catalog).model!;
  const label = modelLabel(vendor, bare, catalog);
  const shortName = isAgentVendor(vendor) ? SPECS[vendor].models.shortName : undefined;
  return label === bare ? (shortName?.(bare) ?? bare) : label;
}

export function agentEffortOf(vendor: AgentVendor, model: string | null, effort: string | null, catalog?: ModelCatalog | null): string | null {
  return splitModelEffort(vendor, model, effort, catalog).effort;
}

export function effortLabel(
  effort: string | null,
  vendor?: AgentVendor | null,
  catalog?: ModelCatalog | null,
): string {
  if (effort === null) return "默认";
  const specLabels = vendor && isAgentVendor(vendor) ? SPECS[vendor].models.effortLabels : undefined;
  return catalog?.effortLabels?.[effort] ?? specLabels?.[effort] ?? effort;
}

function matchesEffortLabel(key: string, label: string, input: string): boolean {
  if (label === input) return true;
  return label.toLowerCase() !== key.toLowerCase() && label.toLowerCase() === input.toLowerCase();
}

/** Map a vendor-specific display label back to its canonical effort key when unambiguous. */
export function normalizeEffortInput(
  vendor: AgentVendor | null | undefined,
  effort: string | null,
  catalog?: ModelCatalog | null,
): string | null {
  if (effort === null) return null;
  const trimmed = effort.trim();
  if (trimmed === "") return trimmed;
  if (vendor && isAgentVendor(vendor)) {
    const allowed = allowedEffortsOf(vendor, catalog);
    if (allowed.includes(trimmed)) return trimmed;
    const labels = { ...SPECS[vendor].models.effortLabels, ...catalog?.effortLabels };
    for (const [key, label] of Object.entries(labels)) {
      if (label !== undefined && matchesEffortLabel(key, label, trimmed) && allowed.includes(key)) return key;
    }
    return trimmed;
  }
  if (ALL_EFFORTS.includes(trimmed)) return trimmed;
  const matches = new Set<string>();
  for (const spec of VENDOR_LIST) {
    const labels = spec.models.effortLabels;
    if (!labels) continue;
    for (const [key, label] of Object.entries(labels)) {
      if (matchesEffortLabel(key, label, trimmed)) matches.add(key);
    }
  }
  return matches.size === 1 ? [...matches][0]! : trimmed;
}

export function vendorLabel(vendor: string): string {
  return isAgentVendor(vendor) ? SPECS[vendor].label : vendor;
}

export function handoverTokenThresholdOf(vendor: string): number {
  return (isAgentVendor(vendor) ? SPECS[vendor].handover?.tokenThreshold : undefined) ?? HANDOVER_TOKEN_THRESHOLD;
}

export const VENDOR_AVAILABILITIES = ["available", "not_installed", "signed_out", "unknown"] as const;
export type VendorAvailability = (typeof VENDOR_AVAILABILITIES)[number];

export type VendorAvailabilityMap = Partial<Record<AgentVendor, VendorAvailability>>;

export const AVAILABILITY_LABELS: Readonly<Record<VendorAvailability, string | null>> = {
  available: null,
  unknown: null,
  not_installed: "Not installed",
  signed_out: "Not signed in",
};

export function isListed(availability: VendorAvailability): boolean {
  return availability !== "not_installed";
}

export function isSelectable(availability: VendorAvailability): boolean {
  return availability === "available" || availability === "unknown";
}

export type AvailabilityOf = (vendor: AgentVendor) => VendorAvailability;

/**
 * The one rule for which vendor the system picks when nobody named one, walking VENDOR_LIST in order.
 * Postcondition: returns the first "available" vendor; when none is available and `probedOnly` is not true,
 * the first "unknown" (installed but not yet probed) vendor; otherwise null.
 * Never returns a "not_installed" or "signed_out" vendor.
 */
export function firstUsableVendor(availabilityOf: AvailabilityOf, options?: { probedOnly?: boolean }): AgentVendor | null {
  let unprobed: AgentVendor | null = null;
  for (const vendor of AGENT_VENDORS) {
    const availability = availabilityOf(vendor);
    if (availability === "available") return vendor;
    if (availability === "unknown" && unprobed === null) unprobed = vendor;
  }
  return options?.probedOnly === true ? null : unprobed;
}

/**
 * Vendor for a new project manager whose creator named none (web dialog, HTTP API, Router, first start).
 * Postcondition: firstUsableVendor(availabilityOf), or DEFAULT_AGENT_VENDOR when no vendor is usable,
 * which keeps today's zero-provider behavior.
 */
export function defaultPmVendor(availabilityOf: AvailabilityOf): AgentVendor {
  return firstUsableVendor(availabilityOf) ?? DEFAULT_AGENT_VENDOR;
}

/** Availability lookup over a catalog list; a vendor missing from the list reads as "unknown". */
export function availabilityOfCatalogs(catalogs: readonly ModelCatalog[]): AvailabilityOf {
  return (vendor) => catalogs.find((c) => c.vendor === vendor)?.availability ?? "unknown";
}

const pickableCatalogsCache = new WeakMap<readonly ModelCatalog[], Map<string, readonly ModelCatalog[]>>();

export function pickableVendorCatalogs(
  catalogs: readonly ModelCatalog[],
  current?: AgentVendor | null,
): readonly ModelCatalog[] {
  let byCurrent = pickableCatalogsCache.get(catalogs);
  if (byCurrent === undefined) {
    byCurrent = new Map();
    pickableCatalogsCache.set(catalogs, byCurrent);
  }
  const key = current ?? "";
  const cached = byCurrent.get(key);
  if (cached !== undefined) return cached;

  const filtered = catalogs.filter((c) => isSelectable(c.availability) || (current != null && c.vendor === current));
  if (current != null && !filtered.some((c) => c.vendor === current)) {
    const fallback = bundledModelCatalog(current);
    if (!filtered.some((c) => c.vendor === fallback.vendor)) {
      filtered.push(fallback);
    }
  }
  byCurrent.set(key, filtered);
  return filtered;
}

export type VendorNotFoundCode = `${AgentVendor}_not_found`;
export function notFoundCode(vendor: AgentVendor): VendorNotFoundCode {
  return `${vendor}_not_found`;
}
export const VENDOR_NOT_FOUND_CODES: readonly VendorNotFoundCode[] = AGENT_VENDORS.map(notFoundCode);

export interface VendorFailureSigns {
  serviceName: string;
  signs: readonly { kind: FailureKind; pattern: RegExp }[];
  auth: RegExp;
  quota: RegExp;
  context: RegExp;
}

const COMMON_AUTH_PATTERN = /not logged in|unauthenticated|authentication required|sign in|to log in|\b401\b|invalid_api_key/i;
const COMMON_QUOTA_PATTERN = /quota[_ ]?exceeded|rate[_ ]?limit|usage[_ ]?limit(?:_reached)?|resource_exhausted|\b429\b|credit balance|quota|\b(?:session|weekly|daily|monthly|\d+[ -](?:hour|day|week)) limit\b/i;
const COMMON_CONTEXT_PATTERN = /context_length_exceeded|context window|prompt is too long/i;
const COMMON_BUSY_PATTERN = /\b529\b|overloaded|api_error|\b5\d\d\b|internal server error|service unavailable/i;

function failureSignsOf(spec: VendorSpec): VendorFailureSigns {
  return {
    serviceName: spec.failure.serviceName,
    auth: COMMON_AUTH_PATTERN,
    quota: COMMON_QUOTA_PATTERN,
    context: COMMON_CONTEXT_PATTERN,
    signs: [
      { kind: "missing", pattern: new RegExp(`^${spec.id}_not_found\\b`) },
      { kind: "start", pattern: /^(spawn_failed|start_timeout)\b/ },
      { kind: "quota", pattern: COMMON_QUOTA_PATTERN },
      { kind: "busy", pattern: COMMON_BUSY_PATTERN },
      { kind: "auth", pattern: COMMON_AUTH_PATTERN },
      { kind: "context", pattern: COMMON_CONTEXT_PATTERN },
    ],
  };
}

export const VENDOR_FAILURE_SIGNS: Readonly<Record<AgentVendor, VendorFailureSigns>> = Object.fromEntries(
  VENDOR_LIST.map((spec) => [spec.id, failureSignsOf(spec)]),
) as Record<AgentVendor, VendorFailureSigns>;

const RAW_HINTS: readonly { vendor: AgentVendor; hint: RegExp }[] = VENDOR_LIST.flatMap(({ id, failure }) =>
  failure.rawHint === undefined ? [] : [{ vendor: id, hint: failure.rawHint, priority: failure.rawHintPriority ?? 0 }],
).toSorted((a, b) => b.priority - a.priority);

function inferVendorFromRaw(raw: string): AgentVendor | null {
  return RAW_HINTS.find(({ hint }) => hint.test(raw))?.vendor ?? null;
}

export function vendorFailureOf(raw: string, vendor?: AgentVendor): { kind: FailureKind; serviceName: string } | null {
  const preferred = vendor !== undefined && isAgentVendor(vendor) ? vendor : inferVendorFromRaw(raw);
  const order: readonly AgentVendor[] =
    preferred !== null ? [preferred, ...AGENT_VENDORS.filter((v) => v !== preferred)] : AGENT_VENDORS;
  for (const v of order) {
    const { serviceName, signs } = VENDOR_FAILURE_SIGNS[v];
    const hit = signs.find((s) => s.pattern.test(raw));
    if (hit) return { kind: hit.kind, serviceName };
  }
  return null;
}
