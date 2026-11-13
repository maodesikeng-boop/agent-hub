// Claude Code 一键安装、更新与界面内直接登录适配器（docs/providers-install-login-design.md 第 2.1、5.2 节）。
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import {
  PROVIDER_LOGOUT_TIMEOUT_MS,
  type ProviderAuthMethodDescriptor,
} from "../../shared/index.ts";
import type { VendorSetupAdapter, VendorSetupContext } from "../daemon-types.ts";
import { readBoundedJsonObject, runShortSubcommand } from "../_common/setup/file-helpers.ts";
import { runCliAuthFlowProcess } from "../_common/setup/spawn-auth-process.ts";

const CLAUDE_POSIX_INSTALL_URL = "https://claude.ai/install.sh";
const CLAUDE_WINDOWS_INSTALL_URL = "https://claude.ai/install.ps1";

const CLAUDE_AUTH_METHODS: readonly ProviderAuthMethodDescriptor[] = [
  {
    id: "browser",
    kind: "browser_oauth",
    label: "Browser",
    variants: [
      { id: "claudeai", label: "Claude Subscription" },
      { id: "console", label: "Anthropic Console" },
    ],
    manualInput: "code_or_callback",
  },
  {
    id: "api_key",
    kind: "api_key",
    label: "API key",
    placeholder: "sk-ant-...",
  },
];

function joinHome(userHome: string, ...parts: string[]): string {
  return /^[A-Za-z]:/.test(userHome) || userHome.startsWith("\\\\") || userHome.includes("\\")
    ? win32.join(userHome, ...parts)
    : posix.join(userHome, ...parts);
}

function readClaudeAccountEmail(ctx: VendorSetupContext): string | null {
  const configDir = ctx.env().CLAUDE_CONFIG_DIR?.trim();
  const claudeJsonPath = configDir ? joinHome(configDir, ".claude.json") : joinHome(ctx.userHome, ".claude.json");
  const doc = readBoundedJsonObject(claudeJsonPath);
  if (!doc) return null;
  const oauth = doc.oauthAccount;
  if (typeof oauth === "object" && oauth !== null && !Array.isArray(oauth)) {
    const record = oauth as Record<string, unknown>;
    for (const field of ["emailAddress", "email"]) {
      const val = record[field];
      if (typeof val === "string" && val.trim() !== "") return val.trim();
    }
  }
  return null;
}

function hasClaudeCredentialsFile(ctx: VendorSetupContext): boolean {
  const configDir = ctx.env().CLAUDE_CONFIG_DIR?.trim() || joinHome(ctx.userHome, ".claude");
  return existsSync(joinHome(configDir, ".credentials.json"));
}

export const claudeSetupAdapter: VendorSetupAdapter = {
  installRecipe(platform) {
    if (platform === "win32") {
      return { kind: "powershell_script", scriptUrl: CLAUDE_WINDOWS_INSTALL_URL };
    }
    return { kind: "posix_script", scriptUrl: CLAUDE_POSIX_INSTALL_URL, shell: "bash" };
  },

  updateRecipe() {
    return {
      kind: "cli_subcommand",
      args: ["update"],
      canUse: (binaryPath) => binaryPath.includes(".local"),
      fallbackToReinstall: true,
    };
  },

  async inspectAuth(ctx) {
    const hasManagedApiKey = ctx.secrets.has("claude", "ANTHROPIC_API_KEY");
    const hasManagedOauthToken = ctx.secrets.has("claude", "CLAUDE_CODE_OAUTH_TOKEN");
    if (hasManagedApiKey) {
      return {
        accountSummary: "API key configured",
        canSignOut: true,
        methods: CLAUDE_AUTH_METHODS,
      };
    }
    if (hasManagedOauthToken) {
      return {
        accountSummary: "Token configured",
        canSignOut: true,
        methods: CLAUDE_AUTH_METHODS,
      };
    }
    const email = readClaudeAccountEmail(ctx);
    if (email) {
      return {
        accountSummary: email,
        canSignOut: true,
        methods: CLAUDE_AUTH_METHODS,
      };
    }
    if (ctx.availability === "available" || hasClaudeCredentialsFile(ctx)) {
      return {
        accountSummary: "Signed in",
        canSignOut: true,
        methods: CLAUDE_AUTH_METHODS,
      };
    }
    return {
      accountSummary: null,
      canSignOut: false,
      methods: CLAUDE_AUTH_METHODS,
    };
  },

  async startAuthFlow(ctx, input, hooks, signal) {
    if (input.methodId !== "browser") {
      throw new Error(`Unsupported Claude sign-in method: ${input.methodId}`);
    }
    const modeFlag = input.variantId === "console" ? "--console" : "--claudeai";
    await runCliAuthFlowProcess({
      program: ctx.executablePath(),
      args: ["auth", "login", modeFlag],
      cwd: ctx.userHome,
      baseEnv: ctx.env(),
      platform: ctx.platform,
      purpose: "provider:auth:claude",
      hooks,
      signal,
    });
    // OAuth 登录成功后清理受管 API Key，避免环境变量抢占订阅账号身份
    ctx.secrets.remove("claude", ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
  },

  async saveApiKey(ctx, { apiKey }) {
    const trimmed = apiKey.trim();
    if (trimmed.startsWith("sk-ant-oat")) {
      ctx.secrets.remove("claude", ["ANTHROPIC_API_KEY"]);
      ctx.secrets.set("claude", { CLAUDE_CODE_OAUTH_TOKEN: trimmed });
    } else {
      ctx.secrets.remove("claude", ["CLAUDE_CODE_OAUTH_TOKEN"]);
      ctx.secrets.set("claude", { ANTHROPIC_API_KEY: trimmed });
    }
  },

  async signOut(ctx) {
    ctx.secrets.remove("claude");
    if (!ctx.installed()) return;
    await runShortSubcommand(ctx.executablePath(), ["auth", "logout"], {
      cwd: ctx.userHome,
      env: ctx.env(),
      timeoutMs: PROVIDER_LOGOUT_TIMEOUT_MS,
      purpose: "provider:logout:claude",
    }).catch(() => undefined);
  },
};
