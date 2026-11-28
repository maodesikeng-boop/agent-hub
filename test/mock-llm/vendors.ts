// Invariant: every registered vendor in VENDOR_LIST has an explicit adapter entry; no vendor is skipped silently.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { AGENT_VENDORS, vendorSpec, type AgentVendor } from "../../src/shared/index.ts";
import { VENDOR_FALLBACK_PATHS, findExecutable } from "../../src/shared/paths.ts";
import { assertIsolatedHome } from "./isolation.ts";
import { MOCK_LLM_REQUIRE_ENV } from "./limits.ts";
import type { ProvisionVendorInput, ProvisionedVendorConfig, RealCliProbeStatus, VendorMockAdapter } from "./types.ts";

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function writeTextFile(filePath: string, content: string): string {
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

function provisionClaude(input: ProvisionVendorInput): ProvisionedVendorConfig {
  assertIsolatedHome(input.homeDir);
  const model = input.model ?? "claude-sonnet-5-5";
  const claudeDir = join(input.homeDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = writeTextFile(join(claudeDir, "settings.json"), "{}\n");
  return {
    model,
    configFiles: [settingsPath],
    env: {
      ANTHROPIC_BASE_URL: stripTrailingSlash(input.mockBaseUrl),
      ANTHROPIC_API_KEY: "dummy-anthropic-local-key",
      CLAUDE_CONFIG_DIR: claudeDir,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
    },
  };
}

function provisionAgy(input: ProvisionVendorInput): ProvisionedVendorConfig {
  assertIsolatedHome(input.homeDir);
  const model = input.model ?? "gemini-3.8-flash";
  const agyDir = join(input.homeDir, ".gemini", "antigravity-cli");
  mkdirSync(agyDir, { recursive: true });
  const settingsPath = writeTextFile(
    join(agyDir, "settings.json"),
    `${JSON.stringify({ modelProvider: "gemini", enableTerminalSandbox: false }, null, 2)}\n`,
  );
  return {
    model,
    configFiles: [settingsPath],
    env: {
      GOOGLE_GEMINI_BASE_URL: stripTrailingSlash(input.mockBaseUrl),
      GEMINI_API_KEY: "dummy-gemini-local-key",
    },
  };
}

function provisionCodex(input: ProvisionVendorInput): ProvisionedVendorConfig {
  assertIsolatedHome(input.homeDir);
  const model = input.model ?? "gpt-6-luna";
  const codexDir = join(input.homeDir, ".codex");
  mkdirSync(codexDir, { recursive: true });
  const baseUrl = `${stripTrailingSlash(input.mockBaseUrl)}/v1`;
  const toml = [
    `model = ${JSON.stringify(model)}`,
    `model_provider = "mock"`,
    "",
    "[model_providers.mock]",
    `name = "Mock Local"`,
    `base_url = ${JSON.stringify(baseUrl)}`,
    `wire_api = "responses"`,
    `env_key = "OPENAI_API_KEY"`,
    "",
  ].join("\n");
  const configPath = writeTextFile(join(codexDir, "config.toml"), toml);
  return {
    model,
    configFiles: [configPath],
    env: {
      CODEX_HOME: codexDir,
      OPENAI_API_KEY: "dummy-openai-local-key",
    },
  };
}

function provisionPi(input: ProvisionVendorInput): ProvisionedVendorConfig {
  assertIsolatedHome(input.homeDir);
  const model = input.model ?? "mock/mock-model";
  const slashIdx = model.indexOf("/");
  const providerId = slashIdx > 0 ? model.slice(0, slashIdx) : "mock";
  const modelId = slashIdx > 0 ? model.slice(slashIdx + 1) : model;
  const piDir = join(input.homeDir, ".pi", "agent");
  mkdirSync(piDir, { recursive: true });
  const baseUrl = `${stripTrailingSlash(input.mockBaseUrl)}/v1`;
  const modelsJson = {
    providers: {
      [providerId]: {
        baseUrl,
        api: "openai-responses",
        apiKey: "dummy-pi-local-key",
        models: [
          {
            id: modelId,
            name: "Mock Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  };
  const modelsPath = writeTextFile(join(piDir, "models.json"), `${JSON.stringify(modelsJson, null, 2)}\n`);
  return {
    model: `${providerId}/${modelId}`,
    configFiles: [modelsPath],
    env: {
      PI_CODING_AGENT_DIR: piDir,
      PI_OFFLINE: "1",
    },
  };
}

function provisionDeepSeek(input: ProvisionVendorInput): ProvisionedVendorConfig {
  assertIsolatedHome(input.homeDir);
  const model = input.model ?? "deepseek-flash";
  const dshDir = join(input.homeDir, ".dsh");
  mkdirSync(dshDir, { recursive: true });
  const baseUrl = `${stripTrailingSlash(input.mockBaseUrl)}/v1`;
  const patchYaml = `- id: llm-deepseek\n  config:\n    baseURL: ${baseUrl}\n`;
  const patchPath = writeTextFile(join(dshDir, "cordis.patch.yml"), patchYaml);
  return {
    model,
    configFiles: [patchPath],
    env: {
      DSH_HOME: dshDir,
      DEEPSEEK_API_KEY: "dummy-deepseek-local-key",
      DSH_TELEMETRY_MODE: "OFF",
    },
  };
}

function provisionCursor(): never {
  throw new Error(
    "Vendor \"cursor\" is unsupported_protocol: cursor-agent speaks proprietary binary Protobuf/ConnectRPC services (/aiserver.v1.*).",
  );
}

function provisionOpenCode(input: ProvisionVendorInput): ProvisionedVendorConfig {
  assertIsolatedHome(input.homeDir);
  const model = input.model ?? "mock/mock-model";
  const slashIdx = model.indexOf("/");
  const providerId = slashIdx > 0 ? model.slice(0, slashIdx) : "mock";
  const modelId = slashIdx > 0 ? model.slice(slashIdx + 1) : model;
  const xdgConfigHome = join(input.homeDir, ".config");
  const ocDir = join(xdgConfigHome, "opencode");
  mkdirSync(ocDir, { recursive: true });
  const config = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Mock Local",
        options: {
          baseURL: `${stripTrailingSlash(input.mockBaseUrl)}/v1`,
          apiKey: "dummy-opencode-local-key",
        },
        models: {
          [modelId]: { name: "Mock Local Model" },
        },
      },
    },
    model: `${providerId}/${modelId}`,
  };
  const configPath = writeTextFile(join(ocDir, "opencode.json"), `${JSON.stringify(config, null, 2)}\n`);
  return {
    model: `${providerId}/${modelId}`,
    configFiles: [configPath],
    env: {
      XDG_CONFIG_HOME: xdgConfigHome,
      OPENCODE_API_KEY: "dummy-opencode-local-key",
    },
  };
}

function provisionKimi(input: ProvisionVendorInput): ProvisionedVendorConfig {
  assertIsolatedHome(input.homeDir);
  const model = input.model ?? "kimi-k3";
  const kimiDir = join(input.homeDir, ".kimi-code");
  mkdirSync(kimiDir, { recursive: true });
  const configPath = writeTextFile(join(kimiDir, "config.toml"), `default_model = ${JSON.stringify(model)}\n`);
  return {
    model,
    configFiles: [configPath],
    env: {
      KIMI_CODE_HOME: kimiDir,
      KIMI_MODEL_API_KEY: "dummy-kimi-local-key",
      KIMI_MODEL_NAME: model,
      KIMI_MODEL_PROVIDER_TYPE: "kimi",
      KIMI_MODEL_BASE_URL: `${stripTrailingSlash(input.mockBaseUrl)}/v1`,
    },
  };
}

export const VENDOR_MOCK_ADAPTERS: Readonly<Record<AgentVendor, VendorMockAdapter>> = {
  claude: {
    vendor: "claude",
    support: "full",
    dialect: "anthropic-messages",
    defaultModel: "claude-sonnet-5-5",
    reason: "Supports ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY + CLAUDE_CONFIG_DIR over Anthropic Messages SSE.",
    provision: provisionClaude,
  },
  agy: {
    vendor: "agy",
    support: "full",
    dialect: "gemini-generate-content",
    defaultModel: "gemini-3.8-flash",
    reason: "Supports settings.json modelProvider=gemini + GEMINI_API_KEY + GOOGLE_GEMINI_BASE_URL over Gemini GenerateContent SSE.",
    provision: provisionAgy,
  },
  codex: {
    vendor: "codex",
    support: "full",
    dialect: "openai-responses",
    defaultModel: "gpt-6-luna",
    reason: "Supports CODEX_HOME/config.toml model_providers.<id>.base_url + wire_api=responses over OpenAI Responses SSE.",
    provision: provisionCodex,
  },
  pi: {
    vendor: "pi",
    support: "full",
    dialect: "openai-responses",
    defaultModel: "mock/mock-model",
    reason: "Supports PI_CODING_AGENT_DIR/models.json custom provider baseUrl over OpenAI Responses, Chat Completions, or Anthropic Messages SSE.",
    provision: provisionPi,
  },
  deepseek: {
    vendor: "deepseek",
    support: "full",
    dialect: "anthropic-messages",
    defaultModel: "deepseek-flash",
    reason: "Supports DSH_HOME/cordis.patch.yml llm-deepseek.baseURL + DEEPSEEK_API_KEY over Anthropic Messages SSE.",
    provision: provisionDeepSeek,
  },
  cursor: {
    vendor: "cursor",
    support: "unsupported_protocol",
    dialect: null,
    defaultModel: "default",
    reason: "Redirects --endpoint/CURSOR_API_ENDPOINT to loopback, but speaks proprietary binary Protobuf/ConnectRPC services (/aiserver.v1.*).",
    provision: provisionCursor,
  },
  opencode: {
    vendor: "opencode",
    support: "full",
    dialect: "openai-chat-completions",
    defaultModel: "mock/mock-model",
    reason: "Supports XDG_CONFIG_HOME/opencode/opencode.json custom provider options.baseURL over OpenAI-compatible SSE.",
    provision: provisionOpenCode,
  },
  kimi: {
    vendor: "kimi",
    support: "full",
    dialect: "openai-chat-completions",
    defaultModel: "kimi-k3",
    reason: "Supports KIMI_CODE_HOME + KIMI_MODEL_BASE_URL + KIMI_MODEL_API_KEY + KIMI_MODEL_NAME + KIMI_MODEL_PROVIDER_TYPE over OpenAI Chat Completions SSE.",
    provision: provisionKimi,
  },
};

export function getVendorMockAdapter(vendor: AgentVendor): VendorMockAdapter {
  return VENDOR_MOCK_ADAPTERS[vendor];
}

function existsFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveAbsoluteExecutable(
  cmd: string,
  envPath: string | undefined,
  fallbacks: readonly string[],
  platform: NodeJS.Platform,
  pathExt?: string,
): string | null {
  if (platform === "win32") {
    return findExecutable(cmd, envPath, fallbacks, { platform: "win32", pathExt });
  }
  if (cmd.includes("/")) return existsFile(cmd) ? cmd : null;
  if (envPath) {
    for (const rawDir of envPath.split(posix.delimiter)) {
      const dir = rawDir.trim();
      if (!dir) continue;
      const candidate = posix.join(dir, cmd);
      if (existsFile(candidate)) return candidate;
    }
  }
  for (const fb of fallbacks) {
    if (existsFile(fb)) return fb;
  }
  return null;
}

function envLookupCaseInsensitive(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (env[key] !== undefined) return env[key];
  const lower = key.toLowerCase();
  const hit = Object.keys(env).find((k) => k.toLowerCase() === lower && env[k] !== undefined);
  return hit ? env[hit] : undefined;
}

export function probeRealCli(
  vendor: AgentVendor,
  options?: { env?: NodeJS.ProcessEnv; userHome?: string; platform?: NodeJS.Platform },
): RealCliProbeStatus {
  const adapter = getVendorMockAdapter(vendor);
  const spec = vendorSpec(vendor);
  const env = options?.env ?? process.env;
  const userHome = options?.userHome ?? homedir();
  const platform = options?.platform ?? process.platform;
  const envPath = platform === "win32" ? envLookupCaseInsensitive(env, "PATH") : env.PATH;
  const pathExt = platform === "win32" ? envLookupCaseInsensitive(env, "PATHEXT") : undefined;
  const fallbacks = VENDOR_FALLBACK_PATHS[vendor](userHome, platform);
  const explicitOverride = env[spec.cli.envVar]?.trim();
  const cmd = explicitOverride && explicitOverride !== "" ? explicitOverride : spec.cli.command;
  const executablePath = resolveAbsoluteExecutable(cmd, envPath, fallbacks, platform, pathExt);
  if (executablePath !== null) {
    return {
      vendor,
      support: adapter.support,
      installed: true,
      executablePath: platform === "win32" ? win32.normalize(executablePath) : executablePath,
      reason: adapter.reason,
    };
  }
  return {
    vendor,
    support: adapter.support,
    installed: false,
    executablePath: null,
    reason: `not_installed: "${spec.cli.command}" not found on PATH or standard install paths. ${adapter.reason}`,
  };
}

export function listRealCliProbes(
  options?: { env?: NodeJS.ProcessEnv; userHome?: string; platform?: NodeJS.Platform },
): readonly RealCliProbeStatus[] {
  return AGENT_VENDORS.map((vendor) => probeRealCli(vendor, options));
}

export function resolveRequiredRealCliVendors(env: NodeJS.ProcessEnv = process.env): readonly AgentVendor[] {
  const raw = env[MOCK_LLM_REQUIRE_ENV]?.trim();
  if (!raw) return [];
  const valid = new Set<string>(AGENT_VENDORS);
  const out: AgentVendor[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    if (!valid.has(trimmed)) {
      throw new Error(`Unknown vendor "${trimmed}" in ${MOCK_LLM_REQUIRE_ENV}; expected one of: ${AGENT_VENDORS.join(", ")}`);
    }
    const vendor = trimmed as AgentVendor;
    if (!out.includes(vendor)) out.push(vendor);
  }
  return out;
}
