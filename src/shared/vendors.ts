// 厂商清单：每家厂商打包的模型名单、哪些思考程度、对应的命令行参数。网页（下拉）和后台（校验、启动参数）都从这里读，
// 加厂商只改这一个文件（问厂商要模型名单的代码在 daemon/driver/model-catalog.ts）。“默认”一律是 null，表示不传对应的参数，用厂商自己的默认。
// agent_sessions.vendor、pms.vendor 存的就是这里的厂商编号。
import { MAX_MODEL_CHARS } from "./limits.ts";

export const AGENT_VENDORS = ["claude"] as const;
export type AgentVendor = (typeof AGENT_VENDORS)[number];
export const DEFAULT_AGENT_VENDOR: AgentVendor = "claude";

export interface VendorSpec {
  /** 界面上的名字。 */
  label: string;
  /** 打包的模型名单（问不到厂商时用）：id 原样传给 modelFlag，label 是界面上的名字。 */
  models: readonly { id: string; label: string }[];
  /** 能不能填完整模型名（下拉里的“自定义”）。 */
  customModel: boolean;
  /** 自定义模型名输入框里的示例。 */
  customModelExample: string;
  /** 思考程度，原样传给 effortFlag。 */
  efforts: readonly string[];
  flags: { model: string; effort: string };
}

export const VENDOR_SPECS: Readonly<Record<AgentVendor, VendorSpec>> = {
  claude: {
    label: "Claude Code",
    models: [
      { id: "fable", label: "Fable" },
      { id: "opus", label: "Opus" },
      { id: "sonnet", label: "Sonnet" },
      { id: "haiku", label: "Haiku" },
    ],
    customModel: true,
    customModelExample: "claude-opus-5-5",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    flags: { model: "--model", effort: "--effort" },
  },
};

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
export const ALL_EFFORTS: readonly string[] = [...new Set(AGENT_VENDORS.flatMap((v) => VENDOR_SPECS[v].efforts))];

/** 合格返回 null，否则返回给人看的原因。别名和自定义的模型名都按同一条字符规则查。 */
export function checkModel(vendor: AgentVendor, model: string | null): string | null {
  if (model === null) return null;
  if ([...model].length > MAX_MODEL_CHARS) return `模型名最多 ${MAX_MODEL_CHARS} 个字`;
  if (VENDOR_SPECS[vendor].models.some((m) => m.id === model)) return null;
  if (!VENDOR_SPECS[vendor].customModel) return `模型只能是 ${VENDOR_SPECS[vendor].models.map((m) => m.id).join("、")}`;
  return MODEL_NAME.test(model) ? null : MODEL_NAME_RULE;
}

export function checkEffort(vendor: AgentVendor, effort: string | null): string | null {
  if (effort === null || VENDOR_SPECS[vendor].efforts.includes(effort)) return null;
  return `思考程度只能是 ${VENDOR_SPECS[vendor].efforts.join("、")}`;
}

/** 厂商、模型、思考程度一起查（vendor 可以是任何值）。 */
export function checkAgentSetting(setting: { vendor: unknown; model: string | null; effort: string | null }): string | null {
  if (!isAgentVendor(setting.vendor)) return `厂商只能是 ${AGENT_VENDORS.join("、")}`;
  return checkModel(setting.vendor, setting.model) ?? checkEffort(setting.vendor, setting.effort);
}

/** 启动参数里模型、思考程度那几个（默认的不传）。 */
export function agentLaunchArgs(setting: AgentSetting): string[] {
  const { flags } = VENDOR_SPECS[setting.vendor];
  const args: string[] = [];
  if (setting.model !== null && setting.model !== "") args.push(flags.model, setting.model);
  if (setting.effort !== null && setting.effort !== "") args.push(flags.effort, setting.effort);
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
  /** 不含“默认”（默认 = 不传参数，界面自己加在最前面）。 */
  models: readonly CatalogModel[];
  /** 选“默认”时支持的思考程度，null = 没说。 */
  defaultEfforts: readonly string[] | null;
  /** “默认”实际用的模型的名字（如 Opus 5.5），厂商没说是 null（界面只写“默认”）。 */
  defaultModel: string | null;
  /** 这家的通用思考程度（VENDOR_SPECS 的 efforts）。 */
  efforts: readonly string[];
  /** 能不能填完整模型名，能的话输入框里的示例；不能是 null。 */
  customModelExample: string | null;
}

/** 打包在程序里的名单。 */
export function bundledModelCatalog(vendor: AgentVendor): ModelCatalog {
  const spec = VENDOR_SPECS[vendor];
  const models = spec.models.map((m) => ({ id: m.id, label: m.label, description: null, efforts: null }));
  return {
    vendor,
    label: spec.label,
    source: "bundled",
    models,
    defaultEfforts: null,
    defaultModel: null,
    efforts: spec.efforts,
    customModelExample: spec.customModel ? spec.customModelExample : null,
  };
}

/** 某个模型（null = 默认）能选的思考程度：名单里说了就按它（只留这家通用档位里有的，后台按通用档位校验），没说用通用档位。 */
export function effortsFor(catalog: ModelCatalog, model: string | null): readonly string[] {
  const all = catalog.efforts;
  const listed = model === null ? catalog.defaultEfforts : (catalog.models.find((m) => m.id === model)?.efforts ?? null);
  return listed === null ? all : all.filter((e) => listed.includes(e));
}

/** 模型下拉选中哪一项：默认是 ""，别的是模型名本身（名单里没有的，下拉里单独列一项“自定义：模型名”）。 */
export function modelChoiceOf(model: string | null): string {
  return model ?? "";
}

/** 界面、修改记录里显示的模型：默认；名单里有的用它的名字（没给名单用打包的）；别的原样。 */
export function modelLabel(vendor: AgentVendor, model: string | null, catalog: ModelCatalog = bundledModelCatalog(vendor)): string {
  if (model === null) return "默认";
  return catalog.models.find((m) => m.id === model)?.label ?? model;
}

/** 模型下拉里“默认”那一项：知道默认是哪个模型就写出来（“Opus 5.5（默认）”），不知道只写“默认”。 */
export function defaultModelOption(catalog: ModelCatalog): string {
  return catalog.defaultModel === null ? "默认" : `${catalog.defaultModel}（默认）`;
}

export function effortLabel(effort: string | null): string {
  return effort ?? "默认";
}

export function vendorLabel(vendor: string): string {
  return isAgentVendor(vendor) ? VENDOR_SPECS[vendor].label : vendor;
}

// ---- 出错的特征 ----
// 失败原因（消息的 failureReason、Worker 这一轮没做完的原因、定时任务没跑成的原因）是厂商给的原文。网页按通用的类型
// 出一句人话（web/errors.ts），各家的错误长什么样只写在这里。网络断了这类和厂商无关的特征在 web/errors.ts。

/** 失败的通用类型：服务繁忙、额度用完、网络断了、没能启动。认不出来的是 unknown（web/errors.ts）。 */
export type FailureKind = "busy" | "quota" | "network" | "start";

export interface VendorFailureSigns {
  /** 出错的话里称呼这家的服务：“Claude 服务繁忙”。 */
  serviceName: string;
  /** 按顺序匹配，先中先算。 */
  signs: readonly { kind: FailureKind; pattern: RegExp }[];
}

export const VENDOR_FAILURE_SIGNS: Readonly<Record<AgentVendor, VendorFailureSigns>> = {
  claude: {
    serviceName: "Claude",
    signs: [
      // 驱动层起不来 claude 的错误码（daemon/driver）
      { kind: "start", pattern: /^(claude_not_found|spawn_failed|start_timeout)\b/ },
      { kind: "quota", pattern: /usage limit|rate[_ ]?limit|\b429\b|credit balance|quota/i },
      { kind: "busy", pattern: /\b529\b|overloaded|api_error|\b5\d\d\b|internal server error|service unavailable/i },
    ],
  },
};

/** 认得出是哪家的哪类错误就返回，否则 null。 */
export function vendorFailureOf(raw: string): { kind: FailureKind; serviceName: string } | null {
  for (const vendor of AGENT_VENDORS) {
    const { serviceName, signs } = VENDOR_FAILURE_SIGNS[vendor];
    const hit = signs.find((s) => s.pattern.test(raw));
    if (hit) return { kind: hit.kind, serviceName };
  }
  return null;
}
