// 界面服务（设计第 4.2、4.3 节；m1-plan 第 3 节接口约定第 1、2 条）：HTTP + WebSocket，只监听 127.0.0.1。
// 联机（docs/multi-device-design.md 第 3 节）：经 tailscale serve 进来的请求另外认本机的 tailnet 名字，并且只放行设备主人；
// Linux 上 serve 转发到另听的 0600 Unix socket（startUiServer 的 serveSocket）。
import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, createReadStream, existsSync, lstatSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
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
  SESSION_MAX_AGE_MS,
  uiCookieName,
  UPLOAD_BUSY_MESSAGE,
  UPLOAD_TOO_LARGE_MESSAGE,
  bundledModelCatalog,
  FILE_ACTIONS,
  isImageMime,
  normalizeName,
  sentFileMime,
  sentFilesOf,
  serverInfoFor,
  isLoopbackAddress,
  serverInfoForClient,
  TAILSCALE_USER_LOGIN_HEADER,
  utf8Bytes,
  type AgentVendor,
  type ApiErrorBody,
  type BrowserSessionsResponse,
  type LoginLinkResponse,
  type CommandsResponse,
  type FilesResponse,
  type Attachment,
  type CreatePmRequest,
  type CreatePmResponse,
  type EditPersonaRequest,
  type EditPersonaResponse,
  type FileAction,
  type FileActionResponse,
  type Ledger,
  type LedgerErrorCode,
  type ModelCatalog,
  type ModelsResponse,
  type QuotaResponse,
  type PersonaResponse,
  type PickFolderResponse,
  type PmMode,
  type PostMessageResponse,
  type PushKeyResponse,
  type RenewSessionResponse,
  type RetryMessageResponse,
  type ServerInfo,
  type StateSnapshot,
  type WsServerMessage,
} from "../../shared/index.ts";
import type { ComposerService } from "../composer.ts";
import { PickFolderError, createFolderPicker, type FolderPicker } from "../pick-folder.ts";
import {
  FILE_ACTIONS_UNAVAILABLE_MESSAGE,
  FileActionsUnavailable,
  OPEN_NOT_ALLOWED_MESSAGE,
  OpenNotAllowed,
  OpenTargetMissing,
  performFileAction,
  runOpenCommand,
  type RunOpen,
} from "../open-file.ts";
import { openDatabase, migrate, type Db } from "../store/index.ts";
import { UploadError, resolveUpload, saveUpload } from "../uploads.ts";
import type { ServeTargetKind, TailnetSelf } from "../platform/index.ts";
import { parsePresence, type PresenceBoard } from "../push/presence.ts";
import { parseSubscription, type PushSubscriptionRecord } from "../push/subscriptions.ts";
import { LOGIN_LINK_FRAGMENT_KEY, LOGIN_LINK_PAGE } from "./login-page.ts";
import { createBrowserSessions, createLoginLinks } from "./sessions.ts";
import { UI_TOKEN_PATTERN, newUiToken } from "./token.ts";

export interface UiServerOptions {
  ledger: Ledger;
  /** 界面用户令牌（“主钥匙”），见 loadOrCreateUiToken：用来登录、生成登录链接；浏览器 cookie 里放的是各自的随机会话令牌，不是它。 */
  token: string;
  /** 浏览器会话存哪（migrations/0015 的 browser_sessions）。不给就用只在内存里的库（测试用，重启即丢）。 */
  db?: Db;
  /** “全部退出”换主钥匙：守护进程在这里写 state/ui-token、打印新的登录链接，返回新令牌。不给就只在内存里换一个随机的。 */
  rotateToken?: () => string;
  /** 当前时间（毫秒），测试用：登录链接的有效期、会话的最后活动。 */
  now?: () => number;
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
  /** 事件流里没有额度的厂商的额度（daemon/quota/fetched-quota.ts 的 createFetchedQuota）。不给就回空。 */
  quota?: { get(): Promise<QuotaResponse> };
  /**
   * 输入框的“/”命令和“@”文件（daemon/composer.ts 的 createComposerService）。不给就回空列表（不查对话在不在）。
   */
  composer?: ComposerService;
  /** 弹“选择文件夹”的（daemon/pick-folder.ts）。不给就用真的 osascript（不是 macOS 回 501）；测试里传假的。 */
  folderPicker?: FolderPicker;
  /** 跑 macOS 的 open（在 Finder 中显示、用默认程序打开）。默认 execFile("open")（不是 macOS 回 501）；测试里换成假的，不真的打开。 */
  runOpen?: RunOpen;
  /** 这台机器能做什么，原样放进 /api/state 的 server，网页按它显示控件。默认按 process.platform（shared/server-info.ts）。 */
  serverInfo?: ServerInfo;
  /** 本机的 tailnet 名字和主人（daemon/platform/tailnet.ts 的探测，读缓存）。不给 = 只认本机 127.0.0.1，和联机之前一样。 */
  tailnet?: { current(): TailnetSelf | null };
  /** 推送（联机 P4，daemon/push/）：订阅接口和 WebSocket 上的前台上报。不给 = 推送接口 404，上报忽略。 */
  push?: {
    publicKey: string;
    subscribe(subscription: PushSubscriptionRecord): void;
    unsubscribe(endpoint: string): void;
    presence: PresenceBoard;
  };
  /** serve 转发到哪（daemon/platform/tailscale.ts）：unix 时 tailnet 名字只在 serve 的 socket 上认，TCP 端口只认本机。默认 tcp。 */
  serveTarget?: ServeTargetKind;
}

/** 登录 cookie 的有效期：一年（和库里会话的有效期一样，shared/limits.ts 的 SESSION_MAX_AGE_MS）。 */
const COOKIE_MAX_AGE_SECONDS = SESSION_MAX_AGE_MS / 1000;
/** 退出 / 全部退出时 WebSocket 被关的状态码（1008 policy violation）和原因。 */
const WS_CLOSE_UNAUTHORIZED = 1008;
/** clientId 是网页生成的 UUID 一类的串，限长免得拿它撑大去重键。 */
const MAX_CLIENT_ID_LENGTH = 200;
const POSITIVE_INT = /^[1-9]\d*$/;
const NON_NEGATIVE_INT = /^(0|[1-9]\d*)$/;
const HOST_HEADER = /^(?:127\.0\.0\.1|localhost):(\d+)$/i;
/** 浏览器发的 Origin 是 scheme://host:port，没有路径和末尾斜杠；主机名那三种跟 Host 检查一致。 */
const ORIGIN_HEADER = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)$/i;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** serve 的 https 默认端口：Host 可能带上 :443。 */
const HTTPS_DEFAULT_PORT_SUFFIX = ":443";
const SERVE_SOCKET_MODE = 0o600;

/** 从 serve 的 Unix socket 进来的请求（startUiServer 的 serveSocket）。按原始请求对象记。 */
const viaServeSocket = new WeakSet<IncomingMessage>();

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

/** 预览窗取文件时带 ?inline=1：pdf、html 才内联（放进 iframe 看），别的照旧当下载。 */
const wantsPreview = (req: FastifyRequest) => (req.query as { inline?: unknown }).inline === "1";
/** html 预览：脚本能跑，但 sandbox 没有 allow-same-origin，页面是“不透明来源”：拿不到 cookie、请求界面接口没有登录也过不了 Origin 检查。 */
const HTML_PREVIEW_CSP = "sandbox allow-scripts";

/**
 * 发一个存在数据目录里的文件（上传的、agent 发出的副本）。文件不可信：只有图片内联显示，别的一律当下载；
 * 禁止嗅探、CSP 沙箱化，直接打开地址也不会当网页执行（svg 里的脚本也不跑）。支持单段 Range（视频、大 PDF 拖动用）。
 * 例外：预览窗带 ?inline=1 取的 pdf 内联（CSP 不变，实测浏览器自带查看器在这样的响应里能渲染），html 内联并换成 HTML_PREVIEW_CSP。
 */
function sendStoredFile(req: FastifyRequest, reply: FastifyReply, file: Pick<Attachment, "name" | "path" | "size" | "mime">) {
  const preview = wantsPreview(req);
  const inline = isImageMime(file.mime) || (preview && (file.mime === "application/pdf" || file.mime === "text/html"));
  // 预览 html 是页面：没写 charset 的中文页面会按 Latin-1 显示成乱码，所以明说 UTF-8
  const contentType = preview && file.mime === "text/html" ? `${file.mime}; charset=utf-8` : file.mime;
  const csp = file.mime === SVG_MIME ? SVG_CSP : preview && file.mime === "text/html" ? HTML_PREVIEW_CSP : STORED_FILE_CSP;
  reply
    .header("content-type", contentType)
    .header("content-disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`)
    .header("x-content-type-options", "nosniff")
    .header("content-security-policy", csp)
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
  const serverInfo = opts.serverInfo ?? serverInfoFor(process.platform);
  // 默认的 open 只有 macOS 上有；不是 macOS 又没注入假的：回 501，不去起一个不存在的 open
  const runOpen: RunOpen =
    opts.runOpen ??
    (serverInfo.fileActions
      ? runOpenCommand
      : async () => {
          throw new FileActionsUnavailable();
        });
  if (!UI_TOKEN_PATTERN.test(opts.token)) throw new Error("ui token must be at least 16 characters of [A-Za-z0-9_-]");
  // 主钥匙：登录用；“全部退出”会换掉它
  let expectedToken = digest(opts.token);
  let ownedDb: Db | undefined;
  if (opts.db === undefined) {
    ownedDb = openDatabase(":memory:");
    migrate(ownedDb);
  }
  const sessions = createBrowserSessions((opts.db ?? ownedDb)!, { ...(opts.now ? { now: opts.now } : {}) });
  const loginLinks = createLoginLinks({ ...(opts.now ? { now: opts.now } : {}) });
  // 每个已登录浏览器连着的 WebSocket：退出时当场关掉，不等它自己断线
  const socketsBySession = new Map<string, Set<{ close(code?: number, reason?: string): void }>>();
  const closeSockets = (sessionId?: string) => {
    for (const [id, sockets] of socketsBySession) {
      if (sessionId !== undefined && id !== sessionId) continue;
      for (const socket of sockets) socket.close(WS_CLOSE_UNAUTHORIZED, "unauthorized");
      socketsBySession.delete(id);
    }
  };
  /** 这次请求是哪个会话（认证钩子里认出来的）。 */
  const sessionOf = new WeakMap<FastifyRequest, string>();
  const folderPicker = opts.folderPicker ?? createFolderPicker({ available: serverInfo.folderPicker });
  const app = Fastify({ logger: opts.logger ?? false });

  const listeningPort = (): number | undefined => {
    const addr = app.server.address();
    return addr !== null && typeof addr === "object" ? addr.port : opts.port;
  };

  /** cookie 名带着网址里的端口（uiCookieName）：同一浏览器里不同端口的界面各用各的。 */
  const sessionToken = (req: FastifyRequest) => readCookie(req.headers.cookie, uiCookieName(req.headers.host));

  const isAuthenticated = (req: FastifyRequest): boolean => {
    const session = sessions.authenticate(sessionToken(req));
    if (session === null) return false;
    sessionOf.set(req, session.id);
    return true;
  };

  /** 设（或清：value 空、maxAge 0）这个浏览器的会话 cookie。 */
  const sessionCookie = (req: FastifyRequest, value: string, maxAgeSeconds: number) =>
    // 经 serve 来的是 https：加 Secure。本机 http://127.0.0.1 不能加（浏览器会丢掉这个 cookie）
    `${uiCookieName(req.headers.host)}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${tailnetRequests.has(req.raw) ? "; Secure" : ""}`;

  /** 登录成功：开一个新会话、设 cookie。这个浏览器已经有会话就换掉（不让同一个浏览器的记录越堆越多）；满了被挤掉的和被换掉的一样，走撤销的路（关 WebSocket）。 */
  const startSession = (req: FastifyRequest, reply: FastifyReply) => {
    const previous = sessions.authenticate(sessionToken(req));
    if (previous !== null) {
      sessions.revoke(previous.id);
      closeSockets(previous.id);
    }
    const session = sessions.create({ userAgent: req.headers["user-agent"] ?? "", entry: req.headers.host ?? "" });
    for (const id of session.evicted) closeSockets(id);
    reply.header("set-cookie", sessionCookie(req, session.token, COOKIE_MAX_AGE_SECONDS)).header("referrer-policy", "no-referrer");
  };

  const fail = (reply: FastifyReply, statusCode: number, error: string, code?: LedgerErrorCode) =>
    reply.code(statusCode).send((code === undefined ? { error } : { error, code }) satisfies ApiErrorBody);

  const serveTarget = opts.serveTarget ?? "tcp";
  /** 经 serve 进来、已经过了 Host 和身份检查的请求 → 当时认的 tailnet 名字（Origin 要和它同源，cookie 加 Secure）。 */
  const tailnetRequests = new WeakMap<IncomingMessage, string>();

  // 防 DNS 重绑定：Host 必须是 127.0.0.1:<端口> 或 localhost:<端口>。所有路径都查，包括静态文件和 /auth。
  // 联机：或者是本机的 tailnet 名字（只在 serve 转发来的那条路上认），这时 serve 给的身份头必须是设备主人。
  // 身份头只是附加条件，不代替 cookie（本机别的进程能直连端口自己带这个头）。
  app.addHook("onRequest", async (req, reply) => {
    const host = req.headers.host ?? "";
    const fromServeSocket = viaServeSocket.has(req.raw);
    const local = fromServeSocket ? null : HOST_HEADER.exec(host);
    if (local !== null) {
      const port = listeningPort();
      if (port === undefined || Number(local[1]) !== port) return fail(reply, 403, "forbidden_host");
      return;
    }
    // 本机 Host 对上了就不看 tailnet，不碰探测
    const self = fromServeSocket === (serveTarget === "unix") ? (opts.tailnet?.current() ?? null) : null;
    const lowerHost = host.toLowerCase();
    if (self === null || (lowerHost !== self.dnsName && lowerHost !== self.dnsName + HTTPS_DEFAULT_PORT_SUFFIX)) {
      return fail(reply, 403, "forbidden_host");
    }
    const login = req.headers[TAILSCALE_USER_LOGIN_HEADER];
    if (self.owner === null || typeof login !== "string" || login.trim().toLowerCase() !== self.owner) {
      return fail(reply, 403, "forbidden_identity");
    }
    tailnetRequests.set(req.raw, self.dnsName);
  });

  /**
   * 判断“浏览器在不在这台机器上”用的地址（serverInfoForClient）。经 serve 来的也是从 127.0.0.1（macOS）或 socket 进来，
   * 但浏览器在别的设备上：当成没有地址（不是本机）。
   */
  const clientAddress = (req: FastifyRequest) => (tailnetRequests.has(req.raw) ? undefined : req.ip);

  // 防别的本机端口上的网页借 cookie 动手：浏览器认为 localhost 不同端口是同一个站点，SameSite=Strict 拦不住。
  // 会改状态的请求和 WebSocket 握手必须带同源的 Origin（http://<host>:<实际端口>），没带也拒绝；GET 不查。
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?", 1)[0] ?? "";
    if (SAFE_METHODS.has(req.method) && path !== API_PATHS.ws) return;
    // 经 serve 来的：只认 https://<本机 tailnet 名字>（serve 是 443，浏览器不写端口）
    const tailnetName = tailnetRequests.get(req.raw);
    if (tailnetName !== undefined) {
      if ((req.headers.origin ?? "").toLowerCase() !== `https://${tailnetName}`) return fail(reply, 403, "forbidden_origin");
      return;
    }
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

  app.setErrorHandler((err: FastifyError | ConversationNotFoundError | LedgerRequestError | UploadError | PickFolderError, req, reply) => {
    if (err instanceof PickFolderError) return fail(reply, err.statusCode, err.message);
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
  if (ownedDb !== undefined) app.addHook("onClose", async () => ownedDb.close());

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
      // 预览窗（?inline=1）按扩展名认类型：上传时只认图片，pdf、html 之类也要能放进 iframe
      const mime = wantsPreview(req) ? sentFileMime(attachment.name) : attachment.mime;
      return sendStoredFile(req, reply, { ...attachment, mime });
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
    // 登录有两条路：
    // - GET /auth?token=<主钥匙>：启动时打印的链接。
    // - 二维码的一次性链接 `/auth#link=<码>`：码在 # 片段里不会发给服务器（不进代理、访问日志，也不进 Referer）。
    //   GET /auth（不带参数）是读片段的落地页，页面再 POST /auth {link} 兑换。老的 /auth?link=<码> 不再认（码会进日志）。
    routes.get(API_PATHS.auth, async (req, reply) => {
      const { token, link } = req.query as { token?: unknown; link?: unknown };
      if (token === undefined && link === undefined) return reply.type("text/html; charset=utf-8").header("referrer-policy", "no-referrer").send(LOGIN_LINK_PAGE);
      if (token === undefined || link !== undefined || !tokenEquals(expectedToken, token)) return fail(reply, 401, "unauthorized");
      startSession(req, reply);
      return reply.redirect("/", 302);
    });

    routes.post(API_PATHS.auth, async (req, reply) => {
      const link = (req.body as { link?: unknown } | null | undefined)?.link;
      if (!loginLinks.consume(link)) return fail(reply, 401, "unauthorized");
      startSession(req, reply);
      return reply.code(204).send();
    });

    routes.get(API_PATHS.browserSessions, async (req): Promise<BrowserSessionsResponse> => {
      const current = sessionOf.get(req);
      return { sessions: sessions.list().map((s) => ({ ...s, current: s.id === current })) };
    });

    routes.delete("/api/sessions/:id", async (req, reply) => {
      const id = String((req.params as { id?: unknown }).id ?? "");
      if (!sessions.revoke(id)) return fail(reply, 404, "not_found");
      closeSockets(id);
      // 退的是自己：顺手把浏览器里的 cookie 清掉
      if (id === sessionOf.get(req)) reply.header("set-cookie", sessionCookie(req, "", 0));
      return reply.code(204).send();
    });

    // 全部退出 = 换主钥匙 + 清所有会话（包括自己）+ 作废没用掉的登录链接
    routes.post(API_PATHS.logoutAll, async (req, reply) => {
      const next = opts.rotateToken?.() ?? newUiToken();
      if (!UI_TOKEN_PATTERN.test(next)) throw new Error("rotated ui token must be at least 16 characters of [A-Za-z0-9_-]");
      expectedToken = digest(next);
      sessions.revokeAll();
      loginLinks.clear();
      closeSockets();
      return reply.header("set-cookie", sessionCookie(req, "", 0)).code(204).send();
    });

    routes.post(API_PATHS.loginLinks, async (req, reply) => {
      const { code, expiresAt } = loginLinks.issue();
      // 手机要扫得通得是 tailnet 名字：请求本来就是经 serve 来的，或本机认得 tailnet 名字（Mac 本机上点的，Host 是 127.0.0.1）就用它（https，serve 是 443）。
      // 都没有（没装 Tailscale、还没探到）保持现状：用请求的 Host（用户现在就是从这个地址进来的）；前面还有一层 https 转发时它会带 x-forwarded-proto。
      const tailnetName = tailnetRequests.get(req.raw) ?? opts.tailnet?.current()?.dnsName;
      const origin = tailnetName !== undefined ? `https://${tailnetName}` : `${req.headers["x-forwarded-proto"] === "https" ? "https" : "http"}://${req.headers.host}`;
      return reply.code(201).send({ url: `${origin}/auth#${LOGIN_LINK_FRAGMENT_KEY}=${code}`, expiresAt } satisfies LoginLinkResponse);
    });

    routes.get(API_PATHS.state, async (req): Promise<StateSnapshot> => ({ ...ledger.snapshot(), server: serverInfoForClient(serverInfo, clientAddress(req)) }));

    routes.get(API_PATHS.models, async (req): Promise<ModelsResponse> => {
      const refresh = (req.query as { refresh?: unknown }).refresh === "1";
      return { catalogs: opts.models ? await opts.models.list({ refresh }) : AGENT_VENDORS.map((v) => bundledModelCatalog(v)) };
    });

    routes.get(API_PATHS.quota, async (): Promise<QuotaResponse> => (opts.quota ? await opts.quota.get() : { groups: [] }));

    // 输入框的“/”列表、“@”列表：后台按对话找目录和厂商，网页不传路径；问不到给空列表
    routes.get("/api/conversations/:id/commands", async (req): Promise<CommandsResponse> => {
      const conversationId = parseId((req.params as { id?: unknown }).id, "conversation id");
      return opts.composer ? opts.composer.commands(conversationId) : { commands: [] };
    });

    routes.get("/api/conversations/:id/files", async (req): Promise<FilesResponse> => {
      const conversationId = parseId((req.params as { id?: unknown }).id, "conversation id");
      const { q } = req.query as { q?: unknown };
      return opts.composer ? opts.composer.files(conversationId, typeof q === "string" ? q : "") : { entries: [], truncated: false };
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

    // 在 Finder 中显示 / 用默认程序打开（open-file.ts）。只收“哪条消息的第几个文件”或上传编号，不收路径。
    const doFileAction = async (reply: FastifyReply, run: () => Promise<FileActionResponse>) => {
      try {
        return await run();
      } catch (error) {
        if (error instanceof OpenTargetMissing) return fail(reply, 404, "not_found");
        if (error instanceof OpenNotAllowed) return fail(reply, 403, OPEN_NOT_ALLOWED_MESSAGE);
        if (error instanceof FileActionsUnavailable) return fail(reply, 501, FILE_ACTIONS_UNAVAILABLE_MESSAGE);
        console.error("ui-server open failed:", error);
        return fail(reply, 500, "没能打开这个文件");
      }
    };
    // 浏览器不在这台机器上（手机、别的电脑）：open 会开在守护进程这台机器的屏幕上，不是用户眼前的那台
    const requireLocal = (req: FastifyRequest): void => {
      if (!isLoopbackAddress(clientAddress(req))) throw new FileActionsUnavailable();
    };
    const parseAction = (raw: unknown): FileAction | null => ((FILE_ACTIONS as readonly unknown[]).includes(raw) ? (raw as FileAction) : null);

    routes.post("/api/messages/:id/files/:index/:action", async (req, reply) => {
      const { id, index, action } = req.params as Record<string, unknown>;
      const act = parseAction(action);
      const message = typeof id === "string" && POSITIVE_INT.test(id) ? ledger.getMessage(Number(id)) : null;
      const file = message === null || typeof index !== "string" || !NON_NEGATIVE_INT.test(index) ? undefined : sentFilesOf(message)[Number(index)];
      if (act === null || message === null || file === undefined || file.id === null) return fail(reply, 404, "not_found");
      const copy = resolveUpload(sentFilesDir, file.id);
      const sessionId = message.sessionId;
      return doFileAction(reply, async () => {
        requireLocal(req);
        return performFileAction(
          act,
          {
            original: file.path,
            isAllowed: (real) => sessionId !== null && ledger.sentFileAllows(sessionId, real),
            copy: copy?.path ?? null,
            name: file.name,
          },
          runOpen,
        );
      });
    });

    routes.post("/api/attachments/:id/:action", async (req, reply) => {
      const { id, action } = req.params as Record<string, unknown>;
      const act = parseAction(action);
      const attachment = resolveUpload(uploadsDir, String(id ?? ""));
      if (act === null || attachment === null) return fail(reply, 404, "not_found");
      return doFileAction(reply, async () => {
        requireLocal(req);
        return performFileAction(act, { original: null, isAllowed: () => false, copy: attachment.path, name: attachment.name }, runOpen);
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

    // 定时任务卡片：校验和写库都在账本里（同 hub schedule），这里只认请求体的形状
    routes.post("/api/pms/:id/schedules", async (req, reply) => {
      const pmId = parseId((req.params as { id?: unknown }).id, "pm id");
      const raw = parseObjectBody(req.body, ["name", "prompt", "daily", "everyMinutes"]);
      const schedule = ledger.addSchedule(pmId, {
        name: raw.name as string,
        prompt: raw.prompt as string,
        ...(raw.daily !== undefined ? { daily: raw.daily as string } : {}),
        ...(raw.everyMinutes !== undefined ? { everyMinutes: raw.everyMinutes as number } : {}),
      });
      return reply.code(201).send(schedule);
    });

    routes.put("/api/schedules/:id", async (req) => {
      const raw = parseObjectBody(req.body, ["enabled"]);
      if (typeof raw.enabled !== "boolean") throw new HttpError(400, "enabled must be a boolean");
      return ledger.setScheduleEnabled(parseId((req.params as { id?: unknown }).id, "schedule id"), raw.enabled);
    });

    routes.delete("/api/schedules/:id", async (req, reply) => {
      ledger.removeSchedule(parseId((req.params as { id?: unknown }).id, "schedule id"));
      return reply.code(204).send();
    });

    routes.post(API_PATHS.pickFolder, async (req): Promise<PickFolderResponse> => {
      const raw = parseObjectBody(req.body ?? {}, ["startDir"]);
      const startDir = raw.startDir === undefined ? undefined : requireBoundedBytes(raw.startDir, "startDir", MAX_PATH_BYTES);
      return { path: await folderPicker.pick(startDir) };
    });

    routes.post("/api/pms/:id/renew-session", async (req, reply) => {
      const result = ledger.renewSession(parseId((req.params as { id?: unknown }).id, "pm id"));
      return reply.code(202).send({ handoverId: result.handoverId } satisfies RenewSessionResponse);
    });

    routes.post("/api/messages/:id/retry", async (req, reply) => {
      const result = ledger.retryMessage(parseId((req.params as { id?: unknown }).id, "message id"));
      return reply.code(202).send({ messageId: result.messageId } satisfies RetryMessageResponse);
    });

    // 推送订阅（联机 P4）：只在开了推送的服务上有
    const push = opts.push;
    if (push !== undefined) {
      routes.get(API_PATHS.pushKey, async (): Promise<PushKeyResponse> => ({ publicKey: push.publicKey }));
      routes.post(API_PATHS.pushSubscriptions, async (req, reply) => {
        const subscription = parseSubscription(req.body);
        if (subscription === null) return fail(reply, 400, "订阅内容不对", "invalid");
        push.subscribe(subscription);
        return reply.code(204).send();
      });
      routes.post(API_PATHS.pushUnsubscribe, async (req, reply) => {
        const { endpoint } = (req.body ?? {}) as { endpoint?: unknown };
        if (typeof endpoint !== "string") return fail(reply, 400, "endpoint 不对", "invalid");
        push.unsubscribe(endpoint);
        return reply.code(204).send();
      });
    }

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
      // 网页 → 服务端只有前台上报（WsClientMessage）；别的、坏的忽略
      if (push !== undefined) {
        socket.on("message", (data: Buffer, isBinary: boolean) => {
          const message = isBinary ? null : parsePresence(data.toString("utf8"));
          if (message !== null) push.presence.report(socket, message);
        });
        const forget = () => push.presence.remove(socket);
        socket.once("close", forget);
        socket.once("error", forget);
      }
      // 记下这条连接属于哪个会话：那个会话被退出时当场关掉
      const sessionId = sessionOf.get(req);
      if (sessionId !== undefined) {
        const sockets = socketsBySession.get(sessionId) ?? new Set();
        sockets.add(socket);
        socketsBySession.set(sessionId, sockets);
        socket.once("close", () => {
          sockets.delete(socket);
          if (sockets.size === 0 && socketsBySession.get(sessionId) === sockets) socketsBySession.delete(sessionId);
        });
      }

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

/**
 * serve 转发用的 Unix socket：另起一个 HTTP 服务，收到的请求（含 WebSocket 握手）记下“从 socket 来的”，交给同一个 Fastify 处理。
 * 残留的 socket 文件直接删（调用方拿着数据目录锁，不会有另一个守护进程在听）；那里是别的东西就报错。
 */
async function listenServeSocket(app: FastifyInstance, socketPath: string): Promise<Server> {
  try {
    if (!lstatSync(socketPath).isSocket()) throw new Error(`界面服务的 socket 路径上已经有别的东西，不是 socket：${socketPath}。请确认后手动移走。`);
    unlinkSync(socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const server = createServer((req, res) => {
    viaServeSocket.add(req);
    app.routing(req, res);
  });
  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    viaServeSocket.add(req);
    app.server.emit("upgrade", req, socket, head);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(socketPath, SERVE_SOCKET_MODE);
  return server;
}

/**
 * 只监听 127.0.0.1，不提供改地址的选项。port 为 0 时由系统分配，实际端口看返回值。
 * serveSocket：再听一个 Unix socket 给 tailscale serve 转发（serveTarget 为 unix 时，daemon/platform/tailscale.ts）。
 */
export async function startUiServer(opts: UiServerOptions & { port: number; serveSocket?: string }): Promise<RunningUiServer> {
  const app = createUiServer(opts);
  await app.listen({ host: "127.0.0.1", port: opts.port });
  const addr = app.server.address();
  if (addr === null || typeof addr !== "object") throw new Error("ui-server is not listening on a TCP port");
  let serveServer: Server | undefined;
  if (opts.serveSocket !== undefined) {
    try {
      serveServer = await listenServeSocket(app, opts.serveSocket);
    } catch (err) {
      await app.close();
      throw err;
    }
  }
  const close = async () => {
    if (serveServer === undefined) return app.close();
    const closed = new Promise<void>((resolve) => serveServer.close(() => resolve()));
    // 先关 Fastify（断开 WebSocket），再断 socket 上剩下的连接；socket 文件由 Node 在关闭时删掉
    await app.close();
    serveServer.closeAllConnections();
    await closed;
  };
  return { app, port: addr.port, close };
}
