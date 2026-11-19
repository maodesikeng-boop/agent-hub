// 转发上传到别的设备（比如跨网慢链路上的远端设备）：等响应头的时限不能把上传请求体的时间也算进去。
// 时限换成 1 秒（vi.mock），不然要等真的 30 秒。
import { randomUUID } from "node:crypto";
import { Agent, createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_PATHS, uiCookieName, type DeviceFingerprint, type DeviceId, type DeviceInfo } from "../../shared/index.ts";
import { migrate, openDatabase } from "../store/index.ts";
import { FakeLedger } from "../ui-server/fake-ledger.ts";
import { startUiServer } from "../ui-server/server.ts";
import { createBrowserSessions } from "../ui-server/sessions.ts";
import type { Peers } from "./service.ts";

const TIMEOUT_MS = vi.hoisted(() => 1_000);
vi.mock("../../shared/index.ts", async (importOriginal) => ({ ...(await importOriginal<object>()), PEER_PROXY_HEADERS_TIMEOUT_MS: TIMEOUT_MS }));

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** 16 KB 背压双工管道连接上游 HTTP 服务：不经过操作系统几 MB 的回环内核缓冲，跨平台确定性触发流式背压。 */
function createPipeAgent(upstream: ReturnType<typeof createServer>): Agent {
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = (() => {
    let clientSide!: Duplex;
    let serverSide!: Duplex;
    let clientNeedsDrain = false;
    let serverNeedsDrain = false;
    clientSide = new Duplex({
      highWaterMark: 16 * 1024,
      read() {
        if (serverNeedsDrain) {
          serverNeedsDrain = false;
          serverSide.emit("wakeup");
        }
      },
      write(chunk: Buffer, _enc, cb) {
        if (serverSide.destroyed) return cb(new Error("closed"));
        if (serverSide.push(chunk)) cb();
        else {
          clientNeedsDrain = true;
          clientSide.once("wakeup", () => cb());
        }
      },
      final(cb) {
        serverSide.push(null);
        cb();
      },
      destroy(err, cb) {
        if (!serverSide.destroyed) serverSide.destroy(err ?? undefined);
        cb(err);
      },
    });
    serverSide = new Duplex({
      highWaterMark: 16 * 1024,
      read() {
        if (clientNeedsDrain) {
          clientNeedsDrain = false;
          clientSide.emit("wakeup");
        }
      },
      write(chunk: Buffer, _enc, cb) {
        if (clientSide.destroyed) return cb(new Error("closed"));
        if (clientSide.push(chunk)) cb();
        else {
          serverNeedsDrain = true;
          serverSide.once("wakeup", () => cb());
        }
      },
      final(cb) {
        clientSide.push(null);
        cb();
      },
      destroy(err, cb) {
        if (!clientSide.destroyed) clientSide.destroy(err ?? undefined);
        cb(err);
      },
    });
    setImmediate(() => upstream.emit("connection", serverSide));
    return clientSide as unknown as ReturnType<Agent["createConnection"]>;
  }) as Agent["createConnection"];
  return agent;
}

/** 慢速上游：每 stepMs 才读一块请求体（上行慢），读完才回响应头；stallAfter 块之后再也不读。 */
function slowPeerHandler(stepMs: number, stallAfter = Infinity) {
  return (req: IncomingMessage, res: ServerResponse) => {
    req.pause();
    let received = 0;
    let chunks = 0;
    let timer: NodeJS.Timeout | null = null;
    const stop = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const pull = () => {
      if (req.destroyed || res.destroyed) return;
      if (chunks >= stallAfter) return;
      timer = setTimeout(() => {
        timer = null;
        if (req.destroyed || res.destroyed) return;
        const chunk = req.read(16 * 1024) as Buffer | null;
        if (chunk !== null) {
          received += chunk.length;
          chunks++;
          pull();
          return;
        }
        if (req.readableEnded) return;
        req.once("readable", pull);
      }, stepMs);
    };
    req.once("end", () => {
      stop();
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ received }));
    });
    req.once("close", stop);
    pull();
  };
}

interface EntryEnv {
  url: string;
  cookie: string;
  peerId: DeviceId;
}

async function entryWith(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<EntryEnv> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hub-proxy-up-")));
  const selfId = randomUUID();
  const peerId = randomUUID();
  const upstream = createServer(handler);
  const agent = createPipeAgent(upstream);
  const selfInfo: DeviceInfo = {
    id: selfId,
    name: "Mac",
    platform: "darwin",
    fingerprint: "a".repeat(64) as DeviceFingerprint,
    self: true,
    online: true,
    link: "local",
  };
  const peerInfo: DeviceInfo = {
    id: peerId,
    name: "东京",
    platform: "linux",
    fingerprint: "b".repeat(64) as DeviceFingerprint,
    self: false,
    online: true,
    link: "relay",
  };
  const peers: Peers = {
    selfId,
    list: () => [selfInfo, peerInfo],
    target: (id) => (id === peerId ? { name: "东京", agent } : null),
    rename: async () => {
      throw new Error("unused");
    },
    renameSelf: () => selfInfo,
    receiveRenamed: () => {},
    remove: async () => {},
    close: () => agent.destroy(),
  };
  const db = openDatabase(":memory:");
  migrate(db);
  const server = await startUiServer({
    ledger: new FakeLedger().asLedger(),
    token: "test-token-0123456789abcdef",
    db,
    port: 0,
    staticDir: join(dir, "no-static"),
    uploadsDir: join(dir, "uploads"),
    sentFilesDir: join(dir, "sent-files"),
    peers,
  });
  const url = `http://127.0.0.1:${server.port}`;
  const session = createBrowserSessions(db).create({ userAgent: "test", entry: `127.0.0.1:${server.port}` });
  const cookie = `${uiCookieName(`127.0.0.1:${server.port}`)}=${session.token}`;
  cleanups.push(async () => {
    peers.close();
    await server.close();
    upstream.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { url, cookie, peerId };
}

const upload = (env: EntryEnv, data: Buffer) =>
  fetch(`${env.url}/d/${env.peerId}${API_PATHS.uploads}?name=clip.mp4`, {
    method: "POST",
    headers: { cookie: env.cookie, origin: env.url, "content-type": "application/octet-stream" },
    body: data,
  });

describe("转发上传到慢链路上的设备", () => {
  it("视频传得比等响应头的时限还久，但一直在传：照常转完，不当成对方离线", async () => {
    const data = Buffer.alloc(2 * 1024 * 1024, 1);
    const started = Date.now();
    const res = await upload(await entryWith(slowPeerHandler(20)), data);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ received: data.length });
    expect(Date.now() - started).toBeGreaterThan(TIMEOUT_MS);
  });

  it("对方没读完请求体就回了 413：回完关掉这条连接", async () => {
    const early413 = (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 413;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "文件太大" }));
    };
    const env = await entryWith(early413);
    const url = new URL(`${env.url}/d/${env.peerId}${API_PATHS.uploads}?name=clip.mp4`);
    // fetch 会在连接被关时报 ECONNRESET 丢掉响应，这里直接用 node:http 读响应头
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(url, { method: "POST", headers: { cookie: env.cookie, origin: env.url, "content-type": "application/octet-stream", "content-length": String(64 * 1024 * 1024) } }, resolve);
      req.on("error", () => {});
      req.once("close", () => reject(new Error("没拿到响应")));
      // 只发一小块：一次写得完，不会在对方关连接后还往外写，触发 RST 冲掉还没读到的响应
      req.write(Buffer.alloc(1024, 1));
    });
    expect(response.statusCode).toBe(413);
    expect(response.headers.connection).toBe("close");
    response.destroy();
  });

  it("请求体传到一半就不动了：过了时限回 502 离线", async () => {
    const res = await upload(await entryWith(slowPeerHandler(10, 2)), Buffer.alloc(2 * 1024 * 1024, 1));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("device_offline");
  });

  it("请求体传完了对方迟迟不回：过了时限回 502 离线", async () => {
    const res = await upload(
      await entryWith((req) => {
        req.resume();
      }),
      Buffer.alloc(1024),
    );
    expect(res.status).toBe(502);
  });
});
