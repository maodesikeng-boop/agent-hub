// No timers or outbound connections in the Durable Object so it can hibernate; expiry runs via room.sweep() after each message.
import { isDeviceId } from "../../shared/api.ts";
import {
  RELAY_CHECKPOINT_PER_IP_PER_MINUTE,
  RELAY_CONCURRENT_SOCKETS_PER_IP,
  RELAY_IP_BLOCKED_MAX,
  RELAY_IP_LIMITER_MAX,
  RELAY_IP_LIMITER_PRUNE_MS,
  RELAY_MAX_CONTROL_FRAME_BYTES,
  RELAY_MAX_DATA_FRAME_BYTES,
  RELAY_RATE_WINDOW_MS,
  RELAY_REGISTER_PER_IP_PER_MINUTE,
  RELAY_TOKEN_CACHE_MAX,
  RELAY_TOKEN_CACHE_TTL_MS,
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
import { clientKeyOf, createIpRateLimiter, createVerifiedTokenCache, tokenDigest } from "../guards.ts";
import { handleLeaseCheckpoint, parseLeaseCheckpointRoute, readBoundedJson, RELAY_CHECKPOINT_BODY_LIMIT } from "../lease-checkpoint.ts";
import { isRelayToken, parseRelayRegisterRequest, RELAY_PATHS, RELAY_PROTOCOL_VERSION, type RelayErrorCode, type RelayHealthResponse, type RelayRegisterRequest } from "../protocol.ts";

export interface RelayWorkerEnv {
  ACCOUNTS: DurableObjectNamespace;
  PUBLIC_ORIGIN: string;
  GITHUB_API_ORIGIN?: string;
  BUILD_SHA?: string;
  VERSION_METADATA?: WorkerVersionMetadata;
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

const limiterOptions = { windowMs: RELAY_RATE_WINDOW_MS, max: RELAY_IP_LIMITER_MAX, blockedMax: RELAY_IP_BLOCKED_MAX, pruneIntervalMs: RELAY_IP_LIMITER_PRUNE_MS };
const registerLimiter = createIpRateLimiter({ ...limiterOptions, limit: RELAY_REGISTER_PER_IP_PER_MINUTE });
const upgradeLimiter = createIpRateLimiter({ ...limiterOptions, limit: RELAY_UPGRADES_PER_IP_PER_MINUTE });
const checkpointLimiter = createIpRateLimiter({ ...limiterOptions, limit: RELAY_CHECKPOINT_PER_IP_PER_MINUTE });
const verifiedTokens = createVerifiedTokenCache({ max: RELAY_TOKEN_CACHE_MAX, ttlMs: RELAY_TOKEN_CACHE_TTL_MS });

function clientIpOf(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() || "unknown";
}

function publicOriginOf(request: Request, env: Pick<RelayWorkerEnv, "PUBLIC_ORIGIN">): string {
  const configured = env.PUBLIC_ORIGIN?.trim() ?? "";
  return configured !== "" ? new URL(configured).origin : new URL(request.url).origin;
}

function healthPayloadOf(env: Pick<RelayWorkerEnv, "BUILD_SHA" | "VERSION_METADATA">): RelayHealthResponse {
  return {
    ok: true,
    service: "bellwood-relay",
    protocolVersion: RELAY_PROTOCOL_VERSION,
    buildSha: env.BUILD_SHA?.trim() || env.VERSION_METADATA?.tag?.trim() || null,
    versionId: env.VERSION_METADATA?.id?.trim() || null,
    deployedAt: env.VERSION_METADATA?.timestamp?.trim() || null,
  };
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

function wrapSocket(ws: WebSocket): RelaySocket {
  return {
    send(data) {
      try {
        ws.send(typeof data === "string" ? data : toArrayBuffer(data));
      } catch {
      }
    },
    close(code, reason) {
      try {
        ws.close(code, reason);
      } catch {
      }
    },
  };
}

function sqlStorage(sql: SqlStorage): RelayAccountStorage {
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

export async function handleRelayRequest(request: Request, env: RelayWorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === RELAY_PATHS.health) {
    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    }
    return jsonResponse(200, healthPayloadOf(env), { "cache-control": "no-store" });
  }
  if (request.method === "POST" && url.pathname === RELAY_PATHS.register) {
    if (!registerLimiter.allow(clientKeyOf(clientIpOf(request)), Date.now())) {
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

    const digest = await tokenDigest(parsed.token);
    let login: AccountLogin | null | undefined = verifiedTokens.get(digest, Date.now());
    if (login === undefined) {
      try {
        login = await verifyGithubToken(parsed.token, env.GITHUB_API_ORIGIN ? { apiOrigin: env.GITHUB_API_ORIGIN } : undefined);
      } catch {
        return jsonResponse(502, { error: "github_unreachable" });
      }
      if (login === null) return jsonResponse(401, { error: "unauthorized" });
      verifiedTokens.set(digest, login, Date.now());
    }

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

  const checkpoint = parseLeaseCheckpointRoute(url.pathname);
  if (checkpoint !== null && (request.method === "GET" || request.method === "PUT")) {
    if (!checkpointLimiter.allow(clientKeyOf(clientIpOf(request)), Date.now())) {
      return jsonResponse(429, { error: "rate_limited" });
    }
    const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName(checkpoint.accountId));
    return stub.fetch(request);
  }

  const route = parseAccountRoute(url.pathname);
  if (route !== null) {
    if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse(426, { error: "upgrade_required" }, { upgrade: "websocket" });
    }
    if (!upgradeLimiter.allow(clientKeyOf(clientIpOf(request)), Date.now())) {
      return jsonResponse(429, { error: "rate_limited" });
    }
    const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName(route.accountId));
    return stub.fetch(request);
  }

  return jsonResponse(404, { error: "not_found" });
}

export class RelayAccountObject {
  private readonly state: DurableObjectState;
  private readonly env: RelayWorkerEnv;
  private readonly storage: RelayAccountStorage;
  private room: RelayAccountRoom | null = null;
  private accountId: AccountId | null = null;
  private relayOrigin = "";
  private readonly controls = new Map<WebSocket, RelayControlHandle>();
  private readonly channels = new Map<WebSocket, RelayChannelHandle>();

  constructor(state: DurableObjectState, env: RelayWorkerEnv) {
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
        // Pairing state is memory-only and does not survive hibernation, so clients must redial.
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

    const checkpoint = parseLeaseCheckpointRoute(url.pathname);
    if (checkpoint !== null && (request.method === "GET" || request.method === "PUT")) {
      const room = this.ensureRoom(checkpoint.accountId, publicOriginOf(request, this.env));
      return handleLeaseCheckpoint(room, checkpoint.leaseName, url, request.method, () => readBoundedJson(request, RELAY_CHECKPOINT_BODY_LIMIT));
    }
    const route = parseAccountRoute(url.pathname);
    if (route === null || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse(426, { error: "upgrade_required" }, { upgrade: "websocket" });
    }
    const ipTag = `ip:${clientKeyOf(clientIpOf(request))}`;
    if (this.state.getWebSockets(ipTag).length >= RELAY_CONCURRENT_SOCKETS_PER_IP) {
      return jsonResponse(429, { error: "rate_limited" });
    }

    const room = this.ensureRoom(route.accountId, publicOriginOf(request, this.env));

    if (route.kind === "control") {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
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
    if (!isRelayToken(route.channel) || !isDeviceId(device) || !isRelayToken(session)) {
      return jsonResponse(400, { error: "bad_frame" });
    }
    const queuedSends: Array<string | Uint8Array> = [];
    let acceptedSocket: RelaySocket | null = null;
    const channelSocket: RelaySocket = {
      send(data) {
        if (acceptedSocket === null) queuedSends.push(data);
        else acceptedSocket.send(data);
      },
      close(code, reason) {
        acceptedSocket?.close(code, reason);
      },
    };
    const handle = room.openChannel({ channel: route.channel, device, session }, channelSocket);
    if ("error" in handle) {
      return jsonResponse(REGISTER_ERROR_STATUS[handle.error], { error: handle.error });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server, ["channel", `ch:${route.channel}`, ipTag]);
    acceptedSocket = wrapSocket(server);
    for (const chunk of queuedSends) acceptedSocket.send(chunk);
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

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
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

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
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
