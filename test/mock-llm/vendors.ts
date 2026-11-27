// Invariant: every registered vendor in VENDOR_LIST has an explicit adapter entry; no vendor is skipped silently.
import type { AgentVendor } from "../../src/shared/index.ts";
import type { RealCliProbeStatus, VendorMockAdapter } from "./types.ts";

function unimplementedProvision(): never {
  throw new Error("Not implemented");
}

export const VENDOR_MOCK_ADAPTERS: Readonly<Record<AgentVendor, VendorMockAdapter>> = {
  claude: {
    vendor: "claude",
    support: "full",
    dialect: "anthropic-messages",
    defaultModel: "claude-sonnet-5-5",
    reason: "Supports ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY + CLAUDE_CONFIG_DIR over Anthropic Messages SSE.",
    provision: unimplementedProvision,
  },
  agy: {
    vendor: "agy",
    support: "full",
    dialect: "gemini-generate-content",
    defaultModel: "gemini-3.1-pro-preview",
    reason: "Supports settings.json modelProvider=gemini + GEMINI_API_KEY + GOOGLE_GEMINI_BASE_URL over Gemini GenerateContent SSE.",
    provision: unimplementedProvision,
  },
  codex: {
    vendor: "codex",
    support: "full",
    dialect: "openai-responses",
    defaultModel: "gpt-6-luna",
    reason: "Supports CODEX_HOME/config.toml model_providers.<id>.base_url + wire_api=responses over OpenAI Responses SSE.",
    provision: unimplementedProvision,
  },
  pi: {
    vendor: "pi",
    support: "full",
    dialect: "openai-responses",
    defaultModel: "mock/mock-model",
    reason: "Supports PI_CODING_AGENT_DIR/models.json custom provider baseUrl over OpenAI Responses, Chat Completions, or Anthropic Messages SSE.",
    provision: unimplementedProvision,
  },
  deepseek: {
    vendor: "deepseek",
    support: "full",
    dialect: "anthropic-messages",
    defaultModel: "deepseek-flash",
    reason: "Supports DSH_HOME/cordis.patch.yml llm-deepseek.baseURL + DEEPSEEK_API_KEY over Anthropic Messages SSE.",
    provision: unimplementedProvision,
  },
  cursor: {
    vendor: "cursor",
    support: "unsupported_protocol",
    dialect: null,
    defaultModel: "default",
    reason: "Redirects --endpoint/CURSOR_API_ENDPOINT to loopback, but speaks proprietary binary Protobuf/ConnectRPC services (/aiserver.v1.*).",
    provision: unimplementedProvision,
  },
  opencode: {
    vendor: "opencode",
    support: "full",
    dialect: "openai-chat-completions",
    defaultModel: "mock/mock-model",
    reason: "Supports XDG_CONFIG_HOME/opencode/opencode.json custom provider options.baseURL over OpenAI-compatible SSE.",
    provision: unimplementedProvision,
  },
  kimi: {
    vendor: "kimi",
    support: "full",
    dialect: "openai-chat-completions",
    defaultModel: "kimi-k3",
    reason: "Supports KIMI_CODE_HOME + KIMI_MODEL_BASE_URL + KIMI_MODEL_API_KEY + KIMI_MODEL_NAME + KIMI_MODEL_PROVIDER_TYPE over OpenAI Chat Completions SSE.",
    provision: unimplementedProvision,
  },
};

/**
 * Precondition: vendor is a registered AgentVendor.
 * Postcondition: returns the vendor's mock adapter descriptor.
 */
export function getVendorMockAdapter(_vendor: AgentVendor): VendorMockAdapter {
  throw new Error("Not implemented");
}

/**
 * Precondition: vendor is a registered AgentVendor.
 * Postcondition: probes PATH and vendor fallbackPaths without executing network calls or mutating user config, returning binary availability and protocol support status.
 */
export function probeRealCli(
  _vendor: AgentVendor,
  _options?: { env?: NodeJS.ProcessEnv; userHome?: string; platform?: NodeJS.Platform },
): RealCliProbeStatus {
  throw new Error("Not implemented");
}

/**
 * Precondition: none.
 * Postcondition: returns probe status entries in VENDOR_LIST order for every registered vendor.
 */
export function listRealCliProbes(
  _options?: { env?: NodeJS.ProcessEnv; userHome?: string; platform?: NodeJS.Platform },
): readonly RealCliProbeStatus[] {
  throw new Error("Not implemented");
}

/**
 * Precondition: env defaults to process.env.
 * Postcondition: parses BELLWOOD_REQUIRE_REAL_CLI into validated AgentVendor IDs, throwing on unknown vendor names.
 */
export function resolveRequiredRealCliVendors(_env?: NodeJS.ProcessEnv): readonly AgentVendor[] {
  throw new Error("Not implemented");
}
