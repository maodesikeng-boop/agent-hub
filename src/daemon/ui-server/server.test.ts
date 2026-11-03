import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LEDGER_ERROR_CODES,
  LedgerRequestError,
  MAX_DESCRIPTION_CHARS,
  MAX_MESSAGE_BYTES,
  MAX_MODEL_CHARS,
  MAX_NAME_CHARS,
  MAX_PATH_BYTES,
  MAX_PERSONA_BYTES,
  MAX_REASON_CHARS,
  UI_COOKIE_NAME,
  type Change,
  type LedgerErrorCode,
  type WsServerMessage,
} from "../../shared/index.ts";
import { FakeLedger, makeMessage } from "./fake-ledger.ts";
import { createUiServer, startUiServer } from "./server.ts";

const TOKEN = "test-token-0123456789abcdef";
const PORT = 4000;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const COOKIE = `${UI_COOKIE_NAME}=${TOKEN}`;
const INDEX_HTML = "<!doctype html><title>agent-hub</title>";

const NEW_PM = { name: "阿周", mode: "hands_on", defaultModel: "claude-haiku-5-5", persona: "# 性格\n- 简短" };

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
  headers?: Record<string, string>;
}

type Method = "GET" | "POST" | "PUT";

async function call(method: Method, url: string, opts: ReqOpts = {}) {
  const headers: Record<string, string> = { host: opts.host ?? HOST, ...opts.headers };
  const cookie = opts.cookie === undefined ? COOKIE : opts.cookie;
  if (cookie !== null) headers.cookie = cookie;
  const origin = opts.origin === undefined ? (method !== "GET" ? ORIGIN : null) : opts.origin;
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

/** M2 新接口记下的调用总数。 */
const ledgerCalls = () =>
  ledger.createdPms.length +
  ledger.personaReads.length +
  ledger.personaEdits.length +
  ledger.reverted.length +
  ledger.retried.length;

describe("没登录", () => {
  const apiRequests: Array<[Method, string, unknown?]> = [
    ["GET", "/api/state"],
    ["GET", "/api/conversations/1/messages?before=5"],
    ["POST", "/api/conversations/1/messages", { clientId: "c", text: "hi" }],
    ["POST", "/api/conversations/1/stop"],
    ["GET", "/api/ws"],
    ["GET", "/api/no-such-thing"],
    ["POST", "/api/pms", NEW_PM],
    ["GET", "/api/pms/1/persona"],
    ["PUT", "/api/pms/1/persona", { text: "x" }],
    ["POST", "/api/persona-changes/1/revert"],
    ["POST", "/api/messages/1/retry"],
  ];

  it.each(apiRequests)("没 cookie：%s %s 返回 401，不碰账本", async (method, url, body) => {
    const res = await call(method, url, { cookie: null, body, origin: ORIGIN });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
    expect(ledger.posted).toEqual([]);
    expect(ledger.stopped).toEqual([]);
    expect(ledgerCalls()).toEqual(0);
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
      pms: [{ id: 1, name: "项目经理", avatarFile: null, mode: "manage_only", defaultModel: null, personaFile: null, createdAt: 1 }],
      projects: [],
      folders: [],
      conversations: [],
      sessions: [],
      health: [],
    };
    const res = await call("GET", "/api/state");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...ledger.snapshotValue, seq: ledger.currentSeq });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("/api/state 带着 projects 和 folders（M2），原样转给网页", async () => {
    const created = ledger.createPm({ ...NEW_PM, mode: "hands_on", folder: "/code/foo" });
    const project = created.project!;
    const mainFolder = { id: 1, projectId: project.id, path: "/code/foo", isMain: true, addedAt: 1, removedAt: null };
    ledger.snapshotValue = {
      ...ledger.snapshotValue,
      projects: [project],
      folders: [mainFolder, { ...mainFolder, id: 2, path: "/code/shared", isMain: false }],
      conversations: [{ conversation: created.conversation, messages: [], hasMore: false }],
    };
    const body = (await call("GET", "/api/state")).json();
    expect(body.projects).toEqual([project]);
    expect(body.folders).toHaveLength(2);
    expect(body).toEqual({ ...ledger.snapshotValue, seq: ledger.currentSeq });
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

  it("整个请求体超过 1 MB：413，响应是 { error }，没有 code 字段；不调账本", async () => {
    const res = await call("POST", "/api/conversations/1/messages", {
      rawBody: JSON.stringify({ clientId: "c", text: "hi", pad: " ".repeat(1024 * 1024 + 1) }),
    });
    expect(res.statusCode).toBe(413);
    const body = res.json();
    expect(typeof body.error).toBe("string");
    expect(body).not.toHaveProperty("code");
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

// ---- M2 新接口 ----

const NEW_ENDPOINTS: Array<[string, Method, string, unknown?]> = [
  ["POST /api/pms", "POST", "/api/pms", NEW_PM],
  ["PUT persona", "PUT", "/api/pms/1/persona", { text: "新正文" }],
  ["POST revert", "POST", "/api/persona-changes/1/revert"],
  ["POST retry", "POST", "/api/messages/1/retry"],
];

/** 每个新接口都被这三道检查拦：Host、Origin（会改状态的请求都查，包括 PUT）、cookie。 */
describe("新接口的 Host、Origin、cookie 检查", () => {
  it.each(NEW_ENDPOINTS)("%s：Origin 不对、没带、别的端口都是 403，不碰账本", async (_name, method, url, body) => {
    for (const origin of ["http://evil.example.com", "http://127.0.0.1:4001", "null", "", null]) {
      const res = await call(method, url, { origin, body });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "forbidden_origin" });
    }
    expect(ledgerCalls()).toBe(0);
  });

  it.each(NEW_ENDPOINTS)("%s：Host 不对 403，没 cookie 401，Origin 对了也不能代替 cookie", async (_name, method, url, body) => {
    expect((await call(method, url, { host: "evil.com:4000", body })).statusCode).toBe(403);
    const res = await call(method, url, { cookie: null, body });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
    expect(ledgerCalls()).toBe(0);
  });

  it("GET persona：没 cookie 401、Host 不对 403；GET 不查 Origin", async () => {
    expect((await call("GET", "/api/pms/1/persona", { cookie: null })).statusCode).toBe(401);
    expect((await call("GET", "/api/pms/1/persona", { host: "evil.com:4000" })).statusCode).toBe(403);
    expect((await call("GET", "/api/pms/1/persona", { origin: "http://evil.example.com" })).statusCode).toBe(200);
  });

  it.each([
    ["会话令牌当 Bearer", { authorization: "Bearer session-token-0123456789abcdef" }],
    ["界面令牌当 Bearer", { authorization: `Bearer ${TOKEN}` }],
  ])("%s：没有 cookie 时一律 401（会话令牌进不了界面接口）", async (_name, headers) => {
    for (const [, method, url, body] of NEW_ENDPOINTS) {
      expect((await call(method, url, { cookie: null, headers, body })).statusCode).toBe(401);
    }
    expect((await call("GET", "/api/pms/1/persona", { cookie: null, headers })).statusCode).toBe(401);
    expect((await call("GET", "/api/state", { cookie: null, headers })).statusCode).toBe(401);
    expect(ledgerCalls()).toBe(0);
  });
});

/** 账本抛 LedgerRequestError：按 LEDGER_ERROR_HTTP_STATUS 映射，error 是它的 message，code 是它的 code。 */
describe("账本拒绝请求时的 HTTP 状态", () => {
  const STATUS: Record<LedgerErrorCode, number> = { invalid: 400, not_found: 404, forbidden: 403, conflict: 409 };
  const CASES = NEW_ENDPOINTS.flatMap(([name, method, url, body]) =>
    LEDGER_ERROR_CODES.map((code) => [name, code, method, url, body] as const),
  );

  it.each(CASES)("%s：账本抛 %s", async (_name, code, method, url, body) => {
    ledger.failWith = new LedgerRequestError(code, `原因：${code}`);
    const res = await call(method, url, { body });
    expect(res.statusCode).toBe(STATUS[code]);
    expect(res.json()).toEqual({ error: `原因：${code}`, code });
  });

  it("GET persona：四种错误码也一样映射", async () => {
    for (const code of LEDGER_ERROR_CODES) {
      ledger.failWith = new LedgerRequestError(code, `原因：${code}`);
      const res = await call("GET", "/api/pms/1/persona");
      expect(res.statusCode).toBe(STATUS[code]);
      expect(res.json()).toEqual({ error: `原因：${code}`, code });
    }
  });

  it("账本别的错误：500，不泄露内部信息", async () => {
    ledger.failWith = new Error("SQLITE_BUSY: /secret/path");
    for (const [, method, url, body] of NEW_ENDPOINTS) {
      const res = await call(method, url, { body });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: "internal_error" });
    }
  });

  it("老接口抛 LedgerRequestError 也照样映射", async () => {
    ledger.failWith = new LedgerRequestError("conflict", "冲突");
    const res = await call("POST", "/api/conversations/1/messages", { body: { clientId: "c", text: "hi" } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "冲突", code: "conflict" });
  });
});

describe("POST /api/pms 建项目经理", () => {
  it("四个字段都对：调 ledger.createPm，201 返回项目经理编号和私聊编号", async () => {
    const res = await call("POST", "/api/pms", { body: NEW_PM });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ pmId: 7, conversationId: 70 });
    expect(ledger.createdPms).toEqual([NEW_PM]);
  });

  it("主文件夹可选：给了原样交给账本（带 ~ 也不展开，账本解析）", async () => {
    const body = { ...NEW_PM, folder: "~/code/foo" };
    expect((await call("POST", "/api/pms", { body })).statusCode).toBe(201);
    expect(ledger.createdPms).toEqual([body]);
  });

  it("账本抛 invalid（比如文件夹不存在）：400，带原因，原样给用户看", async () => {
    ledger.failWith = new LedgerRequestError("invalid", "文件夹不存在，请先建好：/x");
    const res = await call("POST", "/api/pms", { body: { ...NEW_PM, folder: "/x" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "文件夹不存在，请先建好：/x", code: "invalid" });
  });

  it("defaultModel 不给、给 null、给空串都放行，原样交给账本", async () => {
    const { defaultModel: _omit, ...withoutModel } = NEW_PM;
    for (const body of [withoutModel, { ...NEW_PM, defaultModel: null }, { ...NEW_PM, defaultModel: "" }]) {
      expect((await call("POST", "/api/pms", { body })).statusCode).toBe(201);
    }
    expect(ledger.createdPms).toEqual([withoutModel, { ...NEW_PM, defaultModel: null }, { ...NEW_PM, defaultModel: "" }]);
  });

  it("边界刚好放行：名字 40 个字符、性格设定 32 KB（按字节）、模型名 100 个字符、路径 4096 字节", async () => {
    const body = {
      name: "名".repeat(MAX_NAME_CHARS),
      mode: "manage_only",
      defaultModel: "m".repeat(MAX_MODEL_CHARS),
      persona: "a".repeat(MAX_PERSONA_BYTES),
      folder: "/".padEnd(MAX_PATH_BYTES, "a"),
    };
    expect((await call("POST", "/api/pms", { body })).statusCode).toBe(201);
    expect(ledger.createdPms).toHaveLength(1);
  });

  const persona = "a".repeat(MAX_PERSONA_BYTES);
  const badBodies: Array<[string, unknown]> = [
    ["名字是空串", { ...NEW_PM, name: "" }],
    ["名字全是空白", { ...NEW_PM, name: "   " }],
    ["名字超过 40 个字符", { ...NEW_PM, name: "名".repeat(MAX_NAME_CHARS + 1) }],
    ["名字带换行", { ...NEW_PM, name: "阿\n周" }],
    ["名字带 U+2028", { ...NEW_PM, name: "阿 周" }],
    ["名字不是字符串", { ...NEW_PM, name: 5 }],
    ["没给名字", { mode: "hands_on", persona: "x" }],
    ["mode 不是两种之一", { ...NEW_PM, mode: "default" }],
    ["mode 是空串", { ...NEW_PM, mode: "" }],
    ["没给 mode", { name: "阿周", persona: "x" }],
    ["性格设定超过 32 KB（多 1 字节）", { ...NEW_PM, persona: `${persona}a` }],
    ["性格设定按字节算：中文 10923 个字（32769 字节）", { ...NEW_PM, persona: "字".repeat(10923) }],
    ["性格设定不是字符串", { ...NEW_PM, persona: ["x"] }],
    ["没给性格设定", { name: "阿周", mode: "hands_on" }],
    ["模型名超过 100 个字符", { ...NEW_PM, defaultModel: "m".repeat(MAX_MODEL_CHARS + 1) }],
    ["模型名不是字符串", { ...NEW_PM, defaultModel: 3 }],
    ["路径是空串", { ...NEW_PM, folder: "" }],
    ["路径全是空白", { ...NEW_PM, folder: "  " }],
    ["路径超过 4096 字节", { ...NEW_PM, folder: "/".padEnd(MAX_PATH_BYTES + 1, "a") }],
    ["路径按字节算：中文 1366 个字（4098 字节）", { ...NEW_PM, folder: "字".repeat(1366) }],
    ["路径带 NUL", { ...NEW_PM, folder: "/x\u0000y" }],
    ["路径不是字符串", { ...NEW_PM, folder: 1 }],
    ["多余字段", { ...NEW_PM, avatarFile: "x.png" }],
    ["body 是数组", [NEW_PM]],
    ["body 是 null", null],
    ["body 是字符串", "hi"],
  ];

  it.each(badBodies)("请求体不对：%s → 400，code 是 invalid，不调账本", async (_name, body) => {
    const res = await call("POST", "/api/pms", { rawBody: JSON.stringify(body) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid" });
    expect(typeof res.json().error).toBe("string");
    expect(ledger.createdPms).toEqual([]);
  });

  it("body 不是合法 JSON、没有 body：400，不调账本", async () => {
    expect((await call("POST", "/api/pms", { rawBody: "{oops" })).statusCode).toBe(400);
    expect((await call("POST", "/api/pms")).statusCode).toBe(400);
    expect(ledger.createdPms).toEqual([]);
  });
});

describe("POST /api/projects（11-03 拿掉了单独建项目的入口）", () => {
  it("登录了也是 404，不调账本", async () => {
    const res = await call("POST", "/api/projects", { body: { name: "foo", folder: "/x", pmId: 1 } });
    expect(res.statusCode).toBe(404);
    expect(ledgerCalls()).toBe(0);
  });
});

describe("性格设定 GET、PUT /api/pms/:id/persona 和 POST /api/persona-changes/:id/revert", () => {
  it("GET：把项目经理编号交给账本，原样返回 PersonaView", async () => {
    const res = await call("GET", "/api/pms/3/persona");
    expect(res.statusCode).toBe(200);
    expect(ledger.personaReads).toEqual([3]);
    expect(res.json()).toMatchObject({ pmId: 3, text: "性格设定正文", mode: "manage_only", revertableChangeId: 1 });
    expect(res.json().changes).toHaveLength(1);
  });

  it.each(["abc", "0", "-1", "1.5", "01"])("GET：项目经理编号 %s 不是正整数 → 400", async (id) => {
    expect((await call("GET", `/api/pms/${id}/persona`)).statusCode).toBe(400);
    expect(ledger.personaReads).toEqual([]);
  });

  it("PUT：text、mode、reason 原样交给账本（actor 是用户），返回 { changed: true, persona }", async () => {
    const body = { text: "# 新\n- 用列表", mode: "hands_on", reason: "用户要求" };
    const res = await call("PUT", "/api/pms/3/persona", { body });
    expect(res.statusCode).toBe(200);
    expect(ledger.personaEdits).toEqual([{ pmId: 3, input: body, actor: { kind: "user" } }]);
    expect(res.json()).toMatchObject({ changed: true, persona: { pmId: 3 } });
  });

  it("PUT：只给 text、只给 mode 都行；text 给空串（清空性格设定）也行", async () => {
    for (const body of [{ text: "x" }, { mode: "hands_on" }, { text: "" }]) {
      expect((await call("PUT", "/api/pms/3/persona", { body })).statusCode).toBe(200);
    }
    expect(ledger.personaEdits.map((e) => e.input)).toEqual([{ text: "x" }, { mode: "hands_on" }, { text: "" }]);
  });

  it("PUT：账本说没改动（change 为 null）→ changed 是 false", async () => {
    ledger.personaChange = null;
    const res = await call("PUT", "/api/pms/3/persona", { body: { text: "一样的" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ changed: false, persona: { pmId: 3, changes: [], revertableChangeId: null } });
  });

  it("PUT：边界刚好放行：32 KB、理由 500 个字符", async () => {
    const body = { text: "a".repeat(MAX_PERSONA_BYTES), reason: "理".repeat(MAX_REASON_CHARS) };
    expect((await call("PUT", "/api/pms/3/persona", { body })).statusCode).toBe(200);
  });

  const badPuts: Array<[string, unknown]> = [
    ["什么都没给", {}],
    ["只给了 reason", { reason: "x" }],
    ["text 超过 32 KB", { text: "a".repeat(MAX_PERSONA_BYTES + 1) }],
    ["text 不是字符串", { text: 1 }],
    ["text 是 null", { text: null }],
    ["mode 不对", { mode: "foo" }],
    ["mode 不是字符串", { mode: 1 }],
    ["reason 超过 500 个字符", { text: "x", reason: "理".repeat(MAX_REASON_CHARS + 1) }],
    ["reason 不是字符串", { text: "x", reason: 1 }],
    ["多余字段", { text: "x", pmId: 2 }],
    ["body 是数组", ["x"]],
  ];

  it.each(badPuts)("PUT 请求体不对：%s → 400，code 是 invalid，不调账本", async (_name, body) => {
    const res = await call("PUT", "/api/pms/3/persona", { rawBody: JSON.stringify(body) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid" });
    expect(ledger.personaEdits).toEqual([]);
  });

  it("PUT：没有 body、不是合法 JSON、编号不对 → 400，不调账本", async () => {
    expect((await call("PUT", "/api/pms/3/persona")).statusCode).toBe(400);
    expect((await call("PUT", "/api/pms/3/persona", { rawBody: "{" })).statusCode).toBe(400);
    expect((await call("PUT", "/api/pms/abc/persona", { body: { text: "x" } })).statusCode).toBe(400);
    expect(ledger.personaEdits).toEqual([]);
  });

  it("revert：把修改记录编号交给账本，返回 { changed: true, persona }", async () => {
    const res = await call("POST", "/api/persona-changes/5/revert");
    expect(res.statusCode).toBe(200);
    expect(ledger.reverted).toEqual([5]);
    expect(res.json()).toMatchObject({ changed: true, persona: { revertableChangeId: 1 } });
  });

  it("revert：账本说没改动 → changed 是 false", async () => {
    ledger.personaChange = null;
    expect((await call("POST", "/api/persona-changes/5/revert")).json()).toMatchObject({ changed: false });
  });

  it.each(["abc", "0", "-3", "2.5"])("revert：编号 %s 不是正整数 → 400，不调账本", async (id) => {
    expect((await call("POST", `/api/persona-changes/${id}/revert`)).statusCode).toBe(400);
    expect(ledger.reverted).toEqual([]);
  });

  it("账本说不存在 → 404；不是最近一次 → 409（带原因，界面提示“只能撤销最近一次”）", async () => {
    ledger.failWith = new LedgerRequestError("not_found", "没有这条修改记录");
    expect((await call("POST", "/api/persona-changes/5/revert")).statusCode).toBe(404);
    ledger.failWith = new LedgerRequestError("conflict", "只能撤销最近一次修改");
    const res = await call("POST", "/api/persona-changes/5/revert");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "只能撤销最近一次修改", code: "conflict" });
  });
});

describe("POST /api/messages/:id/retry 重试失败的消息", () => {
  it("调 ledger.retryMessage，202 返回消息编号", async () => {
    const res = await call("POST", "/api/messages/12/retry");
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ messageId: 12 });
    expect(ledger.retried).toEqual([12]);
  });

  it.each(["abc", "0", "-1", "1.5", "007"])("消息编号 %s 不是正整数 → 400，不调账本", async (id) => {
    const res = await call("POST", `/api/messages/${id}/retry`);
    expect(res.statusCode).toBe(400);
    expect(ledger.retried).toEqual([]);
  });

  it("消息不存在 → 404，不是失败状态 → 409，都带账本的原因", async () => {
    ledger.failWith = new LedgerRequestError("not_found", "没有这条消息");
    expect((await call("POST", "/api/messages/12/retry")).json()).toEqual({ error: "没有这条消息", code: "not_found" });
    ledger.failWith = new LedgerRequestError("conflict", "只有失败的消息能重试");
    const res = await call("POST", "/api/messages/12/retry");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "只有失败的消息能重试", code: "conflict" });
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

  /** M2 新增的 6 种变化，各造一条。 */
  function m2Changes(): Array<() => Change> {
    const created = ledger.createPm({ ...NEW_PM, mode: "hands_on", folder: "/code/foo" });
    const { pm } = created;
    const project = created.project!;
    const mainFolder = { id: 1, projectId: project.id, path: "/code/foo", isMain: true, addedAt: 1, removedAt: null };
    const session = { sessionId: 700, conversationId: 70, pmId: 7, generation: 1, status: "idle", activity: "idle", currentTool: null, rateLimit: null, lastEventAt: null } as const;
    return [
      () => ledger.emitChange("pm.created", { pm }),
      () => ledger.emitChange("pm.updated", { pm: { ...pm, mode: "manage_only" } }),
      () => ledger.emitChange("project.created", { project }),
      () => ledger.emitChange("folders.updated", { projectId: project.id, folders: [mainFolder] }),
      () => ledger.emitChange("conversation.created", { conversation: created.conversation }),
      () => ledger.emitChange("session.created", { session }),
    ];
  }

  it("M2 的 6 种新变化：实时推给网页，原样 { seq, type, data }", async () => {
    const client = await connect(ledger.currentSeq);
    const emitted = m2Changes().map((emit) => emit());
    await client.waitFor(6);
    await client.settle();
    expect(client.received).toEqual(emitted);
    expect(emitted.map((c) => c.type)).toEqual([
      "pm.created",
      "pm.updated",
      "project.created",
      "folders.updated",
      "conversation.created",
      "session.created",
    ]);
    client.ws.terminate();
  });

  it("M2 的新变化断线补齐里也有：带 since 重连，不多不少", async () => {
    const since = ledger.currentSeq;
    const emitted = m2Changes().map((emit) => emit());
    const client = await connect(since);
    await client.waitFor(6);
    await client.settle();
    expect(client.received).toEqual(emitted);
    client.ws.terminate();
  });
});
