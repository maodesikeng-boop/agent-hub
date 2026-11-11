// Router 跨设备统一目标端口（docs/router-design.md §6.3）：
// - LocalTargetPort：直通本机 SqliteLedger，O(1) 索引解析目标，零拷贝转发原话与已上传附件引用；
// - PeerTargetPort：经 peers/（Tailscale TCP 或 SSH 隧道 Unix Socket）跨设备拉取 Digest、流式上传附件并转发操作；
// - RouterTargetRegistry：按设备管理端口，使用 lru-cache（上限 MAX_PEERS）做 10s Digest 缓存、5s 离线短暂退避，设备移除/地址变化即刻失效。
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
  MAX_PEERS,
  MAX_TASK_BYTES,
  PM_MODES,
  PEER_DEVICE_HEADER,
  ROUTER_ATTACHMENT_ID_MAX_CHARS,
  ROUTER_OP_CLIENT_ID_MAX_CHARS,
  ROUTER_OP_DEDUPE_MAX,
  ROUTER_OP_DEDUPE_TTL_MS,
  ROUTER_OP_NAME_MAX_CHARS,
  ROUTER_PEER_DIGEST_TIMEOUT_MS,
  ROUTER_PEER_DIGEST_TTL_MS,
  ROUTER_PEER_DISPATCH_TIMEOUT_MS,
  ROUTER_PEER_OFFLINE_BACKOFF_MS,
  agentTextOf,
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
  type VendorAvailability,
  type WorkerId,
  type WorkspaceProbe,
} from "../../shared/index.ts";
import { probeWorkspace as defaultProbeWorkspace } from "../git/index.ts";
import type { SqliteLedger } from "../ledger/index.ts";
import type { ProxyTarget } from "../peers/proxy.ts";
import { PEER_UNAUTHORIZED } from "../peers/service.ts";
import { createUnixHttpPool, type ResolvedPeerTarget, type UnixHttpPool } from "../peers/transport.ts";
import { resolveUpload } from "../uploads.ts";

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

// 跨设备 /api/router/target-ops 的载荷来自配对设备，按严格模式逐字段限长（未知字段直接拒），不靠下游再兜。
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
      sourceCommandId: opIdSchema.optional(),
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
  vendorUsable?: (vendor: AgentVendor) => Promise<VendorAvailability>;
}

export function createLocalTargetPort(options: LocalTargetPortOptions): RouterTargetPort {
  const { deviceId, ledger, uploadsDir } = options;
  const resolveDeviceName =
    typeof options.deviceName === "function" ? options.deviceName : () => options.deviceName as string;
  const probeWorkspace = options.probeWorkspace ?? defaultProbeWorkspace;
  // 本机 project.create / worker.start / worker.send 的幂等记忆：键 = clientId + 操作指纹（不含每次重传都会变的附件编号），
  // 同一 clientId 换了目标不会误命中旧结果；成功结果按 TTL 记，在途请求共用同一个 Promise（跨设备超时重试、模型并发重复调用都只执行一次）。
  const opDedupe = new LRUCache<string, RouterTargetOpResult>({ max: ROUTER_OP_DEDUPE_MAX, ttl: ROUTER_OP_DEDUPE_TTL_MS });
  const opInflight = new Map<string, Promise<RouterTargetOpResult>>();
  const dedupeOnce = (key: string, run: () => Promise<RouterTargetOpResult>): Promise<RouterTargetOpResult> => {
    const cached = opDedupe.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = opInflight.get(key);
    if (pending !== undefined) return pending;
    // 失败不记（下次重试照常执行），成功才进 TTL 记忆；在途表只在请求进行中有条目，跟并发请求数同量级
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
            const attachments = resolveAttachmentsOrThrow(uploadsDir, op.attachmentIds);
            const posted = ledger.postUserMessage({
              conversationId: target.conversationId,
              clientId: op.clientId,
              text: op.text,
              ...(attachments.length > 0 ? { attachments } : {}),
            });
            return {
              kind: "pm.forward",
              pmId: target.pmId,
              pmName: target.pmName,
              projectId: target.projectId,
              projectName: target.projectName,
              conversationId: target.conversationId,
              messageId: posted.messageId,
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
              if (op.vendor !== undefined && options.vendorUsable) {
                const vendor = op.vendor as AgentVendor;
                hubCtx.vendorStatus = {
                  vendor,
                  availability: await options.vendorUsable(vendor),
                  device: resolveDeviceName(),
                };
              }

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
            const dedupeKey = JSON.stringify(["worker.send", op.clientId, op.workerId]);
            return await dedupeOnce(dedupeKey, async () => {
              const w = ledger.resolveRouterLocalWorker(op.workerId);
              const attachments = resolveAttachmentsOrThrow(uploadsDir, op.attachmentIds);
              const fullText =
                attachments.length > 0
                  ? agentTextOf({ text: op.text, meta: { attachments } })
                  : op.text;
              const sent = ledger.hubCall(w.pmSessionId, "worker.send", {
                workerId: w.workerId,
                text: fullText,
              }).data;
              const res: RouterTargetOpResult = {
                kind: "worker.send",
                pmId: w.pmId,
                workerId: w.workerId,
                workerConversationId: w.workerConversationId,
                title: w.title,
                messageId: sent.messageId,
              };
              return res;
            });
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
                // ignore archive cleanup error
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
  forget(id: DeviceId): void;
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
  fetch?: typeof fetch;
  unixPool?: UnixHttpPool;
  now?: () => number;
  peerDigestTtlMs?: number;
  peerDigestTimeoutMs?: number;
  peerOfflineBackoffMs?: number;
  peerDispatchTimeoutMs?: number;
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

function resolvePeerEndpoint(target: ProxyTarget): ResolvedPeerTarget | null {
  if (target.resolve !== undefined) return target.resolve();
  return target.url !== "" ? { kind: "tcp", origin: target.url } : null;
}

function endpointFingerprint(endpoint: ResolvedPeerTarget | null): string {
  if (endpoint === null) return "none";
  return endpoint.kind === "unix" ? `unix:${endpoint.socketPath}` : `tcp:${endpoint.origin}`;
}

function isAbortTimeoutError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return true;
    if (/aborted|timed?\s*out/i.test(err.message)) return true;
  }
  return false;
}

function isPeerUnauthorizedBody(status: number, text: string): boolean {
  if (status !== 401) return false;
  try {
    const parsed = JSON.parse(text) as { code?: unknown; error?: unknown };
    return parsed.code === PEER_UNAUTHORIZED || parsed.error === PEER_UNAUTHORIZED;
  } catch {
    return false;
  }
}

export function createRouterTargetRegistry(options: RouterTargetRegistryOptions): RouterTargetRegistry {
  const { localPort, peers, uploadsDir } = options;
  const fetchImpl = options.fetch ?? fetch;
  const unixPool = options.unixPool ?? createUnixHttpPool();
  const ownsUnixPool = options.unixPool === undefined;
  const now = options.now ?? Date.now;
  const digestTtlMs = options.peerDigestTtlMs ?? ROUTER_PEER_DIGEST_TTL_MS;
  const digestTimeoutMs = options.peerDigestTimeoutMs ?? ROUTER_PEER_DIGEST_TIMEOUT_MS;
  const offlineBackoffMs = options.peerOfflineBackoffMs ?? ROUTER_PEER_OFFLINE_BACKOFF_MS;
  const dispatchTimeoutMs = options.peerDispatchTimeoutMs ?? ROUTER_PEER_DISPATCH_TIMEOUT_MS;

  const closing = new AbortController();
  // 严守缓存军规：带硬上限 MAX_PEERS，按时间窗校验正/负缓存，设备移除或连法变更立即失效
  const digestCache = new LRUCache<DeviceId, CachedPeerDigestEntry>({ max: MAX_PEERS });

  const pruneUnpairedFromCache = (devices: readonly DeviceInfo[]) => {
    const activeIds = new Set(devices.filter((d) => !d.self).map((d) => d.id));
    for (const cachedId of digestCache.keys()) {
      if (!activeIds.has(cachedId)) digestCache.delete(cachedId);
    }
  };

  const callPeer = async (
    peerId: DeviceId,
    target: ProxyTarget,
    endpoint: ResolvedPeerTarget,
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: RequestInit["body"]; timeoutMs: number },
  ): Promise<{ status: number; text: string }> => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${target.token}`,
      [PEER_DEVICE_HEADER]: peers?.selfId ?? localPort.deviceId,
      ...init.headers,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs);
    const signal = AbortSignal.any([controller.signal, closing.signal]);
    try {
      const reqInit: RequestInit = {
        method: init.method,
        headers,
        redirect: "manual",
        signal,
        ...(init.body !== undefined ? { body: init.body } : {}),
      };
      const res =
        endpoint.kind === "unix"
          ? await (target.unixPool ?? unixPool).fetch(endpoint.socketPath, path, reqInit)
          : await fetchImpl(endpoint.origin + path, reqInit);
      const text = await res.text();
      return { status: res.status, text };
    } catch (err) {
      target.onOffline?.();
      if (controller.signal.aborted || isAbortTimeoutError(err)) {
        throw new RouterTargetError(
          "device_timeout",
          `连接设备「${target.name}」超时，请检查网络或隧道状态后重试`,
        );
      }
      throw new RouterTargetError(
        "device_offline",
        `设备「${target.name}」当前离线，请确认设备在线后再试`,
      );
    } finally {
      clearTimeout(timer);
    }
  };

  const makePeerPort = (info: DeviceInfo): RouterTargetPort => ({
    deviceId: info.id,
    deviceName: info.name,
    isLocal: false,

    async getDigest(): Promise<DigestFetchResult> {
      const target = peers?.target(info.id) ?? null;
      const endpoint = target ? resolvePeerEndpoint(target) : null;
      const epKey = endpointFingerprint(endpoint);
      const t = now();
      const cached = digestCache.get(info.id);
      if (cached !== undefined && cached.endpointKey === epKey && t < cached.expiresAt) {
        if (cached.kind === "ok" && cached.digest !== null) {
          return { online: true, digest: cached.digest };
        }
        return { online: false, digest: null, error: cached.error };
      }

      if (target === null || endpoint === null) {
        target?.onOffline?.();
        const errText = `设备「${info.name}」当前离线`;
        digestCache.set(info.id, {
          endpointKey: epKey,
          kind: "offline",
          digest: null,
          error: errText,
          expiresAt: t + offlineBackoffMs,
        });
        return { online: false, digest: null, error: errText };
      }

      try {
        const { status, text } = await callPeer(info.id, target, endpoint, API_PATHS.routerDigest, {
          method: "GET",
          timeoutMs: digestTimeoutMs,
        });
        if (isPeerUnauthorizedBody(status, text)) {
          digestCache.delete(info.id);
          peers?.forget(info.id);
          return { online: false, digest: null, error: `设备「${info.name}」已解除与本机的配对` };
        }
        if (status < 200 || status >= 300) {
          const errText = `设备「${info.name}」返回异常（HTTP ${status}）`;
          digestCache.set(info.id, {
            endpointKey: epKey,
            kind: "offline",
            digest: null,
            error: errText,
            expiresAt: now() + offlineBackoffMs,
          });
          return { online: false, digest: null, error: errText };
        }
        const digest = JSON.parse(text) as DeviceRouterDigest;
        digestCache.set(info.id, {
          endpointKey: epKey,
          kind: "ok",
          digest,
          expiresAt: now() + digestTtlMs,
        });
        return { online: true, digest };
      } catch (err) {
        const errText = err instanceof Error ? err.message : `设备「${info.name}」当前离线`;
        digestCache.set(info.id, {
          endpointKey: epKey,
          kind: "offline",
          digest: null,
          error: errText,
          expiresAt: now() + offlineBackoffMs,
        });
        return { online: false, digest: null, error: errText };
      }
    },

    async executeOp(op: RouterTargetOp): Promise<RouterTargetOpResult> {
      const target = peers?.target(info.id) ?? null;
      const endpoint = target ? resolvePeerEndpoint(target) : null;
      if (target === null || endpoint === null) {
        target?.onOffline?.();
        throw new RouterTargetError(
          "device_offline",
          `设备「${info.name}」当前离线，请确认设备在线后再试`,
        );
      }

      // 如带本机已上传附件，先原样把字节上传到远端 /api/uploads 换取远端 attachmentIds
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
          const upRes = await callPeer(info.id, target, endpoint, uploadPath, {
            method: "POST",
            headers: { "content-type": att.mime || "application/octet-stream" },
            body: bytes,
            timeoutMs: dispatchTimeoutMs,
          });
          if (isPeerUnauthorizedBody(upRes.status, upRes.text)) {
            digestCache.delete(info.id);
            peers?.forget(info.id);
            throw new RouterTargetError("device_not_found", `设备「${info.name}」已解除与本机的配对`);
          }
          if (upRes.status < 200 || upRes.status >= 300) {
            let reason = `上传附件「${att.name}」到设备「${info.name}」失败`;
            try {
              const parsedErr = JSON.parse(upRes.text) as { error?: string };
              if (parsedErr.error) reason = parsedErr.error;
            } catch {
              // ignore
            }
            throw new RouterTargetError("invalid", reason);
          }
          const parsedUp = JSON.parse(upRes.text) as { attachment?: { id?: string } };
          if (!parsedUp.attachment?.id) {
            throw new RouterTargetError("invalid", `设备「${info.name}」未返回有效附件编号`);
          }
          remoteIds.push(parsedUp.attachment.id);
        }
        // 远端不共享本机 router_commands 自增主键，跨机派发剥离本机 sourceCommandId
        if (op.kind === "pm.forward") {
          const { sourceCommandId: _omit, ...rest } = op;
          forwardedOp = { ...rest, attachmentIds: remoteIds };
        } else if (op.kind === "worker.start") {
          const { sourceCommandId: _omit, ...rest } = op;
          forwardedOp = { ...rest, attachmentIds: remoteIds };
        } else {
          forwardedOp = { ...op, attachmentIds: remoteIds };
        }
      } else if (op.kind === "pm.forward" && op.sourceCommandId !== undefined) {
        const { sourceCommandId: _omit, ...rest } = op;
        forwardedOp = rest;
      } else if (op.kind === "worker.start" && op.sourceCommandId !== undefined) {
        const { sourceCommandId: _omit, ...rest } = op;
        forwardedOp = rest;
      }

      const res = await callPeer(info.id, target, endpoint, API_PATHS.routerTargetOps, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(forwardedOp),
        timeoutMs: dispatchTimeoutMs,
      });

      if (isPeerUnauthorizedBody(res.status, res.text)) {
        digestCache.delete(info.id);
        peers?.forget(info.id);
        throw new RouterTargetError("device_not_found", `设备「${info.name}」已解除与本机的配对`);
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
          // ignore non-json
        }
        throw new RouterTargetError(code, message);
      }

      // 投递写操作成功后主动使该设备 Digest 缓存失效，保证紧接着下一次查询拿到最新状态
      if (op.kind !== "worker.list") {
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
          url: null,
          transport: { kind: "local" },
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
      if (ownsUnixPool) unixPool.closeAll();
    },
  };
}
