import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ProviderAuthMethodDescriptor, ProviderAuthTarget } from "../../shared/index.ts";
import type { VendorSetupAdapter, VendorSetupContext } from "../daemon-types.ts";
import { runCliAuthFlowProcess } from "../_common/setup/spawn-auth-process.ts";
import { hasKimiOAuthCredentials } from "./catalog.ts";
import { KIMI_MAX_CREDENTIAL_ENTRIES } from "./limits.ts";
import { resolveKimiHome } from "./paths.ts";

const KIMI_POSIX_INSTALL_URL = "https://code.kimi.com/kimi-code/install.sh";
const KIMI_WINDOWS_INSTALL_URL = "https://code.kimi.com/kimi-code/install.ps1";
const KIMI_NPM_SPEC = "@moonshot-ai/kimi-code";
const API_KEY_ENV = "KIMI_MODEL_API_KEY";

// Kimi reads platform keys only from config.toml or the KIMI_MODEL_* variables, so the key defines an env model.
const KIMI_PLATFORMS = [
  { id: "moonshot-ai", label: "platform.kimi.ai", baseUrl: "https://api.moonshot.ai/v1" },
  { id: "moonshot-cn", label: "platform.kimi.com", baseUrl: "https://api.moonshot.cn/v1" },
] as const;
const PLATFORM_MODEL = "kimi-k3";

function configuredPlatform(ctx: VendorSetupContext): string | null {
  if (!ctx.secrets.has("kimi", API_KEY_ENV)) return null;
  const baseUrl = ctx.secrets.getEnv("kimi").KIMI_MODEL_BASE_URL;
  return KIMI_PLATFORMS.find((p) => p.baseUrl === baseUrl)?.id ?? null;
}

function authMethods(ctx: VendorSetupContext): readonly ProviderAuthMethodDescriptor[] {
  const configured = configuredPlatform(ctx);
  const targets: ProviderAuthTarget[] = KIMI_PLATFORMS.map((p) => ({ id: p.id, label: p.label, configured: p.id === configured }));
  return [
    { id: "device_code", kind: "device_code", label: "Kimi Code account" },
    { id: "api_key", kind: "api_key", label: "Kimi Platform API key", placeholder: "sk-...", targets },
  ];
}

function removeKimiOAuthCredentials(kimiHome: string): void {
  const dir = join(kimiHome, "credentials");
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true }).slice(0, KIMI_MAX_CREDENTIAL_ENTRIES);
  } catch {
    return;
  }
  // Only the managed Kimi Code login; MCP OAuth tokens live in credentials/mcp/.
  for (const entry of entries) {
    if (entry.isFile() && entry.name.startsWith("kimi-code") && entry.name.endsWith(".json")) rmSync(join(dir, entry.name), { force: true });
  }
}

export const kimiSetupAdapter: VendorSetupAdapter = {
  installRecipe(platform) {
    const fallback = { kind: "npm", packageSpec: KIMI_NPM_SPEC } as const;
    if (platform === "win32") return { kind: "powershell_script", scriptUrl: KIMI_WINDOWS_INSTALL_URL, fallback };
    return { kind: "posix_script", scriptUrl: KIMI_POSIX_INSTALL_URL, shell: "bash", fallback };
  },

  updateRecipe() {
    return { kind: "cli_subcommand", args: ["upgrade"], fallbackToReinstall: true };
  },

  async inspectAuth(ctx) {
    const methods = authMethods(ctx);
    if (ctx.secrets.has("kimi", API_KEY_ENV)) return { accountSummary: "API key configured", canSignOut: true, methods };
    const kimiHome = resolveKimiHome(ctx.userHome, ctx.env());
    if (hasKimiOAuthCredentials(kimiHome) || ctx.availability === "available") {
      return { accountSummary: "Signed in", canSignOut: true, methods };
    }
    return { accountSummary: null, canSignOut: false, methods };
  },

  async startAuthFlow(ctx, input, hooks, signal) {
    if (input.methodId !== "device_code") throw new Error(`Unsupported Kimi Code sign-in method: ${input.methodId}`);
    await runCliAuthFlowProcess({
      program: ctx.executablePath(),
      args: ["login"],
      cwd: ctx.userHome,
      baseEnv: ctx.env(),
      platform: ctx.platform,
      purpose: "provider:auth:kimi",
      hooks,
      signal,
      expectDeviceCode: true,
      interceptSystemOpeners: true,
    });
    ctx.secrets.remove("kimi");
  },

  async saveApiKey(ctx, { targetId, apiKey }) {
    const platform = KIMI_PLATFORMS.find((p) => p.id === targetId) ?? KIMI_PLATFORMS[0];
    ctx.secrets.set("kimi", {
      [API_KEY_ENV]: apiKey.trim(),
      KIMI_MODEL_NAME: PLATFORM_MODEL,
      KIMI_MODEL_PROVIDER_TYPE: "kimi",
      KIMI_MODEL_BASE_URL: platform.baseUrl,
    });
  },

  async signOut(ctx) {
    ctx.secrets.remove("kimi");
    removeKimiOAuthCredentials(resolveKimiHome(ctx.userHome, ctx.env()));
  },
};
