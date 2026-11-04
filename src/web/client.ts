// 网页调用界面服务的接口。路径和数据形状都来自 src/shared/api.ts。
import {
  API_PATHS,
  UPLOAD_TOO_LARGE_MESSAGE,
  type ApiErrorBody,
  type Attachment,
  type ConversationId,
  type CreatePmRequest,
  type CreatePmResponse,
  type EditPersonaRequest,
  type EditPersonaResponse,
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

export function fetchState(): Promise<StateSnapshot> {
  return request<StateSnapshot>(API_PATHS.state);
}

export function fetchOlderMessages(conversationId: ConversationId, before: MessageId): Promise<MessagesPage> {
  return request<MessagesPage>(`${API_PATHS.messages(conversationId)}?before=${before}`);
}

export function postMessage(conversationId: ConversationId, body: PostMessageRequest): Promise<PostMessageResponse> {
  return postJson<PostMessageResponse>(API_PATHS.messages(conversationId), body);
}

/**
 * 上传一个文件：请求体是文件原样的字节（不是 JSON，也不说发给谁），文件名放在 ?name=。服务端清理文件名、给每个文件单独一个目录。
 * 一律声明 application/octet-stream（File 自带的类型是 application/json 之类时，服务端不会当 JSON 去解析，但这里也不依赖它）。
 * 413：界面服务对普通请求说“最多 1 MB”，上传接口的上限是 20 MB，换成上传自己的说法。
 */
export async function postUpload(file: Blob, name: string): Promise<Attachment> {
  try {
    return await request<Attachment>(`${API_PATHS.uploads}?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: file,
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 413) throw new ApiError(413, UPLOAD_TOO_LARGE_MESSAGE);
    throw err;
  }
}

export function postStop(conversationId: ConversationId): Promise<void> {
  return postJson<void>(API_PATHS.stop(conversationId));
}

export function postCreatePm(body: CreatePmRequest): Promise<CreatePmResponse> {
  return postJson<CreatePmResponse>(API_PATHS.pms, body);
}

/** 让守护进程弹出原生的“选择文件夹”。等用户选完才回；取消（或超时）是 path null。 */
export function postPickFolder(body: PickFolderRequest): Promise<PickFolderResponse> {
  return postJson<PickFolderResponse>(API_PATHS.pickFolder, body);
}

export function fetchPersona(pmId: PmId): Promise<PersonaResponse> {
  return request<PersonaResponse>(API_PATHS.persona(pmId));
}

export function putPersona(pmId: PmId, body: EditPersonaRequest): Promise<EditPersonaResponse> {
  return putJson<EditPersonaResponse>(API_PATHS.persona(pmId), body);
}

export function postRevertPersonaChange(changeId: PersonaChangeId): Promise<EditPersonaResponse> {
  return postJson<EditPersonaResponse>(API_PATHS.revertPersonaChange(changeId));
}

/** 每家厂商的模型名单（服务端问不到厂商时是打包的）。 */
export function fetchModels(): Promise<ModelsResponse> {
  return request<ModelsResponse>(API_PATHS.models);
}

export function postRenewSession(pmId: PmId): Promise<RenewSessionResponse> {
  return postJson<RenewSessionResponse>(API_PATHS.renewSession(pmId));
}

export function postRetryMessage(messageId: MessageId): Promise<RetryMessageResponse> {
  return postJson<RetryMessageResponse>(API_PATHS.retryMessage(messageId));
}

/** 变化推送的地址：和页面同源，since 是已经收到的最后一个 seq。 */
export function changeStreamUrl(since: number): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}${API_PATHS.ws}?since=${since}`;
}
