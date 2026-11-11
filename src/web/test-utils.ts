// 网页测试的假后端：假 fetch（/api/*）和假 WebSocket（/api/ws），不连真服务。
import { vi } from "vitest";
import { API_PATHS, DEFAULT_AGENT_VENDOR, emptyRouterSlice, isQuietMessage, serverInfoFor } from "../shared/index.ts";
import type {
  AddScheduleRequest,
  Attachment,
  ScheduleRecord,
  Change,
  Conversation,
  ConversationSnapshot,
  CreatePmRequest,
  DecideTaskNodeRequest,
  PickFolderRequest,
  EditPersonaRequest,
  HealthEntry,
  Message,
  MessagesPage,
  PersonaChange,
  PersonaView,
  Pm,
  PostMessageRequest,
  PostRouterCommandRequest,
  Project,
  ProjectFolder,
  ResolveRouterItemRequest,
  RouterItemsPage,
  SessionState,
  SetPublicEntryRequest,
  StateSnapshot,
  SystemMessageMeta,
  UpdateRouterSettingsRequest,
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
    vendor: DEFAULT_AGENT_VENDOR,
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
    vendorBefore: DEFAULT_AGENT_VENDOR,
    vendorAfter: DEFAULT_AGENT_VENDOR,
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
    vendor: DEFAULT_AGENT_VENDOR,
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
    router: emptyRouterSlice(),
    activeTaskGraphs: [],
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
  rewind: (conversationId: number) => Reply | Promise<Reply> = () => ({ status: 200, body: { message: null } });
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
  renewSession: (pmId: number) => Reply | Promise<Reply> = () => ({ status: 202, body: { handoverId: 99 } });
  archivePm: (pmId: number) => Reply | Promise<Reply> = (pmId) => ({
    status: 200,
    body: { pm: makePm({ id: pmId, archivedAt: 1_000 }) },
  });
  unarchivePm: (pmId: number) => Reply | Promise<Reply> = (pmId) => ({
    status: 200,
    body: { pm: makePm({ id: pmId, archivedAt: null }) },
  });
  /** GET /api/auth/status。 */
  authStatus: () => Reply | Promise<Reply> = () => ({ status: 200, body: { status: "active" } });
  /** GET /api/sessions。默认：只有这一个浏览器。 */
  browserSessions: () => Reply | Promise<Reply> = () => ({
    status: 200,
    body: { sessions: [{ id: "s1", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36", createdAt: 0, lastSeenAt: Date.now(), current: true }] },
  });
  /** POST /api/sessions/:id/approve。 */
  approveBrowserSession: (id: string) => Reply | Promise<Reply> = () => ({ status: 204 });
  /** DELETE /api/sessions/:id。 */
  deleteBrowserSession: (id: string) => Reply | Promise<Reply> = () => ({ status: 204 });
  /** POST /api/sessions/logout-all。 */
  logoutAll: () => Reply | Promise<Reply> = () => ({ status: 204 });
  /** POST /api/login-links。 */
  loginLink: () => Reply | Promise<Reply> = () => ({ status: 201, body: { url: "http://127.0.0.1:4317/auth#link=fake-code", expiresAt: Date.now() + 300_000 } });
  /** PUT /api/devices/public-entry。 */
  putPublicEntry: (body: SetPublicEntryRequest) => Reply | Promise<Reply> = (body) => ({
    status: 200,
    body: {
      enabled: body.enabled,
      hostname: body.hostname ?? "tokyo.tailnet.ts.net",
      funnelCommand: "sudo tailscale funnel --bg unix:/home/ubuntu/.agent-hub/run/public.sock",
    },
  });
  /** GET /api/models。默认 404：网页用打包的名单。 */
  models: () => Reply | Promise<Reply> = () => ({ status: 404, body: { error: "not found" } });
  /** GET /api/quota。默认 404：不显示那一块。 */
  quota: () => Reply | Promise<Reply> = () => ({ status: 404, body: { error: "not found" } });
  /** POST /api/pick-folder。默认：用户选了 /Users/me/picked。 */
  pickFolder: (body: PickFolderRequest) => Reply | Promise<Reply> = () => ({ status: 200, body: { path: "/Users/me/picked" } });
  /** GET /api/router/digest。 */
  routerDigest: () => Reply | Promise<Reply> = () => ({ status: 200, body: { generatedAt: Date.now(), pms: [] } });
  /** GET /api/router/items。 */
  routerItems: (query: URLSearchParams) => Reply | Promise<Reply> = () => ({
    status: 200,
    body: { items: [], nextCursor: null, hasMore: false } satisfies RouterItemsPage,
  });
  /** POST /api/router/items/:id/resolve。 */
  resolveRouterItem: (id: number, body: ResolveRouterItemRequest) => Reply | Promise<Reply> = (id) => ({
    status: 200,
    body: {
      item: {
        id,
        kind: "report",
        status: "archived",
        pmId: 1,
        projectId: null,
        conversationId: 1,
        summary: "",
        links: [],
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    },
  });
  /** POST /api/router/reports/archive-all。 */
  archiveAllRouterReports: () => Reply | Promise<Reply> = () => ({
    status: 200,
    body: { archivedIds: [], updatedAt: Date.now() },
  });
  /** PUT /api/router/settings。 */
  putRouterSettings: (body: UpdateRouterSettingsRequest) => Reply | Promise<Reply> = (body) => ({
    status: 200,
    body: { settings: { vendor: body.vendor, model: body.model, effort: body.effort, updatedAt: Date.now() } },
  });
  /** POST /api/task-graphs/:id/nodes/:nodeKey/decide。 */
  decideTaskNode: (graphId: number, nodeKey: string, body: DecideTaskNodeRequest) => Reply | Promise<Reply> = (graphId) => ({
    status: 200,
    body: {
      graph: {
        id: graphId,
        projectId: 1,
        pmId: 1,
        conversationId: 1,
        title: "任务图",
        status: "active",
        nodes: [],
        edges: [],
        createdAt: 1_000,
        updatedAt: 1_000,
      },
      messageId: 777,
    },
  });
  /** POST /api/router/commands。 */
  postRouterCommand: (body: PostRouterCommandRequest) => Reply | Promise<Reply> = (body) => ({
    status: 200,
    body: {
      command: {
        id: 800,
        clientId: body.clientId,
        inputText: body.text,
        vendor: DEFAULT_AGENT_VENDOR,
        model: null,
        effort: null,
        status: "planning",
        plan: null,
        dispatched: null,
        error: null,
        durationMs: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
  });
  /** POST /api/router/commands/:id/retry。 */
  retryRouterCommand: (id: number) => Reply | Promise<Reply> = (id) => ({
    status: 200,
    body: {
      command: {
        id,
        clientId: `retry-${id}`,
        inputText: "重试指令",
        vendor: DEFAULT_AGENT_VENDOR,
        model: null,
        effort: null,
        status: "planning",
        plan: null,
        dispatched: null,
        error: null,
        durationMs: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
  });
  /** 跟真的 fetch 一样：init.signal 断了（超时、取消）就以它的 reason 失败，哪怕回应还没好。 */
  fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal;
    if (!signal) return this.respond(input, init);
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<Response>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      this.respond(input, init).then(resolve, reject);
    });
  });

  private async respond(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
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
    if (method === "GET" && url.pathname === "/api/quota") return jsonResponse(await this.quota());
    const m = /^\/api\/conversations\/(\d+)\/(messages|stop|rewind)$/.exec(url.pathname);
    if (m) {
      const id = Number(m[1]);
      if (m[2] === "messages" && method === "POST") return jsonResponse(await this.postMessage(id, body));
      if (m[2] === "messages" && method === "GET") {
        return jsonResponse(await this.older(id, Number(url.searchParams.get("before"))));
      }
      if (m[2] === "stop" && method === "POST") return jsonResponse(await this.stop(id));
      if (m[2] === "rewind" && method === "POST") return jsonResponse(await this.rewind(id));
    }
    if (method === "GET" && url.pathname === API_PATHS.authStatus) return jsonResponse(await this.authStatus());
    if (method === "GET" && url.pathname === "/api/sessions") return jsonResponse(await this.browserSessions());
    if (method === "POST" && url.pathname === "/api/sessions/logout-all") return jsonResponse(await this.logoutAll());
    if (method === "POST" && url.pathname === "/api/login-links") return jsonResponse(await this.loginLink());
    const approveSession = /^\/api\/sessions\/([^/]+)\/approve$/.exec(url.pathname);
    if (approveSession && method === "POST") return jsonResponse(await this.approveBrowserSession(decodeURIComponent(approveSession[1]!)));
    const browserSession = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
    if (browserSession && method === "DELETE") return jsonResponse(await this.deleteBrowserSession(decodeURIComponent(browserSession[1]!)));
    if (method === "PUT" && url.pathname === API_PATHS.publicEntry) return jsonResponse(await this.putPublicEntry(body));
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
    const archive = /^\/api\/pms\/(\d+)\/archive$/.exec(url.pathname);
    if (archive && method === "POST") return jsonResponse(await this.archivePm(Number(archive[1])));
    const unarchive = /^\/api\/pms\/(\d+)\/unarchive$/.exec(url.pathname);
    if (unarchive && method === "POST") return jsonResponse(await this.unarchivePm(Number(unarchive[1])));
    const retry = /^\/api\/messages\/(\d+)\/retry$/.exec(url.pathname);
    if (retry && method === "POST") return jsonResponse(await this.retryMessage(Number(retry[1])));
    if (method === "GET" && url.pathname === API_PATHS.routerDigest) return jsonResponse(await this.routerDigest());
    if (method === "GET" && url.pathname === API_PATHS.routerItems) return jsonResponse(await this.routerItems(url.searchParams));
    if (method === "POST" && url.pathname === API_PATHS.routerReportsArchiveAll) return jsonResponse(await this.archiveAllRouterReports());
    if (method === "PUT" && url.pathname === API_PATHS.routerSettings) return jsonResponse(await this.putRouterSettings(body));
    if (method === "POST" && url.pathname === API_PATHS.routerCommands) return jsonResponse(await this.postRouterCommand(body));
    const resolveItem = /^\/api\/router\/items\/(\d+)\/resolve$/.exec(url.pathname);
    if (resolveItem && method === "POST") return jsonResponse(await this.resolveRouterItem(Number(resolveItem[1]), body));
    const retryCmd = /^\/api\/router\/commands\/(\d+)\/retry$/.exec(url.pathname);
    if (retryCmd && method === "POST") return jsonResponse(await this.retryRouterCommand(Number(retryCmd[1])));
    const decideNode = /^\/api\/task-graphs\/(\d+)\/nodes\/([^/]+)\/decide$/.exec(url.pathname);
    if (decideNode && method === "POST") {
      return jsonResponse(await this.decideTaskNode(Number(decideNode[1]), decodeURIComponent(decideNode[2]!), body));
    }
    // 文件接口的 HEAD（卡片探测文件是否已被清理）：假后端里文件都在
    if (method === "HEAD" && /^\/api\/(uploads|sent-files)\//.test(url.pathname)) return new Response(null, { status: 200 });
    return jsonResponse({ status: 404, body: { error: "not found" } });
  }

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

/**
 * 请求超时（client.ts 用 AbortSignal.timeout）：jsdom 的 AbortSignal.timeout 不受假时钟控制，换成用全局 setTimeout 的（假时钟下跟着走），
 * fire() 让还在等的当场超时（真时钟的界面测试用，不用真等 15 秒）。delays 记下每个请求要的超时。
 */
export function stubRequestTimeouts(): { delays: number[]; fire(): void } {
  const pending: AbortController[] = [];
  const delays: number[] = [];
  const timeout = (controller: AbortController) => controller.abort(new DOMException("signal timed out", "TimeoutError"));
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    const controller = new AbortController();
    pending.push(controller);
    delays.push(ms);
    setTimeout(() => timeout(controller), ms);
    return controller.signal;
  });
  return { delays, fire: () => pending.splice(0).forEach(timeout) };
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

// ---- 拖放、粘贴的假数据（jsdom 没有 DataTransfer 和 FileSystemEntry） ----

type FakeEntry = Pick<FileSystemEntry, "name" | "isFile" | "isDirectory">;

/** 文件夹里的一个文件。 */
export function fakeFileEntry(file: File): FakeEntry {
  return { name: file.name, isFile: true, isDirectory: false, file: (ok: (f: File) => void) => ok(file) } as FakeEntry;
}

/** 一个文件夹：readEntries 像浏览器一样分批给（每批 batch 项），最后给空数组；broken 时读就报错。 */
export function fakeFolderEntry(name: string, children: FakeEntry[], { batch = 100, broken = false } = {}): FakeEntry {
  const createReader = () => {
    let next = 0;
    return {
      readEntries: (ok: (entries: FakeEntry[]) => void, fail: (err: DOMException) => void) =>
        queueMicrotask(() => {
          if (broken) return fail(new DOMException("不让读", "NotReadableError"));
          ok(children.slice(next, next + batch));
          next += batch;
        }),
    };
  };
  return { name, isFile: false, isDirectory: true, createReader } as FakeEntry;
}

/** 拖进来、粘进来的数据：每一项是一个文件（File）或一个文件夹（fakeFolderEntry）。files 里文件夹是 0 字节的空名文件，和 macOS 上的浏览器一样。 */
export function fakeDropData(things: (File | FakeEntry)[]): { files: FileList; items: DataTransferItemList; types: string[] } {
  const asFile = (t: File | FakeEntry) => (t instanceof File ? t : new File([], t.name));
  const items = things.map((t) => ({
    kind: "file",
    type: "",
    getAsFile: () => asFile(t),
    webkitGetAsEntry: () => (t instanceof File ? fakeFileEntry(t) : t),
  }));
  return { files: things.map(asFile) as unknown as FileList, items: items as unknown as DataTransferItemList, types: ["Files"] };
}

/** 若当前网址是空锚点（否则不动显式路由），切到快照里排第一的未归档 PM 对话（无对话时给 `#/c/1` 以落到“暂无对话”占位）。供专测对话页的旧套件复用。 */
export function openFirstConversation(snapshot: StateSnapshot): void {
  if (window.location.hash !== "" && window.location.hash !== "#") return;
  const archived = new Set(snapshot.pms.filter((p) => p.archivedAt != null).map((p) => p.id));
  const pmConvs = snapshot.conversations.filter((c) => c.conversation.kind !== "worker");
  const pool = pmConvs.filter((c) => c.conversation.pmId === null || !archived.has(c.conversation.pmId));
  const list = (pool.length > 0 ? pool : pmConvs).toSorted((a, b) => {
    const ta = a.messages.findLast((m) => !isQuietMessage(m))?.createdAt ?? a.conversation.createdAt;
    const tb = b.messages.findLast((m) => !isQuietMessage(m))?.createdAt ?? b.conversation.createdAt;
    return tb - ta || a.conversation.id - b.conversation.id;
  });
  window.history.replaceState(null, "", `/#/c/${list[0]?.conversation.id ?? 1}`);
}
