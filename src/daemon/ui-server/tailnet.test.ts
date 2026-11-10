// 联机 P1：经 tailscale serve 进来的请求（docs/multi-device-design.md 第 3.1、3.3 节）。
// Host 白名单加本机的 tailnet 名字；Origin 是 https://<名字>；cookie 加 Secure；serve 带来的身份头必须是设备主人。
// 本机 127.0.0.1 直连照旧只看 cookie。身份头不能代替 cookie。
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { API_PATHS, UI_COOKIE_NAME, uiCookieName, serverInfoFor, type LoginLinkResponse } from "../../shared/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import type { TailnetSelf } from "../platform/index.ts";
import type { Db } from "../store/index.ts";
import { FakeLedger } from "./fake-ledger.ts";
import { testLogin } from "./test-login.ts";
import { createUiServer, startUiServer, type RunningUiServer } from "./server.ts";

const TOKEN = "test-token-0123456789abcdef";
const PORT = 4000;
const NAME = "mac-mini.tail1234.ts.net";
const OWNER = "owner@example.com";
// 会话在库里：每个测试开始时开一个，cookie 的值是它的令牌（名字带端口，见 uiCookieName；经 serve 来的 Host 没端口，用不带端口的名字）。
const LOCAL = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, cookie: "" };
const VIA_SERVE = { host: NAME, origin: `https://${NAME}`, cookie: "", "tailscale-user-login": OWNER };
let db: Db;
let sessionToken: string;
const cookieFor = (host: string) => `${uiCookieName(host)}=${sessionToken}`;
function newSession() {
  db = openTestDb();
  sessionToken = testLogin(db, PORT).token;
  LOCAL.cookie = cookieFor(LOCAL.host);
  VIA_SERVE.cookie = cookieFor(NAME);
}

let root: string;
let self: TailnetSelf | null;
let ledger: FakeLedger;
let app: FastifyInstance;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hub-tailnet-")));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function options(serveTarget: "unix" | "tcp") {
  return {
    ledger: ledger.asLedger(),
    token: TOKEN,
    staticDir: join(root, "no-static"),
    uploadsDir: join(root, "uploads"),
    sentFilesDir: join(root, "sent-files"),
    db,
    tailnet: { current: () => self },
    serveTarget,
  };
}

type Headers = Record<string, string | undefined>;
const call = (method: "GET" | "POST", url: string, headers: Headers) =>
  app.inject({ method, url, headers: Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined)) as Record<string, string> });

describe("serve 转发到 127.0.0.1 端口（macOS）", () => {
  beforeEach(async () => {
    newSession();
    self = { dnsName: NAME, owner: OWNER };
    ledger = new FakeLedger();
    app = createUiServer({ ...options("tcp"), port: PORT });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("Host 是本机 tailnet 名字（大小写、带 :443 都算）、身份是主人：放行", async () => {
    expect((await call("GET", API_PATHS.state, VIA_SERVE)).statusCode).toBe(200);
    expect((await call("GET", API_PATHS.state, { ...VIA_SERVE, host: NAME.toUpperCase() })).statusCode).toBe(200);
    expect((await call("GET", API_PATHS.state, { ...VIA_SERVE, host: `${NAME}:443`, cookie: cookieFor(`${NAME}:443`) })).statusCode).toBe(200);
    expect((await call("GET", API_PATHS.state, { ...VIA_SERVE, "tailscale-user-login": OWNER.toUpperCase() })).statusCode).toBe(200);
  });

  it.each(["other.tail1234.ts.net", "mac-mini.tail9999.ts.net", `${NAME}.evil.com`, `${NAME}:4000`, `evil.${NAME}`])(
    "别的 *.ts.net、端口不对：403 forbidden_host（Host %s）",
    async (host) => {
      const res = await call("GET", API_PATHS.state, { ...VIA_SERVE, host });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ code: "forbidden_host", error: "这个网址不能打开 Piece" });
    },
  );

  it("经 serve 来、登录名不是主人或没带：403 forbidden_identity（静态文件、/auth 也一样）", async () => {
    for (const login of ["friend@example.com", undefined, ""]) {
      const res = await call("GET", API_PATHS.state, { ...VIA_SERVE, "tailscale-user-login": login });
      expect(res.statusCode, String(login)).toBe(403);
      expect(res.json()).toEqual({ code: "forbidden_identity", error: "这台设备的主人不是你" });
    }
    expect((await call("GET", "/", { ...VIA_SERVE, cookie: undefined, "tailscale-user-login": "friend@example.com" })).statusCode).toBe(403);
    const auth = await call("GET", `${API_PATHS.auth}?token=${TOKEN}`, { ...VIA_SERVE, cookie: undefined, "tailscale-user-login": "x@y.z" });
    expect(auth.statusCode).toBe(403);
    expect(auth.headers["set-cookie"]).toBeUndefined();
  });

  it("不知道主人（tag 设备又没写 AGENT_HUB_TAILNET_OWNER）：一律 403，不放行", async () => {
    self = { dnsName: NAME, owner: null };
    expect((await call("GET", API_PATHS.state, VIA_SERVE)).statusCode).toBe(403);
  });

  it("身份头单独不能登录：还要 cookie", async () => {
    const res = await call("GET", API_PATHS.state, { ...VIA_SERVE, cookie: undefined });
    expect(res.statusCode).toBe(401);
  });

  it("本机直连不带身份头：只看 cookie，和以前一样；带了也不看", async () => {
    expect((await call("GET", API_PATHS.state, LOCAL)).statusCode).toBe(200);
    expect((await call("GET", API_PATHS.state, { ...LOCAL, "tailscale-user-login": "friend@example.com" })).statusCode).toBe(200);
    expect((await call("GET", API_PATHS.state, { ...LOCAL, cookie: undefined })).statusCode).toBe(401);
  });

  it("没探测到 tailnet 名字：只认本机，和现在一样", async () => {
    self = null;
    expect((await call("GET", API_PATHS.state, VIA_SERVE)).statusCode).toBe(403);
    expect((await call("GET", API_PATHS.state, LOCAL)).statusCode).toBe(200);
  });

  it("改状态的请求：Origin 要是 https://<本机 tailnet 名字>", async () => {
    const stop = (origin: string | undefined) => call("POST", API_PATHS.stop(1), { ...VIA_SERVE, origin });
    expect((await stop(`https://${NAME}`)).statusCode).toBe(202);
    for (const bad of [`http://${NAME}`, "https://other.tail1234.ts.net", `https://${NAME}:4000`, `http://127.0.0.1:${PORT}`, undefined]) {
      const res = await stop(bad);
      expect(res.statusCode, String(bad)).toBe(403);
      expect(res.json()).toEqual({ code: "forbidden_origin", error: "请求来源不对，已拦下" });
    }
    expect(ledger.stopped).toHaveLength(1);
    // 本机直连时 https://<tailnet> 的 Origin 不算同源
    expect((await call("POST", API_PATHS.stop(1), { ...LOCAL, origin: `https://${NAME}` })).statusCode).toBe(403);
  });

  it("WebSocket 握手经 serve：Origin https://<名字> + 主人 + cookie 放行，身份不对拒绝", async () => {
    const socket = await app.injectWS(API_PATHS.ws, { headers: VIA_SERVE as Record<string, string> });
    expect(ledger.listenerCount).toBe(1);
    socket.terminate();
    await expect(app.injectWS(API_PATHS.ws, { headers: { ...VIA_SERVE, "tailscale-user-login": "x@y.z" } as Record<string, string> })).rejects.toThrow(/403/);
  });

  it("经 serve 来的（serve 从 127.0.0.1 转发）不算浏览器在本机：不给“在 Finder 中显示”，接口 501", async () => {
    const id = "0123456789abcdef";
    mkdirSync(join(root, "uploads", id), { recursive: true });
    writeFileSync(join(root, "uploads", id, "a.pdf"), "x");
    await app.close();
    app = createUiServer({ ...options("tcp"), port: PORT, serverInfo: serverInfoFor("darwin"), runOpen: async () => {} });
    await app.ready();
    expect((await call("GET", API_PATHS.state, VIA_SERVE)).json().server.fileActions).toBe(false);
    expect((await call("GET", API_PATHS.state, LOCAL)).json().server.fileActions).toBe(true);
    expect((await call("POST", API_PATHS.attachmentAction(id, "reveal"), VIA_SERVE)).statusCode).toBe(501);
    expect((await call("POST", API_PATHS.attachmentAction(id, "reveal"), LOCAL)).statusCode).toBe(200);
  });

  it("经 serve（https）登录的 cookie 带 Secure；本机 http 的不带", async () => {
    const viaServe = await call("GET", `${API_PATHS.auth}?token=${TOKEN}`, { ...VIA_SERVE, cookie: undefined });
    expect(viaServe.statusCode).toBe(302);
    expect(String(viaServe.headers["set-cookie"])).toMatch(/; Secure(;|$)/);
    const local = await call("GET", `${API_PATHS.auth}?token=${TOKEN}`, { ...LOCAL, cookie: undefined });
    expect(local.statusCode).toBe(302);
    expect(String(local.headers["set-cookie"])).not.toContain("Secure");
  });
});

describe("二维码登录链接 × tailnet", () => {
  beforeEach(async () => {
    newSession();
    self = { dnsName: NAME, owner: OWNER };
    ledger = new FakeLedger();
    app = createUiServer({ ...options("tcp"), port: PORT });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  const makeLink = async (headers: Headers) => (await call("POST", API_PATHS.loginLinks, headers)).json() as LoginLinkResponse;
  const redeem = (headers: Headers, url: string) => {
    const code = new URLSearchParams(new URL(url).hash.slice(1)).get("link");
    return app.inject({
      method: "POST",
      url: "/auth",
      headers: { ...Object.fromEntries(Object.entries({ ...headers, cookie: undefined }).filter(([, v]) => v !== undefined)), "content-type": "application/json" } as Record<string, string>,
      payload: JSON.stringify({ link: code }),
    });
  };

  it("二维码里的地址：经 serve 点的用 https://<tailnet 名字>；本机 127.0.0.1 上点的，本机认得 tailnet 名字也用它（手机才扫得通）", async () => {
    expect((await makeLink(VIA_SERVE)).url).toMatch(new RegExp(`^https://${NAME.replaceAll(".", "\\.")}/auth#link=[A-Za-z0-9_-]{43,}$`));
    expect((await makeLink(LOCAL)).url).toMatch(new RegExp(`^https://${NAME.replaceAll(".", "\\.")}/auth#link=`));
  });

  it("没有 tailnet 名字（没装 Tailscale、还没探到）：保持现状，用请求的 Host", async () => {
    self = null;
    expect((await makeLink(LOCAL)).url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${PORT}/auth#link=`));
  });

  it("手机经 serve（https）用链接登录：cookie 带 Secure 和不带端口的名字；本机 http 兑换的不带 Secure", async () => {
    const phone = await redeem(VIA_SERVE, (await makeLink(VIA_SERVE)).url);
    expect(phone.statusCode).toBe(204);
    const setCookie = String(phone.headers["set-cookie"]);
    expect(setCookie).toMatch(/; Secure(;|$)/);
    expect(setCookie.startsWith(`${UI_COOKIE_NAME}=`)).toBe(true);
    const local = await redeem(LOCAL, (await makeLink(LOCAL)).url);
    expect(local.statusCode).toBe(204);
    expect(String(local.headers["set-cookie"])).not.toContain("Secure");
  });

  it("经 serve 兑换：身份不是主人 403、Origin 不对 403，链接没被用掉", async () => {
    const link = await makeLink(VIA_SERVE);
    expect((await redeem({ ...VIA_SERVE, "tailscale-user-login": "friend@example.com" }, link.url)).statusCode).toBe(403);
    expect((await redeem({ ...VIA_SERVE, origin: "https://evil.example.com" }, link.url)).statusCode).toBe(403);
    expect((await redeem(VIA_SERVE, link.url)).statusCode).toBe(204);
  });

  it("退出时清 cookie 也带 Secure（经 serve 来的）", async () => {
    const res = await call("POST", API_PATHS.logoutAll, VIA_SERVE);
    expect(res.statusCode).toBe(204);
    expect(String(res.headers["set-cookie"])).toMatch(/Max-Age=0.*; Secure/);
  });
});

describe("serve 转发到 Unix socket（Linux）", () => {
  let running: RunningUiServer;
  let socketPath: string;

  beforeEach(async () => {
    newSession();
    self = { dnsName: NAME, owner: OWNER };
    ledger = new FakeLedger();
    socketPath = join(root, "ui.sock");
    running = await startUiServer({ ...options("unix"), port: 0, serveSocket: socketPath });
    app = running.app;
  });
  afterEach(async () => {
    await running.close();
    db.close();
  });

  function viaSocket(headers: Headers): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request({ socketPath, path: API_PATHS.state, headers: headers as Record<string, string>, agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("socket 权限 0600", () => {
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  it("socket 上：tailnet 名字 + 主人 + cookie 放行；本机 Host 不认", async () => {
    expect(await viaSocket(VIA_SERVE)).toBe(200);
    expect(await viaSocket({ ...VIA_SERVE, "tailscale-user-login": "friend@example.com" })).toBe(403);
    expect(await viaSocket({ ...LOCAL, host: `127.0.0.1:${running.port}` })).toBe(403);
  });

  it("socket 上：tailscale serve --bg unix:... 将 Host 改写为 localhost 并带 X-Forwarded-Host 时正常放行", async () => {
    expect(await viaSocket({ ...VIA_SERVE, host: "localhost", "x-forwarded-host": NAME })).toBe(200);
    expect(await viaSocket({ ...VIA_SERVE, host: "localhost", "x-forwarded-host": "evil.com" })).toBe(403);
  });

  it("TCP 端口上：只认本机 Host，tailnet 名字不认（本机别的进程连端口伪造不了 serve 流量）", async () => {
    const tcp = (headers: Headers) => call("GET", API_PATHS.state, headers);
    expect((await tcp({ ...LOCAL, host: `127.0.0.1:${running.port}`, cookie: cookieFor(`127.0.0.1:${running.port}`) })).statusCode).toBe(200);
    expect((await tcp(VIA_SERVE)).statusCode).toBe(403);
  });

  it("关掉后 socket 文件删掉", async () => {
    await running.close();
    expect(() => statSync(socketPath)).toThrow();
    running = await startUiServer({ ...options("unix"), port: 0, serveSocket: socketPath });
    app = running.app;
  });
});
