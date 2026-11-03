import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES, UI_COOKIE_NAME, type Change, type WsServerMessage } from "../../shared/index.ts";
import { FakeLedger, makeMessage } from "./fake-ledger.ts";
import { createUiServer, startUiServer } from "./server.ts";

const TOKEN = "test-token-0123456789abcdef";
const PORT = 4000;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const COOKIE = `${UI_COOKIE_NAME}=${TOKEN}`;
const INDEX_HTML = "<!doctype html><title>agent-hub</title>";

let staticDir: string;
let ledger: FakeLedger;
let app: FastifyInstance;

beforeEach(async () => {
  staticDir = mkdtempSync(join(tmpdir(), "hub-static-"));
  writeFileSync(join(staticDir, "index.html"), INDEX_HTML);
  ledger = new FakeLedger();
  app = createUiServer({ ledger: ledger.asLedger(), token: TOKEN, staticDir, port: PORT });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(staticDir, { recursive: true, force: true });
});

interface ReqOpts {
  cookie?: string | null;
  host?: string;
  /** undefined：POST 带同源的 Origin、GET 不带（浏览器就是这样）；null：不带；字符串：原样带。 */
  origin?: string | null;
  body?: unknown;
  rawBody?: string;
}

async function call(method: "GET" | "POST", url: string, opts: ReqOpts = {}) {
  const headers: Record<string, string> = { host: opts.host ?? HOST };
  const cookie = opts.cookie === undefined ? COOKIE : opts.cookie;
  if (cookie !== null) headers.cookie = cookie;
  const origin = opts.origin === undefined ? (method === "POST" ? ORIGIN : null) : opts.origin;
  if (origin !== null) headers.origin = origin;
  if (opts.body !== undefined || opts.rawBody !== undefined) headers["content-type"] = "application/json";
  return app.inject({
    method,
    url,
    headers,
    payload: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
}

describe("只听本机", () => {
  it("startUiServer 监听 127.0.0.1，返回实际端口，Host 用它就能访问", async () => {
    const running = await startUiServer({ ledger: ledger.asLedger(), token: TOKEN, staticDir, port: 0 });
    try {
      const addr = running.app.server.address();
      expect(addr).toMatchObject({ address: "127.0.0.1", port: running.port });
      expect(running.port).toBeGreaterThan(0);
      const res = await fetch(`http://127.0.0.1:${running.port}/api/state`, { headers: { cookie: COOKIE } });
      expect(res.status).toBe(200);
    } finally {
      await running.close();
    }
  });
});

describe("令牌格式", () => {
  it("太短的令牌（含空串）直接拒绝创建，免得空 cookie 就能登录", () => {
    for (const token of ["", "short", "has space in it 0123456789", "semi;colon-0123456789abc"]) {
      expect(() => createUiServer({ ledger: ledger.asLedger(), token, staticDir })).toThrow(/token/);
    }
  });
});

describe("登录 /auth", () => {
  it("令牌对：设 HttpOnly、SameSite=Strict 的 cookie，跳到 /", async () => {
    const res = await call("GET", `/auth?token=${TOKEN}`, { cookie: null });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/");
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toContain(`${UI_COOKIE_NAME}=${TOKEN}`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\//);
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("拿 /auth 设的 cookie 能访问 /api/state", async () => {
    const login = await call("GET", `/auth?token=${TOKEN}`, { cookie: null });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const res = await call("GET", "/api/state", { cookie });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ["令牌不对", `/auth?token=wrong-token-0123456789abc`],
    ["没带令牌", "/auth"],
    ["令牌是空串", "/auth?token="],
    ["令牌带了两次", `/auth?token=${TOKEN}&token=${TOKEN}`],
    ["令牌只是前缀", `/auth?token=${TOKEN.slice(0, -1)}`],
    ["令牌多一截", `/auth?token=${TOKEN}x`],
  ])("%s：401，不设 cookie", async (_name, url) => {
    const res = await call("GET", url, { cookie: null });
    expect(res.statusCode).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});

describe("没登录", () => {
  const apiRequests: Array<["GET" | "POST", string, unknown?]> = [
    ["GET", "/api/state"],
    ["GET", "/api/conversations/1/messages?before=5"],
    ["POST", "/api/conversations/1/messages", { clientId: "c", text: "hi" }],
    ["POST", "/api/conversations/1/stop"],
    ["GET", "/api/ws"],
    ["GET", "/api/no-such-thing"],
  ];

  it.each(apiRequests)("没 cookie：%s %s 返回 401，不碰账本", async (method, url, body) => {
    const res = await call(method, url, { cookie: null, body, origin: ORIGIN });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
    expect(ledger.posted).toEqual([]);
    expect(ledger.stopped).toEqual([]);
  });

  it.each([
    ["错的令牌", `${UI_COOKIE_NAME}=wrong-token-0123456789abc`],
    ["别的 cookie 名", `other=${TOKEN}`],
    ["空值", `${UI_COOKIE_NAME}=`],
  ])("cookie 不对（%s）：401", async (_name, cookie) => {
    expect((await call("GET", "/api/state", { cookie })).statusCode).toBe(401);
  });

  it("cookie 夹在别的 cookie 中间也认", async () => {
    const res = await call("GET", "/api/state", { cookie: `a=1; ${COOKIE}; b=2` });
    expect(res.statusCode).toBe(200);
  });

  it("WebSocket 没 cookie 连不上", async () => {
    await expect(app.injectWS("/api/ws?since=100", { headers: { host: HOST, origin: ORIGIN } })).rejects.toThrow(/401/);
    expect(ledger.listenerCount).toBe(0);
  });

  it("WebSocket cookie 不对连不上", async () => {
    await expect(
      app.injectWS("/api/ws", { headers: { host: HOST, origin: ORIGIN, cookie: `${UI_COOKIE_NAME}=wrong-token-0123456789abc` } }),
    ).rejects.toThrow(/401/);
  });
});

describe("防 DNS 重绑定", () => {
  it.each(["127.0.0.1:4000", "localhost:4000", "LOCALHOST:4000"])("Host %s 放行", async (host) => {
    expect((await call("GET", "/api/state", { host })).statusCode).toBe(200);
  });

  it.each([
    "evil.example.com",
    "evil.example.com:4000",
    "127.0.0.1",
    "127.0.0.1:4001",
    "localhost:80",
    "127.0.0.1.evil.com:4000",
    "[::1]:4000",
    "",
  ])("Host %j：403", async (host) => {
    const res = await call("GET", "/api/state", { host });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden_host" });
  });

  it("没 cookie 又是错 Host：先 403（Host 在认证前查）", async () => {
    expect((await call("GET", "/api/state", { host: "evil.com:4000", cookie: null })).statusCode).toBe(403);
  });

  it("/auth 也要查 Host，错的不设 cookie", async () => {
    const res = await call("GET", `/auth?token=${TOKEN}`, { host: "evil.com:4000", cookie: null });
    expect(res.statusCode).toBe(403);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("静态文件也要查 Host", async () => {
    expect((await call("GET", "/", { host: "evil.com:4000", cookie: null })).statusCode).toBe(403);
  });

  it("WebSocket 握手也要查 Host", async () => {
    await expect(app.injectWS("/api/ws", { headers: { host: "evil.com:4000", origin: ORIGIN, cookie: COOKIE } })).rejects.toThrow(/403/);
  });
});

describe("检查 Origin（浏览器认为 localhost 不同端口是同一个站点，SameSite=Strict 拦不住）", () => {
  const post = (origin?: string | null) =>
    call("POST", "/api/conversations/1/messages", { origin, body: { clientId: "c", text: "hi" } });
  const ws = (origin: string | null, query = "") => {
    const headers: Record<string, string> = { host: HOST, cookie: COOKIE };
    if (origin !== null) headers.origin = origin;
    return app.injectWS(`/api/ws${query}`, { headers });
  };

  it.each(["http://127.0.0.1:4000", "http://localhost:4000", "http://LOCALHOST:4000", "HTTP://127.0.0.1:4000"])("POST 带 Origin %s 放行", async (origin) => {
    expect((await post(origin)).statusCode).toBe(200);
    expect(ledger.posted).toHaveLength(1);
  });

  it.each(["http://127.0.0.1:4000", "http://localhost:4000", "http://LOCALHOST:4000"])("WebSocket 带 Origin %s 放行", async (origin) => {
    const socket = await ws(origin);
    expect(ledger.listenerCount).toBe(1);
    socket.terminate();
  });

  const badOrigins: Array<[string, string]> = [
    ["本机别的端口", "http://127.0.0.1:4001"],
    ["localhost 别的端口", "http://localhost:3000"],
    ["没写端口", "http://127.0.0.1"],
    ["别的域名", "http://evil.example.com"],
    ["别的域名同端口", "http://evil.example.com:4000"],
    ["域名里藏着 127.0.0.1", "http://127.0.0.1.evil.com:4000"],
    ["域名后缀是 localhost", "http://evil-localhost:4000"],
    ["https", "https://127.0.0.1:4000"],
    ["null（沙盒 iframe、file:// 页面）", "null"],
    ["空串", ""],
    ["末尾斜杠", "http://127.0.0.1:4000/"],
    ["带路径", "http://127.0.0.1:4000/x"],
    ["带用户名", "http://user@127.0.0.1:4000"],
    ["端口前补零", "http://127.0.0.1:04000"],
    ["前后有空白", " http://127.0.0.1:4000"],
    ["IPv6", "http://[::1]:4000"],
    ["只有主机名", "127.0.0.1:4000"],
    ["扩展来源", "chrome-extension://abcdef"],
  ];

  it.each(badOrigins)("POST 发消息：Origin 是%s → 403，不碰账本", async (_name, origin) => {
    const res = await post(origin);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden_origin" });
    expect(ledger.posted).toEqual([]);
  });

  it.each(badOrigins)("POST 停止：Origin 是%s → 403，不碰账本", async (_name, origin) => {
    const res = await call("POST", "/api/conversations/1/stop", { origin });
    expect(res.statusCode).toBe(403);
    expect(ledger.stopped).toEqual([]);
  });

  it.each(badOrigins)("WebSocket：Origin 是%s → 拒绝握手，不留监听者", async (_name, origin) => {
    await expect(ws(origin)).rejects.toThrow(/403/);
    expect(ledger.listenerCount).toBe(0);
  });

  it("POST 没带 Origin：403（浏览器发同源 POST 一定带）", async () => {
    const res = await post(null);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden_origin" });
    expect(ledger.posted).toEqual([]);
    const stop = await call("POST", "/api/conversations/1/stop", { origin: null });
    expect(stop.statusCode).toBe(403);
    expect(ledger.stopped).toEqual([]);
  });

  it("WebSocket 没带 Origin：拒绝握手，不留监听者", async () => {
    await expect(ws(null, `?since=${ledger.currentSeq}`)).rejects.toThrow(/403/);
    expect(ledger.listenerCount).toBe(0);
  });

  it("GET 不查 Origin：带别的 Origin 或不带都能读", async () => {
    expect((await call("GET", "/api/state", { origin: "http://evil.example.com" })).statusCode).toBe(200);
    expect((await call("GET", "/api/state", { origin: "null" })).statusCode).toBe(200);
    expect((await call("GET", "/api/state", { origin: null })).statusCode).toBe(200);
    expect((await call("GET", "/api/conversations/1/messages?before=3", { origin: "http://evil.example.com" })).statusCode).toBe(200);
  });

  it("Origin 对但没登录：401（Origin 不能代替 cookie）", async () => {
    expect((await call("POST", "/api/conversations/1/stop", { cookie: null })).statusCode).toBe(401);
    await expect(app.injectWS("/api/ws", { headers: { host: HOST, origin: ORIGIN } })).rejects.toThrow(/401/);
  });

  it("Origin 错又没登录：先 403（Origin 在认证前查）", async () => {
    const res = await call("POST", "/api/conversations/1/stop", { cookie: null, origin: "http://evil.example.com" });
    expect(res.statusCode).toBe(403);
  });

  it("端口跟着实际监听的走：真起服务，同源 Origin 放行，别的端口拒绝", async () => {
    const running = await startUiServer({ ledger: ledger.asLedger(), token: TOKEN, staticDir, port: 0 });
    try {
      const url = `http://127.0.0.1:${running.port}/api/conversations/1/stop`;
      const send = (origin: string) => fetch(url, { method: "POST", headers: { cookie: COOKIE, origin } });
      expect((await send(`http://127.0.0.1:${running.port}`)).status).toBe(202);
      expect((await send(`http://localhost:${running.port}`)).status).toBe(202);
      expect((await send(`http://127.0.0.1:${running.port + 1}`)).status).toBe(403);
      expect((await send(`http://127.0.0.1:${PORT}`)).status).toBe(403);
    } finally {
      await running.close();
    }
  });
});

describe("GET /api/state 和 /messages?before=", () => {
  it("/api/state 返回账本的快照", async () => {
    ledger.snapshotValue = {
      seq: 0,
      pms: [{ id: 1, name: "项目经理", avatarFile: null, mode: "chat", defaultModel: null, personaFile: null, createdAt: 1 }],
      conversations: [],
      sessions: [],
      health: [],
    };
    const res = await call("GET", "/api/state");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...ledger.snapshotValue, seq: ledger.currentSeq });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("?before= 把对话编号和消息编号原样交给账本，返回它给的页", async () => {
    ledger.messages = [makeMessage(1, 1), makeMessage(2, 1), makeMessage(3, 1), makeMessage(4, 2)];
    const res = await call("GET", "/api/conversations/1/messages?before=3");
    expect(res.statusCode).toBe(200);
    expect(ledger.messagesBeforeCalls).toEqual([{ conversationId: 1, before: 3 }]);
    expect(res.json()).toEqual({ messages: [ledger.messages[0], ledger.messages[1]], hasMore: false });
  });

  it.each(["", "?before=", "?before=abc", "?before=0", "?before=-1", "?before=1.5", "?before=1e3"])(
    "before 不合法（%j）：400，不调账本",
    async (query) => {
      const res = await call("GET", `/api/conversations/1/messages${query}`);
      expect(res.statusCode).toBe(400);
      expect(ledger.messagesBeforeCalls).toEqual([]);
    },
  );

  it("对话编号不是正整数：400", async () => {
    expect((await call("GET", "/api/conversations/abc/messages?before=3")).statusCode).toBe(400);
    expect((await call("GET", "/api/conversations/0/messages?before=3")).statusCode).toBe(400);
    expect(ledger.messagesBeforeCalls).toEqual([]);
  });

  it("对话不存在：404", async () => {
    const res = await call("GET", "/api/conversations/99/messages?before=3");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "conversation_not_found" });
  });
});

describe("发消息 POST /api/conversations/:id/messages", () => {
  it("参数原样交给 ledger.postUserMessage，返回 messageId", async () => {
    const text = "  记住暗号：蓝鲸。\n然后介绍你自己  ";
    const res = await call("POST", "/api/conversations/1/messages", { body: { clientId: "c-1", text } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ messageId: 1 });
    expect(ledger.posted).toEqual([{ conversationId: 1, clientId: "c-1", text }]);
  });

  it("同一个 clientId 发两次：两次返回同一个 messageId（幂等靠账本，界面服务不拦也不改）", async () => {
    const body = { clientId: "dup", text: "hi" };
    const a = await call("POST", "/api/conversations/1/messages", { body });
    const b = await call("POST", "/api/conversations/1/messages", { body });
    expect(a.json()).toEqual(b.json());
    expect(ledger.posted).toHaveLength(2);
    expect(ledger.messages).toHaveLength(1);
  });

  it("不同 clientId 是不同消息", async () => {
    const a = await call("POST", "/api/conversations/1/messages", { body: { clientId: "a", text: "hi" } });
    const b = await call("POST", "/api/conversations/1/messages", { body: { clientId: "b", text: "hi" } });
    expect(a.json()).not.toEqual(b.json());
  });

  it("刚好 100 KB 放行（按 UTF-8 字节算）", async () => {
    const res = await call("POST", "/api/conversations/1/messages", {
      body: { clientId: "c", text: "a".repeat(MAX_MESSAGE_BYTES) },
    });
    expect(res.statusCode).toBe(200);
  });

  it("按字节不按字符：中文 34134 个字（102402 字节）超限", async () => {
    const text = "蓝".repeat(Math.floor(MAX_MESSAGE_BYTES / 3) + 1);
    expect(text.length).toBeLessThan(MAX_MESSAGE_BYTES);
    const res = await call("POST", "/api/conversations/1/messages", { body: { clientId: "c", text } });
    expect(res.statusCode).toBe(400);
    expect(ledger.posted).toEqual([]);
  });

  const bad: Array<[string, unknown]> = [
    ["空文本", { clientId: "c", text: "" }],
    ["只有空白", { clientId: "c", text: " \n\t " }],
    ["超过 100 KB", { clientId: "c", text: "a".repeat(MAX_MESSAGE_BYTES + 1) }],
    ["少了 clientId", { text: "hi" }],
    ["clientId 是空串", { clientId: "", text: "hi" }],
    ["clientId 太长", { clientId: "x".repeat(201), text: "hi" }],
    ["clientId 不是字符串", { clientId: 123, text: "hi" }],
    ["少了 text", { clientId: "c" }],
    ["text 不是字符串", { clientId: "c", text: 123 }],
    ["text 是 null", { clientId: "c", text: null }],
    ["body 是数组", [{ clientId: "c", text: "hi" }]],
    ["body 是 null", null],
    ["body 是字符串", "hi"],
  ];
  it.each(bad)("请求体不对（%s）：400，不调账本", async (_name, body) => {
    const res = await call("POST", "/api/conversations/1/messages", { rawBody: JSON.stringify(body) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error");
    expect(ledger.posted).toEqual([]);
  });

  it("body 不是合法 JSON：400，不调账本", async () => {
    const res = await call("POST", "/api/conversations/1/messages", { rawBody: "{not json" });
    expect(res.statusCode).toBe(400);
    expect(ledger.posted).toEqual([]);
  });

  it("没有 body：400，不调账本", async () => {
    const res = await call("POST", "/api/conversations/1/messages", {});
    expect(res.statusCode).toBe(400);
    expect(ledger.posted).toEqual([]);
  });

  it("对话编号不是正整数：400", async () => {
    const res = await call("POST", "/api/conversations/abc/messages", { body: { clientId: "c", text: "hi" } });
    expect(res.statusCode).toBe(400);
    expect(ledger.posted).toEqual([]);
  });

  it("对话不存在（账本抛 ConversationNotFoundError）：404", async () => {
    const res = await call("POST", "/api/conversations/99/messages", { body: { clientId: "c", text: "hi" } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "conversation_not_found" });
  });

  it("账本别的错误：500，不泄露内部信息", async () => {
    ledger.failWith = new Error("SQLITE_BUSY: secret internals");
    const res = await call("POST", "/api/conversations/1/messages", { body: { clientId: "c", text: "hi" } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal_error" });
    expect(res.body).not.toContain("SQLITE");
  });
});

describe("停止 POST /api/conversations/:id/stop", () => {
  it("调用 ledger.requestStop，返回 202", async () => {
    const res = await call("POST", "/api/conversations/1/stop");
    expect(res.statusCode).toBe(202);
    expect(ledger.stopped).toEqual([1]);
  });

  it("对话不存在：404", async () => {
    const res = await call("POST", "/api/conversations/99/stop");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "conversation_not_found" });
    expect(ledger.stopped).toEqual([]);
  });

  it("对话编号不是正整数：400", async () => {
    expect((await call("POST", "/api/conversations/abc/stop")).statusCode).toBe(400);
    expect(ledger.stopped).toEqual([]);
  });

  it("账本出错：500", async () => {
    ledger.failWith = new Error("boom");
    expect((await call("POST", "/api/conversations/1/stop")).statusCode).toBe(500);
  });
});

describe("静态文件", () => {
  it("请求 / 返回 index.html", async () => {
    const res = await call("GET", "/", { cookie: null });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toBe(INDEX_HTML);
  });

  it("没登录也能拿到页面（页面要自己加载出来才能在 401 时提示用户）", async () => {
    expect((await call("GET", "/index.html", { cookie: null })).statusCode).toBe(200);
  });

  it("目录外的文件拿不到", async () => {
    const res = await call("GET", "/..%2f..%2fetc/passwd", { cookie: null });
    expect(res.statusCode).not.toBe(200);
  });

  it("不存在的文件：404，JSON", async () => {
    const res = await call("GET", "/nope.js", { cookie: null });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("静态目录不存在：服务照常起，/ 返回 404，API 仍可用", async () => {
    const other = createUiServer({
      ledger: ledger.asLedger(),
      token: TOKEN,
      staticDir: join(staticDir, "missing"),
      port: PORT,
    });
    try {
      const headers = { host: HOST, cookie: COOKIE };
      expect((await other.inject({ method: "GET", url: "/", headers })).statusCode).toBe(404);
      expect((await other.inject({ method: "GET", url: "/api/state", headers })).statusCode).toBe(200);
    } finally {
      await other.close();
    }
  });
});

describe("WebSocket /api/ws", () => {
  async function connect(since?: number | string) {
    const url = since === undefined ? "/api/ws" : `/api/ws?since=${since}`;
    const received: WsServerMessage[] = [];
    const waiters: Array<() => void> = [];
    const ws = await app.injectWS(
      url,
      { headers: { host: HOST, origin: ORIGIN, cookie: COOKIE } },
      {
        onInit: (socket) =>
          socket.on("message", (data: unknown) => {
            received.push(JSON.parse(String(data)) as WsServerMessage);
            for (const w of waiters.splice(0)) w();
          }),
      },
    );
    /** 等到至少收到 n 条（再多等一拍，看有没有多出来的）。 */
    const waitFor = async (n: number) => {
      while (received.length < n) await new Promise<void>((resolve) => waiters.push(resolve));
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    return { ws, received, waitFor, settle };
  }

  it("连上后账本发一条变化，收到 { seq, type, data }", async () => {
    const client = await connect(ledger.currentSeq);
    const change = ledger.emitHealthChange("claude_not_found: x");
    await client.waitFor(1);
    expect(client.received).toEqual([change]);
    expect(client.received[0]).toMatchObject({ seq: ledger.currentSeq, type: "health.updated" });
    client.ws.terminate();
  });

  it("每条变化只推一次，seq 递增", async () => {
    const client = await connect(ledger.currentSeq);
    ledger.emitHealthChange();
    ledger.emitHealthChange();
    ledger.emitHealthChange();
    await client.waitFor(3);
    await client.settle();
    expect(client.received.map((m) => (m as Change).seq)).toEqual([101, 102, 103]);
    client.ws.terminate();
  });

  it("断线补齐：带 since 重连，中间有 3 条变化，收到这 3 条，不多不少", async () => {
    const since = ledger.currentSeq;
    ledger.emitHealthChange("a");
    ledger.emitHealthChange("b");
    ledger.emitHealthChange("c");
    const client = await connect(since);
    await client.waitFor(3);
    await client.settle();
    expect(client.received.map((m) => (m as Change).seq)).toEqual([since + 1, since + 2, since + 3]);
    client.ws.terminate();
  });

  it("补齐之后接着推新的，中间不重复", async () => {
    const since = ledger.currentSeq;
    ledger.emitHealthChange("a");
    const client = await connect(since);
    ledger.emitHealthChange("b");
    await client.waitFor(2);
    await client.settle();
    expect(client.received.map((m) => (m as Change).seq)).toEqual([since + 1, since + 2]);
    client.ws.terminate();
  });

  it("since 等于当前 seq：没有补齐的，什么也不推", async () => {
    const client = await connect(ledger.currentSeq);
    await client.settle();
    expect(client.received).toEqual([]);
    client.ws.terminate();
  });

  it("补不齐：since 比缓冲区最早的还早（被挤出去了）→ resync", async () => {
    // 缓冲区只剩最近 1000 条；since 落在被挤出的范围里
    const since = ledger.currentSeq;
    for (let i = 0; i < 1005; i++) ledger.emitHealthChange();
    const client = await connect(since);
    await client.waitFor(1);
    expect(client.received).toEqual([{ type: "resync" }]);
    client.ws.terminate();
  });

  it("补不齐：since 是上次运行留下的（比本次初始 seq 小）→ resync", async () => {
    const client = await connect(5);
    await client.waitFor(1);
    expect(client.received).toEqual([{ type: "resync" }]);
    client.ws.terminate();
  });

  it("补不齐：since 比当前 seq 还大 → resync", async () => {
    const client = await connect(ledger.currentSeq + 50);
    await client.waitFor(1);
    expect(client.received).toEqual([{ type: "resync" }]);
    client.ws.terminate();
  });

  it.each(["abc", "-1", "1.5", "", "1e3"])("since 不是非负整数（%j）→ resync，不调 changesSince", async (since) => {
    const client = await connect(since);
    await client.waitFor(1);
    expect(client.received).toEqual([{ type: "resync" }]);
    expect(ledger.changesSinceCalls).toEqual([]);
    client.ws.terminate();
  });

  it("不带 since：不补齐，只推之后的新变化", async () => {
    ledger.emitHealthChange("old");
    const client = await connect();
    expect(ledger.changesSinceCalls).toEqual([]);
    const change = ledger.emitHealthChange("new");
    await client.waitFor(1);
    expect(client.received).toEqual([change]);
    client.ws.terminate();
  });

  it("多个连接各收各的", async () => {
    const a = await connect(ledger.currentSeq);
    const b = await connect(ledger.currentSeq);
    ledger.emitHealthChange();
    await a.waitFor(1);
    await b.waitFor(1);
    expect(a.received).toEqual(b.received);
    a.ws.terminate();
    b.ws.terminate();
  });

  it("连接关掉后取消订阅，不留监听者", async () => {
    const client = await connect(ledger.currentSeq);
    expect(ledger.listenerCount).toBe(1);
    client.ws.terminate();
    for (let i = 0; i < 50 && ledger.listenerCount > 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(ledger.listenerCount).toBe(0);
    expect(() => ledger.emitHealthChange()).not.toThrow();
  });

  it("补齐时账本出错：服务端关掉连接（1011）并取消订阅，不崩", async () => {
    ledger.failWith = new Error("boom");
    const closed = new Promise<number>((resolve) => {
      void app.injectWS("/api/ws?since=100", { headers: { host: HOST, origin: ORIGIN, cookie: COOKIE } }, { onInit: (socket) => socket.on("close", resolve) });
    });
    expect(await closed).toBe(1011);
    expect(ledger.listenerCount).toBe(0);
  });
});
