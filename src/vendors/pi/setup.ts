// Pi 一键安装、更新与界面内直接登录适配器（docs/providers-install-login-design.md 第 1.6、2.1、2.2.4 节）：
// - 安装：官方脚本 `pi.dev/install.sh` / `install.ps1`（前置守护进程 Node 24 + npm，失败自动回退受管 `npm install --ignore-scripts`）；
// - 多子模型商管理：原子合并读写 `$PI_CODING_AGENT_DIR/auth.json`（`0600`），保留其他已配模型商不丢失；
// - OAuth / Device Code：对支持账号登录的子模型商运行 `pi auth login <id> [--no-browser]`（配合 TTY 垫片与 `BROWSER` 拦截）。
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import {
  PROVIDER_LOGOUT_TIMEOUT_MS,
  type ProviderAuthMethodDescriptor,
  type ProviderAuthTarget,
} from "../../shared/index.ts";
import { vendorConfigHome } from "../../shared/paths.ts";
import type { VendorSetupAdapter, VendorSetupContext } from "../daemon-types.ts";
import {
  readBoundedJsonObject,
  runShortSubcommand,
  writePrivateFileAtomic,
} from "../_common/setup/file-helpers.ts";
import { runCliAuthFlowProcess } from "../_common/setup/spawn-auth-process.ts";

const PI_POSIX_INSTALL_URL = "https://pi.dev/install.sh";
const PI_WINDOWS_INSTALL_URL = "https://pi.dev/install.ps1";
const PI_NPM_PACKAGE = "@earendil-works/pi-coding-agent";
const TARGET_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/iu;

interface PiSubProviderPreset {
  readonly id: string;
  readonly label: string;
  readonly supportsOauth: boolean;
}

/** 常用内置子模型商列表（按设计第 1.6 节高频优先排列）。 */
export const PI_BUILTIN_SUB_PROVIDERS: readonly PiSubProviderPreset[] = [
  { id: "deepseek", label: "DeepSeek", supportsOauth: false },
  { id: "anthropic", label: "Anthropic", supportsOauth: true },
  { id: "openai-codex", label: "OpenAI Codex", supportsOauth: true },
  { id: "openai", label: "OpenAI", supportsOauth: false },
  { id: "google", label: "Google Gemini", supportsOauth: true },
  { id: "openrouter", label: "OpenRouter", supportsOauth: true },
  { id: "github-copilot", label: "GitHub Copilot", supportsOauth: true },
  { id: "xai", label: "xAI", supportsOauth: true },
  { id: "mistral", label: "Mistral", supportsOauth: false },
  { id: "groq", label: "Groq", supportsOauth: false },
  { id: "cerebras", label: "Cerebras", supportsOauth: false },
  { id: "together", label: "Together AI", supportsOauth: false },
  { id: "fireworks", label: "Fireworks AI", supportsOauth: false },
  { id: "moonshot", label: "Moonshot / Kimi", supportsOauth: false },
  { id: "minimax", label: "MiniMax", supportsOauth: false },
  { id: "zai", label: "Z.ai (GLM)", supportsOauth: false },
];

function joinByStyle(base: string, ...parts: string[]): string {
  return /^[A-Za-z]:/.test(base) || base.startsWith("\\\\") || base.includes("\\")
    ? win32.join(base, ...parts)
    : posix.join(base, ...parts);
}

export function resolvePiAuthJsonPath(ctx: Pick<VendorSetupContext, "userHome" | "env">): string {
  const agentDir = vendorConfigHome("pi", ctx.userHome, ctx.env()) ?? joinByStyle(ctx.userHome, ".pi", "agent");
  return joinByStyle(agentDir, "auth.json");
}

function isValidStoredPiEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const rec = entry as Record<string, unknown>;
  if (rec.type === "api_key") {
    return typeof rec.key === "string" && rec.key.trim() !== "";
  }
  if (rec.type === "oauth") {
    return true;
  }
  return Object.keys(rec).length > 0;
}

export function readPiAuthMap(authPath: string): Record<string, Record<string, unknown>> {
  if (!existsSync(authPath)) return {};
  const raw = readBoundedJsonObject(authPath);
  if (!raw) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      out[k] = v as Record<string, unknown>;
    }
  }
  return out;
}

function buildPiTargets(configuredIds: ReadonlySet<string>): ProviderAuthTarget[] {
  const seen = new Set<string>();
  const targets: ProviderAuthTarget[] = [];
  for (const preset of PI_BUILTIN_SUB_PROVIDERS) {
    seen.add(preset.id);
    targets.push({
      id: preset.id,
      label: preset.label,
      configured: configuredIds.has(preset.id),
      ...(preset.supportsOauth ? { supportsOauth: true } : {}),
    });
  }
  for (const customId of [...configuredIds].sort()) {
    if (seen.has(customId)) continue;
    targets.push({
      id: customId,
      label: customId,
      configured: true,
    });
  }
  return targets;
}

function buildPiAuthMethods(targets: readonly ProviderAuthTarget[]): ProviderAuthMethodDescriptor[] {
  const oauthTargetIds = targets.filter((t) => t.supportsOauth === true).map((t) => t.id);
  return [
    {
      id: "api_key",
      kind: "api_key",
      label: "API key",
      placeholder: "sk-...",
      targets,
    },
    {
      id: "browser",
      kind: "browser_oauth",
      label: "Browser",
      manualInput: "code_or_callback",
      preferDeviceCodeWhenRemote: true,
      targetIds: oauthTargetIds,
    },
    {
      id: "device_code",
      kind: "device_code",
      label: "Device code",
      targetIds: oauthTargetIds,
    },
  ];
}

function normalizeTargetId(rawTargetId: string | undefined): string {
  const id = (rawTargetId ?? PI_BUILTIN_SUB_PROVIDERS[0]!.id).trim();
  if (!TARGET_ID_RE.test(id)) {
    throw new Error(`Invalid Pi model provider id: ${id}`);
  }
  return id;
}

export const piSetupAdapter: VendorSetupAdapter = {
  installRecipe(platform) {
    const npmFallback = {
      kind: "npm" as const,
      packageSpec: PI_NPM_PACKAGE,
      extraArgs: ["--ignore-scripts"] as const,
    };
    if (platform === "win32") {
      return {
        kind: "powershell_script",
        scriptUrl: PI_WINDOWS_INSTALL_URL,
        fallback: npmFallback,
      };
    }
    return {
      kind: "posix_script",
      scriptUrl: PI_POSIX_INSTALL_URL,
      shell: "sh",
      fallback: npmFallback,
    };
  },

  updateRecipe() {
    return {
      kind: "cli_subcommand",
      args: ["update", "pi"],
      fallbackToReinstall: true,
    };
  },

  async inspectAuth(ctx) {
    const authPath = resolvePiAuthJsonPath(ctx);
    const map = readPiAuthMap(authPath);
    const configuredIds = new Set<string>(
      Object.entries(map)
        .filter(([, entry]) => isValidStoredPiEntry(entry))
        .map(([id]) => id),
    );
    const targets = buildPiTargets(configuredIds);
    const methods = buildPiAuthMethods(targets);

    if (configuredIds.size > 0) {
      return {
        accountSummary: `${configuredIds.size} configured`,
        canSignOut: true,
        methods,
      };
    }
    if (ctx.availability === "available") {
      return {
        accountSummary: "Signed in",
        canSignOut: false,
        methods,
      };
    }
    return {
      accountSummary: null,
      canSignOut: false,
      methods,
    };
  },

  async startAuthFlow(ctx, input, hooks, signal) {
    const targetId = normalizeTargetId(input.targetId ?? "openai-codex");
    const useNoBrowser = input.methodId === "device_code" || input.remoteHint === true;
    const args = useNoBrowser
      ? ["auth", "login", targetId, "--no-browser"]
      : ["auth", "login", targetId];

    await runCliAuthFlowProcess({
      program: ctx.executablePath(),
      args,
      cwd: ctx.userHome,
      baseEnv: ctx.env(),
      platform: ctx.platform,
      purpose: `provider:auth:pi:${targetId}`,
      hooks,
      signal,
      fakeNodeTty: true,
      expectDeviceCode: input.methodId === "device_code",
    });
  },

  async saveApiKey(ctx, { targetId, apiKey }) {
    const providerId = normalizeTargetId(targetId);
    const authPath = resolvePiAuthJsonPath(ctx);
    const current = readPiAuthMap(authPath);
    const next: Record<string, Record<string, unknown>> = {
      ...current,
      [providerId]: {
        type: "api_key",
        key: apiKey.trim(),
      },
    };
    writePrivateFileAtomic(authPath, `${JSON.stringify(next, null, 2)}\n`, ctx.platform);
  },

  async signOut(ctx, input) {
    const authPath = resolvePiAuthJsonPath(ctx);
    if (input?.targetId) {
      const providerId = normalizeTargetId(input.targetId);
      if (existsSync(authPath)) {
        const current = readPiAuthMap(authPath);
        delete current[providerId];
        writePrivateFileAtomic(authPath, `${JSON.stringify(current, null, 2)}\n`, ctx.platform);
      }
      if (ctx.installed()) {
        await runShortSubcommand(ctx.executablePath(), ["auth", "logout", providerId], {
          cwd: ctx.userHome,
          env: ctx.env(),
          timeoutMs: PROVIDER_LOGOUT_TIMEOUT_MS,
          purpose: `provider:logout:pi:${providerId}`,
        }).catch(() => undefined);
      }
      return;
    }

    if (existsSync(authPath)) {
      writePrivateFileAtomic(authPath, "{}\n", ctx.platform);
    }
  },
};
