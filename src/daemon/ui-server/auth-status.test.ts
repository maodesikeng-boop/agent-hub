import { execFileSync, spawn } from "node:child_process";
import { readFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { arch, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  API_PATHS,
  DAEMON_LOG_MAX_BYTES,
  DEFAULT_UI_PORT,
  ENTRY_ONLY_API_PREFIXES,
  SHUTDOWN_TOTAL_MS,
  uiCookieName,
} from "../../shared/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { FakeLedger } from "./fake-ledger.ts";
import { createUiServer, DESKTOP_PRODUCT, DESKTOP_PROTOCOL_VERSION } from "./server.ts";
import { createBrowserSessions } from "./sessions.ts";
import { testLogin } from "./test-login.ts";
import { DESKTOP_CONTRACT, isSupervised } from "../entry.ts";

interface DesktopContract {
  product: string;
  protocolVersion: number;
  defaultPort: number;
  statusPath: string;
  healthPath: string;
  shutdownTransport: string;
  shutdownPath: string;
  daemonEntryRelativePath: string;
  probeTimeoutMs: number;
  pollIntervalMs: number;
  startupBudgetMs: number;
  stopGraceMs: number;
  crashBackoffMs: number[];
  crashWindowMs: number;
  maxCrashesInWindow: number;
  reloadExitCode: number;
  supervisedEnv: string;
  logRelativePath: string;
  logMaxBytes: number;
  logRotatedFiles: number;
  stderrTailMaxBytes: number;
  stderrSummaryMaxLines: number;
  menuReasonMaxChars: number;
  menuActions: string[];
}

const CONTRACT_URL = new URL("../../../apps/desktop/contract.json", import.meta.url);
const contract = JSON.parse(readFileSync(CONTRACT_URL, "utf8")) as DesktopContract;

const TOKEN = "secret-ui-token-0123456789abcdef";
const PORT = 4317;
const HOST = `127.0.0.1:${PORT}`;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("桌面壳共用监管契约与 /api/auth/status 轻量身份响应", () => {
  let root: string;
  let db = openTestDb();
  let app: FastifyInstance;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "hub-auth-status-")));
    app = createUiServer({
      ledger: new FakeLedger().asLedger(),
      token: TOKEN,
      staticDir: join(root, "no-static"),
      uploadsDir: join(root, "uploads"),
      sentFilesDir: join(root, "sent-files"),
      port: PORT,
      db,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("apps/desktop/contract.json 定义完整且与守护进程常量严格对齐", () => {
    expect(contract.product).toBe("fusa");
    expect(contract.product).toBe(DESKTOP_PRODUCT);
    expect(contract.protocolVersion).toBe(1);
    expect(contract.protocolVersion).toBe(DESKTOP_PROTOCOL_VERSION);
    expect(contract.defaultPort).toBe(DEFAULT_UI_PORT);
    expect(contract.statusPath).toBe(API_PATHS.authStatus);
    expect(contract.healthPath).toBe(API_PATHS.health);
    expect(contract.shutdownTransport).toBe("admin-endpoint");
    expect(contract.shutdownPath).toBe("/admin/shutdown");
    expect(contract.daemonEntryRelativePath).toBe("src/daemon/main.ts");
    expect(contract.probeTimeoutMs).toBe(500);
    expect(contract.pollIntervalMs).toBe(150);
    expect(contract.startupBudgetMs).toBe(15_000);
    expect(contract.stopGraceMs).toBe(40_000);
    expect(contract.stopGraceMs).toBeGreaterThan(SHUTDOWN_TOTAL_MS);
    expect(contract.crashBackoffMs).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    expect(contract.crashWindowMs).toBe(60_000);
    expect(contract.maxCrashesInWindow).toBe(5);
    // 热重启退出码：EX_TEMPFAIL，非 0（systemd Restart=on-failure 照样拉起），不与崩溃的 1 撞
    expect(contract.reloadExitCode).toBe(75);
    expect(contract.reloadExitCode).toBe(DESKTOP_CONTRACT.reloadExitCode);
    expect(contract.supervisedEnv).toBe("AGENT_HUB_SUPERVISED");
    expect(isSupervised({ AGENT_HUB_SUPERVISED: "fusa-macos" })).toBe(true);
    expect(isSupervised({ INVOCATION_ID: "abc" })).toBe(true);
    expect(isSupervised({})).toBe(false);
    // Windows 原生桌面端：fusa-supervisor 按 contract.supervised_env 注入同一个监管变量
    expect(
      readFileSync(new URL("../../../apps/windows/crates/fusa-supervisor/src/supervisor.rs", import.meta.url), "utf8"),
    ).toContain("supervised_env");
    expect(contract.logRelativePath).toBe("state/logs/desktop-daemon.log");
    expect(contract.logMaxBytes).toBe(2 * 1024 * 1024);
    expect(contract.logMaxBytes).toBe(DAEMON_LOG_MAX_BYTES);
    expect(contract.logRotatedFiles).toBe(1);
    expect(contract.stderrTailMaxBytes).toBe(4_096);
    expect(contract.stderrSummaryMaxLines).toBe(8);
    expect(contract.menuReasonMaxChars).toBe(60);
    expect(contract.menuActions.length).toBeGreaterThan(0);
  });

  it("未登录、待批准、已激活三种状态下 /api/auth/status 均保留 status 并返回与契约一致的 product / protocolVersion / 稳定 instanceId", async () => {
    const unauthRes = await app.inject({
      method: "GET",
      url: API_PATHS.authStatus,
      headers: { host: HOST },
    });
    expect(unauthRes.statusCode).toBe(200);
    const unauthBody = unauthRes.json() as Record<string, unknown>;
    expect(unauthBody).toEqual({
      status: "unauthenticated",
      product: contract.product,
      protocolVersion: contract.protocolVersion,
      instanceId: expect.stringMatching(UUID_V4_RE),
    });

    const instanceId = String(unauthBody.instanceId);
    expect(JSON.stringify(unauthBody)).not.toContain(TOKEN);
    expect(JSON.stringify(unauthBody)).not.toContain(root);

    // 同一进程实例多次请求返回稳定一致的 instanceId
    const secondRes = await app.inject({
      method: "GET",
      url: API_PATHS.authStatus,
      headers: { host: HOST },
    });
    expect(secondRes.json().instanceId).toBe(instanceId);

    // 未登录请求 GET /api/health 返回 401
    const unauthHealth = await app.inject({
      method: "GET",
      url: API_PATHS.health,
      headers: { host: HOST },
    });
    expect(unauthHealth.statusCode).toBe(401);

    // 已登录会话（active）
    const activeCookie = testLogin(db, PORT).cookie();
    const activeRes = await app.inject({
      method: "GET",
      url: API_PATHS.authStatus,
      headers: { host: HOST, cookie: activeCookie },
    });
    expect(activeRes.statusCode).toBe(200);
    expect(activeRes.json()).toEqual({
      status: "active",
      product: contract.product,
      protocolVersion: contract.protocolVersion,
      instanceId,
    });

    const activeHealth = await app.inject({
      method: "GET",
      url: API_PATHS.health,
      headers: { host: HOST, cookie: activeCookie },
    });
    expect(activeHealth.statusCode).toBe(200);
    expect(activeHealth.json()).toEqual({
      ok: true,
      product: contract.product,
      protocolVersion: contract.protocolVersion,
      instanceId,
    });

    // 待批准会话（pending_approval）
    const pendingSession = createBrowserSessions(db).create(
      { userAgent: "TestPhone", entry: "example.ts.net" },
      { viaPublic: true, clientIp: "198.51.100.1" },
    );
    const pendingCookie = `${uiCookieName(HOST)}=${pendingSession.token}`;
    const pendingRes = await app.inject({
      method: "GET",
      url: API_PATHS.authStatus,
      headers: { host: HOST, cookie: pendingCookie },
    });
    expect(pendingRes.statusCode).toBe(200);
    expect(pendingRes.json()).toEqual({
      status: "pending_approval",
      product: contract.product,
      protocolVersion: contract.protocolVersion,
      instanceId,
    });
  });

  it("重启后的新服务实例生成不同的 instanceId，且无 Cookie 探活零数据库查询、响应增量几十字节", async () => {
    const db2 = openTestDb();
    const app2 = createUiServer({
      ledger: new FakeLedger().asLedger(),
      token: TOKEN,
      staticDir: join(root, "no-static"),
      uploadsDir: join(root, "uploads"),
      sentFilesDir: join(root, "sent-files"),
      port: PORT,
      db: db2,
    });
    await app2.ready();

    try {
      const getSpy = vi.spyOn(db2, "get");
      const allSpy = vi.spyOn(db2, "all");
      const runSpy = vi.spyOn(db2, "run");
      const execSpy = vi.spyOn(db2, "exec");
      const res1 = await app.inject({ method: "GET", url: API_PATHS.authStatus, headers: { host: HOST } });
      const res2 = await app2.inject({ method: "GET", url: API_PATHS.authStatus, headers: { host: HOST } });

      expect(getSpy).not.toHaveBeenCalled();
      expect(allSpy).not.toHaveBeenCalled();
      expect(runSpy).not.toHaveBeenCalled();
      expect(execSpy).not.toHaveBeenCalled();

      expect(res2.statusCode).toBe(200);
      expect(res2.json().instanceId).toMatch(UUID_V4_RE);
      expect(res2.json().instanceId).not.toBe(res1.json().instanceId);

      const legacyBytes = Buffer.byteLength(JSON.stringify({ status: "unauthenticated" }), "utf8");
      const currentBytes = Buffer.byteLength(res2.body, "utf8");
      const deltaBytes = currentBytes - legacyBytes;
      expect(deltaBytes).toBeGreaterThan(40);
      expect(deltaBytes).toBeLessThan(100);
    } finally {
      await app2.close();
      db2.close();
    }
  });

  it("/api/state 带 bootId（= instanceId）；POST /api/self-reload 登记热重启，没有外壳监管时 409；别的设备的令牌碰不到", async () => {
    const requests: Array<{ build: boolean; by: string }> = [];
    const db3 = openTestDb();
    const app3 = createUiServer({
      ledger: new FakeLedger().asLedger(),
      token: TOKEN,
      staticDir: join(root, "no-static"),
      uploadsDir: join(root, "uploads"),
      sentFilesDir: join(root, "sent-files"),
      port: PORT,
      db: db3,
      selfReload: {
        request: (input) => {
          requests.push(input);
          return { text: "已登记空闲排空热重启", status: { state: "draining", build: input.build, requestedAt: 1, busy: [], lastFailure: null } };
        },
        status: () => ({ state: "draining", build: false, requestedAt: 1, busy: ["1 个会话还在跑"], lastFailure: null }),
      },
    });
    await app3.ready();
    try {
      const cookie = testLogin(db3, PORT).cookie();
      const origin = `http://${HOST}`;
      const instanceId = (await app3.inject({ method: "GET", url: API_PATHS.authStatus, headers: { host: HOST } })).json().instanceId;
      const state = await app3.inject({ method: "GET", url: API_PATHS.state, headers: { host: HOST, cookie } });
      expect(state.json().bootId).toBe(instanceId);

      const ok = await app3.inject({ method: "POST", url: API_PATHS.selfReload, headers: { host: HOST, cookie, origin }, payload: { build: true } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ text: "已登记空闲排空热重启", status: { state: "draining", build: true } });
      expect(requests).toEqual([{ build: true, by: "网页" }]);
      const status = await app3.inject({ method: "GET", url: API_PATHS.selfReload, headers: { host: HOST, cookie } });
      expect(status.json()).toMatchObject({ state: "draining", busy: ["1 个会话还在跑"] });
      const bad = await app3.inject({ method: "POST", url: API_PATHS.selfReload, headers: { host: HOST, cookie, origin }, payload: { force: 1 } });
      expect(bad.statusCode).toBe(400);
      const anonymous = await app3.inject({ method: "POST", url: API_PATHS.selfReload, headers: { host: HOST, origin }, payload: {} });
      expect(anonymous.statusCode).toBe(401);
      expect(requests).toHaveLength(1);
      expect(ENTRY_ONLY_API_PREFIXES.some((prefix) => API_PATHS.selfReload.startsWith(prefix))).toBe(true);

      const plainCookie = testLogin(db, PORT).cookie();
      const unsupported = await app.inject({ method: "POST", url: API_PATHS.selfReload, headers: { host: HOST, cookie: plainCookie, origin }, payload: {} });
      expect(unsupported.statusCode).toBe(409);
    } finally {
      await app3.close();
      db3.close();
    }
  });

  it.skipIf(process.platform !== "darwin")(
    "macOS Swift 监管逻辑契约测试：非 Fusa/协议不兼容冲突拦截且不发 token、外部 Fusa 复用不误杀、40s 预算下 5s 慢关闭优雅退出、崩溃退避与上限",
    async () => {
      const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
      const binPath = join(root, "supervisor-contract-tests");
      const targetArch = arch() === "arm64" ? "arm64" : "x86_64";

      execFileSync(
        "/usr/bin/swiftc",
        [
          "-warnings-as-errors",
          "-target",
          `${targetArch}-apple-macos13.0`,
          "-framework",
          "AppKit",
          "-framework",
          "WebKit",
          "-framework",
          "UserNotifications",
          join(repoRoot, "apps/macos/DaemonSupervisor.swift"),
          join(repoRoot, "apps/macos/StatusBarController.swift"),
          join(repoRoot, "apps/macos/MainWindowController.swift"),
          join(repoRoot, "apps/macos/AppDelegate.swift"),
          join(repoRoot, "apps/macos/Tests/SupervisorTests.swift"),
          "-o",
          binPath,
        ],
        { stdio: "pipe" },
      );

      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn(binPath, [repoRoot, process.execPath], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
        child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code === 0) resolve(out);
          else reject(new Error(`SupervisorTests exited ${code}: ${err}`));
        });
      });

      expect(stdout).toContain("ALL_SUPERVISOR_TESTS_PASSED");
    },
    45_000,
  );
});
