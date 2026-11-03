import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HUB_COMMANDS,
  HUB_MAX_BODY_BYTES,
  LedgerRequestError,
  MAX_DESCRIPTION_CHARS,
  MAX_HANDOFF_BYTES,
  MAX_NAME_CHARS,
  MAX_PATH_BYTES,
  MAX_PERSONA_BYTES,
  MAX_REASON_CHARS,
  hubPath,
  type HubArgsMap,
  type HubCommand,
  type HubResponse,
  type SessionTokens,
} from "../../shared/index.ts";
import { MAX_UNIX_SOCKET_PATH_BYTES } from "../../shared/paths.ts";
import { FakeHubLedger } from "./fake-ledger.ts";
import { createAgentApi, startAgentApi, type RunningAgentApi } from "./server.ts";
import { createSessionTokens } from "./tokens.ts";

/** 测试的 socket 放在 /tmp 下，路径短，远低于 macOS 的 103 字节上限。 */
function shortTempDir(): string {
  return mkdtempSync("/tmp/ah-");
}

const VALID_ARGS: { [C in HubCommand]: HubArgsMap[C] } = {
  status: {},
  "pm.list": {},
  "project.create": { name: "foo", folder: "/x", description: "一个项目" },
  "project.attach": { project: "foo", folder: "/y" },
  "project.detach": { project: "foo", folder: "/y" },
  "project.assign": { project: "foo", to: "阿周", handoff: "交接正文" },
  "persona.show": {},
  "persona.edit": { text: "新的性格设定", mode: "hands_on", reason: "用户要求" },
};

describe("agent api over inject", () => {
  let ledger: FakeHubLedger;
  let tokens: SessionTokens;
  let app: FastifyInstance;
  let tokenA: string;
  let tokenB: string;

  beforeEach(async () => {
    ledger = new FakeHubLedger();
    tokens = createSessionTokens();
    tokenA = tokens.issue(11);
    tokenB = tokens.issue(22);
    app = createAgentApi({ ledger, tokens });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const call = (command: string, body: unknown, token: string | null = tokenA, extraHeaders: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url: `/v1/${command}`,
      headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...extraHeaders },
      payload: body as object,
    });

  describe("tokens", () => {
    it("rejects a request without Authorization with 401 and never calls the ledger", async () => {
      const res = await call("status", {}, null);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ ok: false, code: "unauthorized", message: expect.any(String) });
      expect(ledger.calls).toHaveLength(0);
    });

    it("rejects a wrong token with 401", async () => {
      const res = await call("status", {}, "not-a-real-token");
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("unauthorized");
      expect(ledger.calls).toHaveLength(0);
    });

    it("rejects a revoked token with 401", async () => {
      tokens.revoke(11);
      const res = await call("status", {}, tokenA);
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("unauthorized");
      expect(ledger.calls).toHaveLength(0);
    });

    it("rejects other auth schemes and an empty bearer", async () => {
      for (const authorization of [`Basic ${tokenA}`, "Bearer", "Bearer ", `Bearer ${tokenA} extra`, tokenA]) {
        const res = await app.inject({ method: "POST", url: hubPath("status"), headers: { authorization }, payload: {} });
        expect(res.statusCode, authorization).toBe(401);
      }
      expect(ledger.calls).toHaveLength(0);
    });

    it("checks the token before the route and the body (unknown command, oversized body)", async () => {
      expect((await call("nope", {}, null)).statusCode).toBe(401);
      const huge = { text: "x".repeat(HUB_MAX_BODY_BYTES + 10) };
      expect((await call("persona.edit", huge, "bad")).statusCode).toBe(401);
      expect(ledger.calls).toHaveLength(0);
    });
  });

  describe("identity", () => {
    it("passes the session resolved from the token to the ledger", async () => {
      const resA = await call("status", {}, tokenA);
      const resB = await call("status", {}, tokenB);
      expect(resA.statusCode).toBe(200);
      expect(resB.statusCode).toBe(200);
      expect(ledger.calls.map((c) => c.sessionId)).toEqual([11, 22]);
    });

    it("does not accept a self-declared identity in the body", async () => {
      const res = await call("status", { sessionId: 22 }, tokenA);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("invalid");
      expect(ledger.calls).toHaveLength(0);
    });
  });

  describe("commands", () => {
    it.each(HUB_COMMANDS)("routes %s to ledger.hubCall with the body as args", async (command) => {
      const res = await call(command, VALID_ARGS[command]);
      expect(res.statusCode).toBe(200);
      const body = res.json() as HubResponse;
      expect(body).toEqual({ ok: true, text: expect.stringContaining(command), data: expect.anything() });
      expect(ledger.calls).toEqual([{ sessionId: 11, command, args: VALID_ARGS[command] }]);
    });

    it("accepts optional fields being absent", async () => {
      expect((await call("project.create", { name: "foo", folder: "/x" })).statusCode).toBe(200);
      expect((await call("persona.edit", { mode: "manage_only" })).statusCode).toBe(200);
      expect((await call("persona.edit", { text: "只改正文" })).statusCode).toBe(200);
      expect(ledger.calls).toHaveLength(3);
    });

    it("accepts a field exactly at its byte limit", async () => {
      const handoff = "中".repeat(Math.floor(MAX_HANDOFF_BYTES / 3)); // 每个 3 字节
      expect((await call("project.assign", { project: "foo", to: "阿周", handoff })).statusCode).toBe(200);
      const text = "a".repeat(MAX_PERSONA_BYTES);
      expect((await call("persona.edit", { text })).statusCode).toBe(200);
    });
  });

  describe("error mapping", () => {
    it.each([
      ["invalid", 400],
      ["not_found", 404],
      ["forbidden", 403],
      ["conflict", 409],
    ] as const)("maps LedgerRequestError(%s) to %i", async (code, status) => {
      ledger.failWith = new LedgerRequestError(code, `账本说：${code}`);
      const res = await call("project.attach", VALID_ARGS["project.attach"]);
      expect(res.statusCode).toBe(status);
      expect(res.json()).toEqual({ ok: false, code, message: `账本说：${code}` });
    });

    it("reports agent-api health: each 500 counts, one success clears", async () => {
      ledger.failWith = new Error("database is locked");
      for (let i = 0; i < 3; i++) expect((await call("status", {})).statusCode).toBe(500);
      ledger.failWith = null;
      expect((await call("status", {})).statusCode).toBe(200);
      expect(ledger.healthReports).toEqual([
        ["agent-api", "database is locked"],
        ["agent-api", "database is locked"],
        ["agent-api", "database is locked"],
        ["agent-api", null],
      ]);
    });

    it("400/401/403/404/409 neither count as failures nor clear the count", async () => {
      await call("status", {}, null); // 401
      await call("status", { x: 1 }); // 400
      for (const code of ["invalid", "forbidden", "not_found", "conflict"] as const) {
        ledger.failWith = new LedgerRequestError(code, code);
        await call("status", {});
      }
      await app.inject({ method: "POST", url: "/v1/%", payload: {} });
      expect(ledger.healthReports).toEqual([]);
    });

    it("a throwing reportHealth does not change the answer", async () => {
      ledger.healthFailWith = new Error("health store broken");
      ledger.failWith = new Error("database is locked");
      const failed = await call("status", {});
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toEqual({ ok: false, code: "internal", message: "database is locked" });
      ledger.failWith = null;
      const ok = await call("status", {});
      expect(ok.statusCode).toBe(200);
      expect(ok.json().ok).toBe(true);
      expect(ledger.healthReports).toHaveLength(2);
    });

    it("500s and a throwing reportHealth go to the log option (the daemon's log)", async () => {
      const lines: string[] = [];
      const logged = createAgentApi({ ledger, tokens, log: (line) => lines.push(line) });
      ledger.healthFailWith = new Error("health store broken");
      ledger.failWith = new Error("database is locked");
      const res = await logged.inject({
        method: "POST",
        url: "/v1/status",
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {},
      });
      expect(res.statusCode).toBe(500);
      expect(lines).toEqual([expect.stringMatching(/status.*database is locked/), expect.stringContaining("health store broken")]);
      await logged.close();
    });

    it("maps any other ledger error to 500 internal with the original message", async () => {
      ledger.failWith = new Error("database is locked");
      const res = await call("status", {});
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ ok: false, code: "internal", message: "database is locked" });
    });
  });

  describe("request body", () => {
    const expectInvalid = async (res: Awaited<ReturnType<typeof call>>) => {
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ ok: false, code: "invalid", message: expect.any(String) });
      expect(ledger.calls).toHaveLength(0);
    };

    it("unknown command → invalid", async () => {
      await expectInvalid(await call("project.archive", {}));
      await expectInvalid(await call("ticket.create", {}));
    });

    it("wrong method → invalid", async () => {
      await expectInvalid(await app.inject({ method: "GET", url: hubPath("status"), headers: { authorization: `Bearer ${tokenA}` } }));
    });

    it("missing required parameters → invalid", async () => {
      await expectInvalid(await call("project.create", { name: "foo" }));
      await expectInvalid(await call("project.attach", { project: "foo" }));
      await expectInvalid(await call("project.assign", { project: "foo", to: "阿周" }));
      await expectInvalid(await call("persona.edit", {}));
      await expectInvalid(await call("persona.edit", { reason: "只有理由" }));
    });

    it("extra parameters → invalid (not silently dropped)", async () => {
      await expectInvalid(await call("project.create", { name: "foo", folder: "/x", extra: 1 }));
      await expectInvalid(await call("pm.list", { verbose: true }));
    });

    it("wrong types are not coerced → invalid", async () => {
      await expectInvalid(await call("project.create", { name: 123, folder: "/x" }));
      await expectInvalid(await call("persona.edit", { mode: "boss" }));
      await expectInvalid(await call("status", []));
      await expectInvalid(await call("status", "null", tokenA, { "content-type": "application/json" }));
    });

    it("empty required strings → invalid", async () => {
      await expectInvalid(await call("project.create", { name: "", folder: "/x" }));
      await expectInvalid(await call("project.assign", { project: "foo", to: "阿周", handoff: "" }));
    });

    it("fields over their limits → invalid", async () => {
      await expectInvalid(await call("project.create", { name: "n".repeat(MAX_NAME_CHARS + 1), folder: "/x" }));
      await expectInvalid(
        await call("project.create", { name: "foo", folder: "/x", description: "d".repeat(MAX_DESCRIPTION_CHARS + 1) }),
      );
      await expectInvalid(await call("project.attach", { project: "foo", folder: `/${"p".repeat(MAX_PATH_BYTES)}` }));
      await expectInvalid(await call("persona.edit", { mode: "hands_on", reason: "r".repeat(MAX_REASON_CHARS + 1) }));
    });

    it("byte limits count UTF-8 bytes, not characters", async () => {
      // 字符数没超、字节数超了
      const handoff = "中".repeat(Math.floor(MAX_HANDOFF_BYTES / 3) + 1);
      expect(handoff.length).toBeLessThan(MAX_HANDOFF_BYTES);
      await expectInvalid(await call("project.assign", { project: "foo", to: "阿周", handoff }));
      const text = "性".repeat(Math.floor(MAX_PERSONA_BYTES / 3) + 1);
      await expectInvalid(await call("persona.edit", { text }));
      const folder = `/${"路".repeat(Math.floor(MAX_PATH_BYTES / 3) + 1)}`;
      await expectInvalid(await call("project.create", { name: "foo", folder }));
    });

    it("a whole body over HUB_MAX_BODY_BYTES → 400 invalid, not 413", async () => {
      // 字段本身都合法，只在后面补空白把整个请求体撑过上限：挡住它的只能是 bodyLimit，不是字段的长度上限。
      const payload = `${JSON.stringify({ mode: "hands_on" })}${" ".repeat(HUB_MAX_BODY_BYTES)}`;
      const res = await call("persona.edit", payload, tokenA, { "content-type": "application/json" });
      await expectInvalid(res);
      expect(res.json().message).toContain(`请求体不能超过 ${HUB_MAX_BODY_BYTES} 字节`);
      // 同样的请求体不补空白就能过
      expect((await call("persona.edit", { mode: "hands_on" })).statusCode).toBe(200);
    });

    it("path fields must be absolute and free of NUL", async () => {
      for (const folder of ["../../etc", "etc/passwd", "./x", "~/x", "/x\u0000y", "\u0000"]) {
        await expectInvalid(await call("project.create", { name: "foo", folder }));
        await expectInvalid(await call("project.attach", { project: "foo", folder }));
        await expectInvalid(await call("project.detach", { project: "foo", folder }));
      }
    });

    it("names, project and to must be free of NUL and control characters", async () => {
      for (const bad of ["a\u0000b", "a\nb", "a\rb", "a\tb", "\u001b[31m红", "a\u007fb", "a\u0085b", "../../etc\u0000"]) {
        await expectInvalid(await call("project.create", { name: bad, folder: "/x" }));
        await expectInvalid(await call("project.attach", { project: bad, folder: "/x" }));
        await expectInvalid(await call("project.detach", { project: bad, folder: "/x" }));
        await expectInvalid(await call("project.assign", { project: bad, to: "阿周", handoff: "h" }));
        await expectInvalid(await call("project.assign", { project: "foo", to: bad, handoff: "h" }));
      }
    });

    it("multi-line free text (handoff, persona text) may still contain newlines and tabs", async () => {
      expect((await call("project.assign", { project: "foo", to: "阿周", handoff: "第一行\n\t第二行\r\n" })).statusCode).toBe(200);
      expect((await call("persona.edit", { text: "a\nb" })).statusCode).toBe(200);
    });

    it("a malformed URL without a token → 400 invalid in HubResponse shape", async () => {
      for (const url of ["/v1/%", "/v1/%zz", "/%"]) {
        const res = await app.inject({ method: "POST", url, payload: {} });
        expect(res.statusCode, url).toBe(400);
        expect(res.json(), url).toEqual({ ok: false, code: "invalid", message: expect.any(String) });
      }
      expect(ledger.calls).toHaveLength(0);
    });

    it("malformed JSON and non-JSON content types → invalid", async () => {
      await expectInvalid(await call("status", "{not json", tokenA, { "content-type": "application/json" }));
      await expectInvalid(await call("status", "hello", tokenA, { "content-type": "text/plain" }));
      await expectInvalid(await call("status", '{"__proto__":{"x":1}}', tokenA, { "content-type": "application/json" }));
    });
  });
});

describe("startAgentApi on a unix socket", () => {
  let dir: string;
  let running: RunningAgentApi | null;
  let ledger: FakeHubLedger;
  let tokens: SessionTokens;

  beforeEach(() => {
    dir = shortTempDir();
    running = null;
    ledger = new FakeHubLedger();
    tokens = createSessionTokens();
  });

  afterEach(async () => {
    await running?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const paths = () => ({ runDir: join(dir, "run"), hubSock: join(dir, "run", "hub.sock") });

  const post = (socketPath: string, command: HubCommand, body: unknown, token: string) =>
    new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = request(
        {
          socketPath,
          method: "POST",
          path: hubPath(command),
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });

  it("creates run/ as 0700 and hub.sock as 0600, and returns the real path", async () => {
    running = await startAgentApi({ ledger, tokens, ...paths() });
    expect(statSync(paths().runDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(running.socketPath).isSocket()).toBe(true);
    expect(statSync(running.socketPath).mode & 0o777).toBe(0o600);
    expect(running.socketPath).toBe(realpathSync(paths().hubSock));
    // macOS 上 /tmp 是 /private/tmp 的链接：返回的必须是解析过的
    if (process.platform === "darwin") expect(running.socketPath.startsWith("/private/")).toBe(true);
    const res = await post(running.socketPath, "status", {}, tokens.issue(5));
    expect(res).toEqual({ status: 200, body: { ok: true, text: expect.any(String), data: expect.anything() } });
    expect(ledger.calls).toEqual([{ sessionId: 5, command: "status", args: {} }]);
  });

  it("tightens an existing run/ that is too open", async () => {
    mkdirSync(paths().runDir, { mode: 0o755 });
    chmodSync(paths().runDir, 0o755);
    running = await startAgentApi({ ledger, tokens, ...paths() });
    expect(statSync(paths().runDir).mode & 0o777).toBe(0o700);
  });

  it("replaces a stale hub.sock left behind by a dead process", async () => {
    mkdirSync(paths().runDir, { mode: 0o700 });
    // 另一个进程 listen 之后不 close 直接退出：socket 文件留在盘上，没人监听
    const child = spawnSync(
      process.execPath,
      ["-e", `require("node:net").createServer().listen(${JSON.stringify(paths().hubSock)}, () => process.exit(0))`],
      { encoding: "utf8" },
    );
    expect(child.status).toBe(0);
    expect(lstatSync(paths().hubSock).isSocket()).toBe(true);

    running = await startAgentApi({ ledger, tokens, ...paths() });
    const res = await post(running.socketPath, "pm.list", {}, tokens.issue(1));
    expect(res.status).toBe(200);
  });

  it("refuses to delete something at the socket path that is not a socket", async () => {
    mkdirSync(paths().runDir, { mode: 0o700 });
    writeFileSync(paths().hubSock, "not a socket");
    await expect(startAgentApi({ ledger, tokens, ...paths() })).rejects.toThrow(/不是 socket|not a socket/);
    expect(existsSync(paths().hubSock)).toBe(true);
  });

  it("rejects a socket path over the macOS limit before listening, with a clear message", async () => {
    const deep = join(dir, "d".repeat(MAX_UNIX_SOCKET_PATH_BYTES));
    await expect(startAgentApi({ ledger, tokens, runDir: deep, hubSock: join(deep, "hub.sock") })).rejects.toThrow(
      /AGENT_HUB_HOME/,
    );
  });

  it("refuses to start when a live process is already listening on hub.sock, and leaves it alone", async () => {
    const first = await startAgentApi({ ledger, tokens, ...paths() });
    running = first;
    await expect(startAgentApi({ ledger, tokens, ...paths() })).rejects.toThrow(/已有守护进程在跑/);
    // 第一个实例的 socket 还在、还能用
    expect(lstatSync(first.socketPath).isSocket()).toBe(true);
    expect((await post(first.socketPath, "status", {}, tokens.issue(3))).status).toBe(200);
  });

  it("refuses to start when another kind of server is listening on hub.sock", async () => {
    mkdirSync(paths().runDir, { mode: 0o700 });
    const other = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => other.listen(paths().hubSock, resolve));
    try {
      await expect(startAgentApi({ ledger, tokens, ...paths() })).rejects.toThrow(/已有守护进程在跑/);
      expect(lstatSync(paths().hubSock).isSocket()).toBe(true);
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  it("a token revoked while the request body is still arriving → 401, ledger never called", async () => {
    const app = createAgentApi({ ledger, tokens });
    const token = tokens.issue(7);
    let authed!: () => void;
    const passedAuth = new Promise<void>((resolve) => (authed = resolve));
    // 排在认人的钩子后面：走到这里说明令牌已经认过了
    app.addHook("onRequest", async () => authed());
    mkdirSync(paths().runDir, { mode: 0o700 });
    await app.listen({ path: paths().hubSock });
    running = { app, socketPath: paths().hubSock, close: () => app.close() };

    const payload = JSON.stringify({ project: "foo", folder: "/x" });
    const res = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = request(
        {
          socketPath: paths().hubSock,
          method: "POST",
          path: hubPath("project.attach"),
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
        },
        (r) => {
          let data = "";
          r.setEncoding("utf8");
          r.on("data", (chunk: string) => (data += chunk));
          r.on("end", () => resolve({ status: r.statusCode ?? 0, body: JSON.parse(data) }));
        },
      );
      req.on("error", reject);
      req.flushHeaders();
      req.write(payload.slice(0, 5));
      void passedAuth.then(() => {
        tokens.revoke(7);
        req.end(payload.slice(5));
      });
    });
    expect(await res).toEqual({ status: 401, body: { ok: false, code: "unauthorized", message: expect.any(String) } });
    expect(ledger.calls).toHaveLength(0);
  });

  it("close() returns promptly while a half-sent request is hanging", async () => {
    running = await startAgentApi({ ledger, tokens, ...paths() });
    const token = tokens.issue(8);
    const sockets: Socket[] = [];
    // 一个请求头写完、请求体只写了一半；一个连请求头都没写完
    for (const raw of [
      `POST ${hubPath("status")} HTTP/1.1\r\nhost: x\r\nauthorization: Bearer ${token}\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{`,
      `POST ${hubPath("status")} HTTP/1.1\r\nhost: x\r\n`,
    ]) {
      const socket = createConnection(running.socketPath);
      socket.on("error", () => {});
      await new Promise<void>((resolve) => socket.on("connect", resolve));
      socket.write(raw);
      sockets.push(socket);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    const closed = running.close().then(() => "closed" as const);
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 3_000).unref());
    const result = await Promise.race([closed, timeout]);
    for (const socket of sockets) socket.destroy();
    expect(result).toBe("closed");
    expect(Date.now() - started).toBeLessThan(3_000);
    running = null;
    expect(ledger.calls).toHaveLength(0);
  });

  it("removes the socket on close", async () => {
    running = await startAgentApi({ ledger, tokens, ...paths() });
    const socketPath = running.socketPath;
    await running.close();
    running = null;
    expect(existsSync(socketPath)).toBe(false);
  });
});
