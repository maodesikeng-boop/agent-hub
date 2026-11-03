// 界面服务（设计第 4.2、4.3 节；m1-plan 第 3 节接口约定第 1、2 条）：HTTP + WebSocket，只监听 127.0.0.1。
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  API_PATHS,
  ConversationNotFoundError,
  MAX_MESSAGE_BYTES,
  UI_COOKIE_NAME,
  type ApiErrorBody,
  type Ledger,
  type PostMessageResponse,
  type WsServerMessage,
} from "../../shared/index.ts";
import { UI_TOKEN_PATTERN } from "./token.ts";

export interface UiServerOptions {
  ledger: Ledger;
  /** 界面用户令牌，见 loadOrCreateUiToken。 */
  token: string;
  /** 网页打包产物（vite build 的 dist/）。不存在就只提供 API，请求页面返回 404。 */
  staticDir: string;
  /**
   * 防 DNS 重绑定要比对 Host 头里的端口：已经在监听时用实际端口，
   * 还没监听（测试里用 inject）时用这个。
   */
  port?: number;
  logger?: boolean;
}

/** 登录 cookie 的有效期：一年。令牌不变 cookie 就一直有效，想让它失效删掉 ui-token。 */
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
/** clientId 是网页生成的 UUID 一类的串，限长免得拿它撑大去重键。 */
const MAX_CLIENT_ID_LENGTH = 200;
const POSITIVE_INT = /^[1-9]\d*$/;
const NON_NEGATIVE_INT = /^(0|[1-9]\d*)$/;
const HOST_HEADER = /^(?:127\.0\.0\.1|localhost):(\d+)$/i;

class HttpError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** 定时长比较：先各取 sha256 再比，不泄露令牌长度和前缀。 */
function tokenEquals(expected: Buffer, given: unknown): boolean {
  return typeof given === "string" && timingSafeEqual(expected, digest(given));
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function parseId(raw: unknown, what: string): number {
  if (typeof raw !== "string" || !POSITIVE_INT.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new HttpError(400, `${what} must be a positive integer`);
  }
  return Number(raw);
}

function parsePostBody(body: unknown): { clientId: string; text: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
  const { clientId, text } = body as Record<string, unknown>;
  if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > MAX_CLIENT_ID_LENGTH) {
    throw new HttpError(400, `clientId must be a non-empty string of at most ${MAX_CLIENT_ID_LENGTH} characters`);
  }
  if (typeof text !== "string" || text.trim().length === 0) throw new HttpError(400, "text must not be empty");
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
    throw new HttpError(400, `text must be at most ${MAX_MESSAGE_BYTES} bytes`);
  }
  return { clientId, text };
}

export function createUiServer(opts: UiServerOptions): FastifyInstance {
  const { ledger, staticDir } = opts;
  if (!UI_TOKEN_PATTERN.test(opts.token)) throw new Error("ui token must be at least 16 characters of [A-Za-z0-9_-]");
  const expectedToken = digest(opts.token);
  const app = Fastify({ logger: opts.logger ?? false });

  const listeningPort = (): number | undefined => {
    const addr = app.server.address();
    return addr !== null && typeof addr === "object" ? addr.port : opts.port;
  };

  const isAuthenticated = (req: FastifyRequest): boolean =>
    tokenEquals(expectedToken, readCookie(req.headers.cookie, UI_COOKIE_NAME));

  const fail = (reply: FastifyReply, statusCode: number, error: string) =>
    reply.code(statusCode).send({ error } satisfies ApiErrorBody);

  // 防 DNS 重绑定：Host 必须是 127.0.0.1:<端口> 或 localhost:<端口>。所有路径都查，包括静态文件和 /auth。
  app.addHook("onRequest", async (req, reply) => {
    const match = HOST_HEADER.exec(req.headers.host ?? "");
    const port = listeningPort();
    if (match === null || port === undefined || Number(match[1]) !== port) return fail(reply, 403, "forbidden_host");
  });

  // /api/ 下（含 WebSocket 握手）一律要 cookie。静态文件不要：网页要先加载出来，才能在 401 时提示用户怎么登录。
  app.addHook("onRequest", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const path = req.url.split("?", 1)[0] ?? "";
    if (path.startsWith("/api/") && !isAuthenticated(req)) return fail(reply, 401, "unauthorized");
  });

  app.setErrorHandler((err: FastifyError | ConversationNotFoundError, req, reply) => {
    if (err instanceof ConversationNotFoundError) return fail(reply, 404, err.code);
    const status = (err as FastifyError).statusCode;
    if (status !== undefined && status >= 400 && status < 500) return fail(reply, status, err.message);
    req.log.error({ err }, "ui-server request failed");
    return fail(reply, 500, "internal_error");
  });
  app.setNotFoundHandler((_req, reply) => fail(reply, 404, "not_found"));

  app.register(fastifyWebsocket);
  if (existsSync(staticDir)) {
    app.register(fastifyStatic, { root: staticDir });
  } else {
    app.log.warn(`static dir ${staticDir} does not exist, serving API only`);
  }

  // 路由放进插件里：@fastify/websocket 的 onRoute 钩子只管它注册完之后才定义的路由，直接写在根上会比它先定义。
  app.register(async (routes) => {
    routes.get(API_PATHS.auth, async (req, reply) => {
      const { token } = req.query as { token?: unknown };
      if (!tokenEquals(expectedToken, token)) return fail(reply, 401, "unauthorized");
      reply
        .header("set-cookie", `${UI_COOKIE_NAME}=${opts.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}`)
        .header("referrer-policy", "no-referrer");
      return reply.redirect("/", 302);
    });

    routes.get(API_PATHS.state, async () => ledger.snapshot());

    routes.get("/api/conversations/:id/messages", async (req) => {
      const { id } = req.params as { id?: unknown };
      const { before } = req.query as { before?: unknown };
      return ledger.messagesBefore(parseId(id, "conversation id"), parseId(before, "before"));
    });

    routes.post("/api/conversations/:id/messages", async (req): Promise<PostMessageResponse> => {
      const conversationId = parseId((req.params as { id?: unknown }).id, "conversation id");
      const { clientId, text } = parsePostBody(req.body);
      return ledger.postUserMessage({ conversationId, clientId, text });
    });

    routes.post("/api/conversations/:id/stop", async (req, reply) => {
      ledger.requestStop(parseId((req.params as { id?: unknown }).id, "conversation id"));
      return reply.code(202).send();
    });

    routes.get(API_PATHS.ws, { websocket: true }, (socket, req) => {
      // 自己从 URL 取参数：injectWS 造的请求没有 req.query；重复的 since 当作不合法。
      const sinceValues = new URL(req.url, "http://localhost").searchParams.getAll("since");
      const since = sinceValues.length === 1 ? sinceValues[0] : sinceValues.length === 0 ? undefined : null;
      const send = (message: WsServerMessage) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      };
      // 先订阅再补齐：账本是同步的，两步之间不会有变化插进来，所以每条只推一次、seq 递增。
      const unsubscribe = ledger.onChange(send);
      socket.once("close", unsubscribe);
      socket.once("error", unsubscribe);

      if (since === undefined) return; // 不带 since：只推之后的新变化
      if (typeof since !== "string" || !NON_NEGATIVE_INT.test(since)) return send({ type: "resync" });
      try {
        const result = ledger.changesSince(Number(since));
        if (result.kind === "resync") return send({ type: "resync" });
        for (const change of result.changes) send(change);
      } catch (err) {
        // 账本出错：连接不能留着半截，取消订阅、关掉，让网页按断线重连处理。
        req.log.error({ err }, "ui-server websocket catch-up failed");
        unsubscribe();
        socket.close(1011, "internal_error");
      }
    });
  });

  return app;
}

export interface RunningUiServer {
  app: FastifyInstance;
  port: number;
  /** 优雅关闭：断开 WebSocket、停止监听。 */
  close(): Promise<void>;
}

/** 只监听 127.0.0.1，不提供改地址的选项。port 为 0 时由系统分配，实际端口看返回值。 */
export async function startUiServer(opts: UiServerOptions & { port: number }): Promise<RunningUiServer> {
  const app = createUiServer(opts);
  await app.listen({ host: "127.0.0.1", port: opts.port });
  const addr = app.server.address();
  if (addr === null || typeof addr !== "object") throw new Error("ui-server is not listening on a TCP port");
  return { app, port: addr.port, close: () => app.close() };
}
