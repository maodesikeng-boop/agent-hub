import { VENDOR_LIST } from "../vendors/registry.ts";
import {
  bundledModelCatalog,
  effortsFor,
  firstUsableVendor,
  isAgentVendor,
  splitModelEffort,
  vendorSpec,
  type AgentVendor,
  type ModelCatalog,
  type VendorAvailability,
} from "./vendors.ts";

export interface RouterModelPreference {
  readonly vendor?: string | null;
  readonly model?: string | null;
  readonly effort?: string | null;
}

export type RouterCatalogInput =
  | readonly ModelCatalog[]
  | Readonly<Partial<Record<AgentVendor, ModelCatalog>>>
  | ReadonlyMap<AgentVendor, ModelCatalog>;

export type RouterModelSelectionSource =
  | "explicit"
  | "preset"
  | "catalog_fallback";

export interface ResolvedRouterModel {
  readonly ok: true;
  readonly vendor: AgentVendor;
  readonly model: string;
  readonly effort: string;
  readonly source: RouterModelSelectionSource;
  readonly fallbackFromPreferred?: {
    readonly vendor: AgentVendor;
    readonly availability: VendorAvailability;
  };
}

export type RouterUnavailableReasonCode =
  | "all_not_installed"
  | "needs_sign_in"
  | "no_available_vendor";

export interface VendorUnavailableDetail {
  readonly vendor: AgentVendor;
  readonly label: string;
  readonly availability: VendorAvailability;
  readonly loginCommand: string;
}

export interface RouterModelUnavailable {
  readonly ok: false;
  readonly code: RouterUnavailableReasonCode;
  readonly preferredVendor: {
    readonly vendor: AgentVendor;
    readonly availability: VendorAvailability;
  } | null;
  readonly vendors: readonly VendorUnavailableDetail[];
  readonly message: string;
}

export type RouterModelResolution = ResolvedRouterModel | RouterModelUnavailable;

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function toCatalogMap(input: RouterCatalogInput): Map<AgentVendor, ModelCatalog> {
  const map = new Map<AgentVendor, ModelCatalog>();
  if (input instanceof Map) {
    for (const [vendor, catalog] of input.entries()) {
      if (isAgentVendor(vendor) && catalog) map.set(vendor, catalog);
    }
    return map;
  }
  if (Array.isArray(input)) {
    for (const catalog of input) {
      if (catalog && isAgentVendor(catalog.vendor)) map.set(catalog.vendor, catalog);
    }
    return map;
  }
  for (const [vendor, catalog] of Object.entries(input as Partial<Record<string, ModelCatalog>>)) {
    if (isAgentVendor(vendor) && catalog) map.set(vendor, catalog);
  }
  return map;
}

function lowestEffortFor(vendor: AgentVendor, catalog: ModelCatalog, model: string): string {
  const supported = effortsFor(catalog, model);
  if (supported.length > 0) return supported[0]!;
  if (catalog.efforts.length > 0) return catalog.efforts[0]!;
  return vendorSpec(vendor).models.efforts[0]!;
}

export function resolveVendorRouterPreset(
  vendor: AgentVendor,
  inputCatalog?: ModelCatalog | null,
): { model: string; effort: string; source: "preset" | "catalog_fallback" } {
  const catalog = inputCatalog ?? bundledModelCatalog(vendor);
  const preset = vendorSpec(vendor).models.routerDefault;
  const hasPresetInCatalog =
    catalog.source === "bundled" || catalog.models.some((m) => m.id === preset.model);

  if (hasPresetInCatalog) {
    const supported = effortsFor(catalog, preset.model);
    const effort =
      supported.length === 0 || supported.includes(preset.effort)
        ? preset.effort
        : supported[0]!;
    return { model: preset.model, effort, source: "preset" };
  }

  const fallbackModel = nonEmpty(catalog.defaultModelId) ?? nonEmpty(catalog.models[0]?.id) ?? preset.model;
  return {
    model: fallbackModel,
    effort: lowestEffortFor(vendor, catalog, fallbackModel),
    source: "catalog_fallback",
  };
}

export function resolveExplicitRouterChoice(
  vendor: AgentVendor,
  preference: RouterModelPreference | null | undefined,
  inputCatalog?: ModelCatalog | null,
): { model: string; effort: string | null } {
  const catalog = inputCatalog ?? bundledModelCatalog(vendor);
  const rawModel = nonEmpty(preference?.model);
  const rawEffort = nonEmpty(preference?.effort);
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

export function resolveRouterEffortForModel(
  vendor: AgentVendor,
  nextModel: string,
  currentEffort: string | null,
  inputCatalog?: ModelCatalog | null,
): string | null {
  const catalog = inputCatalog ?? bundledModelCatalog(vendor);
  const nextSupported = effortsFor(catalog, nextModel);
  if (nextSupported.length === 0) return null;
  if (currentEffort !== null && nextSupported.includes(currentEffort)) return currentEffort;
  const routerPreset = vendorSpec(vendor).models.routerDefault;
  return nextModel === routerPreset.model && nextSupported.includes(routerPreset.effort)
    ? routerPreset.effort
    : (nextSupported[0] ?? null);
}

function buildUnavailableMessage(
  code: RouterUnavailableReasonCode,
  preferred: RouterModelUnavailable["preferredVendor"],
  vendors: readonly VendorUnavailableDetail[],
): string {
  if (preferred !== null) {
    const spec = vendorSpec(preferred.vendor);
    if (preferred.availability === "signed_out") {
      return `Router 首选厂商 ${spec.label} 尚未登录（请在终端运行 \`${spec.cli.loginCommand}\`），且本机暂无其他可用厂商`;
    }
    if (preferred.availability === "not_installed") {
      return `Router 首选厂商 ${spec.label} 尚未安装，且本机暂无其他可用厂商`;
    }
  }
  if (code === "all_not_installed") {
    return "本机尚未安装任何已接入的 Agent CLI，无法执行自由指令分派";
  }
  if (code === "needs_sign_in") {
    const signedOut = vendors.filter((v) => v.availability === "signed_out");
    const commands = signedOut.map((v) => `\`${v.loginCommand}\``).join(" 或 ");
    return `本机已安装的厂商均未登录，请先在终端运行 ${commands} 登录后再试`;
  }
  return "当前没有处于可用状态（available）的 Agent 厂商，请检查 CLI 安装与登录状态";
}

export function resolveRouterModel(
  preference: RouterModelPreference | null | undefined,
  catalogs: RouterCatalogInput,
): RouterModelResolution {
  const catalogMap = toCatalogMap(catalogs);
  const rawVendor = nonEmpty(preference?.vendor);
  const preferredVendor = rawVendor !== null && isAgentVendor(rawVendor) ? rawVendor : null;

  if (preferredVendor !== null) {
    const preferredCatalog = catalogMap.get(preferredVendor);
    if (preferredCatalog?.availability === "available") {
      const explicitModel = nonEmpty(preference?.model);
      const explicitEffort = nonEmpty(preference?.effort);
      if (explicitModel !== null) {
        const split = splitModelEffort(preferredVendor, explicitModel, explicitEffort, preferredCatalog);
        const model = split.model ?? explicitModel;
        const effort = split.effort ?? lowestEffortFor(preferredVendor, preferredCatalog, model);
        return {
          ok: true,
          vendor: preferredVendor,
          model,
          effort,
          source: "explicit",
        };
      }
      const resolved = resolveVendorRouterPreset(preferredVendor, preferredCatalog);
      return {
        ok: true,
        vendor: preferredVendor,
        model: resolved.model,
        effort: explicitEffort ?? resolved.effort,
        source: "explicit",
      };
    }
  }

  const fallbackFromPreferred =
    preferredVendor !== null
      ? {
          vendor: preferredVendor,
          availability: catalogMap.get(preferredVendor)?.availability ?? "unknown",
        }
      : undefined;

  const autoVendor = firstUsableVendor((vendor) => catalogMap.get(vendor)?.availability ?? "unknown", { probedOnly: true });
  if (autoVendor !== null) {
    const resolved = resolveVendorRouterPreset(autoVendor, catalogMap.get(autoVendor));
    return {
      ok: true,
      vendor: autoVendor,
      model: resolved.model,
      effort: resolved.effort,
      source: resolved.source,
      ...(fallbackFromPreferred !== undefined ? { fallbackFromPreferred } : {}),
    };
  }

  const vendors: VendorUnavailableDetail[] = VENDOR_LIST.map((spec) => ({
    vendor: spec.id,
    label: spec.label,
    availability: catalogMap.get(spec.id)?.availability ?? "unknown",
    loginCommand: spec.cli.loginCommand,
  }));

  const code: RouterUnavailableReasonCode =
    vendors.length > 0 && vendors.every((v) => v.availability === "not_installed")
      ? "all_not_installed"
      : vendors.some((v) => v.availability === "signed_out")
        ? "needs_sign_in"
        : "no_available_vendor";

  const preferredInfo = fallbackFromPreferred ?? null;
  return {
    ok: false,
    code,
    preferredVendor: preferredInfo,
    vendors,
    message: buildUnavailableMessage(code, preferredInfo, vendors),
  };
}

export function resolveRouterModelPreview(
  preference: RouterModelPreference | null | undefined,
  catalogs: readonly ModelCatalog[],
): RouterModelResolution {
  const allBundledUnknown =
    catalogs.length > 0 &&
    catalogs.every((c) => c.source === "bundled" && c.availability === "unknown");
  if (allBundledUnknown) {
    return resolveRouterModel(
      preference,
      catalogs.map((c) => ({ ...c, availability: "available" as const })),
    );
  }
  const hasExplicitUnknown = catalogs.some((c) => c.availability === "unknown");
  if (hasExplicitUnknown && !catalogs.some((c) => c.availability === "available")) {
    return resolveRouterModel(
      preference,
      catalogs.map((c) => (c.availability === "unknown" ? { ...c, availability: "available" as const } : c)),
    );
  }
  return resolveRouterModel(preference, catalogs);
}
