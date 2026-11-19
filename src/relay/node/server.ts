// 自建中继（docs/account-mesh-design.md「中继」）：Node 外壳，逻辑全在 relay/core.ts。
// HTTP 和 WebSocket 用已有的 fastify + @fastify/websocket（ws），账号数据存 node:sqlite。可以直接听公网端口，也可以放在 Caddy / nginx 后面。
// 不变量：每个账号一个 RelayAccountRoom，按需建、所有连接断开且空闲后丢掉（设备表在库里）；数据通道的内容不写日志、不落盘。
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyRequest } from "fastify";
import { LRUCache } from "lru-cache";
import { DatabaseSync } from "node:sqlite";
import type { RawData, WebSocket } from "ws";
import {
  RELAY_CHANNEL_HIGH_WATER_BYTES,
  RELAY_CONCURRENT_SOCKETS_PER_IP,
  RELAY_IP_LIMITER_MAX,
  RELAY_MAX_DATA_FRAME_BYTES,
  RELAY_REGISTER_PER_IP_PER_MINUTE,
  RELAY_SWEEP_MS,
  RELAY_UPGRADES_PER_IP_PER_MINUTE,
} from "../../shared/limits.ts";
import { isDeviceId } from "../../shared/api.ts";
import { parseAccountId, type AccountId } from "../../shared/mesh.ts";
import { accountIdOf, verifyGithubToken } from "../auth.ts";
import { createRelayAccountRoom, type RelayAccountRecord, type RelayAccountRoom, type RelayAccountStorage, type RelaySocket } from "../core.ts";
import { isRelayToken, parseRelayRegisterRequest, type RelayErrorCode } from "../protocol.ts";

export interface NodeRelayOptions {
  /** 0 表示随便挑一个空端口（测试用）。 */
  port: number;
  host?: string;
  /** 账号数据库文件（node:sqlite）。 */
  dbFile: string;
  /** 对外的 origin（https://…），签名消息里要用；放在反代后面时填反代的地址。不给按实际听的地址（测试用）。 */
  publicOrigin?: string;
  /** 放在反代后面时打开，按 X-Forwarded-For 算登记限流的 IP。 */
  trustProxy?: boolean;
  /** 调试开关：每条数据帧只打印长度和前 8 个字节的十六进制（验证 TLS 记录头，不打印正文）。 */
  debugFrames?: boolean;
  /** 测试观察中继收到的原始密文帧。 */
  onDataFrame?: (bytes: Uint8Array) => void;
  /** 测试换成假的 GitHub。 */
  fetch?: typeof fetch;
  githubApiOrigin?: string;
  now?: () => number;
  log?: (line: string) => void;
}

export interface RunningNodeRelay {
  port: number;
  close(): Promise<void>;
}

const REGISTER_ERROR_STATUS: Record<RelayErrorCode, number> = {
  bad_frame: 400,
  unauthorized: 401,
  unknown_device: 404,
  not_active: 403,
  too_many_devices: 409,
  rate_limited: 429,
  quota_exceeded: 429,
  offline: 409,
  removed: 410,
};
/** 关数据通道、拒绝握手时用的 WebSocket 关闭码。 */
const WS_CLOSE_POLICY = 1008;

function sqliteStorage(db: DatabaseSync, accountId: AccountId, isOpen: () => boolean): RelayAccountStorage {
  return {
    async load() {
      if (!isOpen()) return null;
      const row = db.prepare("SELECT record FROM accounts WHERE account_id = ?").get(accountId) as { record: string } | undefined;
      return row === undefined ? null : (JSON.parse(row.record) as RelayAccountRecord);
    },
    async save(record) {
      if (!isOpen()) return;
      db.prepare("INSERT INTO accounts (account_id, record) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET record = excluded.record").run(accountId, JSON.stringify(record));
    },
  };
}

const toBytes = (data: RawData): Uint8Array =>
  Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;

/** 后置：开始监听；POST /v1/register、控制连接、数据通道都按 relay/protocol.ts 的 RELAY_PATHS；close 后所有连接关掉、端口释放。 */
export async function startNodeRelay(options: NodeRelayOptions): Promise<RunningNodeRelay> {
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const db = new DatabaseSync(options.dbFile);
  let open = true;
  db.exec("CREATE TABLE IF NOT EXISTS accounts (account_id TEXT PRIMARY KEY, record TEXT NOT NULL)");
  let relayOrigin = options.publicOrigin === undefined ? "" : new URL(options.publicOrigin).origin;
  const rooms = new Map<AccountId, { room: RelayAccountRoom; sockets: Set<WebSocket> }>();
  const registerHits = new LRUCache<string, { windowStart: number; count: number }>({ max: RELAY_IP_LIMITER_MAX });
  const upgradeHits = new LRUCache<string, { windowStart: number; count: number }>({ max: RELAY_IP_LIMITER_MAX });
  const activeSocketsByIp = new LRUCache<string, number>({ max: RELAY_IP_LIMITER_MAX });

  const roomFor = (accountId: AccountId) => {
    let entry = rooms.get(accountId);
    if (entry === undefined) {
      entry = { room: createRelayAccountRoom({ accountId, relayOrigin, storage: sqliteStorage(db, accountId, () => open), now }), sockets: new Set() };
      rooms.set(accountId, entry);
    }
    return entry;
  };
  const track = (accountId: AccountId, socket: WebSocket) => {
    const entry = roomFor(accountId);
    entry.sockets.add(socket);
    socket.once("close", () => entry.sockets.delete(socket));
    return entry.room;
  };

  const allowRegister = (ip: string) => {
    const t = now();
    const hit = registerHits.get(ip);
    if (hit === undefined || t - hit.windowStart >= 60_000) {
      registerHits.set(ip, { windowStart: t, count: 1 });
      return true;
    }
    hit.count++;
    return hit.count <= RELAY_REGISTER_PER_IP_PER_MINUTE;
  };

  const allowUpgrade = (ip: string) => {
    if ((activeSocketsByIp.get(ip) ?? 0) >= RELAY_CONCURRENT_SOCKETS_PER_IP) return false;
    const t = now();
    const hit = upgradeHits.get(ip);
    if (hit === undefined || t - hit.windowStart >= 60_000) {
      upgradeHits.set(ip, { windowStart: t, count: 1 });
      return true;
    }
    hit.count++;
    return hit.count <= RELAY_UPGRADES_PER_IP_PER_MINUTE;
  };

  const trackIpSocket = (ip: string, socket: WebSocket) => {
    activeSocketsByIp.set(ip, (activeSocketsByIp.get(ip) ?? 0) + 1);
    socket.once("close", () => {
      const rest = (activeSocketsByIp.get(ip) ?? 1) - 1;
      if (rest <= 0) activeSocketsByIp.delete(ip);
      else activeSocketsByIp.set(ip, rest);
    });
  };

  const app = Fastify({ logger: false, trustProxy: options.trustProxy ?? false, bodyLimit: 64 * 1024 });
  await app.register(fastifyWebsocket, { options: { maxPayload: RELAY_MAX_DATA_FRAME_BYTES, perMessageDeflate: false } });

  app.post("/v1/register", async (req, reply) => {
    if (!allowRegister(req.ip)) return reply.code(429).send({ error: "rate_limited" });
    const request = parseRelayRegisterRequest(req.body);
    if (request === null) return reply.code(400).send({ error: "bad_frame" });
    let login;
    try {
      login = await verifyGithubToken(request.token, { ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.githubApiOrigin ? { apiOrigin: options.githubApiOrigin } : {}) });
    } catch {
      return reply.code(502).send({ error: "github_unreachable" });
    }
    if (login === null) return reply.code(401).send({ error: "unauthorized" });
    const accountId = await accountIdOf(login);
    const result = await roomFor(accountId).room.register(login, request);
    if ("error" in result) return reply.code(REGISTER_ERROR_STATUS[result.error]).send({ error: result.error });
    log(`登记：账号 ${accountId} 设备 ${request.device.id}（${result.state}）`);
    return result;
  });

  const accountParam = (req: FastifyRequest) => parseAccountId((req.params as { account?: unknown }).account);

  app.get(
    "/v1/accounts/:account/control",
    {
      websocket: true,
      preHandler: async (req, reply) => {
        if (!allowUpgrade(req.ip)) return reply.code(429).send({ error: "rate_limited" });
      },
    },
    (socket, req) => {
      const accountId = accountParam(req);
      if (accountId === null) return socket.close(WS_CLOSE_POLICY, "bad_frame");
      trackIpSocket(req.ip, socket);
      const room = track(accountId, socket);
      const handle = room.openControl({ send: (data) => socket.send(data), close: (code, reason) => socket.close(code, reason) });
      socket.on("message", (data, isBinary) => {
        if (isBinary) return socket.close(WS_CLOSE_POLICY, "bad_frame");
        void handle.receive(Buffer.from(toBytes(data)).toString("utf8"));
      });
      socket.once("close", () => handle.closed());
    },
  );

  /** 数据通道两端：一端发得快、另一端收得慢时先停读快的那端，等慢的那端写空再接着读。 */
  const channelEnds = new Map<string, Set<WebSocket>>();
  app.get(
    "/v1/accounts/:account/channels/:channel",
    {
      websocket: true,
      preHandler: async (req, reply) => {
        if (!allowUpgrade(req.ip)) return reply.code(429).send({ error: "rate_limited" });
      },
    },
    (socket, req) => {
      const accountId = accountParam(req);
      const channel = String((req.params as { channel?: unknown }).channel ?? "");
      const query = req.query as { device?: unknown; session?: unknown };
      const device = typeof query.device === "string" ? query.device : "";
      const session = typeof query.session === "string" ? query.session : "";
      if (accountId === null || !isRelayToken(channel) || !isDeviceId(device) || !isRelayToken(session)) return socket.close(WS_CLOSE_POLICY, "bad_frame");
      trackIpSocket(req.ip, socket);
      const room = track(accountId, socket);
    const ends = channelEnds.get(channel) ?? new Set<WebSocket>();
    const relaySocket: RelaySocket = {
      send: (data) => {
        socket.send(data);
        if (socket.bufferedAmount > RELAY_CHANNEL_HIGH_WATER_BYTES) {
          const others = [...ends].filter((s) => s !== socket);
          for (const other of others) other.pause();
          (socket as unknown as { _socket: NodeJS.EventEmitter })._socket.once("drain", () => {
            for (const other of others) other.resume();
          });
        }
      },
      close: (code, reason) => socket.close(code, reason),
    };
    const handle = room.openChannel({ channel, device, session }, relaySocket);
    if ("error" in handle) return socket.close(WS_CLOSE_POLICY, handle.error);
    ends.add(socket);
    channelEnds.set(channel, ends);
    socket.on("message", (data, isBinary) => {
      if (!isBinary) return socket.close(WS_CLOSE_POLICY, "bad_frame");
      const bytes = toBytes(data);
      if (options.debugFrames) {
        const head = Buffer.from(bytes.subarray(0, 8)).toString("hex").match(/.{1,2}/g)?.join(" ") ?? "";
        log(`数据帧 ${bytes.byteLength}B 头8B: ${head}`);
      }
      options.onDataFrame?.(bytes);
      handle.receive(bytes);
    });
      socket.once("close", () => {
        ends.delete(socket);
        if (ends.size === 0) channelEnds.delete(channel);
        handle.closed();
      });
    },
  );

  const sweeper = setInterval(() => {
    for (const [accountId, entry] of rooms) {
      void entry.room.sweep();
      if (entry.sockets.size === 0) rooms.delete(accountId);
    }
  }, RELAY_SWEEP_MS);
  sweeper.unref();

  await app.listen({ port: options.port, host: options.host ?? "127.0.0.1" });
  const address = app.server.address();
  const port = address !== null && typeof address === "object" ? address.port : options.port;
  if (relayOrigin === "") relayOrigin = `http://${options.host ?? "127.0.0.1"}:${port}`;
  log(`中继在听 ${options.host ?? "127.0.0.1"}:${port}，对外地址 ${relayOrigin}`);

  return {
    port,
    async close() {
      clearInterval(sweeper);
      for (const entry of rooms.values()) for (const socket of entry.sockets) socket.terminate();
      await app.close();
      open = false;
      db.close();
    },
  };
}
