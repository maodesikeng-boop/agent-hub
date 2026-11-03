// 网页调用界面服务的接口。路径和数据形状都来自 src/shared/api.ts。
import {
  API_PATHS,
  type ApiErrorBody,
  type ConversationId,
  type CreatePmRequest,
  type CreatePmResponse,
  type CreateProjectRequest,
  type CreateProjectResponse,
  type EditPersonaRequest,
  type EditPersonaResponse,
  type MessageId,
  type MessagesPage,
  type PostMessageRequest,
  type PersonaChangeId,
  type PersonaResponse,
  type PmId,
  type PostMessageResponse,
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

export function postStop(conversationId: ConversationId): Promise<void> {
  return postJson<void>(API_PATHS.stop(conversationId));
}

export function postCreatePm(body: CreatePmRequest): Promise<CreatePmResponse> {
  return postJson<CreatePmResponse>(API_PATHS.pms, body);
}

export function postCreateProject(body: CreateProjectRequest): Promise<CreateProjectResponse> {
  return postJson<CreateProjectResponse>(API_PATHS.projects, body);
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

export function postRetryMessage(messageId: MessageId): Promise<RetryMessageResponse> {
  return postJson<RetryMessageResponse>(API_PATHS.retryMessage(messageId));
}

/** 变化推送的地址：和页面同源，since 是已经收到的最后一个 seq。 */
export function changeStreamUrl(since: number): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}${API_PATHS.ws}?since=${since}`;
}
