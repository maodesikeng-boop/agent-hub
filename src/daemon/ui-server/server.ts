// 界面服务（设计第 4.2、4.3 节；m1-plan 第 3 节接口约定第 1、2 条）：HTTP + WebSocket，只监听 127.0.0.1。
// 组网入口（docs/account-mesh-design.md「连法」）：别的设备经双向认证的 TLS 连进来（daemon/mesh/），握手认出是哪台后交给这里
// （startUiServer 返回的 acceptMeshConnection），只认 TLS 证书，不看任何头。
// 两种入口各认什么、查什么，见 Entry 和 createUiServer 里的 entryRules。
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import fastifyCompress from "@fastify/compress";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AGENT_VENDORS,
  API_PATHS,
  REFRESH_UNUSABLE,
  ConversationNotFoundError,
  LedgerRequestError,
  MAX_DECISION_CHOICE_CHARS,
  MAX_DECISION_NOTE_CHARS,
  MAX_MESSAGE_BYTES,
  MAX_MODEL_CHARS,
  MAX_NODE_KEY_CHARS,
  MAX_PATH_BYTES,
  MAX_PERSONA_BYTES,
  MAX_REASON_CHARS,
  MAX_VENDOR_SYNC_KEY_CHARS,
  MAX_VENDOR_SYNC_MCP_ITEMS,
  MAX_VENDOR_SYNC_SKILL_ITEMS,
  PROVIDER_API_KEY_MAX_CHARS,
  PROVIDER_AUTH_INPUT_MAX_CHARS,
  ATTACHMENTS_MISSING_MESSAGE,
  ATTACHMENTS_TOO_MANY_MESSAGE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_CONCURRENT_UPLOADS,
  MAX_UPLOAD_BYTES,
  PM_CAPABILITY_PATCH_MAX_KEYS,
  PM_MODES,
  ROUTER_COMMAND_MAX_CHARS,
  SESSION_MAX_AGE_MS,
  uiCookieName,
  UPLOAD_BUSY_MESSAGE,
  UPLOAD_TOO_LARGE_MESSAGE,
  bundledModelCatalog,
  FILE_ACTIONS,
  isAgentVendor,
  isValidCapabilityKey,
  isImageMime,
  normalizeName,
  sentFileMime,
  sentFilesOf,
  serverInfoFor,
  isLoopbackAddress,
  serverInfoForClient,
  vendorSpec,
  DEVICE_PROXY_PREFIX,
  ENTRY_ONLY_API_PREFIXES,
  PEER_CLIENT_SCOPE_HEADER,
  utf8Bytes,
  type AgentVendor,
  type ArchiveAllReportsResponse,
  type ArchivePmResponse,
  type AuthStatusResponse,
  type BrowserSessionsResponse,
  type CancelTaskGraphResponse,
  type DecideTaskNodeResponse,
  type RecheckUserBlockerResponse,
  type DeviceId,
  type DeviceRouterDigest,
  type LoginLinkResponse,
  CONVERSATION_LOOKUP_MAX_IDS,
  type CommandsResponse,
  type ConversationsLookup,
  type EndedWorkersPage,
  type FilesResponse,
  type Attachment,
  type CreatePmRequest,
  type CreatePmResponse,
  type EditPersonaRequest,
  type EditPersonaResponse,
  isJellyColorId,
  isPmFruit,
  type JellyColorId,
  type PmFruit,
  type PmLookRequest,
  type PmLookResponse,
  type FileAction,
  type FileActionResponse,
  type Ledger,
  type ModelCatalog,
  type ModelsResponse,
  type QuotaResponse,
  type PersonaResponse,
  type PickFolderResponse,
  type CapabilityBase,
  type CapabilityIsolationMap,
  type CapabilityKind,
  type PmCapabilitiesPatch,
  type PmCapabilitiesView,
  type PmMemoryFileResponse,
  type PmMemoryFilesResponse,
  type PmMode,
  type PostMessageResponse,
  type PostRouterCommandResponse,
  type ProviderCancelAuthRequest,
  type ProviderCancelJobRequest,
  type ProviderLogoutRequest,
  type ProviderSaveApiKeyRequest,
  type ProviderStartAuthRequest,
  type ProviderStatusItem,
  type ProviderSubmitAuthRequest,
  type ProvidersStatusResponse,
  type PushKeyResponse,
  type PutPmMemoryFileResponse,
  type RenewSessionResponse,
  type ResolveRouterItemRequest,
  type ResolveRouterItemResponse,
  type RetryMessageResponse,
  type RewindMessageResponse,
  type RouterCommandsPage,
  type RouterItemsPage,
  type ServerInfo,
  type SkipTaskNodeResponse,
  type StateSnapshot,
  type TurnReplyView,
  type SelfReloadRequestBody,
  type SelfReloadResponse,
  type SelfReloadStatus,
  SELF_RELOAD_UNSUPPORTED_MESSAGE,
  type TaskGraphsPage,
  type UpdateRouterSettingsResponse,
  type VendorSyncApplyRequest,
  type VendorSyncApplyResponse,
  type VendorSyncPreviewResponse,
  type WorkerPick,
  type WsServerMessage,
} from "../../shared/index.ts";
import { workerPickSchema } from "../../shared/worker-pick-schema.ts";
import { API_ERRORS, errorBody, type ApiErrorCode } from "../../shared/errors.ts";
import type { ComposerService } from "../composer.ts";
import { ProviderRequestError, type ProviderManager } from "../provider-manager/index.ts";
import type { CapabilityInventoryService } from "../pm-capabilities/inventory.ts";
import type { VendorSyncService } from "../vendor-sync/index.ts";
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
import { keepAlive } from "../ws-keepalive.ts";
import type { Mesh, MeshConnection } from "../mesh/index.ts";
import { isCompressibleType, peerRoutes, type PeerRoutesOptions, type Peers } from "../peers/index.ts";
import { parsePresence, type PresenceBoard } from "../push/presence.ts";
import { parseSubscription, type PushSubscriptionRecord } from "../push/subscriptions.ts";
import { LOGIN_LINK_FRAGMENT_KEY, LOGIN_LINK_PAGE } from "./login-page.ts";
import { createBrowserSessions, createLoginLinks } from "./sessions.ts";
import {
  FeishuSetupError,
  feishuChatPolicyBodySchema,
  feishuCredentialsSchema,
  feishuDisconnectSchema,
  type FeishuSetupService,
} from "../feishu/setup.ts";
import { UI_TOKEN_PATTERN, newUiToken } from "./token.ts";
import {
  RouterTargetError,
  routerTargetOpSchema,
  type RouterDispatcher,
  type RouterTargetPort,
} from "../router/index.ts";

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
  models?: { list(options?: { refresh?: boolean | "unusable"; vendor?: AgentVendor }): Promise<ModelCatalog[]> };
  /** 事件流里没有额度的厂商的额度（daemon/quota/fetched-quota.ts 的 createFetchedQuota）。不给就回空。 */
  quota?: { get(): Promise<QuotaResponse> };
  /**
   * 输入框的“/”命令和“@”文件（daemon/composer.ts 的 createComposerService）。不给就回空列表（不查对话在不在）。
   */
  composer?: ComposerService;
  /** 全厂商连接器 / MCP / Skill 并集同步服务（daemon/vendor-sync/）。不给则 preview 回空列表、apply 回 501。 */
  vendorSync?: VendorSyncService;
  /** 本机各厂商能力库存服务（daemon/pm-capabilities/inventory.ts）。不给则 GET/PATCH 里的 inventory 为空列表。 */
  capabilityInventory?: CapabilityInventoryService;
  /** Settings → Providers 一键安装与界面内直接登录管理服务（daemon/provider-manager/）。不给则 GET 回空、写接口回 501。 */
  providers?: ProviderManager;
  /** 弹“选择文件夹”的（daemon/pick-folder.ts）。不给就用真的 osascript（不是 macOS 回 501）；测试里传假的。 */
  folderPicker?: FolderPicker;
  /** 跑 macOS 的 open（在 Finder 中显示、用默认程序打开）。默认 execFile("open")（不是 macOS 回 501）；测试里换成假的，不真的打开。 */
  runOpen?: RunOpen;
  /** 这台机器能做什么，原样放进 /api/state 的 server，网页按它显示控件。默认按 process.platform（shared/server-info.ts）。 */
  serverInfo?: ServerInfo;
  /** 推送（联机 P4，daemon/push/）：订阅接口和 WebSocket 上的前台上报。不给 = 推送接口 404，上报忽略。 */
  push?: {
    publicKey: string;
    subscribe(subscription: PushSubscriptionRecord): void;
    unsubscribe(endpoint: string): void;
    presence: PresenceBoard;
  };
  /** 飞书（docs/feishu-design.md，daemon/feishu/）：设置接口 /api/feishu/*，和终端命令共用一份。不给 = 这些接口回 unavailable。 */
  feishu?: FeishuSetupService;
  /**
   * 联机（daemon/peers/）：设备列表、入口转发。不给 = 没有 /api/devices、/api/peer/*、/d/，组网入口来的请求一律 401。
   * 组网入口来的设备能访问的：/api/ 下除了 ENTRY_ONLY_API_PREFIXES 的；不能用 /d/、/auth。
   */
  peers?: Peers;
  /** 账号组网（daemon/mesh/）：/api/account*、/api/peer/trust；组网入口来的设备按它的信任表再认一次。状态一变给浏览器推 account.updated。 */
  mesh?: NonNullable<PeerRoutesOptions["mesh"]> & Pick<Mesh, "onChange" | "trust">;
  /** 全账号单飞书机器人的跨机同步与转发接口（/api/peer/feishu/*）。 */
  feishuPeer?: PeerRoutesOptions["feishuPeer"];
  /** 入口转发的可调项（测试里换 fetch、调短心跳）。 */
  peerProxy?: PeerRoutesOptions["proxy"];
  /** /api/ws 给浏览器发心跳的间隔（ws-keepalive.ts），默认 WS_HEARTBEAT_MS；测试调短。 */
  wsHeartbeatMs?: number;
  /** Router 跨设备分派引擎（处理本机 /api/router/commands 发令与重试）。 */
  routerDispatcher?: RouterDispatcher;
  /** 本机 Router 目标端口（供远端对等设备经 /api/router/target-ops 执行操作）。 */
  routerLocalPort?: RouterTargetPort;
  /** 空闲排空热重启（daemon/self-reload.ts）：POST/GET /api/self-reload。不给 = 守护进程没有外壳监管，POST 回 409。 */
  selfReload?: {
    request(input: { build: boolean; by: string }): SelfReloadResponse;
    status(): SelfReloadStatus;
  };
}

/** 仓库根目录（打包产物、自热重启找代码用）。 */
export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

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

/**
 * 请求从哪来：界面端口（127.0.0.1 TCP），或组网入口（startUiServer 的 acceptMeshConnection 交进来的 TLS 连接）。
 * 组网入口的请求记进 listenerOf 再交给同一个 Fastify；没记的是界面端口。
 */
type Listener = "uiPort" | "mesh";
const listenerOf = new WeakMap<IncomingMessage, Listener>();
/** 组网入口的连接是哪台设备的（TLS 握手时按证书认出来的）。 */
const meshPeerOf = new WeakMap<object, DeviceId>();

/** 请求从哪个入口进来：每个请求在第一个钩子里按“在哪听到的 + Host”定一次（resolveEntry），之后各处都按它和 EntryRule 办。 */
type Entry =
  /** 本机浏览器：界面端口，Host 是 127.0.0.1 / localhost:<界面端口>。 */
  | { kind: "loopback" }
  /** 组网入口：账号里的别的设备（TLS 证书认出来的）。 */
  | { kind: "mesh" };
type EntryKind = Entry["kind"];

/** 请求带的身份。 */
type Identity =
  /** 已登录浏览器的会话 cookie（只在 /api/、/d/ 上查）。 */
  | { kind: "cookie"; sessionId: string }
  /** 组网入口来的设备：别的设备，或别的设备转发来的浏览器请求。 */
  | { kind: "meshDevice"; peer: DeviceId }
  | { kind: "none" };
type IdentityKind = Exclude<Identity["kind"], "none">;

/** 定入口时被拒的原因（403）。 */
type EntryRejection = "forbidden_host" | "forbidden_identity";

/** 每种入口的规则（createUiServer 里的 entryRules）。加一种入口 = 在 Entry 里加一种、表里加一行。 */
interface EntryRule {
  /** 在哪几个地方听到的请求可能是这种入口。同一个地方有几种时按表里的顺序认 Host。 */
  listeners: readonly Listener[];
  /** 查 Host：是这种入口回 Entry，不是回 null（试下一种），是但不放行回原因。null = 不查 Host，听到就是。 */
  host: ((req: FastifyRequest) => Entry | EntryRejection | null) | null;
  /** cookie 身份的改状态请求和 WebSocket 握手：Origin 要对上的。null = 不查（这个入口不认 cookie）。 */
  origin: ((origin: string, entry: Entry) => boolean) | null;
  /** 认哪些身份。 */
  identities: readonly IdentityKind[];
  /** 浏览器算不算在这台机器上（serverInfoForClient：出不出“在 Finder 中显示”）。 */
  sameMachine: boolean;
  /** 能不能碰浏览器才用的：/auth、静态文件、/d/ 转发、ENTRY_ONLY_API_PREFIXES。能的入口上也只有 cookie 身份能碰。 */
  browserPaths: boolean;
}

/** 认出入口和身份之后记下的（按原始请求对象记，WebSocket 握手和 HTTP 一样）。 */
interface RequestContext {
  entry: Entry;
  rule: EntryRule;
  identity: Identity;
}

/** 桌面外壳监管契约标识（与 apps/desktop/contract.json 锁死一致，由 auth-status.test.ts 校验）。 */
export const DESKTOP_PRODUCT = "fusa" as const;
export const DESKTOP_PROTOCOL_VERSION = 1 as const;

export interface DesktopAuthStatusResponse extends AuthStatusResponse {
  product: typeof DESKTOP_PRODUCT;
  protocolVersion: typeof DESKTOP_PROTOCOL_VERSION;
  instanceId: string;
}

export interface DesktopHealthResponse {
  ok: true;
  product: typeof DESKTOP_PRODUCT;
  protocolVersion: typeof DESKTOP_PROTOCOL_VERSION;
  instanceId: string;
}

const pathOf = (req: FastifyRequest) => req.url.split("?", 1)[0] ?? "";
/** 组网入口来的设备能碰的：/api/ 下除了入口专用的（不能借本机的转发 /d/ 去别的设备，也不能碰 /auth、静态文件）。 */
const inDeviceScope = (path: string) => path.startsWith("/api/") && !ENTRY_ONLY_API_PREFIXES.some((prefix) => path.startsWith(prefix));

const STATUS_TO_CODE: Readonly<Record<number, ApiErrorCode>> = {
  400: "invalid",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "too_large",
  429: "busy",
  501: "unavailable",
};
const codeOfStatus = (status: number): ApiErrorCode => STATUS_TO_CODE[status] ?? "internal";

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

function parseWithSchema<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues[0]?.message ?? "invalid request");
  }
  return parsed.data;
}

const positiveIntIdSchema = z
  .string()
  .regex(POSITIVE_INT)
  .transform(Number)
  .refine(Number.isSafeInteger, "must be a safe integer");

function parseId(raw: unknown, what: string): number {
  const parsed = positiveIntIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, `${what} must be a positive integer`);
  }
  return parsed.data;
}

const boundedBytesSchema = (maxBytes: number, what: string) =>
  z.string().refine((s) => utf8Bytes(s) <= maxBytes, `${what} must be at most ${maxBytes} bytes`);

const boundedCharsSchema = (maxChars: number, what: string) =>
  z.string().refine((s) => [...s].length <= maxChars, `${what} must be at most ${maxChars} characters`);

const nameSchema = z.string().refine((s) => normalizeName(s) !== null, "invalid name");
const modeSchema = z.enum(PM_MODES);
const vendorSchema = z.enum(AGENT_VENDORS);
const optionalSettingSchema = (what: string) => boundedCharsSchema(MAX_MODEL_CHARS, what).nullable();

const pmCapabilitiesStartSchema = z.discriminatedUnion("from", [
  z.object({ from: z.literal("all") }).strict(),
  z.object({ from: z.literal("pm"), pmId: z.number().int().positive() }).strict(),
]);

const pmFruitSchema = z.string().refine(isPmFruit, "unknown fruit").transform((s) => s as PmFruit);
const jellyColorSchema = z.string().refine(isJellyColorId, "unknown color").transform((s) => s as JellyColorId);

/** PUT /api/pms/:id/look：两项都要给，null 是回到默认。 */
const pmLookBodySchema = z.object({ fruit: pmFruitSchema.nullable(), color: jellyColorSchema.nullable() }).strict();

function parsePmLookBody(body: unknown): PmLookRequest {
  return parseWithSchema(pmLookBodySchema, body);
}

const createPmBodySchema = z
  .object({
    name: nameSchema,
    mode: modeSchema,
    persona: boundedBytesSchema(MAX_PERSONA_BYTES, "persona"),
    vendor: vendorSchema.optional(),
    defaultModel: optionalSettingSchema("defaultModel").optional(),
    effort: optionalSettingSchema("effort").optional(),
    // 主文件夹可选；给了就必须是个非空路径（存不存在、是不是目录由账本查）
    folder: boundedBytesSchema(MAX_PATH_BYTES, "folder")
      .refine((s) => s.trim() !== "" && !s.includes("\u0000"), "folder must be a non-empty path")
      .optional(),
    capabilities: pmCapabilitiesStartSchema.optional(),
    look: z.object({ fruit: pmFruitSchema, color: jellyColorSchema }).strict().optional(),
  })
  .strict();

function parseCreatePmBody(body: unknown): CreatePmRequest {
  const raw = parseWithSchema(createPmBodySchema, body);
  return {
    name: raw.name,
    mode: raw.mode,
    persona: raw.persona,
    ...(raw.vendor !== undefined ? { vendor: raw.vendor } : {}),
    ...(raw.defaultModel !== undefined ? { defaultModel: raw.defaultModel } : {}),
    ...(raw.effort !== undefined ? { effort: raw.effort } : {}),
    ...(raw.folder !== undefined ? { folder: raw.folder } : {}),
    ...(raw.capabilities !== undefined ? { capabilities: raw.capabilities } : {}),
    ...(raw.look !== undefined ? { look: raw.look } : {}),
  };
}

const capabilityBaseSchema = z.enum(["all", "none"]);

const patchPmCapabilitiesBodySchema = z
  .object({
    base: z
      .object({
        skill: capabilityBaseSchema.optional(),
        mcp: capabilityBaseSchema.optional(),
        connector: capabilityBaseSchema.optional(),
      })
      .strict()
      .optional(),
    set: z
      .record(
        z.string().refine((k) => isValidCapabilityKey(k), "invalid capability key"),
        z.boolean().nullable(),
      )
      .refine(
        (rec) => Object.keys(rec).length <= PM_CAPABILITY_PATCH_MAX_KEYS,
        `at most ${PM_CAPABILITY_PATCH_MAX_KEYS} capability keys`,
      )
      .optional(),
  })
  .strict()
  .refine(
    (obj) =>
      (obj.base !== undefined && Object.keys(obj.base).length > 0) ||
      (obj.set !== undefined && Object.keys(obj.set).length > 0),
    "at least one of base or set must be non-empty",
  );

function parsePatchPmCapabilitiesBody(body: unknown): PmCapabilitiesPatch {
  const raw = parseWithSchema(patchPmCapabilitiesBodySchema, body);
  let base: Partial<Record<CapabilityKind, CapabilityBase>> | undefined;
  if (raw.base !== undefined) {
    base = {
      ...(raw.base.skill !== undefined ? { skill: raw.base.skill } : {}),
      ...(raw.base.mcp !== undefined ? { mcp: raw.base.mcp } : {}),
      ...(raw.base.connector !== undefined ? { connector: raw.base.connector } : {}),
    };
  }
  return {
    ...(base !== undefined && Object.keys(base).length > 0 ? { base } : {}),
    ...(raw.set !== undefined ? { set: raw.set } : {}),
  };
}

function vendorIsolationMap(): Readonly<Partial<Record<AgentVendor, CapabilityIsolationMap>>> {
  return Object.fromEntries(AGENT_VENDORS.map((v) => [v, vendorSpec(v).capabilities.isolation]));
}

function vendorPluginIsolationMap(): Readonly<Partial<Record<AgentVendor, Partial<CapabilityIsolationMap>>>> {
  return Object.fromEntries(
    AGENT_VENDORS.flatMap((v) => {
      const plugin = vendorSpec(v).capabilities.pluginIsolation;
      return plugin === undefined ? [] : [[v, plugin]];
    }),
  );
}

const editPersonaBodySchema = z
  .object({
    text: boundedBytesSchema(MAX_PERSONA_BYTES, "text").optional(),
    mode: modeSchema.optional(),
    vendor: vendorSchema.optional(),
    model: optionalSettingSchema("model").optional(),
    effort: optionalSettingSchema("effort").optional(),
    reason: boundedCharsSchema(MAX_REASON_CHARS, "reason").optional(),
  })
  .strict()
  .refine(
    (v) => v.text !== undefined || v.mode !== undefined || v.vendor !== undefined || v.model !== undefined || v.effort !== undefined,
    "one of text, mode, vendor, model, effort is required",
  );

function parseEditPersonaBody(body: unknown): EditPersonaRequest {
  const raw = parseWithSchema(editPersonaBodySchema, body);
  return {
    ...(raw.text !== undefined ? { text: raw.text } : {}),
    ...(raw.mode !== undefined ? { mode: raw.mode } : {}),
    ...(raw.vendor !== undefined ? { vendor: raw.vendor } : {}),
    ...(raw.model !== undefined ? { model: raw.model } : {}),
    ...(raw.effort !== undefined ? { effort: raw.effort } : {}),
    ...(raw.reason !== undefined ? { reason: raw.reason } : {}),
  };
}

const postMessageBodySchema = z.object({
  clientId: z.string().min(1).max(MAX_CLIENT_ID_LENGTH),
  text: z.string(),
  attachmentIds: z.array(z.string()).optional(),
  workerPick: workerPickSchema.optional(),
});

function parsePostBody(body: unknown): { clientId: string; text: string; attachmentIds: string[]; workerPick?: WorkerPick } {
  const { clientId, text, attachmentIds: rawIds, workerPick } = parseWithSchema(postMessageBodySchema, body);
  const ids = [...new Set(rawIds ?? [])];
  if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new LedgerRequestError("invalid", ATTACHMENTS_TOO_MANY_MESSAGE);
  // 只发文件的时候文字可以是空的
  if (text.trim().length === 0 && ids.length === 0) throw new HttpError(400, "text must not be empty");
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
    throw new HttpError(400, `text must be at most ${MAX_MESSAGE_BYTES} bytes`);
  }
  return { clientId, text, attachmentIds: ids, ...(workerPick !== undefined ? { workerPick } : {}) };
}

const emptyObjectBodySchema = z.object({}).strict();
const addScheduleBodySchema = z
  .object({
    name: z.unknown().optional(),
    prompt: z.unknown().optional(),
    daily: z.unknown().optional(),
    everyMinutes: z.unknown().optional(),
  })
  .strict();
const setScheduleEnabledBodySchema = z.object({ enabled: z.boolean() }).strict();
const putPmMemoryFileBodySchema = z.object({ content: z.string() }).strict();
const pickFolderBodySchema = z.object({ startDir: boundedBytesSchema(MAX_PATH_BYTES, "startDir").optional() }).strict();
const pushUnsubscribeBodySchema = z.object({ endpoint: z.string() });

const resolveRouterItemBodySchema = z.union([
  z.object({ action: z.literal("archive") }).strict(),
  z
    .object({
      clientId: z.string().min(1).max(MAX_CLIENT_ID_LENGTH),
      optionIndex: z.number().int().nonnegative().nullable().optional(),
      choice: boundedCharsSchema(MAX_DECISION_CHOICE_CHARS, "choice").nullable().optional(),
      note: boundedCharsSchema(MAX_DECISION_NOTE_CHARS, "note").optional(),
    })
    .strict(),
]);

const decideRouterItemBodySchema = z
  .object({
    clientId: z.string().min(1).max(MAX_CLIENT_ID_LENGTH),
    optionIndex: z.number().int().nonnegative().nullable().optional(),
    choice: boundedCharsSchema(MAX_DECISION_CHOICE_CHARS, "choice").nullable().optional(),
    note: boundedCharsSchema(MAX_DECISION_NOTE_CHARS, "note").optional(),
  })
  .strict();

const postRouterCommandBodySchema = z
  .object({
    clientId: z.string().min(1).max(MAX_CLIENT_ID_LENGTH),
    text: boundedCharsSchema(ROUTER_COMMAND_MAX_CHARS, "text"),
    attachmentIds: z.array(z.string().min(1).max(100)).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
    target: z
      .object({
        deviceId: z.string().max(200).optional(),
        pmId: z.number().int().positive().optional(),
        projectId: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const updateRouterSettingsBodySchema = z
  .object({
    vendor: vendorSchema.nullable(),
    model: optionalSettingSchema("model"),
    effort: optionalSettingSchema("effort"),
  })
  .strict();

const decideTaskNodeBodySchema = z
  .object({
    clientId: z.string().min(1).max(MAX_CLIENT_ID_LENGTH),
    choice: boundedCharsSchema(MAX_DECISION_CHOICE_CHARS, "choice").nullable().optional(),
    note: boundedCharsSchema(MAX_DECISION_NOTE_CHARS, "note").nullable().optional(),
  })
  .strict();

const skipTaskNodeBodySchema = z
  .object({
    reason: boundedCharsSchema(MAX_DECISION_NOTE_CHARS, "reason").optional(),
  })
  .strict();

const cancelTaskGraphBodySchema = z
  .object({
    reason: boundedCharsSchema(MAX_DECISION_NOTE_CHARS, "reason").optional(),
  })
  .strict();

const syncItemKeySchema = boundedCharsSchema(MAX_VENDOR_SYNC_KEY_CHARS, "key").refine(
  (s) => s.trim() !== "" && !s.includes("\u0000"),
  "key must not be empty",
);

const vendorSyncApplyBodySchema = z
  .object({
    selectedMcpKeys: z.array(syncItemKeySchema).max(MAX_VENDOR_SYNC_MCP_ITEMS),
    removeMcpKeys: z.array(syncItemKeySchema).max(MAX_VENDOR_SYNC_MCP_ITEMS),
    selectedSkillKeys: z.array(syncItemKeySchema).max(MAX_VENDOR_SYNC_SKILL_ITEMS),
    removeSkillKeys: z.array(syncItemKeySchema).max(MAX_VENDOR_SYNC_SKILL_ITEMS),
    confirmedHostBoundMcpKeys: z.array(syncItemKeySchema).max(MAX_VENDOR_SYNC_MCP_ITEMS).optional(),
  })
  .strict();

const emptyStrictBodySchema = z.object({}).strict();

const providerCancelJobBodySchema = z
  .object({
    jobId: z.string().min(1).max(128),
  })
  .strict();

const providerStartAuthBodySchema = z
  .object({
    methodId: z.string().min(1).max(64),
    variantId: z.string().min(1).max(64).optional(),
    targetId: z.string().min(1).max(64).optional(),
    remoteHint: z.boolean().optional(),
  })
  .strict();

const providerSubmitAuthBodySchema = z
  .object({
    flowId: z.string().min(1).max(128),
    input: boundedCharsSchema(PROVIDER_AUTH_INPUT_MAX_CHARS, "input").refine(
      (s) => s.trim() !== "",
      "input must not be empty",
    ),
  })
  .strict();

const providerCancelAuthBodySchema = z
  .object({
    flowId: z.string().min(1).max(128),
  })
  .strict();

const providerSaveApiKeyBodySchema = z
  .object({
    targetId: z.string().min(1).max(64).optional(),
    apiKey: boundedCharsSchema(PROVIDER_API_KEY_MAX_CHARS, "apiKey").refine(
      (s) => s.trim() !== "",
      "apiKey must not be empty",
    ),
  })
  .strict();

const providerLogoutBodySchema = z
  .object({
    targetId: z.string().min(1).max(64).optional(),
  })
  .strict();

function parseVendorParam(raw: unknown): AgentVendor {
  if (typeof raw !== "string" || !isAgentVendor(raw)) {
    throw new HttpError(404, "unknown provider");
  }
  return raw;
}

/** 逗号分隔的编号列表（空串、不带都是空列表），最多 CONVERSATION_LOOKUP_MAX_IDS 个。 */
function parseIdList(raw: unknown, what: string): number[] {
  if (raw === undefined || raw === "") return [];
  if (typeof raw !== "string") throw new HttpError(400, `${what} must be a comma-separated list of positive integers`);
  const parts = raw.split(",");
  if (parts.length > CONVERSATION_LOOKUP_MAX_IDS) throw new HttpError(400, `${what} must have at most ${CONVERSATION_LOOKUP_MAX_IDS} items`);
  return parts.map((part) => parseId(part, what));
}

function parseOptionalPositiveInt(raw: unknown, what: string): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  return parseId(raw, what);
}

function parseNodeKeyParam(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "" || [...raw].length > MAX_NODE_KEY_CHARS) {
    throw new HttpError(400, "invalid nodeKey");
  }
  return raw;
}

/** Range 头（只认单段 bytes=a-b、bytes=a-、bytes=-n）：返回要发的闭区间；没带、认不出、无效是 null（发整个文件），超出文件是 "unsatisfiable"。 */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "unsatisfiable" {
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
  req.headers["x-no-compression"] = "1";
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
  const serverInfo =
    opts.serverInfo ?? {
      ...serverInfoFor(process.platform, { supervised: opts.selfReload !== undefined }),
      repoDir: ROOT_DIR,
    };
  // 默认的 open 只有 macOS 上有；不是 macOS 又没注入假的：回 501，不去起一个不存在的 open
  const runOpen: RunOpen =
    opts.runOpen ??
    (serverInfo.fileActions
      ? runOpenCommand
      : async () => {
          throw new FileActionsUnavailable();
        });
  if (!UI_TOKEN_PATTERN.test(opts.token)) throw new Error("ui token must be at least 16 characters of [A-Za-z0-9_-]");
  // 进程内唯一实例标识：供桌面外壳探活核验所有权与实例退出，纯内存常量，零查询零 I/O。
  const instanceId = randomUUID();
  // 主钥匙：登录用；“全部退出”会换掉它
  let expectedToken = digest(opts.token);
  let ownedDb: Db | undefined;
  if (opts.db === undefined) {
    ownedDb = openDatabase(":memory:");
    migrate(ownedDb);
  }
  const sessions = createBrowserSessions((opts.db ?? ownedDb)!, { ...(opts.now ? { now: opts.now } : {}) });
  const loginLinks = createLoginLinks({ ...(opts.now ? { now: opts.now } : {}) });
  const wsSenders = new Set<(message: WsServerMessage) => void>();
  const broadcastResync = () => {
    for (const send of wsSenders) send({ type: "resync" });
  };
  // 每个已登录浏览器连着的 WebSocket：退出时当场关掉，不等它自己断线
  const socketsBySession = new Map<string, Set<{ close(code?: number, reason?: string): void }>>();
  const closeSockets = (sessionId?: string) => {
    for (const [id, sockets] of socketsBySession) {
      if (sessionId !== undefined && id !== sessionId) continue;
      for (const socket of sockets) socket.close(WS_CLOSE_UNAUTHORIZED, "unauthorized");
      socketsBySession.delete(id);
    }
  };
  /** 每个请求认出来的入口和身份（认证钩子里定一次）。 */
  const contexts = new WeakMap<IncomingMessage, RequestContext>();
  const contextOf = (req: FastifyRequest) => contexts.get(req.raw);
  /** 这次请求是哪个会话（cookie 身份）。 */
  const sessionOf = (req: FastifyRequest) => {
    const identity = contextOf(req)?.identity;
    return identity?.kind === "cookie" ? identity.sessionId : undefined;
  };
  /** 组网入口来的请求 → 是哪台设备。 */
  const peerOf = (req: FastifyRequest) => {
    const identity = contextOf(req)?.identity;
    return identity?.kind === "meshDevice" ? identity.peer : undefined;
  };
  /** 登录流与状态快照的发起方会话隔离标识（本机浏览器按 sessionId，跨机 Peer 代理按配对设备 ID + 入口会话摘要）。 */
  const clientOwnerKeyOf = (req: FastifyRequest): string => {
    const identity = contextOf(req)?.identity;
    if (identity?.kind === "cookie") return `session:${identity.sessionId}`;
    if (identity?.kind === "meshDevice") {
      const rawScope = req.headers[PEER_CLIENT_SCOPE_HEADER];
      const scope = typeof rawScope === "string" && /^[0-9a-f]{16,64}$/u.test(rawScope) ? rawScope : null;
      return scope ? `peer:${identity.peer}:${scope}` : `peer:${identity.peer}`;
    }
    return "anonymous";
  };
  /** 记下这条 WebSocket 属于哪个会话：那个会话被退出时当场关掉。组网入口来的没有会话，不记。 */
  const trackSocket = (req: FastifyRequest, socket: { close(code?: number, reason?: string): void; once(event: "close", fn: () => void): unknown }) => {
    const sessionId = sessionOf(req);
    if (sessionId === undefined) return;
    const sockets = socketsBySession.get(sessionId) ?? new Set();
    sockets.add(socket);
    socketsBySession.set(sessionId, sockets);
    socket.once("close", () => {
      sockets.delete(socket);
      if (sockets.size === 0 && socketsBySession.get(sessionId) === sockets) socketsBySession.delete(sessionId);
    });
  };
  const folderPicker = opts.folderPicker ?? createFolderPicker({ available: serverInfo.folderPicker });
  const app = Fastify({ logger: opts.logger ?? false });

  const listeningPort = (): number | undefined => {
    const addr = app.server.address();
    return addr !== null && typeof addr === "object" ? addr.port : opts.port;
  };

  /** cookie 名带着网址里的端口（uiCookieName）：同一浏览器里不同端口的界面各用各的。 */
  const sessionToken = (req: FastifyRequest) => readCookie(req.headers.cookie, uiCookieName(req.headers.host));

  /** 设（或清：value 空、maxAge 0）这个浏览器的会话 cookie。本机 http://127.0.0.1 不能加 Secure（浏览器会丢掉这个 cookie）。 */
  const sessionCookie = (req: FastifyRequest, value: string, maxAgeSeconds: number) =>
    `${uiCookieName(req.headers.host)}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;

  /** 登录成功：开一个新会话、设 cookie。这个浏览器已经有会话就换掉（不让同一个浏览器的记录越堆越多）；满了被挤掉的和被换掉的一样，走撤销的路（关 WebSocket）。 */
  const startSession = (req: FastifyRequest, reply: FastifyReply) => {
    const previous = sessions.authenticate(sessionToken(req));
    if (previous !== null) {
      sessions.revoke(previous.id);
      closeSockets(previous.id);
    }
    const session = sessions.create({ userAgent: req.headers["user-agent"] ?? "", entry: (req.headers.host ?? "").toLowerCase() });
    for (const id of session.evicted) closeSockets(id);
    reply.header("set-cookie", sessionCookie(req, session.token, COOKIE_MAX_AGE_SECONDS)).header("referrer-policy", "no-referrer");
    return session;
  };

  const fail = (reply: FastifyReply, code: ApiErrorCode, reason?: string) =>
    reply.code(API_ERRORS[code].status).send(errorBody(code, reason));


  /** 本机 Origin：http://127.0.0.1|localhost:<实际端口>，端口要逐字相同（不接受 04000 这种写法）。 */
  const isLoopbackOrigin = (origin: string) => {
    const match = ORIGIN_HEADER.exec(origin);
    const port = listeningPort();
    return match !== null && port !== undefined && match[1] === String(port);
  };

  // 每种入口的规则（数据结构见 EntryRule）。顺序 = 同一个地方听到时认 Host 的顺序。
  const entryRules: Record<EntryKind, EntryRule> = {
    // 防 DNS 重绑定：Host 必须是 127.0.0.1:<端口> 或 localhost:<端口>。所有路径都查，包括静态文件和 /auth。
    loopback: {
      listeners: ["uiPort"],
      host: (req) => {
        const local = HOST_HEADER.exec(req.headers.host ?? "");
        if (local === null) return null;
        const port = listeningPort();
        return port !== undefined && Number(local[1]) === port ? { kind: "loopback" } : "forbidden_host";
      },
      origin: isLoopbackOrigin,
      identities: ["cookie"],
      sameMachine: true,
      browserPaths: true,
    },
    // 组网入口：TLS 握手已经按证书认出是哪台，Host、Origin 是对方随便写的，不查；cookie 完全不看。
    mesh: {
      listeners: ["mesh"],
      host: null,
      origin: null,
      identities: ["meshDevice"],
      sameMachine: false,
      browserPaths: false,
    },
  };
  const entryKinds = Object.keys(entryRules) as EntryKind[];

  /** 定入口：在哪听到的 → 可能的几种，按顺序认 Host。一种都对不上是 forbidden_host。 */
  const resolveEntry = (req: FastifyRequest): Entry | EntryRejection => {
    const listener = listenerOf.get(req.raw) ?? "uiPort";
    for (const kind of entryKinds) {
      const rule = entryRules[kind];
      if (!rule.listeners.includes(listener)) continue;
      const entry = rule.host === null ? ({ kind } as Entry) : rule.host(req);
      if (entry !== null) return entry;
    }
    return "forbidden_host";
  };

  /** 是不是 WebSocket 握手（本机的 /api/ws，和转发的 /d/<设备>/api/ws）。 */
  const isUpgrade = (req: FastifyRequest) => (req.headers.upgrade ?? "").toLowerCase() === "websocket";

  // 每个请求（含 WebSocket 握手）进来先定入口，再按入口的规则认身份、查 Origin、限路径。
  app.addHook("onRequest", async (req, reply) => {
    const entry = resolveEntry(req);
    if (typeof entry === "string") return fail(reply, entry);
    const rule = entryRules[entry.kind];
    const path = pathOf(req);
    // 过了入口检查后的所有回应（含认不出设备令牌的 401）都不许缓存。
    reply.header("cache-control", "no-store");

    // 浏览器入口上没有设备之间的接口：/api/peer/* 一律 403 forbidden_peer
    if (!rule.identities.includes("meshDevice") && path.startsWith("/api/peer/")) return fail(reply, "forbidden_peer");

    // 组网入口：TLS 证书认出来的设备，还要仍在本机信任表里（握手之后被移除的，这里拒）。认不出一律 401 peer_unauthorized。
    let identity: Identity = { kind: "none" };
    if (rule.identities.includes("meshDevice")) {
      const peer = meshPeerOf.get(req.raw.socket);
      if (peer === undefined || opts.mesh?.trust.get(peer) === undefined || opts.peers === undefined) return fail(reply, "peer_unauthorized");
      identity = { kind: "meshDevice", peer };
      if (!inDeviceScope(path)) return fail(reply, "forbidden_peer");
    }

    if (identity.kind === "none") {
      // 防别的本机端口上的网页借 cookie 动手：浏览器认为 localhost 不同端口是同一个站点，SameSite=Strict 拦不住。
      // 会改状态的请求和 WebSocket 握手必须带同源的 Origin，没带也拒绝；GET 不查。
      const unsafe = !SAFE_METHODS.has(req.method) || path === API_PATHS.ws || isUpgrade(req);
      if (unsafe && rule.origin !== null && !rule.origin(req.headers.origin ?? "", entry)) return fail(reply, "forbidden_origin");

      // /api/ 下（含 WebSocket 握手）和转发 /d/ 一律要 cookie。静态文件不要：网页要先加载出来，才能在 401 时提示用户怎么登录。
      if (path.startsWith("/api/") || path.startsWith(`${DEVICE_PROXY_PREFIX}/`)) {
        const session = sessions.authenticate(sessionToken(req));
        if (session === null) {
          if (!(req.method === "GET" && path === API_PATHS.authStatus)) {
            return fail(reply, "unauthorized");
          }
        } else {
          identity = { kind: "cookie", sessionId: session.id };
        }
      }
    }
    contexts.set(req.raw, { entry, rule, identity });
  });

  /** 判断“浏览器在不在这台机器上”用的地址（serverInfoForClient）。不算本机的入口当成没有地址。 */
  const clientAddress = (req: FastifyRequest) => (contextOf(req)?.rule.sameMachine ? req.ip : undefined);

  // 对可压缩的 JSON 与文本响应标记 Vary: Accept-Encoding（具体压缩由 @fastify/compress 处理，支持 Range 的存储文件下载除外）。
  app.addHook("onSend", async (req, reply, payload) => {
    if (
      payload !== null &&
      payload !== undefined &&
      req.method !== "HEAD" &&
      !req.headers["x-no-compression"] &&
      reply.statusCode !== 204 &&
      reply.statusCode !== 205 &&
      reply.statusCode !== 206 &&
      reply.statusCode !== 304 &&
      reply.getHeader("accept-ranges") === undefined &&
      reply.getHeader("content-range") === undefined &&
      isCompressibleType(reply.getHeader("content-type"))
    ) {
      const existing = reply.getHeader("vary");
      reply.header("vary", existing === undefined ? "Accept-Encoding" : `${String(existing)}, Accept-Encoding`);
    }
    return payload;
  });

  // 握手被这里的钩子拒了（401、403、404）：@fastify/websocket 自己的钩子排在后面没跑到，不会替它关连接；
  // 回完响应把连接断掉，不然这条连接一直挂着（关机时还要等它）。
  app.addHook("onResponse", async (req) => {
    if (isUpgrade(req)) req.raw.socket.destroy();
  });

  app.setErrorHandler((err: FastifyError | ConversationNotFoundError | LedgerRequestError | RouterTargetError | UploadError | PickFolderError | ProviderRequestError | FeishuSetupError, req, reply) => {
    const reason = err.message;
    if (err instanceof PickFolderError) return fail(reply, codeOfStatus(err.statusCode), reason);
    if (err instanceof ProviderRequestError) return fail(reply, codeOfStatus(err.statusCode), reason);
    if (err instanceof ConversationNotFoundError) return fail(reply, "not_found");
    if (err instanceof UploadError) return fail(reply, codeOfStatus(err.statusCode), reason);
    if (err instanceof LedgerRequestError) return fail(reply, err.code, reason);
    if (err instanceof RouterTargetError) {
      const apiCode =
        err.code === "not_found" || err.code === "device_not_found"
          ? "not_found"
          : err.code === "forbidden"
            ? "forbidden"
            : err.code === "invalid"
              ? "invalid"
              : "conflict";
      return fail(reply, apiCode, reason);
    }
    if (err instanceof FeishuSetupError) return fail(reply, "invalid", reason);
    const status = (err as FastifyError).statusCode;
    // 请求体超过 1 MB：Fastify 在收完之前就拒了，原因是英文；换成默认中文（上传超限是 UploadError，上面已经处理）
    if (status === 413) return fail(reply, "too_large");
    // 请求体校验没过（含 JSON 解析失败、HttpError）英文原文只记日志，对外统一回默认中文。
    if (status !== undefined && status >= 400 && status < 500) {
      req.log.warn({ err }, "ui-server bad request");
      return fail(reply, codeOfStatus(status));
    }
    req.log.error({ err }, "ui-server request failed");
    return fail(reply, "internal");
  });
  app.setNotFoundHandler((_req, reply) => fail(reply, "not_found"));

  app.register(fastifyCompress, {
    global: true,
    threshold: 1024,
    encodings: ["gzip", "deflate"],
    customTypes: isCompressibleType,
  });
  app.register(fastifyWebsocket);
  app.addHook("onClose", async () => {
    if (ownedDb !== undefined) ownedDb.close();
  });

  // 上传文件（不绑定接收方，谁来用都是先上传、再在发消息时带编号）：请求体是文件原样的字节，上限 MAX_UPLOAD_BYTES，只对这个接口放大。
  // 放进单独的插件里：内容类型解析器只在这个插件里生效（别的接口照旧只收 JSON、上限 1 MB）；
  // 先去掉 Fastify 自带的 JSON、文本解析器，免得 .json、.txt 文件被当成文本解析坏掉。
  // 解析器不读请求体，把流原样交给 saveUpload 边收边写盘（几十 MB 的视频不进内存），上限由 saveUpload 数着字节管。
  app.register(async (uploads) => {
    uploads.removeAllContentTypeParsers();
    uploads.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

    // 同时在收的上传有上限。名额占到响应结束（正常结束、连接中途断掉都会释放）
    let activeUploads = 0;
    uploads.addHook("onRequest", async (req, reply) => {
      if (req.method !== "POST") return;
      if (activeUploads >= MAX_CONCURRENT_UPLOADS) return fail(reply, "busy", UPLOAD_BUSY_MESSAGE);
      activeUploads++;
      reply.raw.once("close", () => {
        activeUploads--;
      });
    });

    uploads.post(API_PATHS.uploads, async (req, reply) => {
      // 声明的长度已经超了：不收请求体，回完关掉连接
      if (Number(req.headers["content-length"]) > MAX_UPLOAD_BYTES) {
        reply.header("connection", "close");
        throw new UploadError(413, UPLOAD_TOO_LARGE_MESSAGE);
      }
      const { name } = req.query as { name?: unknown };
      return saveUpload(uploadsDir, typeof name === "string" ? name : "", req.body instanceof Readable ? req.body : Buffer.alloc(0));
    });

    // 地址里的文件名只是给浏览器看的（取文件只认编号），用通配：命名参数 Fastify 默认最多 100 个字符，长文件名会 404
    uploads.get("/api/uploads/:id/*", async (req, reply) => {
      const attachment = resolveUpload(uploadsDir, String((req.params as { id?: unknown }).id ?? ""));
      if (attachment === null) return fail(reply, "not_found");
      // 预览窗（?inline=1）按扩展名认类型：上传时只认图片，pdf、html 之类也要能放进 iframe
      const mime = wantsPreview(req) ? sentFileMime(attachment.name) : attachment.mime;
      return sendStoredFile(req, reply, { ...attachment, mime });
    });
  });

  // agent 发给用户的文件的副本（daemon/sent-files.ts）：和上传的文件同一个布局，同一套查找和响应头；类型按 sentFileMime（svg 算图片）
  app.get("/api/sent-files/:id/*", async (req, reply) => {
    const copy = resolveUpload(sentFilesDir, String((req.params as { id?: unknown }).id ?? ""));
    if (copy === null) return fail(reply, "not_found");
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
      if (token === undefined || link !== undefined || !tokenEquals(expectedToken, token)) return fail(reply, "unauthorized");
      startSession(req, reply);
      return reply.redirect("/", 302);
    });

    routes.post(API_PATHS.auth, async (req, reply) => {
      const body = (req.body ?? {}) as { link?: unknown; token?: unknown };
      if (body.token !== undefined && body.link === undefined) {
        if (!tokenEquals(expectedToken, body.token)) return fail(reply, "unauthorized");
        startSession(req, reply);
        return reply.code(204).send();
      }
      if (!loginLinks.consume(body.link)) return fail(reply, "unauthorized");
      startSession(req, reply);
      return reply.code(204).send();
    });

    routes.get(API_PATHS.authStatus, async (req): Promise<DesktopAuthStatusResponse> => {
      const identity = contextOf(req)?.identity;
      const status = identity?.kind === "cookie" ? "active" : "unauthenticated";
      return {
        status,
        product: DESKTOP_PRODUCT,
        protocolVersion: DESKTOP_PROTOCOL_VERSION,
        instanceId,
      };
    });

    routes.get(API_PATHS.health, async (): Promise<DesktopHealthResponse> => ({
      ok: true,
      product: DESKTOP_PRODUCT,
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
      instanceId,
    }));

    routes.get(API_PATHS.browserSessions, async (req): Promise<BrowserSessionsResponse> => {
      const current = sessionOf(req);
      return { sessions: sessions.list().map((s) => ({ ...s, current: s.id === current })) };
    });

    routes.delete("/api/sessions/:id", async (req, reply) => {
      const id = String((req.params as { id?: unknown }).id ?? "");
      if (!sessions.revoke(id)) return fail(reply, "not_found");
      closeSockets(id);
      // 退的是自己：顺手把浏览器里的 cookie 清掉
      if (id === sessionOf(req)) reply.header("set-cookie", sessionCookie(req, "", 0));
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
      const origin = `http://${req.headers.host}`;
      return reply.code(201).send({ url: `${origin}/auth#${LOGIN_LINK_FRAGMENT_KEY}=${code}`, expiresAt } satisfies LoginLinkResponse);
    });

    // 联机：设备管理、设备之间、入口转发（daemon/peers/routes.ts）
    if (opts.peers !== undefined) {
      routes.register(peerRoutes, {
        peers: opts.peers,
        ...(opts.mesh ? { mesh: opts.mesh } : {}),
        ...(opts.feishuPeer ? { feishuPeer: opts.feishuPeer } : {}),
        peerOf,
        clientScopeOf: (req) => createHash("sha256").update(clientOwnerKeyOf(req)).digest("hex").slice(0, 24),
        trackSocket,
        onChange: broadcastResync,
        ...(opts.peerProxy ? { proxy: opts.peerProxy } : {}),
      });
    }

    const selfReloadBodySchema = z.object({ build: z.boolean().optional() }).strict();
    routes.post(API_PATHS.selfReload, async (req): Promise<SelfReloadResponse> => {
      const body: SelfReloadRequestBody = parseWithSchema(selfReloadBodySchema, req.body ?? {});
      if (!opts.selfReload) throw new LedgerRequestError("conflict", SELF_RELOAD_UNSUPPORTED_MESSAGE);
      return opts.selfReload.request({ build: body.build === true, by: "网页" });
    });

    routes.get(API_PATHS.selfReload, async (): Promise<SelfReloadStatus> =>
      opts.selfReload?.status() ?? { state: "idle", build: false, requestedAt: null, deadlineAt: null, overdue: false, busy: [], unresumable: [], lastFailure: null },
    );

    routes.get(API_PATHS.state, async (req): Promise<StateSnapshot> => {
      const snap = ledger.snapshot();
      // 对等设备看不到本机指令：连同“还有更早指令”的标记一起抹掉
      const router = peerOf(req) !== undefined ? { ...snap.router, commands: [], commandsHasMore: false } : snap.router;
      return {
        ...snap,
        router,
        server: serverInfoForClient(serverInfo, clientAddress(req)),
        bootId: instanceId,
      };
    });

    routes.get(API_PATHS.models, async (req): Promise<ModelsResponse> => {
      // ?refresh=1 全部重问；?refresh=unusable 只重问这台设备上没登录（没装）的那几家（网页打开厂商下拉时在后台发）
      const query = (req.query as { refresh?: unknown }).refresh;
      const refresh = query === "1" ? true : query === REFRESH_UNUSABLE ? REFRESH_UNUSABLE : false;
      return { catalogs: opts.models ? await opts.models.list({ refresh }) : AGENT_VENDORS.map((v) => bundledModelCatalog(v)) };
    });

    routes.get(API_PATHS.quota, async (): Promise<QuotaResponse> => (opts.quota ? await opts.quota.get() : { groups: [] }));

    routes.get(API_PATHS.vendorSyncPreview, async (): Promise<VendorSyncPreviewResponse> => {
      if (!opts.vendorSync) {
        return {
          scannedAt: (opts.now ?? Date.now)(),
          mcpServers: [],
          skills: [],
          nonSyncable: [],
          truncated: false,
        };
      }
      return opts.vendorSync.preview();
    });

    routes.post(API_PATHS.vendorSyncApply, async (req): Promise<VendorSyncApplyResponse> => {
      if (!opts.vendorSync) throw new HttpError(501, "vendor sync unavailable");
      const raw = parseWithSchema(vendorSyncApplyBodySchema, req.body);
      const request: VendorSyncApplyRequest = {
        selectedMcpKeys: raw.selectedMcpKeys,
        removeMcpKeys: raw.removeMcpKeys,
        selectedSkillKeys: raw.selectedSkillKeys,
        removeSkillKeys: raw.removeSkillKeys,
        ...(raw.confirmedHostBoundMcpKeys !== undefined ? { confirmedHostBoundMcpKeys: raw.confirmedHostBoundMcpKeys } : {}),
      };
      const applied = opts.vendorSync.apply(request);
      opts.capabilityInventory?.invalidate();
      return applied;
    });

    routes.get(API_PATHS.providers, async (req): Promise<ProvidersStatusResponse> => {
      if (!opts.providers) {
        return {
          platform: serverInfo.platform,
          gitInstalled: true,
          canInstallGit: false,
          gitJob: null,
          providers: [],
        };
      }
      const refresh = (req.query as { refresh?: unknown }).refresh === "1";
      return opts.providers.getStatus({ refresh, ownerKey: clientOwnerKeyOf(req) });
    });

    routes.post(API_PATHS.providerGitInstall, async (req): Promise<ProvidersStatusResponse> => {
      if (!opts.providers) throw new HttpError(501, "provider manager unavailable");
      parseWithSchema(emptyStrictBodySchema, req.body ?? {});
      return opts.providers.installGit(clientOwnerKeyOf(req));
    });

    routes.post("/api/providers/:vendor/install", async (req): Promise<ProviderStatusItem> => {
      if (!opts.providers) throw new HttpError(501, "provider manager unavailable");
      const vendor = parseVendorParam((req.params as { vendor?: unknown }).vendor);
      parseWithSchema(emptyStrictBodySchema, req.body ?? {});
      return opts.providers.install(vendor, clientOwnerKeyOf(req));
    });

    routes.post("/api/providers/:vendor/update", async (req): Promise<ProviderStatusItem> => {
      if (!opts.providers) throw new HttpError(501, "provider manager unavailable");
      const vendor = parseVendorParam((req.params as { vendor?: unknown }).vendor);
      parseWithSchema(emptyStrictBodySchema, req.body ?? {});
      return opts.providers.update(vendor, clientOwnerKeyOf(req));
    });

    routes.post("/api/providers/:vendor/job/cancel", async (req): Promise<ProviderStatusItem> => {
      if (!opts.providers) throw new HttpError(501, "provider manager unavailable");
      const vendor = parseVendorParam((req.params as { vendor?: unknown }).vendor);
      const body = parseWithSchema(providerCancelJobBodySchema, req.body) satisfies ProviderCancelJobRequest;
      return opts.providers.cancelJob(vendor, body, clientOwnerKeyOf(req));
    });

    routes.post("/api/providers/:vendor/auth/start", async (req): Promise<ProviderStatusItem> => {
      if (!opts.providers) throw new HttpError(501, "provider manager unavailable");
      const vendor = parseVendorParam((req.params as { vendor?: unknown }).vendor);
      const body = parseWithSchema(providerStartAuthBodySchema, req.body) satisfies ProviderStartAuthRequest;
      return opts.providers.startAuth(vendor, body, clientOwnerKeyOf(req));
    });

    routes.post("/api/providers/:vendor/auth/submit", async (req): Promise<ProviderStatusItem> => {
      if (!opts.providers) throw new HttpError(501, "provider manager unavailable");
      const vendor = parseVendorParam((req.params as { vendor?: unknown }).vendor);
      const body = parseWithSchema(providerSubmitAuthBodySchema, req.body) satisfies ProviderSubmitAuthRequest;
      return opts.providers.submitAuth(vendor, body, clientOwnerKeyOf(req));
    });

    routes.post("/api/providers/:vendor/auth/cancel", async (req): Promise<ProviderStatusItem> => {
      if (!opts.providers) throw new HttpError(501, "provider manager unavailable");
      const vendor = parseVendorParam((req.params as { vendor?: unknown }).vendor);
      const body = parseWithSchema(providerCancelAuthBodySchema, req.body) satisfies ProviderCancelAuthRequest;
      return opts.providers.cancelAuth(vendor, body, clientOwnerKeyOf(req));
    });

    routes.post("/api/providers/:vendor/auth/api-key", async (req): Promise<ProviderStatusItem> => {
      if (!opts.providers) throw new HttpError(501, "provider manager unavailable");
      const vendor = parseVendorParam((req.params as { vendor?: unknown }).vendor);
      const body = parseWithSchema(providerSaveApiKeyBodySchema, req.body) satisfies ProviderSaveApiKeyRequest;
      return opts.providers.saveApiKey(vendor, body, clientOwnerKeyOf(req));
    });

    routes.post("/api/providers/:vendor/auth/logout", async (req): Promise<ProviderStatusItem> => {
      if (!opts.providers) throw new HttpError(501, "provider manager unavailable");
      const vendor = parseVendorParam((req.params as { vendor?: unknown }).vendor);
      const body = parseWithSchema(providerLogoutBodySchema, req.body ?? {}) satisfies ProviderLogoutRequest;
      return opts.providers.logout(vendor, body, clientOwnerKeyOf(req));
    });

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

    routes.get("/api/conversations/lookup", async (req): Promise<ConversationsLookup> => {
      const { ids, workerIds } = req.query as { ids?: unknown; workerIds?: unknown };
      return ledger.lookupConversations({ ids: parseIdList(ids, "ids"), workerIds: parseIdList(workerIds, "workerIds") });
    });

    routes.get("/api/pms/:id/ended-workers", async (req): Promise<EndedWorkersPage> => {
      const pmId = parseId((req.params as { id?: unknown }).id, "pm id");
      const { before } = req.query as { before?: unknown };
      return ledger.endedWorkersPage(pmId, parseOptionalPositiveInt(before, "before") ?? null);
    });

    routes.get("/api/conversations/:id/messages", async (req) => {
      const { id } = req.params as { id?: unknown };
      const { before } = req.query as { before?: unknown };
      return ledger.messagesBefore(parseId(id, "conversation id"), parseId(before, "before"));
    });

    routes.post("/api/conversations/:id/messages", async (req): Promise<PostMessageResponse> => {
      const conversationId = parseId((req.params as { id?: unknown }).id, "conversation id");
      const { clientId, text, attachmentIds, workerPick } = parsePostBody(req.body);
      // 附件按编号从磁盘重新算（路径、名字、大小），不信请求里的任何别的东西
      const attachments = attachmentIds.map((id) => resolveUpload(uploadsDir, id) ?? undefined);
      if (attachments.some((a) => a === undefined)) throw new LedgerRequestError("invalid", ATTACHMENTS_MISSING_MESSAGE);
      return ledger.postUserMessage({
        conversationId,
        clientId,
        text,
        ...(attachments.length > 0 ? { attachments: attachments as NonNullable<(typeof attachments)[number]>[] } : {}),
        // 只校验形状；是不是项目经理的对话由账本查（invalid），这台设备能不能用那家厂商不查（hub worker start 会报）
        ...(workerPick !== undefined ? { workerPick } : {}),
      });
    });

    // 在 Finder 中显示 / 用默认程序打开（open-file.ts）。只收“哪条消息的第几个文件”或上传编号，不收路径。
    const doFileAction = async (reply: FastifyReply, run: () => Promise<FileActionResponse>) => {
      try {
        return await run();
      } catch (error) {
        if (error instanceof OpenTargetMissing) return fail(reply, "not_found");
        if (error instanceof OpenNotAllowed) return fail(reply, "forbidden", OPEN_NOT_ALLOWED_MESSAGE);
        if (error instanceof FileActionsUnavailable) return fail(reply, "unavailable", FILE_ACTIONS_UNAVAILABLE_MESSAGE);
        console.error("ui-server open failed:", error);
        return fail(reply, "internal", "没能打开这个文件");
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
      if (act === null || message === null || file === undefined || file.id === null) return fail(reply, "not_found");
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
      if (act === null || attachment === null) return fail(reply, "not_found");
      return doFileAction(reply, async () => {
        requireLocal(req);
        return performFileAction(act, { original: null, isAllowed: () => false, copy: attachment.path, name: attachment.name }, runOpen);
      });
    });

    routes.post("/api/conversations/:id/stop", async (req, reply) => {
      ledger.requestStop(parseId((req.params as { id?: unknown }).id, "conversation id"));
      return reply.code(202).send();
    });

    routes.post("/api/conversations/:id/rewind", async (req): Promise<RewindMessageResponse> => {
      const id = parseId((req.params as { id?: unknown }).id, "conversation id");
      return { message: ledger.rewindLastUserMessage(id) };
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

    routes.put("/api/pms/:id/look", async (req): Promise<PmLookResponse> => {
      const pmId = parseId((req.params as { id?: unknown }).id, "pm id");
      return { pm: ledger.setPmLook(pmId, parsePmLookBody(req.body)) };
    });

    routes.get("/api/pms/:id/capabilities", async (req): Promise<PmCapabilitiesView> => {
      const pmId = parseId((req.params as { id?: unknown }).id, "pm id");
      const policy = ledger.getPmCapabilityPolicy(pmId);
      const projectDir = ledger.pmProjectMainFolder(pmId);
      if ((req.query as { refresh?: unknown }).refresh === "1") {
        opts.capabilityInventory?.invalidate();
      }
      const inventory = opts.capabilityInventory
        ? await opts.capabilityInventory.get({ projectDir })
        : { scannedAt: (opts.now ?? Date.now)(), items: [], groups: [], truncated: false };
      return { pmId, inventory, policy, isolation: vendorIsolationMap(), pluginIsolation: vendorPluginIsolationMap() };
    });

    routes.patch("/api/pms/:id/capabilities", async (req): Promise<PmCapabilitiesView> => {
      const pmId = parseId((req.params as { id?: unknown }).id, "pm id");
      const patch = parsePatchPmCapabilitiesBody(req.body);
      const policy = ledger.patchPmCapabilities(pmId, patch);
      const projectDir = ledger.pmProjectMainFolder(pmId);
      const inventory = opts.capabilityInventory
        ? await opts.capabilityInventory.get({ projectDir })
        : { scannedAt: (opts.now ?? Date.now)(), items: [], groups: [], truncated: false };
      return { pmId, inventory, policy, isolation: vendorIsolationMap(), pluginIsolation: vendorPluginIsolationMap() };
    });

    routes.post("/api/persona-changes/:id/revert", async (req): Promise<EditPersonaResponse> => {
      const result = ledger.revertPersonaChange(parseId((req.params as { id?: unknown }).id, "persona change id"));
      return { changed: result.change !== null, persona: result.persona };
    });

    // 项目经理记忆目录子文件（<topic>.md）：文件名用通配，让含编码斜杠的非法路径走账本 400 校验而不是落成 404
    routes.get("/api/pms/:id/memory-files", async (req): Promise<PmMemoryFilesResponse> => {
      return ledger.listPmMemoryFiles(parseId((req.params as { id?: unknown }).id, "pm id"));
    });

    routes.get("/api/pms/:id/memory-files/*", async (req): Promise<PmMemoryFileResponse> => {
      const { id, "*": name } = req.params as { id?: unknown; "*"?: unknown };
      return ledger.getPmMemoryFile(parseId(id, "pm id"), typeof name === "string" ? name : "");
    });

    routes.put("/api/pms/:id/memory-files/*", async (req): Promise<PutPmMemoryFileResponse> => {
      const { id, "*": name } = req.params as { id?: unknown; "*"?: unknown };
      const raw = parseWithSchema(putPmMemoryFileBodySchema, req.body);
      return ledger.putPmMemoryFile(parseId(id, "pm id"), typeof name === "string" ? name : "", raw.content);
    });

    routes.delete("/api/pms/:id/memory-files/*", async (req, reply) => {
      const { id, "*": name } = req.params as { id?: unknown; "*"?: unknown };
      ledger.deletePmMemoryFile(parseId(id, "pm id"), typeof name === "string" ? name : "");
      return reply.code(204).send();
    });

    // 定时任务卡片：校验和写库都在账本里（同 hub schedule），这里只认请求体的形状
    routes.post("/api/pms/:id/schedules", async (req, reply) => {
      const pmId = parseId((req.params as { id?: unknown }).id, "pm id");
      const raw = parseWithSchema(addScheduleBodySchema, req.body);
      const schedule = ledger.addSchedule(pmId, {
        name: raw.name as string,
        prompt: raw.prompt as string,
        ...(raw.daily !== undefined ? { daily: raw.daily as string } : {}),
        ...(raw.everyMinutes !== undefined ? { everyMinutes: raw.everyMinutes as number } : {}),
      });
      return reply.code(201).send(schedule);
    });

    routes.put("/api/schedules/:id", async (req) => {
      const raw = parseWithSchema(setScheduleEnabledBodySchema, req.body);
      return ledger.setScheduleEnabled(parseId((req.params as { id?: unknown }).id, "schedule id"), raw.enabled);
    });

    routes.delete("/api/schedules/:id", async (req, reply) => {
      ledger.removeSchedule(parseId((req.params as { id?: unknown }).id, "schedule id"));
      return reply.code(204).send();
    });

    routes.post(API_PATHS.pickFolder, async (req): Promise<PickFolderResponse> => {
      const raw = parseWithSchema(pickFolderBodySchema, req.body ?? {});
      return { path: await folderPicker.pick(raw.startDir) };
    });

    routes.post("/api/pms/:id/renew-session", async (req, reply) => {
      const result = ledger.renewSession(parseId((req.params as { id?: unknown }).id, "pm id"));
      return reply.code(202).send({ handoverId: result.handoverId } satisfies RenewSessionResponse);
    });

    routes.post("/api/pms/:id/archive", async (req): Promise<ArchivePmResponse> => {
      const pmId = parseId((req.params as { id?: unknown }).id, "pm id");
      return { pm: ledger.archivePm(pmId) };
    });

    routes.post("/api/pms/:id/unarchive", async (req): Promise<ArchivePmResponse> => {
      const pmId = parseId((req.params as { id?: unknown }).id, "pm id");
      return { pm: ledger.unarchivePm(pmId) };
    });

    routes.get("/api/messages/:id/turn-reply", async (req, reply): Promise<TurnReplyView | FastifyReply> => {
      const view = ledger.turnReplyOf(parseId((req.params as { id?: unknown }).id, "message id"));
      return view === null ? fail(reply, "not_found") : view;
    });

    routes.post("/api/messages/:id/retry", async (req, reply) => {
      const result = ledger.retryMessage(parseId((req.params as { id?: unknown }).id, "message id"));
      return reply.code(202).send({ messageId: result.messageId } satisfies RetryMessageResponse);
    });

    // ---- Router（总助）与持久化任务图轨道 A 接口 ----
    routes.get(API_PATHS.routerDigest, async (): Promise<DeviceRouterDigest> => {
      return ledger.getRouterDigest();
    });

    routes.get(API_PATHS.routerItems, async (req): Promise<RouterItemsPage> => {
      const query = req.query as { cursor?: unknown; before?: unknown; limit?: unknown; kind?: unknown };
      const cursor =
        typeof query.cursor === "string" && query.cursor.trim() !== ""
          ? query.cursor
          : typeof query.before === "string" && query.before.trim() !== ""
            ? query.before
            : undefined;
      const limit = parseOptionalPositiveInt(query.limit, "limit");
      // kind=report：不分状态只回简报（v2 时间流翻历史）；不带 kind 照旧
      if (query.kind === undefined) return ledger.listRouterItems(cursor, limit);
      if (query.kind !== "report") throw new LedgerRequestError("invalid", "kind 只能是 report");
      return ledger.listRouterItems(cursor, limit, query.kind);
    });

    routes.post("/api/router/items/:id/resolve", async (req): Promise<ResolveRouterItemResponse> => {
      const itemId = parseId((req.params as { id?: unknown }).id, "router item id");
      const raw = parseWithSchema(resolveRouterItemBodySchema, req.body);
      const body: ResolveRouterItemRequest =
        "action" in raw
          ? { action: "archive" }
          : {
              clientId: raw.clientId,
              optionIndex: raw.optionIndex ?? null,
              ...(raw.choice !== undefined && raw.choice !== null ? { choice: raw.choice } : {}),
              ...(raw.note !== undefined ? { note: raw.note } : {}),
            };
      return ledger.resolveRouterItem(itemId, body);
    });

    routes.post("/api/asks/:id/answer", async (req): Promise<ResolveRouterItemResponse> => {
      const messageId = parseId((req.params as { id?: unknown }).id, "message id");
      const raw = parseWithSchema(decideRouterItemBodySchema, req.body);
      return ledger.answerAsk(messageId, {
        clientId: raw.clientId,
        optionIndex: raw.optionIndex ?? null,
        ...(raw.choice !== undefined && raw.choice !== null ? { choice: raw.choice } : {}),
        ...(raw.note !== undefined ? { note: raw.note } : {}),
      });
    });

    // 用户在“要你动手”的提醒卡上点了 Done：先让 ModelCatalogs 重问这家厂商（事务外的 I/O），账本再按它的现状留卡或接着派（docs/user-blockers-design.md）
    routes.post("/api/user-blockers/:id/recheck", async (req): Promise<RecheckUserBlockerResponse> => {
      const blockerId = parseId((req.params as { id?: unknown }).id, "user blocker id");
      const vendor = ledger.userBlockerVendor(blockerId);
      if (vendor !== null && opts.models) await opts.models.list({ vendor, refresh: true });
      return ledger.recheckUserBlocker(blockerId);
    });

    routes.post("/api/router/items/:id/decide", async (req): Promise<ResolveRouterItemResponse> => {
      const itemId = parseId((req.params as { id?: unknown }).id, "router item id");
      const raw = parseWithSchema(decideRouterItemBodySchema, req.body);
      return ledger.resolveRouterItem(itemId, {
        clientId: raw.clientId,
        optionIndex: raw.optionIndex ?? null,
        ...(raw.choice !== undefined && raw.choice !== null ? { choice: raw.choice } : {}),
        ...(raw.note !== undefined ? { note: raw.note } : {}),
      });
    });

    routes.post("/api/router/items/:id/archive", async (req): Promise<ResolveRouterItemResponse> => {
      const itemId = parseId((req.params as { id?: unknown }).id, "router item id");
      parseWithSchema(emptyObjectBodySchema, req.body ?? {});
      return ledger.resolveRouterItem(itemId, { action: "archive" });
    });

    routes.get(API_PATHS.routerCommands, async (req, reply): Promise<RouterCommandsPage> => {
      if (peerOf(req) !== undefined) return fail(reply, "forbidden_peer") as never;
      const query = req.query as { cursor?: unknown; before?: unknown; limit?: unknown };
      const cursor =
        typeof query.cursor === "string" && query.cursor.trim() !== ""
          ? query.cursor
          : typeof query.before === "string" && query.before.trim() !== ""
            ? query.before
            : undefined;
      const limit = parseOptionalPositiveInt(query.limit, "limit");
      return ledger.listRouterCommands
        ? ledger.listRouterCommands(cursor, limit)
        : { commands: [], nextCursor: null, hasMore: false };
    });

    routes.post(API_PATHS.routerCommands, async (req, reply): Promise<PostRouterCommandResponse> => {
      if (peerOf(req) !== undefined) return fail(reply, "forbidden_peer") as never;
      if (!opts.routerDispatcher) return fail(reply, "unavailable", "当前服务未启用总助分派引擎") as never;
      const raw = parseWithSchema(postRouterCommandBodySchema, req.body);
      // 规划可能很慢：登记完立即回 planning 记录，终态由 router.command.updated 推给网页
      const command = await opts.routerDispatcher.submitCommand(raw, { background: true });
      return { command };
    });

    routes.post("/api/router/commands/:id/retry", async (req, reply): Promise<PostRouterCommandResponse> => {
      if (peerOf(req) !== undefined) return fail(reply, "forbidden_peer") as never;
      if (!opts.routerDispatcher) return fail(reply, "unavailable", "当前服务未启用总助分派引擎") as never;
      const commandId = parseId((req.params as { id?: unknown }).id, "router command id");
      parseWithSchema(emptyObjectBodySchema, req.body ?? {});
      const command = await opts.routerDispatcher.retryCommand(commandId, { background: true });
      return { command };
    });

    routes.post(API_PATHS.routerTargetOps, async (req, reply) => {
      if (!opts.routerLocalPort) return fail(reply, "unavailable", "当前服务未启用总助目标端口");
      const op = parseWithSchema(routerTargetOpSchema, req.body);
      const result = await opts.routerLocalPort.executeOp(op);
      return { result };
    });

    routes.post(API_PATHS.routerReportsArchiveAll, async (req): Promise<ArchiveAllReportsResponse> => {
      parseWithSchema(emptyObjectBodySchema, req.body ?? {});
      return ledger.archiveAllRouterReports();
    });

    routes.put(API_PATHS.routerSettings, async (req): Promise<UpdateRouterSettingsResponse> => {
      const raw = parseWithSchema(updateRouterSettingsBodySchema, req.body);
      return {
        settings: ledger.updateRouterSettings({
          vendor: raw.vendor,
          model: raw.model,
          effort: raw.effort,
        }),
      };
    });

    routes.get("/api/projects/:id/task-graphs", async (req): Promise<TaskGraphsPage> => {
      const projectId = parseId((req.params as { id?: unknown }).id, "project id");
      const query = req.query as { before?: unknown; limit?: unknown };
      const beforeId = parseOptionalPositiveInt(query.before, "before");
      const limit = parseOptionalPositiveInt(query.limit, "limit");
      return ledger.listProjectTaskGraphs(projectId, beforeId, limit);
    });

    routes.post("/api/task-graphs/:graphId/nodes/:nodeKey/decide", async (req): Promise<DecideTaskNodeResponse> => {
      const params = req.params as { graphId?: unknown; nodeKey?: unknown };
      const graphId = parseId(params.graphId, "graphId");
      const nodeKey = parseNodeKeyParam(params.nodeKey);
      const raw = parseWithSchema(decideTaskNodeBodySchema, req.body);
      return ledger.decideTaskNode(graphId, nodeKey, {
        clientId: raw.clientId,
        ...(raw.choice !== undefined ? { choice: raw.choice } : {}),
        ...(raw.note !== undefined ? { note: raw.note } : {}),
      });
    });

    routes.post("/api/task-graphs/:graphId/nodes/:nodeKey/skip", async (req): Promise<SkipTaskNodeResponse> => {
      const params = req.params as { graphId?: unknown; nodeKey?: unknown };
      const graphId = parseId(params.graphId, "graphId");
      const nodeKey = parseNodeKeyParam(params.nodeKey);
      const raw = parseWithSchema(skipTaskNodeBodySchema, req.body ?? {});
      return ledger.skipTaskNode(graphId, nodeKey, {
        ...(raw.reason !== undefined ? { reason: raw.reason } : {}),
      });
    });

    routes.post("/api/task-graphs/:graphId/cancel", async (req): Promise<CancelTaskGraphResponse> => {
      const graphId = parseId((req.params as { graphId?: unknown }).graphId, "graphId");
      const raw = parseWithSchema(cancelTaskGraphBodySchema, req.body ?? {});
      return ledger.cancelTaskGraph(graphId, {
        ...(raw.reason !== undefined ? { reason: raw.reason } : {}),
      });
    });

    // 推送订阅（联机 P4）：只在开了推送的服务上有
    const push = opts.push;
    if (push !== undefined) {
      routes.get(API_PATHS.pushKey, async (): Promise<PushKeyResponse> => ({ publicKey: push.publicKey }));
      routes.post(API_PATHS.pushSubscriptions, async (req, reply) => {
        const subscription = parseSubscription(req.body);
        if (subscription === null) return fail(reply, "invalid", "订阅内容不对");
        push.subscribe(subscription);
        return reply.code(204).send();
      });
      routes.post(API_PATHS.pushUnsubscribe, async (req, reply) => {
        const parsed = pushUnsubscribeBodySchema.safeParse(req.body);
        if (!parsed.success) return fail(reply, "invalid", "endpoint 不对");
        push.unsubscribe(parsed.data.endpoint);
        return reply.code(204).send();
      });
    }

    // 飞书设置（docs/feishu-design.md）：只在本机网页上配，别的设备经组网转过来的一律 forbidden_peer
    const feishuOf = (req: FastifyRequest, reply: FastifyReply): FeishuSetupService | null => {
      if (peerOf(req) !== undefined) {
        fail(reply, "forbidden_peer");
        return null;
      }
      if (opts.feishu === undefined) {
        fail(reply, "unavailable", "这台没开飞书");
        return null;
      }
      return opts.feishu;
    };
    routes.get(API_PATHS.feishu, async (req, reply) => {
      const feishu = feishuOf(req, reply);
      return feishu === null ? reply : feishu.status();
    });
    routes.post(API_PATHS.feishuRegistration, async (req, reply) => {
      const feishu = feishuOf(req, reply);
      if (feishu === null) return reply;
      parseWithSchema(emptyObjectBodySchema, req.body ?? {});
      return feishu.startRegistration();
    });
    routes.delete(API_PATHS.feishuRegistration, async (req, reply) => {
      const feishu = feishuOf(req, reply);
      return feishu === null ? reply : feishu.cancelRegistration();
    });
    routes.put(API_PATHS.feishuCredentials, async (req, reply) => {
      const feishu = feishuOf(req, reply);
      if (feishu === null) return reply;
      const body = parseWithSchema(feishuCredentialsSchema, req.body);
      return feishu.saveCredentials(body);
    });
    routes.post(API_PATHS.feishuBindCode, async (req, reply) => {
      const feishu = feishuOf(req, reply);
      if (feishu === null) return reply;
      parseWithSchema(emptyObjectBodySchema, req.body ?? {});
      return feishu.issueBindCode();
    });
    routes.put("/api/feishu/chats/:pmId/policy", async (req, reply) => {
      const feishu = feishuOf(req, reply);
      if (feishu === null) return reply;
      const pmId = parseId((req.params as { pmId?: unknown }).pmId, "pm id");
      const body = parseWithSchema(feishuChatPolicyBodySchema, req.body);
      return feishu.setChatPolicy({ pmId, ...body });
    });
    routes.post(API_PATHS.feishuResync, async (req, reply) => {
      const feishu = feishuOf(req, reply);
      if (feishu === null) return reply;
      parseWithSchema(emptyObjectBodySchema, req.body ?? {});
      return feishu.resync();
    });
    routes.post(API_PATHS.feishuDisconnect, async (req, reply) => {
      const feishu = feishuOf(req, reply);
      if (feishu === null) return reply;
      const body = parseWithSchema(feishuDisconnectSchema, req.body);
      return feishu.disconnect(body);
    });

    routes.get(API_PATHS.ws, { websocket: true }, (socket, req) => {
      // 自己从 URL 取参数：injectWS 造的请求没有 req.query；重复的 since 当作不合法。
      const sinceValues = new URL(req.url, "http://localhost").searchParams.getAll("since");
      const since = sinceValues.length === 1 ? sinceValues[0] : sinceValues.length === 0 ? undefined : null;
      const isPeerSocket = peerOf(req) !== undefined;
      const send = (message: WsServerMessage) => {
        if (isPeerSocket && (message.type === "router.command.created" || message.type === "router.command.updated")) return;
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      };
      wsSenders.add(send);
      const removeSender = () => wsSenders.delete(send);
      socket.once("close", removeSender);
      socket.once("error", removeSender);
      // 先订阅再补齐：账本是同步的，两步之间不会有变化插进来，所以每条只推一次、seq 递增。
      const unsubscribe = ledger.onChange(send);
      socket.once("close", unsubscribe);
      socket.once("error", unsubscribe);
      // 账号组网的状态不在账本的变化流里：变了让本机浏览器重拉 GET /api/account（别的设备来的不推，它们看不到本机的账号接口）
      if (opts.mesh && !isPeerSocket) {
        const offAccount = opts.mesh.onChange(() => send({ type: "account.updated" }));
        socket.once("close", offAccount);
        socket.once("error", offAccount);
      }
      // 网页 → 服务端只有前台上报（WsClientMessage）；别的、坏的忽略。组网入口来的（别的设备直连或转发来的浏览器）不收：
      // 前台状态只属于入口本机已登录的浏览器（跟 /api/push/* 一样）
      if (push !== undefined && sessionOf(req) !== undefined) {
        socket.on("message", (data: Buffer, isBinary: boolean) => {
          const message = isBinary ? null : parsePresence(data.toString("utf8"));
          if (message !== null) push.presence.report(socket, message);
        });
        const forget = () => push.presence.remove(socket);
        socket.once("close", forget);
        socket.once("error", forget);
      }
      trackSocket(req, socket);
      keepAlive(socket, opts.wsHeartbeatMs);

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
  /** 组网入口：把验过身份的 TLS 连接（daemon/mesh/ 的 onConnection）交给界面服务，按这台设备的身份认。 */
  acceptMeshConnection(connection: MeshConnection): void;
  /** 优雅关闭：断开 WebSocket、停止监听、断开组网连接。 */
  close(): Promise<void>;
}

/** 只监听 127.0.0.1，不提供改地址的选项。port 为 0 时由系统分配，实际端口看返回值。组网入口不另听端口：连接由 daemon/mesh/ 交进来。 */
export async function startUiServer(opts: UiServerOptions & { port: number }): Promise<RunningUiServer> {
  const app = createUiServer(opts);
  await app.listen({ host: "127.0.0.1", port: opts.port });
  const addr = app.server.address();
  if (addr === null || typeof addr !== "object") throw new Error("ui-server is not listening on a TCP port");
  const meshServer: Server = createServer((req, res) => {
    listenerOf.set(req, "mesh");
    app.routing(req, res);
  });
  meshServer.on("upgrade", (req: IncomingMessage, socket, head) => {
    listenerOf.set(req, "mesh");
    app.server.emit("upgrade", req, socket, head);
  });
  const close = async () => {
    // 先关 Fastify（断开 WebSocket），再断组网入口上剩下的连接
    await app.close();
    meshServer.closeAllConnections();
  };
  return {
    app,
    port: addr.port,
    acceptMeshConnection(connection) {
      meshPeerOf.set(connection.socket, connection.peer.id);
      meshServer.emit("connection", connection.socket);
    },
    close,
  };
}
