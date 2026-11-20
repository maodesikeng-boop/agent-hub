import type { CapabilitySource, SessionCapabilities } from "../shared/pm-capabilities.ts";
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

export interface VendorDriverDeps extends DriverOptions {
  composer?: VendorComposerBase;
  defaultModel?: () => Promise<string | null>;
}

export interface VendorComposerDeps {
  executablePath: string | (() => string);
  env?: Record<string, string | undefined> | (() => Record<string, string | undefined>);
  timeoutMs?: number;
}

export interface VendorDaemon {
  createDriver(deps: VendorDriverDeps): Driver;
  composer?: { base: VendorComposerBase; create(deps: VendorComposerDeps): VendorComposer };
  // Must not open a session, connect MCP, or run hooks.
  catalog?: { probe: VendorCatalogProbe; source(options: VendorCatalogSourceOptions): VendorCatalogSource };
  forkers?: readonly SessionForker[];
  transcriptPath?(ref: TranscriptRef, roots: TranscriptRoots): string | null;
  sessionFiles?(ref: TranscriptRef, roots: TranscriptRoots): string[];
  launchFiles?(input: VendorLaunchInput): VendorLaunchFiles;
  capabilityLaunch?(caps: SessionCapabilities): unknown;
  sync?: VendorSyncAdapter;
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

export interface ManagedProviderSecrets {
  keys(vendor: AgentVendor): string[];
  has(vendor: AgentVendor, envName: string): boolean;
  getEnv(vendor: AgentVendor): Readonly<Record<string, string>>;
  set(vendor: AgentVendor, entries: Readonly<Record<string, string>>): void;
  remove(vendor: AgentVendor, names?: readonly string[]): void;
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
  onAuthorizeUrl(url: string): void;
  onDeviceCode(payload: { verificationUrl: string; userCode: string }): void;
  onUserInput(handler: (input: string) => void | Promise<void>): void;
}

export interface VendorSetupAdapter {
  installRecipe(platform: string): VendorInstallRecipe;
  updateRecipe(platform: string): VendorUpdateRecipe;
  versionArgs?: readonly string[];
  inspectAuth(ctx: VendorSetupContext): Promise<{
    accountSummary: string | null;
    canSignOut: boolean;
    methods: readonly ProviderAuthMethodDescriptor[];
  }>;
  startAuthFlow?(
    ctx: VendorSetupContext,
    input: { methodId: string; variantId?: string; targetId?: string; remoteHint?: boolean },
    hooks: AuthFlowHooks,
    signal: AbortSignal,
  ): Promise<void>;
  saveApiKey?(ctx: VendorSetupContext, input: { targetId?: string; apiKey: string }): Promise<void>;
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
  nextContent: string | null;
  mode?: number;
}

export type VendorSkillTarget =
  | { mode: "native" }
  | { mode: "symlink"; targetDir: string };

export interface VendorSyncAdapter {
  readonly supportsSseMcp: boolean;
  scanMcp(ctx: VendorSyncContext): VendorMcpScanResult;
  planMcpPatch(
    ctx: VendorSyncContext,
    input: {
      upsert: Readonly<Record<string, CanonicalMcpServer>>;
      removeNames: ReadonlySet<string>;
      isProtectedServer?: (server: CanonicalMcpServer) => boolean;
    },
  ): VendorMcpPatchPlan;
  skillTarget(ctx: VendorSyncContext, scope: { kind: "global" } | { kind: "project"; projectDir: string }): VendorSkillTarget;
  scanCapabilities?(ctx: VendorSyncContext, scope: { projectDir: string | null }): Promise<VendorCapabilityScan>;
}

export interface VendorCapabilityScan {
  skills: Array<{ name: string; dir: string; description: string | null; source: CapabilitySource }>;
  mcp: Array<{ name: string; source: CapabilitySource }>;
  connectors: Array<{ id: string; name: string }>;
  plugins: Array<{ id: string; label: string }>;
}

interface VendorLaunchInput {
  role: SessionRole;
  hubSock?: string;
  stateDir: string;
  osSandboxed: boolean;
  readonly?: { policy: ReadonlyPolicy; denyWrite: string[] };
  capabilities?: SessionCapabilities;
}

interface VendorLaunchFiles {
  settings?: string;
  env?: Readonly<Record<string, string>>;
}

export function defineVendorDaemon(daemon: VendorDaemon): VendorDaemon {
  return daemon;
}

interface FallbackPathsInput {
  userHome: string;
  platform: string;
  linuxInstallDirs: readonly string[];
  toolsNpmBinDir?: string;
  join: (...parts: string[]) => string;
}

export interface VendorPathsModule {
  fallbackPaths?: (input: FallbackPathsInput) => string[];
  parentSessionEnv?: readonly string[];
  credentialEnv?: { names?: readonly string[]; prefixes?: readonly string[]; pattern?: RegExp };
  installCommand?: string;
  windowsInstallCommand?: string;
  headlessLoginCommand?: string;
}
