// 设备入口（docs/hub-tunnel-design.md 第 4 节，实现块 A）：隧道只接到这里。
// 只认设备令牌（POST /api/peer/pair 凭邀请码），cookie 完全不看；/auth、静态文件、/d/、入口专用接口一律 403；
// 不查 Host、Origin；算“不是本机”，不出 Finder 按钮。连入方听 unix socket（0600），中心听 TCP 127.0.0.1。
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { API_PATHS, PEER_DEVICE_HEADER, serverInfoFor, type StateSnapshot } from "../../shared/index.ts";
import type { PeerRecord } from "../peers/index.ts";
import { startTestDevice, type TestDevice } from "../peers/test-helpers.ts";
import { newPeerToken, sha256Hex } from "../peers/tokens.ts";

/** 已配对的那台（假的，不会真去连它）和它访问本机用的令牌。 */
const token = newPeerToken();
const peer: PeerRecord = {
  id: randomUUID(),
  name: "mac",
  platform: "darwin",
  url: "http://127.0.0.1:9",
  state: "paired",
  since: Date.now(),
  inboundTokenSha256: sha256Hex(token),
  outboundToken: newPeerToken(),
};
const deviceAuth = { authorization: `Bearer ${token}`, [PEER_DEVICE_HEADER]: peer.id };
/** 本机能出 Finder 按钮：看设备入口上它被关掉。 */
const serverInfo = { ...serverInfoFor("darwin"), fileActions: true };

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hub-peer-entry-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function device(peerEntry: { socket?: string; port?: number }): Promise<TestDevice> {
  const d = await startTestDevice({ seed: [peer], serverOptions: { serverInfo }, peerEntry });
  cleanups.push(() => d.close());
  return d;
}

interface Res {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** 发到设备入口上（unix socket 或 TCP 端口）。 */
function send(at: { socketPath: string } | { port: number }, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Res> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        ...("socketPath" in at ? { socketPath: at.socketPath } : { host: "127.0.0.1", port: at.port }),
        method,
        path,
        headers: { ...headers, ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

/** 开 WebSocket：连上了回 "open"，被拒回握手的状态码。 */
function openWs(url: string, headers: Record<string, string>): Promise<"open" | number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("open", () => {
      socket.close();
      resolve("open");
    });
    socket.once("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      socket.terminate();
    });
    socket.once("error", reject);
  });
}

describe.skipIf(process.platform === "win32")("设备入口：unix socket（连入方）", () => {
  async function setup() {
    const socketPath = join(tempDir(), "peer.sock");
    const d = await device({ socket: socketPath });
    /** 浏览器会带的：本机 Host、同源 Origin、已登录的 cookie。 */
    const browser = { host: `127.0.0.1:${d.port}`, origin: d.url, cookie: d.cookie };
    return { d, socketPath, browser, at: { socketPath } };
  }

  it("socket 权限 0600；关掉后文件删掉", async () => {
    const { d, socketPath } = await setup();
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    await d.stop();
    expect(() => statSync(socketPath)).toThrow();
  });

  it("带 cookie 不带设备令牌的 /api/state → 401（cookie 完全不看）", async () => {
    const { at, browser } = await setup();
    const res = await send(at, "GET", API_PATHS.state, browser);
    expect(res.status).toBe(401);
  });

  it("/auth、/、/d/<设备>/api/state、推送订阅、设备管理 → 403（带 cookie、带设备令牌都一样）", async () => {
    const { at, browser } = await setup();
    const cases: Array<[string, string]> = [
      ["GET", "/auth"],
      ["GET", "/auth?token=test-token-0123456789abcdef"],
      ["GET", "/"],
      ["GET", "/index.html"],
      ["GET", `/d/${peer.id}/api/state`],
      ["POST", API_PATHS.pushSubscriptions],
      ["GET", API_PATHS.devices],
      ["POST", API_PATHS.loginLinks],
    ];
    for (const [method, path] of cases) {
      expect([method, path, (await send(at, method, path, browser)).status]).toEqual([method, path, 403]);
      expect([method, path, (await send(at, method, path, deviceAuth)).status]).toEqual([method, path, 403]);
    }
  });

  it("设备令牌 GET /api/state → 200，不查 Host、Origin；算不是本机，不出 Finder 按钮", async () => {
    const { d, at } = await setup();
    const res = await send(at, "GET", API_PATHS.state, { ...deviceAuth, host: "evil.example", origin: "https://evil.example" });
    expect(res.status).toBe(200);
    expect((JSON.parse(res.body) as StateSnapshot).server.fileActions).toBe(false);
    // 对照：同一台的界面端口上，本机浏览器有 Finder 按钮
    const local = (await (await d.browser(API_PATHS.state)).json()) as StateSnapshot;
    expect(local.server.fileActions).toBe(true);
  });

  it("设备令牌改状态的请求不要 Origin", async () => {
    const { d, at } = await setup();
    const res = await send(at, "POST", "/api/conversations/1/stop", { ...deviceAuth, host: "whatever" });
    expect(res.status).toBe(202);
    expect(d.ledger.stopped).toEqual([1]);
  });

  it("认错的设备令牌 → 401 peer_unauthorized", async () => {
    const { at } = await setup();
    const res = await send(at, "GET", API_PATHS.state, { ...deviceAuth, authorization: `Bearer ${newPeerToken()}` });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ code: "peer_unauthorized", error: "这台设备没有配对或已被移除" });
  });

  it("POST /api/peer/pair 不要设备令牌（凭邀请码，邀请码不对由配对自己回）；GET 照样 401", async () => {
    const { at } = await setup();
    const res = await send(at, "POST", API_PATHS.peerPair, { host: "x" }, {});
    expect(res.status).toBe(400);
    expect((await send(at, "GET", API_PATHS.peerPair, { host: "x" })).status).toBe(401);
  });

  it("WebSocket：带 cookie 的 /api/ws 被拒，带设备令牌的能连上", async () => {
    const { at, browser } = await setup();
    const url = `ws+unix://${at.socketPath}:${API_PATHS.ws}`;
    expect(await openWs(url, browser)).toBe(401);
    expect(await openWs(url, deviceAuth)).toBe("open");
  });

  it("界面端口不受影响：cookie 照旧能用，设备令牌照旧不能用 /auth", async () => {
    const { d } = await setup();
    expect((await d.browser(API_PATHS.state)).status).toBe(200);
    expect((await fetch(`${d.url}/auth`, { headers: deviceAuth })).status).toBe(403);
  });
});

describe("设备入口：TCP 127.0.0.1（中心）", () => {
  it("只听 127.0.0.1；设备令牌 200，cookie 401，WebSocket 同样只认设备令牌", async () => {
    const d = await device({ port: 0 });
    const port = d.server.peerEntryPort;
    expect(port).toBeGreaterThan(0);
    expect(port).not.toBe(d.port);
    const at = { port: port! };
    const browser = { host: `127.0.0.1:${d.port}`, origin: d.url, cookie: d.cookie };
    expect((await send(at, "GET", API_PATHS.state, deviceAuth)).status).toBe(200);
    expect((await send(at, "GET", API_PATHS.state, browser)).status).toBe(401);
    expect((await send(at, "GET", "/auth", browser)).status).toBe(403);
    const url = `ws://127.0.0.1:${port}${API_PATHS.ws}`;
    expect(await openWs(url, browser)).toBe(401);
    expect(await openWs(url, deviceAuth)).toBe("open");
  });
});

describe("认错设备令牌的 401 也带 no-store", () => {
  const wrongAuth = { authorization: `Bearer ${newPeerToken()}`, [PEER_DEVICE_HEADER]: peer.id };

  it("设备入口（unix socket 和 TCP）", async () => {
    const socketPath = join(tempDir(), "peer.sock");
    await device({ socket: socketPath });
    const socketRes = await send({ socketPath }, "GET", API_PATHS.state, wrongAuth);
    expect(socketRes.status).toBe(401);
    expect(socketRes.headers["cache-control"]).toBe("no-store");
    const byPort = await device({ port: 0 });
    const portRes = await send({ port: byPort.server.peerEntryPort ?? 0 }, "GET", API_PATHS.state, wrongAuth);
    expect(portRes.status).toBe(401);
    expect(portRes.headers["cache-control"]).toBe("no-store");
  });

  it("界面端口", async () => {
    const d = await device({ port: 0 });
    const res = await send({ port: d.port }, "GET", API_PATHS.state, { ...wrongAuth, host: `127.0.0.1:${d.port}` });
    expect(res.status).toBe(401);
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe.skipIf(process.platform === "win32")("旁路 socket 和 hub.sock 走同一套准备", () => {
  /** run/ 事先是 0755，peer.sock 放在里面。 */
  function runDir0755(): { runDir: string; socket: string } {
    const runDir = join(tempDir(), "run");
    mkdirSync(runDir, { mode: 0o755 });
    chmodSync(runDir, 0o755);
    return { runDir, socket: join(runDir, "peer.sock") };
  }

  it("run/ 事先是 0755：启动后 run/ 是 0700、peer.sock 是 0600", async () => {
    const { runDir, socket } = runDir0755();
    await device({ socket });
    expect(statSync(runDir).mode & 0o777).toBe(0o700);
    expect(statSync(socket).mode & 0o777).toBe(0o600);
  });

  it("peer.sock 上已有活的监听者：拒绝启动，不动它", async () => {
    const { socket } = runDir0755();
    const other = createServer((s) => s.end());
    await new Promise<void>((resolve) => other.listen(socket, resolve));
    cleanups.push(() => new Promise<void>((resolve) => other.close(() => resolve())));
    await expect(startTestDevice({ seed: [peer], peerEntry: { socket } })).rejects.toThrow(/已有守护进程在跑/);
    expect(lstatSync(socket).isSocket()).toBe(true);
  });

  it("peer.sock 是残留的死 socket：删掉后正常启动", async () => {
    const { socket } = runDir0755();
    // 另一个进程 listen 之后不 close 直接退出：socket 文件留在盘上，没人监听
    const child = spawnSync(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(socket)}, () => process.exit(0))`], { encoding: "utf8" });
    expect(child.status).toBe(0);
    expect(lstatSync(socket).isSocket()).toBe(true);
    await device({ socket });
    expect((await send({ socketPath: socket }, "GET", API_PATHS.state, deviceAuth)).status).toBe(200);
  });
});

describe.skipIf(process.platform === "win32")("设备入口同时听 socket 与 TCP 端口（Linux 既可做中心也可做连入方）", () => {
  it("传 { socket, port } 时两边都听且都按设备入口规则走，关闭后两边都停", async () => {
    const socketPath = join(tempDir(), "peer.sock");
    const d = await device({ socket: socketPath, port: 0 });
    const port = d.server.peerEntryPort;
    expect(port).toBeGreaterThan(0);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect((await send({ socketPath }, "GET", API_PATHS.state, deviceAuth)).status).toBe(200);
    expect((await send({ port: port! }, "GET", API_PATHS.state, deviceAuth)).status).toBe(200);
    await d.stop();
    expect(() => statSync(socketPath)).toThrow();
  });
});

describe("默认不开", () => {
  it("不给 peerEntry：没有设备入口", async () => {
    const d = await startTestDevice({ seed: [peer] });
    cleanups.push(() => d.close());
    expect(d.server.peerEntryPort).toBeUndefined();
  });
});
