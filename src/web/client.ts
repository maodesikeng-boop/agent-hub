// 网页调用界面服务的接口。路径和数据形状都来自 src/shared/api.ts。
import {
  API_PATHS,
  type ApiErrorBody,
  type ConversationId,
  type MessageId,
  type MessagesPage,
  type PostMessageRequest,
  type PostMessageResponse,
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", ...init });
  } catch (err) {
    throw new ApiError(0, err instanceof Error ? err.message : "网络错误");
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = ((await res.json()) as ApiErrorBody).error ?? message;
    } catch {
      // 响应体不是 JSON，用状态文字
    }
    throw new ApiError(res.status, message);
  }
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

/** 变化推送的地址：和页面同源，since 是已经收到的最后一个 seq。 */
export function changeStreamUrl(since: number): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}${API_PATHS.ws}?since=${since}`;
}
