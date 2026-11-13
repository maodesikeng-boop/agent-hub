// Cursor (cursor-agent) 一键安装、更新与界面内直接登录适配器（docs/providers-install-login-design.md 第 2.1 节）：
// - 安装：官方脚本 `cursor.com/install` / `cursor.com/install?win32=true`；
// - 登录：`NO_OPEN_BROWSER=1 cursor-agent login` 云端轮询（本机与远端东京服务器均零粘贴落盘；Linux 无 keyring 时设 `AGENT_CLI_CREDENTIAL_STORE=file`）；
// - API Key：受管存储 `CURSOR_API_KEY`。
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import {
  PROVIDER_LOGOUT_TIMEOUT_MS,
  type ProviderAuthMethodDescriptor,
} from "../../shared/index.ts";
import type { VendorSetupAdapter, VendorSetupContext } from "../daemon-types.ts";
import { readBoundedJsonObject, runShortSubcommand } from "../_common/setup/file-helpers.ts";
import { runCliAuthFlowProcess } from "../_common/setup/spawn-auth-process.ts";

const CURSOR_POSIX_INSTALL_URL = "https://cursor.com/install";
const CURSOR_WINDOWS_INSTALL_URL = "https://cursor.com/install?win32=true";

const CURSOR_AUTH_METHODS: readonly ProviderAuthMethodDescriptor[] = [
  {
    id: "browser",
    kind: "browser_oauth",
    label: "Browser",
    manualInput: "none",
  },
  {
    id: "api_key",
    kind: "api_key",
    label: "API key",
    placeholder: "key_...",
  },
];

function joinByStyle(base: string, ...parts: string[]): string {
  return /^[A-Za-z]:/.test(base) || base.startsWith("\\\\") || base.includes("\\")
    ? win32.join(base, ...parts)
    : posix.join(base, ...parts);
}

function readCursorAuthEmail(userHome: string): string | null {
  for (const rel of [
    [".cursor", "auth.json"],
    [".config", "cursor", "auth.json"],
    [".cursor", "cli-config.json"],
  ] as const) {
    const obj = readBoundedJsonObject(joinByStyle(userHome, ...rel));
    if (!obj) continue;
    for (const field of ["email", "userEmail", "accountEmail"]) {
      const val = obj[field];
      if (typeof val === "string" && val.trim() !== "") return val.trim();
    }
  }
  return null;
}

function hasCursorAuthFile(userHome: string): boolean {
  return (
    existsSync(joinByStyle(userHome, ".cursor", "auth.json")) ||
    existsSync(joinByStyle(userHome, ".config", "cursor", "auth.json"))
  );
}

function extraCursorStoreEnv(ctx: VendorSetupContext): Record<string, string> {
  const env = ctx.env();
  if (ctx.platform === "linux" && !env.DBUS_SESSION_BUS_ADDRESS && !env.AGENT_CLI_CREDENTIAL_STORE) {
    return { AGENT_CLI_CREDENTIAL_STORE: "file" };
  }
  return {};
}

export const cursorSetupAdapter: VendorSetupAdapter = {
  installRecipe(platform) {
    if (platform === "win32") {
      return { kind: "powershell_script", scriptUrl: CURSOR_WINDOWS_INSTALL_URL };
    }
    return { kind: "posix_script", scriptUrl: CURSOR_POSIX_INSTALL_URL, shell: "bash" };
  },

  updateRecipe() {
    return { kind: "cli_subcommand", args: ["update"], fallbackToReinstall: true };
  },

  async inspectAuth(ctx) {
    if (ctx.secrets.has("cursor", "CURSOR_API_KEY")) {
      return {
        accountSummary: "API key configured",
        canSignOut: true,
        methods: CURSOR_AUTH_METHODS,
      };
    }
    const email = readCursorAuthEmail(ctx.userHome);
    if (email) {
      return {
        accountSummary: email,
        canSignOut: true,
        methods: CURSOR_AUTH_METHODS,
      };
    }
    if (ctx.availability === "available" || hasCursorAuthFile(ctx.userHome)) {
      return {
        accountSummary: "Signed in",
        canSignOut: true,
        methods: CURSOR_AUTH_METHODS,
      };
    }
    return {
      accountSummary: null,
      canSignOut: false,
      methods: CURSOR_AUTH_METHODS,
    };
  },

  async startAuthFlow(ctx, input, hooks, signal) {
    if (input.methodId !== "browser") {
      throw new Error(`Unsupported Cursor sign-in method: ${input.methodId}`);
    }
    await runCliAuthFlowProcess({
      program: ctx.executablePath(),
      args: ["login"],
      cwd: ctx.userHome,
      baseEnv: ctx.env(),
      extraEnv: {
        NO_OPEN_BROWSER: "1",
        ...extraCursorStoreEnv(ctx),
      },
      platform: ctx.platform,
      purpose: "provider:auth:cursor",
      hooks,
      signal,
    });
    ctx.secrets.remove("cursor", ["CURSOR_API_KEY"]);
  },

  async saveApiKey(ctx, { apiKey }) {
    ctx.secrets.set("cursor", { CURSOR_API_KEY: apiKey.trim() });
  },

  async signOut(ctx) {
    ctx.secrets.remove("cursor");
    if (!ctx.installed()) return;
    await runShortSubcommand(ctx.executablePath(), ["logout"], {
      cwd: ctx.userHome,
      env: { ...ctx.env(), ...extraCursorStoreEnv(ctx) },
      timeoutMs: PROVIDER_LOGOUT_TIMEOUT_MS,
      purpose: "provider:logout:cursor",
    }).catch(() => undefined);
  },
};
