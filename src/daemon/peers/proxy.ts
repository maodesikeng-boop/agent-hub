// 入口转发 /d/<设备>/api/*（docs/account-mesh-design.md「连法」）：浏览器只面对入口一个来源，别的设备的接口由入口经组网原样转过去。
// 没用 @fastify/http-proxy：它按固定上游配置，这里上游按设备编号查、连接走组网的 http.Agent（局域网直连或中继，TLS 双向认证）、
// 要严格过滤两个方向的头、要把“连不上”统一成 device_offline，自己写（http.Agent + ws）更短也更好查。
//
// 安全：
// - 请求头只带白名单里的（浏览器的 cookie、Origin、Referer、Authorization 一律不带）；对方按 TLS 证书认出是本机，不看任何头；
// - 只转 /api/ 下、规范化后路径不变的地址（挡住 ../、%2e%2e、反斜杠），只发到信任表里的设备（不收浏览器给的地址，防 SSRF）；
// - 响应头也只放白名单里的回浏览器（不放 Set-Cookie、Location），并且一律加上沙箱 CSP 和 nosniff：
//   对方回的东西是在入口的来源下显示的，不能让它在入口的来源里跑脚本、借浏览器的 cookie 访问入口本机。
// - 组网入口来的请求不能用 /d/（server.ts 的认证钩子拦）：别的设备不能借本机的转发去第三台。
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

/** 转发给对方的请求头（小写）。别的都不带。 */
const FORWARD_REQUEST_HEADERS = ["accept", "content-type", "range", "if-range", "if-none-match", "if-modified-since"];
/** 对方回的响应头里放回浏览器的（小写）。 */
const FORWARD_RESPONSE_HEADERS = ["content-type", "content-length", "content-disposition", "content-range", "accept-ranges", "cache-control", "etag", "last-modified"];

// 和 ui-server/server.ts 发存着的文件时用的一样：html 只许在不透明来源里跑脚本，svg 只放开内联样式，别的什么都不许加载。
const CSP_DEFAULT = "sandbox; default-src 'none'";
const CSP_HTML = "sandbox allow-scripts";
const CSP_SVG = `${CSP_DEFAULT}; style-src 'unsafe-inline'`;

/** 浏览器 → 对方的 WebSocket 关闭码：ws 不让发 1005、1006、1015（只表示“没有关闭帧”），换成正常关闭。 */
const sendableCode = (code: number, fallback: number) => (code === 1000 || (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999) ? code : fallback);
/** 对方发来的心跳：入口自己给浏览器发（对方是老版本、不发也不影响），对方的这条不转。先比长度，别的消息不用逐字节比。 */
const HEARTBEAT_FRAME = Buffer.from(WS_HEARTBEAT_TEXT);
const isHeartbeat = (data: Buffer, isBinary: boolean) => !isBinary && data.length === HEARTBEAT_FRAME.length && data.equals(HEARTBEAT_FRAME);
/** 关闭原因最多 123 字节。 */
const reasonOf = (reason: Buffer) => reason.subarray(0, 123).toString("utf8");

export interface ProxyTarget {
  name: string;
  /** 这台设备的组网连接（MeshDialer.agentFor）：HTTP 和 WebSocket 都经它，按设备复用 keep-alive。 */
  agent: Agent;
}

/**
 * /d/<设备>/api/... → 设备编号段和要转发的路径（含查询串）。路径不是 /api/ 开头、规范化后会变（../、%2e%2e、\）回 null。
 * 设备编号原样返回，由调用方查是不是认识的设备。
 */
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
  /** 入口当前客户端会话的不可逆隔离摘要（仅注入上游请求头，不透传任何浏览器原始凭证）。 */
  clientScope?: string;
  /** WebSocket 心跳间隔，默认 PEER_WS_PING_MS。 */
  pingMs?: number;
  /** 给浏览器那条发心跳的间隔（ws-keepalive.ts），默认 WS_HEARTBEAT_MS。 */
  heartbeatMs?: number;
}

/** 可开启 HTTP gzip 压缩的 MIME 类型（不含二进制与流媒体）。 */
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

/** 客户端 Accept-Encoding 是否允许 gzip（考虑 q=0 显式拒绝与 * 通配）。 */
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

/** 转发一个 HTTP 请求。请求体原样流过去（上传不在入口落地），响应体原样流回来。 */
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
  // 浏览器真带了请求体才流过去（没有请求体的 POST、DELETE 不能变成一个空的分块请求体）
  const length = req.headers["content-length"];
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && ((length !== undefined && length !== "0") || req.headers["transfer-encoding"] !== undefined);
  if (hasBody && length !== undefined) headers["content-length"] = length;

  // 等响应头有时限（对方睡着了 TCP 不回）；响应头到了就不再限时（大文件下载）。浏览器中途断了也停掉上游。
  // 请求体每往上游流过一块就重新计时：慢链路上传视频要传好几分钟，只要一直在传就不算离线，卡住不动才算。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PEER_PROXY_HEADERS_TIMEOUT_MS);
  const onBodyProgress = () => timer.refresh();
  if (hasBody) req.raw.on("data", onBodyProgress);
  // （请求的 close 在请求体读完时就会触发，所以看响应的：还没发完就关了 = 浏览器走了）
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
    // 上传没传完就放弃了：回完 502 关掉这条连接，浏览器不再接着往一个没人读的连接里传
    if (hasBody && !req.raw.complete) reply.header("connection", "close");
    return reply.code(502).send(offlineBody(target.name));
  } finally {
    clearTimeout(timer);
    req.raw.off("data", onBodyProgress);
  }

  // 对端没读完请求体就回了（413、429 等）：回完关掉这条连接，免得浏览器接着往里传剩下的
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
      // 上游回明文：去掉上游旧的 content-length，交由外层 server.ts 的 @fastify/compress 统一按需压缩
      reply.removeHeader("content-length");
    }
    return reply.send(buf);
  }
  // 大文件 / Range 响应体流式转回；流完之前浏览器走了，onClientGone 停掉上游
  req.headers["x-no-compression"] = "1";
  return reply.send(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]));
}

/**
 * 转发一条 WebSocket：浏览器那条已经连上（downstream），这里经组网连对方（带 since 原样转），消息原样双向转，关闭也双向转。
 * 连不上、对方心跳没回：用 DEVICE_OFFLINE_WS_CLOSE_CODE 关浏览器那条（网页按断线重连，重连时 /d/ 的请求回 502 就显示离线）。
 * 两段各管各的保活：对方那段入口 ping（PEER_WS_PING_MS），浏览器那段入口发心跳（keepAlive），对方发来的心跳不转。
 */
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
  // 对方连上之前浏览器发来的先攒着
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
      // 对方不回关闭帧也别一直挂着
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
  // 对方没接受握手（回了 HTTP 响应）：当离线关浏览器那条，之后的 error、close 不再管
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
    // 1006 = 连接断了没有关闭帧：对方掉线
    closeDownstream(code === 1006 ? DEVICE_OFFLINE_WS_CLOSE_CODE : sendableCode(code, 1000), code === 1006 ? DEVICE_OFFLINE_REASON : reasonOf(reason));
  });
}
