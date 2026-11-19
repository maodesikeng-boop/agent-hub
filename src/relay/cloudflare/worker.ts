// Cloudflare 版中继（docs/account-mesh-design.md「中继」）：Worker 收 /v1/register 并把每个账号的连接交给该账号的 Durable Object，
// DO 里放一个 relay/core.ts 的 RelayAccountRoom。WebSocket 一律用休眠 API（acceptWebSocket），协议层 ping 用 setWebSocketAutoResponse 自动回。
// 不变量：
// - Durable Object 只用 SQLite 存储（免费档只开放这种），只存设备表和中心顺序；
// - 不在 DO 里开定时器、不持有出站连接，空闲时能休眠；过期检查放在每条消息之后调 room.sweep()；
// - 没有服务端密钥：wrangler.toml 里只有 GitHub API 地址这类公开配置。
// 实现时加 wrangler.toml 和 Workers 的类型包，把这个文件从根 tsconfig.json 挪到 src/relay/cloudflare/tsconfig.json；下面的接口只是骨架阶段让根类型检查能过的最小形状。
import { isDeviceId } from "../../shared/api.ts";
import {
  RELAY_CONCURRENT_SOCKETS_PER_IP,
  RELAY_IP_LIMITER_MAX,
  RELAY_MAX_CONTROL_FRAME_BYTES,
  RELAY_MAX_DATA_FRAME_BYTES,
  RELAY_REGISTER_PER_IP_PER_MINUTE,
  RELAY_UPGRADES_PER_IP_PER_MINUTE,
} from "../../shared/limits.ts";
import { parseAccountId, type AccountId, type AccountLogin } from "../../shared/mesh.ts";
import { accountIdOf, verifyGithubToken } from "../auth.ts";
import {
  createRelayAccountRoom,
  type RelayAccountRecord,
  type RelayAccountRoom,
  type RelayAccountStorage,
  type RelayChannelHandle,
  type RelayControlAttachment,
  type RelayControlHandle,
  type RelaySocket,
} from "../core.ts";
import { isRelayToken, parseRelayRegisterRequest, type RelayErrorCode, type RelayRegisterRequest } from "../protocol.ts";

export interface CfWebSocket {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface CfSqlStorage {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export interface CfDurableObjectState {
  storage: {
    sql: CfSqlStorage;
  };
  acceptWebSocket(ws: CfWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): CfWebSocket[];
  setWebSocketAutoResponse?(pair: unknown): void;
}

interface CfDurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface RelayWorkerEnv {
  ACCOUNTS: {
    idFromName(name: string): unknown;
    get(id: unknown): CfDurableObjectStub;
  };
  /** 对外的 origin（https://…），签名消息里要用。 */
  PUBLIC_ORIGIN: string;
  GITHUB_API_ORIGIN?: string;
}

const INTERNAL_REGISTER_URL = "https://do.internal/internal/register";
const WS_CLOSE_POLICY = 1008;
const REGISTER_BODY_LIMIT = 64 * 1024;

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

const registerHits = new Map<string, { windowStart: number; count: number }>();
const upgradeHits = new Map<string, { windowStart: number; count: number }>();

function allowIpWindow(hits: Map<string, { windowStart: number; count: number }>, ip: string, now: number, limit: number): boolean {
  const hit = hits.get(ip);
  if (hit !== undefined && now - hit.windowStart < 60_000) {
    hits.delete(ip);
    hit.count++;
    hits.set(ip, hit);
    return hit.count <= limit;
  }
  hits.delete(ip);
  if (hits.size >= RELAY_IP_LIMITER_MAX) {
    const oldest = hits.keys().next().value;
    if (oldest !== undefined) hits.delete(oldest);
  }
  hits.set(ip, { windowStart: now, count: 1 });
  return true;
}

const allowRegisterIp = (ip: string, now: number) => allowIpWindow(registerHits, ip, now, RELAY_REGISTER_PER_IP_PER_MINUTE);
const allowUpgradeIp = (ip: string, now: number) => allowIpWindow(upgradeHits, ip, now, RELAY_UPGRADES_PER_IP_PER_MINUTE);

function clientIpOf(request: Request): string {
  const cfIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cfIp) return cfIp;
  const xff = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  return xff || "local";
}

function publicOriginOf(request: Request, env: Pick<RelayWorkerEnv, "PUBLIC_ORIGIN">): string {
  const configured = env.PUBLIC_ORIGIN.trim();
  return configured !== "" ? new URL(configured).origin : new URL(request.url).origin;
}

function jsonResponse(status: number, body: unknown, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

interface InternalRegisterPayload {
  accountId: AccountId;
  login: AccountLogin;
  request: RelayRegisterRequest;
  relayOrigin: string;
}

type SocketAttachment =
  | { kind: "control"; accountId: AccountId; relayOrigin: string; control: RelayControlAttachment }
  | { kind: "channel"; accountId: AccountId; relayOrigin: string; channel: string };

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function wrapSocket(ws: CfWebSocket): RelaySocket {
  return {
    send(data) {
      try {
        ws.send(typeof data === "string" ? data : toArrayBuffer(data));
      } catch {
        // 对端已断，等 webSocketClose 收尾
      }
    },
    close(code, reason) {
      try {
        ws.close(code, reason);
      } catch {
        // 已经关闭
      }
    },
  };
}

function sqlStorage(sql: CfSqlStorage): RelayAccountStorage {
  let tableReady = false;
  const ensureTable = () => {
    if (tableReady) return;
    sql.exec("CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY CHECK (id = 1), record TEXT NOT NULL)");
    tableReady = true;
  };
  return {
    async load() {
      ensureTable();
      const rows = sql.exec("SELECT record FROM account WHERE id = 1").toArray();
      const raw = rows[0]?.record;
      return typeof raw === "string" ? (JSON.parse(raw) as RelayAccountRecord) : null;
    },
    async save(record) {
      ensureTable();
      sql.exec("INSERT INTO account (id, record) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record", JSON.stringify(record));
    },
  };
}

function parseAccountRoute(pathname: string): { accountId: AccountId; kind: "control" } | { accountId: AccountId; kind: "channel"; channel: string } | null {
  const controlMatch = /^\/v1\/accounts\/([^/]+)\/control$/.exec(pathname);
  if (controlMatch) {
    const accountId = parseAccountId(controlMatch[1]);
    return accountId === null ? null : { accountId, kind: "control" };
  }
  const channelMatch = /^\/v1\/accounts\/([^/]+)\/channels\/([^/]+)$/.exec(pathname);
  if (channelMatch) {
    const accountId = parseAccountId(channelMatch[1]);
    const channel = channelMatch[2]!;
    return accountId === null ? null : { accountId, kind: "channel", channel };
  }
  return null;
}

/**
 * Worker 入口。
 * 后置：POST /v1/register 先验 GitHub token、按账号编号交给对应 DO；/v1/accounts/<账号>/… 的 WebSocket 升级交给该账号的 DO；
 * 别的路径 404；同一 IP 每分钟登记超过 RELAY_REGISTER_PER_IP_PER_MINUTE 次回 429。
 */
export async function handleRelayRequest(request: Request, env: RelayWorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/v1/register") {
    if (!allowRegisterIp(clientIpOf(request), Date.now())) {
      return jsonResponse(429, { error: "rate_limited" });
    }
    let rawText: string;
    try {
      rawText = await request.text();
    } catch {
      return jsonResponse(400, { error: "bad_frame" });
    }
    if (rawText.length > REGISTER_BODY_LIMIT) return jsonResponse(400, { error: "bad_frame" });
    let rawBody: unknown;
    try {
      rawBody = JSON.parse(rawText);
    } catch {
      return jsonResponse(400, { error: "bad_frame" });
    }
    const parsed = parseRelayRegisterRequest(rawBody);
    if (parsed === null) return jsonResponse(400, { error: "bad_frame" });

    let login: AccountLogin | null;
    try {
      login = await verifyGithubToken(parsed.token, env.GITHUB_API_ORIGIN ? { apiOrigin: env.GITHUB_API_ORIGIN } : undefined);
    } catch {
      return jsonResponse(502, { error: "github_unreachable" });
    }
    if (login === null) return jsonResponse(401, { error: "unauthorized" });

    const accountId = await accountIdOf(login);
    const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName(accountId));
    const payload: InternalRegisterPayload = {
      accountId,
      login,
      request: parsed,
      relayOrigin: publicOriginOf(request, env),
    };
    return stub.fetch(
      new Request(INTERNAL_REGISTER_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
  }

  const route = parseAccountRoute(url.pathname);
  if (route !== null) {
    if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse(426, { error: "upgrade_required" }, { upgrade: "websocket" });
    }
    if (!allowUpgradeIp(clientIpOf(request), Date.now())) {
      return jsonResponse(429, { error: "rate_limited" });
    }
    const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName(route.accountId));
    return stub.fetch(request);
  }

  return jsonResponse(404, { error: "not_found" });
}

/** 一个账号一个对象。 */
export class RelayAccountObject {
  private readonly state: CfDurableObjectState;
  private readonly env: RelayWorkerEnv;
  private readonly storage: RelayAccountStorage;
  private room: RelayAccountRoom | null = null;
  private accountId: AccountId | null = null;
  private relayOrigin = "";
  private readonly controls = new Map<CfWebSocket, RelayControlHandle>();
  private readonly channels = new Map<CfWebSocket, RelayChannelHandle>();

  constructor(state: CfDurableObjectState, env: RelayWorkerEnv) {
    this.state = state;
    this.env = env;
    this.storage = sqlStorage(state.storage.sql);
    if (typeof WebSocketRequestResponsePair === "function") {
      state.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair("ping", "pong"));
    }
    this.restoreHibernatedSockets();
  }

  private ensureRoom(accountId: AccountId, relayOrigin: string): RelayAccountRoom {
    if (this.room === null) {
      this.accountId = accountId;
      this.relayOrigin = relayOrigin;
      this.room = createRelayAccountRoom({
        accountId,
        relayOrigin,
        storage: this.storage,
      });
    }
    return this.room;
  }

  private restoreHibernatedSockets(): void {
    for (const ws of this.state.getWebSockets()) {
      const raw = ws.deserializeAttachment() as SocketAttachment | null;
      if (raw === null || typeof raw !== "object" || !("kind" in raw)) continue;
      if (raw.kind === "control") {
        const room = this.ensureRoom(raw.accountId, raw.relayOrigin);
        const handle = room.openControl(wrapSocket(ws), raw.control);
        this.controls.set(ws, handle);
      } else if (raw.kind === "channel") {
        // 数据通道只有内存配对状态，休眠醒来不保留未完成配对，通知客户端重拨
        wrapSocket(ws).close(1001, "hibernated");
      }
    }
  }

  private syncAttachments(): void {
    if (this.accountId === null) return;
    for (const [ws, handle] of this.controls) {
      const att: SocketAttachment = {
        kind: "control",
        accountId: this.accountId,
        relayOrigin: this.relayOrigin,
        control: handle.attachment(),
      };
      ws.serializeAttachment(att);
    }
  }

  /** 后置：控制连接和数据通道用 acceptWebSocket 收下；登记请求交给 room.register。 */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && request.url === INTERNAL_REGISTER_URL) {
      const payload = (await request.json()) as InternalRegisterPayload;
      const room = this.ensureRoom(payload.accountId, payload.relayOrigin);
      const result = await room.register(payload.login, payload.request);
      await room.sweep();
      this.syncAttachments();
      if ("error" in result) {
        return jsonResponse(REGISTER_ERROR_STATUS[result.error], { error: result.error });
      }
      return jsonResponse(200, result);
    }

    const route = parseAccountRoute(url.pathname);
    if (route === null || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse(426, { error: "upgrade_required" }, { upgrade: "websocket" });
    }
    const ipTag = `ip:${clientIpOf(request)}`;
    if (this.state.getWebSockets(ipTag).length >= RELAY_CONCURRENT_SOCKETS_PER_IP) {
      return jsonResponse(429, { error: "rate_limited" });
    }

    const room = this.ensureRoom(route.accountId, publicOriginOf(request, this.env));
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1] as unknown as CfWebSocket;

    if (route.kind === "control") {
      let closedOnOpen = false;
      const socketWrapper = wrapSocket(server);
      this.state.acceptWebSocket(server, ["control", ipTag]);
      const handle = room.openControl({
        send: (data) => socketWrapper.send(data),
        close: (code, reason) => {
          closedOnOpen = true;
          socketWrapper.close(code, reason);
        },
      });
      if (!closedOnOpen) this.controls.set(server, handle);
      this.syncAttachments();
      await room.sweep();
      return new Response(null, { status: 101, webSocket: client });
    }

    const device = url.searchParams.get("device") ?? "";
    const session = url.searchParams.get("session") ?? "";
    this.state.acceptWebSocket(server, ["channel", `ch:${route.channel}`, ipTag]);
    if (!isRelayToken(route.channel) || !isDeviceId(device) || !isRelayToken(session)) {
      wrapSocket(server).close(WS_CLOSE_POLICY, "bad_frame");
      return new Response(null, { status: 101, webSocket: client });
    }
    const handle = room.openChannel({ channel: route.channel, device, session }, wrapSocket(server));
    if ("error" in handle) {
      wrapSocket(server).close(WS_CLOSE_POLICY, handle.error);
      return new Response(null, { status: 101, webSocket: client });
    }
    this.channels.set(server, handle);
    const att: SocketAttachment = {
      kind: "channel",
      accountId: route.accountId,
      relayOrigin: this.relayOrigin,
      channel: route.channel,
    };
    server.serializeAttachment(att);
    this.syncAttachments();
    await room.sweep();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** 后置：控制连接的文本交给对应的 RelayControlHandle，数据通道的二进制交给 RelayChannelHandle；之后存 attachment、调 sweep。 */
  async webSocketMessage(ws: CfWebSocket, message: string | ArrayBuffer): Promise<void> {
    const control = this.controls.get(ws);
    if (control !== undefined) {
      if (typeof message !== "string" || message.length > RELAY_MAX_CONTROL_FRAME_BYTES) {
        wrapSocket(ws).close(WS_CLOSE_POLICY, "bad_frame");
        return;
      }
      try {
        await control.receive(message);
        await this.room?.sweep();
        this.syncAttachments();
      } catch {
        this.controls.delete(ws);
        wrapSocket(ws).close(1011, "internal_error");
      }
      return;
    }
    const channel = this.channels.get(ws);
    if (channel !== undefined) {
      if (typeof message === "string" || message.byteLength > RELAY_MAX_DATA_FRAME_BYTES) {
        wrapSocket(ws).close(WS_CLOSE_POLICY, "bad_frame");
        return;
      }
      channel.receive(new Uint8Array(message));
      await this.room?.sweep();
      return;
    }
    wrapSocket(ws).close(WS_CLOSE_POLICY, "unknown_socket");
  }

  async webSocketClose(ws: CfWebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const control = this.controls.get(ws);
    if (control !== undefined) {
      this.controls.delete(ws);
      try {
        await control.closed();
        await this.room?.sweep();
        this.syncAttachments();
      } catch {}
      return;
    }
    const channel = this.channels.get(ws);
    if (channel !== undefined) {
      this.channels.delete(ws);
      channel.closed();
      await this.room?.sweep();
    }
  }
}

export default {
  fetch: handleRelayRequest,
};
