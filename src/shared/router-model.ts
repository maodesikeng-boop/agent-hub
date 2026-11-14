// Router 轨道 B 零厂商分支模型选型纯函数（docs/router-design.md 第 6.1 节）：
// 一律按 VENDOR_LIST 与各家 VendorSpec.models.routerDefault / ModelCatalog 动态决策，零单家厂商 if/else。
import { VENDOR_LIST } from "../vendors/registry.ts";
import {
  bundledModelCatalog,
  effortsFor,
  isAgentVendor,
  splitModelEffort,
  vendorSpec,
  type AgentVendor,
  type ModelCatalog,
  type VendorAvailability,
} from "./vendors.ts";

/** 用户或 router_settings 表传入的最小模型偏好结构（与第 2 波 RouterSettings 直接兼容）。 */
export interface RouterModelPreference {
  readonly vendor?: string | null;
  readonly model?: string | null;
  readonly effort?: string | null;
}

/** 支持直接传 ModelCatalog[]（ModelCatalogs.list() 返回值）、按厂商键索引的对象或 Map。 */
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
  /** 若用户显式指定了偏好厂商，但该厂商当前不可用而自动回退到其他可用厂商时附带。 */
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

/** 取指定模型在该目录中支持的最低思考档位（所有厂商 efforts 均按从低到高排列，第 0 项即最低档位）。 */
function lowestEffortFor(vendor: AgentVendor, catalog: ModelCatalog, model: string): string {
  const supported = effortsFor(catalog, model);
  if (supported.length > 0) return supported[0]!;
  if (catalog.efforts.length > 0) return catalog.efforts[0]!;
  return vendorSpec(vendor).models.efforts[0]!;
}

/** 在某家厂商目录内计算默认 Router 快模型预设：优先命中 spec.models.routerDefault，若实时目录无该预设则降级到 defaultModelId ?? models[0].id。 */
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

/**
 * 零厂商分支的 Router 极快模型选型器：
 * 1. 显式指定 (vendor, model, effort) 且该厂商可用（availability === "available"）时优先使用；未传 effort 取 efforts[0]。
 * 2. 未指定（或首选厂商当前不可用）时，按 VENDOR_LIST 顺序挑第一家 availability === "available" 的厂商：
 *    - 优先命中 spec.models.routerDefault；
 *    - 若实时 ModelCatalog 中无该预设模型，优雅降级到 catalog.defaultModelId ?? catalog.models[0].id + efforts[0]。
 * 3. 全部厂商不可用时返回清晰的结构化不可用原因。
 */
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

  for (const spec of VENDOR_LIST) {
    const catalog = catalogMap.get(spec.id);
    if (catalog?.availability !== "available") continue;
    const resolved = resolveVendorRouterPreset(spec.id, catalog);
    return {
      ok: true,
      vendor: spec.id,
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

/**
 * 前端预览解析：服务端真实可用性尚未拉回（全为 bundled + unknown）时按打包名单计算预览；
 * 只要已有服务端状态（含 available / signed_out / not_installed 或 unknown 混合），严格按 resolveRouterModel 判定。
 */
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
