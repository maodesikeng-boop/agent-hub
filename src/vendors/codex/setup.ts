// OpenAI Codex 一键安装、更新与界面内直接登录适配器（docs/providers-install-login-design.md 第 2.1、2.2.5 节）：
// - macOS / Linux 官方脚本传 `CODEX_NON_INTERACTIVE=1`；Windows 走随包 Node 24 受管 npm 安装 `@openai/codex`；
// - 登录统一通过原生 `codex app-server --listen stdio://` JSON-RPC `account/login/start`（Browser OAuth / Device Code / API Key）
//   并监听 `account/login/completed`，取消时发 `account/login/cancel` 并整树回收。
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { posix, win32 } from "node:path";
import { killThenSettle } from "../../daemon/driver/model-catalog.ts";
import { termGroupAfterExit } from "../../daemon/driver/process.ts";
import { buildChildEnv } from "../../daemon/driver/protocol.ts";
import { spawnOwnedProcess } from "../../daemon/platform/index.ts";
import { trackChild } from "../../daemon/process-ledger.ts";
import {
  PROVIDER_LOGOUT_TIMEOUT_MS,
  type ProviderAuthMethodDescriptor,
} from "../../shared/index.ts";
import { vendorConfigHome } from "../../shared/paths.ts";
import type { VendorSetupAdapter, VendorSetupContext } from "../daemon-types.ts";
import { createBrowserCaptureSession } from "../_common/setup/browser-capture.ts";
import { readBoundedJsonObject, runShortSubcommand } from "../_common/setup/file-helpers.ts";

const CODEX_POSIX_INSTALL_URL = "https://chatgpt.com/codex/install.sh";
const CODEX_NPM_PACKAGE = "@openai/codex";

const CODEX_AUTH_METHODS: readonly ProviderAuthMethodDescriptor[] = [
  {
    id: "browser",
    kind: "browser_oauth",
    label: "Browser",
    manualInput: "callback_url",
    preferDeviceCodeWhenRemote: true,
  },
  {
    id: "device_code",
    kind: "device_code",
    label: "Device code",
  },
  {
    id: "api_key",
    kind: "api_key",
    label: "API key",
    placeholder: "sk-...",
  },
];

function joinByStyle(base: string, ...parts: string[]): string {
  return /^[A-Za-z]:/.test(base) || base.startsWith("\\\\") || base.includes("\\")
    ? win32.join(base, ...parts)
    : posix.join(base, ...parts);
}

function decodeJwtEmail(jwt: unknown): string | null {
  if (typeof jwt !== "string") return null;
  const parts = jwt.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(json) as Record<string, unknown>;
    if (typeof payload.email === "string" && payload.email.trim() !== "") {
      return payload.email.trim();
    }
    const profile = payload["https://api.openai.com/profile"];
    if (typeof profile === "object" && profile !== null && !Array.isArray(profile)) {
      const email = (profile as Record<string, unknown>).email;
      if (typeof email === "string" && email.trim() !== "") return email.trim();
    }
  } catch {
    // ignore malformed JWT payload
  }
  return null;
}

function inspectCodexAuthFile(ctx: VendorSetupContext): { summary: string | null; hasFileCreds: boolean } {
  const codexHome = vendorConfigHome("codex", ctx.userHome, ctx.env());
  if (!codexHome) return { summary: null, hasFileCreds: false };
  const authPath = joinByStyle(codexHome, "auth.json");
  if (!existsSync(authPath)) return { summary: null, hasFileCreds: false };
  const obj = readBoundedJsonObject(authPath);
  if (!obj) return { summary: "Signed in", hasFileCreds: true };

  if (typeof obj.OPENAI_API_KEY === "string" && obj.OPENAI_API_KEY.trim() !== "") {
    return { summary: "API key configured", hasFileCreds: true };
  }
  if (obj.auth_mode === "apikey") {
    return { summary: "API key configured", hasFileCreds: true };
  }
  const tokens = obj.tokens;
  if (typeof tokens === "object" && tokens !== null && !Array.isArray(tokens)) {
    const tokenMap = tokens as Record<string, unknown>;
    const email = decodeJwtEmail(tokenMap.id_token) ?? decodeJwtEmail(tokenMap.access_token);
    if (email) return { summary: email, hasFileCreds: true };
    if (Object.keys(tokenMap).length > 0) return { summary: "Signed in", hasFileCreds: true };
  }
  return { summary: "Signed in", hasFileCreds: true };
}

async function runCodexAppServerLogin(options: {
  codexPath: string;
  cwd: string;
  baseEnv: Record<string, string | undefined>;
  platform: string;
  loginParams: Record<string, unknown>;
  waitForCompletionNotification: boolean;
  onStarted?: (res: Record<string, unknown>) => void;
  signal: AbortSignal;
}): Promise<void> {
  const {
    codexPath,
    cwd,
    baseEnv,
    platform,
    loginParams,
    waitForCompletionNotification,
    onStarted,
    signal,
  } = options;

  if (signal.aborted) throw new Error("cancelled");

  const capture = createBrowserCaptureSession({
    platform,
    onUrl: () => {},
  });

  try {
    const cleanBase = buildChildEnv(baseEnv, { NO_OPEN_BROWSER: "1" });
    const childEnv = capture.applyEnv(cleanBase);

    await new Promise<void>((resolve, reject) => {
      let spawned: { child: ChildProcessWithoutNullStreams; detached: boolean };
      try {
        spawned = spawnOwnedProcess(codexPath, ["app-server", "--listen", "stdio://"], {
          cwd,
          env: childEnv,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      const { child, detached } = spawned;
      trackChild(child, "provider:codex-login", { detached });
      child.once("exit", () => termGroupAfterExit(child));
      child.stdin.on("error", () => {});

      let activeLoginId: string | null = null;
      let stderrTail = "";
      let settled = false;

      const finish = (err: Error | null) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        rl.close();
        if (child.exitCode === null && child.signalCode === null) {
          if (err && activeLoginId && !child.stdin.destroyed) {
            try {
              child.stdin.write(
                `${JSON.stringify({
                  jsonrpc: "2.0",
                  id: 99,
                  method: "account/login/cancel",
                  params: { loginId: activeLoginId },
                })}\n`,
              );
            } catch {
              // ignore write error during abort
            }
          }
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
        stderrTail = (stderrTail + chunk).slice(-4096);
      });

      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          return;
        }

        if (msg.id === 1 && msg.error !== undefined) {
          const errObj = msg.error as { message?: unknown };
          finish(new Error(typeof errObj.message === "string" ? errObj.message : "Codex app-server initialize failed"));
          return;
        }

        if (msg.id === 2) {
          if (msg.error !== undefined) {
            const errObj = msg.error as { message?: unknown };
            finish(new Error(typeof errObj.message === "string" ? errObj.message : "Codex login start failed"));
            return;
          }
          const result = (typeof msg.result === "object" && msg.result !== null ? msg.result : {}) as Record<
            string,
            unknown
          >;
          if (typeof result.loginId === "string" && result.loginId.trim() !== "") {
            activeLoginId = result.loginId;
          }
          onStarted?.(result);
          if (!waitForCompletionNotification) {
            finish(null);
          }
          return;
        }

        if (msg.method === "account/login/completed") {
          const params = (typeof msg.params === "object" && msg.params !== null ? msg.params : {}) as Record<
            string,
            unknown
          >;
          if (activeLoginId && typeof params.loginId === "string" && params.loginId !== activeLoginId) {
            return;
          }
          if (params.success === true) {
            finish(null);
          } else {
            const reason =
              typeof params.error === "string" && params.error.trim() !== ""
                ? params.error.trim()
                : "Codex sign-in did not complete";
            finish(new Error(reason));
          }
        }
      });

      child.once("close", (code, sig) => {
        if (settled) return;
        finish(new Error(stderrTail.trim() || `Codex app-server exited unexpectedly (${sig ?? `code ${code}`})`));
      });

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "fusa", version: "0.1.0" } },
        })}\n`,
      );
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "account/login/start",
          params: loginParams,
        })}\n`,
      );
    });
  } finally {
    capture.dispose();
  }
}

export const codexSetupAdapter: VendorSetupAdapter = {
  installRecipe(platform) {
    if (platform === "win32") {
      return { kind: "npm", packageSpec: CODEX_NPM_PACKAGE };
    }
    return {
      kind: "posix_script",
      scriptUrl: CODEX_POSIX_INSTALL_URL,
      shell: "sh",
      env: { CODEX_NON_INTERACTIVE: "1" },
    };
  },

  updateRecipe() {
    return { kind: "reinstall" };
  },

  async inspectAuth(ctx) {
    if (ctx.secrets.has("codex", "OPENAI_API_KEY")) {
      return {
        accountSummary: "API key configured",
        canSignOut: true,
        methods: CODEX_AUTH_METHODS,
      };
    }
    const fileInfo = inspectCodexAuthFile(ctx);
    if (fileInfo.hasFileCreds) {
      return {
        accountSummary: fileInfo.summary ?? "Signed in",
        canSignOut: true,
        methods: CODEX_AUTH_METHODS,
      };
    }
    if (ctx.availability === "available") {
      return {
        accountSummary: "Signed in",
        canSignOut: true,
        methods: CODEX_AUTH_METHODS,
      };
    }
    return {
      accountSummary: null,
      canSignOut: false,
      methods: CODEX_AUTH_METHODS,
    };
  },

  async startAuthFlow(ctx, input, hooks, signal) {
    if (input.methodId === "device_code") {
      await runCodexAppServerLogin({
        codexPath: ctx.executablePath(),
        cwd: ctx.userHome,
        baseEnv: ctx.env(),
        platform: ctx.platform,
        loginParams: { type: "chatgptDeviceCode" },
        waitForCompletionNotification: true,
        onStarted: (res) => {
          if (typeof res.verificationUrl === "string" && typeof res.userCode === "string") {
            hooks.onDeviceCode({
              verificationUrl: res.verificationUrl,
              userCode: res.userCode,
            });
          }
        },
        signal,
      });
      ctx.secrets.remove("codex");
      return;
    }

    if (input.methodId === "browser") {
      await runCodexAppServerLogin({
        codexPath: ctx.executablePath(),
        cwd: ctx.userHome,
        baseEnv: ctx.env(),
        platform: ctx.platform,
        loginParams: { type: "chatgpt" },
        waitForCompletionNotification: true,
        onStarted: (res) => {
          if (typeof res.authUrl === "string" && res.authUrl.trim() !== "") {
            hooks.onAuthorizeUrl(res.authUrl);
          }
        },
        signal,
      });
      ctx.secrets.remove("codex");
      return;
    }

    throw new Error(`Unsupported Codex sign-in method: ${input.methodId}`);
  },

  async saveApiKey(ctx, { apiKey }) {
    const trimmed = apiKey.trim();
    if (!ctx.installed()) {
      ctx.secrets.set("codex", { OPENAI_API_KEY: trimmed });
      return;
    }
    try {
      await runCodexAppServerLogin({
        codexPath: ctx.executablePath(),
        cwd: ctx.userHome,
        baseEnv: ctx.env(),
        platform: ctx.platform,
        loginParams: { type: "apiKey", apiKey: trimmed },
        waitForCompletionNotification: false,
        signal: AbortSignal.timeout(PROVIDER_LOGOUT_TIMEOUT_MS),
      });
      ctx.secrets.remove("codex");
    } catch {
      // 兼容老版 CLI 回退 stdin 管道登录
      const res = await runShortSubcommand(ctx.executablePath(), ["login", "--with-api-key"], {
        cwd: ctx.userHome,
        env: ctx.env(),
        timeoutMs: PROVIDER_LOGOUT_TIMEOUT_MS,
        stdinText: `${trimmed}\n`,
        purpose: "provider:codex-api-key",
      });
      if (res.code !== 0) {
        ctx.secrets.set("codex", { OPENAI_API_KEY: trimmed });
      } else {
        ctx.secrets.remove("codex");
      }
    }
  },

  async signOut(ctx) {
    ctx.secrets.remove("codex");
    if (!ctx.installed()) return;
    await runShortSubcommand(ctx.executablePath(), ["logout"], {
      cwd: ctx.userHome,
      env: ctx.env(),
      timeoutMs: PROVIDER_LOGOUT_TIMEOUT_MS,
      purpose: "provider:logout:codex",
    }).catch(() => undefined);
  },
};
