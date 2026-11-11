// 厂商声明的类型（docs/vendor-plugin-design.md 3.2 节）：每家在 src/vendors/<id>/spec.ts 填一份 VendorSpec，名单在 registry.ts。
// 只放类型和纯函数：网页、hub 命令行、守护进程都引，不许 import node:*、src/daemon（契约测试 S2 查）。
// 公共代码一律按 vendorSpec(vendor) 读这里的分组字段（src/shared/vendors.ts），不再派生平铺的旧形状。
import type { QuotaWindowKey } from "../shared/vendors.ts";

/**
 * 事件流里没有额度、只能另起一次性进程问的厂商（agy：`agy -p "/usage"`，每行 “组名 TAB 窗口名 TAB 剩余百分比 TAB 重置时间”）。
 * groups：厂商分的组，每组在浮层里是一块；windows：窗口名（命令输出里的写法）对应的额度窗口。
 */
export interface FetchedQuotaSpec {
  args: readonly string[];
  groups: readonly { key: string; name: string; match: string }[];
  windows: Readonly<Record<string, QuotaWindowKey>>;
}

/**
 * 输入框里“/”命令的厂商数据（docs/composer-commands.md 实测）。怎么问命令列表、`@` 文件怎么写、怎么拼写进 agent 的内容
 * 这些要写代码的，在 src/vendors/<厂商>/composer.ts。
 */
interface ComposerSpec {
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

/** 失败的通用类型：服务繁忙、额度用完、网络断了、找不到程序、没能启动。认不出来的是 unknown（shared/errors.ts）。 */
export type FailureKind = "busy" | "quota" | "network" | "missing" | "start" | "auth" | "context";

/**
 * 工具的通用动作（docs/vendor-plugin-design.md 的 A16）：状态文案、hub worker log --stats 的分类只认这些（shared/step-labels.ts），
 * 不认厂商的工具名。各家在 spec 的 tools.actions 里把自己的工具名翻成它。
 * read、edit、write 的文案带文件名（Reading a.ts）；web_search、web_fetch 都算“上网”类；connector：调用连接器（MCP）工具；connector_resource：列 / 读连接器（MCP）的资源。
 */
export type ToolAction =
  | "command"
  | "read"
  | "edit"
  | "write"
  | "search"
  | "web_search"
  | "web_fetch"
  | "skill"
  | "subagent"
  | "todo"
  | "tool_search"
  | "connector"
  | "connector_resource";

/** 该厂商跑 Router 轨道 B 单轮极速分派时的默认快模型预设（docs/router-design.md 6.1 节）。 */
export interface RouterModelPreset {
  /** 该厂商跑 Router 轨道 B 单轮分派时的默认极快模型 ID。 */
  readonly model: string;
  /** 该厂商对应的最低思考档位（须在该模型支持的 efforts 内）。 */
  readonly effort: string;
}

export interface VendorModelsSpec {
  /** 打包的模型名单（问不到厂商时用）：id 原样传给 flags.model，label 是界面上的名字。 */
  bundled: readonly { id: string; label: string; efforts?: readonly string[] }[];
  /** 能不能填完整模型名（下拉里的“自定义”）。 */
  customModel: boolean;
  /** 自定义模型名输入框里的示例。 */
  customModelExample: string;
  /** 思考程度，原样传给 flags.effort（effortInModelId 的厂商拼进模型 ID）。 */
  efforts: readonly string[];
  /** Router 轨道 B 单轮分派默认极快模型与最低思考档位预设。 */
  readonly routerDefault: RouterModelPreset;
  /**
   * 思考程度写在模型 ID 末尾（agy：gemini-4-argon-high）。界面把它拆成“模型 + 思考程度”（和 Antigravity 软件一致），
   * 启动时再拼回完整 ID 传给 flags.model，不再传 flags.effort（agy 对两个都传且对不上会报错）。
   */
  effortInModelId?: boolean;
  /** 模型、思考程度的命令行参数名（ACP 等通过会话协议传模型与档位的厂商不写）。 */
  flags?: { model: string; effort: string };
  /** 完整模型名（名单里没有的）在列表里显示的短名，认不出来返回 null（原样显示）。 */
  shortName?: (model: string) => string | null;
}

interface VendorCapabilities {
  /**
   * 能不能把长命令放后台跑、跑完自动开新一轮叫醒 agent（见 docs/mid-turn-messages.md 第 10 节）。
   * false：提示词让项目经理把长命令派给 Worker。
   */
  backgroundWake: boolean;
  /** 只读 Worker 怎么落实：settings=写进厂商设置文件的原生沙箱；driver=驱动层原生参数；os_sandbox=依赖外层 OS 沙箱。 */
  readonly: "settings" | "driver" | "os_sandbox";
  /** 未选模型时把名单里的默认模型（ModelCatalog.defaultModelId）显式传给驱动。不写 = false。 */
  explicitDefaultModel?: boolean;
  /**
   * 包进 OS 沙箱时加在命令行最前面、关掉这家自带沙箱的参数（macOS 沙箱不能嵌套；daemon/driver/write-scope.ts 的 WRITE_SCOPE_ENFORCERS 按它推）。
   * 不写 = 不在命令行上关（claude 写在设置文件里、codex 用 sandboxPolicy）。
   */
  ownSandboxOffArgs?: readonly string[];
}

export interface VendorSpec<Id extends string = string> {
  /** 存进 agent_sessions.vendor、pms.vendor，发布后不改。只用小写字母数字（契约测试 S3 查）。 */
  id: Id;
  /** 界面上的名字。 */
  label: string;
  cli: {
    /** 默认可执行文件名；也用于提示词里“严禁直接调 CLI”的列表。 */
    command: string;
    /** 覆盖可执行文件路径的环境变量，约定 AGENT_HUB_<大写 id>（契约测试 S3 查）。 */
    envVar: string;
    /** 在终端里登录这家要跑的命令（没登录时报错里告诉用户）。 */
    loginCommand: string;
  };
  /**
   * 凭据和配置目录（相对用户主目录）：
   * - dirs：整个目录（或文件）。分享文件时一律禁（daemon/sent-files.ts 的 SENSITIVE_HOME_PATHS）；
   * - readonlySecrets：只读 Worker 禁读的具体文件（readonly-policy.ts 的 READONLY_SECRET_HOME_PATHS，粒度比 dirs 细：
   *   会话记录、日志留给排查读），必须在 dirs 里面；
   * - catalogWatchPaths：影响模型名单或登录状态的本地配置/凭据/缓存文件（必须在 dirs 里面），stat 指纹变化时立即刷新模型目录缓存；
   * - configHome：配置根目录能被环境变量改位置的（codex 的 CODEX_HOME）：catalogWatchPaths 里以 rel 开头的换到环境变量给的目录下。
   */
  home: {
    dirs: readonly string[];
    readonlySecrets: readonly string[];
    catalogWatchPaths: readonly string[];
    configHome?: { rel: string; env: string };
  };
  models: VendorModelsSpec;
  /**
   * 额度（左下角）：厂商在事件里报的用量窗口（QUOTA_WINDOWS 的键，也是 RateLimitInfo.windows 里的键），按显示顺序。
   * warningStatus：厂商自己报“快用完”时的状态值，不报的不写。fetched：要另起进程问的。没有额度数据的厂商整个不写。
   */
  quota?: { name: string; windows: readonly QuotaWindowKey[]; warningStatus?: string; fetched?: FetchedQuotaSpec };
  /** 输入框的命令（纯数据；用它的代码在 daemon/vendors/）。 */
  composer: ComposerSpec;
  prompt: {
    /** 厂商内置子代理工具名（提示词里严禁直接调用的列表）。 */
    subagentTools: readonly string[];
    /** 后台运行长命令的工具写法说明（如 "Bash 工具的 `run_in_background`"）；用于拼提示词。 */
    backgroundCommandTool: string;
    /**
     * 需要提醒先读 AGENTS.md 的说明文件（CLAUDE.md 沿用迁移前的条件）。只在它和 AGENTS.md 都在、它里面又没写 @AGENTS.md 时，
     * 提示词才加一句“先读 AGENTS.md”（daemon/prompt.ts 的 needsAgentsNote）。不写 = 这家自己读 AGENTS.md，不加。
     */
    instructionFile?: string;
    /** 换厂商写交接时举例“别写只有这家才有的工具用法”（daemon/ledger/handover.ts）。不写就不举例。 */
    vendorOnlyTools?: string;
  };
  failure: {
    /** 出错的话里称呼这家的服务：“Claude 服务繁忙”。 */
    serviceName: string;
    /** 没告诉是哪家时，原文里认出是这家的特征。 */
    rawHint?: RegExp;
    /** 几家的 rawHint 同时命中时谁先认，大的先（不写 = 0，同分按名单顺序）。转接别家模型的厂商报错里常带别家的模型名，要排前面。 */
    rawHintPriority?: number;
  };
  handover?: {
    /** 项目经理自动换新会话的上下文 token 阈值。不写 = HANDOVER_TOKEN_THRESHOLD。 */
    tokenThreshold?: number;
    /** 原始记录别家能不能直接读（agy 的是 sqlite 库：false，换到别家时交接里不给路径）。不写 = true（纯文本）。 */
    transcriptPortable?: boolean;
  };
  /**
   * 工具名（驱动层 agent.tool 事件里原样的名字）→ 通用动作（shared/step-labels.ts 按它出文案、分类）。几家的名单合在一起查，
   * 所以同一个名字在各家要是同一个动作（契约测试查）。没列的工具显示“Using <名字>”，统计里按原名单独计数；mcp__ 开头的另按连接器认。
   */
  tools?: { actions: Readonly<Record<string, ToolAction>> };
  capabilities: VendorCapabilities;
}

/** 写 spec.ts 用：只做类型检查并把编号推成字面量类型（AgentVendor 从名单推出来）。 */
export function defineVendor<const Id extends string>(
  spec: VendorSpec<Id> & { models: { flags: { model: string; effort: string } } },
): VendorSpec<Id> & { models: { flags: { model: string; effort: string } } };
export function defineVendor<const Id extends string>(spec: VendorSpec<Id>): VendorSpec<Id>;
export function defineVendor<const Id extends string>(spec: VendorSpec<Id>): VendorSpec<Id> {
  return spec;
}

/** 一组隐藏命令共用一个拦下的原因。 */
export function blockedCommands(reason: string, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, reason]));
}

/** 首字母大写（shortName 拼名字用）。 */
export function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
