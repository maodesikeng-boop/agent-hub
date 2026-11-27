// Exhaustive cross-vendor evaluation profile registry and isolated mock-server launch contracts.
// Invariant: every registered AgentVendor has an explicit profile and coverage row with zero silent skips.
import { posix, win32 } from "node:path";
import { AGENT_VENDORS, vendorSpec, type AgentVendor } from "../../../src/shared/vendors.ts";
import type { VendorCoverageRow, VendorEvalProfile, VendorMockLaunchConfig } from "./types.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

// Preserve the caller's path separator style so POSIX and Windows scratch roots stay consistent across hosts.
function joinIsolatedPath(root: string, ...segments: readonly string[]): string {
  return root.includes("\\") ? win32.join(root, ...segments) : posix.join(root, ...segments);
}

function buildProfile<V extends AgentVendor>(
  vendor: V,
  rest: Omit<VendorEvalProfile, "vendor" | "systemPromptChannel">,
): VendorEvalProfile {
  return {
    vendor,
    systemPromptChannel: vendorSpec(vendor).capabilities.systemPrompt,
    ...rest,
  };
}

const VENDOR_EVAL_PROFILES: Readonly<Record<AgentVendor, VendorEvalProfile>> = {
  claude: buildProfile("claude", {
    mockServerProtocol: "anthropic_messages",
    baseUrlStrategy: { kind: "env", envVar: "ANTHROPIC_BASE_URL", apiKeyEnvVar: "ANTHROPIC_API_KEY" },
    tier1Coverage: "real_cli_mock_server",
    promptCacheCheck: "prefix_only",
    replaySupport: "full",
    gapReason: null,
  }),
  agy: buildProfile("agy", {
    mockServerProtocol: "unsupported",
    baseUrlStrategy: {
      kind: "none",
      reason: "CLI does not expose a documented loopback model base URL override.",
    },
    tier1Coverage: "fake_driver_contract",
    promptCacheCheck: "live_cache_read_only",
    replaySupport: "driver_contract_only",
    gapReason: "No documented custom model base URL override; covered by driver contract tests and live cacheRead probes.",
  }),
  codex: buildProfile("codex", {
    mockServerProtocol: "openai_responses",
    baseUrlStrategy: { kind: "codex_config_toml", providerId: "mock", apiKeyEnvVar: "MOCK_KEY" },
    tier1Coverage: "real_cli_mock_server",
    promptCacheCheck: "prefix_and_key",
    replaySupport: "full",
    gapReason: null,
  }),
  pi: buildProfile("pi", {
    mockServerProtocol: "openai_responses",
    baseUrlStrategy: { kind: "env", envVar: "OPENAI_BASE_URL", apiKeyEnvVar: "OPENAI_API_KEY" },
    tier1Coverage: "real_cli_mock_server",
    promptCacheCheck: "prefix_only",
    replaySupport: "driver_contract_only",
    gapReason: null,
  }),
  deepseek: buildProfile("deepseek", {
    mockServerProtocol: "acp_fake",
    baseUrlStrategy: {
      kind: "none",
      reason: "ACP runtime rewrites its profile config on startup without a documented loopback base URL override.",
    },
    tier1Coverage: "fake_driver_contract",
    promptCacheCheck: "live_cache_read_only",
    replaySupport: "driver_contract_only",
    gapReason: "Covered by fake ACP driver contract tests and live bench probes because startup rewrites ACP profile config.",
  }),
  cursor: buildProfile("cursor", {
    mockServerProtocol: "acp_fake",
    baseUrlStrategy: {
      kind: "none",
      reason: "ACP runtime does not expose a custom loopback model base URL override.",
    },
    tier1Coverage: "fake_driver_contract",
    promptCacheCheck: "live_cache_read_only",
    replaySupport: "driver_contract_only",
    gapReason: "ACP runtime routes through hosted endpoints without a loopback base URL override; covered by fake ACP contract tests.",
  }),
  opencode: buildProfile("opencode", {
    mockServerProtocol: "openai_responses",
    baseUrlStrategy: { kind: "env", envVar: "OPENAI_BASE_URL", apiKeyEnvVar: "OPENAI_API_KEY" },
    tier1Coverage: "real_cli_mock_server",
    promptCacheCheck: "prefix_only",
    replaySupport: "driver_contract_only",
    gapReason: null,
  }),
  kimi: buildProfile("kimi", {
    mockServerProtocol: "openai_responses",
    baseUrlStrategy: { kind: "env", envVar: "KIMI_MODEL_BASE_URL", apiKeyEnvVar: "KIMI_API_KEY" },
    tier1Coverage: "real_cli_mock_server",
    promptCacheCheck: "prefix_only",
    replaySupport: "driver_contract_only",
    gapReason: null,
  }),
};

function parseLoopbackUrl(serverUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new RangeError(`Mock server URL must be a valid loopback HTTP URL: ${serverUrl}`);
  }
  if (parsed.protocol !== "http:" || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new RangeError(`Mock server URL must use http:// on a loopback address (got ${serverUrl})`);
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${cleanPath}`;
}

export function getVendorEvalProfiles(): Readonly<Record<AgentVendor, VendorEvalProfile>> {
  return VENDOR_EVAL_PROFILES;
}

export function getVendorEvalProfile(vendor: AgentVendor): VendorEvalProfile {
  return VENDOR_EVAL_PROFILES[vendor];
}

export function resolveVendorMockEnv(
  vendor: AgentVendor,
  serverUrl: string,
  scratchHome: string,
): VendorMockLaunchConfig {
  const normalizedUrl = parseLoopbackUrl(serverUrl);
  if (scratchHome.trim() === "") {
    throw new RangeError("scratchHome must be a non-empty isolated directory path");
  }

  const profile = VENDOR_EVAL_PROFILES[vendor];
  const strategy = profile.baseUrlStrategy;
  if (strategy.kind === "none") {
    return {
      vendor,
      supported: false,
      env: {},
      configFiles: [],
      unsupportedReason: strategy.reason,
    };
  }

  const baseEnv: Record<string, string> = {
    HOME: scratchHome,
    USERPROFILE: scratchHome,
    XDG_CONFIG_HOME: joinIsolatedPath(scratchHome, ".config"),
    XDG_DATA_HOME: joinIsolatedPath(scratchHome, ".local", "share"),
    XDG_STATE_HOME: joinIsolatedPath(scratchHome, ".local", "state"),
  };

  const configHome = vendorSpec(vendor).home.configHome;
  if (configHome) {
    baseEnv[configHome.env] = joinIsolatedPath(scratchHome, configHome.rel);
  }

  if (strategy.kind === "codex_config_toml") {
    const providerId = strategy.providerId;
    const toml = [
      'model = "gpt-5"',
      `model_provider = "${providerId}"`,
      "",
      `[model_providers.${providerId}]`,
      `name = "${providerId}"`,
      `base_url = "${normalizedUrl}/v1"`,
      'wire_api = "responses"',
      `env_key = "${strategy.apiKeyEnvVar}"`,
      "request_max_retries = 0",
      "stream_max_retries = 0",
      "",
    ].join("\n");
    const relPath = configHome ? `${configHome.rel}/config.toml` : ".codex/config.toml";
    return {
      vendor,
      supported: true,
      env: {
        ...baseEnv,
        [strategy.apiKeyEnvVar]: "bellwood-mock-key",
      },
      configFiles: [{ relativePath: relPath, content: toml }],
      unsupportedReason: null,
    };
  }

  return {
    vendor,
    supported: true,
    env: {
      ...baseEnv,
      [strategy.envVar]: normalizedUrl,
      [strategy.apiKeyEnvVar]: "bellwood-mock-key",
    },
    configFiles: [],
    unsupportedReason: null,
  };
}

export function buildVendorCoverageMatrix(
  profiles: Readonly<Record<AgentVendor, VendorEvalProfile>> = VENDOR_EVAL_PROFILES,
): VendorCoverageRow[] {
  return AGENT_VENDORS.map((vendor) => {
    const profile = profiles[vendor];
    return {
      vendor,
      tier1Coverage: profile.tier1Coverage,
      promptCacheCheck: profile.promptCacheCheck,
      replaySupport: profile.replaySupport,
      gapReason: profile.gapReason,
    };
  });
}
