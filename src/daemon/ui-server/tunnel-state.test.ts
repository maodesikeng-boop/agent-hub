// 隧道状态进 /api/state（docs/hub-tunnel-design.md 第 6、10 节）：状态是内部值，网页怎么说由块 E 定。
// 状态变化来自子进程事件：变了就给每条 WebSocket 发 resync，网页重拉 /api/state，不轮询。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_PATHS, PEER_DEVICE_HEADER } from "../../shared/index.ts";
import type { TunnelStatus } from "../../shared/tunnel.ts";
import { TunnelInputError } from "../tunnel/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import type { Db } from "../store/index.ts";
import { FakeLedger } from "./fake-ledger.ts";
import { createUiServer } from "./server.ts";
import { testLogin } from "./test-login.ts";

const PORT = 4000;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let dir: string;
let db: Db;
let app: FastifyInstance;
let cookie: string;
let status: TunnelStatus | null;
let lastConnectedCode: string | null;
let retryCalls: number;
const listeners = new Set<(s: TunnelStatus | null) => void>();
const tunnel = {
  status: () => status,
  onChange: (l: (s: TunnelStatus | null) => void) => {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  connect: async (code: string): Promise<TunnelStatus> => {
    if (!code.startsWith("ahtun1_")) throw new TunnelInputError("连接码格式不对");
    lastConnectedCode = code;
    status = { state: "connecting", since: 10, retryAt: null, detail: null };
    return status;
  },
  retry: () => {
    retryCalls++;
    status = { state: "connecting", since: 20, retryAt: null, detail: null };
  },
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hub-tunnel-state-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html>");
  db = openTestDb();
  cookie = testLogin(db, PORT).cookie();
  status = null;
  lastConnectedCode = null;
  retryCalls = 0;
});
afterEach(async () => {
  await app.close();
  db.close();
  listeners.clear();
  rmSync(dir, { recursive: true, force: true });
});

async function start(withTunnel: boolean) {
  app = createUiServer({
    ledger: new FakeLedger().asLedger(),
    token: "test-token-0123456789abcdef",
    staticDir: dir,
    uploadsDir: join(dir, "uploads"),
    sentFilesDir: join(dir, "sent-files"),
    port: PORT,
    db,
    ...(withTunnel ? { tunnel } : {}),
  });
  await app.ready();
}

const state = async () => (await app.inject({ method: "GET", url: "/api/state", headers: { host: HOST, cookie } })).json() as { tunnel?: unknown };

describe("/api/state 的 tunnel", () => {
  it("没配隧道：不带这个字段", async () => {
    await start(false);
    expect("tunnel" in (await state())).toBe(false);
  });

  it("配了：当前状态原样放进去；还没连过中心是 null", async () => {
    await start(true);
    expect((await state()).tunnel).toBeNull();
    status = { state: "retrying", since: 1, retryAt: 2, detail: "Connection refused" };
    expect((await state()).tunnel).toEqual(status);
  });

  it("状态一变，每条 WebSocket 收到 resync；断开后不再推", async () => {
    await start(true);
    const ws = await app.injectWS("/api/ws", { headers: { host: HOST, origin: ORIGIN, cookie } });
    const received: unknown[] = [];
    ws.on("message", (data: Buffer) => received.push(JSON.parse(data.toString("utf8"))));
    expect(listeners.size).toBe(1);
    status = { state: "connected", since: 3, retryAt: null, detail: null };
    for (const l of listeners) l(status);
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual([{ type: "resync" }]);
    ws.terminate();
    await new Promise((r) => setTimeout(r, 50));
    expect(listeners.size).toBe(0);
  });
});

describe("/api/devices/tunnel/connect 与 /api/devices/tunnel/retry", () => {
  const postHeaders = () => ({ host: HOST, origin: ORIGIN, cookie, "content-type": "application/json" });

  it("没配隧道时回 404", async () => {
    await start(false);
    const res1 = await app.inject({ method: "POST", url: API_PATHS.tunnelConnect, headers: postHeaders(), payload: JSON.stringify({ code: "ahtun1_x" }) });
    expect(res1.statusCode).toBe(404);
    const res2 = await app.inject({ method: "POST", url: API_PATHS.tunnelRetry, headers: postHeaders(), payload: "{}" });
    expect(res2.statusCode).toBe(404);
  });

  it("connect 调 tunnel.connect 并返回 status；TunnelInputError 回 400 中文原因", async () => {
    await start(true);
    const ok = await app.inject({
      method: "POST",
      url: API_PATHS.tunnelConnect,
      headers: postHeaders(),
      payload: JSON.stringify({ code: "ahtun1_abc" }),
    });
    expect(ok.statusCode).toBe(200);
    expect(lastConnectedCode).toBe("ahtun1_abc");
    expect(ok.json()).toEqual({ status: { state: "connecting", since: 10, retryAt: null, detail: null } });

    const bad = await app.inject({
      method: "POST",
      url: API_PATHS.tunnelConnect,
      headers: postHeaders(),
      payload: JSON.stringify({ code: "bad_code" }),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ code: "invalid", error: "连接码格式不对" });
  });

  it("retry 调 tunnel.retry 并返回当前 status", async () => {
    await start(true);
    const res = await app.inject({
      method: "POST",
      url: API_PATHS.tunnelRetry,
      headers: postHeaders(),
      payload: "{}",
    });
    expect(res.statusCode).toBe(200);
    expect(retryCalls).toBe(1);
    expect(res.json()).toEqual({ status: { state: "connecting", since: 20, retryAt: null, detail: null } });
  });

  it("挂在 /api/devices/ 下：设备令牌不可访问", async () => {
    await start(true);
    const res = await app.inject({
      method: "POST",
      url: API_PATHS.tunnelConnect,
      headers: { host: HOST, authorization: "Bearer some-token", [PEER_DEVICE_HEADER]: "00000000-0000-4000-8000-000000000001" },
      payload: JSON.stringify({ code: "ahtun1_abc" }),
    });
    expect(res.statusCode).toBe(401);
  });
});
