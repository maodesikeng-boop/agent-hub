import { createServer, type Server } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_VENDORS,
  API_PATHS,
  PEER_CLIENT_SCOPE_HEADER,
  PEER_DEVICE_HEADER,
  PROVIDER_JOB_LOG_MAX_BYTES,
  PROVIDER_JOB_LOG_MAX_LINES,
  uiCookieName,
  type ProvidersStatusResponse,
} from "../../shared/index.ts";
import { resolveHubPaths } from "../../shared/paths.ts";
import { VENDOR_DAEMONS } from "../../vendors/daemon-registry.ts";
import {
  forwardValidatedLoopbackCallback,
  parseLoopbackCallbackContract,
  validateLoopbackCallbackUrl,
} from "../../vendors/_common/setup/loopback-callback.ts";
import { patchAgySettingsModelProvider } from "../../vendors/agy/setup.ts";
import { createDeepSeekCatalogSource, hasDeepSeekLocalCredentials } from "../../vendors/deepseek/catalog.ts";
import {
  DEEPSEEK_PINNED_NPM_SPEC,
  parseDeepSeekCredentialsYaml,
  resolveDeepSeekCredentialsPath,
} from "../../vendors/deepseek/setup.ts";
import { readPiAuthMap, resolvePiAuthJsonPath } from "../../vendors/pi/setup.ts";
import { createModelCatalogs } from "../driver/model-catalog.ts";
import { createPeers, type PeerRecord } from "../peers/index.ts";
import { newPeerToken, sha256Hex } from "../peers/tokens.ts";
import * as win32Platform from "../platform/win32/process-tree.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { FakeLedger } from "../ui-server/fake-ledger.ts";
import { createUiServer } from "../ui-server/server.ts";
import { createBrowserSessions } from "../ui-server/sessions.ts";
import { testLogin } from "../ui-server/test-login.ts";
import { createVendorCatalogSources } from "../vendors/index.ts";
import {
  assertSafeHttpsScriptUrl,
  BoundedJobLogBuffer,
  buildWindowsPowerShellArgs,
  createManagedProviderSecrets,
  createProviderManager,
  createVendorRuntimeResolver,
  redactProviderLog,
  resolveNpmCliJsPath,
} from "./index.ts";

function makeTempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function writeExecutable(filePath: string, body: string): string {
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, body, { mode: 0o755 });
  chmodSync(filePath, 0o755);
  return filePath;
}

async function waitForCondition(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Condition did not settle within ${timeoutMs}ms`);
}

describe("provider-manager：6 家白名单安装与更新配方、PowerShell 安全参数与 npm-cli 定位", () => {
  it("核对 6 家厂商在 darwin / linux / win32 三平台的白名单安装与更新配方", () => {
    expect(VENDOR_DAEMONS.claude.setup!.installRecipe("darwin")).toEqual({
      kind: "posix_script",
      scriptUrl: "https://claude.ai/install.sh",
      shell: "bash",
    });
    expect(VENDOR_DAEMONS.claude.setup!.installRecipe("win32")).toEqual({
      kind: "powershell_script",
      scriptUrl: "https://claude.ai/install.ps1",
    });
    const claudeUpdate = VENDOR_DAEMONS.claude.setup!.updateRecipe("darwin");
    expect(claudeUpdate.kind).toBe("cli_subcommand");
    if (claudeUpdate.kind === "cli_subcommand") {
      expect(claudeUpdate.canUse?.("/Users/u/.local/bin/claude", "darwin")).toBe(true);
      expect(claudeUpdate.canUse?.("/opt/homebrew/bin/claude", "darwin")).toBe(false);
    }

    expect(VENDOR_DAEMONS.agy.setup!.installRecipe("linux")).toEqual({
      kind: "posix_script",
      scriptUrl: "https://antigravity.google/cli/install.sh",
      shell: "bash",
    });
    expect(VENDOR_DAEMONS.agy.setup!.installRecipe("win32")).toEqual({
      kind: "powershell_script",
      scriptUrl: "https://antigravity.google/cli/install.ps1",
    });

    expect(VENDOR_DAEMONS.codex.setup!.installRecipe("darwin")).toEqual({
      kind: "posix_script",
      scriptUrl: "https://chatgpt.com/codex/install.sh",
      shell: "sh",
      env: { CODEX_NON_INTERACTIVE: "1" },
    });
    expect(VENDOR_DAEMONS.codex.setup!.installRecipe("win32")).toEqual({
      kind: "npm",
      packageSpec: "@openai/codex",
    });

    const piWin = VENDOR_DAEMONS.pi.setup!.installRecipe("win32");
    expect(piWin).toEqual({
      kind: "powershell_script",
      scriptUrl: "https://pi.dev/install.ps1",
      fallback: {
        kind: "npm",
        packageSpec: "@earendil-works/pi-coding-agent",
        extraArgs: ["--ignore-scripts"],
      },
    });

    expect(VENDOR_DAEMONS.deepseek.setup!.installRecipe("darwin")).toEqual({
      kind: "npm",
      packageSpec: DEEPSEEK_PINNED_NPM_SPEC,
    });
    expect(VENDOR_DAEMONS.deepseek.setup!.installRecipe("win32")).toEqual({
      kind: "npm",
      packageSpec: DEEPSEEK_PINNED_NPM_SPEC,
    });

    expect(VENDOR_DAEMONS.cursor.setup!.installRecipe("win32")).toEqual({
      kind: "powershell_script",
      scriptUrl: "https://cursor.com/install?win32=true",
    });
  });

  it("拒绝非 HTTPS 或含引号注入字符的脚本 URL，且能定位宿主 Node 24 的 npm-cli.js", () => {
    expect(() => assertSafeHttpsScriptUrl("http://claude.ai/install.sh")).toThrow();
    expect(() => assertSafeHttpsScriptUrl("https://evil.example/install.ps1';calc.exe;'")).toThrow();
    expect(() => assertSafeHttpsScriptUrl("https://user:pass@claude.ai/install.sh")).toThrow();

    const psArgs = buildWindowsPowerShellArgs("https://cursor.com/install?win32=true");
    expect(psArgs.slice(0, 5)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
    ]);
    expect(psArgs[5]).toContain("Invoke-RestMethod -UseBasicParsing -Uri 'https://cursor.com/install?win32=true'");

    const npmCli = resolveNpmCliJsPath();
    expect(npmCli).not.toBeNull();
    expect(existsSync(npmCli!)).toBe(true);
  });
});

describe("provider-manager：脱敏与有界环形日志缓冲（16 KiB / 80 行 / \\r 进度条）", () => {
  it("彻底擦除 API Key、Bearer Token、OAuth code / state / access_token 与环境变量键值", () => {
    const raw = [
      "\x1b[32mAuth callback: http://127.0.0.1:54321/callback?code=sec_code_999&state=st_abc123&access_token=tok_xyz\x1b[0m",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "Using key sk-proj-AbCdEfGhIjKlMnOp123456 and AIzaSyD-1234567890abcdefGHIJKLMN and key_live_9876543210",
      "ANTHROPIC_API_KEY=sk-ant-api03-secretvalue",
    ].join("\n");

    const clean = redactProviderLog(raw);
    expect(clean).not.toContain("sec_code_999");
    expect(clean).not.toContain("st_abc123");
    expect(clean).not.toContain("tok_xyz");
    expect(clean).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(clean).not.toContain("sk-proj-AbCdEfGhIjKlMnOp123456");
    expect(clean).not.toContain("AIzaSyD-1234567890abcdefGHIJKLMN");
    expect(clean).not.toContain("key_live_9876543210");
    expect(clean).not.toContain("sk-ant-api03-secretvalue");
    expect(clean).toContain("code=[REDACTED]");
    expect(clean).toContain("state=[REDACTED]");
    expect(clean).toContain("Bearer [REDACTED]");
  });

  it("BoundedJobLogBuffer 处理 \\r 进度条刷新，严格限制 <= 80 行且 <= 16 KiB", () => {
    const buf = new BoundedJobLogBuffer({ initialProgress: "Starting…" });
    for (let pct = 1; pct <= 100; pct += 10) {
      buf.append(`Downloading archive (${pct}%)...\r`);
    }
    expect(buf.progressLine).toBe("Downloading archive (91%)...");
    expect(buf.toString()).toBe("");

    for (let i = 0; i < 200; i += 1) {
      buf.append(`Step ${i}: installing module with secret sk-testSecretKeyValue1234567890 ${"x".repeat(160)}\n`);
    }
    const tail = buf.toString();
    const lines = tail.split("\n");
    expect(lines.length).toBeLessThanOrEqual(PROVIDER_JOB_LOG_MAX_LINES);
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(PROVIDER_JOB_LOG_MAX_BYTES);
    expect(tail).not.toContain("sk-testSecretKeyValue1234567890");
    expect(tail).toContain("Step 199:");
  });
});

describe("provider-manager：受管密钥库、各家凭据落盘与回环回调 6 重防 SSRF 校验", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("provider-secrets.json 强制 0600 原子写入、无明文指纹，并感知外部变更与 64 KiB 体积守卫", () => {
    const dir = makeTempDir("fusa-secrets-test-");
    tempDirs.push(dir);
    const secretsFile = join(dir, "state", "provider-secrets.json");
    const store = createManagedProviderSecrets(secretsFile);

    expect(store.fingerprint("claude")).toBe("0");
    store.set("claude", { ANTHROPIC_API_KEY: "sk-ant-real-secret-key" });
    expect(store.has("claude", "ANTHROPIC_API_KEY")).toBe(true);
    expect(store.getEnv("claude")).toEqual({ ANTHROPIC_API_KEY: "sk-ant-real-secret-key" });

    if (process.platform !== "win32") {
      const mode = statSync(secretsFile).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    const fp1 = store.fingerprint("claude");
    expect(fp1).not.toBe("0");
    expect(fp1).not.toContain("sk-ant");

    // 外部文件被删除时立即感知失效
    rmSync(secretsFile);
    expect(store.has("claude", "ANTHROPIC_API_KEY")).toBe(false);
    expect(store.fingerprint("claude")).toBe("0");

    // 超出 64 KiB 上限时安全拒绝读取，不崩
    writeFileSync(secretsFile, "x".repeat(70 * 1024), { mode: 0o600 });
    expect(store.keys("claude")).toEqual([]);
  });

  it("Antigravity settings.json 双开关联动、DeepSeek .credentials.yaml 0600+v1+PKCE、Pi 多子模型商合并", async () => {
    const home = makeTempDir("fusa-vendor-creds-");
    tempDirs.push(home);
    const secrets = createManagedProviderSecrets(join(home, ".agent-hub", "state", "provider-secrets.json"));

    const makeCtx = (vendor: (typeof AGENT_VENDORS)[number]) => ({
      platform: process.platform,
      userHome: home,
      availability: "signed_out" as const,
      executablePath: () => `/nonexistent/${vendor}`,
      installed: () => false,
      env: () => ({ HOME: home }),
      secrets,
    });

    // 1. Antigravity: 保留已有 JSONC 注释与无关字段，联动增删 modelProvider: "gemini"
    const agySettingsDir = join(home, ".gemini", "antigravity-cli");
    mkdirSync(agySettingsDir, { recursive: true });
    const agySettingsFile = join(agySettingsDir, "settings.json");
    writeFileSync(agySettingsFile, '// user comment\n{\n  "theme": "light"\n}\n', { mode: 0o600 });

    await VENDOR_DAEMONS.agy.setup!.saveApiKey!(makeCtx("agy"), { apiKey: "AIzaSyTestKey1234567890" });
    const patchedAgy = readFileSync(agySettingsFile, "utf8");
    expect(patchedAgy).toContain("// user comment");
    expect(patchedAgy).toContain('"theme": "light"');
    expect(patchedAgy).toContain('"modelProvider": "gemini"');
    expect(secrets.getEnv("agy")).toEqual({ GEMINI_API_KEY: "AIzaSyTestKey1234567890" });

    await VENDOR_DAEMONS.agy.setup!.signOut(makeCtx("agy"));
    const clearedAgy = readFileSync(agySettingsFile, "utf8");
    expect(clearedAgy).toContain('"theme": "light"');
    expect(clearedAgy).not.toContain('"modelProvider"');
    expect(secrets.keys("agy")).toEqual([]);
    patchAgySettingsModelProvider(home, "clear");

    // 2. DeepSeek: .credentials.yaml 必须为 0600 + version: 1 + refs.DEEPSEEK_API_KEY，且被零子进程 catalog 立即识别
    await VENDOR_DAEMONS.deepseek.setup!.saveApiKey!(makeCtx("deepseek"), { apiKey: "sk-ds-key-123456789" });
    const dshCredFile = resolveDeepSeekCredentialsPath(makeCtx("deepseek"));
    if (process.platform !== "win32") {
      expect(statSync(dshCredFile).mode & 0o077).toBe(0);
    }
    const rawYaml = readFileSync(dshCredFile, "utf8");
    expect(rawYaml.startsWith("version: 1\n")).toBe(true);
    const parsedYaml = parseDeepSeekCredentialsYaml(rawYaml);
    expect(parsedYaml.refs.DEEPSEEK_API_KEY).toBe("sk-ds-key-123456789");
    expect(hasDeepSeekLocalCredentials({ HOME: home })).toBe(true);

    // DeepSeek 原厂 PKCE OAuth 流 + 远端粘贴回环 URL 转发换票
    let fakePlatformServer: Server | null = null;
    try {
      let fakeOrigin = "";
      fakePlatformServer = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          res.setHeader("content-type", "application/json");
          if (req.url === "/auth-api/v0/dsh/auth_init") {
            const parsed = JSON.parse(body) as { redirect_uri: string; state: string };
            const authUrl = `${fakeOrigin}/dsh/authorize?redirect_uri=${encodeURIComponent(parsed.redirect_uri)}&state=${encodeURIComponent(parsed.state)}`;
            res.end(
              JSON.stringify({
                code: 0,
                data: {
                  biz_code: 0,
                  biz_data: { authorize_url: authUrl, authorize_id: "aid-1", expires_in: 300 },
                },
              }),
            );
            return;
          }
          if (req.url === "/auth-api/v0/dsh/auth_exchange") {
            res.end(
              JSON.stringify({
                code: 0,
                data: {
                  biz_code: 0,
                  biz_data: { token: "dsh_live_grant_token_abc", authorized_url: `${fakeOrigin}/dsh/authorized` },
                },
              }),
            );
            return;
          }
          res.statusCode = 404;
          res.end("{}");
        });
      });
      const platformPort = await new Promise<number>((resolve) => {
        fakePlatformServer!.listen(0, "127.0.0.1", () => {
          resolve((fakePlatformServer!.address() as { port: number }).port);
        });
      });
      fakeOrigin = `http://127.0.0.1:${platformPort}`;

      let capturedAuthorizeUrl: string | null = null;
      const dshFlowPromise = VENDOR_DAEMONS.deepseek.setup!.startAuthFlow!(
        {
          ...makeCtx("deepseek"),
          env: () => ({ HOME: home, DSH_PLATFORM_ORIGIN: fakeOrigin }),
        },
        { methodId: "browser" },
        {
          onAuthorizeUrl: (u) => {
            capturedAuthorizeUrl = u;
          },
          onDeviceCode: () => {},
          onUserInput: () => {},
        },
        AbortSignal.timeout(5_000),
      );
      await waitForCondition(() => capturedAuthorizeUrl !== null);
      const contract = parseLoopbackCallbackContract(capturedAuthorizeUrl!);
      expect(contract).not.toBeNull();
      const pastedUrl = `http://127.0.0.1:${contract!.port}${contract!.pathname}?code=pkce_code_777&state=${encodeURIComponent(contract!.expectedState!)}`;
      const validated = validateLoopbackCallbackUrl(pastedUrl, contract);
      expect(validated.ok).toBe(true);
      if (validated.ok) {
        await forwardValidatedLoopbackCallback(validated.url);
      }
      await dshFlowPromise;

      const afterGrant = parseDeepSeekCredentialsYaml(readFileSync(dshCredFile, "utf8"));
      expect(afterGrant.refs.DEEPSEEK_API_KEY).toBe("sk-ds-key-123456789");
      expect(afterGrant.records["deepseek-account-platform/default"]).toMatchObject({
        kind: "grant",
        payload: { version: 1, token: "dsh_live_grant_token_abc", issuer: fakeOrigin },
      });
    } finally {
      fakePlatformServer?.close();
    }

    await VENDOR_DAEMONS.deepseek.setup!.signOut(makeCtx("deepseek"));
    expect(hasDeepSeekLocalCredentials({ HOME: home })).toBe(false);

    // 3. Pi: 多子模型商合并写入 auth.json（0600），单个登出不影响另一家
    await VENDOR_DAEMONS.pi.setup!.saveApiKey!(makeCtx("pi"), { targetId: "deepseek", apiKey: "sk-pi-ds-1" });
    await VENDOR_DAEMONS.pi.setup!.saveApiKey!(makeCtx("pi"), { targetId: "openai", apiKey: "sk-pi-oa-2" });
    const piAuthFile = resolvePiAuthJsonPath(makeCtx("pi"));
    if (process.platform !== "win32") {
      expect(statSync(piAuthFile).mode & 0o777).toBe(0o600);
    }
    expect(Object.keys(readPiAuthMap(piAuthFile)).sort()).toEqual(["deepseek", "openai"]);

    const piInspected2 = await VENDOR_DAEMONS.pi.setup!.inspectAuth(makeCtx("pi"));
    expect(piInspected2.accountSummary).toBe("2 configured");
    expect(piInspected2.canSignOut).toBe(true);

    await VENDOR_DAEMONS.pi.setup!.signOut(makeCtx("pi"), { targetId: "deepseek" });
    expect(Object.keys(readPiAuthMap(piAuthFile))).toEqual(["openai"]);
    const piInspected1 = await VENDOR_DAEMONS.pi.setup!.inspectAuth(makeCtx("pi"));
    expect(piInspected1.accountSummary).toBe("1 configured");

    await VENDOR_DAEMONS.pi.setup!.signOut(makeCtx("pi"));
    expect(Object.keys(readPiAuthMap(piAuthFile))).toEqual([]);
  });

  it("回环回调 6 重防 SSRF 硬校验：逐一拦截无契约、账密/锚点、非回环主机、错端口、错路径、错 state，且零重定向跟随、丢弃响应体", async () => {
    const authUrl =
      "https://auth.openai.com/authorize?client_id=abc&redirect_uri=" +
      encodeURIComponent("http://127.0.0.1:41234/auth/callback") +
      "&state=expected_state_token_999";
    const contract = parseLoopbackCallbackContract(authUrl);
    expect(contract).toEqual({
      port: 41234,
      pathname: "/auth/callback",
      expectedState: "expected_state_token_999",
    });

    // ① 无契约
    expect(validateLoopbackCallbackUrl("http://127.0.0.1:41234/auth/callback?code=1&state=expected_state_token_999", null).ok).toBe(false);
    // ② 含账密或 fragment
    expect(validateLoopbackCallbackUrl("http://user:pw@127.0.0.1:41234/auth/callback?code=1&state=expected_state_token_999", contract).ok).toBe(false);
    expect(validateLoopbackCallbackUrl("http://127.0.0.1:41234/auth/callback?code=1&state=expected_state_token_999#frag", contract).ok).toBe(false);
    // ③ 非 http 或非回环主机（防外网与内网 SSRF）
    expect(validateLoopbackCallbackUrl("https://127.0.0.1:41234/auth/callback?code=1&state=expected_state_token_999", contract).ok).toBe(false);
    expect(validateLoopbackCallbackUrl("http://169.254.169.254:41234/auth/callback?code=1&state=expected_state_token_999", contract).ok).toBe(false);
    expect(validateLoopbackCallbackUrl("http://192.168.1.10:41234/auth/callback?code=1&state=expected_state_token_999", contract).ok).toBe(false);
    // ④ 篡改端口（试图扫本机别的端口）
    expect(validateLoopbackCallbackUrl("http://127.0.0.1:4317/auth/callback?code=1&state=expected_state_token_999", contract).ok).toBe(false);
    // ⑤ 篡改路径或缺失 code
    expect(validateLoopbackCallbackUrl("http://127.0.0.1:41234/admin/shutdown?code=1&state=expected_state_token_999", contract).ok).toBe(false);
    expect(validateLoopbackCallbackUrl("http://127.0.0.1:41234/auth/callback?state=expected_state_token_999", contract).ok).toBe(false);
    // ⑥ 篡改或缺失 state
    expect(validateLoopbackCallbackUrl("http://127.0.0.1:41234/auth/callback?code=1&state=wrong_state", contract).ok).toBe(false);
    expect(validateLoopbackCallbackUrl("http://127.0.0.1:41234/auth/callback?code=1", contract).ok).toBe(false);

    // 真实回环监听验证：返回 302 指向不可达外网时绝不跟随重定向，且正常视为送达成功
    let hitCount = 0;
    const srv = createServer((_req, res) => {
      hitCount += 1;
      res.writeHead(302, { location: "http://192.0.2.1:9999/never-follow" });
      res.end("SENSITIVE_LOCAL_BODY_NEVER_RETURNED");
    });
    const realPort = await new Promise<number>((resolve) => {
      srv.listen(0, "127.0.0.1", () => resolve((srv.address() as { port: number }).port));
    });
    try {
      const liveContract = { port: realPort, pathname: "/auth/callback", expectedState: "s123" };
      const okRes = validateLoopbackCallbackUrl(
        `http://localhost:${realPort}/auth/callback?code=ok_code&state=s123`,
        liveContract,
      );
      expect(okRes.ok).toBe(true);
      if (okRes.ok) {
        const ret = await forwardValidatedLoopbackCallback(okRes.url);
        expect(ret).toBeUndefined();
      }
      expect(hitCount).toBe(1);
    } finally {
      srv.close();
    }
  });
});

describe("provider-manager + ui-server：0 子进程读取、免重启安装/登录闭环、BROWSER 拦截、任务取消与跨窗口隔离", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("GET /api/providers 严格 0 子进程拉起，一键安装 + BROWSER 登录免重启立即刷新 VendorRuntimeResolver 与 ModelCatalogs，且隔离跨窗口会话与拦截 pending_approval", async () => {
    const root = makeTempDir("fusa-providers-e2e-");
    tempDirs.push(root);
    const userHome = join(root, "home");
    const hubHome = join(userHome, ".agent-hub");
    mkdirSync(userHome, { recursive: true });

    const baseEnv: Record<string, string | undefined> = {
      HOME: userHome,
      PATH: "/usr/bin:/bin",
    };
    const paths = resolveHubPaths(baseEnv, userHome);
    const secrets = createManagedProviderSecrets(paths.providerSecretsFile);
    const runtime = createVendorRuntimeResolver({
      paths,
      userHome,
      baseEnv,
      platform: "darwin",
      secrets,
    });

    const models = createModelCatalogs({
      sources: createVendorCatalogSources(
        Object.fromEntries(
          AGENT_VENDORS.map((vendor) => [
            vendor,
            {
              path: () => runtime.resolveExecutablePath(vendor),
              cwd: userHome,
              env: () => runtime.resolveVendorEnv(vendor),
              installed: () => runtime.installed(vendor),
              fingerprint: () => runtime.catalogFingerprint(vendor),
            },
          ]),
        ) as Parameters<typeof createVendorCatalogSources>[0],
      ),
    });

    let allowInstallFinish!: () => void;
    const installGate = new Promise<void>((resolve) => {
      allowInstallFinish = resolve;
    });

    const manager = createProviderManager({
      runtime,
      models,
      recipeRunner: {
        async install(_recipe, ctx) {
          ctx.logBuffer.append("Downloading package archive...\n");
          await Promise.race([
            installGate,
            new Promise<void>((_res, rej) => {
              ctx.signal.addEventListener("abort", () => rej(new Error("cancelled")), { once: true });
            }),
          ]);
          if (ctx.signal.aborted) throw new Error("cancelled");
          // 将真实可执行的假 claude 安装到 ~/.local/bin/claude（注意 baseEnv.PATH 只有 /usr/bin:/bin，专门验证 GUI 免重启兜底发现！）
          const binPath = join(userHome, ".local", "bin", "claude");
          const jsPath = join(userHome, ".local", "bin", "fake-claude.cjs");
          const authMarker = join(userHome, ".claude", ".credentials.json");
          const claudeJson = join(userHome, ".claude.json");
          const fakeClaudeJs = [
            'const { spawnSync } = require("node:child_process");',
            'const { existsSync, mkdirSync, writeFileSync } = require("node:fs");',
            'const { createInterface } = require("node:readline");',
            `const authMarker = ${JSON.stringify(authMarker)};`,
            `const claudeJson = ${JSON.stringify(claudeJson)};`,
            `const claudeDir = ${JSON.stringify(join(userHome, ".claude"))};`,
            "const args = process.argv.slice(2);",
            'if (args[0] === "--version") { console.log("2.1.323 (Claude Code)"); process.exit(0); }',
            'if (args[0] === "auth" && args[1] === "status") {',
            "  console.log(JSON.stringify({ loggedIn: existsSync(authMarker) }));",
            "  process.exit(0);",
            "}",
            'if (args[0] === "auth" && args[1] === "login") {',
            '  const url = "https://claude.ai/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A55667%2Fcallback&state=st_claude_1";',
            "  if (process.env.BROWSER) spawnSync(process.env.BROWSER, [url], { stdio: 'ignore' });",
            "  const rl = createInterface({ input: process.stdin });",
            '  rl.once("line", (line) => {',
            '    if (line.trim() === "valid-auth-code-42") {',
            "      mkdirSync(claudeDir, { recursive: true });",
            '      writeFileSync(authMarker, "{\\"ok\\":true}", { mode: 0o600 });',
            '      writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: "dev@fusa.app" } }), { mode: 0o600 });',
            "      process.exit(0);",
            "    }",
            '    console.error("Invalid code"); process.exit(1);',
            "  });",
            "} else {",
            "  const rl = createInterface({ input: process.stdin });",
            '  rl.once("line", (line) => {',
            "    const req = JSON.parse(line);",
            '    const account = existsSync(authMarker) ? { email: "dev@fusa.app" } : {};',
            "    console.log(JSON.stringify({",
            '      type: "control_response",',
            "      response: {",
            '        subtype: "success",',
            "        request_id: req.request_id,",
            '        response: { models: [{ value: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5" }], account },',
            "      },",
            "    }));",
            "    process.exit(0);",
            "  });",
            "}",
          ].join("\n");
          mkdirSync(join(userHome, ".local", "bin"), { recursive: true });
          writeFileSync(jsPath, fakeClaudeJs, { mode: 0o600 });
          writeExecutable(binPath, `#!/bin/sh\nexec "${process.execPath}" "${jsPath}" "$@"\n`);
        },
        async update() {},
        async installGit() {},
      },
    });

    const db = openTestDb();
    const port = 4391;
    const host = `127.0.0.1:${port}`;
    const app = createUiServer({
      ledger: new FakeLedger().asLedger(),
      token: "secret-ui-token-0123456789abcdef",
      db,
      port,
      uploadsDir: paths.uploadsDir,
      sentFilesDir: paths.sentFilesDir,
      staticDir: join(hubHome, "no-static"),
      models,
      providers: manager,
    });

    try {
      const clientA = testLogin(db, port);
      const clientB = testLogin(db, port);
      const pendingClient = createBrowserSessions(db).create({
        userAgent: "mobile-public",
        entry: "public.example.com",
        viaPublic: true,
      });
      const pendingCookie = `${uiCookieName(host)}=${pendingClient.token}`;

      // 1. 公网待批准会话访问 /api/providers 一律 403 拒绝
      const pendingRes = await app.inject({
        method: "GET",
        url: API_PATHS.providers,
        headers: { host, cookie: pendingCookie },
      });
      expect(pendingRes.statusCode).toBe(403);

      // 2. 默认 GET /api/providers 严格 0 子进程拉起，且延迟与体积轻量
      const spawnSpy = vi.spyOn(win32Platform, "spawnOwnedProcess");
      const t0 = performance.now();
      const initialRes = await app.inject({
        method: "GET",
        url: API_PATHS.providers,
        headers: { host, cookie: clientA.cookie() },
      });
      const elapsedMs = performance.now() - t0;
      expect(initialRes.statusCode).toBe(200);
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(Buffer.byteLength(initialRes.body, "utf8")).toBeLessThan(8 * 1024);
      expect(elapsedMs).toBeLessThan(100);
      spawnSpy.mockRestore();

      const initialBody = initialRes.json() as ProvidersStatusResponse;
      expect(initialBody.providers.map((p) => p.vendor)).toEqual([...AGENT_VENDORS]);
      const claudeBefore = initialBody.providers.find((p) => p.vendor === "claude")!;
      expect(claudeBefore.installed).toBe(false);
      expect(claudeBefore.availability).toBe("not_installed");
      expect(claudeBefore.canInstall).toBe(true);

      // 3. 发起一键安装：异步秒回 running，重复点击幂等返回同一 jobId，安装期间禁止发起登录（409）
      const startInstallRes = await app.inject({
        method: "POST",
        url: API_PATHS.providerInstall("claude"),
        headers: { host, origin: `http://${host}`, cookie: clientA.cookie() },
        payload: {},
      });
      expect(startInstallRes.statusCode).toBe(200);
      const installingItem = startInstallRes.json();
      expect(installingItem.job.phase).toBe("running");

      const dupInstallRes = await app.inject({
        method: "POST",
        url: API_PATHS.providerInstall("claude"),
        headers: { host, origin: `http://${host}`, cookie: clientA.cookie() },
        payload: {},
      });
      expect(dupInstallRes.json().job.jobId).toBe(installingItem.job.jobId);

      const conflictAuthRes = await app.inject({
        method: "POST",
        url: API_PATHS.providerAuthStart("claude"),
        headers: { host, origin: `http://${host}`, cookie: clientA.cookie() },
        payload: { methodId: "browser" },
      });
      expect(conflictAuthRes.statusCode).toBe(409);

      // 放行安装完成：无需重启守护进程，~/.local/bin/claude 自动被发现、版本号与 ModelCatalog 自动刷新为 signed_out
      allowInstallFinish();
      await waitForCondition(async () => {
        const r = await app.inject({
          method: "GET",
          url: API_PATHS.providers,
          headers: { host, cookie: clientA.cookie() },
        });
        const item = (r.json() as ProvidersStatusResponse).providers.find((p) => p.vendor === "claude")!;
        return item.job?.phase === "succeeded";
      });

      const afterInstallRes = await app.inject({
        method: "GET",
        url: API_PATHS.providers,
        headers: { host, cookie: clientA.cookie() },
      });
      const claudeInstalled = (afterInstallRes.json() as ProvidersStatusResponse).providers.find(
        (p) => p.vendor === "claude",
      )!;
      expect(claudeInstalled.installed).toBe(true);
      expect(claudeInstalled.version).toBe("2.1.323");
      expect(claudeInstalled.availability).toBe("signed_out");
      expect(runtime.resolveExecutablePath("claude")).toBe(join(userHome, ".local", "bin", "claude"));

      // 4. 客户端 A 发起 Browser OAuth 登录：BROWSER 拦截器秒捕 URL，客户端 B 被严格隔离脱敏
      const authStartRes = await app.inject({
        method: "POST",
        url: API_PATHS.providerAuthStart("claude"),
        headers: { host, origin: `http://${host}`, cookie: clientA.cookie() },
        payload: { methodId: "browser", variantId: "claudeai" },
      });
      expect(authStartRes.statusCode).toBe(200);
      let authStartedA = authStartRes.json();
      expect(["starting", "waiting_browser"]).toContain(authStartedA.authFlow.phase);
      if (authStartedA.authFlow.phase === "starting") {
        await waitForCondition(async () => {
          const r = await app.inject({
            method: "GET",
            url: API_PATHS.providers,
            headers: { host, cookie: clientA.cookie() },
          });
          authStartedA = (r.json() as ProvidersStatusResponse).providers.find((p) => p.vendor === "claude")!;
          return authStartedA.authFlow?.phase === "waiting_browser";
        });
      }
      expect(authStartedA.authFlow.phase).toBe("waiting_browser");
      expect(authStartedA.authFlow.authorizeUrl).toContain("https://claude.ai/oauth/authorize");
      expect(authStartedA.authFlow.ownedByOtherClient).toBe(false);

      const viewFromB = await app.inject({
        method: "GET",
        url: API_PATHS.providers,
        headers: { host, cookie: clientB.cookie() },
      });
      const claudeForB = (viewFromB.json() as ProvidersStatusResponse).providers.find(
        (p) => p.vendor === "claude",
      )!;
      expect(claudeForB.authFlow?.ownedByOtherClient).toBe(true);
      expect(claudeForB.authFlow?.authorizeUrl).toBeNull();

      // 客户端 B 试图提交授权码或取消均被 403 拦截
      const hijackRes = await app.inject({
        method: "POST",
        url: API_PATHS.providerAuthSubmit("claude"),
        headers: { host, origin: `http://${host}`, cookie: clientB.cookie() },
        payload: { flowId: authStartedA.authFlow.flowId, input: "valid-auth-code-42" },
      });
      expect(hijackRes.statusCode).toBe(403);

      // 客户端 A 提交正确授权码：子进程落盘退出，ModelCatalogs 免重启当场变为 available，显示账号邮箱
      const submitRes = await app.inject({
        method: "POST",
        url: API_PATHS.providerAuthSubmit("claude"),
        headers: { host, origin: `http://${host}`, cookie: clientA.cookie() },
        payload: { flowId: authStartedA.authFlow.flowId, input: "valid-auth-code-42" },
      });
      expect(submitRes.statusCode).toBe(200);
      await waitForCondition(async () => {
        const r = await app.inject({
          method: "GET",
          url: API_PATHS.providers,
          headers: { host, cookie: clientA.cookie() },
        });
        const item = (r.json() as ProvidersStatusResponse).providers.find((p) => p.vendor === "claude")!;
        return item.authFlow?.phase === "succeeded";
      });

      const finalRes = await app.inject({
        method: "GET",
        url: API_PATHS.providers,
        headers: { host, cookie: clientA.cookie() },
      });
      const claudeReady = (finalRes.json() as ProvidersStatusResponse).providers.find(
        (p) => p.vendor === "claude",
      )!;
      expect(claudeReady.availability).toBe("available");
      expect(claudeReady.accountSummary).toBe("dev@fusa.app");
      expect(claudeReady.canSignOut).toBe(true);
      expect((await models.list({ vendor: "claude" }))[0]?.availability).toBe("available");
    } finally {
      allowInstallFinish();
      await manager.close();
      await models.close();
      await app.close();
      db.close();
    }
  });

  it("支持取消正在运行的真实安装子进程组，且 Windows Git 安装能重读注册表 Path 即时生效", async () => {
    const root = makeTempDir("fusa-cancel-win-");
    tempDirs.push(root);
    const winHome = "C:\\Users\\alice";
    let regPaths: string[] = [];

    const paths = resolveHubPaths({}, winHome, { platform: "win32" });
    const secrets = createManagedProviderSecrets(join(root, "provider-secrets.json"), { platform: "win32" });
    const baseEnv: Record<string, string | undefined> = {
      Path: "C:\\Windows\\System32",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    };
    const runtime = createVendorRuntimeResolver({
      paths,
      userHome: winHome,
      baseEnv,
      platform: "win32",
      secrets,
      readWinRegistryPaths: () => regPaths,
    });
    const models = createModelCatalogs({ sources: {} });

    let installAborted = false;
    const fakeGitDir = join(root, "win-git-cmd");
    const manager = createProviderManager({
      runtime,
      models,
      recipeRunner: {
        async install(_recipe, ctx) {
          await new Promise<void>((_resolve, reject) => {
            ctx.signal.addEventListener(
              "abort",
              () => {
                installAborted = true;
                reject(new Error("cancelled"));
              },
              { once: true },
            );
          });
        },
        async update() {},
        async installGit() {
          mkdirSync(fakeGitDir, { recursive: true });
          writeFileSync(join(fakeGitDir, "git.exe"), "MZ");
          regPaths = [fakeGitDir];
        },
      },
    });

    try {
      const started = await manager.install("codex", "session:1");
      expect(started.job?.phase).toBe("running");
      const cancelled = await manager.cancelJob("codex", { jobId: started.job!.jobId }, "session:1");
      expect(cancelled.job?.phase).toBe("cancelled");
      expect(installAborted).toBe(true);

      expect(runtime.gitInstalled()).toBe(false);
      await manager.installGit("session:1");
      await waitForCondition(async () => {
        const st = await manager.getStatus({ ownerKey: "session:1" });
        return st.gitJob?.phase === "succeeded";
      });
      expect(runtime.gitInstalled()).toBe(true);
      expect(baseEnv.Path).toContain(fakeGitDir);
    } finally {
      await manager.close();
      await models.close();
    }
  });

  it("冷启动未探测模型目录时：无凭据已装厂商不伪装 available，已配凭据厂商报 available，且 submitAuth 报错后恢复 waiting_browser 支持重试", async () => {
    const root = makeTempDir("fusa-coldstart-retry-");
    tempDirs.push(root);
    const userHome = join(root, "home");
    const hubHome = join(userHome, ".agent-hub");
    mkdirSync(userHome, { recursive: true });

    // 预装 codex 与 deepseek 假可执行文件，但不触发 models.list()（模拟冷启动 models.availability === "unknown"）
    writeExecutable(join(userHome, ".local", "bin", "codex"), "#!/bin/sh\nexit 0\n");
    writeExecutable(join(hubHome, "tools", "npm", "bin", "dsh"), "#!/bin/sh\nexit 0\n");

    const paths = resolveHubPaths({}, userHome, { home: hubHome, platform: "darwin" });
    const secrets = createManagedProviderSecrets(paths.providerSecretsFile, { platform: "darwin" });
    const runtime = createVendorRuntimeResolver({
      paths,
      userHome,
      baseEnv: { PATH: "/usr/bin:/bin" },
      platform: "darwin",
      secrets,
    });
    const sources = createVendorCatalogSources(
      Object.fromEntries(
        AGENT_VENDORS.map((vendor) => [
          vendor,
          {
            path: () => runtime.resolveExecutablePath(vendor),
            cwd: userHome,
            env: () => runtime.resolveVendorEnv(vendor),
            installed: () => runtime.installed(vendor),
            fingerprint: () => runtime.catalogFingerprint(vendor),
          },
        ]),
      ) as Parameters<typeof createVendorCatalogSources>[0],
    );
    const models = createModelCatalogs({ sources });

    // 验证无 HOME 环境变量时 createDeepSeekCatalogSource 也能按 options.cwd (userHome) 识别凭据
    await VENDOR_DAEMONS.deepseek.setup!.saveApiKey!(
      {
        platform: "darwin",
        userHome,
        availability: "unknown",
        executablePath: () => runtime.resolveExecutablePath("deepseek"),
        installed: () => true,
        env: () => ({ PATH: "/usr/bin:/bin" }),
        secrets,
      },
      { apiKey: "sk-deepseek-coldstart-key-123456" },
    );
    const dsSource = createDeepSeekCatalogSource({
      path: () => runtime.resolveExecutablePath("deepseek"),
      cwd: userHome,
      env: () => ({ PATH: "/usr/bin:/bin" }),
      installed: () => true,
    });
    const dsRaw = await dsSource.query(new AbortController().signal);
    expect(dsSource.availabilityOf?.(dsRaw)).toBe("available");

    let forwardAttempt = 0;
    let resolveCallbackDone!: () => void;
    const callbackDone = new Promise<void>((r) => {
      resolveCallbackDone = r;
    });
    const manager = createProviderManager({
      runtime,
      models,
      adapters: {
        codex: {
          ...VENDOR_DAEMONS.codex.setup!,
          async startAuthFlow(_ctx, _input, hooks, signal) {
            hooks.onAuthorizeUrl(
              "https://auth.openai.com/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A45678%2Fauth%2Fcallback&state=st_retry_1",
            );
            await Promise.race([
              callbackDone,
              new Promise<void>((_res, rej) => {
                signal.addEventListener("abort", () => rej(new Error("cancelled")), { once: true });
              }),
            ]);
          },
        },
      },
      forwardLoopback: async () => {
        forwardAttempt += 1;
        if (forwardAttempt === 1) {
          throw new Error("Local sign-in listener rejected callback (HTTP 400)");
        }
        resolveCallbackDone();
      },
    });

    try {
      const coldStatus = await manager.getStatus({ ownerKey: "session:1" });
      const codexCold = coldStatus.providers.find((p) => p.vendor === "codex")!;
      const dsCold = coldStatus.providers.find((p) => p.vendor === "deepseek")!;
      expect(codexCold.installed).toBe(true);
      expect(codexCold.availability).toBe("unknown");
      expect(codexCold.accountSummary).toBeNull();
      expect(dsCold.installed).toBe(true);
      expect(dsCold.availability).toBe("available");
      expect(dsCold.accountSummary).toBe("API key configured");

      // 启动登录流并验证第一次转发报错后 phase 恢复 waiting_browser（不卡在 verifying），第二次重试成功
      const started = await manager.startAuth("codex", { methodId: "browser" }, "session:1");
      expect(started.authFlow?.phase).toBe("waiting_browser");
      const validCbUrl = "http://127.0.0.1:45678/auth/callback?code=ok_code&state=st_retry_1";

      await expect(
        manager.submitAuth("codex", { flowId: started.authFlow!.flowId, input: validCbUrl }, "session:1"),
      ).rejects.toThrow("HTTP 400");

      const afterFail = await manager.getStatus({ ownerKey: "session:1" });
      expect(afterFail.providers.find((p) => p.vendor === "codex")?.authFlow?.phase).toBe("waiting_browser");

      const retried = await manager.submitAuth(
        "codex",
        { flowId: started.authFlow!.flowId, input: validCbUrl },
        "session:1",
      );
      expect(["verifying", "succeeded"]).toContain(retried.authFlow?.phase);
      await waitForCondition(async () => {
        const st = await manager.getStatus({ ownerKey: "session:1" });
        return st.providers.find((p) => p.vendor === "codex")?.authFlow?.phase === "succeeded";
      });
    } finally {
      resolveCallbackDone();
      await manager.close();
      await models.close();
    }
  });

  it("跨设备 Peer 代理（/d/<device>/api/providers/*）按入口浏览器会话摘要隔离 ownerKey，禁止跨窗口偷看或劫持远端登录流", async () => {
    const root = makeTempDir("fusa-peer-scope-");
    tempDirs.push(root);
    const tokyoHome = join(root, "tokyo-home");
    mkdirSync(tokyoHome, { recursive: true });
    writeExecutable(join(tokyoHome, ".local", "bin", "cursor-agent"), "#!/bin/sh\nexit 0\n");

    const tokyoPaths = resolveHubPaths({}, tokyoHome, { platform: "linux" });
    const tokyoSecrets = createManagedProviderSecrets(tokyoPaths.providerSecretsFile, { platform: "linux" });
    const tokyoRuntime = createVendorRuntimeResolver({
      paths: tokyoPaths,
      userHome: tokyoHome,
      baseEnv: { PATH: "/usr/bin:/bin" },
      platform: "linux",
      secrets: tokyoSecrets,
    });
    const tokyoModels = createModelCatalogs({ sources: {} });
    let releaseAuth!: () => void;
    const authHold = new Promise<void>((r) => {
      releaseAuth = r;
    });
    const tokyoManager = createProviderManager({
      runtime: tokyoRuntime,
      models: tokyoModels,
      adapters: {
        cursor: {
          ...VENDOR_DAEMONS.cursor.setup!,
          async startAuthFlow(_ctx, _input, hooks, signal) {
            hooks.onAuthorizeUrl("https://cursor.com/cli-login?session=secret_tokyo_99");
            await Promise.race([
              authHold,
              new Promise<void>((_res, rej) => {
                signal.addEventListener("abort", () => rej(new Error("cancelled")), { once: true });
              }),
            ]);
          },
        },
      },
    });

    const entryId = "11111111-1111-4111-8111-111111111111";
    const tokyoId = "22222222-2222-4222-8222-222222222222";
    const sharedPeerToken = newPeerToken();

    // 上游东京服务器
    const tokyoDb = openTestDb();
    const entryRecordOnTokyo: PeerRecord = {
      id: entryId,
      name: "Mac",
      platform: "darwin",
      url: "http://127.0.0.1:9",
      state: "paired",
      since: Date.now(),
      inboundTokenSha256: sha256Hex(sharedPeerToken),
      outboundToken: newPeerToken(),
    };
    const tokyoPeersFile = join(root, "tokyo-peers.json");
    writeFileSync(tokyoPeersFile, JSON.stringify({ version: 1, devices: [entryRecordOnTokyo], removed: [] }));
    const tokyoPeersLoaded = createPeers({
      file: tokyoPeersFile,
      device: { id: tokyoId, name: "Tokyo" },
      platform: "linux",
      saveName: () => {},
      selfUrl: () => null,
      allowLoopback: true,
    });
    const tokyoApp = createUiServer({
      ledger: new FakeLedger().asLedger(),
      token: "tokyo-ui-token-0123456789abcdef",
      db: tokyoDb,
      port: 4392,
      uploadsDir: tokyoPaths.uploadsDir,
      sentFilesDir: tokyoPaths.sentFilesDir,
      staticDir: join(root, "no-static"),
      peers: tokyoPeersLoaded,
      providers: tokyoManager,
    });
    await tokyoApp.listen({ host: "127.0.0.1", port: 0 });
    const tokyoAddress = tokyoApp.server.address();
    const tokyoPort = typeof tokyoAddress === "object" && tokyoAddress ? tokyoAddress.port : 0;

    // 入口本机服务器（挂两个不同的已登录浏览器会话 browser1 / browser2，共享同一条配对隧道连向 Tokyo）
    const entryDb = openTestDb();
    const tokyoRecordOnEntry: PeerRecord = {
      id: tokyoId,
      name: "Tokyo",
      platform: "linux",
      url: `http://127.0.0.1:${tokyoPort}`,
      state: "paired",
      since: Date.now(),
      inboundTokenSha256: sha256Hex(newPeerToken()),
      outboundToken: sharedPeerToken,
    };
    const entryPeersFile = join(root, "entry-peers.json");
    writeFileSync(entryPeersFile, JSON.stringify({ version: 1, devices: [tokyoRecordOnEntry], removed: [] }));
    const entryPeers = createPeers({
      file: entryPeersFile,
      device: { id: entryId, name: "Mac" },
      platform: "darwin",
      saveName: () => {},
      selfUrl: () => null,
      allowLoopback: true,
    });
    const entryPort = 4393;
    const entryHost = `127.0.0.1:${entryPort}`;
    const entryApp = createUiServer({
      ledger: new FakeLedger().asLedger(),
      token: "entry-ui-token-0123456789abcdef",
      db: entryDb,
      port: entryPort,
      uploadsDir: tokyoPaths.uploadsDir,
      sentFilesDir: tokyoPaths.sentFilesDir,
      staticDir: join(root, "no-static"),
      peers: entryPeers,
    });

    try {
      const browser1 = testLogin(entryDb, entryPort);
      const browser2 = testLogin(entryDb, entryPort);

      // browser1 经 /d/<tokyoId>/api/providers/cursor/auth/start 发起远端登录（伪造 x-agent-hub-client-scope 也会被代理覆盖）
      const startRes = await entryApp.inject({
        method: "POST",
        url: `/d/${tokyoId}${API_PATHS.providerAuthStart("cursor")}`,
        headers: {
          host: entryHost,
          origin: `http://${entryHost}`,
          cookie: browser1.cookie(),
          "content-type": "application/json",
          [PEER_CLIENT_SCOPE_HEADER]: "deadbeefdeadbeefdeadbeef",
        },
        payload: JSON.stringify({ methodId: "browser", remoteHint: true }),
      });
      expect(startRes.statusCode).toBe(200);
      const startedItem = startRes.json();
      expect(startedItem.authFlow.ownedByOtherClient).toBe(false);
      expect(startedItem.authFlow.authorizeUrl).toBe("https://cursor.com/cli-login?session=secret_tokyo_99");

      // browser2 经同一台入口访问 Tokyo：authorizeUrl 被脱敏为 null 且标记 ownedByOtherClient: true
      const viewByBrowser2 = await entryApp.inject({
        method: "GET",
        url: `/d/${tokyoId}${API_PATHS.providers}`,
        headers: { host: entryHost, cookie: browser2.cookie() },
      });
      expect(viewByBrowser2.statusCode).toBe(200);
      const cursorFor2 = (viewByBrowser2.json() as ProvidersStatusResponse).providers.find(
        (p) => p.vendor === "cursor",
      )!;
      expect(cursorFor2.authFlow?.ownedByOtherClient).toBe(true);
      expect(cursorFor2.authFlow?.authorizeUrl).toBeNull();

      // browser2 试图取消 browser1 的远端登录流被 403 拒绝
      const cancelBy2 = await entryApp.inject({
        method: "POST",
        url: `/d/${tokyoId}${API_PATHS.providerAuthCancel("cursor")}`,
        headers: {
          host: entryHost,
          origin: `http://${entryHost}`,
          cookie: browser2.cookie(),
          "content-type": "application/json",
        },
        payload: JSON.stringify({ flowId: startedItem.authFlow.flowId }),
      });
      expect(cancelBy2.statusCode).toBe(403);
    } finally {
      releaseAuth();
      await tokyoManager.close();
      await tokyoModels.close();
      await entryApp.close();
      await tokyoApp.close();
      entryDb.close();
      tokyoDb.close();
    }
  });
});
