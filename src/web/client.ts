// 网页调用界面服务的接口。路径和数据形状都来自 src/shared/api.ts。
import {
  API_PATHS,
  UPLOAD_TOO_LARGE_MESSAGE,
  devicePath,
  type AddDeviceRequest,
  type ApiErrorBody,
  type Attachment,
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
  type PickFolderRequest,
  type PickFolderResponse,
  type PostMessageRequest,
  type PersonaChangeId,
  type PersonaResponse,
  type PmId,
  type PostMessageResponse,
  type QuotaResponse,
  type RenewSessionResponse,
  type RetryMessageResponse,
  type StateSnapshot,
} from "../shared/index.ts";

/** 服务端回了非 2xx。status 0 表示根本没连上（服务没开、网断了）。 */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** 请求体超过界面服务的上限（1 MB）时 Fastify 回 413，响应里没有 code，原因是英文；统一换成中文。 */
const TOO_LARGE_MESSAGE = "内容太大，发不出去（最多 1 MB）";

/** 非 2xx 响应给用户看的原因：413 固定一句；有 { error } 就原样用；别的（空体、不是 JSON、error 不是字符串）说“请求失败（状态码）”。 */
async function failureMessage(res: Response): Promise<string> {
  if (res.status === 413) return TOO_LARGE_MESSAGE;
  try {
    const body = (await res.json()) as Partial<ApiErrorBody> | null;
    const error = body?.error;
    if (typeof error === "string" && error !== "") return error;
  } catch {
    // 响应体不是 JSON
  }
  return `请求失败（${res.status}）`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", ...init });
  } catch (err) {
    throw new ApiError(0, err instanceof Error ? err.message : "网络错误");
  }
  if (!res.ok) throw new ApiError(res.status, await failureMessage(res));
  const text = await res.text();
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

function postJson<T>(path: string, body?: unknown): Promise<T> {
  // 没有请求体就不声明 JSON：界面服务（Fastify）对“声明了 JSON 却是空的”回 400
  if (body === undefined) return request<T>(path, { method: "POST" });
  return request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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
    fetchState: () => request<StateSnapshot>(at(API_PATHS.state)),
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
        return await request<Attachment>(`${at(API_PATHS.uploads)}?name=${encodeURIComponent(name)}`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: file,
        });
      } catch (err) {
        if (err instanceof ApiError && err.status === 413) throw new ApiError(413, UPLOAD_TOO_LARGE_MESSAGE);
        throw err;
      }
    },
    postStop: (conversationId: ConversationId) => postJson<void>(at(API_PATHS.stop(conversationId))),
    postCreatePm: (body: CreatePmRequest) => postJson<CreatePmResponse>(at(API_PATHS.pms), body),
    /** 让守护进程弹出原生的“选择文件夹”。等用户选完才回；取消（或超时）是 path null。 */
    postPickFolder: (body: PickFolderRequest) => postJson<PickFolderResponse>(at(API_PATHS.pickFolder), body),
    fetchPersona: (pmId: PmId) => request<PersonaResponse>(at(API_PATHS.persona(pmId))),
    putPersona: (pmId: PmId, body: EditPersonaRequest) => putJson<EditPersonaResponse>(at(API_PATHS.persona(pmId)), body),
    postRevertPersonaChange: (changeId: PersonaChangeId) => postJson<EditPersonaResponse>(at(API_PATHS.revertPersonaChange(changeId))),
    postAddSchedule: (pmId: PmId, body: AddScheduleRequest) => postJson<ScheduleRecord>(at(API_PATHS.pmSchedules(pmId)), body),
    putScheduleEnabled: (scheduleId: ScheduleId, enabled: boolean) =>
      putJson<ScheduleRecord>(at(API_PATHS.schedule(scheduleId)), { enabled } satisfies SetScheduleEnabledRequest),
    deleteSchedule: (scheduleId: ScheduleId) => request<void>(at(API_PATHS.schedule(scheduleId)), { method: "DELETE" }),
    /** 每家厂商的模型名单（服务端问不到厂商时是打包的）。每台设备装的 CLI 不一样，名单按设备取。 */
    fetchModels: () => request<ModelsResponse>(at(API_PATHS.models)),
    /** 事件流里没有额度的厂商（agy）的额度；服务端缓存，没有那一块时 groups 是空的。 */
    fetchQuota: () => request<QuotaResponse>(at(API_PATHS.quota)),
    postRenewSession: (pmId: PmId) => postJson<RenewSessionResponse>(at(API_PATHS.renewSession(pmId))),
    postRetryMessage: (messageId: MessageId) => postJson<RetryMessageResponse>(at(API_PATHS.retryMessage(messageId))),
    postFileAction: (target: FileActionTarget, action: FileAction) => {
      const path = target.kind === "sent" ? API_PATHS.sentFileAction(target.messageId, target.index, action) : API_PATHS.attachmentAction(target.id, action);
      return postJson<FileActionResponse>(at(path));
    },
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

export const {
  fetchState,
  fetchOlderMessages,
  postMessage,
  postUpload,
  postStop,
  postCreatePm,
  postPickFolder,
  fetchPersona,
  putPersona,
  postRevertPersonaChange,
  postAddSchedule,
  putScheduleEnabled,
  deleteSchedule,
  fetchModels,
  fetchQuota,
  postRenewSession,
  postRetryMessage,
  postFileAction,
  changeStreamUrl,
} = localClient;

// ---- 入口自己的：设备清单（不转发） ----

/** GET /api/devices。老的守护进程（还没有联机）回 404：调用方当成只有本机一台。 */
export const fetchDevices = () => request<DevicesResponse>(API_PATHS.devices);
export const postAddDevice = (body: AddDeviceRequest) => postJson<DeviceInfo>(API_PATHS.devices, body);
export const patchDevice = (id: DeviceId, body: RenameDeviceRequest) =>
  request<DeviceInfo>(API_PATHS.device(id), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
export const deleteDevice = (id: DeviceId) => request<void>(API_PATHS.device(id), { method: "DELETE" });
export const postDeviceInvite = () => postJson<DeviceInviteResponse>(API_PATHS.deviceInvites);

/** 在 Finder 中显示 / 用默认程序打开的对象：agent 发来的文件（哪条消息的第几个）或聊天框上传的附件。 */
export type FileActionTarget = { kind: "sent"; messageId: MessageId; index: number } | { kind: "upload"; id: string };

/** 预览窗取文件内容：maxBytes 不是 null 时只要前这么多字节（Range；服务端不理 Range 也截到这么多）。 */
export async function fetchFileBytes(url: string, maxBytes: number | null): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "same-origin", ...(maxBytes === null ? {} : { headers: { range: `bytes=0-${maxBytes - 1}` } }) });
  } catch (err) {
    throw new ApiError(0, err instanceof Error ? err.message : "网络错误");
  }
  if (!res.ok) throw new ApiError(res.status, await failureMessage(res));
  const bytes = await res.arrayBuffer();
  return maxBytes === null || bytes.byteLength <= maxBytes ? bytes : bytes.slice(0, maxBytes);
}
