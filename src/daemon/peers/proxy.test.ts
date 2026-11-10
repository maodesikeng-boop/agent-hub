// 联机 P2：入口转发 /d/<设备>/api/*（docs/multi-device-design.md 第 10 节“转发”）。
// HTTP 用一个假的上游（记下收到了什么、按用例回）；WebSocket 用两台真的设备（假账本推变化）。
import { createHash, randomUUID } from "node:crypto";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { API_PATHS, DEVICE_OFFLINE_REASON, DEVICE_OFFLINE_WS_CLOSE_CODE, PEER_DEVICE_HEADER, WS_HEARTBEAT_TEXT, type WsServerMessage } from "../../shared/index.ts";
import { acceptsGzip, splitProxyUrl } from "./proxy.ts";
import type { PeerRecord } from "./store.ts";
import { pair, settle, sleep, startTestDevice, type TestDevice } from "./test-helpers.ts";
import { newPeerToken, sha256Hex } from "./tokens.ts";

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** 假的上游：记下每个请求，按 respond 回。 */
async function fakeUpstream(respond: (seen: Seen, res: import("node:http").ServerResponse) => void = (_s, res) => res.end("{}")) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const s = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(s);
      respond(s, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

function record(url: string, extra: Partial<PeerRecord> = {}): PeerRecord {
  return { id: randomUUID(), name: "上游", platform: "linux", url, state: "paired", since: Date.now(), inboundTokenSha256: sha256Hex(newPeerToken()), outboundToken: newPeerToken(), ...extra };
}

async function entryWith(peer: PeerRecord, opts: Parameters<typeof startTestDevice>[0] = {}): Promise<TestDevice> {
  const d = await startTestDevice({ ...opts, seed: [peer] });
  cleanups.push(() => d.close());
  return d;
}

/** 原样发一个路径（fetch 会把 ../ 先规范化掉，这里不让它动）。 */
function rawGet(d: TestDevice, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: d.port, path, headers: { cookie: d.cookie } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("splitProxyUrl", () => {
  const id = randomUUID();
  it.each([
    [`/d/${id}/api/state`, `/api/state`],
    [`/d/${id}/api/conversations/7/messages?before=3`, `/api/conversations/7/messages?before=3`],
    [`/d/${id}/api/uploads/u1/%E6%96%87%E4%BB%B6.png`, `/api/uploads/u1/%E6%96%87%E4%BB%B6.png`],
  ])("%s → %s", (url, rest) => expect(splitProxyUrl(url)).toEqual({ device: id, rest }));

  it.each([`/d/${id}`, `/d/${id}/`, `/d/${id}/auth`, `/d/${id}/api/../auth`, `/d/${id}/api/%2e%2e/auth`, `/d/${id}/api/.%2E/auth`, `/d/${id}/api/x/..`, `/d/${id}/api\\..\\auth`, `/d/${id}/x/../api/state`])(
    "拒绝 %s",
    (url) => expect(splitProxyUrl(url)).toBeNull(),
  );
});

describe("HTTP 转发", () => {
  it("方法、路径、查询串、请求体、状态码、响应体原样转", async () => {
    const up = await fakeUpstream((_s, res) => {
      res.statusCode = 409;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "冲突", code: "conflict" }));
    });
    const peer = record(up.url);
    const a = await entryWith(peer);
    const res = await a.browser(`/d/${peer.id}/api/pms/3/persona?x=1`, { method: "PUT", body: { text: "你好" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "冲突", code: "conflict" });
    expect(up.seen).toHaveLength(1);
    expect(up.seen[0]!.method).toBe("PUT");
    expect(up.seen[0]!.url).toBe("/api/pms/3/persona?x=1");
    expect(JSON.parse(up.seen[0]!.body.toString())).toEqual({ text: "你好" });
    expect(up.seen[0]!.headers["content-type"]).toBe("application/json");
  });

  it("去掉浏览器的 cookie、Origin、Referer、Tailscale-* 和 Authorization，换成本机的设备令牌", async () => {
    const up = await fakeUpstream();
    const peer = record(up.url);
    const a = await entryWith(peer);
    const res = await a.browser(`/d/${peer.id}/api/conversations/1/stop`, {
      method: "POST",
      headers: { referer: `${a.url}/`, "tailscale-user-login": "me@example.com", "tailscale-user-name": "Me", "x-forwarded-for": "1.2.3.4", "user-agent": "Safari" },
    });
    expect(res.status, await res.text()).toBe(200);
    const h = up.seen[0]!.headers;
    expect(h.authorization).toBe(`Bearer ${peer.outboundToken}`);
    expect(h[PEER_DEVICE_HEADER]).toBe(a.id);
    for (const name of ["cookie", "origin", "referer", "tailscale-user-login", "tailscale-user-name", "x-forwarded-for"]) expect(h[name], name).toBeUndefined();
    expect(h["user-agent"]).not.toBe("Safari");
    expect(h.host).toBe(new URL(up.url).host);
  });

  it("响应头只放白名单：不放 Set-Cookie、Location；一律加沙箱 CSP 和 nosniff（html 只许不透明来源里跑脚本）", async () => {
    let type = "text/html";
    const up = await fakeUpstream((_s, res) => {
      res.setHeader("content-type", type);
      res.setHeader("set-cookie", "agent_hub_ui=evil; Path=/");
      res.setHeader("location", "/auth?token=x");
      res.setHeader("content-security-policy", "default-src *");
      res.setHeader("content-disposition", "inline; filename=a.html");
      res.statusCode = 200;
      res.end("<script>fetch('/api/state')</script>");
    });
    const peer = record(up.url);
    const a = await entryWith(peer);
    const html = await a.browser(`/d/${peer.id}/api/uploads/u1/a.html?inline=1`);
    expect(html.headers.get("set-cookie")).toBeNull();
    expect(html.headers.get("location")).toBeNull();
    expect(html.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
    expect(html.headers.get("x-content-type-options")).toBe("nosniff");
    expect(html.headers.get("content-disposition")).toBe("inline; filename=a.html");
    type = "image/svg+xml";
    expect((await a.browser(`/d/${peer.id}/api/uploads/u1/a.svg`)).headers.get("content-security-policy")).toBe("sandbox; default-src 'none'; style-src 'unsafe-inline'");
    type = "application/json";
    expect((await a.browser(`/d/${peer.id}/api/state`)).headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
  });

  it("上传 20 MB 原样转过去；Range 下载原样转回来", async () => {
    const up = await fakeUpstream((s, res) => {
      if (s.method === "GET") {
        res.statusCode = 206;
        res.setHeader("content-range", `bytes 0-3/10`);
        res.setHeader("content-type", "video/mp4");
        res.end(`got ${s.headers.range}`);
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ size: s.body.length, sha: createHash("sha256").update(s.body).digest("hex") }));
    });
    const peer = record(up.url);
    const a = await entryWith(peer);
    const file = Buffer.alloc(20 * 1024 * 1024, 7);
    file.write("头", 0);
    const res = await fetch(`${a.url}/d/${peer.id}/api/uploads?name=big.bin`, {
      method: "POST",
      headers: { cookie: a.cookie, origin: a.url, "content-type": "application/octet-stream" },
      body: file,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ size: file.length, sha: createHash("sha256").update(file).digest("hex") });

    const ranged = await fetch(`${a.url}/d/${peer.id}/api/uploads/u1/v.mp4`, { headers: { cookie: a.cookie, range: "bytes=0-3" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe("bytes 0-3/10");
    expect(await ranged.text()).toBe("got bytes=0-3");
  });

  it("对方连不上：502 device_offline", async () => {
    const up = await fakeUpstream();
    const peer = record(up.url);
    await new Promise<void>((resolve) => up.server.close(() => resolve()));
    const a = await entryWith(peer);
    const res = await a.browser(`/d/${peer.id}/api/state`);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("device_offline");
  });

  it("未知设备、不合规的编号、../ 之类的路径：404，不发出去", async () => {
    const up = await fakeUpstream();
    const peer = record(up.url);
    const a = await entryWith(peer);
    for (const path of [
      `/d/${randomUUID()}/api/state`,
      `/d/${peer.id.toUpperCase()}/api/state`,
      `/d/..%2f${peer.id}/api/state`,
      `/d/${peer.id}/api/../auth?token=x`,
      `/d/${peer.id}/api/%2e%2e/auth`,
      `/d/${peer.id}/auth`,
      `/d/http:%2f%2fevil.com/api/state`,
    ]) {
      expect(await rawGet(a, path), path).toBe(404);
    }
    expect(up.seen).toEqual([]);
  });

  it("只转给已配对的设备：待确认的不转", async () => {
    const up = await fakeUpstream();
    const peer = record(up.url, { state: "pending" });
    const a = await entryWith(peer);
    expect((await a.browser(`/d/${peer.id}/api/state`)).status).toBe(404);
    expect(up.seen).toEqual([]);
  });

  it("要浏览器登录；改状态的请求 Origin 要同源", async () => {
    const up = await fakeUpstream();
    const peer = record(up.url);
    const a = await entryWith(peer);
    expect((await fetch(`${a.url}/d/${peer.id}/api/state`)).status).toBe(401);
    const cross = await fetch(`${a.url}/d/${peer.id}/api/conversations/1/stop`, { method: "POST", headers: { cookie: a.cookie, origin: "http://evil.com" } });
    expect(cross.status).toBe(403);
    expect(up.seen).toEqual([]);
  });

  it("对方回 401 peer_unauthorized（它已经移除了本机）：本机也删掉它，回 404", async () => {
    const up = await fakeUpstream((_s, res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "peer_unauthorized" }));
    });
    const peer = record(up.url);
    const a = await entryWith(peer);
    const res = await a.browser(`/d/${peer.id}/api/state`);
    expect(res.status).toBe(404);
    expect(a.records()).toEqual([]);
  });

  it("acceptsGzip：识别 gzip、x-gzip、q 权重与 * 通配", () => {
    expect(acceptsGzip(undefined)).toBe(false);
    expect(acceptsGzip("identity")).toBe(false);
    expect(acceptsGzip("deflate, br")).toBe(false);
    expect(acceptsGzip("gzip, deflate, br")).toBe(true);
    expect(acceptsGzip("x-gzip;q=0.5")).toBe(true);
    expect(acceptsGzip("gzip;q=0, identity;q=1")).toBe(false);
    expect(acceptsGzip("gzip;q=0, *;q=1")).toBe(false);
    expect(acceptsGzip("*;q=0.8")).toBe(true);
    expect(acceptsGzip("*;q=0")).toBe(false);
  });

  it("跨设备转发支持 gzip：客户端支持 gzip 时向上游传 accept-encoding: gzip，下游收到 gzip 压缩流与沙箱头", async () => {
    const bigPayload = JSON.stringify({ seq: 42, text: "跨设备状态快照压缩测试-".repeat(500) });
    const up = await fakeUpstream((s, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      if (s.headers["accept-encoding"] === "gzip") {
        const gz = gzipSync(Buffer.from(bigPayload, "utf8"));
        res.setHeader("content-encoding", "gzip");
        res.setHeader("content-length", String(gz.length));
        res.end(gz);
      } else {
        res.end(bigPayload);
      }
    });
    const peer = record(up.url);
    const a = await entryWith(peer);

    const rawWire = await new Promise<{ statusCode: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: a.port,
          path: `/d/${peer.id}/api/state`,
          headers: { host: `127.0.0.1:${a.port}`, cookie: a.cookie, "accept-encoding": "gzip" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ statusCode: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(up.seen[0]!.headers["accept-encoding"]).toBe("gzip");
    expect(rawWire.statusCode).toBe(200);
    expect(rawWire.headers["content-encoding"]).toBe("gzip");
    expect(rawWire.headers.vary).toContain("Accept-Encoding");
    expect(rawWire.headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
    expect(rawWire.headers["x-content-type-options"]).toBe("nosniff");
    expect(rawWire.body.length).toBeLessThan(Buffer.byteLength(bigPayload, "utf8") / 5);
    expect(gunzipSync(rawWire.body).toString("utf8")).toBe(bigPayload);
  });
});

describe("转发到真的设备", () => {
  it("没有请求体的 POST、DELETE，带 JSON 的 POST：对方照常处理", async () => {
    const a = await startTestDevice();
    const b = await startTestDevice();
    cleanups.push(() => a.close(), () => b.close());
    await pair(a, b);
    await settle([a, b]);
    expect((await a.browser(`/d/${b.id}${API_PATHS.stop(1)}`, { method: "POST" })).status).toBe(202);
    expect(b.ledger.stopped).toEqual([1]);
    const posted = await a.browser(`/d/${b.id}${API_PATHS.messages(1)}`, { method: "POST", body: { clientId: "c1", text: "你好" } });
    expect(posted.status).toBe(200);
    expect(b.ledger.posted.map((p) => p.text)).toEqual(["你好"]);
    expect((await a.browser(`/d/${b.id}/api/schedules/9`, { method: "DELETE" })).status).toBe(204);
    expect(b.ledger.scheduleCalls).toEqual([{ call: "remove", args: [9] }]);
  });
});

describe("WebSocket 转发", () => {
  async function paired(): Promise<[TestDevice, TestDevice]> {
    const a = await startTestDevice({ name: "a", serverOptions: { peerProxy: { pingMs: 200 } } });
    const b = await startTestDevice({ name: "b" });
    cleanups.push(() => a.close(), () => b.close());
    expect((await pair(a, b)).status).toBe(201);
    await settle([a, b]);
    return [a, b];
  }

  function open(a: TestDevice, path: string, origin = a.url) {
    const socket = new WebSocket(`ws://127.0.0.1:${a.port}${path}`, { headers: { cookie: a.cookie, origin } });
    const messages: WsServerMessage[] = [];
    socket.on("message", (data) => messages.push(JSON.parse(String(data)) as WsServerMessage));
    const closed = new Promise<{ code: number; reason: string }>((resolve) => socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
    const opened = new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
      socket.once("unexpected-response", (req, res) => {
        req.destroy();
        reject(new Error(`HTTP ${res.statusCode}`));
      });
    });
    return { socket, messages, closed, opened };
  }

  it("带 since 转发：先补齐，再收新变化；浏览器关了，对方那条也关", async () => {
    const [a, b] = await paired();
    const first = b.ledger.emitHealthChange("x");
    const ws = open(a, `/d/${b.id}${API_PATHS.ws}?since=${first.seq - 1}`);
    await ws.opened;
    await expect.poll(() => ws.messages.map((m) => (m as { seq?: number }).seq)).toEqual([first.seq]);
    const second = b.ledger.emitHealthChange(null);
    await expect.poll(() => ws.messages.map((m) => (m as { seq?: number }).seq)).toEqual([first.seq, second.seq]);
    expect(b.ledger.listenerCount).toBe(1);
    ws.socket.close(1000);
    await ws.closed;
    await expect.poll(() => b.ledger.listenerCount).toBe(0);
  });

  it("对方关了：浏览器那条也关", async () => {
    const [a, b] = await paired();
    const ws = open(a, `/d/${b.id}${API_PATHS.ws}`);
    await ws.opened;
    await expect.poll(() => b.ledger.listenerCount).toBe(1);
    await b.stop();
    await ws.closed;
  });

  it("对方连不上：握手后马上用 4502 device_offline 关", async () => {
    const [a, b] = await paired();
    await b.stop();
    const ws = open(a, `/d/${b.id}${API_PATHS.ws}`);
    expect(await ws.closed).toEqual({ code: DEVICE_OFFLINE_WS_CLOSE_CODE, reason: DEVICE_OFFLINE_REASON });
  });

  it("对方不回心跳（断网、睡着）：4502 device_offline", async () => {
    // 假上游：握手成功，但不回 pong
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", autoPong: false });
    await new Promise((resolve) => wss.once("listening", resolve));
    cleanups.push(() => new Promise<void>((resolve) => wss.close(() => resolve())));
    const port = (wss.address() as AddressInfo).port;
    const peer = record(`http://127.0.0.1:${port}`);
    const a = await entryWith(peer, { serverOptions: { peerProxy: { pingMs: 100 } } });
    const ws = open(a, `/d/${peer.id}${API_PATHS.ws}`);
    await ws.opened;
    expect(await ws.closed).toEqual({ code: DEVICE_OFFLINE_WS_CLOSE_CODE, reason: DEVICE_OFFLINE_REASON });
    for (const client of wss.clients) client.terminate();
  });

  /** 假上游：握手成功；连上时 onConnection 决定发什么。 */
  async function silentUpstream(onConnection: (socket: WebSocket) => void = () => {}) {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((resolve) => wss.once("listening", resolve));
    wss.on("connection", onConnection);
    cleanups.push(() => new Promise<void>((resolve) => {
      for (const client of wss.clients) client.terminate();
      wss.close(() => resolve());
    }));
    return record(`http://127.0.0.1:${(wss.address() as AddressInfo).port}`);
  }

  it("入口自己给浏览器那条发心跳：对方什么都不发（老版本、没变化）也一样", async () => {
    const peer = await silentUpstream();
    const a = await entryWith(peer, { serverOptions: { peerProxy: { heartbeatMs: 40 } } });
    const frames: string[] = [];
    const ws = open(a, `/d/${peer.id}${API_PATHS.ws}`);
    ws.socket.on("message", (data) => frames.push(String(data)));
    await ws.opened;
    await expect.poll(() => frames.length).toBeGreaterThanOrEqual(2);
    expect(new Set(frames)).toEqual(new Set([WS_HEARTBEAT_TEXT]));
    ws.socket.close();
  });

  it("对方发来的心跳不转（一跳一份），别的照转", async () => {
    const change = { seq: 1, type: "health.updated", data: { health: { key: "x", problem: null } } };
    const peer = await silentUpstream((socket) => {
      socket.send(WS_HEARTBEAT_TEXT);
      socket.send(JSON.stringify(change));
    });
    const a = await entryWith(peer, { serverOptions: { peerProxy: { heartbeatMs: 60_000 } } });
    const frames: string[] = [];
    const ws = open(a, `/d/${peer.id}${API_PATHS.ws}`);
    ws.socket.on("message", (data) => frames.push(String(data)));
    await ws.opened;
    await expect.poll(() => frames.length).toBe(1);
    await sleep(50);
    expect(frames).toEqual([JSON.stringify(change)]);
    ws.socket.close();
  });

  it("握手 Origin 不同源：403（防跨站劫持 WebSocket）；未知设备 404 不升级", async () => {
    const [a, b] = await paired();
    const cross = open(a, `/d/${b.id}${API_PATHS.ws}`, "http://evil.com");
    await expect(cross.opened).rejects.toThrow("HTTP 403");
    const unknown = open(a, `/d/${randomUUID()}${API_PATHS.ws}`);
    await expect(unknown.opened).rejects.toThrow("HTTP 404");
    // 本机的 /api/ws 也一样；被拒的握手连接要断掉（不然关机时一直等它，afterEach 会超时）
    const local = open(a, API_PATHS.ws, "http://evil.com");
    await expect(local.opened).rejects.toThrow("HTTP 403");
  });

  it("退出登录：经入口转发的 WebSocket 也当场关", async () => {
    const [a, b] = await paired();
    const ws = open(a, `/d/${b.id}${API_PATHS.ws}`);
    await ws.opened;
    await sleep(20);
    expect((await a.browser(API_PATHS.logoutAll, { method: "POST" })).status).toBe(204);
    expect((await ws.closed).code).toBe(1008);
  });
});
