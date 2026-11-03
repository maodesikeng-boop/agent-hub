// 网页测试的假后端：假 fetch（/api/*）和假 WebSocket（/api/ws），不连真服务。
import { vi } from "vitest";
import type {
  Change,
  Conversation,
  ConversationSnapshot,
  HealthEntry,
  Message,
  MessagesPage,
  Pm,
  PostMessageRequest,
  SessionState,
  StateSnapshot,
  WsServerMessage,
} from "../shared/index.ts";

// ---- 数据构造 ----

export function makePm(over: Partial<Pm> = {}): Pm {
  return {
    id: 1,
    name: "项目经理",
    avatarFile: null,
    mode: "manager",
    defaultModel: null,
    personaFile: null,
    createdAt: 1_000,
    ...over,
  };
}

export function makeConversation(over: Partial<Conversation> = {}): Conversation {
  return { id: 1, kind: "pm", pmId: 1, projectId: null, title: "项目经理", createdAt: 1_000, ...over };
}

export function makeMessage(over: Partial<Message> & Pick<Message, "id">): Message {
  const conversationId = over.conversationId ?? 1;
  return {
    conversationId,
    sessionId: 1,
    ticketId: null,
    sender: "agent",
    kind: "text",
    text: `消息 ${over.id}`,
    meta: null,
    collapsed: false,
    dedupeKey: `session:1:u${over.id}`,
    status: null,
    failureReason: null,
    createdAt: 10_000 + over.id * 1_000,
    updatedAt: 10_000 + over.id * 1_000,
    ...over,
  };
}

export function makeUserMessage(over: Partial<Message> & Pick<Message, "id">): Message {
  return makeMessage({
    sender: "user",
    sessionId: null,
    status: "replied",
    dedupeKey: `client:${over.conversationId ?? 1}:c${over.id}`,
    ...over,
  });
}

export function makeToolMessage(over: Partial<Message> & Pick<Message, "id">): Message {
  return makeMessage({
    kind: "tool",
    collapsed: true,
    text: `Bash: 命令 ${over.id}`,
    meta: { toolUseId: `t${over.id}`, name: "Bash", input: {} },
    ...over,
  });
}

export function makeSession(over: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: 1,
    conversationId: 1,
    status: "idle",
    activity: "idle",
    currentTool: null,
    rateLimit: null,
    lastEventAt: null,
    ...over,
  };
}

export function makeHealth(over: Partial<HealthEntry> = {}): HealthEntry {
  return { module: "driver", consecutiveFailures: 1, lastError: null, updatedAt: 1_000, ...over };
}

export function makeConvSnapshot(
  messages: Message[],
  over: { conversation?: Partial<Conversation>; hasMore?: boolean } = {},
): ConversationSnapshot {
  return { conversation: makeConversation(over.conversation), messages, hasMore: over.hasMore ?? false };
}

export function makeSnapshot(over: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    seq: 10,
    pms: [makePm()],
    conversations: [makeConvSnapshot([])],
    sessions: [],
    health: [],
    ...over,
  };
}

// ---- 假 fetch ----

export interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export type Reply = { status: number; body?: unknown };

function jsonResponse(reply: Reply): Response {
  const body = reply.body === undefined ? null : JSON.stringify(reply.body);
  return new Response(body, { status: reply.status, headers: { "content-type": "application/json" } });
}

/** 每个接口一个可替换的回应；calls 记下所有请求，测试拿它对答案。 */
export class FakeApi {
  calls: RecordedCall[] = [];
  state: () => Reply | Promise<Reply>;
  postMessage: (conversationId: number, body: PostMessageRequest) => Reply | Promise<Reply> = () => ({
    status: 200,
    body: { messageId: 999 },
  });
  stop: (conversationId: number) => Reply | Promise<Reply> = () => ({ status: 202 });
  older: (conversationId: number, before: number) => Reply | Promise<Reply> = () => ({
    status: 200,
    body: { messages: [], hasMore: false } satisfies MessagesPage,
  });
  fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://127.0.0.1:1");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    // 跟真的界面服务（Fastify）一样：声明了 JSON 却没有请求体，回 400
    const contentType = new Headers(init?.headers).get("content-type");
    if (contentType?.startsWith("application/json") && (init?.body === undefined || init.body === "")) {
      this.calls.push({ method, path: url.pathname, query: url.searchParams, body });
      return jsonResponse({ status: 400, body: { error: "Body cannot be empty when content-type is set to 'application/json'" } });
    }
    this.calls.push({ method, path: url.pathname, query: url.searchParams, body });
    if (method === "GET" && url.pathname === "/api/state") return jsonResponse(await this.state());
    const m = /^\/api\/conversations\/(\d+)\/(messages|stop)$/.exec(url.pathname);
    if (m) {
      const id = Number(m[1]);
      if (m[2] === "messages" && method === "POST") return jsonResponse(await this.postMessage(id, body));
      if (m[2] === "messages" && method === "GET") {
        return jsonResponse(await this.older(id, Number(url.searchParams.get("before"))));
      }
      if (m[2] === "stop" && method === "POST") return jsonResponse(await this.stop(id));
    }
    return jsonResponse({ status: 404, body: { error: "not found" } });
  });

  constructor(snapshot: StateSnapshot) {
    this.state = () => ({ status: 200, body: snapshot });
  }

  install(): void {
    vi.stubGlobal("fetch", this.fetch);
  }

  callsTo(method: string, pathPattern: RegExp): RecordedCall[] {
    return this.calls.filter((c) => c.method === method && pathPattern.test(c.path));
  }
}

// ---- 假 WebSocket ----

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }
  static get last(): FakeWebSocket {
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error("还没有 WebSocket 连接");
    return ws;
  }

  readonly url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closedByClient = false;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  /** 服务端接受连接。 */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** 服务端推一条。 */
  push(msg: WsServerMessage | Change | string): void {
    this.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }

  /** 连接断了（服务端关闭、网络断）。 */
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  close(): void {
    this.closedByClient = true;
    this.readyState = 3;
  }

  get since(): number | null {
    const v = new URL(this.url).searchParams.get("since");
    return v === null ? null : Number(v);
  }

  send(): void {}
}

export function installFakeWebSocket(): void {
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
}

/** 推变化的小工具：seq 由调用者给。 */
export function messageChange(
  seq: number,
  type: "message.created" | "message.updated",
  message: Message,
): Change {
  return { seq, type, data: { message } };
}

export function sessionChange(seq: number, session: SessionState): Change {
  return { seq, type: "session.status", data: { session } };
}

export function healthChange(seq: number, health: HealthEntry): Change {
  return { seq, type: "health.updated", data: { health } };
}
