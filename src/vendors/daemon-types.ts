// 守护进程侧每家厂商交出来的东西（docs/vendor-plugin-design.md 3.3 节）：src/vendors/<id>/daemon.ts 默认导出一个 VendorDaemon，
// daemon-registry.ts 按名单加载；src/vendors/<id>/paths.ts 放只给守护进程用的路径（PATH 里找不到可执行文件时去哪找）。
// 只给守护进程用（会 import 驱动、起进程的代码），网页不引。现有的接口（VendorComposerBase、VendorCatalogProbe、SessionForker、Driver）原样复用。
import type {
  AgentVendor,
  Driver,
  DriverOptions,
  ProviderAuthMethodDescriptor,
  ReadonlyPolicy,
  SessionRole,
  VendorAvailability,
} from "../shared/index.ts";
import type { TranscriptRef, TranscriptRoots } from "../daemon/driver/transcript-files.ts";
import type { VendorCatalogSource } from "../daemon/driver/model-catalog.ts";
import type { SessionForker } from "../daemon/handover/forker.ts";
import type { VendorCatalogProbe, VendorCatalogSourceOptions, VendorComposer, VendorComposerBase } from "../daemon/vendors/types.ts";

/** 起驱动要的东西（守护进程给）：通用的 DriverOptions（executablePath 是解析好的可执行文件），加上按家可选的。 */
export interface VendorDriverDeps extends DriverOptions {
  /** 输入框不起进程的那部分；不给用这家自己的（daemon/vendors/index.ts 的 createVendorDrivers 按名单给）。 */
  composer?: VendorComposerBase;
  /** 未选模型时用的默认模型（spec 的 capabilities.explicitDefaultModel 为 true 的厂商才给）。 */
  defaultModel?: () => Promise<string | null>;
}

/** 起进程问命令列表要的东西（守护进程给）。 */
export interface VendorComposerDeps {
  executablePath: string | (() => string);
  env?: Record<string, string | undefined> | (() => Record<string, string | undefined>);
  timeoutMs?: number;
}

export interface VendorDaemon {
  /** 必需：会话驱动（启动、恢复、发消息、打断、结束、清残留）。 */
  createDriver(deps: VendorDriverDeps): Driver;
  /**
   * 可选：输入框（"/" 命令、"@" 文件）。base 不起进程（账本、驱动层拼消息用），create 带上另起进程问命令列表。
   * 缺了用 _common/composer.ts：只认 spec.composer 的命令开头、隐藏名单，命令列表只有压缩命令。
   */
  composer?: { base: VendorComposerBase; create(deps: VendorComposerDeps): VendorComposer };
  /** 可选：模型名单和登录状态（同一次查询，不得打开会话、连 MCP、跑钩子）。缺了用打包的名单，状态 unknown（当能用）。 */
  catalog?: { probe: VendorCatalogProbe; source(options: VendorCatalogSourceOptions): VendorCatalogSource };
  /** 可选：换会话复制原对话的办法，按顺序试（id 所有厂商之间唯一，契约 S9）。缺了 = []，在本会话里写交接。 */
  forkers?: readonly SessionForker[];
  /** 可选：原始记录在哪（只读文件系统，找不到返回 null，不抛）。缺了 = null，交接里不给路径。 */
  transcriptPath?(ref: TranscriptRef, roots: TranscriptRoots): string | null;
  /**
   * 可选：这个会话在用户目录里留下的全部文件和目录（原始记录和它附带的）。只算路径、不删；冒烟测试收尾按它删（test/smoke/kit.ts）。
   * 缺了 = 不删。
   */
  sessionFiles?(ref: TranscriptRef, roots: TranscriptRoots): string[];
  /** 可选：每次启动前要生成的这家专属的东西（claude 的 --settings 文件、Worker 多设的环境变量）。缺了不生成（docs/vendor-plugin-design.md 的 A15）。 */
  launchFiles?(input: VendorLaunchInput): VendorLaunchFiles;
  /** 可选：全厂商 MCP、云端连接器与 Skill 扫描及局部补丁适配器（daemon/vendor-sync/）。 */
  sync?: VendorSyncAdapter;
  /** 可选：Settings → Providers 一键安装、更新与界面内直接登录适配器（daemon/provider-manager/）。 */
  setup?: VendorSetupAdapter;
}

export type VendorNpmExtraArg = "--ignore-scripts" | "--min-release-age=0";

export interface VendorNpmInstallRecipe {
  readonly kind: "npm";
  readonly packageSpec: string;
  readonly extraArgs?: readonly VendorNpmExtraArg[];
}

export type VendorInstallRecipe =
  | VendorNpmInstallRecipe
  | {
      readonly kind: "posix_script";
      readonly scriptUrl: string;
      readonly shell: "bash" | "sh";
      readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
      readonly fallback?: VendorNpmInstallRecipe;
    }
  | {
      readonly kind: "powershell_script";
      readonly scriptUrl: string;
      readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
      /** PowerShell 受组策略限制失败时的免脚本回退配方（如回退受管 npm 安装）。 */
      readonly fallback?: VendorNpmInstallRecipe;
    };

export type VendorUpdateRecipe =
  | { readonly kind: "reinstall" }
  | {
      readonly kind: "cli_subcommand";
      readonly args: readonly string[];
      readonly canUse?: (binaryPath: string, platform: string) => boolean;
      readonly fallbackToReinstall?: boolean;
    };

/** 守护进程受管密钥库（`<stateDir>/provider-secrets.json`，0600，绝不写日志或 SQLite）。 */
export interface ManagedProviderSecrets {
  /** 返回指定厂商已配置的受管环境变量键名列表（不含明文）。 */
  keys(vendor: AgentVendor): string[];
  /** 判断指定厂商某环境变量是否配置了非空值。 */
  has(vendor: AgentVendor, envName: string): boolean;
  /** 读取指定厂商全部受管环境变量键值（仅供注入该厂商自身子进程环境）。 */
  getEnv(vendor: AgentVendor): Readonly<Record<string, string>>;
  /** 原子更新指定厂商的受管环境变量键值。 */
  set(vendor: AgentVendor, entries: Readonly<Record<string, string>>): void;
  /** 原子移除指定厂商的受管环境变量（不传 names 则清空该厂商全部受管密钥）。 */
  remove(vendor: AgentVendor, names?: readonly string[]): void;
  /** 返回不含明文的修订指纹（供模型目录缓存感知密钥变更）。 */
  fingerprint(vendor: AgentVendor): string;
}

export interface VendorSetupContext {
  readonly platform: string;
  readonly userHome: string;
  readonly availability: VendorAvailability;
  readonly executablePath: () => string;
  readonly installed: () => boolean;
  readonly env: () => Record<string, string | undefined>;
  readonly secrets: ManagedProviderSecrets;
}

export interface AuthFlowHooks {
  /** 通知引擎已捕获浏览器 OAuth 授权 URL（引擎自动解析并登记回环回调契约）。 */
  onAuthorizeUrl(url: string): void;
  /** 通知引擎已拿到 Device Code 验证页与一次性设备验证码。 */
  onDeviceCode(payload: { verificationUrl: string; userCode: string }): void;
  /** 注册接收用户手动粘贴的授权码回调（回环回调 URL 由引擎经 6 重防 SSRF 校验后直接转发）。 */
  onUserInput(handler: (input: string) => void | Promise<void>): void;
}

export interface VendorSetupAdapter {
  /** 按目标平台返回白名单安装配方（禁止任意 shell 字符串）。 */
  installRecipe(platform: string): VendorInstallRecipe;
  /** 返回更新配方。 */
  updateRecipe(platform: string): VendorUpdateRecipe;
  /** 可选版本解析参数（默认 ["--version"]，结果按二进制 stat 指纹缓存）。 */
  versionArgs?: readonly string[];
  /** 返回当前环境下该厂商支持的界面内登录方法列表与已登录摘要（0 子进程轻量检查）。 */
  inspectAuth(ctx: VendorSetupContext): Promise<{
    accountSummary: string | null;
    canSignOut: boolean;
    methods: readonly ProviderAuthMethodDescriptor[];
  }>;
  /** 启动交互式登录流（Browser OAuth 或 Device Code）。 */
  startAuthFlow?(
    ctx: VendorSetupContext,
    input: { methodId: string; variantId?: string; targetId?: string; remoteHint?: boolean },
    hooks: AuthFlowHooks,
    signal: AbortSignal,
  ): Promise<void>;
  /** 保存 API Key（写入原厂凭据文件或受管 secrets，必要时联动厂商配置）。 */
  saveApiKey?(ctx: VendorSetupContext, input: { targetId?: string; apiKey: string }): Promise<void>;
  /** 退出登录或移除指定子模型商凭据。 */
  signOut(ctx: VendorSetupContext, input?: { targetId?: string }): Promise<void>;
}

export interface VendorSyncContext {
  userHome: string;
  env: Readonly<Record<string, string | undefined>>;
}

export type CanonicalMcpServer =
  | {
      transport: "stdio";
      command: string;
      args: readonly string[];
      env: Readonly<Record<string, string>>;
      /** 当该 stdio 条目是从 `npx -y mcp-remote <sseUrl>` 识别出的桥接命令时记录原始 SSE URL，防二次包裹并支持幂等对账。 */
      bridgedSseUrl?: string;
    }
  | {
      transport: "http";
      url: string;
      headers: Readonly<Record<string, string>>;
      bearerTokenEnvVar?: string;
    }
  | {
      transport: "sse";
      url: string;
      headers: Readonly<Record<string, string>>;
    };

export interface ScannedCloudConnector {
  name: string;
  kind: "cloud_connector" | "oauth_mcp";
  reason: string;
}

export interface VendorMcpScanResult {
  configPath: string;
  servers: Record<string, CanonicalMcpServer>;
  nonSyncable: ScannedCloudConnector[];
}

export interface VendorMcpPatchPlan {
  configPath: string;
  /** 局部补丁后的完整文本（保留注释、排版、无关字段和登录态）；无需改动时返回 null。 */
  nextContent: string | null;
  mode?: number;
}

export type VendorSkillTarget =
  | { mode: "native" }
  | { mode: "symlink"; targetDir: string };

export interface VendorSyncAdapter {
  /** 是否原生支持旧版 `/sse` 远程 MCP；为 false 时同步引擎自动包一层 `npx -y mcp-remote <url>` 转 stdio。 */
  readonly supportsSseMcp: boolean;
  /** 只读扫描该厂商全局配置中的可移植 MCP 与不可跨厂同步的私有云端/OAuth 连接器。 */
  scanMcp(ctx: VendorSyncContext): VendorMcpScanResult;
  /** 计算局部补丁文本（不直接写盘，由同步引擎统一备份后原子替换，失败回滚）。 */
  planMcpPatch(
    ctx: VendorSyncContext,
    input: {
      upsert: Readonly<Record<string, CanonicalMcpServer>>;
      removeNames: ReadonlySet<string>;
    },
  ): VendorMcpPatchPlan;
  /** 全局（`~/.agents/skills`）或项目（`<projectDir>/.agents/skills`）下的技能同步策略。 */
  skillTarget(ctx: VendorSyncContext, scope: { kind: "global" } | { kind: "project"; projectDir: string }): VendorSkillTarget;
}

/** 生成启动文件时守护进程给的（daemon/launch.ts）。 */
interface VendorLaunchInput {
  role: SessionRole;
  /** hub.sock 的真实路径（realpath 过）。 */
  hubSock: string;
  /** 数据目录 state/ 的真实路径。 */
  stateDir: string;
  /** Worker 的进程会不会包进 OS 沙箱（daemon/driver/write-scope.ts 的 osSandboxAvailable）。 */
  osSandboxed: boolean;
  /** 只读 Worker、而且这家用设置文件落实只读（spec 的 capabilities.readonly 是 "settings"）时才给：统一策略和要盖住写的真实路径。 */
  readonly?: { policy: ReadonlyPolicy; denyWrite: string[] };
}

/** launchFiles 交出来的：设置文件的内容（守护进程写成 launch/<会话>/settings.json，进 fingerprint）、这一次启动多设的环境变量。 */
interface VendorLaunchFiles {
  settings?: string;
  env?: Readonly<Record<string, string>>;
}

/** 写 daemon.ts 用：只做类型检查。 */
export function defineVendorDaemon(daemon: VendorDaemon): VendorDaemon {
  return daemon;
}

/** 算兜底安装路径时公共代码（shared/paths.ts）给的东西。 */
interface FallbackPathsInput {
  userHome: string;
  platform: string;
  /** Linux 上各家官方安装方式放可执行文件的目录（shared/paths.ts 的 linuxInstallDirs）。 */
  linuxInstallDirs: readonly string[];
  /** Fusa 受管免管理员 npm 全局导出目录（win32 为 `<hubHome>\tools\npm`，POSIX 为 `<hubHome>/tools/npm/bin`）。 */
  toolsNpmBinDir?: string;
  join: (...parts: string[]) => string;
}

/**
 * src/vendors/<id>/paths.ts 的导出：只给守护进程和脚本用的纯数据（不进网页包，所以不放 spec.ts；按名单加载见 paths-registry.ts）。
 * 都可以不写。
 */
export interface VendorPathsModule {
  /** PATH 里找不到可执行文件时按顺序去哪找。不写 = 只认 PATH。 */
  fallbackPaths?: (input: FallbackPathsInput) => string[];
  /**
   * 这家 agent 在自己的会话里给子进程设的“父会话”变量：守护进程起任何厂商的子进程、跑准备命令前都去掉（daemon/driver/protocol.ts 的
   * buildChildEnv 取各家的并集），免得在这家的会话里起的守护进程把它们传给 agent，被当成嵌套会话。
   */
  parentSessionEnv?: readonly string[];
  /** 这家的凭据变量（名字按大写比较）：准备命令（daemon/setup/setup.ts）跑的是仓库里的脚本，一律去掉，各家取并集。 */
  credentialEnv?: { names?: readonly string[]; prefixes?: readonly string[]; pattern?: RegExp };
  /** scripts/provision-linux.sh 在 Linux 上装它的命令（官方安装脚本，装到 ~/.local/bin、不要 root）。不写 = 脚本跳过、提示手动装。 */
  installCommand?: string;
  /** Windows 桌面版引导页展示的官方 PowerShell / npm / WinGet 安装命令（普通用户免管理员）。 */
  windowsInstallCommand?: string;
  /** 没有浏览器的机器（ssh 上的 Linux）登录用的命令（provision 脚本最后提示）。不写 = spec 的 cli.loginCommand。 */
  headlessLoginCommand?: string;
}
