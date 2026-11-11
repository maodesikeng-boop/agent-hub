// 网页调用界面服务的接口。路径和数据形状都来自 src/shared/api.ts。
import {
  API_PATHS,
  API_REQUEST_TIMEOUT_MS,
  SLOW_API_REQUEST_TIMEOUT_MS,
  UPLOAD_TOO_LARGE_MESSAGE,
  devicePath,
  type AddDeviceRequest,
  type ArchiveAllReportsResponse,
  type ArchivePmResponse,
  type Attachment,
  type BrowserSessionsResponse,
  type DecideTaskNodeRequest,
  type DecideTaskNodeResponse,
  type DeviceRouterDigest,
  type LoginLinkResponse,
  type ConversationId,
  type CreatePmRequest,
  type CreatePmResponse,
  type DeviceId,
  type DeviceInfo,
  type DeviceInviteResponse,
  type DevicesResponse,
  type RenameDeviceRequest,
  type AddScheduleRequest,
  type EditPersonaRequest,
  type ScheduleId,
  type ScheduleRecord,
  type SetScheduleEnabledRequest,
  type EditPersonaResponse,
  type FileAction,
  type FileActionResponse,
  type MessageId,
  type MessagesPage,
  type ModelsResponse,
  type REFRESH_UNUSABLE,
  type PickFolderRequest,
  type PickFolderResponse,
  type PostMessageRequest,
  type PostRouterCommandRequest,
  type PostRouterCommandResponse,
  type PersonaChangeId,
  type PersonaResponse,
  type PmId,
  type PostMessageResponse,
  type PublicEntryStatus,
  type QuotaResponse,
  type RenewSessionResponse,
  type ResolveRouterItemRequest,
  type ResolveRouterItemResponse,
  type RetryMessageResponse,
  type RewindMessageResponse,
  type RouterCommandId,
  type RouterItemId,
  type RouterItemsPage,
  type SetPublicEntryRequest,
  type StateSnapshot,
  type TaskGraphId,
  type TaskNodeKey,
  type TunnelConnectRequest,
  type TunnelStatusResponse,
  type UpdateRouterSettingsRequest,
  type UpdateRouterSettingsResponse,
  type VendorSyncApplyRequest,
  type VendorSyncApplyResponse,
  type VendorSyncPreviewResponse,
} from "../shared/index.ts";
import { GENERIC_ERROR_TEXT, LOCAL_ERRORS, humanize, type ErrorCode, type HumanError } from "../shared/errors.ts";
import { checkConnections } from "./connection.ts";

/** 服务端回了非 2xx，或根本没连上。text/hint/raw 都来自 humanize（docs/user-facing-errors-design.md），message 就是 text；组件用 format.ts 的 errorText 拿来显示。 */
export class ApiError extends Error {
  /** HTTP 状态码；0 表示根本没连上（服务没开、网断了）。 */
  readonly status: number;
  /** 错误码表里的码；认不出是 null。 */
  readonly code: ErrorCode | null;
  readonly hint: string | undefined;
  /** 原文（服务端给的 error、非 JSON 的应答文本、或浏览器自己的错误），只放 title。 */
  readonly raw: string;
  constructor(status: number, human: HumanError) {
    super(human.text);
    this.name = "ApiError";
    this.status = status;
    this.code = human.code;
    this.hint = human.hint;
    this.raw = human.raw;
  }
}

/** 请求体超过界面服务的上限（1 MB）时 Fastify 回 413，响应里没有 code，原因是英文；统一换成中文。 */
const TOO_LARGE_MESSAGE = "内容太大，发不出去（最多 1 MB）";

/** 任何接口回 401 都说明网页没登录（或登录过期）：通知这里登记的人（入口本机的 hub）切到登录界面。设备没配对（peer_unauthorized）是另一回事，照常显示。 */
const unauthorizedListeners = new Set<() => void>();
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

/** fetch 本身抛错（Failed to fetch、断网）：一律当 network。 */
function networkError(err: unknown): ApiError {
  const raw = err instanceof Error ? err.message : "";
  return new ApiError(0, { code: "network", ...LOCAL_ERRORS.network, raw });
}

/**
 * 请求或读响应体时出错：超时（AbortSignal.timeout 的 TimeoutError）报 timeout，别的当 network。
 * 超时多半是连接静默断了（手机 VPN、NAT 丢了连接，请求挂在死连接上）：顺便让实时连接查一次，该重连就重连。
 */
function transportError(err: unknown): ApiError {
  if (!(err instanceof DOMException && err.name === "TimeoutError")) return networkError(err);
  checkConnections();
  return new ApiError(0, { code: "timeout", ...LOCAL_ERRORS.timeout, raw: err.message });
}

/** 非 2xx 响应 → ApiError：应答体是 JSON 就按 JSON，不是就把文本当 body，都交给 humanize。 */
async function failure(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => "");
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // 响应体不是 JSON：humanize 收文本
  }
  let human = humanize(body, res.status);
  if (res.status === 413 && human.code === null && human.text.startsWith(GENERIC_ERROR_TEXT)) human = { ...human, code: "too_large", text: TOO_LARGE_MESSAGE };
  const err = new ApiError(res.status, human);
  if (res.status === 401 && err.code !== "peer_unauthorized") for (const listener of unauthorizedListeners) listener();
  return err;
}

/** timeoutMs：从发出到读完响应体最多等多久（limits.ts）；null 不限时，只给上传、等用户操作的请求用。 */
async function request<T>(path: string, init?: RequestInit, timeoutMs: number | null = API_REQUEST_TIMEOUT_MS): Promise<T> {
  const timeout = timeoutMs === null ? {} : { signal: AbortSignal.timeout(timeoutMs) };
  let res: Response;
  let text: string;
  try {
    res = await fetch(path, { credentials: "same-origin", ...init, ...timeout });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await failure(res);
  try {
    text = await res.text();
  } catch (err) {
    throw transportError(err);
  }
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

function postJson<T>(path: string, body?: unknown, timeoutMs: number | null = API_REQUEST_TIMEOUT_MS): Promise<T> {
  // 没有请求体就不声明 JSON：界面服务（Fastify）对“声明了 JSON 却是空的”回 400
  if (body === undefined) return request<T>(path, { method: "POST" }, timeoutMs);
  return request<T>(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
}

function putJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * 一台设备的接口（docs/multi-device-design.md 第 4.1 节）：device 是 null（入口本机）就是原路径，别的设备都加 /d/<设备编号>，
 * 入口原样转发。网页里取数据、发消息都经过这里，组件用 device-scope.tsx 的 useClient() 拿当前设备的这一份。
 */
export function createClient(device: DeviceId | null) {
  const at = (path: string) => devicePath(device, path);
  return {
    device,
    /** 这台设备上的地址（文件链接、预览要用）。 */
    url: at,
    /** 快照在手机上可能要传一会儿：用长一点的超时。 */
    fetchState: () => request<StateSnapshot>(at(API_PATHS.state), undefined, SLOW_API_REQUEST_TIMEOUT_MS),
    fetchOlderMessages: (conversationId: ConversationId, before: MessageId) =>
      request<MessagesPage>(`${at(API_PATHS.messages(conversationId))}?before=${before}`),
    postMessage: (conversationId: ConversationId, body: PostMessageRequest) => postJson<PostMessageResponse>(at(API_PATHS.messages(conversationId)), body),
    /**
     * 上传一个文件：请求体是文件原样的字节（不是 JSON，也不说发给谁），文件名放在 ?name=。服务端清理文件名、给每个文件单独一个目录。
     * 一律声明 application/octet-stream（File 自带的类型是 application/json 之类时，服务端不会当 JSON 去解析，但这里也不依赖它）。
     * 413：界面服务对普通请求说“最多 1 MB”，上传接口的上限是 20 MB，换成上传自己的说法。
     */
    postUpload: async (file: Blob, name: string): Promise<Attachment> => {
      try {
        // 不限时：大文件在慢网上传多久都正常
        return await request<Attachment>(
          `${at(API_PATHS.uploads)}?name=${encodeURIComponent(name)}`,
          {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: file,
          },
          null,
        );
      } catch (err) {
        if (err instanceof ApiError && err.status === 413) throw new ApiError(413, { code: "too_large", text: UPLOAD_TOO_LARGE_MESSAGE, raw: err.raw });
        throw err;
      }
    },
    postStop: (conversationId: ConversationId) => postJson<void>(at(API_PATHS.stop(conversationId))),
    postRewind: (conversationId: ConversationId) => postJson<RewindMessageResponse>(at(API_PATHS.rewind(conversationId))),
    postCreatePm: (body: CreatePmRequest) => postJson<CreatePmResponse>(at(API_PATHS.pms), body),
    /** 让守护进程弹出原生的“选择文件夹”。等用户选完才回（不限时，服务端自己最多等 PICK_FOLDER_TIMEOUT_MS）；取消（或超时）是 path null。 */
    postPickFolder: (body: PickFolderRequest) => postJson<PickFolderResponse>(at(API_PATHS.pickFolder), body, null),
    fetchPersona: (pmId: PmId) => request<PersonaResponse>(at(API_PATHS.persona(pmId))),
    putPersona: (pmId: PmId, body: EditPersonaRequest) => putJson<EditPersonaResponse>(at(API_PATHS.persona(pmId)), body),
    postRevertPersonaChange: (changeId: PersonaChangeId) => postJson<EditPersonaResponse>(at(API_PATHS.revertPersonaChange(changeId))),
    postAddSchedule: (pmId: PmId, body: AddScheduleRequest) => postJson<ScheduleRecord>(at(API_PATHS.pmSchedules(pmId)), body),
    putScheduleEnabled: (scheduleId: ScheduleId, enabled: boolean) =>
      putJson<ScheduleRecord>(at(API_PATHS.schedule(scheduleId)), { enabled } satisfies SetScheduleEnabledRequest),
    deleteSchedule: (scheduleId: ScheduleId) => request<void>(at(API_PATHS.schedule(scheduleId)), { method: "DELETE" }),
    /**
     * 每家厂商的模型名单和这台设备上的状态（服务端问不到厂商时是打包的）。每台设备装的 CLI 不一样，名单按设备取。
     * refresh: REFRESH_UNUSABLE 让服务端只重问不能用的那几家。
     */
    fetchModels: (options: { refresh?: typeof REFRESH_UNUSABLE } = {}) =>
      request<ModelsResponse>(at(options.refresh ? `${API_PATHS.models}?refresh=${options.refresh}` : API_PATHS.models), undefined, SLOW_API_REQUEST_TIMEOUT_MS),
    /** 事件流里没有额度的厂商（agy）的额度；服务端缓存，没有那一块时 groups 是空的。服务端可能要现问（最多 FETCHED_QUOTA_TIMEOUT_MS）。 */
    fetchQuota: () => request<QuotaResponse>(at(API_PATHS.quota), undefined, SLOW_API_REQUEST_TIMEOUT_MS),
    fetchVendorSyncPreview: () => request<VendorSyncPreviewResponse>(at(API_PATHS.vendorSyncPreview), undefined, SLOW_API_REQUEST_TIMEOUT_MS),
    postVendorSyncApply: (body: VendorSyncApplyRequest) => postJson<VendorSyncApplyResponse>(at(API_PATHS.vendorSyncApply), body, SLOW_API_REQUEST_TIMEOUT_MS),
    postRenewSession: (pmId: PmId) => postJson<RenewSessionResponse>(at(API_PATHS.renewSession(pmId))),
    postArchivePm: (pmId: PmId) => postJson<ArchivePmResponse>(at(API_PATHS.archivePm(pmId))),
    postUnarchivePm: (pmId: PmId) => postJson<ArchivePmResponse>(at(API_PATHS.unarchivePm(pmId))),
    postRetryMessage: (messageId: MessageId) => postJson<RetryMessageResponse>(at(API_PATHS.retryMessage(messageId))),
    postFileAction: (target: FileActionTarget, action: FileAction) => {
      const path = target.kind === "sent" ? API_PATHS.sentFileAction(target.messageId, target.index, action) : API_PATHS.attachmentAction(target.id, action);
      return postJson<FileActionResponse>(at(path));
    },
    fetchRouterDigest: () => request<DeviceRouterDigest>(at(API_PATHS.routerDigest)),
    fetchRouterItems: (options: { cursor?: string | null; limit?: number } = {}) => {
      // 查询参数用对象键名拼，不写字符串字面量（参数名 cursor 与厂商编号同名，会被 vendor-guard 当成点名厂商）。
      const query: Record<string, string> = {};
      if (options.cursor) query.cursor = options.cursor;
      if (options.limit !== undefined) query.limit = String(options.limit);
      const qs = new URLSearchParams(query).toString();
      return request<RouterItemsPage>(at(qs ? `${API_PATHS.routerItems}?${qs}` : API_PATHS.routerItems));
    },
    postResolveRouterItem: (id: RouterItemId, body: ResolveRouterItemRequest) =>
      postJson<ResolveRouterItemResponse>(at(API_PATHS.routerItemResolve(id)), body),
    postArchiveAllRouterReports: () => postJson<ArchiveAllReportsResponse>(at(API_PATHS.routerReportsArchiveAll), {}),
    putRouterSettings: (body: UpdateRouterSettingsRequest) =>
      putJson<UpdateRouterSettingsResponse>(at(API_PATHS.routerSettings), body),
    postDecideTaskNode: (graphId: TaskGraphId, nodeKey: TaskNodeKey, body: DecideTaskNodeRequest) =>
      postJson<DecideTaskNodeResponse>(at(API_PATHS.taskGraphDecide(graphId, nodeKey)), body),
    postRouterCommand: (body: PostRouterCommandRequest) =>
      postJson<PostRouterCommandResponse>(at(API_PATHS.routerCommands), body, SLOW_API_REQUEST_TIMEOUT_MS),
    postRetryRouterCommand: (id: RouterCommandId) =>
      postJson<PostRouterCommandResponse>(at(API_PATHS.routerCommandRetry(id)), {}, SLOW_API_REQUEST_TIMEOUT_MS),
    /** 变化推送的地址：和页面同源，since 是已经收到的最后一个 seq。 */
    changeStreamUrl: (since: number) => {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      return `${scheme}://${location.host}${at(API_PATHS.ws)}?since=${since}`;
    },
  };
}

export type HubClient = ReturnType<typeof createClient>;

/** 入口本机。设备清单、配对这些入口自己的接口也只走它。 */
export const localClient: HubClient = createClient(null);

export const { fetchState, postMessage, postUpload, fetchVendorSyncPreview, postVendorSyncApply } = localClient;

// ---- 入口自己的：设备清单（不转发） ----

/** GET /api/devices。老的守护进程（还没有联机）回 404：调用方当成只有本机一台。 */
export const fetchDevices = () => request<DevicesResponse>(API_PATHS.devices);
export const postAddDevice = (body: AddDeviceRequest) => postJson<DeviceInfo>(API_PATHS.devices, body);
export const patchDevice = (id: DeviceId, body: RenameDeviceRequest) =>
  request<DeviceInfo>(API_PATHS.device(id), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
export const deleteDevice = (id: DeviceId) => request<void>(API_PATHS.device(id), { method: "DELETE" });
export const postDeviceInvite = () => postJson<DeviceInviteResponse>(API_PATHS.deviceInvites);
export const postTunnelConnect = (code: string) => postJson<TunnelStatusResponse>(API_PATHS.tunnelConnect, { code } satisfies TunnelConnectRequest);
export const postTunnelRetry = () => postJson<TunnelStatusResponse>(API_PATHS.tunnelRetry, {});
export const putPublicEntry = (body: SetPublicEntryRequest): Promise<PublicEntryStatus> => putJson<PublicEntryStatus>(API_PATHS.publicEntry, body);

/** 已登录的浏览器（设置里的列表）。 */
export function fetchBrowserSessions(): Promise<BrowserSessionsResponse> {
  return request<BrowserSessionsResponse>(API_PATHS.browserSessions);
}

/** 已登录设备批准公网待批准（pending_approval）的浏览器会话。 */
export function postApproveBrowserSession(id: string): Promise<void> {
  return postJson<void>(API_PATHS.approveBrowserSession(id));
}

/** 退出一个浏览器（可以是自己）。 */
export function deleteBrowserSession(id: string): Promise<void> {
  return request<void>(API_PATHS.browserSession(id), { method: "DELETE" });
}

/** 全部退出（换主钥匙、清所有会话，包括自己）。 */
export function postLogoutAll(): Promise<void> {
  return postJson<void>(API_PATHS.logoutAll);
}

/** 给手机扫的一次性登录链接（5 分钟、用一次）。 */
export function postLoginLink(): Promise<LoginLinkResponse> {
  return postJson<LoginLinkResponse>(API_PATHS.loginLinks);
}

/** 在 Finder 中显示 / 用默认程序打开的对象：agent 发来的文件（哪条消息的第几个）或聊天框上传的附件。 */
export type FileActionTarget = { kind: "sent"; messageId: MessageId; index: number } | { kind: "upload"; id: string };

/** 预览窗取文件内容：maxBytes 不是 null 时只要前这么多字节（Range；服务端不理 Range 也截到这么多）。文件可能大，不限时。 */
export async function fetchFileBytes(url: string, maxBytes: number | null): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "same-origin", ...(maxBytes === null ? {} : { headers: { range: `bytes=0-${maxBytes - 1}` } }) });
  } catch (err) {
    throw networkError(err);
  }
  if (!res.ok) throw await failure(res);
  const bytes = await res.arrayBuffer();
  return maxBytes === null || bytes.byteLength <= maxBytes ? bytes : bytes.slice(0, maxBytes);
}
