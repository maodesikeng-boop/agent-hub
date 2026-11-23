import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeExecutableNodeScript } from "../../../test/fake-cli-shim.ts";
import { removeTreeWithRetry } from "../../daemon/platform/index.ts";
import type { ManagedProviderSecrets, VendorSetupContext } from "../daemon-types.ts";
import {
  forwardValidatedLoopbackCallback,
  parseLoopbackCallbackContract,
  validateLoopbackCallbackUrl,
} from "../_common/setup/loopback-callback.ts";
import { codexSetupAdapter } from "./setup.ts";

function makeSecrets(): { secrets: ManagedProviderSecrets; store: Record<string, string> } {
  const store: Record<string, string> = {};
  const secrets: ManagedProviderSecrets = {
    keys: () => Object.keys(store),
    has: (_vendor, name) => name in store,
    getEnv: () => ({ ...store }),
    set: (_vendor, entries) => {
      Object.assign(store, entries);
    },
    remove: (_vendor, keys) => {
      if (!keys) {
        for (const k of Object.keys(store)) delete store[k];
        return;
      }
      for (const k of keys) delete store[k];
    },
    fingerprint: () => JSON.stringify(store),
  };
  return { secrets, store };
}

function makeJwtWithEmail(email: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ email })).toString("base64url");
  return `${header}.${payload}.sig`;
}

describe("codexSetupAdapter", () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "codex-setup-test-")));
  });

  afterEach(async () => {
    await removeTreeWithRetry(dir);
  });

  function makeCtx(overrides: Partial<VendorSetupContext> = {}): {
    ctx: VendorSetupContext;
    store: Record<string, string>;
  } {
    const { secrets, store } = makeSecrets();
    const ctx: VendorSetupContext = {
      platform: process.platform,
      userHome: dir,
      availability: "signed_out",
      executablePath: () => join(dir, "codex"),
      installed: () => true,
      env: () => ({ HOME: dir, PATH: process.env.PATH }),
      secrets,
      ...overrides,
    };
    return { ctx, store };
  }

  it("browser sign-in sends clientInfo.name=codex_cli_rs so authUrl carries originator=codex_cli_rs and completes via loopback callback", async () => {
    const rpcLogFile = join(dir, "rpc.jsonl");
    const envLogFile = join(dir, "env.json");
    const authJsonPath = join(dir, ".codex", "auth.json");
    const idToken = makeJwtWithEmail("alice@example.com");

    const fakeCodex = writeExecutableNodeScript(
      join(dir, "codex"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const readline = require("node:readline");

fs.writeFileSync(${JSON.stringify(envLogFile)}, JSON.stringify({ argv: process.argv.slice(2), noOpen: process.env.NO_OPEN_BROWSER }));
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");

let originator = "unknown";
let callbackServer = null;

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(rpcLogFile)}, JSON.stringify(msg) + "\\n");

  if (msg.method === "initialize") {
    originator = msg.params?.clientInfo?.name || "missing";
    out({ jsonrpc: "2.0", id: msg.id, result: { userAgent: originator + "/0.1.0" } });
    return;
  }

  if (msg.method === "account/login/start" && msg.params?.type === "chatgpt") {
    const loginId = "login-browser-1";
    const expectedState = "codex_state_123";
    callbackServer = http.createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname === "/auth/callback" && u.searchParams.get("state") === expectedState && u.searchParams.get("code") === "auth_code_ok") {
        fs.mkdirSync(path.dirname(${JSON.stringify(authJsonPath)}), { recursive: true });
        fs.writeFileSync(${JSON.stringify(authJsonPath)}, JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: ${JSON.stringify(idToken)} } }));
        res.writeHead(200);
        res.end("ok");
        out({ jsonrpc: "2.0", method: "account/login/completed", params: { loginId, success: true } });
        callbackServer.close();
        return;
      }
      res.writeHead(400);
      res.end("bad");
    });
    callbackServer.listen(0, "127.0.0.1", () => {
      const port = callbackServer.address().port;
      const redirectUri = encodeURIComponent("http://127.0.0.1:" + port + "/auth/callback");
      const authUrl = "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_test&redirect_uri=" + redirectUri + "&state=" + expectedState + "&codex_cli_simplified_flow=true&originator=" + encodeURIComponent(originator);
      out({ jsonrpc: "2.0", id: msg.id, result: { type: "chatgpt", loginId, authUrl } });
    });
  }
});
`,
    );

    const { ctx, store } = makeCtx({ executablePath: () => fakeCodex });
    ctx.secrets.set("codex", { OPENAI_API_KEY: "sk-stale" });

    let capturedUrl: string | null = null;
    const flowPromise = codexSetupAdapter.startAuthFlow!(
      ctx,
      { methodId: "browser" },
      {
        onAuthorizeUrl: (url) => {
          capturedUrl = url;
        },
        onDeviceCode: () => {},
        onUserInput: () => {},
      },
      AbortSignal.timeout(10_000),
    );

    await expect.poll(() => capturedUrl, { timeout: 5_000 }).not.toBeNull();
    const parsedUrl = new URL(capturedUrl!);
    expect(parsedUrl.searchParams.get("originator")).toBe("codex_cli_rs");
    expect(capturedUrl).not.toContain("originator=fusa");

    const contract = parseLoopbackCallbackContract(capturedUrl!);
    expect(contract).not.toBeNull();
    const callbackUrl = `http://127.0.0.1:${contract!.port}${contract!.pathname}?code=auth_code_ok&state=${encodeURIComponent(contract!.expectedState!)}`;
    const validated = validateLoopbackCallbackUrl(callbackUrl, contract);
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      await forwardValidatedLoopbackCallback(validated.url);
    }

    await flowPromise;
    expect(store).toEqual({});

    const envLog = JSON.parse(readFileSync(envLogFile, "utf8")) as { argv: string[]; noOpen: string };
    expect(envLog.argv).toEqual(["app-server", "--listen", "stdio://"]);
    expect(envLog.noOpen).toBe("1");

    const rpcLines = readFileSync(rpcLogFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { method: string; params?: { clientInfo?: { name?: string } } });
    expect(rpcLines[0]?.method).toBe("initialize");
    expect(rpcLines[0]?.params?.clientInfo?.name).toBe("codex_cli_rs");

    const inspected = await codexSetupAdapter.inspectAuth(ctx);
    expect(inspected.accountSummary).toBe("alice@example.com");
    expect(inspected.canSignOut).toBe(true);
  });

  it("device_code sign-in uses codex_cli_rs clientInfo and emits verificationUrl and userCode", async () => {
    const fakeCodex = writeExecutableNodeScript(
      join(dir, "codex"),
      `#!/usr/bin/env node
const readline = require("node:readline");
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    if (msg.params?.clientInfo?.name !== "codex_cli_rs") {
      out({ jsonrpc: "2.0", id: msg.id, error: { message: "unexpected originator" } });
      return;
    }
    out({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "account/login/start" && msg.params?.type === "chatgptDeviceCode") {
    out({
      jsonrpc: "2.0",
      id: msg.id,
      result: { type: "chatgptDeviceCode", loginId: "dev-1", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" },
    });
    setTimeout(() => out({ jsonrpc: "2.0", method: "account/login/completed", params: { loginId: "dev-1", success: true } }), 20);
  }
});
`,
    );

    const { ctx } = makeCtx({ executablePath: () => fakeCodex });
    let deviceCode: { verificationUrl: string; userCode: string } | null = null;
    await codexSetupAdapter.startAuthFlow!(
      ctx,
      { methodId: "device_code" },
      {
        onAuthorizeUrl: () => {},
        onDeviceCode: (info) => {
          deviceCode = info;
        },
        onUserInput: () => {},
      },
      AbortSignal.timeout(10_000),
    );
    expect(deviceCode).toEqual({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
    });
  });

  it("saveApiKey and signOut handle app-server, stdin fallback, and logout cleanup", async () => {
    const stdinLog = join(dir, "stdin.txt");
    const logoutLog = join(dir, "logout.txt");
    const fakeCodex = writeExecutableNodeScript(
      join(dir, "codex"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "login" && args[1] === "--with-api-key") {
  let body = "";
  process.stdin.on("data", (c) => (body += c));
  process.stdin.on("end", () => {
    fs.writeFileSync(${JSON.stringify(stdinLog)}, body);
    process.exit(0);
  });
} else if (args[0] === "logout") {
  fs.writeFileSync(${JSON.stringify(logoutLog)}, "logged-out");
  process.exit(0);
} else {
  // Force saveApiKey to fall back to login --with-api-key.
  process.stderr.write("unsupported");
  process.exit(1);
}
`,
    );

    const { ctx, store } = makeCtx({ executablePath: () => fakeCodex });
    ctx.secrets.set("codex", { OPENAI_API_KEY: "old" });
    await codexSetupAdapter.saveApiKey!(ctx, { apiKey: " sk-live-999 " });
    expect(readFileSync(stdinLog, "utf8")).toBe("sk-live-999\n");
    expect(store).toEqual({});

    await codexSetupAdapter.signOut(ctx);
    expect(existsSync(logoutLog)).toBe(true);
  });

  it("inspectAuth reads managed secret, auth.json JWT email, api_key mode, and returns null when clean", async () => {
    const { ctx } = makeCtx();
    expect(await codexSetupAdapter.inspectAuth(ctx)).toEqual({
      accountSummary: null,
      canSignOut: false,
      methods: expect.any(Array),
    });

    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(
      join(dir, ".codex", "auth.json"),
      JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: makeJwtWithEmail("bob@example.com") } }),
    );
    expect((await codexSetupAdapter.inspectAuth(ctx)).accountSummary).toBe("bob@example.com");

    writeFileSync(join(dir, ".codex", "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-1" }));
    expect((await codexSetupAdapter.inspectAuth(ctx)).accountSummary).toBe("API key configured");

    rmSync(join(dir, ".codex", "auth.json"));
    ctx.secrets.set("codex", { OPENAI_API_KEY: "sk-managed" });
    expect((await codexSetupAdapter.inspectAuth(ctx)).accountSummary).toBe("API key configured");
  });
});
