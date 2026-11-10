// 通用 ACP（Agent Client Protocol）会话驱动配置与扩展钩子类型。
// 具体厂商只需在各自文件夹中构造 AcpDriverConfig 传入 createAcpDriver，不在各家重复实现 JSON-RPC / ACP 会话层。
import type {
  AuthMethod,
  ClientCapabilities,
  ClientContext,
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  Implementation,
  InitializeResponse,
  JsonRpcId,
  McpServer,
  PermissionOptionKind,
  RequestPermissionOutcome,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionModeState,
  ToolCall,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk/unstable";
import type {
  AgentSessionRow,
  AgentVendor,
  ConnectorToolAnnotations,
  DriverOptions,
  LaunchFiles,
  ReadonlyPolicy,
} from "../../../shared/index.ts";
import type {
  ReadonlySandboxInput,
  ScopedSpawn,
  SpawnCommand,
} from "../../../daemon/driver/write-scope.ts";
import type { VendorComposerBase } from "../../../daemon/vendors/types.ts";

/** 启动子进程与初始化会话时的上下文。 */
export interface AcpLaunchContext {
  row: AgentSessionRow;
  files: LaunchFiles;
  resume: boolean;
  executablePath: string;
}

/** 会话建好或恢复好之后的配置上下文。 */
export interface AcpSessionSetupContext {
  row: AgentSessionRow;
  files: LaunchFiles;
  resumed: boolean;
  sessionId: string;
  init: InitializeResponse;
  modes: SessionModeState | null;
  configOptions: readonly SessionConfigOption[];
}

/** 认证握手配置（部分厂商要求 initialize 后显式调 authenticate，部分不需要）。 */
export interface AcpAuthConfig {
  /** 是否在 initialize 之后发起 authenticate 请求。默认 false。 */
  enabled?: boolean | ((init: InitializeResponse, context: AcpLaunchContext) => boolean);
  /** 优先选用的认证方式 ID；未命中时回退到 authMethods[0]。 */
  preferredMethodId?: string;
  /** 自定义从 initialize 返回的 authMethods 中挑选 methodId；返回 null 则跳过 authenticate。 */
  selectMethodId?: (methods: readonly AuthMethod[], init: InitializeResponse, context: AcpLaunchContext) => string | null;
}

/** 会话续接策略（session/load 重放历史 vs session/resume 直接续接）。 */
export interface AcpContinuationConfig {
  /**
   * 续接使用的 ACP 方法：
   * - "load"：固定调 session/load；
   * - "resume"：固定调 session/resume；
   * - "auto"（默认）：优先看 agentCapabilities.sessionCapabilities.resume，其次看 loadSession，都没有则按 load 试。
   */
  mode?: "load" | "resume" | "auto";
  /**
   * 调 session/load 期间是否吞掉服务端重放的历史轮次通知（user_message_chunk / agent_message_chunk /
   * agent_thought_chunk / tool_call / tool_call_update / plan 等），避免账本重复入库历史消息。
   * available_commands_update / config_option_update / current_mode_update / usage_update 仍正常消费。
   * 默认 true。
   */
  swallowReplayOnLoad?: boolean;
  /** session/load 或 session/resume 失败（如会话不存在）时是否自动回退到 session/new。默认 true。 */
  fallbackToNewOnFailure?: boolean;
  /** 恢复会话时服务端是否重新读取最新系统提示词（供 personaSeenAtStart 判断）。默认 false。 */
  rebakesPersonaOnResume?: boolean;
}

/** 系统提示词与会话初始参数配置。 */
export interface AcpSessionSetupConfig {
  /**
   * 系统提示词注入方式：
   * - "first_turn_new_session"（默认）：仅新建会话（含恢复失败回退新建）首轮消息最前面注入 <system_instructions>；
   * - "every_process_first_turn"：每次新起进程的首轮消息都重新注入系统提示词；
   * - "never"：不注入（由厂商自行通过配置文件或其他机制读取）。
   */
  systemPromptInjection?: "first_turn_new_session" | "every_process_first_turn" | "never";
  /** 若服务端在 sessionCapabilities.systemPrompt 声明了原生支持，是否优先走原生 systemPrompt 字段。默认 false（统一走首轮块更稳）。 */
  preferNativeSystemPrompt?: boolean;
  /** 自定义系统提示词包裹格式；默认包在 <system_instructions> 标签中。 */
  formatSystemPrompt?: (promptText: string) => string;
  /** 会话创建/恢复后要切换的目标 modeId（与 currentModeId 不同且存在于 availableModes 时调 session/set_mode）。 */
  defaultModeId?: string | ((context: AcpSessionSetupContext) => string | null);
  /** 传给 session/new、session/load、session/resume 的 MCP 服务器列表。默认 []。 */
  mcpServers?: readonly McpServer[] | ((context: AcpLaunchContext) => readonly McpServer[]);
}

/** 模型与思考程度通过 session/set_config_option 映射的规则。 */
export interface AcpConfigOptionsConfig {
  /** 匹配模型配置项的候选 configId（默认 ["model"]），未命中时再按 category === modelCategory 找。 */
  modelOptionIds?: readonly string[];
  /** 模型配置项的 category 名（默认 "model"）。 */
  modelCategory?: string;
  /** 匹配思考程度配置项的候选 configId（默认 ["reasoning_effort", "thought_level", "thinking_effort", "effort"]）。 */
  effortOptionIds?: readonly string[];
  /** 思考程度配置项的 category 名（默认 "thought_level"）。 */
  effortCategory?: string;
  /** 自定义把 AgentSessionRow.model 映射为该配置项的 value；返回 null 表示不调。 */
  resolveModelValue?: (
    requestedModel: string,
    option: SessionConfigOption | null,
    allOptions: readonly SessionConfigOption[],
  ) => string | null;
  /** 自定义把 AgentSessionRow.effort 映射为该配置项的 value；返回 null 表示不调。 */
  resolveEffortValue?: (
    requestedEffort: string,
    option: SessionConfigOption | null,
    allOptions: readonly SessionConfigOption[],
  ) => string | null;
  /**
   * 部分厂商把思考程度编码进模型配置项的 value 中（而非独立配置项）：
   * 若提供此钩子且返回非 null 数组，则直接按返回的列表依次调 session/set_config_option；返回 null 则走默认的两段式（先模型、再用刷新后的 configOptions 设思考程度）。
   */
  combineModelAndEffort?: (params: {
    model: string | null;
    effort: string | null;
    options: readonly SessionConfigOption[];
  }) => Array<{ configId: string; value: string }> | null;
}

/** 权限决策上下文。 */
export interface AcpPermissionDecisionContext {
  request: RequestPermissionRequest;
  readonlyPolicy: ReadonlyPolicy | null;
  closing: boolean;
  signal: AbortSignal;
}

/** session/request_permission 权限回调策略配置。 */
export interface AcpPermissionsConfig {
  /** 放行时优先选用的 option.kind 顺序（默认 ["allow_always", "allow_once"]）。 */
  allowOptionKinds?: readonly PermissionOptionKind[];
  /** 拒绝时优先选用的 option.kind 顺序（默认 ["reject_once", "reject_always"]）。 */
  rejectOptionKinds?: readonly PermissionOptionKind[];
  /** 只读 Worker 下额外拒绝的 ToolKind 列表（始终拒绝 edit/delete/move 及非白名单未知 kind，默认放行 read/search/think/fetch 与受外层 OS 沙箱包裹的内置 execute；此处只能追加拒绝）。 */
  writeToolKinds?: readonly ToolKind[];
  /** 只读 Worker 下额外视为写操作的工具名集合（不区分大小写精确匹配）。 */
  writeToolNames?: readonly string[];
  /** 从权限请求中识别 MCP 连接器工具（返回 server、tool 及可选 annotations）；返回 null 则按通用规则识别。 */
  extractMcpTool?: (request: RequestPermissionRequest) => {
    server: string;
    tool: string;
    annotations?: ConnectorToolAnnotations | null;
  } | null;
  /** 厂商自定义权限裁决钩子：通过只读安全检查后，返回非 null 则采用，返回 null 则走通用策略。 */
  decide?: (
    context: AcpPermissionDecisionContext,
  ) => RequestPermissionOutcome | null | Promise<RequestPermissionOutcome | null>;
}

/** 厂商扩展阻塞请求上下文（服务端发给客户端的非标 JSON-RPC request）。 */
export interface AcpExtensionRequestContext {
  method: string;
  params: unknown;
  requestId: JsonRpcId;
  signal: AbortSignal;
  agent: ClientContext;
  sessionId: string | null;
  readonlyPolicy: ReadonlyPolicy | null;
}

/** 厂商扩展通知上下文（服务端发给客户端的非标 JSON-RPC notification）。 */
export interface AcpExtensionNotificationContext {
  method: string;
  params: unknown;
  sessionId: string | null;
}

/** 厂商在 session/update 中发送的非标准 sessionUpdate 分支上下文。 */
export interface AcpCustomSessionUpdateContext {
  sessionId: string | null;
  sessionUpdate: string;
  update: Record<string, unknown>;
}

/** 厂商扩展方法与交互拦截配置。 */
export interface AcpExtensionsConfig {
  /**
   * 处理厂商私有的阻塞式客户端请求（如自定义交互提问、计划审批等）。
   * 返回 undefined 时驱动按标准 JSON-RPC Method Not Found (-32601) 拒绝，防止子进程永久挂起。
   */
  onBlockingRequest?: (context: AcpExtensionRequestContext) => unknown | Promise<unknown>;
  /**
   * 处理标准 ACP elicitation/create 交互提问请求。
   * 后台无人值守会话默认自动返回 { action: "decline" } 拒绝阻塞提问。
   */
  onElicitation?: (
    params: CreateElicitationRequest,
    signal: AbortSignal,
  ) => CreateElicitationResponse | Promise<CreateElicitationResponse>;
  /** 处理厂商私有的客户端通知。 */
  onNotification?: (context: AcpExtensionNotificationContext) => void;
  /** 处理 session/update 中不在标准联合类型内的私有 sessionUpdate 事件。 */
  onCustomSessionUpdate?: (context: AcpCustomSessionUpdateContext) => void;
}

/** 只读 Worker 外层 OS 沙箱附加可写目录配置。 */
export interface AcpReadonlySandboxConfig {
  /** 除通用缓存目录外，该厂商运行时必须可写的目录（如日志、临时锁目录，不含敏感凭据）；还没有的启动前先建好。 */
  writableDirs?: (homeDir: string, cwd: string) => readonly string[];
  /** 该厂商运行时必须可写的单层文件通配。 */
  writableFileGlobs?: (homeDir: string, cwd: string) => readonly string[];
}

/** 厂商默认超时与宽限期预算（调用方显式传入的 DriverOptions 优先于此处默认值）。 */
export interface AcpTimeoutsConfig {
  startTimeoutMs?: number;
  interruptGraceMs?: number;
  idleCloseMs?: number;
  shutdownGraceMs?: number;
  commandsTimeoutMs?: number;
  /** 空闲关闭时若服务端支持 session/close，等待其返回的最大毫秒数（超时则直接关 stdin）。 */
  closeSessionGraceMs?: number;
}

/** 错误分类与识别钩子。 */
export interface AcpErrorConfig {
  /** 将 session/prompt 抛出的错误或拒绝状态映射为 turn.ended.error。 */
  classifyTurnError?: (error: unknown) => { subtype: string; message: string };
  /** 判断 session/load 或 session/resume 的报错是否属于“目标会话不存在/已损坏”。 */
  isSessionNotFoundError?: (error: unknown) => boolean;
}

/** 残留进程识别配置（供 cleanupStale 使用）。 */
export interface AcpStaleProcessConfig {
  /** 判断 ps args 命令行是否属于当前会话的残留 ACP 进程。 */
  matchesCommand?: (psArgs: string, row: AgentSessionRow, executablePath: string) => boolean;
}

/** 当前轮内跟踪的工具调用状态。 */
export interface AcpTrackedToolCall {
  toolCallId: string;
  name: string;
  input: unknown;
  kind?: ToolKind | null;
  resultEmitted: boolean;
}

/** 通用 ACP 驱动完整配置（由具体厂商薄封装传入）。 */
export interface AcpDriverConfig {
  /** 厂商编号（必须在 AGENT_VENDORS 中）。 */
  vendor: AgentVendor;
  /** 启动 ACP 常驻模式的命令行参数（如子命令、profile 参数等）。 */
  launchArgs: readonly string[] | ((context: AcpLaunchContext) => readonly string[]);
  /** 客户端身份声明（传给 initialize.clientInfo）。 */
  clientInfo?: Implementation;
  /** 客户端能力声明（传给 initialize.clientCapabilities，默认 {}，由服务端自行在沙箱内执行工具）。 */
  clientCapabilities?: ClientCapabilities;
  /** 认证握手策略。 */
  authenticate?: AcpAuthConfig;
  /** 会话恢复/加载策略。 */
  continuation?: AcpContinuationConfig;
  /** 系统提示词注入与会话模式初始化。 */
  session?: AcpSessionSetupConfig;
  /** 模型与思考档位 configOptions 映射。 */
  configOptions?: AcpConfigOptionsConfig;
  /** 权限请求策略与只读拦截。 */
  permissions?: AcpPermissionsConfig;
  /** 厂商私有阻塞请求、通知与自定义 sessionUpdate 钩子。 */
  extensions?: AcpExtensionsConfig;
  /** 只读 Worker 外层 OS 沙箱目录补充。 */
  readonlySandbox?: AcpReadonlySandboxConfig;
  /** 启动/打断/空闲/关闭宽限期预算覆盖。 */
  timeouts?: AcpTimeoutsConfig;
  /** 错误映射与会话缺失判定。 */
  errors?: AcpErrorConfig;
  /** 残留进程匹配策略。 */
  staleProcess?: AcpStaleProcessConfig;
  /** PromptResponse.usage 口径："turn"（默认，单轮增量累加）或 "cumulative"（当前进程内累计值）。 */
  usageMode?: "turn" | "cumulative";
  /** 自定义从 ACP ToolCall / ToolCallUpdate 提取账本工具名与 input。 */
  extractToolUse?: (
    toolCall: ToolCall | ToolCallUpdate,
    previous?: AcpTrackedToolCall,
  ) => { name: string; input: unknown };
}

/** 创建 ACP 驱动时的可选运行参数（在标准 DriverOptions 基础上允许自定义输入框实现与只读沙箱包装注入）。 */
export interface AcpDriverOptions extends DriverOptions {
  composer?: VendorComposerBase;
  /** @internal 供单测在已处于外层 macOS seatbelt 的环境里注入只读沙箱包装器（默认 wrapInReadonlyOsSandbox）。 */
  readonlySpawn?: (base: SpawnCommand, input: ReadonlySandboxInput) => ScopedSpawn;
}
