import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { posix, win32 } from "node:path";
import { killChildAndWait, termGroupAfterExit } from "../../daemon/driver/process.ts";
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
// OpenAI OAuth rejects unrecognized originators, so login initialize must match codex login.
const CODEX_LOGIN_CLIENT_INFO = { name: "codex_cli_rs", version: "0.1.0" } as const;

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

interface CodexLoginOptions {
  codexPath: string;
  cwd: string;
  baseEnv: Record<string, string | undefined>;
  platform: string;
  loginParams: Record<string, unknown>;
  waitForCompletionNotification: boolean;
  onStarted?: (res: Record<string, unknown>) => void;
  signal: AbortSignal;
}

function rpcErrorMessage(error: unknown, fallback: string): string {
  const errObj = error as { message?: unknown };
  return typeof errObj.message === "string" ? errObj.message : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
}

function onCodexLoginMessage(
  msg: Record<string, unknown>,
  session: { activeLoginId: string | null },
  options: CodexLoginOptions,
  finish: (err: Error | null) => void,
): void {
  if (msg.id === 1 && msg.error !== undefined) {
    finish(new Error(rpcErrorMessage(msg.error, "Codex app-server initialize failed")));
    return;
  }

  if (msg.id === 2) {
    if (msg.error !== undefined) {
      finish(new Error(rpcErrorMessage(msg.error, "Codex login start failed")));
      return;
    }
    const result = asRecord(msg.result);
    if (typeof result.loginId === "string" && result.loginId.trim() !== "") {
      session.activeLoginId = result.loginId;
    }
    options.onStarted?.(result);
    if (!options.waitForCompletionNotification) {
      finish(null);
    }
    return;
  }

  if (msg.method === "account/login/completed") {
    const params = asRecord(msg.params);
    if (session.activeLoginId && typeof params.loginId === "string" && params.loginId !== session.activeLoginId) {
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
}

function writeCodexLoginRequests(child: ChildProcessWithoutNullStreams, loginParams: Record<string, unknown>): void {
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: CODEX_LOGIN_CLIENT_INFO },
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
}

function driveCodexLoginServer(options: CodexLoginOptions, childEnv: Record<string, string>): Promise<void> {
  const { codexPath, cwd, signal } = options;
  return new Promise<void>((resolve, reject) => {
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

    const session = { activeLoginId: null as string | null };
    let stderrTail = "";
    let settled = false;

    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      rl.close();
      if (child.exitCode === null && child.signalCode === null) {
        if (err && session.activeLoginId && !child.stdin.destroyed) {
          try {
            child.stdin.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: 99,
                method: "account/login/cancel",
                params: { loginId: session.activeLoginId },
              })}\n`,
            );
          } catch {
          }
        }
        void killChildAndWait(child).finally(() => (err ? reject(err) : resolve()));
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
      onCodexLoginMessage(msg, session, options, finish);
    });

    child.once("close", (code, sig) => {
      if (settled) return;
      finish(new Error(stderrTail.trim() || `Codex app-server exited unexpectedly (${sig ?? `code ${code}`})`));
    });

    writeCodexLoginRequests(child, options.loginParams);
  });
}

async function runCodexAppServerLogin(options: CodexLoginOptions): Promise<void> {
  if (options.signal.aborted) throw new Error("cancelled");

  const capture = createBrowserCaptureSession({
    platform: options.platform,
    onUrl: () => {},
  });

  try {
    const cleanBase = buildChildEnv(options.baseEnv, { NO_OPEN_BROWSER: "1" });
    await driveCodexLoginServer(options, capture.applyEnv(cleanBase));
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
      // Older CLIs log in through a stdin pipe.
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
