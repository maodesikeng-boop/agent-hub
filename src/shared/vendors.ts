// 厂商的通用函数（校验、启动参数、模型名单、出错特征……）：网页（下拉）和后台（校验、启动参数）都从这里读。
// 每家的数据在 src/vendors/<厂商>/spec.ts，名单在 src/vendors/registry.ts；这里只读名单，不写任何一家（docs/vendor-plugin-design.md）。
// AGENT_VENDORS、VENDOR_SPECS、VENDOR_HOME_PATHS、VENDOR_FAILURE_SIGNS 是从名单推出来的旧形状，导出名不变、调用方不动。
// “默认”一律是 null，表示不传对应的参数，用厂商自己的默认。agent_sessions.vendor、pms.vendor 存的就是厂商编号。
import { VENDOR_LIST, type AgentVendor } from "../vendors/registry.ts";
import type { ComposerSpec, FailureKind, VendorSpec as VendorDefinition } from "../vendors/types.ts";
import { HANDOVER_TOKEN_THRESHOLD, MAX_MODEL_CHARS } from "./limits.ts";

export type { AgentVendor } from "../vendors/registry.ts";
export type { FailureKind, FetchedQuotaSpec } from "../vendors/types.ts";

type IdsOf<L extends readonly unknown[]> = { readonly [K in keyof L]: L[K] extends { id: infer Id } ? Id : never };

/** 厂商编号，按名单顺序（元组类型，zod 的 z.enum 要）。 */
export const AGENT_VENDORS = VENDOR_LIST.map((spec) => spec.id) as unknown as IdsOf<typeof VENDOR_LIST>;
export const DEFAULT_AGENT_VENDOR: AgentVendor = VENDOR_LIST[0].id;

/** 按编号查名单里的声明。 */
const SPECS = Object.fromEntries(VENDOR_LIST.map((spec) => [spec.id, spec])) as Readonly<Record<AgentVendor, VendorDefinition<AgentVendor>>>;

/** 按编号查厂商声明（src/vendors/<id>/spec.ts）。 */
export function vendorSpec(vendor: AgentVendor): VendorDefinition<AgentVendor> {
  return SPECS[vendor];
}

/**
 * 额度窗口的统一定义：厂商报的窗口按长度（分钟）归到这些键上，short 是界面上的窗口名（左下角按钮和浮层共用，界面外壳用英文）。
 * 厂商只报“第一个、第二个窗口”不报名字的（codex 的 primary / secondary），按 windowKeyByMinutes 用长度认，不按位置认：
 * 同一个位置在不同账号上长度不一样（同一个 primary，有的账号是 5 小时，有的是 30 天）。加新长度的窗口只改这里。
 */
export const QUOTA_WINDOWS = {
  five_hour: { durationMins: 300, short: "5h" },
  seven_day: { durationMins: 7 * 24 * 60, short: "7d" },
  thirty_day: { durationMins: 30 * 24 * 60, short: "30d" },
} as const;
export type QuotaWindowKey = keyof typeof QUOTA_WINDOWS;

/** 窗口长度（分钟）→ 额度窗口的键；不认识的长度（或没报长度）返回 null。 */
export function windowKeyByMinutes(mins: number | null | undefined): QuotaWindowKey | null {
  const hit = (Object.keys(QUOTA_WINDOWS) as QuotaWindowKey[]).find((key) => QUOTA_WINDOWS[key].durationMins === mins);
  return hit ?? null;
}

/**
 * 旧的平铺形状（VENDOR_SPECS 的值）：从 src/vendors/<id>/spec.ts 的分组字段派生，只为调用方不动。新代码读 vendorSpec(vendor)。
 * 每个字段注明来自 spec 的哪里；含义见 src/vendors/types.ts。
 */
export interface VendorSpec {
  /** label */
  label: string;
  /** cli.loginCommand */
  loginCommand: string;
  /** models.bundled */
  models: VendorDefinition["models"]["bundled"];
  /** models.customModel */
  customModel: boolean;
  /** models.customModelExample */
  customModelExample: string;
  /** models.efforts */
  efforts: readonly string[];
  /** models.effortInModelId */
  effortInModelId?: boolean;
  /** models.flags.model */
  modelFlag: string;
  /** models.flags.effort */
  effortFlag: string;
  /** models.flags */
  flags: { model: string; effort: string };
  /** quota */
  quota?: VendorDefinition["quota"];
  /** models.shortName */
  shortModelName?: (model: string) => string | null;
  /** capabilities.backgroundWake */
  backgroundCommands: boolean;
  /** cli.command */
  cliCommand: string;
  /** cli.envVar */
  envVar: string;
  /** prompt.subagentTools */
  subagentTools: readonly string[];
  /** prompt.backgroundCommandTool */
  backgroundCommandTool: string;
  /** capabilities.readonly */
  readonlyMode: VendorDefinition["capabilities"]["readonly"];
  /** capabilities.explicitDefaultModel（不写 = false） */
  explicitDefaultModel?: boolean;
  /** handover.tokenThreshold（不写 = HANDOVER_TOKEN_THRESHOLD） */
  handoverTokenThreshold: number;
  /** composer */
  composer: ComposerSpec;
}

function flatSpec(spec: VendorDefinition): VendorSpec {
  const { cli, models, capabilities } = spec;
  return {
    label: spec.label,
    loginCommand: cli.loginCommand,
    models: models.bundled,
    customModel: models.customModel,
    customModelExample: models.customModelExample,
    efforts: models.efforts,
    ...(models.effortInModelId === undefined ? {} : { effortInModelId: models.effortInModelId }),
    modelFlag: models.flags.model,
    effortFlag: models.flags.effort,
    flags: models.flags,
    ...(spec.quota === undefined ? {} : { quota: spec.quota }),
    ...(models.shortName === undefined ? {} : { shortModelName: models.shortName }),
    backgroundCommands: capabilities.backgroundWake,
    cliCommand: cli.command,
    envVar: cli.envVar,
    subagentTools: spec.prompt.subagentTools,
    backgroundCommandTool: spec.prompt.backgroundCommandTool,
    readonlyMode: capabilities.readonly,
    explicitDefaultModel: capabilities.explicitDefaultModel ?? false,
    handoverTokenThreshold: spec.handover?.tokenThreshold ?? HANDOVER_TOKEN_THRESHOLD,
    composer: spec.composer,
  };
}

/** 每家的声明（旧的平铺形状），以 AGENT_VENDORS 为键。 */
export const VENDOR_SPECS: Readonly<Record<AgentVendor, VendorSpec>> = Object.fromEntries(
  VENDOR_LIST.map((spec) => [spec.id, flatSpec(spec)]),
) as Record<AgentVendor, VendorSpec>;

/** 各家厂商的凭据和配置目录（相对用户主目录），以 AGENT_VENDORS 为键；字段含义见 src/vendors/types.ts 的 VendorSpec.home。 */
export const VENDOR_HOME_PATHS: Readonly<
  Record<AgentVendor, { dirs: readonly string[]; readonlySecrets: readonly string[]; catalogWatchPaths: readonly string[] }>
> = Object.fromEntries(
  VENDOR_LIST.map(({ id, home }) => [id, { dirs: home.dirs, readonlySecrets: home.readonlySecrets, catalogWatchPaths: home.catalogWatchPaths }]),
) as Record<AgentVendor, { dirs: readonly string[]; readonlySecrets: readonly string[]; catalogWatchPaths: readonly string[] }>;

/** 一个 agent 用哪家、哪个模型、多大思考程度。model、effort 是 null = 默认（不传参数）。 */
export interface AgentSetting {
  vendor: AgentVendor;
  model: string | null;
  effort: string | null;
}

export const DEFAULT_AGENT_SETTING: AgentSetting = { vendor: DEFAULT_AGENT_VENDOR, model: null, effort: null };

/**
 * 完整模型名能用的字符：字母、数字和 . _ - : / @ [ ]（如 claude-sonnet-5-5[1m]、us.anthropic.claude-haiku-5-5:0）。
 * 不能以横线开头，免得被当成命令行参数。
 */
const MODEL_NAME = /^[A-Za-z0-9._:/@[\]][A-Za-z0-9._:/@[\]-]*$/;
export const MODEL_NAME_RULE = "模型名只能用字母、数字和 . _ - : / @ [ ]，不能以 - 开头";

export function isAgentVendor(value: unknown): value is AgentVendor {
  return typeof value === "string" && (AGENT_VENDORS as readonly string[]).includes(value);
}

/** 所有厂商的思考程度（去重）：hub 命令行先按它查，再由账本按项目经理那家的清单查。 */
export const ALL_EFFORTS: readonly string[] = [...new Set(VENDOR_LIST.flatMap((spec) => spec.models.efforts))];

/** 合格返回 null，否则返回给人看的原因。别名和自定义的模型名都按同一条字符规则查。 */
export function checkModel(vendor: AgentVendor, model: string | null): string | null {
  if (model === null) return null;
  if ([...model].length > MAX_MODEL_CHARS) return `模型名最多 ${MAX_MODEL_CHARS} 个字`;
  const { bundled, customModel } = SPECS[vendor].models;
  if (bundled.some((m) => m.id === model)) return null;
  if (!customModel) return `模型只能是 ${bundled.map((m) => m.id).join("、")}`;
  return MODEL_NAME.test(model) ? null : MODEL_NAME_RULE;
}

/** 把模型各自的档位和默认档位合并进厂商通用档位（保持通用档位顺序在前，新出现的动态档位按出现顺序追加）。 */
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

/** 厂商静态档位 + 动态模型名单里出现的档位（去重保序）。 */
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

/**
 * 思考程度写在模型 ID 里的厂商（agy）：完整 ID 拆成 模型 + 思考程度。末尾是这家清单里的档位词（-low、-medium、-high 等）才拆；
 * 不带档位的、默认（null）、别家厂商原样返回。ID 里的档位优先于另存的 effort（启动时 agy 认的就是 ID）。
 * 老数据里存的是完整 ID，界面、右栏用它显示成“模型 + 档位”。
 */
export function splitModelEffort(
  vendor: AgentVendor,
  model: string | null,
  effort: string | null,
  catalog?: ModelCatalog | null,
): { model: string | null; effort: string | null } {
  // 网页的厂商来自名单，名单里可能有这里没有的厂商（测试里的假厂商），所以 spec 可能是 undefined
  const spec = (SPECS[vendor] as VendorDefinition | undefined)?.models;
  if (!spec?.effortInModelId || model === null) return { model, effort };
  const efforts = catalog ? allowedEffortsOf(vendor, catalog) : spec.efforts;
  const split = splitEffortSuffix(model, efforts);
  return split === null ? { model, effort } : { model: split.base, effort: split.effort };
}

/** 末尾是 -<档位> 且档位在 efforts 里：拆成 { base, effort }，否则 null。 */
export function splitEffortSuffix(id: string, efforts: readonly string[]): { base: string; effort: string } | null {
  const dash = id.lastIndexOf("-");
  if (dash <= 0) return null;
  const effort = id.slice(dash + 1);
  return efforts.includes(effort) ? { base: id.slice(0, dash), effort } : null;
}

/** 完整 ID 里已经带了档位，另给的思考程度和它对不上（agy 会报 conflicts）：返回给人看的原因，否则 null。 */
export function checkModelEffort(
  vendor: AgentVendor,
  model: string | null,
  effort: string | null,
  catalog?: ModelCatalog | null,
): string | null {
  if (effort === null) return null;
  const split = splitModelEffort(vendor, model, null, catalog);
  if (split.effort === null || split.effort === effort) return null;
  return `模型 ${model} 已经带了思考程度 ${split.effort}，和 ${effort} 对不上；请用不带档位的 ${split.model} 再选思考程度，或者去掉思考程度`;
}

/** 厂商、模型、思考程度一起查（vendor 可以是任何值）。 */
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

/**
 * 启动参数里模型、思考程度那几个（默认的不传）。思考程度在模型 ID 里的厂商（agy）：不带档位的模型 + 思考程度拼成完整 ID
 * 一个 --model（gemini-4-argon + high → gemini-4-argon-high），不再另传 --effort；只有思考程度才传 --effort。
 */
export function agentLaunchArgs(setting: AgentSetting): string[] {
  const { effortInModelId, flags } = SPECS[setting.vendor].models;
  const args: string[] = [];
  const hasModel = setting.model !== null && setting.model !== "";
  const hasEffort = setting.effort !== null && setting.effort !== "";
  if (effortInModelId && hasModel) {
    const { model, effort } = splitModelEffort(setting.vendor, setting.model, hasEffort ? setting.effort : null);
    args.push(flags.model, effort === null ? model! : `${model}-${effort}`);
    return args;
  }
  if (hasModel) args.push(flags.model, setting.model!);
  if (hasEffort) args.push(flags.effort, setting.effort!);
  return args;
}

/** 模型下拉里“自定义”那一项的值（选了它下面多一个输入框，填完整模型名）。以横线开头，不会和模型名撞。 */
export const CUSTOM_MODEL = "-custom";

// ---- 模型名单 ----
// 下拉里列哪些模型：优先用厂商自己报的（claude 的 initialize 控制请求，见 daemon/driver/model-catalog.ts），
// 拿不到时用这里打包的（VENDOR_SPECS 的 models）。网页从 GET /api/models 拿，后台的校验、启动参数不看名单。

/** 名单里的一个模型。id 原样传给 modelFlag；efforts 是它支持的思考程度，null = 没说，用厂商的通用档位。 */
export interface CatalogModel {
  id: string;
  label: string;
  description: string | null;
  efforts: readonly string[] | null;
}

/**
 * 一家厂商的名单：网页的厂商、模型、思考程度下拉只看它（GET /api/models 每家一份），不直接读 VENDOR_SPECS，
 * 所以厂商名、通用思考程度、能不能自定义也跟着名单走（取自 VENDOR_SPECS）。
 */
export interface ModelCatalog {
  vendor: AgentVendor;
  /** 界面上的厂商名（VENDOR_SPECS 的 label）。 */
  label: string;
  /** vendor：厂商自己报的；bundled：打包在程序里的（厂商没装、超时、报错时）。 */
  source: "vendor" | "bundled";
  /** 这家在这台设备上能不能用（跟名单一起问、一起缓存，见 docs/vendor-availability-design.md）。 */
  availability: VendorAvailability;
  /** 不含“默认”（默认 = 不传参数，界面自己加在最前面）。 */
  models: readonly CatalogModel[];
  /** 选“默认”时支持的思考程度，null = 没说。 */
  defaultEfforts: readonly string[] | null;
  /** “默认”的思考程度档位（若厂商有明确报出），没说是 null。 */
  defaultEffort?: string | null;
  /** “默认”实际用的模型的名字（如 Opus 5.5），厂商没说是 null（界面只写“默认”）。 */
  defaultModel: string | null;
  /** 同上的模型 ID（codex 启动时显式传它：不传的话 codex 用 ~/.codex/config.toml 里钉死的，那个模型可能这个账号用不了）。厂商没说是 null。 */
  defaultModelId: string | null;
  /** 这家的通用思考程度（VENDOR_SPECS 的 efforts）。 */
  efforts: readonly string[];
  /** 能不能填完整模型名，能的话输入框里的示例；不能是 null。 */
  customModelExample: string | null;
}

/** 打包在程序里的名单。 */
export function bundledModelCatalog(vendor: AgentVendor): ModelCatalog {
  const spec = SPECS[vendor];
  const { bundled, efforts, customModel, customModelExample } = spec.models;
  const models = bundled.map((m) => ({ id: m.id, label: m.label, description: null, efforts: m.efforts ?? null }));
  return {
    vendor,
    label: spec.label,
    source: "bundled",
    availability: "unknown",
    models,
    defaultEfforts: null,
    defaultModel: null,
    defaultModelId: null,
    efforts,
    customModelExample: customModel ? customModelExample : null,
  };
}

/** 某个模型（null = 默认）能选的思考程度：名单里说了就按它（按通用档位排序，并保留模型新增的动态档位），没说用通用档位。 */
export function effortsFor(catalog: ModelCatalog, model: string | null): readonly string[] {
  const all = catalog.efforts;
  const listed = model === null ? catalog.defaultEfforts : (catalog.models.find((m) => m.id === model)?.efforts ?? null);
  if (listed === null) return all;
  const known = isAgentVendor(catalog.vendor) ? SPECS[catalog.vendor].models.efforts : all;
  return [...all.filter((e) => listed.includes(e)), ...listed.filter((e) => !all.includes(e) && !known.includes(e))];
}

/** 模型下拉选中哪一项：默认是 ""，别的是模型名本身（名单里没有的，下拉里单独列一项“自定义：模型名”）。 */
export function modelChoiceOf(model: string | null): string {
  return model ?? "";
}

/** 界面、修改记录里显示的模型：默认；名单里有的用它的名字（没给名单用打包的；带档位的完整 ID 只取模型的名字）；别的原样。 */
export function modelLabel(vendor: AgentVendor, model: string | null, catalog: ModelCatalog = bundledModelCatalog(vendor)): string {
  if (model === null) return "默认";
  const listed = catalog.models.find((m) => m.id === model);
  if (listed) return listed.label;
  // 老数据存的是带档位的完整 ID（agy）：只显示模型的名字，档位另外显示（agentEffortOf），不拼在一起
  const bare = splitModelEffort(vendor, model, null, catalog).model!;
  return catalog.models.find((m) => m.id === bare)?.label ?? model;
}

/** 模型下拉里“默认”那一项：知道默认是哪个模型就写出来（“Opus 5.5（默认）”），不知道只写“默认”。 */
export function defaultModelOption(catalog: ModelCatalog): string {
  return catalog.defaultModel === null ? "默认" : `${catalog.defaultModel}（默认）`;
}

/**
 * 列表里（右栏的 Worker 行）显示的模型：名单里有的用名单的名字；名单里没有的完整模型名按厂商的规则缩短（Sonnet 5.5）；
 * 默认（null）写厂商说的实际模型（ModelCatalog.defaultModel），厂商没说才写“默认”。
 */
export function modelShortLabel(vendor: AgentVendor, model: string | null, catalog: ModelCatalog = bundledModelCatalog(vendor)): string {
  if (model === null) return catalog.defaultModel ?? "默认";
  // 带档位的完整 ID（老数据）只显示模型，档位另外显示（agentEffortOf）
  const bare = splitModelEffort(vendor, model, null, catalog).model!;
  const label = modelLabel(vendor, bare, catalog);
  return label === bare ? (SPECS[vendor].models.shortName?.(bare) ?? bare) : label;
}

/** 列表里显示的思考程度：另存的，或者老数据里写在模型 ID 末尾的（ID 优先）。 */
export function agentEffortOf(vendor: AgentVendor, model: string | null, effort: string | null, catalog?: ModelCatalog | null): string | null {
  return splitModelEffort(vendor, model, effort, catalog).effort;
}

export function effortLabel(effort: string | null): string {
  return effort ?? "默认";
}

export function vendorLabel(vendor: string): string {
  return isAgentVendor(vendor) ? SPECS[vendor].label : vendor;
}

/** 项目经理自动换新会话的上下文 token 阈值：认识的厂商返回声明表里的，否则默认 HANDOVER_TOKEN_THRESHOLD。 */
export function handoverTokenThresholdOf(vendor: string): number {
  const spec = (VENDOR_SPECS as Readonly<Record<string, VendorSpec | undefined>>)[vendor];
  return spec?.handoverTokenThreshold ?? HANDOVER_TOKEN_THRESHOLD;
}

// ---- 这台设备上能不能用（docs/vendor-availability-design.md）----
// 每台设备、每家厂商一个状态，只在这里定义；各家怎么判断在 daemon/vendors/<厂商>.ts，跟模型名单一起问、一起缓存。

/** available：能用；not_installed：没装；signed_out：没登录；unknown：认不出（当能用）。 */
export const VENDOR_AVAILABILITIES = ["available", "not_installed", "signed_out", "unknown"] as const;
export type VendorAvailability = (typeof VENDOR_AVAILABILITIES)[number];

/** 每家厂商在一台设备上的状态；没有的那家当 unknown。 */
export type VendorAvailabilityMap = Partial<Record<AgentVendor, VendorAvailability>>;

/** 界面上的英文状态词；能选的不显示。 */
export const AVAILABILITY_LABELS: Readonly<Record<VendorAvailability, string | null>> = {
  available: null,
  unknown: null,
  not_installed: "Not installed",
  signed_out: "Not signed in",
};

/** 列不列出来（下拉、额度）：没装的不列。 */
export function isListed(availability: VendorAvailability): boolean {
  return availability !== "not_installed";
}

/** 能不能选（下拉能选、提示词里列、hub worker start 放行）：能用、认不出的能。 */
export function isSelectable(availability: VendorAvailability): boolean {
  return availability === "available" || availability === "unknown";
}

/** 不能用时给人看的一句（hub worker start 报错用）；能用返回 null。device 是设备名。 */
export function vendorUnavailableMessage(vendor: AgentVendor, availability: VendorAvailability, device: string): string | null {
  if (availability === "not_installed") return `这台设备（${device}）没装 ${vendor}`;
  if (availability === "signed_out") {
    return `这台设备（${device}）的 ${vendor} 没登录：先在这台设备的终端里跑 \`${SPECS[vendor].cli.loginCommand}\` 登录，再派`;
  }
  return null;
}

/** 找不到这家程序的驱动错误码（codex_not_found……），按厂商生成，不手写。 */
export type VendorNotFoundCode = `${AgentVendor}_not_found`;
export function notFoundCode(vendor: AgentVendor): VendorNotFoundCode {
  return `${vendor}_not_found`;
}
export const VENDOR_NOT_FOUND_CODES: readonly VendorNotFoundCode[] = AGENT_VENDORS.map(notFoundCode);

// ---- 出错的特征 ----
// 失败原因（消息的 failureReason、Worker 这一轮没做完的原因、定时任务没跑成的原因）是厂商给的原文。网页按通用的类型
// 出一句人话（shared/errors.ts），各家的服务名、认出是哪家的特征写在各自 spec 的 failure，通用特征在这里。网络断了这类和厂商无关的特征在 shared/errors.ts。

export interface VendorFailureSigns {
  /** 出错的话里称呼这家的服务：“Claude 服务繁忙”。 */
  serviceName: string;
  /** 按顺序匹配，先中先算。 */
  signs: readonly { kind: FailureKind; pattern: RegExp }[];
  /** 鉴权失败匹配正则。 */
  auth: RegExp;
  /** 额度耗尽匹配正则。 */
  quota: RegExp;
  /** 上下文超长匹配正则。 */
  context: RegExp;
}

const COMMON_AUTH_PATTERN = /not logged in|unauthenticated|sign in|\b401\b|invalid_api_key/i;
const COMMON_QUOTA_PATTERN = /quota[_ ]?exceeded|rate[_ ]?limit|usage[_ ]?limit(?:_reached)?|resource_exhausted|\b429\b|credit balance|quota/i;
const COMMON_CONTEXT_PATTERN = /context_length_exceeded|context window|prompt is too long/i;
const COMMON_BUSY_PATTERN = /\b529\b|overloaded|api_error|\b5\d\d\b|internal server error|service unavailable/i;

/** 出错特征：通用的几条，加上找不到这家程序的错误码（<编号>_not_found）。 */
function failureSignsOf(spec: VendorDefinition): VendorFailureSigns {
  return {
    serviceName: spec.failure.serviceName,
    auth: COMMON_AUTH_PATTERN,
    quota: COMMON_QUOTA_PATTERN,
    context: COMMON_CONTEXT_PATTERN,
    signs: [
      // 驱动层起不来这家程序的错误码（daemon/driver）
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

/** 有 failure.rawHint 的厂商，按 rawHintPriority 从大到小（同分按名单顺序，toSorted 是稳定排序）。 */
const RAW_HINTS: readonly { vendor: AgentVendor; hint: RegExp }[] = VENDOR_LIST.flatMap(({ id, failure }) =>
  failure.rawHint === undefined ? [] : [{ vendor: id, hint: failure.rawHint, priority: failure.rawHintPriority ?? 0 }],
).toSorted((a, b) => b.priority - a.priority);

/** 从原文的特征词（各家的 failure.rawHint）推断优先检查哪家厂商。 */
function inferVendorFromRaw(raw: string): AgentVendor | null {
  return RAW_HINTS.find(({ hint }) => hint.test(raw))?.vendor ?? null;
}

/** 认得出是哪家的哪类错误就返回，否则 null。 */
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
