// 界面服务（设计第 4.2、4.3 节；m1-plan 第 3 节接口约定第 1、2 条）：HTTP + WebSocket，只监听 127.0.0.1。
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  AGENT_VENDORS,
  API_PATHS,
  ConversationNotFoundError,
  LEDGER_ERROR_HTTP_STATUS,
  LedgerRequestError,
  MAX_MESSAGE_BYTES,
  MAX_MODEL_CHARS,
  MAX_NAME_CHARS,
  MAX_PATH_BYTES,
  MAX_PERSONA_BYTES,
  MAX_REASON_CHARS,
  ATTACHMENTS_MISSING_MESSAGE,
  ATTACHMENTS_TOO_MANY_MESSAGE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_CONCURRENT_UPLOADS,
  MAX_UPLOAD_BYTES,
  PM_MODES,
  isAgentVendor,
  UI_COOKIE_NAME,
  UPLOAD_BUSY_MESSAGE,
  UPLOAD_TOO_LARGE_MESSAGE,
  bundledModelCatalog,
  isImageMime,
  normalizeName,
  sentFileMime,
  utf8Bytes,
  type AgentVendor,
  type ApiErrorBody,
  type Attachment,
  type CreatePmRequest,
  type CreatePmResponse,
  type EditPersonaRequest,
  type EditPersonaResponse,
  type Ledger,
  type LedgerErrorCode,
  type ModelCatalog,
  type ModelsResponse,
  type PersonaResponse,
  type PmMode,
  type PostMessageResponse,
  type RetryMessageResponse,
  type WsServerMessage,
} from "../../shared/index.ts";
import { UploadError, resolveUpload, saveUpload } from "../uploads.ts";
import { UI_TOKEN_PATTERN } from "./token.ts";

export interface UiServerOptions {
  ledger: Ledger;
  /** 界面用户令牌，见 loadOrCreateUiToken。 */
  token: string;
  /** 聊天框上传的文件放哪（paths.ts 的 uploadsDir；守护进程传 realpath 过的，agent 拿到的路径和它一致）。 */
  uploadsDir: string;
  /** agent 发给用户的文件的副本放哪（paths.ts 的 sentFilesDir）。 */
  sentFilesDir: string;
  /** 网页打包产物（vite build 的 dist/）。不存在就只提供 API，请求页面返回 404。 */
  staticDir: string;
  /**
   * 防 DNS 重绑定要比对 Host 头里的端口：已经在监听时用实际端口，
   * 还没监听（测试里用 inject）时用这个。
   */
  port?: number;
  logger?: boolean;
  /** 模型名单（daemon/driver/model-catalog.ts 的 createModelCatalogs）。不给就回打包的名单。 */
  models?: { list(options?: { refresh?: boolean }): Promise<ModelCatalog[]> };
}

/** 登录 cookie 的有效期：一年。令牌不变 cookie 就一直有效，想让它失效删掉 ui-token。 */
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
/** clientId 是网页生成的 UUID 一类的串，限长免得拿它撑大去重键。 */
const MAX_CLIENT_ID_LENGTH = 200;
const POSITIVE_INT = /^[1-9]\d*$/;
const NON_NEGATIVE_INT = /^(0|[1-9]\d*)$/;
const HOST_HEADER = /^(?:127\.0\.0\.1|localhost):(\d+)$/i;
/** 浏览器发的 Origin 是 scheme://host:port，没有路径和末尾斜杠；主机名那三种跟 Host 检查一致。 */
const ORIGIN_HEADER = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)$/i;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

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

/** 新接口的请求体：必须是 JSON 对象，只许出现 allowed 里的字段（多余字段拒绝）。 */
function parseObjectBody(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new HttpError(400, `unknown field: ${extra[0]}`);
  return body as Record<string, unknown>;
}

function requireName(value: unknown, what: string): string {
  if (typeof value !== "string" || normalizeName(value) === null) {
    throw new HttpError(400, `${what} must be a non-empty string of at most ${MAX_NAME_CHARS} characters without control characters`);
  }
  return value;
}

function requireMode(value: unknown): PmMode {
  if (typeof value !== "string" || !(PM_MODES as readonly string[]).includes(value)) {
    throw new HttpError(400, `mode must be one of ${PM_MODES.join(", ")}`);
  }
  return value as PmMode;
}

function requireBoundedBytes(value: unknown, what: string, maxBytes: number): string {
  if (typeof value !== "string") throw new HttpError(400, `${what} must be a string`);
  if (utf8Bytes(value) > maxBytes) throw new HttpError(400, `${what} must be at most ${maxBytes} bytes`);
  return value;
}

function requireBoundedChars(value: unknown, what: string, maxChars: number): string {
  if (typeof value !== "string") throw new HttpError(400, `${what} must be a string`);
  if ([...value].length > maxChars) throw new HttpError(400, `${what} must be at most ${maxChars} characters`);
  return value;
}

/** 厂商：清单里的编号。 */
function requireVendor(value: unknown): AgentVendor {
  if (!isAgentVendor(value)) throw new HttpError(400, `vendor must be one of ${AGENT_VENDORS.join(", ")}`);
  return value;
}

/** 模型、思考程度：字符串或 null（默认）。取值对不对由账本按厂商清单查，原因原样回给网页。 */
function optionalSetting(value: unknown, what: string): string | null {
  return value === null ? null : requireBoundedChars(value, what, MAX_MODEL_CHARS);
}

function parseCreatePmBody(body: unknown): CreatePmRequest {
  const raw = parseObjectBody(body, ["name", "mode", "vendor", "defaultModel", "effort", "persona", "folder"]);
  const input: CreatePmRequest = {
    name: requireName(raw.name, "name"),
    mode: requireMode(raw.mode),
    persona: requireBoundedBytes(raw.persona, "persona", MAX_PERSONA_BYTES),
  };
  if (raw.vendor !== undefined) input.vendor = requireVendor(raw.vendor);
  if (raw.defaultModel !== undefined) input.defaultModel = optionalSetting(raw.defaultModel, "defaultModel");
  if (raw.effort !== undefined) input.effort = optionalSetting(raw.effort, "effort");
  // 主文件夹可选；给了就必须是个非空路径（存不存在、是不是目录由账本查）
  if (raw.folder !== undefined) {
    const folder = requireBoundedBytes(raw.folder, "folder", MAX_PATH_BYTES);
    if (folder.trim() === "" || folder.includes("\u0000")) throw new HttpError(400, "folder must be a non-empty path");
    input.folder = folder;
  }
  return input;
}

function parseEditPersonaBody(body: unknown): EditPersonaRequest {
  const fields = ["text", "mode", "vendor", "model", "effort"];
  const raw = parseObjectBody(body, [...fields, "reason"]);
  if (fields.every((f) => raw[f] === undefined)) throw new HttpError(400, `one of ${fields.join(", ")} is required`);
  const input: EditPersonaRequest = {};
  if (raw.text !== undefined) input.text = requireBoundedBytes(raw.text, "text", MAX_PERSONA_BYTES);
  if (raw.mode !== undefined) input.mode = requireMode(raw.mode);
  if (raw.vendor !== undefined) input.vendor = requireVendor(raw.vendor);
  if (raw.model !== undefined) input.model = optionalSetting(raw.model, "model");
  if (raw.effort !== undefined) input.effort = optionalSetting(raw.effort, "effort");
  if (raw.reason !== undefined) input.reason = requireBoundedChars(raw.reason, "reason", MAX_REASON_CHARS);
  return input;
}

/** 请求体里的 attachmentIds：字符串数组，去重，最多 MAX_ATTACHMENTS_PER_MESSAGE 个。没写就是空。 */
function parseAttachmentIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) throw new HttpError(400, "attachmentIds must be an array of strings");
  const ids = [...new Set(value as string[])];
  if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new HttpError(400, ATTACHMENTS_TOO_MANY_MESSAGE);
  return ids;
}

function parsePostBody(body: unknown): { clientId: string; text: string; attachmentIds: string[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
  const { clientId, text, attachmentIds } = body as Record<string, unknown>;
  if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > MAX_CLIENT_ID_LENGTH) {
    throw new HttpError(400, `clientId must be a non-empty string of at most ${MAX_CLIENT_ID_LENGTH} characters`);
  }
  const ids = parseAttachmentIds(attachmentIds);
  // 只发文件的时候文字可以是空的
  if (typeof text !== "string" || (text.trim().length === 0 && ids.length === 0)) throw new HttpError(400, "text must not be empty");
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
    throw new HttpError(400, `text must be at most ${MAX_MESSAGE_BYTES} bytes`);
  }
  return { clientId, text, attachmentIds: ids };
}

/** Range 头（只认单段 bytes=a-b、bytes=a-、bytes=-n）：返回要发的闭区间；没带、认不出、无效是 null（发整个文件），超出文件是 "unsatisfiable"。 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "unsatisfiable" {
  const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  // 末位比首位小（bytes=5-2）：RFC 9110 说这个 Range 无效、整个忽略，发整个文件
  if (match[2] !== "" && Number(match[2]) < start) return null;
  if (start >= size) return "unsatisfiable";
  return { start, end: match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1) };
}

/** 存着的文件的 CSP：沙箱、什么都不许加载，直接打开也不会当网页执行。 */
const STORED_FILE_CSP = "sandbox; default-src 'none'";
const SVG_MIME = "image/svg+xml";
/**
 * svg 直接打开（点开看大图）时，它自带的 <style>、style="" 被 default-src 'none' 拦掉，画出来是黑的（真浏览器验证过），
 * 所以只给 svg 放开内联样式；脚本仍被 sandbox（没有 allow-scripts）和 default-src 'none' 拦着。
 */
const SVG_CSP = `${STORED_FILE_CSP}; style-src 'unsafe-inline'`;

/**
 * 发一个存在数据目录里的文件（上传的、agent 发出的副本）。文件不可信：只有图片内联显示，别的一律当下载；
 * 禁止嗅探、CSP 沙箱化，直接打开地址也不会当网页执行（svg 里的脚本也不跑）。支持单段 Range（视频、大 PDF 拖动用）。
 */
function sendStoredFile(req: FastifyRequest, reply: FastifyReply, file: Pick<Attachment, "name" | "path" | "size" | "mime">) {
  const inline = isImageMime(file.mime);
  reply
    .header("content-type", file.mime)
    .header("content-disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`)
    .header("x-content-type-options", "nosniff")
    .header("content-security-policy", file.mime === SVG_MIME ? SVG_CSP : STORED_FILE_CSP)
    .header("cache-control", "private, max-age=3600")
    .header("accept-ranges", "bytes");
  const range = parseRange(req.headers.range, file.size);
  if (range === "unsatisfiable") return reply.code(416).header("content-range", `bytes */${file.size}`).send();
  if (range === null) return reply.header("content-length", file.size).send(createReadStream(file.path));
  return reply
    .code(206)
    .header("content-range", `bytes ${range.start}-${range.end}/${file.size}`)
    .header("content-length", range.end - range.start + 1)
    .send(createReadStream(file.path, { start: range.start, end: range.end }));
}

export function createUiServer(opts: UiServerOptions): FastifyInstance {
  const { ledger, staticDir, uploadsDir, sentFilesDir } = opts;
  if (!UI_TOKEN_PATTERN.test(opts.token)) throw new Error("ui token must be at least 16 characters of [A-Za-z0-9_-]");
  const expectedToken = digest(opts.token);
  const app = Fastify({ logger: opts.logger ?? false });

  const listeningPort = (): number | undefined => {
    const addr = app.server.address();
    return addr !== null && typeof addr === "object" ? addr.port : opts.port;
  };

  const isAuthenticated = (req: FastifyRequest): boolean =>
    tokenEquals(expectedToken, readCookie(req.headers.cookie, UI_COOKIE_NAME));

  const fail = (reply: FastifyReply, statusCode: number, error: string, code?: LedgerErrorCode) =>
    reply.code(statusCode).send((code === undefined ? { error } : { error, code }) satisfies ApiErrorBody);

  // 防 DNS 重绑定：Host 必须是 127.0.0.1:<端口> 或 localhost:<端口>。所有路径都查，包括静态文件和 /auth。
  app.addHook("onRequest", async (req, reply) => {
    const match = HOST_HEADER.exec(req.headers.host ?? "");
    const port = listeningPort();
    if (match === null || port === undefined || Number(match[1]) !== port) return fail(reply, 403, "forbidden_host");
  });

  // 防别的本机端口上的网页借 cookie 动手：浏览器认为 localhost 不同端口是同一个站点，SameSite=Strict 拦不住。
  // 会改状态的请求和 WebSocket 握手必须带同源的 Origin（http://<host>:<实际端口>），没带也拒绝；GET 不查。
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?", 1)[0] ?? "";
    if (SAFE_METHODS.has(req.method) && path !== API_PATHS.ws) return;
    const match = ORIGIN_HEADER.exec(req.headers.origin ?? "");
    const port = listeningPort();
    // 端口要和实际端口逐字相同：不接受 04000 这种写法。
    if (match === null || port === undefined || match[1] !== String(port)) return fail(reply, 403, "forbidden_origin");
  });

  // /api/ 下（含 WebSocket 握手）一律要 cookie。静态文件不要：网页要先加载出来，才能在 401 时提示用户怎么登录。
  app.addHook("onRequest", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const path = req.url.split("?", 1)[0] ?? "";
    if (path.startsWith("/api/") && !isAuthenticated(req)) return fail(reply, 401, "unauthorized");
  });

  app.setErrorHandler((err: FastifyError | ConversationNotFoundError | LedgerRequestError | UploadError, req, reply) => {
    if (err instanceof ConversationNotFoundError) return fail(reply, 404, err.code);
    if (err instanceof UploadError) return fail(reply, err.statusCode, err.message, err.statusCode === 400 ? "invalid" : undefined);
    // 上传超过 MAX_UPLOAD_BYTES：Fastify 在收完之前就拒了，原因是英文；换成中文（别的接口的 413 照旧）
    if ((err as FastifyError).statusCode === 413 && (req.url.split("?", 1)[0] ?? "") === API_PATHS.uploads) {
      return fail(reply, 413, UPLOAD_TOO_LARGE_MESSAGE);
    }
    if (err instanceof LedgerRequestError) return fail(reply, LEDGER_ERROR_HTTP_STATUS[err.code], err.message, err.code);
    const status = (err as FastifyError).statusCode;
    // 请求体校验没过（含 JSON 解析失败）一律 400 + code "invalid"，和账本拒绝的 invalid 同形，网页统一处理。
    if (status === 400) return fail(reply, 400, err.message, "invalid");
    if (status !== undefined && status >= 400 && status < 500) return fail(reply, status, err.message);
    req.log.error({ err }, "ui-server request failed");
    return fail(reply, 500, "internal_error");
  });
  app.setNotFoundHandler((_req, reply) => fail(reply, 404, "not_found"));

  app.register(fastifyWebsocket);

  // 上传文件（不绑定接收方，谁来用都是先上传、再在发消息时带编号）：请求体是文件原样的字节，上限 MAX_UPLOAD_BYTES，只对这个接口放大。
  // 放进单独的插件里：内容类型解析器只在这个插件里生效（别的接口照旧只收 JSON、上限 1 MB）；
  // 先去掉 Fastify 自带的 JSON、文本解析器，免得 .json、.txt 文件被当成文本解析坏掉。
  app.register(async (uploads) => {
    uploads.removeAllContentTypeParsers();
    uploads.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

    // 同时在收的上传有上限：每个都整个读进内存。名额占到响应结束（正常结束、连接中途断掉都会释放）
    let activeUploads = 0;
    uploads.addHook("onRequest", async (req, reply) => {
      if (req.method !== "POST") return;
      if (activeUploads >= MAX_CONCURRENT_UPLOADS) return fail(reply, 429, UPLOAD_BUSY_MESSAGE);
      activeUploads++;
      reply.raw.once("close", () => {
        activeUploads--;
      });
    });

    uploads.post(API_PATHS.uploads, { bodyLimit: MAX_UPLOAD_BYTES }, async (req) => {
      const { name } = req.query as { name?: unknown };
      return saveUpload(uploadsDir, typeof name === "string" ? name : "", Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
    });

    // 地址里的文件名只是给浏览器看的（取文件只认编号），用通配：命名参数 Fastify 默认最多 100 个字符，长文件名会 404
    uploads.get("/api/uploads/:id/*", async (req, reply) => {
      const attachment = resolveUpload(uploadsDir, String((req.params as { id?: unknown }).id ?? ""));
      if (attachment === null) return fail(reply, 404, "not_found");
      return sendStoredFile(req, reply, attachment);
    });
  });

  // agent 发给用户的文件的副本（daemon/sent-files.ts）：和上传的文件同一个布局，同一套查找和响应头；类型按 sentFileMime（svg 算图片）
  app.get("/api/sent-files/:id/*", async (req, reply) => {
    const copy = resolveUpload(sentFilesDir, String((req.params as { id?: unknown }).id ?? ""));
    if (copy === null) return fail(reply, 404, "not_found");
    return sendStoredFile(req, reply, { ...copy, mime: sentFileMime(copy.name) });
  });

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

    routes.get(API_PATHS.models, async (req): Promise<ModelsResponse> => {
      const refresh = (req.query as { refresh?: unknown }).refresh === "1";
      return { catalogs: opts.models ? await opts.models.list({ refresh }) : AGENT_VENDORS.map((v) => bundledModelCatalog(v)) };
    });

    routes.get("/api/conversations/:id/messages", async (req) => {
      const { id } = req.params as { id?: unknown };
      const { before } = req.query as { before?: unknown };
      return ledger.messagesBefore(parseId(id, "conversation id"), parseId(before, "before"));
    });

    routes.post("/api/conversations/:id/messages", async (req): Promise<PostMessageResponse> => {
      const conversationId = parseId((req.params as { id?: unknown }).id, "conversation id");
      const { clientId, text, attachmentIds } = parsePostBody(req.body);
      // 附件按编号从磁盘重新算（路径、名字、大小），不信请求里的任何别的东西
      const attachments = attachmentIds.map((id) => resolveUpload(uploadsDir, id) ?? undefined);
      if (attachments.some((a) => a === undefined)) throw new HttpError(400, ATTACHMENTS_MISSING_MESSAGE);
      return ledger.postUserMessage({
        conversationId,
        clientId,
        text,
        ...(attachments.length > 0 ? { attachments: attachments as NonNullable<(typeof attachments)[number]>[] } : {}),
      });
    });

    routes.post("/api/conversations/:id/stop", async (req, reply) => {
      ledger.requestStop(parseId((req.params as { id?: unknown }).id, "conversation id"));
      return reply.code(202).send();
    });

    routes.post(API_PATHS.pms, async (req, reply) => {
      const result = ledger.createPm(parseCreatePmBody(req.body));
      return reply.code(201).send({ pmId: result.pm.id, conversationId: result.conversation.id } satisfies CreatePmResponse);
    });

    routes.get("/api/pms/:id/persona", async (req): Promise<PersonaResponse> => {
      return ledger.getPersona(parseId((req.params as { id?: unknown }).id, "pm id"));
    });

    routes.put("/api/pms/:id/persona", async (req): Promise<EditPersonaResponse> => {
      const pmId = parseId((req.params as { id?: unknown }).id, "pm id");
      const result = ledger.editPersona(pmId, parseEditPersonaBody(req.body), { kind: "user" });
      return { changed: result.change !== null, persona: result.persona };
    });

    routes.post("/api/persona-changes/:id/revert", async (req): Promise<EditPersonaResponse> => {
      const result = ledger.revertPersonaChange(parseId((req.params as { id?: unknown }).id, "persona change id"));
      return { changed: result.change !== null, persona: result.persona };
    });

    routes.post("/api/messages/:id/retry", async (req, reply) => {
      const result = ledger.retryMessage(parseId((req.params as { id?: unknown }).id, "message id"));
      return reply.code(202).send({ messageId: result.messageId } satisfies RetryMessageResponse);
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
