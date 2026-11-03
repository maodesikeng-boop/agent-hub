import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
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
  MAX_UNIX_SOCKET_PATH_BYTES,
  hubPath,
  type HubArgsMap,
  type HubCommand,
  type HubResponse,
  type SessionTokens,
} from "../../shared/index.ts";
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
      const folder = `/${"路".repeat(Math.floor(MAX_PATH_BYTES / 3))}`;
      await expectInvalid(await call("project.create", { name: "foo", folder }));
    });

    it("a whole body over HUB_MAX_BODY_BYTES → 400 invalid, not 413", async () => {
      const res = await call("persona.edit", { text: "x".repeat(HUB_MAX_BODY_BYTES) });
      await expectInvalid(res);
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

  it("removes the socket on close", async () => {
    running = await startAgentApi({ ledger, tokens, ...paths() });
    const socketPath = running.socketPath;
    await running.close();
    running = null;
    expect(existsSync(socketPath)).toBe(false);
  });
});
