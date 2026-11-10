// 块 G1：公网入口 public.sock 与 4 道登录安全防线后端测试（docs/mac-app-and-mobile-design.md 第 2.2、3.2、5 节）。
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  API_PATHS,
  MAX_BROWSER_SESSIONS,
  MAX_PUBLIC_AUTH_IP_BUCKETS,
  PEER_DEVICE_HEADER,
  PENDING_SESSION_TTL_MS,
  PUBLIC_AUTH_GLOBAL_MAX_FAILURES,
  PUBLIC_AUTH_GLOBAL_WINDOW_MS,
  PUBLIC_AUTH_IP_MAX_FAILURES,
  PUBLIC_AUTH_IP_WINDOW_MS,
  PUBLIC_AUTH_LOCKOUT_MS,
  PUBLIC_SESSION_MAX_AGE_MS,
  SESSION_TOUCH_INTERVAL_MS,
  TAILSCALE_USER_LOGIN_HEADER,
  UI_COOKIE_NAME,
  serverInfoFor,
  uiCookieName,
  type AuthStatusResponse,
  type BrowserSessionsResponse,
  type LoginLinkResponse,
  type PublicEntryStatus,
  type StateSnapshot,
} from "../../shared/index.ts";
import { migrate, openDatabase, userVersion, type Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { FakeLedger } from "./fake-ledger.ts";
import { createPublicAuthRateLimiter } from "./public-rate-limit.ts";
import { createBrowserSessions } from "./sessions.ts";
import { startUiServer, type RunningUiServer } from "./server.ts";
import { loginCookie } from "./test-login.ts";

const TOKEN = "test-token-0123456789abcdef";
const PUBLIC_HOST = "tokyo.tail1234.ts.net";
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
const TAILNET_OWNER = "owner@example.com";

interface SocketResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json<T = unknown>(): T;
}

function sendViaSocket(
  socketPath: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: { headers?: Record<string, string | undefined>; body?: unknown } = {},
): Promise<SocketResponse> {
  return new Promise((resolve, reject) => {
    const rawHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      if (v !== undefined) rawHeaders[k] = v;
    }
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    if (payload !== undefined) {
      rawHeaders["content-type"] = "application/json";
      rawHeaders["content-length"] = String(Buffer.byteLength(payload));
    }
    const req = httpRequest({ socketPath, method, path, headers: rawHeaders }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body,
          json: <T = unknown>() => JSON.parse(body) as T,
        });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function connectSocketWs(socketPath: string, path: string, headers: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws+unix://${socketPath}:${path}`, { headers });
    const onOpen = () => {
      ws.off("error", onError);
      resolve(ws);
    };
    const onError = (err: Error) => {
      ws.off("open", onOpen);
      reject(err);
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
  });
}

describe("0017_public_entry.sql 幂等迁移测试", () => {
  it("把 PRAGMA user_version 退回 8 再重跑 migrate() 完全幂等，不报错且数据保留", () => {
    const db = openDatabase(":memory:");
    try {
      const first = migrate(db);
      expect(first.to).toBeGreaterThanOrEqual(17);
      expect(userVersion(db)).toBe(first.to);

      const sessions = createBrowserSessions(db, { now: () => 1_000 });
      const local = sessions.create({ userAgent: "Mac", entry: "127.0.0.1:4317" });
      const pub = sessions.create({ userAgent: "iPhone", entry: PUBLIC_HOST, viaPublic: true, clientIp: "203.0.113.5" });

      db.exec("PRAGMA user_version = 8");
      expect(userVersion(db)).toBe(8);

      const second = migrate(db);
      expect(second.from).toBe(8);
      expect(second.to).toBe(first.to);
      expect(second.applied).toContain(17);

      expect(sessions.authenticate(local.token)).toEqual({ id: local.id, status: "active", viaPublic: false });
      expect(sessions.authenticate(pub.token)).toEqual({ id: pub.id, status: "pending_approval", viaPublic: true });
      expect(sessions.list()).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});

describe("createPublicAuthRateLimiter 桶上限与过期清理", () => {
  it("IP 桶数量不超过 MAX_PUBLIC_AUTH_IP_BUCKETS（1000），超限时先清过期桶，仍满则淘汰最旧桶", () => {
    let now = 1_000_000;
    const limiter = createPublicAuthRateLimiter({ now: () => now });

    for (let i = 0; i < MAX_PUBLIC_AUTH_IP_BUCKETS; i++) {
      limiter.recordFailure(`10.0.${Math.floor(i / 256)}.${i % 256}`);
    }
    expect(limiter.bucketCount()).toBe(MAX_PUBLIC_AUTH_IP_BUCKETS);

    // 仍在窗口内新增 50 个 IP：淘汰最早插入的 50 个，总数保持 1000
    for (let i = 0; i < 50; i++) {
      limiter.recordFailure(`192.168.1.${i}`);
    }
    expect(limiter.bucketCount()).toBe(MAX_PUBLIC_AUTH_IP_BUCKETS);

    // 窗口过期后再来新 IP：先清理已过期桶
    now += PUBLIC_AUTH_IP_WINDOW_MS + 1;
    limiter.recordFailure("203.0.113.99");
    expect(limiter.bucketCount()).toBe(1);
  });
});

describe("公网入口 public.sock 与 4 道安全防线", () => {
  let root: string;
  let publicSock: string;
  let publicEntryFile: string;
  let db: Db;
  let now: number;
  let ledger: FakeLedger;
  let running: RunningUiServer;
  let localCookie: string;
  let localHost: string;
  let localOrigin: string;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "hub-public-")));
    publicSock = join(root, "run", "public.sock");
    publicEntryFile = join(root, "state", "public-entry.json");
    db = openTestDb();
    now = 10_000_000;
    ledger = new FakeLedger();
    running = await startUiServer({
      ledger: ledger.asLedger(),
      token: TOKEN,
      port: 0,
      staticDir: join(root, "no-static"),
      uploadsDir: join(root, "uploads"),
      sentFilesDir: join(root, "sent"),
      db,
      now: () => now,
      serverInfo: serverInfoFor("darwin"),
      tailnet: { current: () => ({ dnsName: PUBLIC_HOST, owner: TAILNET_OWNER }) },
      publicSock,
      publicEntryFile,
      publicEntry: { enabled: true, hostname: PUBLIC_HOST },
    });
    localHost = `127.0.0.1:${running.port}`;
    localOrigin = `http://127.0.0.1:${running.port}`;
    localCookie = await loginCookie(running.app, { token: TOKEN, port: running.port, userAgent: "Mac Safari" });
  });

  afterEach(async () => {
    await running.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const localCall = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown, cookie: string | null = localCookie) =>
    running.app.inject({
      method,
      url,
      headers: {
        host: localHost,
        ...(cookie === null ? {} : { cookie }),
        ...(method === "GET" ? {} : { origin: localOrigin }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });

  const issueLinkCode = async (): Promise<{ url: string; code: string }> => {
    const res = await localCall("POST", API_PATHS.loginLinks);
    expect(res.statusCode).toBe(201);
    const body = res.json() as LoginLinkResponse;
    const code = new URLSearchParams(new URL(body.url).hash.slice(1)).get("link")!;
    return { url: body.url, code };
  };

  it("场景 1：public.sock 上 Host/Origin 不匹配 → 403；Cookie 带 Secure；sameMachine 为 false", async () => {
    expect(statSync(publicSock).mode & 0o777).toBe(0o600);

    // Host 不匹配 → 403 forbidden_host
    for (const badHost of ["evil.example.com", "other.tail1234.ts.net", `${PUBLIC_HOST}:8443`, localHost, ""]) {
      const res = await sendViaSocket(publicSock, "GET", API_PATHS.auth, { headers: { host: badHost } });
      expect(res.status, badHost).toBe(403);
      expect(res.json()).toEqual({ code: "forbidden_host", error: "这个网址不能打开 Piece" });
    }

    // Host 匹配（含大写与 :443）→ 放行落地页
    for (const goodHost of [PUBLIC_HOST, PUBLIC_HOST.toUpperCase(), `${PUBLIC_HOST}:443`]) {
      const res = await sendViaSocket(publicSock, "GET", API_PATHS.auth, { headers: { host: goodHost } });
      expect(res.status, goodHost).toBe(200);
    }

    // POST 请求 Origin 不匹配或缺失 → 403 forbidden_origin（且不消费登录链接）
    const { code } = await issueLinkCode();
    for (const badOrigin of [`http://${PUBLIC_HOST}`, "https://evil.example.com", localOrigin, undefined]) {
      const res = await sendViaSocket(publicSock, "POST", API_PATHS.auth, {
        headers: { host: PUBLIC_HOST, origin: badOrigin },
        body: { link: code },
      });
      expect(res.status, String(badOrigin)).toBe(403);
      expect(res.json()).toEqual({ code: "forbidden_origin", error: "请求来源不对，已拦下" });
    }

    // 正确 Origin 兑换成功，种下的 Cookie 强制带 Secure、HttpOnly、SameSite=Strict
    const redeemed = await sendViaSocket(publicSock, "POST", API_PATHS.auth, {
      headers: { host: PUBLIC_HOST, origin: PUBLIC_ORIGIN, "user-agent": "iPhone Safari", "x-forwarded-for": "203.0.113.10" },
      body: { link: code },
    });
    expect(redeemed.status).toBe(202);
    const setCookie = String(redeemed.headers["set-cookie"]);
    expect(setCookie).toMatch(new RegExp(`^${UI_COOKIE_NAME}=`));
    expect(setCookie).toMatch(/; Secure(;|$)/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    const pubCookie = setCookie.split(";")[0]!;

    // 批准后检查 sameMachine = false（server.fileActions 为 false，且不暴露本机 repoDir）
    const pendingId = ((await localCall("GET", API_PATHS.browserSessions)).json() as BrowserSessionsResponse).sessions.find((s) => s.viaPublic)!.id;
    expect((await localCall("POST", API_PATHS.approveBrowserSession(pendingId))).statusCode).toBe(204);

    const stateRes = await sendViaSocket(publicSock, "GET", API_PATHS.state, {
      headers: { host: PUBLIC_HOST, cookie: pubCookie },
    });
    expect(stateRes.status).toBe(200);
    const state = stateRes.json<StateSnapshot>();
    expect(state.server.fileActions).toBe(false);
    expect(state.server.repoDir).toBeUndefined();
  });

  it("场景 2：public.sock 上带 Authorization 设备令牌或访问 /api/peer/* 一律回 403 forbidden_peer", async () => {
    const withAuth = await sendViaSocket(publicSock, "GET", API_PATHS.state, {
      headers: {
        host: PUBLIC_HOST,
        authorization: "Bearer some-device-token",
        [PEER_DEVICE_HEADER]: "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f",
      },
    });
    expect(withAuth.status).toBe(403);
    expect(withAuth.json()).toEqual({ code: "forbidden_peer", error: "别的设备不能调这个接口" });

    for (const [method, path] of [
      ["POST", API_PATHS.peerPair],
      ["PUT", API_PATHS.peerDevices],
      ["POST", API_PATHS.peerUnpair],
      ["POST", API_PATHS.peerInvites],
    ] as const) {
      const res = await sendViaSocket(publicSock, method, path, {
        headers: { host: PUBLIC_HOST, origin: PUBLIC_ORIGIN },
        body: {},
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.json()).toEqual({ code: "forbidden_peer", error: "别的设备不能调这个接口" });
    }
  });

  it("场景 3：公网禁止 GET /auth?token= 主钥匙直登与 POST /auth { token }（回 401 unauthorized）", async () => {
    const getWithToken = await sendViaSocket(publicSock, "GET", `${API_PATHS.auth}?token=${TOKEN}`, {
      headers: { host: PUBLIC_HOST },
    });
    expect(getWithToken.status).toBe(401);
    expect(getWithToken.headers["set-cookie"]).toBeUndefined();
    expect(getWithToken.json()).toEqual({ code: "unauthorized", error: "登录过期了" });

    const postWithToken = await sendViaSocket(publicSock, "POST", API_PATHS.auth, {
      headers: { host: PUBLIC_HOST, origin: PUBLIC_ORIGIN },
      body: { token: TOKEN },
    });
    expect(postWithToken.status).toBe(401);
    expect(postWithToken.headers["set-cookie"]).toBeUndefined();
  });

  it("场景 4：公网 POST /auth { link } 创建 pending_approval 会话，未批准前拦截 403 session_pending_approval，批准后放行，优先淘汰待批准", async () => {
    // 连接本机 WebSocket 监听 resync 广播
    const localWs = await running.app.injectWS(API_PATHS.ws, {
      headers: { host: localHost, origin: localOrigin, cookie: localCookie },
    });
    const resyncMessages: unknown[] = [];
    localWs.on("message", (data: Buffer) => resyncMessages.push(JSON.parse(data.toString("utf8"))));

    // 1. 生成二维码链接：公网开启时优先使用 https://<publicHostname>/auth#link=...
    const { url, code } = await issueLinkCode();
    expect(url).toBe(`${PUBLIC_ORIGIN}/auth#link=${code}`);

    // 未登录时查询 /api/auth/status 返回 unauthenticated
    const unauthStatus = await sendViaSocket(publicSock, "GET", API_PATHS.authStatus, { headers: { host: PUBLIC_HOST } });
    expect(unauthStatus.status).toBe(200);
    expect(unauthStatus.json()).toEqual({ status: "unauthenticated" });

    // 2. 手机经公网兑换链接 → 202 pending_approval，电脑端收到 resync
    const authRes = await sendViaSocket(publicSock, "POST", API_PATHS.auth, {
      headers: {
        host: PUBLIC_HOST,
        origin: PUBLIC_ORIGIN,
        "user-agent": "iPhone Safari",
        "x-forwarded-for": "198.51.100.42, 10.0.0.1",
      },
      body: { link: code },
    });
    expect(authRes.status).toBe(202);
    expect(authRes.json()).toEqual({ status: "pending_approval" });
    const phoneCookie = String(authRes.headers["set-cookie"]).split(";")[0]!;
    await new Promise((r) => setTimeout(r, 20));
    expect(resyncMessages).toContainEqual({ type: "resync" });

    // 3. 电脑端查看会话列表：包含 status = pending_approval、viaPublic = true、clientIp
    const sessionsList = ((await localCall("GET", API_PATHS.browserSessions)).json() as BrowserSessionsResponse).sessions;
    const pendingSession = sessionsList.find((s) => s.viaPublic);
    expect(pendingSession).toBeDefined();
    expect(pendingSession).toMatchObject({
      userAgent: "iPhone Safari",
      status: "pending_approval",
      viaPublic: true,
      clientIp: "198.51.100.42",
    });

    // 4. 未批准前：只放行 GET /api/auth/status 和 DELETE /api/sessions/<自己>，其余一律 403 session_pending_approval
    const pendingStatus = await sendViaSocket(publicSock, "GET", API_PATHS.authStatus, {
      headers: { host: PUBLIC_HOST, cookie: phoneCookie },
    });
    expect(pendingStatus.status).toBe(200);
    expect(pendingStatus.json()).toEqual({ status: "pending_approval" });

    for (const [method, path] of [
      ["GET", API_PATHS.state],
      ["GET", API_PATHS.browserSessions],
      ["POST", API_PATHS.approveBrowserSession(pendingSession!.id)],
      ["DELETE", API_PATHS.browserSession("other-session-id")],
      ["GET", "/d/3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f/api/state"],
    ] as const) {
      const blocked = await sendViaSocket(publicSock, method, path, {
        headers: { host: PUBLIC_HOST, origin: PUBLIC_ORIGIN, cookie: phoneCookie },
      });
      expect(blocked.status, `${method} ${path}`).toBe(403);
      expect(blocked.json()).toEqual({ code: "session_pending_approval", error: "等待已登录设备批准登录" });
    }
    await expect(
      connectSocketWs(publicSock, API_PATHS.ws, { host: PUBLIC_HOST, origin: PUBLIC_ORIGIN, cookie: phoneCookie }),
    ).rejects.toThrow(/403/);

    // 5. 电脑端调用 POST /api/sessions/:id/approve 批准该会话
    resyncMessages.length = 0;
    const approveRes = await localCall("POST", API_PATHS.approveBrowserSession(pendingSession!.id));
    expect(approveRes.statusCode).toBe(204);
    await new Promise((r) => setTimeout(r, 20));
    expect(resyncMessages).toContainEqual({ type: "resync" });

    // 6. 批准后：/api/auth/status 为 active，/api/state 返回 200，WebSocket 连接成功
    const activeStatus = await sendViaSocket(publicSock, "GET", API_PATHS.authStatus, {
      headers: { host: PUBLIC_HOST, cookie: phoneCookie },
    });
    expect(activeStatus.status).toBe(200);
    expect(activeStatus.json()).toEqual({ status: "active" });

    const stateAfterApprove = await sendViaSocket(publicSock, "GET", API_PATHS.state, {
      headers: { host: PUBLIC_HOST, cookie: phoneCookie },
    });
    expect(stateAfterApprove.status).toBe(200);

    const phoneWs = await connectSocketWs(publicSock, API_PATHS.ws, {
      host: PUBLIC_HOST,
      origin: PUBLIC_ORIGIN,
      cookie: phoneCookie,
    });
    phoneWs.close();
    localWs.terminate();

    // 7. 待批准会话 10 分钟（PENDING_SESSION_TTL_MS）未批准自动超时删除
    const { code: code2 } = await issueLinkCode();
    const pending2 = await sendViaSocket(publicSock, "POST", API_PATHS.auth, {
      headers: { host: PUBLIC_HOST, origin: PUBLIC_ORIGIN },
      body: { link: code2 },
    });
    const cookie2 = String(pending2.headers["set-cookie"]).split(";")[0]!;
    now += PENDING_SESSION_TTL_MS + 1;
    const expiredPending = await sendViaSocket(publicSock, "GET", API_PATHS.authStatus, {
      headers: { host: PUBLIC_HOST, cookie: cookie2 },
    });
    expect(expiredPending.status).toBe(200);
    expect(expiredPending.json()).toEqual({ status: "unauthenticated" });

    // 8. 满 MAX_BROWSER_SESSIONS（100）淘汰时：优先淘汰 pending_approval，绝不挤掉更老的 active 会话
    const store = createBrowserSessions(db, { now: () => now });
    store.revokeAll();
    const oldestActive = store.create({ userAgent: "OldestActiveMac", entry: localHost });
    now += 1_000;
    const firstPending = store.create({ userAgent: "FirstPendingPhone", entry: PUBLIC_HOST, viaPublic: true, clientIp: "1.1.1.1" });
    for (let i = 2; i < MAX_BROWSER_SESSIONS; i++) {
      now += 10;
      store.create({ userAgent: `Pending-${i}`, entry: PUBLIC_HOST, viaPublic: true, clientIp: "1.1.1.2" });
    }
    expect(store.list()).toHaveLength(MAX_BROWSER_SESSIONS);
    now += 10;
    const newest = store.create({ userAgent: "NewestPending", entry: PUBLIC_HOST, viaPublic: true, clientIp: "1.1.1.3" });
    expect(newest.evicted).toEqual([firstPending.id]);
    expect(store.authenticate(oldestActive.token)).toEqual({ id: oldestActive.id, status: "active", viaPublic: false });
    expect(store.authenticate(firstPending.token)).toBeNull();
  });

  it("场景 5：公网 /auth 单 IP 连续 5 次失败或全局 30 次失败 → 锁定 15 分钟回 429 public_auth_locked，不影响本机登录与已登录公网会话", async () => {
    // 先准备一个已批准的公网会话
    const { code: initialCode } = await issueLinkCode();
    const initialAuth = await sendViaSocket(publicSock, "POST", API_PATHS.auth, {
      headers: { host: PUBLIC_HOST, origin: PUBLIC_ORIGIN },
      body: { link: initialCode },
    });
    const activePubCookie = String(initialAuth.headers["set-cookie"]).split(";")[0]!;
    const pubId = ((await localCall("GET", API_PATHS.browserSessions)).json() as BrowserSessionsResponse).sessions.find((s) => s.viaPublic)!.id;
    await localCall("POST", API_PATHS.approveBrowserSession(pubId));

    // 单 IP 连续 5 次失败（返回 401）
    for (let i = 0; i < PUBLIC_AUTH_IP_MAX_FAILURES; i++) {
      const failRes = await sendViaSocket(publicSock, "POST", API_PATHS.auth, {
        headers: { host: PUBLIC_HOST, origin: PUBLIC_ORIGIN, "x-forwarded-for": "198.51.100.77" },
        body: { link: "wrong-code" },
      });
      expect(failRes.status).toBe(401);
    }

    // 锁定期间：即使拿着有效的 link，公网 POST /auth 和 GET /auth 都直接回 429 public_auth_locked，且有效 link 不被消费
    const { code: validCode } = await issueLinkCode();
    const lockedPost = await sendViaSocket(publicSock, "POST", API_PATHS.auth, {
      headers: { host: PUBLIC_HOST, origin: PUBLIC_ORIGIN, "x-forwarded-for": "198.51.100.88" },
      body: { link: validCode },
    });
    expect(lockedPost.status).toBe(429);
    expect(lockedPost.json()).toEqual({
      code: "public_auth_locked",
      error: "公网登录尝试过多，已锁定 15 分钟后再试",
    });

    const lockedGet = await sendViaSocket(publicSock, "GET", API_PATHS.auth, {
      headers: { host: PUBLIC_HOST },
    });
    expect(lockedGet.status).toBe(429);

    // 锁定期间：已批准的公网会话正常访问 /api/state
    const activeState = await sendViaSocket(publicSock, "GET", API_PATHS.state, {
      headers: { host: PUBLIC_HOST, cookie: activePubCookie },
    });
    expect(activeState.status).toBe(200);

    // 锁定期间：本机 loopback 用刚才那枚 validCode 登录完全不受影响（204）
    const loopbackRedeem = await localCall("POST", API_PATHS.auth, { link: validCode }, null);
    expect(loopbackRedeem.statusCode).toBe(204);

    // 15 分钟后解锁
    now += PUBLIC_AUTH_LOCKOUT_MS + 1;
    const { code: afterUnlockCode } = await issueLinkCode();
    const unlockedPost = await sendViaSocket(publicSock, "POST", API_PATHS.auth, {
      headers: { host: PUBLIC_HOST, origin: PUBLIC_ORIGIN, "x-forwarded-for": "198.51.100.88" },
      body: { link: afterUnlockCode },
    });
    expect(unlockedPost.status).toBe(202);

    // 全局 30 次失败测试（跨过上一段 1 小时全局窗口后，分散在不同 IP，每个 IP 只失败 2 次，不触发单 IP 阈值）
    now += PUBLIC_AUTH_GLOBAL_WINDOW_MS + 1;
    for (let i = 0; i < PUBLIC_AUTH_GLOBAL_MAX_FAILURES; i++) {
      const ip = `203.0.113.${Math.floor(i / 2) + 1}`;
      const r = await sendViaSocket(publicSock, "POST", API_PATHS.auth, {
        headers: { host: PUBLIC_HOST, origin: PUBLIC_ORIGIN, "x-forwarded-for": ip },
        body: { link: "bad-global" },
      });
      expect(r.status).toBe(401);
    }
    const globalLocked = await sendViaSocket(publicSock, "POST", API_PATHS.auth, {
      headers: { host: PUBLIC_HOST, origin: PUBLIC_ORIGIN, "x-forwarded-for": "203.0.113.250" },
      body: { link: "any" },
    });
    expect(globalLocked.status).toBe(429);
    expect(globalLocked.json()).toEqual({
      code: "public_auth_locked",
      error: "公网登录尝试过多，已锁定 15 分钟后再试",
    });
  });

  it("场景 6：公网会话 30 天不活动过期，本机会话 30 天仍有效", async () => {
    const { code } = await issueLinkCode();
    const pubAuth = await sendViaSocket(publicSock, "POST", API_PATHS.auth, {
      headers: { host: PUBLIC_HOST, origin: PUBLIC_ORIGIN },
      body: { link: code },
    });
    const pubCookie = String(pubAuth.headers["set-cookie"]).split(";")[0]!;
    const pubId = ((await localCall("GET", API_PATHS.browserSessions)).json() as BrowserSessionsResponse).sessions.find((s) => s.viaPublic)!.id;
    await localCall("POST", API_PATHS.approveBrowserSession(pubId));

    // 30 天内最後一毫秒：公网会话和本机会话都有效
    now += PUBLIC_SESSION_MAX_AGE_MS - SESSION_TOUCH_INTERVAL_MS;
    expect(
      (await sendViaSocket(publicSock, "GET", API_PATHS.state, { headers: { host: PUBLIC_HOST, cookie: pubCookie } })).status,
    ).toBe(200);

    // 从最新一次活动起再过 30 天零 1 毫秒：公网会话过期返回 401，而本机会话在 30 天不活动后依然返回 200
    const freshLocalCookie = await loginCookie(running.app, { token: TOKEN, port: running.port, userAgent: "Mac" });
    now += PUBLIC_SESSION_MAX_AGE_MS + 1;

    const expiredPub = await sendViaSocket(publicSock, "GET", API_PATHS.state, {
      headers: { host: PUBLIC_HOST, cookie: pubCookie },
    });
    expect(expiredPub.status).toBe(401);

    const validLocal = await localCall("GET", API_PATHS.state, undefined, freshLocalCookie);
    expect(validLocal.statusCode).toBe(200);
  });

  it("场景 7：PUT /api/devices/public-entry 关闭公网开关时当场停止 public.sock、撤销所有公网会话并断开其 WebSocket", async () => {
    // 1. 手机经公网登录、批准并连上 WebSocket
    const { code } = await issueLinkCode();
    const pubAuth = await sendViaSocket(publicSock, "POST", API_PATHS.auth, {
      headers: { host: PUBLIC_HOST, origin: PUBLIC_ORIGIN },
      body: { link: code },
    });
    const pubCookie = String(pubAuth.headers["set-cookie"]).split(";")[0]!;
    const pubId = ((await localCall("GET", API_PATHS.browserSessions)).json() as BrowserSessionsResponse).sessions.find((s) => s.viaPublic)!.id;
    await localCall("POST", API_PATHS.approveBrowserSession(pubId));

    const pubWs = await connectSocketWs(publicSock, API_PATHS.ws, {
      host: PUBLIC_HOST,
      origin: PUBLIC_ORIGIN,
      cookie: pubCookie,
    });
    const pubWsClosed = new Promise<number>((resolve) => pubWs.once("close", (closeCode) => resolve(closeCode)));

    const localWs = await running.app.injectWS(API_PATHS.ws, {
      headers: { host: localHost, origin: localOrigin, cookie: localCookie },
    });
    let localClosed = false;
    localWs.once("close", () => {
      localClosed = true;
    });

    // 2. 关闭公网入口开关
    const disableRes = await localCall("PUT", API_PATHS.publicEntry, { enabled: false });
    expect(disableRes.statusCode).toBe(200);
    const disabledStatus = disableRes.json() as PublicEntryStatus;
    expect(disabledStatus).toEqual({
      enabled: false,
      hostname: PUBLIC_HOST,
      funnelCommand: `sudo tailscale funnel --bg unix:${publicSock}`,
    });
    expect(JSON.parse(readFileSync(publicEntryFile, "utf8"))).toEqual({
      enabled: false,
      hostname: PUBLIC_HOST,
    });
    expect(statSync(publicEntryFile).mode & 0o777).toBe(0o600);

    // 3. 公网 WebSocket 被当场关掉（1008），public.sock 已停止监听并删除，公网会话从库里全部清空，本机不受影响
    expect(await pubWsClosed).toBe(1008);
    expect(existsSync(publicSock)).toBe(false);
    await expect(sendViaSocket(publicSock, "GET", API_PATHS.state, { headers: { host: PUBLIC_HOST } })).rejects.toThrow();

    const remaining = ((await localCall("GET", API_PATHS.browserSessions)).json() as BrowserSessionsResponse).sessions;
    expect(remaining.some((s) => s.viaPublic)).toBe(false);
    expect(localClosed).toBe(false);

    // 4. 重新打开公网入口（不传 hostname 时自动沿用已保存或 tailnet.dnsName）
    const enableRes = await localCall("PUT", API_PATHS.publicEntry, { enabled: true });
    expect(enableRes.statusCode).toBe(200);
    expect((enableRes.json() as PublicEntryStatus).enabled).toBe(true);
    expect(existsSync(publicSock)).toBe(true);
    const probeAfterReenable = await sendViaSocket(publicSock, "GET", API_PATHS.authStatus, { headers: { host: PUBLIC_HOST } });
    expect(probeAfterReenable.status).toBe(200);
    expect(probeAfterReenable.json()).toEqual({ status: "unauthenticated" });

    localWs.terminate();
  });

  it("场景 8：loopback 下 POST /auth { token } 成功种 Cookie 并返回 204；错误 token 或非 loopback 入口返回 401", async () => {
    const okRes = await localCall("POST", API_PATHS.auth, { token: TOKEN }, null);
    expect(okRes.statusCode).toBe(204);
    const setCookie = String(okRes.headers["set-cookie"]);
    expect(setCookie).toContain(`${uiCookieName(localHost)}=`);
    expect(setCookie).not.toContain("Secure");
    const desktopCookie = setCookie.split(";")[0]!;

    const stateRes = await localCall("GET", API_PATHS.state, undefined, desktopCookie);
    expect(stateRes.statusCode).toBe(200);
    expect((stateRes.json() as StateSnapshot).publicEntry).toEqual({
      enabled: true,
      hostname: PUBLIC_HOST,
      funnelCommand: `sudo tailscale funnel --bg unix:${publicSock}`,
    });

    // 错误 token → 401
    const badRes = await localCall("POST", API_PATHS.auth, { token: "wrong-token-0123456789abcdef" }, null);
    expect(badRes.statusCode).toBe(401);
    expect(badRes.headers["set-cookie"]).toBeUndefined();

    // tailnet 入口不支持 POST /auth { token } → 401
    const viaTailnet = await running.app.inject({
      method: "POST",
      url: API_PATHS.auth,
      headers: {
        host: PUBLIC_HOST,
        origin: PUBLIC_ORIGIN,
        [TAILSCALE_USER_LOGIN_HEADER]: TAILNET_OWNER,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ token: TOKEN }),
    });
    expect(viaTailnet.statusCode).toBe(401);
  });

  it("场景 9：/auth 落地页包含 202 待批准提示与 /api/auth/status 轮询跳转逻辑，以及 429 锁定提示；未保存前 /api/state 也返回默认 publicEntry", async () => {
    const landing = await sendViaSocket(publicSock, "GET", API_PATHS.auth, {
      headers: { host: PUBLIC_HOST },
    });
    expect(landing.status).toBe(200);
    expect(landing.body).toContain("res.status === 204");
    expect(landing.body).toContain("res.status === 202");
    expect(landing.body).toContain("已扫码，请在已登录的电脑上点「允许」完成登录…");
    expect(landing.body).toContain("/api/auth/status");
    expect(landing.body).toContain('data.status === "active"');
    expect(landing.body).toContain('data.status === "unauthenticated"');
    expect(landing.body).toContain("登录未获批准或已超时，请回电脑上重新生成二维码。");
    expect(landing.body).toContain("res.status === 429");
    expect(landing.body).toContain("公网登录尝试过多，已锁定 15 分钟后再试。");

    // 还没保存过 public-entry.json 时，/api/state 也返回默认 publicEntry（hostname 默认取 tailnet.dnsName）
    const freshFile = join(root, "state", "unconfigured-public-entry.json");
    const freshSock = join(root, "run", "unconfigured-public.sock");
    const freshServer = await startUiServer({
      ledger: ledger.asLedger(),
      token: TOKEN,
      port: 0,
      staticDir: join(root, "no-static"),
      uploadsDir: join(root, "uploads"),
      sentFilesDir: join(root, "sent"),
      db,
      now: () => now,
      serverInfo: serverInfoFor("darwin"),
      tailnet: { current: () => ({ dnsName: PUBLIC_HOST, owner: TAILNET_OWNER }) },
      publicSock: freshSock,
      publicEntryFile: freshFile,
    });
    try {
      const freshCookie = await loginCookie(freshServer.app, { token: TOKEN, port: freshServer.port, userAgent: "Mac" });
      const res = await freshServer.app.inject({
        method: "GET",
        url: API_PATHS.state,
        headers: { host: `127.0.0.1:${freshServer.port}`, cookie: freshCookie },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as StateSnapshot).publicEntry).toEqual({
        enabled: false,
        hostname: PUBLIC_HOST,
        funnelCommand: `sudo tailscale funnel --bg unix:${freshSock}`,
      });
    } finally {
      await freshServer.close();
    }
  });

  it("场景 10：tailscale funnel --bg unix:... 将 Host 改写为 localhost 并通过 X-Forwarded-Host 传真实域名时全链路放行", async () => {
    const funnelHost = "tokyo.tailnet.ts.net";
    const funnelOrigin = `https://${funnelHost}`;
    const configRes = await localCall("PUT", API_PATHS.publicEntry, { enabled: true, hostname: funnelHost });
    expect(configRes.statusCode).toBe(200);

    // Host: localhost + X-Forwarded-Host: evil.com（或缺失）仍返回 403 forbidden_host
    for (const badForwarded of ["evil.com", undefined]) {
      const badRes = await sendViaSocket(publicSock, "GET", API_PATHS.auth, {
        headers: { host: "localhost", "x-forwarded-host": badForwarded },
      });
      expect(badRes.status, String(badForwarded)).toBe(403);
      expect(badRes.json()).toEqual({ code: "forbidden_host", error: "这个网址不能打开 Piece" });
    }

    // 1. GET /auth（Host: localhost + X-Forwarded-Host: tokyo.tailnet.ts.net）→ 200
    const landingRes = await sendViaSocket(publicSock, "GET", API_PATHS.auth, {
      headers: { host: "localhost", "x-forwarded-host": funnelHost },
    });
    expect(landingRes.status).toBe(200);

    // 2. POST /auth（Origin: https://tokyo.tailnet.ts.net）→ 202 待批准，且会话 entry 记录真实外部域名
    const { code } = await issueLinkCode();
    const authRes = await sendViaSocket(publicSock, "POST", API_PATHS.auth, {
      headers: {
        host: "localhost",
        "x-forwarded-host": funnelHost,
        origin: funnelOrigin,
        "user-agent": "iPhone Safari",
        "x-forwarded-for": "203.0.113.55",
      },
      body: { link: code },
    });
    expect(authRes.status).toBe(202);
    expect(authRes.json()).toEqual({ status: "pending_approval" });
    const setCookie = String(authRes.headers["set-cookie"]);
    expect(setCookie).toMatch(new RegExp(`^${UI_COOKIE_NAME}=`));
    const phoneCookie = setCookie.split(";")[0]!;

    const row = db.get<{ entry: string }>(
      "SELECT s.entry FROM browser_sessions s JOIN browser_session_public p ON p.session_id = s.id",
    );
    expect(row?.entry).toBe(funnelHost);

    // 3. 批准后 GET /api/state（Host: localhost + X-Forwarded-Host: tokyo.tailnet.ts.net）→ 200
    const pendingId = ((await localCall("GET", API_PATHS.browserSessions)).json() as BrowserSessionsResponse).sessions.find((s) => s.viaPublic)!.id;
    expect((await localCall("POST", API_PATHS.approveBrowserSession(pendingId))).statusCode).toBe(204);

    const stateRes = await sendViaSocket(publicSock, "GET", API_PATHS.state, {
      headers: { host: "localhost", "x-forwarded-host": funnelHost, cookie: phoneCookie },
    });
    expect(stateRes.status).toBe(200);
  });
});
