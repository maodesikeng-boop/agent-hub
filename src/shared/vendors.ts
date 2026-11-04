// 厂商清单：每家厂商有哪些模型、哪些思考程度、对应的命令行参数。网页（下拉）和后台（校验、启动参数）都从这里读，
// 加厂商只改这一个文件。“默认”一律是 null，表示不传对应的参数，用厂商自己的默认。
// agent_sessions.vendor、pms.vendor 存的就是这里的厂商编号。
import { MAX_MODEL_CHARS } from "./limits.ts";

export const AGENT_VENDORS = ["claude"] as const;
export type AgentVendor = (typeof AGENT_VENDORS)[number];
export const DEFAULT_AGENT_VENDOR: AgentVendor = "claude";

export interface VendorSpec {
  /** 界面上的名字。 */
  label: string;
  /** 下拉里的模型：id 原样传给 modelFlag，label 是界面上的名字。 */
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

/** 模型下拉里“自定义”那一项的值。 */
export const CUSTOM_MODEL = "custom";

/** 模型下拉选中哪一项：默认是 ""，清单里的别名是它自己，别的是 CUSTOM_MODEL。 */
export function modelChoiceOf(vendor: AgentVendor, model: string | null): string {
  if (model === null) return "";
  return VENDOR_SPECS[vendor].models.some((m) => m.id === model) ? model : CUSTOM_MODEL;
}

/** 界面、修改记录里显示的模型：默认、别名的名字，完整模型名原样。 */
export function modelLabel(vendor: AgentVendor, model: string | null): string {
  if (model === null) return "默认";
  return VENDOR_SPECS[vendor].models.find((m) => m.id === model)?.label ?? model;
}

export function effortLabel(effort: string | null): string {
  return effort ?? "默认";
}

export function vendorLabel(vendor: string): string {
  return isAgentVendor(vendor) ? VENDOR_SPECS[vendor].label : vendor;
}
