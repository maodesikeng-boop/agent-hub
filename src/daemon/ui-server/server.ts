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
  token: string;
  db?: Db;
  rotateToken?: () => string;
  now?: () => number;
  uploadsDir: string;
  sentFilesDir: string;
  staticDir: string;
  /** DNS rebinding protection compares the Host port; before listen (inject in tests) this value is used. */
  port?: number;
  logger?: boolean;
  models?: { list(options?: { refresh?: boolean | "unusable"; vendor?: AgentVendor }): Promise<ModelCatalog[]> };
  quota?: { get(): Promise<QuotaResponse> };
  composer?: ComposerService;
  vendorSync?: VendorSyncService;
  capabilityInventory?: CapabilityInventoryService;
  providers?: ProviderManager;
  folderPicker?: FolderPicker;
  runOpen?: RunOpen;
  serverInfo?: ServerInfo;
  push?: {
    publicKey: string;
    subscribe(subscription: PushSubscriptionRecord): void;
    unsubscribe(endpoint: string): void;
    presence: PresenceBoard;
  };
  feishu?: FeishuSetupService;
  peers?: Peers;
  mesh?: NonNullable<PeerRoutesOptions["mesh"]> & Pick<Mesh, "onChange" | "trust">;
  feishuPeer?: PeerRoutesOptions["feishuPeer"];
  peerProxy?: PeerRoutesOptions["proxy"];
  wsHeartbeatMs?: number;
  routerDispatcher?: RouterDispatcher;
  routerLocalPort?: RouterTargetPort;
  selfReload?: {
    request(input: { build: boolean; by: string }): SelfReloadResponse;
    status(): SelfReloadStatus;
  };
}

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const COOKIE_MAX_AGE_SECONDS = SESSION_MAX_AGE_MS / 1000;
const WS_CLOSE_UNAUTHORIZED = 1008;
/** Cap length so clientId cannot inflate dedupe keys. */
const MAX_CLIENT_ID_LENGTH = 200;
const POSITIVE_INT = /^[1-9]\d*$/;
const NON_NEGATIVE_INT = /^(0|[1-9]\d*)$/;
const HOST_HEADER = /^(?:127\.0\.0\.1|localhost):(\d+)$/i;
const ORIGIN_HEADER = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)$/i;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type Listener = "uiPort" | "mesh";
const listenerOf = new WeakMap<IncomingMessage, Listener>();
const meshPeerOf = new WeakMap<object, DeviceId>();

type Entry =
  | { kind: "loopback" }
  | { kind: "mesh" };
type EntryKind = Entry["kind"];

type Identity =
  | { kind: "cookie"; sessionId: string }
  | { kind: "meshDevice"; peer: DeviceId }
  | { kind: "none" };
type IdentityKind = Exclude<Identity["kind"], "none">;

type EntryRejection = "forbidden_host" | "forbidden_identity";

interface EntryRule {
  listeners: readonly Listener[];
  host: ((req: FastifyRequest) => Entry | EntryRejection | null) | null;
  origin: ((origin: string, entry: Entry) => boolean) | null;
  identities: readonly IdentityKind[];
  sameMachine: boolean;
  browserPaths: boolean;
}

interface RequestContext {
  entry: Entry;
  rule: EntryRule;
  identity: Identity;
}

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

/** Compare sha256 digests so timing leaks neither token length nor prefix. */
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

function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "unsatisfiable" {
  const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  // RFC 9110 says an inverted range is invalid and must be ignored.
  if (match[2] !== "" && Number(match[2]) < start) return null;
  if (start >= size) return "unsatisfiable";
  return { start, end: match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1) };
}

/** Stored files are untrusted; the sandbox CSP prevents them from executing as pages even when opened directly. */
const STORED_FILE_CSP = "sandbox; default-src 'none'";
const SVG_MIME = "image/svg+xml";
/** SVG needs inline styles or it renders black under default-src 'none'; scripts stay blocked by sandbox and default-src. */
const SVG_CSP = `${STORED_FILE_CSP}; style-src 'unsafe-inline'`;

const wantsPreview = (req: FastifyRequest) => (req.query as { inline?: unknown }).inline === "1";
/** HTML previews run scripts in an opaque origin (no allow-same-origin), so they get no cookies and fail the Origin check. */
const HTML_PREVIEW_CSP = "sandbox allow-scripts";

function sendStoredFile(req: FastifyRequest, reply: FastifyReply, file: Pick<Attachment, "name" | "path" | "size" | "mime">) {
  req.headers["x-no-compression"] = "1";
  const preview = wantsPreview(req);
  const inline = isImageMime(file.mime) || (preview && (file.mime === "application/pdf" || file.mime === "text/html"));
  // Without an explicit charset, Chinese pages render as Latin-1 mojibake.
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
  const runOpen: RunOpen =
    opts.runOpen ??
    (serverInfo.fileActions
      ? runOpenCommand
      : async () => {
          throw new FileActionsUnavailable();
        });
  if (!UI_TOKEN_PATTERN.test(opts.token)) throw new Error("ui token must be at least 16 characters of [A-Za-z0-9_-]");
  const instanceId = randomUUID();
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
  const socketsBySession = new Map<string, Set<{ close(code?: number, reason?: string): void }>>();
  const closeSockets = (sessionId?: string) => {
    for (const [id, sockets] of socketsBySession) {
      if (sessionId !== undefined && id !== sessionId) continue;
      for (const socket of sockets) socket.close(WS_CLOSE_UNAUTHORIZED, "unauthorized");
      socketsBySession.delete(id);
    }
  };
  const contexts = new WeakMap<IncomingMessage, RequestContext>();
  const contextOf = (req: FastifyRequest) => contexts.get(req.raw);
  const sessionOf = (req: FastifyRequest) => {
    const identity = contextOf(req)?.identity;
    return identity?.kind === "cookie" ? identity.sessionId : undefined;
  };
  const peerOf = (req: FastifyRequest) => {
    const identity = contextOf(req)?.identity;
    return identity?.kind === "meshDevice" ? identity.peer : undefined;
  };
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

  const sessionToken = (req: FastifyRequest) => readCookie(req.headers.cookie, uiCookieName(req.headers.host));

  /** Secure cannot be set on http://127.0.0.1 or browsers drop the cookie. */
  const sessionCookie = (req: FastifyRequest, value: string, maxAgeSeconds: number) =>
    `${uiCookieName(req.headers.host)}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;

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


  const isLoopbackOrigin = (origin: string) => {
    const match = ORIGIN_HEADER.exec(origin);
    const port = listeningPort();
    return match !== null && port !== undefined && match[1] === String(port);
  };

  const entryRules: Record<EntryKind, EntryRule> = {
    // DNS rebinding protection applies to every path, including static files and /auth.
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
    // Mesh peers are identified by their TLS certificate; Host and Origin are attacker-controlled and cookies are ignored.
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

  const isUpgrade = (req: FastifyRequest) => (req.headers.upgrade ?? "").toLowerCase() === "websocket";

  app.addHook("onRequest", async (req, reply) => {
    const entry = resolveEntry(req);
    if (typeof entry === "string") return fail(reply, entry);
    const rule = entryRules[entry.kind];
    const path = pathOf(req);
    reply.header("cache-control", "no-store");

    if (!rule.identities.includes("meshDevice") && path.startsWith("/api/peer/")) return fail(reply, "forbidden_peer");

    // A device removed from the trust table after its handshake is rejected here.
    let identity: Identity = { kind: "none" };
    if (rule.identities.includes("meshDevice")) {
      const peer = meshPeerOf.get(req.raw.socket);
      if (peer === undefined || opts.mesh?.trust.get(peer) === undefined || opts.peers === undefined) return fail(reply, "peer_unauthorized");
      identity = { kind: "meshDevice", peer };
      if (!inDeviceScope(path)) return fail(reply, "forbidden_peer");
    }

    if (identity.kind === "none") {
      // Browsers treat other localhost ports as same-site, so SameSite=Strict does not stop them; state-changing requests and WebSocket handshakes require a matching Origin.
      const unsafe = !SAFE_METHODS.has(req.method) || path === API_PATHS.ws || isUpgrade(req);
      if (unsafe && rule.origin !== null && !rule.origin(req.headers.origin ?? "", entry)) return fail(reply, "forbidden_origin");

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

  const clientAddress = (req: FastifyRequest) => (contextOf(req)?.rule.sameMachine ? req.ip : undefined);

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

  // @fastify/websocket's hook never runs after this hook rejects, so close the socket here or it hangs until shutdown.
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
    if (status === 413) return fail(reply, "too_large");
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

  app.register(async (uploads) => {
    uploads.removeAllContentTypeParsers();
    uploads.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

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
      if (Number(req.headers["content-length"]) > MAX_UPLOAD_BYTES) {
        reply.header("connection", "close");
        throw new UploadError(413, UPLOAD_TOO_LARGE_MESSAGE);
      }
      const { name } = req.query as { name?: unknown };
      return saveUpload(uploadsDir, typeof name === "string" ? name : "", req.body instanceof Readable ? req.body : Buffer.alloc(0));
    });

    // Wildcard because Fastify caps named params at 100 characters and long file names would 404.
    uploads.get("/api/uploads/:id/*", async (req, reply) => {
      const attachment = resolveUpload(uploadsDir, String((req.params as { id?: unknown }).id ?? ""));
      if (attachment === null) return fail(reply, "not_found");
      const mime = wantsPreview(req) ? sentFileMime(attachment.name) : attachment.mime;
      return sendStoredFile(req, reply, { ...attachment, mime });
    });
  });

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

  // @fastify/websocket's onRoute hook only sees routes registered after it, so routes live inside a plugin.
  app.register(async (routes) => {
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
      if (id === sessionOf(req)) reply.header("set-cookie", sessionCookie(req, "", 0));
      return reply.code(204).send();
    });

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
      const router = peerOf(req) !== undefined ? { ...snap.router, commands: [], commandsHasMore: false } : snap.router;
      return {
        ...snap,
        router,
        server: serverInfoForClient(serverInfo, clientAddress(req)),
        bootId: instanceId,
      };
    });

    routes.get(API_PATHS.models, async (req): Promise<ModelsResponse> => {
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
      const attachments = attachmentIds.map((id) => resolveUpload(uploadsDir, id) ?? undefined);
      if (attachments.some((a) => a === undefined)) throw new LedgerRequestError("invalid", ATTACHMENTS_MISSING_MESSAGE);
      return ledger.postUserMessage({
        conversationId,
        clientId,
        text,
        ...(attachments.length > 0 ? { attachments: attachments as NonNullable<(typeof attachments)[number]>[] } : {}),
        ...(workerPick !== undefined ? { workerPick } : {}),
      });
    });

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
    // A remote browser would open the file on the daemon machine's screen, not the user's.
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
      // injectWS requests have no req.query, so parse the URL directly.
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
      // The ledger is synchronous, so nothing can land between subscribe and backfill; each change is sent once in seq order.
      const unsubscribe = ledger.onChange(send);
      socket.once("close", unsubscribe);
      socket.once("error", unsubscribe);
      if (opts.mesh && !isPeerSocket) {
        const offAccount = opts.mesh.onChange(() => send({ type: "account.updated" }));
        socket.once("close", offAccount);
        socket.once("error", offAccount);
      }
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

      if (since === undefined) return;
      if (typeof since !== "string" || !NON_NEGATIVE_INT.test(since)) return send({ type: "resync" });
      try {
        const result = ledger.changesSince(Number(since));
        if (result.kind === "resync") return send({ type: "resync" });
        for (const change of result.changes) send(change);
      } catch (err) {
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
  acceptMeshConnection(connection: MeshConnection): void;
  close(): Promise<void>;
}

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
    // Close Fastify first to drop WebSockets, then the remaining mesh connections.
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
