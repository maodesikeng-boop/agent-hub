// 浏览器会话（联机 P6，docs/multi-device-design.md 第 3.4 节）：每个浏览器一条登录记录，库里只存哈希，能单个退出、全部退出，
// 二维码登录链接 5 分钟、只能用一次。先是库和链接的单元测试，后面是经界面服务的整条流程（撤销后立刻失效是重点）。
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  API_PATHS,
  LOGIN_LINK_TTL_MS,
  MAX_BROWSER_SESSIONS,
  MAX_PENDING_LOGIN_LINKS,
  MAX_USER_AGENT_CHARS,
  SESSION_MAX_AGE_MS,
  SESSION_TOUCH_INTERVAL_MS,
  UI_COOKIE_NAME,
  uiCookieName,
  type BrowserSessionsResponse,
  type LoginLinkResponse,
} from "../../shared/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import type { Db } from "../store/index.ts";
import { FakeLedger } from "./fake-ledger.ts";
import { createBrowserSessions, createLoginLinks } from "./sessions.ts";
import { createUiServer } from "./server.ts";
import { loginCookie } from "./test-login.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

describe("uiCookieName（cookie 按主机名不分端口，名字里带端口各用各的）", () => {
  it.each([
    ["127.0.0.1:4317", `${UI_COOKIE_NAME}_4317`],
    ["localhost:4318", `${UI_COOKIE_NAME}_4318`],
    ["tokyo.tail1234.ts.net", UI_COOKIE_NAME],
    [undefined, UI_COOKIE_NAME],
  ])("%s → %s", (host, name) => {
    expect(uiCookieName(host)).toBe(name);
  });
});

describe("createBrowserSessions", () => {
  let db: Db;
  let now: number;
  let sessions: ReturnType<typeof createBrowserSessions>;
  beforeEach(() => {
    db = openTestDb();
    now = 1_000_000;
    sessions = createBrowserSessions(db, { now: () => now });
  });
  afterEach(() => db.close());

  it("创建：令牌是随机的，每次不同；id 和令牌无关", () => {
    const a = sessions.create({ userAgent: "A", entry: "127.0.0.1:4317" });
    const b = sessions.create({ userAgent: "B", entry: "127.0.0.1:4317" });
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(43);
    expect(a.id).not.toBe(b.id);
    expect(a.token).not.toContain(a.id);
  });

  it("库里只有令牌的 sha256，没有令牌明文", () => {
    const { token } = sessions.create({ userAgent: "A", entry: "127.0.0.1:4317" });
    const rows = db.all<Record<string, unknown>>("SELECT * FROM browser_sessions");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(sha256(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("认令牌：对的返回会话 id；错的、空的、非字符串、令牌的哈希本身都认不出", () => {
    const { id, token } = sessions.create({ userAgent: "A", entry: "x" });
    expect(sessions.authenticate(token)).toEqual({ id, status: "active", viaPublic: false });
    expect(sessions.authenticate(`${token}x`)).toBeNull();
    expect(sessions.authenticate(token.slice(0, -1))).toBeNull();
    expect(sessions.authenticate("")).toBeNull();
    expect(sessions.authenticate(undefined)).toBeNull();
    expect(sessions.authenticate(sha256(token))).toBeNull();
    expect(sessions.authenticate(id)).toBeNull();
  });

  it("revoke：这一个立刻认不出，别的不受影响；没有这个 id 返回 false", () => {
    const a = sessions.create({ userAgent: "A", entry: "x" });
    const b = sessions.create({ userAgent: "B", entry: "x" });
    expect(sessions.revoke(a.id)).toBe(true);
    expect(sessions.authenticate(a.token)).toBeNull();
    expect(sessions.authenticate(b.token)).toEqual({ id: b.id, status: "active", viaPublic: false });
    expect(sessions.revoke(a.id)).toBe(false);
    expect(sessions.revoke("nope")).toBe(false);
  });

  it("revokeAll：全部立刻认不出，表清空", () => {
    const a = sessions.create({ userAgent: "A", entry: "x" });
    const b = sessions.create({ userAgent: "B", entry: "x" });
    sessions.revokeAll();
    expect(sessions.authenticate(a.token)).toBeNull();
    expect(sessions.authenticate(b.token)).toBeNull();
    expect(sessions.list()).toEqual([]);
  });

  it("list：按最后活动从新到旧，带 UA 和时间", () => {
    const a = sessions.create({ userAgent: "A", entry: "x" });
    now += 1000;
    const b = sessions.create({ userAgent: "B", entry: "x" });
    now += 1000;
    const list = sessions.list();
    expect(list.map((s) => s.id)).toEqual([b.id, a.id]);
    expect(list[0]).toEqual({ id: b.id, userAgent: "B", createdAt: 1_001_000, lastSeenAt: 1_001_000, status: "active", viaPublic: false });
  });

  it("最后活动：隔不到间隔不写库，超过间隔才更新", () => {
    const { id, token } = sessions.create({ userAgent: "A", entry: "x" });
    now += SESSION_TOUCH_INTERVAL_MS - 1;
    sessions.authenticate(token);
    expect(sessions.list()[0]!.lastSeenAt).toBe(1_000_000);
    now += 1;
    sessions.authenticate(token);
    expect(sessions.list().find((s) => s.id === id)!.lastSeenAt).toBe(now);
  });

  it("太久没用（超过有效期）的会话认不出，并且被删掉", () => {
    const { token } = sessions.create({ userAgent: "A", entry: "x" });
    now += SESSION_MAX_AGE_MS + 1;
    expect(sessions.authenticate(token)).toBeNull();
    expect(sessions.list()).toEqual([]);
  });

  it("User-Agent 去掉控制字符、截到上限；没有就记成空串", () => {
    const long = sessions.create({ userAgent: `a\u0000\n${"b".repeat(MAX_USER_AGENT_CHARS * 2)}`, entry: "x" });
    const ua = sessions.list().find((s) => s.id === long.id)!.userAgent;
    expect(ua).not.toMatch(/[\u0000-\u001f]/);
    expect([...ua]).toHaveLength(MAX_USER_AGENT_CHARS);
  });

  it("满了：新登录挤掉最久没用的，其余留着", () => {
    const first = sessions.create({ userAgent: "first", entry: "x" });
    for (let i = 1; i < MAX_BROWSER_SESSIONS; i++) {
      now += 1;
      sessions.create({ userAgent: `u${i}`, entry: "x" });
    }
    expect(sessions.list()).toHaveLength(MAX_BROWSER_SESSIONS);
    now += 1;
    const newest = sessions.create({ userAgent: "newest", entry: "x" });
    expect(sessions.list()).toHaveLength(MAX_BROWSER_SESSIONS);
    expect(sessions.authenticate(first.token)).toBeNull();
    expect(sessions.authenticate(newest.token)).toEqual({ id: newest.id, status: "active", viaPublic: false });
    expect(newest.evicted).toEqual([first.id]);
  });

  it("没满时 evicted 是空的", () => {
    expect(sessions.create({ userAgent: "A", entry: "x" }).evicted).toEqual([]);
  });

  it("重开库（守护进程重启）会话还在", () => {
    const { id, token } = sessions.create({ userAgent: "A", entry: "x" });
    const again = createBrowserSessions(db, { now: () => now });
    expect(again.authenticate(token)).toEqual({ id, status: "active", viaPublic: false });
  });
});

describe("createLoginLinks", () => {
  let now: number;
  let links: ReturnType<typeof createLoginLinks>;
  beforeEach(() => {
    now = 5_000;
    links = createLoginLinks({ now: () => now });
  });

  it("发出的码随机，有效期 5 分钟", () => {
    const a = links.issue();
    const b = links.issue();
    expect(a.code).not.toBe(b.code);
    expect(a.code.length).toBeGreaterThanOrEqual(43);
    expect(a.expiresAt).toBe(5_000 + LOGIN_LINK_TTL_MS);
  });

  it("只能用一次：第二次用同一个码失败", () => {
    const { code } = links.issue();
    expect(links.consume(code)).toBe(true);
    expect(links.consume(code)).toBe(false);
  });

  it("5 分钟内有效，到点就过期", () => {
    const a = links.issue();
    now += LOGIN_LINK_TTL_MS - 1;
    expect(links.consume(a.code)).toBe(true);
    const b = links.issue();
    now += LOGIN_LINK_TTL_MS;
    expect(links.consume(b.code)).toBe(false);
  });

  it("没发过的码、空串、非字符串都不行；失败不影响别的码", () => {
    const { code } = links.issue();
    expect(links.consume("nope")).toBe(false);
    expect(links.consume("")).toBe(false);
    expect(links.consume(undefined)).toBe(false);
    expect(links.consume(code)).toBe(true);
  });

  it("同时有效的码有上限：多了挤掉最早的", () => {
    const first = links.issue();
    const rest = Array.from({ length: MAX_PENDING_LOGIN_LINKS }, () => links.issue());
    expect(links.consume(first.code)).toBe(false);
    expect(links.consume(rest.at(-1)!.code)).toBe(true);
  });
});

// ---- 经界面服务 ----

const TOKEN = "test-token-0123456789abcdef";
const PORT = 4000;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";

describe("经界面服务的浏览器登录", () => {
  let dir: string;
  let tokenFile: string;
  let db: Db;
  let now: number;
  let app: FastifyInstance;
  let rotated: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "hub-sessions-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html>");
    tokenFile = join(dir, "ui-token");
    db = openTestDb();
    now = 10_000_000;
    rotated = [];
    app = createUiServer({
      ledger: new FakeLedger().asLedger(),
      token: TOKEN,
      staticDir: dir,
      uploadsDir: join(dir, "uploads"),
      sentFilesDir: join(dir, "sent"),
      port: PORT,
      db,
      now: () => now,
      rotateToken: () => {
        const next = `rotated-token-${rotated.length}-0123456789abcdef`;
        rotated.push(next);
        return next;
      },
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const login = (userAgent?: string) => loginCookie(app, { token: TOKEN, port: PORT, ...(userAgent === undefined ? {} : { userAgent }) });

  const call = (method: "GET" | "POST" | "DELETE", url: string, cookie: string | null, opts: { host?: string; origin?: string } = {}) =>
    app.inject({
      method,
      url,
      headers: {
        host: opts.host ?? HOST,
        ...(cookie === null ? {} : { cookie }),
        ...(method === "GET" ? {} : { origin: opts.origin ?? ORIGIN }),
      },
    });

  const listSessions = async (cookie: string) => ((await call("GET", API_PATHS.browserSessions, cookie)).json() as BrowserSessionsResponse).sessions;

  describe("登录发的是随机会话 cookie，不是令牌", () => {
    it("cookie 值不是主钥匙，库里只有它的哈希；cookie 名带端口", async () => {
      const res = await app.inject({ method: "GET", url: `/auth?token=${TOKEN}`, headers: { host: HOST } });
      const setCookie = String(res.headers["set-cookie"]);
      const [pair] = setCookie.split(";");
      const [name, value] = pair!.split("=") as [string, string];
      expect(name).toBe(`${UI_COOKIE_NAME}_${PORT}`);
      expect(value).not.toBe(TOKEN);
      expect(value.length).toBeGreaterThanOrEqual(43);
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=Strict/i);
      expect(db.all<{ token_hash: string }>("SELECT token_hash FROM browser_sessions").map((r) => r.token_hash)).toEqual([sha256(value)]);
    });

    it("老 cookie（值是主钥匙本身，不管名字带不带端口）不再有效：要重登一次", async () => {
      for (const name of [UI_COOKIE_NAME, `${UI_COOKIE_NAME}_${PORT}`]) {
        expect((await call("GET", "/api/state", `${name}=${TOKEN}`)).statusCode).toBe(401);
      }
    });

    it("每个浏览器各一条：登两次是两条，各自的 cookie 都有效", async () => {
      const a = await login(IPHONE_UA);
      const b = await login(MAC_UA);
      expect(a).not.toBe(b);
      expect((await call("GET", "/api/state", a)).statusCode).toBe(200);
      expect((await call("GET", "/api/state", b)).statusCode).toBe(200);
      expect(await listSessions(a)).toHaveLength(2);
    });

    it("同一个浏览器带着有效 cookie 再点一次登录链接：换新会话，旧的作废，不堆记录", async () => {
      const old = await login(MAC_UA);
      const res = await app.inject({ method: "GET", url: `/auth?token=${TOKEN}`, headers: { host: HOST, cookie: old, "user-agent": MAC_UA } });
      const fresh = String(res.headers["set-cookie"]).split(";")[0]!;
      expect(fresh).not.toBe(old);
      expect((await call("GET", "/api/state", old)).statusCode).toBe(401);
      expect((await call("GET", "/api/state", fresh)).statusCode).toBe(200);
      expect(await listSessions(fresh)).toHaveLength(1);
    });

    it("cookie 名对不上 Host 的端口就不认（另一个端口的 cookie 不能拿来用）", async () => {
      const cookie = await login();
      const value = cookie.split("=")[1]!;
      expect((await call("GET", "/api/state", `${UI_COOKIE_NAME}_4001=${value}`)).statusCode).toBe(401);
    });

    it("同一个浏览器里两个端口的 cookie 互不顶掉", async () => {
      const other = createUiServer({
        ledger: new FakeLedger().asLedger(),
        token: "other-token-0123456789abcdef",
        staticDir: dir,
        uploadsDir: join(dir, "uploads2"),
        sentFilesDir: join(dir, "sent2"),
        port: 4001,
        db: openTestDb(),
      });
      await other.ready();
      const mine = await login();
      const theirs = await loginCookie(other, { token: "other-token-0123456789abcdef", port: 4001 });
      // 浏览器把两个 cookie 一起带上（同主机名），各自只认自己的那个
      const jar = `${mine}; ${theirs}`;
      expect((await call("GET", "/api/state", jar)).statusCode).toBe(200);
      expect((await other.inject({ method: "GET", url: "/api/state", headers: { host: "127.0.0.1:4001", cookie: jar } })).statusCode).toBe(200);
      await other.close();
    });
  });

  describe("列表、单个退出", () => {
    it("GET /api/sessions：每个浏览器一条，自己标 current，UA 原样（截断后）记着", async () => {
      const phone = await login(IPHONE_UA);
      const mac = await login(MAC_UA);
      const list = await listSessions(mac);
      expect(list).toHaveLength(2);
      expect(list.filter((s) => s.current).map((s) => s.userAgent)).toEqual([MAC_UA]);
      expect(list.find((s) => !s.current)!.userAgent).toBe(IPHONE_UA);
      expect((await listSessions(phone)).find((s) => s.current)!.userAgent).toBe(IPHONE_UA);
    });

    it("列表里不含令牌或哈希", async () => {
      const cookie = await login();
      const body = (await call("GET", API_PATHS.browserSessions, cookie)).body;
      expect(body).not.toContain(cookie.split("=")[1]!);
      expect(body).not.toContain("hash");
      expect(Object.keys(JSON.parse(body).sessions[0]).sort()).toEqual(["createdAt", "current", "id", "lastSeenAt", "status", "userAgent", "viaPublic"]);
    });

    it("退出别的浏览器：204，那个浏览器马上 401（接口、WebSocket 都是），自己不受影响", async () => {
      const mine = await login(MAC_UA);
      const phone = await login(IPHONE_UA);
      const phoneId = (await listSessions(mine)).find((s) => !s.current)!.id;
      expect((await call("GET", "/api/state", phone)).statusCode).toBe(200);

      const res = await call("DELETE", API_PATHS.browserSession(phoneId), mine);
      expect(res.statusCode).toBe(204);

      expect((await call("GET", "/api/state", phone)).statusCode).toBe(401);
      expect((await call("POST", API_PATHS.loginLinks, phone)).statusCode).toBe(401);
      await expect(app.injectWS("/api/ws", { headers: { host: HOST, origin: ORIGIN, cookie: phone } })).rejects.toThrow(/401/);
      expect((await call("GET", "/api/state", mine)).statusCode).toBe(200);
      expect(await listSessions(mine)).toHaveLength(1);
    });

    it("退出自己：204，响应清掉 cookie，之后这个 cookie 401", async () => {
      const mine = await login();
      const id = (await listSessions(mine))[0]!.id;
      const res = await call("DELETE", API_PATHS.browserSession(id), mine);
      expect(res.statusCode).toBe(204);
      const setCookie = String(res.headers["set-cookie"]);
      expect(setCookie).toContain(`${UI_COOKIE_NAME}_${PORT}=`);
      expect(setCookie).toMatch(/Max-Age=0/);
      expect((await call("GET", "/api/state", mine)).statusCode).toBe(401);
    });

    it("退别人的时候不清自己的 cookie", async () => {
      const mine = await login();
      await login();
      const otherId = (await listSessions(mine)).find((s) => !s.current)!.id;
      expect((await call("DELETE", API_PATHS.browserSession(otherId), mine)).headers["set-cookie"]).toBeUndefined();
    });

    it("不存在的 id：404", async () => {
      const mine = await login();
      expect((await call("DELETE", API_PATHS.browserSession("nope"), mine)).statusCode).toBe(404);
    });

    it("撤销后立刻失效：已经连着的 WebSocket 当场被关（不等断线重连）", async () => {
      const mine = await login(MAC_UA);
      const phone = await login(IPHONE_UA);
      const ws = await app.injectWS("/api/ws", { headers: { host: HOST, origin: ORIGIN, cookie: phone } });
      const closed = new Promise<number>((resolve) => ws.once("close", (code: number) => resolve(code)));
      const phoneId = (await listSessions(mine)).find((s) => !s.current)!.id;
      await call("DELETE", API_PATHS.browserSession(phoneId), mine);
      expect(await closed).toBe(1008);
    });

    it("没登录不能看、不能退（401）；会改状态的要同源 Origin（403）", async () => {
      const mine = await login();
      const id = (await listSessions(mine))[0]!.id;
      expect((await call("GET", API_PATHS.browserSessions, null)).statusCode).toBe(401);
      expect((await call("DELETE", API_PATHS.browserSession(id), null)).statusCode).toBe(401);
      expect((await call("DELETE", API_PATHS.browserSession(id), mine, { origin: "http://evil.example.com" })).statusCode).toBe(403);
      expect((await call("POST", API_PATHS.logoutAll, mine, { origin: "http://evil.example.com" })).statusCode).toBe(403);
      expect((await call("POST", API_PATHS.loginLinks, mine, { origin: "http://evil.example.com" })).statusCode).toBe(403);
      expect(await listSessions(mine)).toHaveLength(1);
    });

    it("会话令牌的哈希、会话 id 都当不了 cookie", async () => {
      const mine = await login();
      const id = (await listSessions(mine))[0]!.id;
      const value = mine.split("=")[1]!;
      for (const v of [id, sha256(value)]) {
        expect((await call("GET", "/api/state", `${UI_COOKIE_NAME}_${PORT}=${v}`)).statusCode).toBe(401);
      }
    });
  });

  describe("全部退出", () => {
    it("204：所有浏览器（含自己）立刻 401，会话清空，换了主钥匙，响应清掉自己的 cookie", async () => {
      const mine = await login(MAC_UA);
      const phone = await login(IPHONE_UA);
      const res = await call("POST", API_PATHS.logoutAll, mine);
      expect(res.statusCode).toBe(204);
      expect(String(res.headers["set-cookie"])).toMatch(/Max-Age=0/);
      expect((await call("GET", "/api/state", mine)).statusCode).toBe(401);
      expect((await call("GET", "/api/state", phone)).statusCode).toBe(401);
      expect(db.all("SELECT * FROM browser_sessions")).toEqual([]);
      expect(rotated).toHaveLength(1);
    });

    it("旧主钥匙作废、新主钥匙能登录；旧登录链接也作废", async () => {
      const mine = await login();
      const link = ((await call("POST", API_PATHS.loginLinks, mine)).json() as LoginLinkResponse).url;
      await call("POST", API_PATHS.logoutAll, mine);
      expect((await app.inject({ method: "GET", url: `/auth?token=${TOKEN}`, headers: { host: HOST } })).statusCode).toBe(401);
      const code = new URLSearchParams(new URL(link).hash.slice(1)).get("link");
      expect((await app.inject({ method: "POST", url: "/auth", headers: { host: HOST, origin: ORIGIN, "content-type": "application/json" }, payload: JSON.stringify({ link: code }) })).statusCode).toBe(401);
      const again = await loginCookie(app, { token: rotated[0]!, port: PORT });
      expect((await call("GET", "/api/state", again)).statusCode).toBe(200);
    });

    it("已经连着的 WebSocket 全部当场被关", async () => {
      const mine = await login();
      const other = await login();
      const sockets = await Promise.all([mine, other].map((cookie) => app.injectWS("/api/ws", { headers: { host: HOST, origin: ORIGIN, cookie } })));
      const closes = sockets.map((ws: { once(event: "close", cb: (code: number) => void): unknown }) => new Promise<number>((resolve) => ws.once("close", resolve)));
      await call("POST", API_PATHS.logoutAll, mine);
      expect(await Promise.all(closes)).toEqual([1008, 1008]);
    });

    it("没有换主钥匙的回调时守护进程自己换一个随机的（不能一直用旧的）", async () => {
      const bare = createUiServer({ ledger: new FakeLedger().asLedger(), token: TOKEN, staticDir: dir, uploadsDir: join(dir, "u"), sentFilesDir: join(dir, "s"), port: PORT });
      await bare.ready();
      const cookie = await loginCookie(bare, { token: TOKEN, port: PORT });
      await bare.inject({ method: "POST", url: API_PATHS.logoutAll, headers: { host: HOST, cookie, origin: ORIGIN } });
      expect((await bare.inject({ method: "GET", url: `/auth?token=${TOKEN}`, headers: { host: HOST } })).statusCode).toBe(401);
      await bare.close();
    });
  });

  describe("会话满了挤掉最旧的：和“退出”走同一条路", () => {
    const wsOf = (cookie: string) => app.injectWS("/api/ws", { headers: { host: HOST, origin: ORIGIN, cookie } });
    const closeCode = (ws: { once(event: "close", cb: (code: number) => void): unknown }) => new Promise<number>((resolve) => ws.once("close", resolve));

    it("被挤掉的浏览器：cookie 立刻 401，连着的 WebSocket 当场被关（1008），别的浏览器不受影响", async () => {
      const oldest = await login(MAC_UA);
      now += 1;
      const second = await login(IPHONE_UA);
      const oldestWs = await wsOf(oldest);
      const secondWs = await wsOf(second);
      const oldestClosed = closeCode(oldestWs);
      let secondClosed = false;
      void closeCode(secondWs).then(() => (secondClosed = true));
      for (let i = 2; i < MAX_BROWSER_SESSIONS; i++) {
        now += 1;
        await login();
      }
      expect(await listSessions(second)).toHaveLength(MAX_BROWSER_SESSIONS);
      expect((await call("GET", "/api/state", oldest)).statusCode).toBe(200);
      // 第 101 个登录：最久没用的是 oldest，second 排在它后面（先让 second 比 oldest 更新鲜，免得并列）
      now += SESSION_TOUCH_INTERVAL_MS;
      expect((await call("GET", "/api/state", second)).statusCode).toBe(200);
      now += 1;
      await login();
      expect(await oldestClosed).toBe(1008);
      expect((await call("GET", "/api/state", oldest)).statusCode).toBe(401);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(secondClosed).toBe(false);
      expect((await call("GET", "/api/state", second)).statusCode).toBe(200);
      expect(await listSessions(second)).toHaveLength(MAX_BROWSER_SESSIONS);
      secondWs.terminate();
    });
  });

  describe("二维码登录链接", () => {
    const makeLink = async (cookie: string, host = HOST) => (await call("POST", API_PATHS.loginLinks, cookie, { host })).json() as LoginLinkResponse;
    const codeOf = (link: LoginLinkResponse) => new URLSearchParams(new URL(link.url).hash.slice(1)).get("link")!;
    /** 照浏览器那样用链接：# 片段不会发给服务器，落地页读出码再 POST /auth 兑换。 */
    const open = (link: LoginLinkResponse, headers: Record<string, string> = {}, body: unknown = { link: codeOf(link) }) =>
      app.inject({ method: "POST", url: new URL(link.url).pathname, headers: { host: HOST, origin: ORIGIN, "content-type": "application/json", ...headers }, payload: JSON.stringify(body) });

    it("201：返回入口上的完整链接（用请求的 Host）和 5 分钟后的过期时间；要登录", async () => {
      expect((await call("POST", API_PATHS.loginLinks, null)).statusCode).toBe(401);
      const cookie = await login();
      const res = await call("POST", API_PATHS.loginLinks, cookie);
      expect(res.statusCode).toBe(201);
      const body = res.json() as LoginLinkResponse;
      // 码在 # 片段里，不在 ? 查询参数里：片段不会随请求发给服务器，不进代理 / 访问日志 / Referer
      expect(body.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${PORT}/auth#link=[A-Za-z0-9_-]{43,}$`));
      expect(body.url).not.toContain("?");
      expect(body.expiresAt).toBe(now + LOGIN_LINK_TTL_MS);
    });

    it("手机打开链接就登录：POST /auth 兑换成功 204，发自己的会话 cookie（不是电脑的），列表里多一条手机", async () => {
      const mac = await login(MAC_UA);
      const link = await makeLink(mac);
      const res = await open(link, { "user-agent": IPHONE_UA });
      expect(res.statusCode).toBe(204);
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      const phone = String(res.headers["set-cookie"]).split(";")[0]!;
      expect(phone).not.toBe(mac);
      expect((await call("GET", "/api/state", phone)).statusCode).toBe(200);
      const list = await listSessions(mac);
      expect(list.map((s) => s.userAgent).sort()).toEqual([IPHONE_UA, MAC_UA].sort());
    });

    it("链接本身不进库明文，也不当会话令牌用", async () => {
      const mac = await login();
      const link = await makeLink(mac);
      const code = codeOf(link);
      expect(JSON.stringify(db.all("SELECT * FROM browser_sessions"))).not.toContain(code);
      expect((await call("GET", "/api/state", `${UI_COOKIE_NAME}_${PORT}=${code}`)).statusCode).toBe(401);
    });

    it("只能用一次：第二次打开 401，不设 cookie", async () => {
      const link = await makeLink(await login());
      expect((await open(link)).statusCode).toBe(204);
      const second = await open(link);
      expect(second.statusCode).toBe(401);
      expect(second.headers["set-cookie"]).toBeUndefined();
    });

    it("5 分钟过期：到点打开 401，没登录上", async () => {
      const link = await makeLink(await login());
      now += LOGIN_LINK_TTL_MS;
      const res = await open(link);
      expect(res.statusCode).toBe(401);
      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    it("过期前一刻还能用", async () => {
      const link = await makeLink(await login());
      now += LOGIN_LINK_TTL_MS - 1;
      expect((await open(link)).statusCode).toBe(204);
    });

    it("码不对、没带、不是字符串：401，不设 cookie，也没用掉真的链接", async () => {
      const link = await makeLink(await login());
      for (const body of [{ link: "nope" }, { link: "" }, {}, { link: 5 }, { link: [codeOf(link)] }, null]) {
        const res = await open(link, {}, body);
        expect(res.statusCode).toBe(401);
        expect(res.headers["set-cookie"]).toBeUndefined();
      }
      expect((await open(link)).statusCode).toBe(204);
    });

    it("老的 /auth?link=<码> 不再认（码会进日志）：401，没用掉，也不设 cookie", async () => {
      const link = await makeLink(await login());
      const code = codeOf(link);
      for (const url of [`/auth?link=${code}`, `/auth?link=${code}&link=${code}`, `/auth?link=${code}&token=${TOKEN}`, "/auth?link="]) {
        const res = await app.inject({ method: "GET", url, headers: { host: HOST } });
        expect(res.statusCode).toBe(401);
        expect(res.headers["set-cookie"]).toBeUndefined();
      }
      expect((await open(link)).statusCode).toBe(204);
    });

    it("跨站不行：Origin 不对或没带 403，链接没被用掉；Host 不对 403", async () => {
      const link = await makeLink(await login());
      expect((await open(link, { origin: "http://evil.example.com" })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/auth", headers: { host: HOST, "content-type": "application/json" }, payload: JSON.stringify({ link: codeOf(link) }) })).statusCode).toBe(403);
      expect((await open(link, { host: "evil.com:4000" })).statusCode).toBe(403);
      expect((await open(link)).statusCode).toBe(204);
    });

    it("落地页（GET /auth 不带参数）：不要登录就能打开，读 # 片段、先清地址栏再 POST 兑换，不带 Referer，页面里没有任何码", async () => {
      const link = await makeLink(await login());
      const res = await app.inject({ method: "GET", url: new URL(link.url).pathname, headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(res.body).toContain('<meta name="referrer" content="no-referrer">');
      expect(res.body).toContain("location.hash");
      expect(res.body).toContain('referrerPolicy: "no-referrer"');
      expect(res.body).toContain('method: "POST"');
      // 地址栏先清掉（replaceState），再发请求
      expect(res.body.indexOf("history.replaceState")).toBeGreaterThan(-1);
      expect(res.body.indexOf("history.replaceState")).toBeLessThan(res.body.indexOf("fetch("));
      expect(res.body).not.toContain(codeOf(link));
      // 打开落地页本身没用掉码
      expect((await open(link)).statusCode).toBe(204);
    });

    it("服务器收到的请求里没有码：登录全程（发链接、落地页、兑换）的请求地址、Referer 都不含它", async () => {
      const seen: string[] = [];
      const spied = createUiServer({
        ledger: new FakeLedger().asLedger(),
        token: TOKEN,
        staticDir: dir,
        uploadsDir: join(dir, "uploads3"),
        sentFilesDir: join(dir, "sent3"),
        port: PORT,
        db,
        now: () => now,
      });
      spied.addHook("onRequest", async (req) => {
        seen.push(`${req.method} ${req.raw.url} ${String(req.headers.referer ?? "")}`);
      });
      await spied.ready();
      const cookie = await loginCookie(spied, { token: TOKEN, port: PORT });
      const made = await spied.inject({ method: "POST", url: API_PATHS.loginLinks, headers: { host: HOST, cookie, origin: ORIGIN } });
      const link = made.json() as LoginLinkResponse;
      const code = codeOf(link);
      // 浏览器打开 link.url：请求地址只有 /auth（片段不发），落地页再 POST /auth
      await spied.inject({ method: "GET", url: new URL(link.url).pathname, headers: { host: HOST } });
      const redeemed = await spied.inject({ method: "POST", url: "/auth", headers: { host: HOST, origin: ORIGIN, "content-type": "application/json" }, payload: JSON.stringify({ link: code }) });
      expect(redeemed.statusCode).toBe(204);
      expect(seen.length).toBeGreaterThanOrEqual(4);
      expect(seen.join("\n")).not.toContain(code);
      expect(redeemed.headers["set-cookie"]).toBeDefined();
      await spied.close();
    });

    it("Host 不对：403，链接没被用掉", async () => {
      const link = await makeLink(await login());
      expect((await app.inject({ method: "GET", url: "/auth", headers: { host: "evil.com:4000" } })).statusCode).toBe(403);
      expect((await open(link)).statusCode).toBe(204);
    });

    it("链接里的地址跟着请求走：经 https 来的（x-forwarded-proto）是 https", async () => {
      const cookie = await login();
      const res = await app.inject({ method: "POST", url: API_PATHS.loginLinks, headers: { host: HOST, cookie, origin: ORIGIN, "x-forwarded-proto": "https" } });
      expect((res.json() as LoginLinkResponse).url).toMatch(new RegExp(`^https://127\\.0\\.0\\.1:${PORT}/auth#link=`));
    });
  });
});
