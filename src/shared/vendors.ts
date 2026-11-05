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
  /**
   * 额度（左下角）：厂商在事件里报的用量窗口（键是 RateLimitInfo.windows 里的键），按显示顺序；label 是浮层里的全名，
   * short 是左下角按钮上的简写。warningStatus：厂商自己报“快用完”时的状态值。没有额度数据的厂商不写。
   */
  quota?: { name: string; windows: readonly { key: string; label: string; short: string }[]; warningStatus: string };
  /** 完整模型名（名单里没有的）在列表里显示的短名，认不出来返回 null（原样显示）。 */
  shortModelName?: (model: string) => string | null;
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
    quota: {
      name: "Claude",
      windows: [
        { key: "five_hour", label: "5 小时", short: "5h" },
        { key: "seven_day", label: "7 天", short: "7d" },
      ],
      warningStatus: "allowed_warning",
    },
    // claude-sonnet-5-5、claude-opus-4-1-20250805、claude-sonnet-5-5[1m] → Sonnet 5.5、Opus 4.1、Sonnet 5.5 1M
    shortModelName: (model) => {
      const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/.exec(model);
      if (!m) return null;
      const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
      return [family, m[3] === undefined ? m[2] : `${m[2]}.${m[3]}`, m[4] ? "1M" : null].filter(Boolean).join(" ");
    },
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

/**
 * 列表里（右栏的 Worker 行）显示的模型：名单里有的用名单的名字；名单里没有的完整模型名按厂商的规则缩短（Sonnet 5.5）；
 * 默认（null）写厂商说的实际模型（ModelCatalog.defaultModel），厂商没说才写“默认”。
 */
export function modelShortLabel(vendor: AgentVendor, model: string | null, catalog: ModelCatalog = bundledModelCatalog(vendor)): string {
  if (model === null) return catalog.defaultModel ?? "默认";
  const label = modelLabel(vendor, model, catalog);
  return label === model ? (VENDOR_SPECS[vendor].shortModelName?.(model) ?? model) : label;
}

export function effortLabel(effort: string | null): string {
  return effort ?? "默认";
}

export function vendorLabel(vendor: string): string {
  return isAgentVendor(vendor) ? VENDOR_SPECS[vendor].label : vendor;
}
