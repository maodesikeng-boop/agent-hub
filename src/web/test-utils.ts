// 网页测试的假后端：假 fetch（/api/*）和假 WebSocket（/api/ws），不连真服务。
import { vi } from "vitest";
import { serverInfoFor } from "../shared/index.ts";
import type {
  AddScheduleRequest,
  Attachment,
  ScheduleRecord,
  Change,
  Conversation,
  ConversationSnapshot,
  CreatePmRequest,
  PickFolderRequest,
  EditPersonaRequest,
  HealthEntry,
  Message,
  MessagesPage,
  PersonaChange,
  PersonaView,
  Pm,
  PostMessageRequest,
  Project,
  ProjectFolder,
  SessionState,
  StateSnapshot,
  SystemMessageMeta,
  WorkerMessageMeta,
  WsServerMessage,
} from "../shared/index.ts";

// ---- 数据构造 ----

export function makePm(over: Partial<Pm> = {}): Pm {
  return {
    id: 1,
    name: "项目经理",
    avatarFile: null,
    mode: "manage_only",
    vendor: "claude",
    defaultModel: null,
    effort: null,
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
    workerId: null,
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

/** 一个上传好的文件（服务端上传接口的响应）。 */
export function makeAttachment(over: Partial<Attachment> = {}): Attachment {
  const name = over.name ?? "报告.pdf";
  const id = over.id ?? "0123456789abcdef";
  return { id, name, path: `/Users/u/.agent-hub/uploads/${id}/${name}`, size: 2048, mime: "application/octet-stream", ...over };
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

export function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 1,
    name: "foo",
    description: null,
    status: "active",
    pmId: 1,
    conversationId: 2,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

export function makeFolder(over: Partial<ProjectFolder> = {}): ProjectFolder {
  return { id: 1, projectId: 1, path: "/work/foo", isMain: true, addedAt: 1_000, removedAt: null, ...over };
}

export function makeSystemMessage(over: Partial<Message> & Pick<Message, "id"> & { event?: SystemMessageMeta }): Message {
  const { event, ...rest } = over;
  return makeMessage({
    sender: "system",
    sessionId: null,
    meta: event ?? { event: "project.created", projectId: 1 },
    dedupeKey: `system:${rest.conversationId ?? 1}:test:${rest.id}`,
    ...rest,
  });
}

/** 项目经理对话里那一行 Worker 汇报（M3）。 */
export function makeWorkerLine(
  over: Partial<Message> & Pick<Message, "id"> & { line?: Partial<WorkerMessageMeta> },
): Message {
  const { line, ...rest } = over;
  const meta: WorkerMessageMeta = {
    workerId: 3,
    workerConversationId: 30,
    title: "修 X",
    readonly: false,
    event: "started",
    status: null,
    summary: null,
    ...line,
  };
  return makeMessage({
    sender: "system",
    sessionId: null,
    kind: "worker",
    workerId: meta.workerId,
    text: `【Worker #${meta.workerId} · ${meta.title} 的汇报】`,
    meta,
    dedupeKey: `worker:${meta.workerId}:${meta.event}:${rest.id}`,
    ...rest,
  });
}

/** Worker 自己的对话（M3）：左栏不显示，点项目经理对话里那一行打开。 */
export function makeWorkerConversation(over: Partial<Conversation> = {}): Conversation {
  return { id: 30, kind: "worker", pmId: 1, projectId: 1, title: "修 X", createdAt: 1_000, ...over };
}

export function makePersonaChange(over: Partial<PersonaChange> = {}): PersonaChange {
  return {
    id: 1,
    pmId: 1,
    actor: "user",
    sessionId: null,
    textBefore: "旧设定",
    textAfter: "新设定",
    modeBefore: "manage_only",
    modeAfter: "manage_only",
    vendorBefore: "claude",
    vendorAfter: "claude",
    modelBefore: null,
    modelAfter: null,
    effortBefore: null,
    effortAfter: null,
    reason: null,
    revertOf: null,
    createdAt: 20_000,
    ...over,
  };
}

export function makePersonaView(over: Partial<PersonaView> = {}): PersonaView {
  return {
    pmId: 1,
    text: "# 性格设定\n\n说大白话",
    mode: "manage_only",
    vendor: "claude",
    model: null,
    effort: null,
    changes: [],
    revertableChangeId: null,
    ...over,
  };
}

export function makeSchedule(over: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: 1,
    pmId: 1,
    name: "晨报",
    kind: "daily",
    atTime: "09:00",
    everyMinutes: null,
    prompt: "整理昨天的进展",
    enabled: true,
    nextRunAt: new Date(2030, 0, 2, 9, 0).getTime(),
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    lastMessageId: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

export function makeSession(over: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: 1,
    conversationId: 1,
    pmId: null,
    generation: 1,
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
    projects: [],
    folders: [],
    conversations: [makeConvSnapshot([])],
    sessions: [],
    health: [],
    schedules: [],
    server: serverInfoFor("darwin"),
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

/** 上传接口收到的一个文件（请求体是文件原样的字节，文件名在 ?name=）。 */
export interface RecordedUpload {
  name: string | null;
  file: Blob;
  contentType: string | null;
}

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
  createPm: (body: CreatePmRequest) => Reply | Promise<Reply> = () => ({
    status: 201,
    body: { pmId: 50, conversationId: 50 },
  });
  getPersona: (pmId: number) => Reply | Promise<Reply> = (pmId) => ({ status: 200, body: makePersonaView({ pmId }) });
  putPersona: (pmId: number, body: EditPersonaRequest) => Reply | Promise<Reply> = (pmId) => ({
    status: 200,
    body: { changed: true, persona: makePersonaView({ pmId }) },
  });
  revertPersona: (changeId: number) => Reply | Promise<Reply> = () => ({
    status: 200,
    body: { changed: true, persona: makePersonaView() },
  });
  addSchedule: (pmId: number, body: AddScheduleRequest) => Reply | Promise<Reply> = (pmId, body) => ({
    status: 201,
    body: makeSchedule({ id: 50, pmId, name: body.name, prompt: body.prompt }),
  });
  setScheduleEnabled: (id: number, enabled: boolean) => Reply | Promise<Reply> = (id, enabled) => ({ status: 200, body: makeSchedule({ id, enabled }) });
  removeSchedule: (id: number) => Reply | Promise<Reply> = () => ({ status: 204 });
  uploads: RecordedUpload[] = [];
  /** 默认：200，编号按收到的顺序 0000000000000001、0000000000000002…，名字原样，类型按扩展名（图片 image/*）。 */
  upload: (name: string | null, file: Blob) => Reply | Promise<Reply> = (name, file) => {
    const id = String(this.uploads.length).padStart(16, "0");
    const fileName = name ?? "文件";
    return { status: 200, body: makeAttachment({ id, name: fileName, size: file.size, mime: /\.(png|jpe?g|gif|webp)$/i.test(fileName) ? "image/png" : "application/octet-stream" }) };
  };
  retryMessage: (messageId: number) => Reply | Promise<Reply> = (messageId) => ({ status: 202, body: { messageId } });
  renewSession: (pmId: number) => Reply | Promise<Reply> = () => ({ status: 202, body: { messageId: 99 } });
  /** GET /api/models。默认 404：网页用打包的名单。 */
  models: () => Reply | Promise<Reply> = () => ({ status: 404, body: { error: "not found" } });
  /** POST /api/pick-folder。默认：用户选了 /Users/me/picked。 */
  pickFolder: (body: PickFolderRequest) => Reply | Promise<Reply> = () => ({ status: 200, body: { path: "/Users/me/picked" } });
  fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://127.0.0.1:1");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (method === "POST" && url.pathname === "/api/uploads") {
      this.calls.push({ method, path: url.pathname, query: url.searchParams, body: init?.body });
      this.uploads.push({ name: url.searchParams.get("name"), file: init?.body as Blob, contentType: new Headers(init?.headers).get("content-type") });
      return jsonResponse(await this.upload(url.searchParams.get("name"), init?.body as Blob));
    }
    // 跟真的界面服务（Fastify）一样：声明了 JSON 却没有请求体，回 400
    const contentType = new Headers(init?.headers).get("content-type");
    if (contentType?.startsWith("application/json") && (init?.body === undefined || init.body === "")) {
      this.calls.push({ method, path: url.pathname, query: url.searchParams, body });
      return jsonResponse({ status: 400, body: { error: "Body cannot be empty when content-type is set to 'application/json'" } });
    }
    this.calls.push({ method, path: url.pathname, query: url.searchParams, body });
    if (method === "GET" && url.pathname === "/api/state") return jsonResponse(await this.state());
    if (method === "GET" && url.pathname === "/api/models") return jsonResponse(await this.models());
    const m = /^\/api\/conversations\/(\d+)\/(messages|stop)$/.exec(url.pathname);
    if (m) {
      const id = Number(m[1]);
      if (m[2] === "messages" && method === "POST") return jsonResponse(await this.postMessage(id, body));
      if (m[2] === "messages" && method === "GET") {
        return jsonResponse(await this.older(id, Number(url.searchParams.get("before"))));
      }
      if (m[2] === "stop" && method === "POST") return jsonResponse(await this.stop(id));
    }
    if (method === "POST" && url.pathname === "/api/pick-folder") return jsonResponse(await this.pickFolder(body));
    if (method === "POST" && url.pathname === "/api/pms") return jsonResponse(await this.createPm(body));
    const persona = /^\/api\/pms\/(\d+)\/persona$/.exec(url.pathname);
    if (persona && method === "GET") return jsonResponse(await this.getPersona(Number(persona[1])));
    if (persona && method === "PUT") return jsonResponse(await this.putPersona(Number(persona[1]), body));
    const revert = /^\/api\/persona-changes\/(\d+)\/revert$/.exec(url.pathname);
    if (revert && method === "POST") return jsonResponse(await this.revertPersona(Number(revert[1])));
    const addSched = /^\/api\/pms\/(\d+)\/schedules$/.exec(url.pathname);
    if (addSched && method === "POST") return jsonResponse(await this.addSchedule(Number(addSched[1]), body));
    const sched = /^\/api\/schedules\/(\d+)$/.exec(url.pathname);
    if (sched && method === "PUT") return jsonResponse(await this.setScheduleEnabled(Number(sched[1]), body.enabled));
    if (sched && method === "DELETE") return jsonResponse(await this.removeSchedule(Number(sched[1])));
    const renew = /^\/api\/pms\/(\d+)\/renew-session$/.exec(url.pathname);
    if (renew && method === "POST") return jsonResponse(await this.renewSession(Number(renew[1])));
    const retry = /^\/api\/messages\/(\d+)\/retry$/.exec(url.pathname);
    if (retry && method === "POST") return jsonResponse(await this.retryMessage(Number(retry[1])));
    // 文件接口的 HEAD（卡片探测文件是否已被清理）：假后端里文件都在
    if (method === "HEAD" && /^\/api\/(uploads|sent-files)\//.test(url.pathname)) return new Response(null, { status: 200 });
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

export function changeOf<T extends Change["type"]>(seq: number, type: T, data: Extract<Change, { type: T }>["data"]): Change {
  return { seq, type, data } as Change;
}

// ---- 假浏览器通知（M4） ----

/** 假的 Notification：permission 和 requestPermission 可以改，弹出来的都记在 instances 里。 */
export class FakeNotification {
  static instances: FakeNotification[] = [];
  static permission: NotificationPermission = "granted";
  /** 用户在浏览器弹窗里点了什么；requestPermission 之后 permission 变成它。 */
  static answer: NotificationPermission = "granted";
  static requestPermission = vi.fn(async (): Promise<NotificationPermission> => {
    FakeNotification.permission = FakeNotification.answer;
    return FakeNotification.permission;
  });
  static get last(): FakeNotification {
    const n = FakeNotification.instances.at(-1);
    if (!n) throw new Error("还没弹过通知");
    return n;
  }

  readonly title: string;
  readonly options: NotificationOptions;
  onclick: (() => void) | null = null;
  closed = false;

  constructor(title: string, options: NotificationOptions = {}) {
    this.title = title;
    this.options = options;
    FakeNotification.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

/** 换上假的 Notification；permission 是授权状态，null 表示这个浏览器根本没有通知接口。 */
export function installFakeNotification(permission: NotificationPermission | null = "granted"): void {
  FakeNotification.instances = [];
  FakeNotification.requestPermission.mockClear();
  FakeNotification.answer = "granted";
  if (permission === null) {
    vi.stubGlobal("Notification", undefined);
    return;
  }
  FakeNotification.permission = permission;
  vi.stubGlobal("Notification", FakeNotification);
}

/** 网页在不在前台：标签页可见并且窗口有焦点。 */
export function setForeground(foreground: boolean): void {
  vi.spyOn(document, "hasFocus").mockReturnValue(foreground);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (foreground ? "visible" : "hidden") });
  window.dispatchEvent(new Event(foreground ? "focus" : "blur"));
  document.dispatchEvent(new Event("visibilitychange"));
}
