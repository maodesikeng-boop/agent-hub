// Hand-written instead of @fastify/http-proxy because upstreams are looked up per device over mesh agents. Only allowlisted headers pass both ways, and responses get a sandbox CSP so peer content cannot script the entry origin.
import type { Agent } from "node:http";
import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { WebSocket } from "ws";
import {
  DEVICE_OFFLINE_REASON,
  DEVICE_OFFLINE_WS_CLOSE_CODE,
  PEER_CLIENT_SCOPE_HEADER,
  PEER_PROXY_HEADERS_TIMEOUT_MS,
  PEER_WS_CONNECT_TIMEOUT_MS,
  PEER_WS_PING_MS,
  WS_HEARTBEAT_TEXT,
  type ApiErrorBody,
} from "../../shared/index.ts";
import { MESH_HTTP_HOST, agentFetch } from "../mesh/agent-fetch.ts";
import { keepAlive } from "../ws-keepalive.ts";

const FORWARD_REQUEST_HEADERS = ["accept", "content-type", "range", "if-range", "if-none-match", "if-modified-since"];
const FORWARD_RESPONSE_HEADERS = ["content-type", "content-length", "content-disposition", "content-range", "accept-ranges", "cache-control", "etag", "last-modified"];

const CSP_DEFAULT = "sandbox; default-src 'none'";
const CSP_HTML = "sandbox allow-scripts";
const CSP_SVG = `${CSP_DEFAULT}; style-src 'unsafe-inline'`;

const sendableCode = (code: number, fallback: number) => (code === 1000 || (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999) ? code : fallback);
const HEARTBEAT_FRAME = Buffer.from(WS_HEARTBEAT_TEXT);
const isHeartbeat = (data: Buffer, isBinary: boolean) => !isBinary && data.length === HEARTBEAT_FRAME.length && data.equals(HEARTBEAT_FRAME);
const reasonOf = (reason: Buffer) => reason.subarray(0, 123).toString("utf8");

export interface ProxyTarget {
  name: string;
  agent: Agent;
}

export function splitProxyUrl(rawUrl: string): { device: string; rest: string } | null {
  const match = /^\/d\/([^/?#]*)(\/[^#]*)?$/.exec(rawUrl);
  if (match === null || match[2] === undefined) return null;
  const rest = match[2];
  const path = rest.split("?", 1)[0]!;
  if (!path.startsWith("/api/")) return null;
  let normalized: string;
  try {
    normalized = new URL(rest, "http://x").pathname;
  } catch {
    return null;
  }
  if (normalized !== path || path.includes("\\")) return null;
  return { device: match[1]!, rest };
}

function offlineBody(name: string): ApiErrorBody {
  return { error: `连不上“${name}”`, code: "device_offline" };
}

export interface ProxyContext {
  clientScope?: string;
  pingMs?: number;
  heartbeatMs?: number;
}

const COMPRESSIBLE_CONTENT_TYPES = new Set([
  "application/json",
  "text/html",
  "text/plain",
  "text/css",
  "text/javascript",
  "application/javascript",
  "image/svg+xml",
]);

export function isCompressibleType(contentType: unknown): boolean {
  if (typeof contentType !== "string") return false;
  const essence = contentType.split(";", 1)[0]!.trim().toLowerCase();
  return COMPRESSIBLE_CONTENT_TYPES.has(essence) || essence.endsWith("+json");
}

export function acceptsGzip(header: string | string[] | undefined): boolean {
  if (header === undefined) return false;
  const raw = Array.isArray(header) ? header.join(",") : header;
  let wildcard: boolean | null = null;
  for (const item of raw.split(",")) {
    const [namePart, ...params] = item.split(";");
    const coding = namePart?.trim().toLowerCase() ?? "";
    if (coding !== "gzip" && coding !== "x-gzip" && coding !== "*") continue;
    let allowed = true;
    for (const param of params) {
      const eq = param.indexOf("=");
      if (eq !== -1 && param.slice(0, eq).trim().toLowerCase() === "q") {
        const q = Number(param.slice(eq + 1).trim());
        if (Number.isNaN(q) || q <= 0) allowed = false;
      }
    }
    if (coding === "gzip" || coding === "x-gzip") return allowed;
    wildcard = allowed;
  }
  return wildcard ?? false;
}

const isGzipBuffer = (buf: Buffer | null): boolean =>
  buf !== null && buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;

export async function proxyHttp(req: FastifyRequest, reply: FastifyReply, target: ProxyTarget, rest: string, ctx: ProxyContext): Promise<FastifyReply> {
  const wantGzip = req.headers.range === undefined && acceptsGzip(req.headers["accept-encoding"]);
  const headers: Record<string, string> = {
    "accept-encoding": wantGzip ? "gzip" : "identity",
    ...(ctx.clientScope ? { [PEER_CLIENT_SCOPE_HEADER]: ctx.clientScope } : {}),
  };
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  const length = req.headers["content-length"];
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && ((length !== undefined && length !== "0") || req.headers["transfer-encoding"] !== undefined);
  if (hasBody && length !== undefined) headers["content-length"] = length;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PEER_PROXY_HEADERS_TIMEOUT_MS);
  const onBodyProgress = () => timer.refresh();
  if (hasBody) req.raw.on("data", onBodyProgress);
  const onClientGone = () => {
    if (!reply.raw.writableFinished) controller.abort();
  };
  reply.raw.once("close", onClientGone);
  let res: Response;
  try {
    res = await agentFetch(target.agent, rest, {
      method: req.method,
      headers,
      signal: controller.signal,
      ...(hasBody ? { body: req.raw } : {}),
    });
  } catch {
    reply.raw.off("close", onClientGone);
    if (hasBody && !req.raw.complete) reply.header("connection", "close");
    return reply.code(502).send(offlineBody(target.name));
  } finally {
    clearTimeout(timer);
    req.raw.off("data", onBodyProgress);
  }

  // The peer answered before reading the body (413, 429), so close the connection to stop the browser uploading the rest.
  if (hasBody && !req.raw.complete) reply.header("connection", "close");

  reply.code(res.status);
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = res.headers.get(name);
    if (value !== null) reply.header(name, value);
  }
  const type = (res.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
  reply
    .header("content-security-policy", type === "text/html" ? CSP_HTML : type === "image/svg+xml" ? CSP_SVG : CSP_DEFAULT)
    .header("x-content-type-options", "nosniff");
  if (res.body === null) return reply.send();
  if (
    res.headers.get("content-encoding")?.trim().toLowerCase() === "gzip" ||
    (res.status !== 206 &&
      res.headers.get("accept-ranges") === null &&
      res.headers.get("content-range") === null &&
      isCompressibleType(type))
  ) {
    let buf: Buffer;
    try {
      buf = Buffer.from(await res.arrayBuffer());
    } catch {
      reply.raw.off("close", onClientGone);
      return reply.code(502).send(offlineBody(target.name));
    }
    reply.raw.off("close", onClientGone);
    if (isGzipBuffer(buf)) {
      reply.header("content-encoding", "gzip").header("vary", "Accept-Encoding").header("content-length", buf.length);
    } else {
      // Drop the upstream content-length so @fastify/compress can re-encode.
      reply.removeHeader("content-length");
    }
    return reply.send(buf);
  }
  req.headers["x-no-compression"] = "1";
  return reply.send(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]));
}

export function proxyWebSocket(downstream: WebSocket, target: ProxyTarget, rest: string, ctx: ProxyContext): void {
  keepAlive(downstream, ctx.heartbeatMs);
  const closeDownstream = (code: number, reason: string) => {
    if (downstream.readyState === WebSocket.OPEN || downstream.readyState === WebSocket.CONNECTING) downstream.close(code, reason);
  };
  const upstream = new WebSocket(`ws://${MESH_HTTP_HOST}${rest}`, {
    agent: target.agent,
    handshakeTimeout: PEER_WS_CONNECT_TIMEOUT_MS,
    perMessageDeflate: false,
    followRedirects: false,
  });
  const pending: Array<{ data: Buffer; binary: boolean }> = [];
  let heartbeat: NodeJS.Timeout | undefined;
  let alive = true;

  const stop = () => {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeat = undefined;
  };

  downstream.on("message", (data: Buffer, isBinary: boolean) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else pending.push({ data, binary: isBinary });
  });
  downstream.once("close", (code: number, reason: Buffer) => {
    stop();
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.close(sendableCode(code, 1000), reasonOf(reason));
      setTimeout(() => upstream.terminate(), 2_000).unref();
    } else {
      upstream.terminate();
    }
  });

  upstream.once("open", () => {
    for (const m of pending.splice(0)) upstream.send(m.data, { binary: m.binary });
    heartbeat = setInterval(() => {
      if (!alive) {
        stop();
        upstream.terminate();
        closeDownstream(DEVICE_OFFLINE_WS_CLOSE_CODE, DEVICE_OFFLINE_REASON);
        return;
      }
      alive = false;
      upstream.ping();
    }, ctx.pingMs ?? PEER_WS_PING_MS);
  });
  upstream.on("pong", () => {
    alive = true;
  });
  upstream.on("message", (data: Buffer, isBinary: boolean) => {
    if (downstream.readyState === WebSocket.OPEN && !isHeartbeat(data, isBinary)) downstream.send(data, { binary: isBinary });
  });
  let rejected = false;
  upstream.once("unexpected-response", (request) => {
    rejected = true;
    stop();
    closeDownstream(DEVICE_OFFLINE_WS_CLOSE_CODE, DEVICE_OFFLINE_REASON);
    request.destroy();
  });
  upstream.on("error", () => {
    stop();
    if (!rejected) closeDownstream(DEVICE_OFFLINE_WS_CLOSE_CODE, DEVICE_OFFLINE_REASON);
  });
  upstream.once("close", (code: number, reason: Buffer) => {
    stop();
    if (rejected) return;
    closeDownstream(code === 1006 ? DEVICE_OFFLINE_WS_CLOSE_CODE : sendableCode(code, 1000), code === 1006 ? DEVICE_OFFLINE_REASON : reasonOf(reason));
  });
}
