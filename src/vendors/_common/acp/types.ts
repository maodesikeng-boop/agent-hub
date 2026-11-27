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
  PromptResponse,
  RequestPermissionOutcome,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionModeState,
  ToolCall,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk/unstable";
import type { AcpChecklistConfig } from "./checklist.ts";
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

export interface AcpLaunchContext {
  row: AgentSessionRow;
  files: LaunchFiles;
  resume: boolean;
  executablePath: string;
}

export interface AcpSessionSetupContext {
  row: AgentSessionRow;
  files: LaunchFiles;
  resumed: boolean;
  sessionId: string;
  init: InitializeResponse;
  modes: SessionModeState | null;
  configOptions: readonly SessionConfigOption[];
}

export interface AcpAuthConfig {
  enabled?: boolean | ((init: InitializeResponse, context: AcpLaunchContext) => boolean);
  preferredMethodId?: string;
  selectMethodId?: (methods: readonly AuthMethod[], init: InitializeResponse, context: AcpLaunchContext) => string | null;
}

export interface AcpContinuationConfig {
  // auto prefers sessionCapabilities.resume, then loadSession, and falls back to load.
  mode?: "load" | "resume" | "auto";
  // Swallow history replayed by session/load so the ledger does not store it twice.
  swallowReplayOnLoad?: boolean;
  fallbackToNewOnFailure?: boolean;
  rebakesPersonaOnResume?: boolean;
}

export interface AcpSessionSetupConfig {
  systemPromptInjection?: "first_turn_new_session" | "every_process_first_turn" | "never";
  preferNativeSystemPrompt?: boolean;
  formatSystemPrompt?: (promptText: string) => string;
  defaultModeId?: string | ((context: AcpSessionSetupContext) => string | null);
  mcpServers?: readonly McpServer[] | ((context: AcpLaunchContext) => readonly McpServer[]);
  extraAdditionalDirectories?: (context: AcpLaunchContext) => readonly string[];
  sessionMeta?: (context: AcpLaunchContext) => Record<string, unknown> | undefined;
}

export interface AcpConfigOptionsConfig {
  modelOptionIds?: readonly string[];
  modelCategory?: string;
  effortOptionIds?: readonly string[];
  effortCategory?: string;
  resolveModelValue?: (
    requestedModel: string,
    option: SessionConfigOption | null,
    allOptions: readonly SessionConfigOption[],
  ) => string | null;
  resolveEffortValue?: (
    requestedEffort: string,
    option: SessionConfigOption | null,
    allOptions: readonly SessionConfigOption[],
  ) => string | null;
  // For vendors that encode effort in the model value: return the full set_config_option sequence, or null for the two-step default.
  combineModelAndEffort?: (params: {
    model: string | null;
    effort: string | null;
    options: readonly SessionConfigOption[];
  }) => Array<{ configId: string; value: string }> | null;
}

export interface AcpPermissionDecisionContext {
  request: RequestPermissionRequest;
  readonlyPolicy: ReadonlyPolicy | null;
  closing: boolean;
  signal: AbortSignal;
}

export interface AcpPermissionsConfig {
  allowOptionKinds?: readonly PermissionOptionKind[];
  rejectOptionKinds?: readonly PermissionOptionKind[];
  writeToolKinds?: readonly ToolKind[];
  writeToolNames?: readonly string[];
  extractMcpTool?: (request: RequestPermissionRequest) => {
    server: string;
    tool: string;
    annotations?: ConnectorToolAnnotations | null;
  } | null;
  decide?: (
    context: AcpPermissionDecisionContext,
  ) => RequestPermissionOutcome | null | Promise<RequestPermissionOutcome | null>;
}

export interface AcpExtensionRequestContext {
  method: string;
  params: unknown;
  requestId: JsonRpcId;
  signal: AbortSignal;
  agent: ClientContext;
  sessionId: string | null;
  readonlyPolicy: ReadonlyPolicy | null;
}

export interface AcpExtensionNotificationContext {
  method: string;
  params: unknown;
  sessionId: string | null;
}

export interface AcpCustomSessionUpdateContext {
  sessionId: string | null;
  sessionUpdate: string;
  update: Record<string, unknown>;
}

export interface AcpExtensionsConfig {
  // Returning undefined replies -32601 so the child never blocks on an unanswered request.
  onBlockingRequest?: (context: AcpExtensionRequestContext) => unknown | Promise<unknown>;
  // Unattended sessions decline elicitation/create by default.
  onElicitation?: (
    params: CreateElicitationRequest,
    signal: AbortSignal,
  ) => CreateElicitationResponse | Promise<CreateElicitationResponse>;
  onNotification?: (context: AcpExtensionNotificationContext) => void;
  onCustomSessionUpdate?: (context: AcpCustomSessionUpdateContext) => void;
}

export interface AcpReadonlySandboxConfig {
  writableDirs?: (homeDir: string, cwd: string, launch: AcpLaunchContext) => readonly string[];
  writableFileGlobs?: (homeDir: string, cwd: string, launch: AcpLaunchContext) => readonly string[];
  readableFiles?: (homeDir: string) => readonly string[];
  // Vendor config the read-only process must not load, such as project-level MCP server lists.
  hiddenPaths?: (homeDir: string, cwd: string, launch: AcpLaunchContext) => readonly string[];
}

export interface AcpTimeoutsConfig {
  startTimeoutMs?: number;
  interruptGraceMs?: number;
  idleCloseMs?: number;
  shutdownGraceMs?: number;
  commandsTimeoutMs?: number;
  closeSessionGraceMs?: number;
}

export interface AcpErrorConfig {
  classifyTurnError?: (error: unknown) => { subtype: string; message: string };
  isSessionNotFoundError?: (error: unknown) => boolean;
}

export type AcpPromptOutcomeCheck = (response: PromptResponse) => Promise<{ subtype: string; message: string } | null>;

export interface AcpStaleProcessConfig {
  matchesCommand?: (psArgs: string, row: AgentSessionRow, executablePath: string) => boolean;
}

export interface AcpTrackedToolCall {
  toolCallId: string;
  name: string;
  input: unknown;
  kind?: ToolKind | null;
  resultEmitted: boolean;
  pending?: boolean;
  lastChecklistJson?: string;
}

export interface AcpDriverConfig {
  vendor: AgentVendor;
  launchArgs: readonly string[] | ((context: AcpLaunchContext) => readonly string[]);
  clientInfo?: Implementation;
  clientCapabilities?: ClientCapabilities;
  authenticate?: AcpAuthConfig;
  continuation?: AcpContinuationConfig;
  session?: AcpSessionSetupConfig;
  configOptions?: AcpConfigOptionsConfig;
  permissions?: AcpPermissionsConfig;
  extensions?: AcpExtensionsConfig;
  readonlySandbox?: AcpReadonlySandboxConfig;
  timeouts?: AcpTimeoutsConfig;
  errors?: AcpErrorConfig;
  staleProcess?: AcpStaleProcessConfig;
  // Called before each prompt for agents that answer a failed turn with end_turn; the check reports the real failure.
  watchPromptOutcome?: (context: { sessionId: string }) => AcpPromptOutcomeCheck | null;
  // turn: per-turn deltas (default); cumulative: running totals for the current process.
  usageMode?: "turn" | "cumulative";
  extractToolUse?: (
    toolCall: ToolCall | ToolCallUpdate,
    previous?: AcpTrackedToolCall,
  ) => { name: string; input: unknown };
  checklist?: AcpChecklistConfig;
}

export interface AcpDriverOptions extends DriverOptions {
  composer?: VendorComposerBase;
  // @internal Test hook for injecting the read-only sandbox wrapper.
  readonlySpawn?: (base: SpawnCommand, input: ReadonlySandboxInput) => ScopedSpawn;
}
