import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { LRUCache } from "lru-cache";
import { z } from "zod";
import {
  API_PATHS,
  ATTACHMENTS_MISSING_MESSAGE,
  ATTACHMENTS_TOO_MANY_MESSAGE,
  ConversationNotFoundError,
  DEFAULT_PM_MODE,
  LedgerRequestError,
  AGENT_VENDORS,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_MODEL_CHARS,
  MAX_PATH_BYTES,
  MESH_DIAL_TIMEOUT_MS,
  MESH_MAX_DEVICES_PER_ACCOUNT,
  MAX_TASK_BYTES,
  PM_MODES,
  PRODUCT_NAME,
  ROUTER_ATTACHMENT_ID_MAX_CHARS,
  ROUTER_OP_CLIENT_ID_MAX_CHARS,
  ROUTER_OP_DEDUPE_MAX,
  ROUTER_OP_DEDUPE_TTL_MS,
  ROUTER_OP_NAME_MAX_CHARS,
  ROUTER_PEER_DIGEST_MAX_BYTES,
  ROUTER_PEER_DIGEST_TIMEOUT_MS,
  ROUTER_PEER_DIGEST_TTL_MS,
  ROUTER_PEER_DISPATCH_TIMEOUT_MS,
  ROUTER_PEER_OFFLINE_BACKOFF_MS,
  agentTextOf,
  parseDeviceRouterDigest,
  type AgentVendor,
  type Attachment,
  type ConversationId,
  type DeviceId,
  type DeviceInfo,
  type DeviceRouterDigest,
  type HubCallContext,
  type MessageId,
  type PmId,
  type PmMode,
  type ProjectId,
  type RouterCommandId,
  type WorkerId,
  type WorkspaceProbe,
} from "../../shared/index.ts";
import { probeWorkspace as defaultProbeWorkspace } from "../git/index.ts";
import type { SqliteLedger } from "../ledger/index.ts";
import { agentFetch } from "../mesh/agent-fetch.ts";
import type { ProxyTarget } from "../peers/proxy.ts";
import { resolveUpload } from "../uploads.ts";
import type { ProjectCatalogDetail } from "../../shared/project-catalog.ts";

export type RouterTargetErrorCode =
  | "device_offline"
  | "device_timeout"
  | "device_not_found"
  | "not_found"
  | "conflict"
  | "invalid"
  | "forbidden";

export class RouterTargetError extends Error {
  readonly code: RouterTargetErrorCode;
  constructor(code: RouterTargetErrorCode, message: string) {
    super(message);
    this.name = "RouterTargetError";
    this.code = code;
  }
}

const opClientIdSchema = z.string().min(1).max(ROUTER_OP_CLIENT_ID_MAX_CHARS);
const opIdSchema = z.number().int().positive();
const opBytesSchema = (maxBytes: number, what: string) =>
  z.string().refine((v) => Buffer.byteLength(v, "utf8") <= maxBytes, `${what} 不能超过 ${maxBytes} 字节`);
const opCharsSchema = (maxChars: number, what: string) =>
  z.string().refine((v) => [...v].length <= maxChars, `${what} 不能超过 ${maxChars} 字`);
const opTextSchema = opBytesSchema(MAX_TASK_BYTES, "正文");
const opAttachmentIdsSchema = z
  .array(z.string().min(1).max(ROUTER_ATTACHMENT_ID_MAX_CHARS))
  .max(MAX_ATTACHMENTS_PER_MESSAGE)
  .optional();
const opNameSchema = opCharsSchema(ROUTER_OP_NAME_MAX_CHARS, "名称").optional();
const opModelSchema = z.string().min(1).max(MAX_MODEL_CHARS).optional();

export const routerTargetOpSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("pm.forward"),
      clientId: opClientIdSchema,
      pmId: opIdSchema.optional(),
      projectId: opIdSchema.optional(),
      text: opTextSchema,
      attachmentIds: opAttachmentIdsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("worker.start"),
      clientId: opClientIdSchema,
      projectId: opIdSchema,
      title: z.string().min(1).max(ROUTER_OP_NAME_MAX_CHARS),
      task: opTextSchema,
      attachmentIds: opAttachmentIdsSchema,
      vendor: z.enum(AGENT_VENDORS).optional(),
      model: opModelSchema,
      effort: opModelSchema,
      readonly: z.boolean().optional(),
      noWorktree: z.boolean().optional(),
      sourceCommandId: opIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("worker.send"),
      clientId: opClientIdSchema,
      workerId: opIdSchema,
      text: opTextSchema,
      attachmentIds: opAttachmentIdsSchema,
    })
    .strict(),
  z.object({ kind: z.literal("worker.stop"), workerId: opIdSchema }).strict(),
  z.object({ kind: z.literal("worker.end"), workerId: opIdSchema }).strict(),
  z.object({ kind: z.literal("worker.list"), projectId: opIdSchema.optional() }).strict(),
  z.object({ kind: z.literal("project.show"), projectId: opIdSchema }).strict(),
  z
    .object({
      kind: z.literal("project.create"),
      clientId: opClientIdSchema,
      folder: opBytesSchema(MAX_PATH_BYTES, "folder")
        .refine((v) => v.trim() !== "", "folder 不能是空的")
        .refine((v) => !v.includes("\0"), "folder 不能含 NUL 字符"),
      name: opNameSchema,
      pmName: opNameSchema,
      vendor: z.enum(AGENT_VENDORS).optional(),
      mode: z.enum(PM_MODES).optional(),
    })
    .strict(),
]);

export type RouterTargetOp = z.infer<typeof routerTargetOpSchema>;

export type RouterTargetOpResult =
  | {
      kind: "pm.forward";
      pmId: PmId;
      pmName: string;
      projectId: ProjectId | null;
      projectName: string | null;
      conversationId: ConversationId;
      messageId: MessageId;
    }
  | {
      kind: "worker.start";
      pmId: PmId;
      pmName: string;
      projectId: ProjectId;
      projectName: string;
      workerId: WorkerId;
      workerConversationId: ConversationId;
      title: string;
      readonly: boolean;
      pmMessageId: MessageId;
    }
  | {
      kind: "worker.send";
      pmId: PmId;
      workerId: WorkerId;
      workerConversationId: ConversationId;
      title: string;
      messageId: MessageId;
    }
  | {
      kind: "worker.stop";
      pmId: PmId;
      workerId: WorkerId;
      workerConversationId: ConversationId;
      title: string;
    }
  | {
      kind: "worker.end";
      pmId: PmId;
      workerId: WorkerId;
      workerConversationId: ConversationId;
      title: string;
    }
  | {
      kind: "worker.list";
      workers: Array<{
        id: WorkerId;
        projectId: ProjectId;
        title: string;
        status: string;
        activity: string;
        readonly: boolean;
        vendor: string;
        model: string | null;
      }>;
    }
  | {
      kind: "project.create";
      pmId: PmId;
      pmName: string;
      projectId: ProjectId;
      projectName: string;
      conversationId: ConversationId;
    }
  | {
      kind: "project.show";
      projectId: ProjectId;
      detail: ProjectCatalogDetail | null;
    };

export interface DigestFetchResult {
  online: boolean;
  stale?: boolean;
  digest: DeviceRouterDigest | null;
  error?: string;
}

export interface RouterTargetPort {
  readonly deviceId: DeviceId;
  readonly deviceName: string;
  readonly isLocal: boolean;
  getDigest(): Promise<DigestFetchResult>;
  executeOp(op: RouterTargetOp): Promise<RouterTargetOpResult>;
}

function resolveAttachmentsOrThrow(uploadsDir: string | undefined, ids?: readonly string[]): Attachment[] {
  if (!ids || ids.length === 0) return [];
  if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new RouterTargetError("invalid", ATTACHMENTS_TOO_MANY_MESSAGE);
  }
  if (!uploadsDir) {
    throw new RouterTargetError("invalid", ATTACHMENTS_MISSING_MESSAGE);
  }
  const out: Attachment[] = [];
  for (const id of ids) {
    const att = resolveUpload(uploadsDir, id);
    if (att === null) throw new RouterTargetError("invalid", ATTACHMENTS_MISSING_MESSAGE);
    out.push(att);
  }
  return out;
}

function wrapLedgerError(err: unknown): never {
  if (err instanceof RouterTargetError) throw err;
  if (err instanceof ConversationNotFoundError) {
    throw new RouterTargetError("not_found", err.message);
  }
  if (err instanceof LedgerRequestError) {
    throw new RouterTargetError(err.code === "git_failed" ? "conflict" : err.code, err.message);
  }
  throw new RouterTargetError("invalid", err instanceof Error ? err.message : String(err));
}

export interface LocalTargetPortOptions {
  deviceId: DeviceId;
  deviceName: string | (() => string);
  ledger: SqliteLedger;
  uploadsDir?: string;
  probeWorkspace?: (folder: string) => Promise<WorkspaceProbe>;
  refreshVendor?: (vendor: AgentVendor) => Promise<unknown>;
}

export function createLocalTargetPort(options: LocalTargetPortOptions): RouterTargetPort {
  const { deviceId, ledger, uploadsDir } = options;
  const resolveDeviceName =
    typeof options.deviceName === "function" ? options.deviceName : () => options.deviceName as string;
  const probeWorkspace = options.probeWorkspace ?? defaultProbeWorkspace;
  // Idempotency key excludes attachment ids because they change on every retry.
  const opDedupe = new LRUCache<string, RouterTargetOpResult>({ max: ROUTER_OP_DEDUPE_MAX, ttl: ROUTER_OP_DEDUPE_TTL_MS });
  const opInflight = new Map<string, Promise<RouterTargetOpResult>>();
  const dedupeOnce = (key: string, run: () => Promise<RouterTargetOpResult>): Promise<RouterTargetOpResult> => {
    const cached = opDedupe.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = opInflight.get(key);
    if (pending !== undefined) return pending;
    // Only successes are remembered, so a failed request retries normally.
    const p = run()
      .then((res) => {
        opDedupe.set(key, res);
        return res;
      })
      .finally(() => opInflight.delete(key));
    opInflight.set(key, p);
    return p;
  };

  return {
    get deviceId() {
      return deviceId;
    },
    get deviceName() {
      return resolveDeviceName();
    },
    isLocal: true,

    async getDigest(): Promise<DigestFetchResult> {
      return {
        online: true,
        digest: ledger.getRouterDigest(),
      };
    },

    async executeOp(rawOp: RouterTargetOp): Promise<RouterTargetOpResult> {
      const parsed = routerTargetOpSchema.safeParse(rawOp);
      if (!parsed.success) {
        throw new RouterTargetError("invalid", parsed.error.issues[0]?.message ?? "目标操作参数不正确");
      }
      const op = parsed.data;

      try {
        switch (op.kind) {
          case "pm.forward": {
            const target = ledger.resolveRouterLocalPmOrProject({
              pmId: op.pmId,
              projectId: op.projectId,
            });
            let messageId = ledger.postedUserMessageId(target.conversationId, op.clientId);
            if (messageId === undefined) {
              const attachments = resolveAttachmentsOrThrow(uploadsDir, op.attachmentIds);
              messageId = ledger.postUserMessage({
                conversationId: target.conversationId,
                clientId: op.clientId,
                text: op.text,
                ...(attachments.length > 0 ? { attachments } : {}),
              }).messageId;
            }
            return {
              kind: "pm.forward",
              pmId: target.pmId,
              pmName: target.pmName,
              projectId: target.projectId,
              projectName: target.projectName,
              conversationId: target.conversationId,
              messageId,
            };
          }

          case "worker.start": {
            const dedupeKey = JSON.stringify(["worker.start", op.clientId, op.projectId, op.title]);
            return await dedupeOnce(dedupeKey, async () => {
              const target = ledger.resolveRouterLocalPmOrProject({ projectId: op.projectId });
              if (target.projectId === null || target.mainFolder === null) {
                throw new RouterTargetError("not_found", `项目 #${op.projectId} 不存在或未绑定主文件夹`);
              }
              const attachments = resolveAttachmentsOrThrow(uploadsDir, op.attachmentIds);
              const fullTask =
                attachments.length > 0
                  ? agentTextOf({ text: op.task, meta: { attachments } })
                  : op.task;

              const hubCtx: HubCallContext = {};
              if (!op.noWorktree) {
                hubCtx.workspace = await probeWorkspace(target.mainFolder);
              }
              if (op.vendor !== undefined && options.refreshVendor) await options.refreshVendor(op.vendor as AgentVendor);

              const started = ledger.hubCall(
                target.sessionId,
                "worker.start",
                {
                  title: op.title,
                  task: fullTask,
                  ...(op.vendor !== undefined ? { vendor: op.vendor as AgentVendor } : {}),
                  ...(op.model !== undefined ? { model: op.model } : {}),
                  ...(op.effort !== undefined ? { effort: op.effort } : {}),
                  ...(op.readonly !== undefined ? { readonly: op.readonly } : {}),
                  ...(op.noWorktree !== undefined ? { noWorktree: op.noWorktree } : {}),
                },
                hubCtx,
              ).data.worker;

              let pmMessageId: MessageId = 0;
              if (op.sourceCommandId !== undefined) {
                pmMessageId =
                  ledger.recordRouterWorkerOrigin({
                    workerId: started.id,
                    sourceKind: "router_command",
                    sourceId: op.sourceCommandId,
                  }) ?? 0;
              }

              const res: RouterTargetOpResult = {
                kind: "worker.start",
                pmId: target.pmId,
                pmName: target.pmName,
                projectId: target.projectId,
                projectName: target.projectName ?? `#${target.projectId}`,
                workerId: started.id,
                workerConversationId: started.workerConversationId,
                title: started.title,
                readonly: started.readonly,
                pmMessageId,
              };
              return res;
            });
          }

          case "worker.send": {
            const w = ledger.resolveRouterLocalWorker(op.workerId);
            const attachments = resolveAttachmentsOrThrow(uploadsDir, op.attachmentIds);
            const fullText =
              attachments.length > 0
                ? agentTextOf({ text: op.text, meta: { attachments } })
                : op.text;
            const sent = ledger.hubCall(w.pmSessionId, "worker.send", {
              workerId: w.workerId,
              text: fullText,
            }, { routerDeliveryId: op.clientId }).data;
            return {
              kind: "worker.send",
              pmId: w.pmId,
              workerId: w.workerId,
              workerConversationId: w.workerConversationId,
              title: w.title,
              messageId: sent.messageId,
            };
          }

          case "worker.stop": {
            const w = ledger.resolveRouterLocalWorker(op.workerId);
            ledger.requestStop(w.workerConversationId);
            return {
              kind: "worker.stop",
              pmId: w.pmId,
              workerId: w.workerId,
              workerConversationId: w.workerConversationId,
              title: w.title,
            };
          }

          case "worker.end": {
            const w = ledger.resolveRouterLocalWorker(op.workerId);
            ledger.hubCall(w.pmSessionId, "worker.end", { workerId: w.workerId });
            return {
              kind: "worker.end",
              pmId: w.pmId,
              workerId: w.workerId,
              workerConversationId: w.workerConversationId,
              title: w.title,
            };
          }

          case "worker.list": {
            return {
              kind: "worker.list",
              workers: ledger.listRouterLocalWorkers(op.projectId),
            };
          }

          case "project.show":
            return { kind: "project.show", projectId: op.projectId, detail: ledger.projectCatalog.detailOf(op.projectId) };

          case "project.create": {
            const dedupeKey = JSON.stringify(["project.create", op.clientId, op.folder, op.name ?? null]);
            return await dedupeOnce(dedupeKey, async () => {
              const resolvedFolder =
                op.folder === "~"
                  ? homedir()
                  : op.folder.startsWith("~/")
                    ? resolve(homedir(), op.folder.slice(2))
                    : op.folder;
              const pmName = op.pmName?.trim() || (op.name?.trim() ? `${op.name.trim()}负责人` : "项目经理");
              const created = ledger.createPm({
                name: pmName,
                mode: op.mode ?? DEFAULT_PM_MODE,
                ...(op.vendor !== undefined ? { vendor: op.vendor as AgentVendor } : {}),
                persona: "",
            });
            let proj;
            try {
              proj = ledger.hubCall(created.sessionId, "project.create", {
                folder: resolvedFolder,
                ...(op.name?.trim() ? { name: op.name.trim() } : {}),
              }).data.project;
            } catch (err) {
              try {
                ledger.archivePm(created.pm.id);
              } catch {
              }
              throw err;
            }
            const res: RouterTargetOpResult = {
              kind: "project.create",
              pmId: created.pm.id,
              pmName: created.pm.name,
              projectId: proj.id,
              projectName: proj.name,
              conversationId: created.conversation.id,
            };
            return res;
            });
          }
        }
      } catch (err) {
        return wrapLedgerError(err);
      }
    },
  };
}

export interface PeersLike {
  readonly selfId: DeviceId;
  list(): DeviceInfo[];
  target(id: string): ProxyTarget | null;
}

interface CachedPeerDigestEntry {
  endpointKey: string;
  kind: "ok" | "offline";
  digest: DeviceRouterDigest | null;
  error?: string;
  expiresAt: number;
}

export interface RouterTargetRegistryOptions {
  localPort: RouterTargetPort;
  peers?: PeersLike;
  uploadsDir?: string;
  now?: () => number;
  peerDigestTtlMs?: number;
  peerDigestTimeoutMs?: number;
  peerOfflineBackoffMs?: number;
  peerDispatchTimeoutMs?: number;
  peerDialTimeoutMs?: number;
}

export interface RouterTargetRegistry {
  readonly selfId: DeviceId;
  selfDeviceId(): DeviceId;
  listDevices(): DeviceInfo[];
  portFor(deviceIdOrSelf: string): RouterTargetPort | null;
  getPort(deviceIdOrSelf: string): RouterTargetPort | null;
  listPorts(): RouterTargetPort[];
  listAllDigests(): Promise<Array<{ port: RouterTargetPort; result: DigestFetchResult }>>;
  invalidatePeer(deviceId: DeviceId): void;
  close(): void;
}

function endpointFingerprint(target: ProxyTarget | null): string {
  return target === null ? "none" : "mesh";
}

function isAbortTimeoutError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return true;
    if (/aborted|timed?\s*out/i.test(err.message)) return true;
  }
  return false;
}

interface PeerCallInit {
  method: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs: number;
  /** Separate budget for opening the mesh link; when set, timeoutMs starts once the link is up. */
  dialTimeoutMs?: number;
  maxResponseBytes?: number;
}

class ResponseTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`response exceeded ${maxBytes} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

async function readResponseText(res: Response, maxBytes?: number): Promise<string> {
  if (maxBytes === undefined) return await res.text();
  const contentLength = res.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new ResponseTooLargeError(maxBytes);
    }
  }
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ResponseTooLargeError(maxBytes);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

async function callPeer(target: ProxyTarget, path: string, init: PeerCallInit, closing: AbortSignal): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), init.dialTimeoutMs ?? init.timeoutMs);
  let settled = false;
  const onSocket = () => {
    if (settled) return;
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), init.timeoutMs);
  };
  try {
    const res = await agentFetch(target.agent, path, {
      method: init.method,
      headers: init.headers ?? {},
      signal: AbortSignal.any([controller.signal, closing]),
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.dialTimeoutMs !== undefined ? { onSocket } : {}),
    });
    const text = await readResponseText(res, init.maxResponseBytes);
    return { status: res.status, text };
  } catch (err) {
    if (err instanceof ResponseTooLargeError) {
      throw new RouterTargetError("invalid", `设备「${target.name}」返回的数据超过上限`);
    }
    if (err instanceof RouterTargetError) throw err;
    if (controller.signal.aborted || isAbortTimeoutError(err)) {
      throw new RouterTargetError("device_timeout", `连接设备「${target.name}」超时，请检查网络后重试`);
    }
    throw new RouterTargetError("device_offline", `设备「${target.name}」当前离线，请确认设备在线后再试`);
  } finally {
    settled = true;
    clearTimeout(timer);
  }
}

interface FetchPeerDigestParams {
  readonly info: DeviceInfo;
  readonly target: ProxyTarget | null;
  readonly digestCache: LRUCache<DeviceId, CachedPeerDigestEntry>;
  readonly now: () => number;
  readonly digestTtlMs: number;
  readonly digestTimeoutMs: number;
  readonly offlineBackoffMs: number;
  readonly dialTimeoutMs: number;
  readonly closing: AbortSignal;
}

async function fetchPeerDigest(params: FetchPeerDigestParams): Promise<DigestFetchResult> {
  const { info, target, digestCache, now, digestTtlMs, digestTimeoutMs, offlineBackoffMs, dialTimeoutMs, closing } = params;
  const epKey = endpointFingerprint(target);
  const t = now();
  const cached = digestCache.get(info.id);
  if (cached !== undefined && cached.endpointKey === epKey && t < cached.expiresAt) {
    if (cached.kind === "ok" && cached.digest !== null) {
      return { online: true, digest: cached.digest };
    }
    return { online: false, digest: null, error: cached.error };
  }

  const cacheOffline = (errText: string, at: number): DigestFetchResult => {
    digestCache.set(info.id, {
      endpointKey: epKey,
      kind: "offline",
      digest: null,
      error: errText,
      expiresAt: at + offlineBackoffMs,
    });
    return { online: false, digest: null, error: errText };
  };

  if (target === null) {
    return cacheOffline(`设备「${info.name}」当前离线`, t);
  }

  try {
    // A cold relay dial alone can exceed the digest timeout, so a device the relay reports present gets the mesh dial budget on top.
    const { status, text } = await callPeer(
      target,
      API_PATHS.routerDigest,
      {
        method: "GET",
        timeoutMs: digestTimeoutMs,
        maxResponseBytes: ROUTER_PEER_DIGEST_MAX_BYTES,
        ...(info.online ? { dialTimeoutMs } : {}),
      },
      closing,
    );
    if (status < 200 || status >= 300) {
      return cacheOffline(`设备「${info.name}」返回异常（HTTP ${status}）`, now());
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return cacheOffline(`设备「${info.name}」返回的数据格式不正确`, now());
    }
    const parsed = parseDeviceRouterDigest(raw);
    if (!parsed.ok) {
      return cacheOffline(`设备「${info.name}」返回的数据格式不正确`, now());
    }
    digestCache.set(info.id, {
      endpointKey: epKey,
      kind: "ok",
      digest: parsed.digest,
      expiresAt: now() + digestTtlMs,
    });
    return { online: true, digest: parsed.digest };
  } catch (err) {
    const errText = err instanceof Error ? err.message : `设备「${info.name}」当前离线`;
    return cacheOffline(errText, now());
  }
}

export function createRouterTargetRegistry(options: RouterTargetRegistryOptions): RouterTargetRegistry {
  const { localPort, peers, uploadsDir } = options;
  const now = options.now ?? Date.now;
  const digestTtlMs = options.peerDigestTtlMs ?? ROUTER_PEER_DIGEST_TTL_MS;
  const digestTimeoutMs = options.peerDigestTimeoutMs ?? ROUTER_PEER_DIGEST_TIMEOUT_MS;
  const offlineBackoffMs = options.peerOfflineBackoffMs ?? ROUTER_PEER_OFFLINE_BACKOFF_MS;
  const dispatchTimeoutMs = options.peerDispatchTimeoutMs ?? ROUTER_PEER_DISPATCH_TIMEOUT_MS;
  const dialTimeoutMs = options.peerDialTimeoutMs ?? MESH_DIAL_TIMEOUT_MS;

  const closing = new AbortController();
  const digestCache = new LRUCache<DeviceId, CachedPeerDigestEntry>({ max: MESH_MAX_DEVICES_PER_ACCOUNT });

  const pruneUnpairedFromCache = (devices: readonly DeviceInfo[]) => {
    const activeIds = new Set(devices.filter((d) => !d.self).map((d) => d.id));
    for (const cachedId of digestCache.keys()) {
      if (!activeIds.has(cachedId)) digestCache.delete(cachedId);
    }
  };

  const makePeerPort = (info: DeviceInfo): RouterTargetPort => ({
    deviceId: info.id,
    deviceName: info.name,
    isLocal: false,

    getDigest(): Promise<DigestFetchResult> {
      return fetchPeerDigest({
        info,
        target: peers?.target(info.id) ?? null,
        digestCache,
        now,
        digestTtlMs,
        digestTimeoutMs,
        offlineBackoffMs,
        dialTimeoutMs,
        closing: closing.signal,
      });
    },

    async executeOp(op: RouterTargetOp): Promise<RouterTargetOpResult> {
      const target = peers?.target(info.id) ?? null;
      if (target === null) {
        throw new RouterTargetError(
          "device_offline",
          `设备「${info.name}」当前离线，请确认设备在线后再试`,
        );
      }

      let forwardedOp: RouterTargetOp = op;
      if (
        (op.kind === "pm.forward" || op.kind === "worker.start" || op.kind === "worker.send") &&
        op.attachmentIds &&
        op.attachmentIds.length > 0
      ) {
        const localAttachments = resolveAttachmentsOrThrow(uploadsDir, op.attachmentIds);
        const remoteIds: string[] = [];
        for (const att of localAttachments) {
          const bytes = await readFile(att.path);
          const uploadPath = `${API_PATHS.uploads}?name=${encodeURIComponent(att.name)}`;
          const upRes = await callPeer(
            target,
            uploadPath,
            { method: "POST", headers: { "content-type": att.mime || "application/octet-stream" }, body: bytes, timeoutMs: dispatchTimeoutMs },
            closing.signal,
          );
          if (upRes.status < 200 || upRes.status >= 300) {
            let reason = `上传附件「${att.name}」到设备「${info.name}」失败`;
            try {
              const parsedErr = JSON.parse(upRes.text) as { error?: string };
              if (parsedErr.error) reason = parsedErr.error;
            } catch {
            }
            throw new RouterTargetError("invalid", reason);
          }
          const parsedUp = JSON.parse(upRes.text) as { attachment?: { id?: string } };
          if (!parsedUp.attachment?.id) {
            throw new RouterTargetError("invalid", `设备「${info.name}」未返回有效附件编号`);
          }
          remoteIds.push(parsedUp.attachment.id);
        }
        if (op.kind === "worker.start") {
          const { sourceCommandId: _omit, ...rest } = op;
          forwardedOp = { ...rest, attachmentIds: remoteIds };
        } else {
          forwardedOp = { ...op, attachmentIds: remoteIds };
        }
      } else if (op.kind === "worker.start" && op.sourceCommandId !== undefined) {
        const { sourceCommandId: _omit, ...rest } = op;
        forwardedOp = rest;
      }

      const res = await callPeer(
        target,
        API_PATHS.routerTargetOps,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(forwardedOp), timeoutMs: dispatchTimeoutMs },
        closing.signal,
      );

      if (op.kind === "project.show" && res.status === 400) {
        throw new RouterTargetError("invalid", `设备「${info.name}」的 ${PRODUCT_NAME} 版本旧，不支持查看项目档案，请升级那台设备，或把问题转给它的项目经理`);
      }
      if (res.status < 200 || res.status >= 300) {
        let code: RouterTargetErrorCode = res.status === 404 ? "not_found" : res.status === 409 ? "conflict" : "invalid";
        let message = `设备「${info.name}」拒绝了操作（HTTP ${res.status}）`;
        try {
          const body = JSON.parse(res.text) as { error?: string; code?: string };
          if (typeof body.error === "string" && body.error.trim() !== "") message = body.error;
          if (
            body.code === "not_found" ||
            body.code === "conflict" ||
            body.code === "invalid" ||
            body.code === "forbidden" ||
            body.code === "device_offline" ||
            body.code === "device_not_found"
          ) {
            code = body.code;
          }
        } catch {
        }
        throw new RouterTargetError(code, message);
      }

      if (op.kind !== "worker.list" && op.kind !== "project.show") {
        digestCache.delete(info.id);
      }

      const body = JSON.parse(res.text) as { result: RouterTargetOpResult };
      return body.result;
    },
  });

  const listDevices = (): DeviceInfo[] => {
    if (!peers) {
      return [
        {
          id: localPort.deviceId,
          name: localPort.deviceName,
          platform: process.platform,
          self: true,
          online: true,
          link: "local",
          fingerprint: null,
        },
      ];
    }
    const list = peers.list();
    pruneUnpairedFromCache(list);
    return list;
  };

  const portFor = (deviceIdOrSelf: string): RouterTargetPort | null => {
    const normalized = deviceIdOrSelf.trim();
    const selfId = peers?.selfId ?? localPort.deviceId;
    if (normalized === "self" || normalized === "local" || normalized === selfId) {
      return localPort;
    }
    if (!peers) return null;
    const list = peers.list();
    pruneUnpairedFromCache(list);
    const found = list.find((d) => !d.self && d.id === normalized);
    if (!found) return null;
    return makePeerPort(found);
  };

  const listPorts = (): RouterTargetPort[] =>
    listDevices().map((d) => (d.self ? localPort : makePeerPort(d)));

  return {
    get selfId() {
      return peers?.selfId ?? localPort.deviceId;
    },
    selfDeviceId() {
      return peers?.selfId ?? localPort.deviceId;
    },
    listDevices,
    portFor,
    getPort: portFor,
    listPorts,
    async listAllDigests() {
      const ports = listPorts();
      return Promise.all(
        ports.map(async (port) => ({
          port,
          result: await port.getDigest(),
        })),
      );
    },
    invalidatePeer(deviceId: DeviceId) {
      digestCache.delete(deviceId);
    },
    close() {
      closing.abort();
      digestCache.clear();
    },
  };
}
