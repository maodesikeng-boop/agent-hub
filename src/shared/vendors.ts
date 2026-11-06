// 厂商清单：每家厂商打包的模型名单、哪些思考程度、对应的命令行参数。网页（下拉）和后台（校验、启动参数）都从这里读，
// 加厂商只改这一个文件（问厂商要模型名单的代码在 daemon/driver/model-catalog.ts）。“默认”一律是 null，表示不传对应的参数，用厂商自己的默认。
// agent_sessions.vendor、pms.vendor 存的就是这里的厂商编号。
import { MAX_MODEL_CHARS } from "./limits.ts";

export const AGENT_VENDORS = ["claude", "agy", "codex"] as const;
export type AgentVendor = (typeof AGENT_VENDORS)[number];
export const DEFAULT_AGENT_VENDOR: AgentVendor = "claude";

export interface VendorSpec {
  /** 界面上的名字。 */
  label: string;
  /** 打包的模型名单（问不到厂商时用）：id 原样传给 modelFlag，label 是界面上的名字。 */
  models: readonly { id: string; label: string; efforts?: readonly string[] }[];
  /** 能不能填完整模型名（下拉里的“自定义”）。 */
  customModel: boolean;
  /** 自定义模型名输入框里的示例。 */
  customModelExample: string;
  /** 思考程度，原样传给 effortFlag（effortInModelId 的厂商拼进模型 ID）。 */
  efforts: readonly string[];
  /**
   * 思考程度写在模型 ID 末尾（agy：gemini-4-argon-high）。界面把它拆成“模型 + 思考程度”（和 Antigravity 软件一致），
   * 启动时再拼回完整 ID 传给 modelFlag，不再传 effortFlag（agy 对两个都传且对不上会报错）。
   */
  effortInModelId?: boolean;
  modelFlag: string;
  effortFlag: string;
  flags: { model: string; effort: string };
  quotaWindows: Readonly<Record<string, string>>;
  /**
   * 额度（左下角）：厂商在事件里报的用量窗口（键是 RateLimitInfo.windows 里的键），按显示顺序；label 是浮层里的全名，
   * short 是左下角按钮上的简写。warningStatus：厂商自己报“快用完”时的状态值。没有额度数据的厂商不写。
   */
  quota?: { name: string; windows: readonly { key: string; label: string; short: string }[]; warningStatus: string };
  /** 完整模型名（名单里没有的）在列表里显示的短名，认不出来返回 null（原样显示）。 */
  shortModelName?: (model: string) => string | null;
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
  /** 压缩上下文的命令名（不带开头的 /）：这一轮只压缩、不回话，项目经理发了它不会有汇报。 */
  compactCommand: string;
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

/** agy 的思考程度：和 Antigravity 软件一样三档（实测 xhigh、max 被 agy 拒绝）。 */
const AGY_EFFORTS: readonly string[] = ["low", "medium", "high"];

const AGY_SESSION_BLOCKED = "会话由 agent-hub 管，这里不能用这个命令；项目经理要开新会话，请点右上角“开新会话”按钮";
const AGY_MODEL_BLOCKED = "换模型、思考程度请在资料页改（Worker 的由项目经理派活时定）";
const AGY_ACCOUNT_BLOCKED = "账号相关的命令这里不能用，请在终端里打开 agy";
const AGY_TERMINAL_BLOCKED = "交互式命令不能在后台会话跑，请在终端界面里打开 agy";

const CODEX_SESSION_BLOCKED = "会话由 agent-hub 管，这里不能用这个命令；项目经理要开新会话，请点右上角“开新会话”按钮";
const CODEX_MODEL_BLOCKED = "换模型、思考程度请在资料页改（Worker 的由项目经理派活时定）";
const CODEX_ACCOUNT_BLOCKED = "账号相关的命令这里不能用，请在终端里打开 codex";
const CODEX_SANDBOX_BLOCKED = "权限和沙箱由 agent-hub 管，这里不能用这个命令";

function blocked(reason: string, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, reason]));
}

function cap(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
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
    modelFlag: "--model",
    effortFlag: "--effort",
    flags: { model: "--model", effort: "--effort" },
    quotaWindows: { five_hour: "5 小时", seven_day: "7 天" },
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
      const family = cap(m[1]!);
      return [family, m[3] === undefined ? m[2] : `${m[2]}.${m[3]}`, m[4] ? "1M" : null].filter(Boolean).join(" ");
    },
    composer: {
      commandPrefix: "/",
      compactCommand: "compact",
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
        ...blocked(CLAUDE_ACCOUNT_BLOCKED, ["login", "logout", "usage-credits", "extra-usage", "design", "design-consent", "design-revoke"]),
        // system/init 的 terminal_slash_commands 标出来的四个，加上 heapdump（往桌面写文件）
        ...blocked(CLAUDE_TERMINAL_BLOCKED, ["doctor", "checkup", "color", "focus", "reload-plugins", "heapdump"]),
      },
    },
  },
  agy: {
    label: "Antigravity",
    // 2026-11-06 `agy models` 的实际内容去掉档位后的样子（docs/model-catalog.md）；拿不到名单时兜底
    models: [
      { id: "gemini-4-argon", label: "Gemini 4 Argon", efforts: AGY_EFFORTS },
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", efforts: AGY_EFFORTS },
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", efforts: AGY_EFFORTS },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", efforts: AGY_EFFORTS },
      { id: "gpt-oss-120b", label: "GPT-OSS 120B", efforts: ["medium"] },
    ],
    customModel: true,
    customModelExample: "如 gemini-4-argon",
    efforts: AGY_EFFORTS,
    effortInModelId: true,
    modelFlag: "--model",
    effortFlag: "--effort",
    flags: { model: "--model", effort: "--effort" },
    quotaWindows: { five_hour: "5 小时", seven_day: "7 天" },
    // 不带档位的模型名（档位另外显示）：gemini-4-argon、gemini-3.8-flash、claude-opus-5-5、gpt-oss-120b → Gemini 4 Argon、Gemini 3.8 Flash、Claude Opus 5.5、GPT-OSS 120B
    shortModelName: (model) => {
      const gemini = /^gemini-(\d+(?:\.\d+)?)-([a-z]+)$/.exec(model);
      if (gemini) return `Gemini ${gemini[1]} ${cap(gemini[2]!)}`;
      const claude = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model);
      if (claude) return `Claude ${cap(claude[1]!)} ${claude[3] === undefined ? claude[2] : `${claude[2]}.${claude[3]}`}`;
      const gptOss = /^gpt-oss-(\d+b)$/i.exec(model);
      if (gptOss) return `GPT-OSS ${gptOss[1]!.toUpperCase()}`;
      return null;
    },
    composer: {
      commandPrefix: "/",
      compactCommand: "compact",
      blockedCommands: {
        ...blocked(AGY_SESSION_BLOCKED, ["clear", "resume"]),
        ...blocked(AGY_ACCOUNT_BLOCKED, ["logout", "login"]),
        ...blocked(AGY_MODEL_BLOCKED, ["model", "effort", "mode"]),
        ...blocked(AGY_TERMINAL_BLOCKED, ["update", "doctor", "color", "focus"]),
      },
    },
  },
  codex: {
    label: "Codex",
    models: [
      { id: "gpt-5.4", label: "GPT-5.4" },
      { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
      { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    ],
    customModel: true,
    customModelExample: "如 gpt-5.4",
    efforts: ["low", "medium", "high", "xhigh"],
    modelFlag: "--model",
    effortFlag: "-c",
    flags: { model: "--model", effort: "-c" },
    quotaWindows: { five_hour: "5 小时", seven_day: "7 天" },
    shortModelName: (model) => {
      const gpt = /^gpt-(\d+(?:\.\d+)?)(?:-([a-z]+))?$/.exec(model);
      if (!gpt) return null;
      return gpt[2] === undefined ? `GPT-${gpt[1]}` : `GPT-${gpt[1]} ${cap(gpt[2])}`;
    },
    composer: {
      commandPrefix: "/",
      compactCommand: "compact",
      blockedCommands: {
        ...blocked(CODEX_SESSION_BLOCKED, ["clear", "new", "resume", "fork", "quit", "exit"]),
        ...blocked(CODEX_ACCOUNT_BLOCKED, ["login", "logout"]),
        ...blocked(CODEX_MODEL_BLOCKED, ["model"]),
        ...blocked(CODEX_SANDBOX_BLOCKED, ["approvals", "permissions", "sandbox"]),
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

/**
 * 思考程度写在模型 ID 里的厂商（agy）：完整 ID 拆成 模型 + 思考程度。末尾是这家清单里的档位词（-low、-medium、-high）才拆；
 * 不带档位的、默认（null）、别家厂商原样返回。ID 里的档位优先于另存的 effort（启动时 agy 认的就是 ID）。
 * 老数据里存的是完整 ID，界面、右栏用它显示成“模型 + 档位”。
 */
export function splitModelEffort(vendor: AgentVendor, model: string | null, effort: string | null): { model: string | null; effort: string | null } {
  // 网页的厂商来自名单，名单里可能有这里没有的厂商（测试里的假厂商），所以 spec 可能是 undefined
  const spec = VENDOR_SPECS[vendor] as VendorSpec | undefined;
  if (!spec?.effortInModelId || model === null) return { model, effort };
  const split = splitEffortSuffix(model, spec.efforts);
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
export function checkModelEffort(vendor: AgentVendor, model: string | null, effort: string | null): string | null {
  if (effort === null) return null;
  const split = splitModelEffort(vendor, model, null);
  if (split.effort === null || split.effort === effort) return null;
  return `模型 ${model} 已经带了思考程度 ${split.effort}，和 ${effort} 对不上；请用不带档位的 ${split.model} 再选思考程度，或者去掉思考程度`;
}

/** 厂商、模型、思考程度一起查（vendor 可以是任何值）。 */
export function checkAgentSetting(setting: { vendor: unknown; model: string | null; effort: string | null }): string | null {
  if (!isAgentVendor(setting.vendor)) return `厂商只能是 ${AGENT_VENDORS.join("、")}`;
  return (
    checkModel(setting.vendor, setting.model) ??
    checkEffort(setting.vendor, setting.effort) ??
    checkModelEffort(setting.vendor, setting.model, setting.effort)
  );
}

/**
 * 启动参数里模型、思考程度那几个（默认的不传）。思考程度在模型 ID 里的厂商（agy）：不带档位的模型 + 思考程度拼成完整 ID
 * 一个 --model（gemini-4-argon + high → gemini-4-argon-high），不再另传 --effort；只有思考程度才传 --effort。
 */
export function agentLaunchArgs(setting: AgentSetting): string[] {
  const spec = VENDOR_SPECS[setting.vendor];
  const args: string[] = [];
  const hasModel = setting.model !== null && setting.model !== "";
  const hasEffort = setting.effort !== null && setting.effort !== "";
  if (spec.effortInModelId && hasModel) {
    const { model, effort } = splitModelEffort(setting.vendor, setting.model, hasEffort ? setting.effort : null);
    args.push(spec.modelFlag, effort === null ? model! : `${model}-${effort}`);
    return args;
  }
  if (hasModel) args.push(spec.modelFlag, setting.model!);
  if (hasEffort) args.push(spec.effortFlag, setting.effort!);
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
  const models = spec.models.map((m) => ({ id: m.id, label: m.label, description: null, efforts: m.efforts ?? null }));
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

/** 界面、修改记录里显示的模型：默认；名单里有的用它的名字（没给名单用打包的；带档位的完整 ID 只取模型的名字）；别的原样。 */
export function modelLabel(vendor: AgentVendor, model: string | null, catalog: ModelCatalog = bundledModelCatalog(vendor)): string {
  if (model === null) return "默认";
  const listed = catalog.models.find((m) => m.id === model);
  if (listed) return listed.label;
  // 老数据存的是带档位的完整 ID（agy）：只显示模型的名字，档位另外显示（agentEffortOf），不拼在一起
  const bare = splitModelEffort(vendor, model, null).model!;
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
  const bare = splitModelEffort(vendor, model, null).model!;
  const label = modelLabel(vendor, bare, catalog);
  return label === bare ? (VENDOR_SPECS[vendor].shortModelName?.(bare) ?? bare) : label;
}

/** 列表里显示的思考程度：另存的，或者老数据里写在模型 ID 末尾的（ID 优先）。 */
export function agentEffortOf(vendor: AgentVendor, model: string | null, effort: string | null): string | null {
  return splitModelEffort(vendor, model, effort).effort;
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
export type FailureKind = "busy" | "quota" | "network" | "start" | "auth" | "context";

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

export const VENDOR_FAILURE_SIGNS: Readonly<Record<AgentVendor, VendorFailureSigns>> = {
  claude: {
    serviceName: "Claude",
    auth: COMMON_AUTH_PATTERN,
    quota: COMMON_QUOTA_PATTERN,
    context: COMMON_CONTEXT_PATTERN,
    signs: [
      // 驱动层起不来 claude 的错误码（daemon/driver）
      { kind: "start", pattern: /^(claude_not_found|spawn_failed|start_timeout)\b/ },
      { kind: "quota", pattern: COMMON_QUOTA_PATTERN },
      { kind: "busy", pattern: COMMON_BUSY_PATTERN },
      { kind: "auth", pattern: COMMON_AUTH_PATTERN },
      { kind: "context", pattern: COMMON_CONTEXT_PATTERN },
    ],
  },
  agy: {
    serviceName: "Antigravity",
    auth: COMMON_AUTH_PATTERN,
    quota: COMMON_QUOTA_PATTERN,
    context: COMMON_CONTEXT_PATTERN,
    signs: [
      { kind: "start", pattern: /^(agy_not_found|spawn_failed|start_timeout)\b/ },
      { kind: "quota", pattern: COMMON_QUOTA_PATTERN },
      { kind: "busy", pattern: COMMON_BUSY_PATTERN },
      { kind: "auth", pattern: COMMON_AUTH_PATTERN },
      { kind: "context", pattern: COMMON_CONTEXT_PATTERN },
    ],
  },
  codex: {
    serviceName: "Codex",
    auth: COMMON_AUTH_PATTERN,
    quota: COMMON_QUOTA_PATTERN,
    context: COMMON_CONTEXT_PATTERN,
    signs: [
      { kind: "start", pattern: /^(codex_not_found|spawn_failed|start_timeout)\b/ },
      { kind: "quota", pattern: COMMON_QUOTA_PATTERN },
      { kind: "busy", pattern: COMMON_BUSY_PATTERN },
      { kind: "auth", pattern: COMMON_AUTH_PATTERN },
      { kind: "context", pattern: COMMON_CONTEXT_PATTERN },
    ],
  },
};

/** 从原文的特征词推断优先检查哪家厂商（如含 agy/antigravity 优先判 agy，含 codex/openai/chatgpt 优先判 codex）。 */
function inferVendorFromRaw(raw: string): AgentVendor | null {
  if (/^agy_not_found\b|\bagy\b|antigravity/i.test(raw)) return "agy";
  if (/^codex_not_found\b|\bcodex\b|openai|chatgpt/i.test(raw)) return "codex";
  if (/^claude_not_found\b|\bclaude\b|anthropic/i.test(raw)) return "claude";
  return null;
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
