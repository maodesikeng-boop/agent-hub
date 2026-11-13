// Antigravity (agy) 一键安装、更新与界面内直接登录适配器（docs/providers-install-login-design.md 第 2.1、2.2.2 节）：
// - Google / Enterprise OAuth：启动 `agy acp` 执行 `initialize` → `authenticate`（`oauth-personal` / `oauth-business`），通过 `BROWSER` 拦截 URL；
// - Gemini API Key：受管存储 `GEMINI_API_KEY` + 原子局部补丁 `~/.gemini/antigravity-cli/settings.json` 的 `"modelProvider": "gemini"`（双开关联动）。
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { posix, win32 } from "node:path";
import { applyEdits, modify, type FormattingOptions } from "jsonc-parser";
import { killThenSettle } from "../../daemon/driver/model-catalog.ts";
import { termGroupAfterExit } from "../../daemon/driver/process.ts";
import { buildChildEnv } from "../../daemon/driver/protocol.ts";
import { spawnOwnedProcess } from "../../daemon/platform/index.ts";
import { trackChild } from "../../daemon/process-ledger.ts";
import {
  PROVIDER_LOGOUT_TIMEOUT_MS,
  type ProviderAuthMethodDescriptor,
} from "../../shared/index.ts";
import type { AuthFlowHooks, VendorSetupAdapter, VendorSetupContext } from "../daemon-types.ts";
import { readJsoncObjectFile } from "../_common/sync/jsonc.ts";
import {
  createBrowserCaptureSession,
  extractAuthorizeUrlFromOutput,
  stripAnsi,
} from "../_common/setup/browser-capture.ts";
import { readBoundedJsonObject, writePrivateFileAtomic } from "../_common/setup/file-helpers.ts";
import { agyCliDataDir } from "./paths.ts";

const AGY_POSIX_INSTALL_URL = "https://antigravity.google/cli/install.sh";
const AGY_WINDOWS_INSTALL_URL = "https://antigravity.google/cli/install.ps1";

const JSONC_FORMAT: FormattingOptions = {
  tabSize: 2,
  insertSpaces: true,
  eol: "\n",
};

const AGY_AUTH_METHODS: readonly ProviderAuthMethodDescriptor[] = [
  {
    id: "browser",
    kind: "browser_oauth",
    label: "Google Account",
    variants: [
      { id: "oauth-personal", label: "Personal Google" },
      { id: "oauth-business", label: "Gemini Enterprise" },
    ],
    manualInput: "code_or_callback",
  },
  {
    id: "api_key",
    kind: "api_key",
    label: "API key",
    placeholder: "AIza...",
  },
];

function joinByStyle(base: string, ...parts: string[]): string {
  return /^[A-Za-z]:/.test(base) || base.startsWith("\\\\") || base.includes("\\")
    ? win32.join(base, ...parts)
    : posix.join(base, ...parts);
}

/**
 * 原子联动增删 `~/.gemini/antigravity-cli/settings.json` 中的 `"modelProvider": "gemini"`：
 * - 保存 `GEMINI_API_KEY` 时写入 `"modelProvider": "gemini"`；
 * - 移除 `GEMINI_API_KEY`、登出或切回 Google OAuth 时，若当前值为 `"gemini"` 则移除该字段，防止缺少环境变量导致 `agy` 启动报错。
 */
export function patchAgySettingsModelProvider(
  userHome: string,
  mode: "gemini" | "clear",
  platform: string = process.platform,
): void {
  const settingsPath = joinByStyle(agyCliDataDir(userHome), "settings.json");
  if (mode === "clear" && !existsSync(settingsPath)) return;

  const doc = readJsoncObjectFile(settingsPath);
  let content = doc.exists && doc.raw.trim() !== "" ? doc.raw : "{}\n";

  if (mode === "gemini") {
    const edits = modify(content, ["modelProvider"], "gemini", { formattingOptions: JSONC_FORMAT });
    content = applyEdits(content, edits);
  } else {
    if (doc.data.modelProvider !== "gemini") return;
    const edits = modify(content, ["modelProvider"], undefined, { formattingOptions: JSONC_FORMAT });
    content = applyEdits(content, edits);
  }

  if (!content.endsWith("\n")) content += "\n";
  writePrivateFileAtomic(settingsPath, content, platform);
}

function readAgyOauthEmail(userHome: string): string | null {
  const credsPath = joinByStyle(userHome, ".gemini", "oauth_creds.json");
  const obj = readBoundedJsonObject(credsPath);
  if (!obj) return null;
  for (const field of ["email", "account", "user_email"]) {
    const val = obj[field];
    if (typeof val === "string" && val.trim() !== "") return val.trim();
  }
  return null;
}

async function runAgyAcpRpc(options: {
  agyPath: string;
  cwd: string;
  baseEnv: Record<string, string | undefined>;
  platform: string;
  method: "authenticate" | "logout";
  params: Record<string, unknown>;
  hooks?: AuthFlowHooks;
  signal: AbortSignal;
}): Promise<void> {
  const { agyPath, cwd, baseEnv, platform, method, params, hooks, signal } = options;
  if (signal.aborted) throw new Error("cancelled");

  let urlEmitted = false;
  const emitUrl = (url: string) => {
    if (urlEmitted || !hooks) return;
    urlEmitted = true;
    hooks.onAuthorizeUrl(url);
  };

  const capture = hooks
    ? createBrowserCaptureSession({ platform, onUrl: emitUrl })
    : null;

  try {
    const cleanBase = buildChildEnv(baseEnv, undefined);
    const childEnv = capture ? capture.applyEnv(cleanBase) : cleanBase;

    await new Promise<void>((resolve, reject) => {
      let spawned: { child: ChildProcessWithoutNullStreams; detached: boolean };
      try {
        spawned = spawnOwnedProcess(agyPath, ["acp"], {
          cwd,
          env: childEnv,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      const { child, detached } = spawned;
      trackChild(child, `provider:agy-acp:${method}`, { detached });
      child.once("exit", () => termGroupAfterExit(child));
      child.stdin.on("error", () => {});

      hooks?.onUserInput((input) => {
        if (child.exitCode === null && child.signalCode === null && !child.stdin.destroyed) {
          child.stdin.write(`${input.trim()}\n`);
        }
      });

      let stderrTail = "";
      let settled = false;

      const finish = (err: Error | null) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        rl.close();
        if (child.exitCode === null && child.signalCode === null) {
          killThenSettle(child, () => (err ? reject(err) : resolve()));
        } else if (err) {
          reject(err);
        } else {
          resolve();
        }
      };

      const onAbort = () => finish(new Error("cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });

      child.once("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-8192);
        capture?.pollOnce();
        const url = extractAuthorizeUrlFromOutput(stderrTail);
        if (url) emitUrl(url);
      });

      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on("line", (line) => {
        capture?.pollOnce();
        const trimmed = line.trim();
        if (trimmed === "") return;
        if (!trimmed.startsWith("{")) {
          const url = extractAuthorizeUrlFromOutput(trimmed);
          if (url) emitUrl(url);
          return;
        }
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          return;
        }
        if (msg.id === 1) {
          if (msg.error) {
            const errObj = msg.error as { message?: unknown };
            finish(new Error(typeof errObj.message === "string" ? errObj.message : "ACP initialize failed"));
            return;
          }
          child.stdin.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: method === "logout" ? "auth/logout" : "authenticate",
              params,
            })}\n`,
          );
          return;
        }
        if (msg.id === 2) {
          if (msg.error) {
            const errObj = msg.error as { message?: unknown; data?: unknown };
            const detail =
              typeof errObj.data === "string" && errObj.data.trim() !== ""
                ? errObj.data.trim()
                : typeof errObj.message === "string"
                  ? errObj.message
                  : `ACP ${method} failed`;
            finish(new Error(detail));
            return;
          }
          finish(null);
        }
      });

      child.once("close", (code, sig) => {
        if (settled) return;
        const cleanErr = stripAnsi(stderrTail).trim();
        finish(new Error(cleanErr || `Antigravity exited before completing ${method} (${sig ?? `code ${code}`})`));
      });

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: "fusa", version: "0.1.0" },
          },
        })}\n`,
      );
    });
  } finally {
    capture?.dispose();
  }
}

export const agySetupAdapter: VendorSetupAdapter = {
  installRecipe(platform) {
    if (platform === "win32") {
      return { kind: "powershell_script", scriptUrl: AGY_WINDOWS_INSTALL_URL };
    }
    return { kind: "posix_script", scriptUrl: AGY_POSIX_INSTALL_URL, shell: "bash" };
  },

  updateRecipe() {
    return { kind: "cli_subcommand", args: ["update"], fallbackToReinstall: true };
  },

  async inspectAuth(ctx) {
    if (ctx.secrets.has("agy", "GEMINI_API_KEY")) {
      return {
        accountSummary: "API key configured",
        canSignOut: true,
        methods: AGY_AUTH_METHODS,
      };
    }
    const email = readAgyOauthEmail(ctx.userHome);
    if (email) {
      return {
        accountSummary: email,
        canSignOut: true,
        methods: AGY_AUTH_METHODS,
      };
    }
    const hasOauthFile = existsSync(joinByStyle(ctx.userHome, ".gemini", "oauth_creds.json"));
    if (ctx.availability === "available" || hasOauthFile) {
      return {
        accountSummary: "Signed in",
        canSignOut: true,
        methods: AGY_AUTH_METHODS,
      };
    }
    return {
      accountSummary: null,
      canSignOut: false,
      methods: AGY_AUTH_METHODS,
    };
  },

  async startAuthFlow(ctx, input, hooks, signal) {
    if (input.methodId !== "browser") {
      throw new Error(`Unsupported Antigravity sign-in method: ${input.methodId}`);
    }
    const acpMethodId = input.variantId === "oauth-business" ? "oauth-business" : "oauth-personal";
    await runAgyAcpRpc({
      agyPath: ctx.executablePath(),
      cwd: ctx.userHome,
      baseEnv: ctx.env(),
      platform: ctx.platform,
      method: "authenticate",
      params: { methodId: acpMethodId },
      hooks,
      signal,
    });
    // 切回 Google / Enterprise 账号后清除受管 GEMINI_API_KEY 与 modelProvider: "gemini"
    ctx.secrets.remove("agy", ["GEMINI_API_KEY"]);
    patchAgySettingsModelProvider(ctx.userHome, "clear", ctx.platform);
  },

  async saveApiKey(ctx, { apiKey }) {
    ctx.secrets.set("agy", { GEMINI_API_KEY: apiKey.trim() });
    patchAgySettingsModelProvider(ctx.userHome, "gemini", ctx.platform);
  },

  async signOut(ctx) {
    ctx.secrets.remove("agy");
    patchAgySettingsModelProvider(ctx.userHome, "clear", ctx.platform);
    const oauthFile = joinByStyle(ctx.userHome, ".gemini", "oauth_creds.json");
    if (existsSync(oauthFile)) {
      try {
        rmSync(oauthFile, { force: true });
      } catch {
        // ignore
      }
    }
    if (!ctx.installed()) return;
    await runAgyAcpRpc({
      agyPath: ctx.executablePath(),
      cwd: ctx.userHome,
      baseEnv: ctx.env(),
      platform: ctx.platform,
      method: "logout",
      params: {},
      signal: AbortSignal.timeout(PROVIDER_LOGOUT_TIMEOUT_MS),
    }).catch(() => undefined);
  },
};
