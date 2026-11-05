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
  /** 输入框的命令（纯数据；用它的代码在 daemon/vendors/）。 */
  composer: ComposerSpec;
}

/**
 * 输入框里“/”命令的厂商数据（docs/composer-commands.md 实测）。怎么问命令列表、`@` 文件怎么写、怎么拼写进 agent 的内容
 * 这些要写代码的，在 daemon/vendors/<厂商>.ts。
 */
export interface ComposerSpec {
  /** 命令的开头：用户原文以它开头（前面不能有空格）才算命令。 */
  commandPrefix: string;
  /**
   * 隐藏的命令（不带开头的 /，别名也要写上）→ 用户手打时拦下、告诉用户的原因。这些不进列表，手打的也不发给 agent：
   * 会打乱 hub 管着的会话（换会话 ID）、和资料页的设置打架、或者只能在终端界面里用。
   */
  blockedCommands: Readonly<Record<string, string>>;
}

// claude 的隐藏命令：按“为什么拦”分组，原因是给用户看的一句（docs/composer-commands.md 的 T1、T2、T7）
const CLAUDE_SESSION_BLOCKED = "会话由 agent-hub 管，这里不能用这个命令；项目经理要开新会话，请用资料页的“开新会话”按钮";
const CLAUDE_MODEL_BLOCKED = "换模型、思考程度请在资料页改（Worker 的由项目经理派活时定）";
const CLAUDE_SETTINGS_BLOCKED = "这个命令会改 claude 自己的设置，这里不能用；要改请在终端里打开 claude";
const CLAUDE_ACCOUNT_BLOCKED = "账号相关的命令这里不能用，请在终端里打开 claude";
const CLAUDE_TERMINAL_BLOCKED = "这个命令只能在终端界面里用";

function blocked(reason: string, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, reason]));
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
    composer: {
      commandPrefix: "/",
      blockedCommands: {
        // /clear 会换会话 ID，我们 --resume 的还是旧的（T7）
        ...blocked(CLAUDE_SESSION_BLOCKED, ["clear", "reset", "new", "resume", "exit", "quit", "rename", "name"]),
        ...blocked(CLAUDE_MODEL_BLOCKED, ["model", "effort", "fast", "advisor"]),
        ...blocked(CLAUDE_SETTINGS_BLOCKED, [
          "config",
          "settings",
          "output-style",
          "autocompact",
          "mcp",
          "agents",
          "auto-mode-setup",
          "import",
          "debug",
          "goal",
          "__remote-workflow",
          "workflow-launch-exec",
        ]),
        ...blocked(CLAUDE_ACCOUNT_BLOCKED, ["login", "logout", "usage-credits", "extra-usage", "design-consent", "design-revoke"]),
        // system/init 的 terminal_slash_commands 标出来的四个，加上 heapdump（往桌面写文件）
        ...blocked(CLAUDE_TERMINAL_BLOCKED, ["doctor", "checkup", "color", "focus", "reload-plugins", "heapdump"]),
      },
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

export interface ModelCatalog {
  vendor: AgentVendor;
  /** vendor：厂商自己报的；bundled：打包在程序里的（厂商没装、超时、报错时）。 */
  source: "vendor" | "bundled";
  /** 不含“默认”（默认 = 不传参数，界面自己加在最前面）。 */
  models: readonly CatalogModel[];
  /** 选“默认”时支持的思考程度，null = 没说。 */
  defaultEfforts: readonly string[] | null;
}

/** 打包在程序里的名单。 */
export function bundledModelCatalog(vendor: AgentVendor): ModelCatalog {
  const models = VENDOR_SPECS[vendor].models.map((m) => ({ id: m.id, label: m.label, description: null, efforts: null }));
  return { vendor, source: "bundled", models, defaultEfforts: null };
}

/** 某个模型（null = 默认）能选的思考程度：名单里说了就按它（只留厂商通用档位里有的，后台按通用档位校验），没说用通用档位。 */
export function effortsFor(catalog: ModelCatalog, model: string | null): readonly string[] {
  const all = VENDOR_SPECS[catalog.vendor].efforts;
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

export function effortLabel(effort: string | null): string {
  return effort ?? "默认";
}

export function vendorLabel(vendor: string): string {
  return isAgentVendor(vendor) ? VENDOR_SPECS[vendor].label : vendor;
}
