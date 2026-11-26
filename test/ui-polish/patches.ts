// 命名补丁（docs/ui-polish-loop-design.md 第 3.2 节）：真守护进程撑不住的瞬时状态（在忙、流式、额度、离线、接口出错、加载中），
// 在浏览器这一头改写接口的回包来摆出来。补丁只在这里定义，清单里按名字引用。
// 不变量：补丁改写的回包仍然是 src/shared/api.ts 里那个接口的类型；补丁不发任何请求给守护进程。
import type { Page, Request, Route } from "playwright";
import {
  API_PATHS,
  AGENT_VENDORS,
  DEFAULT_AGENT_VENDOR,
  DEVICE_OFFLINE_REASON,
  DEVICE_OFFLINE_WS_CLOSE_CODE,
  vendorSpec,
  type AgentVendor,
  type AccountStatusView,
  type ApiErrorBody,
  type BrowserSessionsResponse,
  type DeviceFingerprint,
  type LoginLinkResponse,
  type ModelsResponse,
  type PmMemoryFileDetail,
  type PmMemoryFilesList,
  type PostRouterCommandRequest,
  type PostRouterCommandResponse,
  type QuotaResponse,
  type RateLimitInfo,
  type ResourcesSnapshot,
  type StateSnapshot,
  type VendorAvailability,
} from "../../src/shared/index.ts";
import type { ProviderStatusItem, ProvidersStatusResponse } from "../../src/shared/providers.ts";
import type { VendorSyncPreviewResponse } from "../../src/shared/vendor-sync.ts";
import { progressScenarioMessages } from "./progress-scenarios.ts";
import { BROWSER_NOW_ISO } from "./limits.ts";

export const PATCH_NAMES = [
  "state-pending",
  "state-500",
  "folder-picker-available",
  "ws-reconnecting",
  "health-driver",
  "session-working",
  "session-streaming",
  "progress-running",
  "progress-two-turns",
  "progress-unfinished",
  "progress-wakeup-waiting",
  "progress-wakeup-idle",
  "progress-done",
  "workers-busy",
  "blocker-checking",
  "vendors-mixed",
  "models-long-names",
  "memory-files",
  "router-working",
  "router-failed",
  "router-vendor-agy",
  "router-quick-working",
  "router-quick-reply",
  "send-rejected",
  "device-reconnecting",
  "device-offline",
  "quota-normal",
  "quota-max",
  "provider-installing",
  "provider-login-code",
  "provider-failed",
  "vendor-sync-preview",
  "browsers-multi",
  "account-approvals",
  "account-long-name",
  "resources-attention",
] as const;
export type PatchName = (typeof PATCH_NAMES)[number];

const NOW = Date.parse(BROWSER_NOW_ISO);
const HOUR = 3_600_000;
const anyDevice = (path: string) => new RegExp(`^https?://[^/]+(?:/d/[^/]+)?${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\?.*)?$`);
// 入口本机的接口：HTTP 的和 WebSocket 的都认（routeWebSocket 拿到的网址是 ws:// 开头）
const localOnly = (path: string) => new RegExp(`^(?:https?|wss?)://[^/]+${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\?.*)?$`);

async function editJson<T>(page: Page, url: RegExp, edit: (body: T) => T): Promise<void> {
  await page.route(url, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as T;
    await route.fulfill({ status: response.status(), contentType: "application/json", body: JSON.stringify(edit(body)) });
  });
}

async function fixedJson(page: Page, url: RegExp, body: unknown, options: { method?: string; status?: number } = {}): Promise<void> {
  await page.route(url, (route) =>
    route.request().method() !== (options.method ?? "GET") ? route.fallback() : route.fulfill({ status: options.status ?? 200, contentType: "application/json", body: JSON.stringify(body) }),
  );
}

/** 补丁故意挂着不回的请求：截图等“网络静下来”时不算它们。 */
export const heldRequests = new WeakSet<Request>();

async function hang(page: Page, url: RegExp, method = "GET"): Promise<void> {
  await page.route(url, (route) => {
    if (route.request().method() !== method) return route.fallback();
    heldRequests.add(route.request());
    return new Promise<void>(() => {});
  });
}

const editState = (page: Page, edit: (state: StateSnapshot) => StateSnapshot, url = anyDevice(API_PATHS.state)) => editJson<StateSnapshot>(page, url, edit);

function latestSessions(state: StateSnapshot, pick: (s: StateSnapshot["sessions"][number]) => boolean): Set<number> {
  const best = new Map<number, StateSnapshot["sessions"][number]>();
  for (const s of state.sessions) {
    if (s.conversationId === null || !pick(s)) continue;
    const prev = best.get(s.conversationId);
    if (prev === undefined || s.generation > prev.generation) best.set(s.conversationId, s);
  }
  return new Set([...best.values()].map((s) => s.sessionId));
}

function working(state: StateSnapshot, sessionIds: Set<number>, extra: (index: number) => Partial<StateSnapshot["sessions"][number]>): StateSnapshot {
  let index = 0;
  return {
    ...state,
    sessions: state.sessions.map((s) => (sessionIds.has(s.sessionId) ? { ...s, status: "running", activity: "working", lastEventAt: NOW - 20_000, ...extra(index++) } : s)),
  };
}

const QUICK_REPLY = "小林在等你定失败结果缓存多久；小周卡在 Antigravity 没登录；其余项目经理都空闲。\n\n- 证书续期已交给柚子\n- 博客图片压缩已完成";

/** The top-bar Router input's POST answers at once with this command: still planning, or answered with a short Markdown reply. */
async function quickRouterAnswer(page: Page, status: "planning" | "answered"): Promise<void> {
  await page.route(localOnly(API_PATHS.routerCommands), (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as PostRouterCommandRequest;
    const answered = status === "answered";
    const response: PostRouterCommandResponse = {
      command: {
        id: 9_001,
        clientId: body.clientId,
        inputText: body.text,
        vendor: DEFAULT_AGENT_VENDOR,
        model: null,
        effort: null,
        status,
        plan: answered ? { intent: "answer", reply: QUICK_REPLY, actions: [] } : null,
        dispatched: null,
        error: null,
        durationMs: answered ? 4_200 : null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    };
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(response) });
  });
}

const firstPmConversation = (state: StateSnapshot) => state.conversations.find((c) => c.conversation.kind === "pm")?.conversation.id;

const claudeWindows = (fiveHour: number, sevenDay: number): RateLimitInfo => ({
  status: fiveHour >= 1 ? "rejected" : fiveHour >= 0.8 ? "allowed_warning" : "allowed",
  resetsAt: Math.floor((NOW + 2 * HOUR) / 1000),
  windows: {
    five_hour: { utilization: fiveHour, resetsAt: Math.floor((NOW + 2 * HOUR) / 1000), status: fiveHour >= 1 ? "rejected" : "allowed" },
    seven_day: { utilization: sevenDay, resetsAt: Math.floor((NOW + 76 * HOUR) / 1000), status: "allowed" },
  },
});

function quota(page: Page, claude: RateLimitInfo, agy: QuotaResponse): Promise<void[]> {
  return Promise.all([
    editState(page, (state) => {
      const [pm, second] = state.conversations.filter((c) => c.conversation.kind === "pm").map((c) => c.conversation.id);
      // 第二个项目经理用 Antigravity：有按需查额度的厂商在用，浮层才会去查它的两个模型族（selectors.ts 的 hasFetchedQuotaSession）
      return {
        ...state,
        sessions: state.sessions.map((s) => (s.conversationId === pm ? { ...s, vendor: "claude", rateLimit: claude } : s.conversationId === second ? { ...s, vendor: "agy" } : s)),
      };
    }),
    fixedJson(page, anyDevice(API_PATHS.quota), agy),
    editJson<ModelsResponse>(page, anyDevice(API_PATHS.models), (m) => ({ catalogs: m.catalogs.map((c) => (c.vendor === "agy" ? { ...c, availability: "available" } : c)) })),
  ]);
}

/**
 * 截图用的厂商状态混排，照用户真实机器的样子：五家能用、DeepSeek 没登录。
 * 行多、每行都带模型名，面板才会被撑宽（PR #337 修的那个右边被裁，就是在这种情况下出现的）。
 */
const MIXED: Partial<Record<AgentVendor, VendorAvailability>> = { claude: "available", agy: "available", codex: "available", pi: "available", cursor: "available", deepseek: "signed_out" };
/**
 * Pi 是聚合多家的厂商，它自己报的模型名带服务商后缀（用户机器上是“Claude Sonnet 5.5 (anthropic)”），打包名单里没有后缀。
 * 照真实的样子补上：模型面板每行右边显示它，是撑宽面板的那一行。
 */
const PI_PROVIDER: ReadonlyArray<[RegExp, string]> = [[/^DeepSeek/, "deepseek"], [/^Claude/, "anthropic"], [/^GPT/, "openai"], [/^Gemini/, "google"]];
const mixedCatalog = (c: ModelsResponse["catalogs"][number]): ModelsResponse["catalogs"][number] => ({
  ...c,
  availability: mixedAvailability(c.vendor),
  models:
    c.vendor === "pi"
      ? c.models.map((m) => ({ ...m, label: `${m.label} (${PI_PROVIDER.find(([re]) => re.test(m.label))?.[1] ?? "openrouter"})` }))
      : c.models,
});
const mixedAvailability = (vendor: AgentVendor): VendorAvailability => MIXED[vendor] ?? "not_installed";

function provider(vendor: AgentVendor, patch: Partial<ProviderStatusItem> = {}): ProviderStatusItem {
  const availability = mixedAvailability(vendor);
  const installed = availability !== "not_installed";
  return {
    vendor,
    label: vendorSpec(vendor).label,
    installed,
    version: installed ? "2.4.1" : null,
    availability,
    accountSummary: availability === "available" ? "demo@example.com" : null,
    canInstall: !installed,
    canUpdate: installed,
    canSignOut: availability === "available",
    authMethods: [
      { id: "browser", kind: "browser_oauth", label: "Sign in with browser", manualInput: "code" },
      { id: "api-key", kind: "api_key", label: "API key", placeholder: "sk-…" },
    ],
    job: null,
    authFlow: null,
    ...patch,
  };
}

function providers(page: Page, edit: (vendor: AgentVendor) => Partial<ProviderStatusItem> = () => ({})): Promise<void> {
  const body: ProvidersStatusResponse = {
    platform: "darwin",
    gitInstalled: true,
    canInstallGit: false,
    gitJob: null,
    providers: AGENT_VENDORS.map((vendor) => provider(vendor, edit(vendor))),
  };
  return fixedJson(page, anyDevice(API_PATHS.providers), body);
}

const job = (phase: "running" | "failed", logTail: string) => ({
  jobId: "job-1",
  kind: "install" as const,
  phase,
  progressLine: phase === "running" ? "Installing package…" : null,
  error: phase === "failed" ? "npm exited with code 1: EACCES permission denied" : null,
  logTail,
  startedAt: NOW - 40_000,
  finishedAt: phase === "failed" ? NOW - 5_000 : null,
});

const INSTALL_LOG = ["npm notice Beginning install", "added 112 packages in 6s", "npm error code EACCES", "npm error syscall mkdir", "npm error path /usr/local/lib/node_modules"].join("\n");

const MEMORY_FILES: readonly PmMemoryFileDetail[] = [
  { name: "conventions.md", bytes: 4_200, updatedAt: NOW - 2 * HOUR, content: "# 约定\n\n- 改动前先说清边界\n- 测试不过不交\n- 周报每周五发" },
  { name: "crawler-notes.md", bytes: 512_000, updatedAt: NOW - 26 * HOUR, content: "# 抓取笔记\n\n限流时退避到每 3 小时一次。" },
  { name: "release-log.md", bytes: 356_000, updatedAt: NOW - 5 * 24 * HOUR, content: "# 发布记录\n\n1.4：换会话阈值按厂商配置。" },
];

const LONG_MODEL = "claude-opus-5-5-20261101-extended-thinking-preview-with-a-very-long-identifier";

const SYNC_PREVIEW: VendorSyncPreviewResponse = {
  scannedAt: NOW - 60_000,
  truncated: false,
  hostBoundConfirmSupported: true,
  mcpServers: [
    {
      key: "github",
      name: "github",
      transport: "stdio",
      maskedTarget: "npx -y @modelcontextprotocol/server-github",
      maskedAuth: ["GITHUB_TOKEN=••••"],
      usesMcpRemoteBridge: false,
      vendors: [
        { vendor: "claude", label: "Claude Code", status: "present" },
        { vendor: "codex", label: "Codex", status: "will_add" },
      ],
    },
    {
      key: "linear",
      name: "linear",
      transport: "http",
      maskedTarget: "https://mcp.linear.app/sse?token=••••",
      maskedAuth: [],
      usesMcpRemoteBridge: true,
      vendors: [
        { vendor: "claude", label: "Claude Code", status: "mcp_remote" },
        { vendor: "codex", label: "Codex", status: "present" },
      ],
    },
  ],
  skills: [
    {
      key: "global:frontend-rules",
      name: "frontend-rules",
      scope: "global",
      sourcePath: "~/.agents/skills/frontend-rules",
      vendors: [
        { vendor: "claude", label: "Claude Code", status: "present" },
        { vendor: "codex", label: "Codex", status: "will_link" },
      ],
    },
    {
      key: "project:/tmp/fusa-ui-shots/projects/agent-hub:poteto-mode",
      name: "poteto-mode",
      scope: "project",
      projectLabel: "agent-hub",
      sourcePath: "/tmp/fusa-ui-shots/projects/agent-hub/.agents/skills/poteto-mode",
      vendors: [{ vendor: "claude", label: "Claude Code", status: "present" }],
    },
  ],
  nonSyncable: [{ key: "drive", name: "Google Drive", vendor: "claude", vendorLabel: "Claude Code", kind: "cloud_connector", reason: "Cloud connectors stay with the provider that owns them" }],
};

function progressScenario(page: Page, scenario: Parameters<typeof progressScenarioMessages>[0]["scenario"]) {
  return editState(page, (state) => {
    const conversationId = firstPmConversation(state);
    if (conversationId === undefined) return state;
    const target = latestSessions(state, (session) => session.conversationId === conversationId);
    const sessionId = [...target][0];
    if (sessionId === undefined) return state;
    const next = scenario === "waiting" ? working(state, target, () => ({
      step: { type: "tool_use", name: "Read", input: {} }, currentTool: "Read", stepStartedAt: NOW - 35_000,
    })) : state;
    return {
      ...next,
      conversations: next.conversations.map((conv) => conv.conversation.id !== conversationId ? conv : {
        ...conv,
        messages: progressScenarioMessages({ scenario, baseId: (conv.messages.at(-1)?.id ?? 100) + 10, conversationId, sessionId, now: NOW }),
      }),
    };
  });
}

const PATCHES: Record<PatchName, (page: Page) => Promise<unknown>> = {
  "progress-two-turns": (page) => progressScenario(page, "two-turns"),
  "progress-unfinished": (page) => progressScenario(page, "unfinished"),
  "progress-wakeup-waiting": (page) => progressScenario(page, "waiting"),
  "progress-wakeup-idle": (page) => progressScenario(page, "idle"),
  "state-pending": (page) => hang(page, localOnly(API_PATHS.state)),
  "state-500": (page) => fixedJson(page, localOnly(API_PATHS.state), { error: "数据库打不开：database is locked", } satisfies ApiErrorBody, { status: 500 }),
  "folder-picker-available": (page) => editState(page, (state) => ({ ...state, server: { ...state.server, folderPicker: true } }), localOnly(API_PATHS.state)),
  "ws-reconnecting": (page) => page.routeWebSocket(localOnly(API_PATHS.ws), (ws) => ws.close({ code: 1006, reason: "" }).catch(() => {})),
  "health-driver": (page) =>
    editState(page, (state) => ({
      ...state,
      health: [{ module: "driver", consecutiveFailures: 3, lastError: "claude_not_found: 找不到 claude 命令，装好后点 Retry", updatedAt: NOW - 90_000 }],
    }), localOnly(API_PATHS.state)),
  "session-working": (page) =>
    editState(page, (state) => {
      const target = latestSessions(state, (s) => s.conversationId === firstPmConversation(state) || s.pmId === null);
      return working(state, target, () => ({ step: { type: "tool_use", name: "Bash", input: {} }, currentTool: "Bash", stepStartedAt: NOW - 16_000 }));
    }),
  "session-streaming": (page) =>
    editState(page, (state) =>
      working(state, latestSessions(state, (s) => s.conversationId === firstPmConversation(state)), () => ({
        step: { type: "text" },
        stepStartedAt: NOW - 4_000,
        streamingText: "我看了一下超时的那几次：都是 MCP 服务第一次握手超过 30 秒，失败结果被当成正常结果缓存了 10 分钟，所以后面几次",
      })),
    ),
  "progress-running": (page) =>
    editState(page, (state) => {
      const pmConvId = firstPmConversation(state);
      const target = latestSessions(state, (s) => s.conversationId === pmConvId);
      const sessionId = [...target][0] ?? 1;
      const next = working(state, target, () => ({
        step: { type: "tool_use", name: "Bash", input: {} },
        currentTool: "Bash",
        stepStartedAt: NOW - 16_000,
      }));
      return {
        ...next,
        conversations: next.conversations.map((conv) => {
          if (conv.conversation.id !== pmConvId) return conv;
          const baseId = (conv.messages.at(-1)?.id ?? 100) + 10;
          const mk = (offset: number, over: Partial<StateSnapshot["conversations"][number]["messages"][number]>) => ({
            id: baseId + offset,
            conversationId: pmConvId,
            sessionId,
            workerId: null,
            sender: "agent" as const,
            kind: "text" as const,
            text: "",
            meta: null,
            collapsed: false,
            dedupeKey: `patch-progress-run:${baseId + offset}`,
            status: null,
            failureReason: null,
            createdAt: NOW - 30_000 + offset * 2_000,
            updatedAt: NOW - 30_000 + offset * 2_000,
            ...over,
          });
          return {
            ...conv,
            messages: [
              ...conv.messages,
              mk(1, { sender: "user", text: "汇总上次发布以来的提交、PR 和 CI 状态", status: "processing" }),
              mk(2, {
                kind: "checklist",
                collapsed: true,
                meta: {
                  checklist: [
                    { id: "s1", title: "读完右栏规格和原型", activeTitle: null, status: "in_progress" },
                    { id: "s2", title: "查看 4b1fb2e2 之后的提交、PR 和发布", activeTitle: null, status: "pending" },
                    { id: "s3", title: "拉新快照核对遗留问题和新增内容", activeTitle: null, status: "pending" },
                    { id: "s4", title: "汇总变化", activeTitle: null, status: "pending" },
                  ],
                },
              }),
              mk(3, { kind: "tool", collapsed: true, text: "Read: docs/ui-standard.md" }),
              mk(4, {
                kind: "checklist",
                collapsed: true,
                meta: {
                  checklist: [
                    { id: "s1", title: "读完右栏规格和原型", activeTitle: null, status: "completed" },
                    { id: "s2", title: "查看 4b1fb2e2 之后的提交、PR 和发布", activeTitle: null, status: "in_progress" },
                    { id: "s3", title: "拉新快照核对遗留问题和新增内容", activeTitle: null, status: "pending" },
                    { id: "s4", title: "汇总变化", activeTitle: null, status: "pending" },
                  ],
                },
              }),
              mk(5, { kind: "tool", collapsed: true, text: "Bash: git log --oneline 4b1fb2e2..HEAD" }),
            ],
          };
        }),
      };
    }),
  "progress-done": (page) =>
    editState(page, (state) => {
      const pmConvId = firstPmConversation(state);
      const sessionId = state.sessions.find((s) => s.conversationId === pmConvId)?.sessionId ?? 1;
      return {
        ...state,
        conversations: state.conversations.map((conv) => {
          if (conv.conversation.id !== pmConvId) return conv;
          const baseId = (conv.messages.at(-1)?.id ?? 100) + 20;
          const mk = (offset: number, over: Partial<StateSnapshot["conversations"][number]["messages"][number]>) => ({
            id: baseId + offset,
            conversationId: pmConvId,
            sessionId,
            workerId: null,
            sender: "agent" as const,
            kind: "text" as const,
            text: "",
            meta: null,
            collapsed: false,
            dedupeKey: `patch-progress-done:${baseId + offset}`,
            status: null,
            failureReason: null,
            createdAt: NOW - 200_000 + offset * 20_000,
            updatedAt: NOW - 200_000 + offset * 20_000,
            ...over,
          });
          return {
            ...conv,
            messages: [
              ...conv.messages,
              mk(1, { sender: "user", text: "把上次以来的改动整理一份摘要", status: "replied" }),
              mk(2, {
                kind: "checklist",
                collapsed: true,
                meta: {
                  checklist: [
                    { id: "s1", title: "读完右栏规格和原型", activeTitle: null, status: "in_progress" },
                    { id: "s2", title: "查看 4b1fb2e2 之后的提交、PR 和发布", activeTitle: null, status: "pending" },
                    { id: "s3", title: "拉新快照核对遗留问题和新增内容", activeTitle: null, status: "pending" },
                    { id: "s4", title: "汇总变化", activeTitle: null, status: "pending" },
                  ],
                },
              }),
              mk(3, { kind: "tool", collapsed: true, text: "Read: docs/ui-standard.md" }),
              mk(4, {
                kind: "checklist",
                collapsed: true,
                meta: {
                  checklist: [
                    { id: "s1", title: "读完右栏规格和原型", activeTitle: null, status: "completed" },
                    { id: "s2", title: "查看 4b1fb2e2 之后的提交、PR 和发布", activeTitle: null, status: "in_progress" },
                    { id: "s3", title: "拉新快照核对遗留问题和新增内容", activeTitle: null, status: "pending" },
                    { id: "s4", title: "汇总变化", activeTitle: null, status: "pending" },
                  ],
                },
              }),
              mk(5, { kind: "tool", collapsed: true, text: "Bash: git log --oneline 4b1fb2e2..HEAD" }),
              mk(6, { kind: "tool", collapsed: true, text: "Bash: gh pr list --state merged --limit 10" }),
              mk(7, {
                kind: "checklist",
                collapsed: true,
                meta: {
                  checklist: [
                    { id: "s1", title: "读完右栏规格和原型", activeTitle: null, status: "completed" },
                    { id: "s2", title: "查看 4b1fb2e2 之后的提交、PR 和发布", activeTitle: null, status: "completed" },
                    { id: "s3", title: "拉新快照核对遗留问题和新增内容", activeTitle: null, status: "in_progress" },
                    { id: "s4", title: "汇总变化", activeTitle: null, status: "pending" },
                  ],
                },
              }),
              mk(8, { kind: "tool", collapsed: true, text: "Read: src/web/components/TurnProgress.tsx" }),
              mk(9, {
                kind: "checklist",
                collapsed: true,
                meta: {
                  checklist: [
                    { id: "s1", title: "读完右栏规格和原型", activeTitle: null, status: "completed" },
                    { id: "s2", title: "查看 4b1fb2e2 之后的提交、PR 和发布", activeTitle: null, status: "completed" },
                    { id: "s3", title: "拉新快照核对遗留问题和新增内容", activeTitle: null, status: "completed" },
                    { id: "s4", title: "汇总变化", activeTitle: null, status: "completed" },
                  ],
                },
              }),
              mk(10, { text: "已核对完 4b1fb2e2 之后的提交与发布，主要变化集中在木头外壳与实时进度清单。" }),
            ],
          };
        }),
      };
    }),
  "workers-busy": (page) =>
    editState(page, (state) => {
      const workerConversations = new Set(state.conversations.filter((c) => c.conversation.kind === "worker").map((c) => c.conversation.id));
      return working(state, latestSessions(state, (s) => s.conversationId !== null && workerConversations.has(s.conversationId)), (i) => ({
        step: i % 2 === 0 ? { type: "thinking" } : { type: "tool_use", name: "Edit", input: { file_path: "src/shared/vendors.ts" } },
      }));
    }),
  "blocker-checking": (page) => hang(page, /\/api\/user-blockers\/\d+\/recheck$/, "POST"),
  "vendors-mixed": (page) =>
    Promise.all([
      editJson<ModelsResponse>(page, anyDevice(API_PATHS.models), (m) => ({ catalogs: m.catalogs.map(mixedCatalog) })),
      providers(page),
    ]),
  // 总助指定用这个超长名字的模型：顶栏的入口和面板里 Claude 那一行都要显示它（只往名单里加一个没人用的模型，界面上看不到）
  "models-long-names": (page) => Promise.all([
    editState(page, (state) => ({ ...state, router: { ...state.router, settings: { ...state.router.settings, vendor: "claude", model: LONG_MODEL, effort: "high" } } })),
    editJson<ModelsResponse>(page, anyDevice(API_PATHS.models), (m) => ({
      catalogs: m.catalogs.map((c) =>
        c.vendor === "claude"
          ? { ...c, availability: "available", defaultModel: LONG_MODEL, models: [...c.models, { id: LONG_MODEL, label: LONG_MODEL, description: "Preview model with extended thinking and a very long marketing description", efforts: ["low", "medium", "high"] }] }
          : mixedCatalog(c),
      ),
    })),
  ]),
  // 记忆文件：三个子文件，合计接近 1 MB 上限（出配额提示）；点开一个能看到内容
  "memory-files": (page) => Promise.all([
    fixedJson(page, /\/api\/pms\/\d+\/memory-files$/, { files: MEMORY_FILES.map(({ content: _content, ...summary }) => summary), totalBytes: MEMORY_FILES.reduce((sum, f) => sum + f.bytes, 0) } satisfies PmMemoryFilesList),
    page.route(/\/api\/pms\/\d+\/memory-files\/[^/]+$/, (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
      const file = MEMORY_FILES.find((f) => f.name === name) ?? MEMORY_FILES[0]!;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(file satisfies PmMemoryFileDetail) });
    }),
  ]),
  "router-working": (page) =>
    editState(page, (state) => ({
      ...state,
      router: { ...state.router, commands: state.router.commands.map((c, i) => (i === 0 ? { ...c, status: "planning", plan: null, dispatched: null, durationMs: null } : c)) },
    })),
  "router-failed": (page) =>
    editState(page, (state) => ({
      ...state,
      router: {
        ...state.router,
        commands: state.router.commands.map((c, i) => (i === 0 ? { ...c, status: "failed", plan: null, dispatched: null, error: "总助没有回应：claude 进程退出（code 1）" } : c)),
      },
    })),
  "router-vendor-agy": (page) =>
    Promise.all([
      editState(page, (state) => ({ ...state, router: { ...state.router, settings: { ...state.router.settings, vendor: "agy", model: null, effort: "high" } } })),
      editJson<ModelsResponse>(page, anyDevice(API_PATHS.models), (m) => ({ catalogs: m.catalogs.map(mixedCatalog) })),
    ]),
  "router-quick-working": (page) => quickRouterAnswer(page, "planning"),
  "router-quick-reply": (page) => quickRouterAnswer(page, "answered"),
  "send-rejected": (page) =>
    page.route(/\/api\/conversations\/\d+\/messages$/, (route) =>
      route.request().method() !== "POST"
        ? route.fallback()
        : route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "/clear 在这里不能用：换会话请到资料页点 New session", code: "invalid" } satisfies ApiErrorBody) }),
    ),
  "device-reconnecting": (page) => page.routeWebSocket(/\/d\/[^/]+\/api\/ws/, (ws) => ws.close({ code: 1006, reason: "" }).catch(() => {})),
  // 只断推送不断接口：快照照常拉到，推送被入口按“对方离线”关掉，界面显示离线（同真的断网后的样子）
  "device-offline": (page) => page.routeWebSocket(/\/d\/[^/]+\/api\/ws/, (ws) => ws.close({ code: DEVICE_OFFLINE_WS_CLOSE_CODE, reason: DEVICE_OFFLINE_REASON }).catch(() => {})),
  "quota-normal": (page) =>
    quota(page, claudeWindows(0.42, 0.18), {
      groups: [
        { vendor: "agy", id: "gemini", windows: { five_hour: { utilization: 0.3, resetsAt: Math.floor((NOW + 3 * HOUR) / 1000), status: "allowed" }, seven_day: { utilization: 0.12, resetsAt: Math.floor((NOW + 100 * HOUR) / 1000), status: "allowed" } } },
      ],
    }),
  "quota-max": (page) =>
    quota(page, claudeWindows(1, 0.86), {
      groups: [
        { vendor: "agy", id: "gemini", windows: { five_hour: { utilization: 0.92, resetsAt: Math.floor((NOW + HOUR / 2) / 1000), status: "allowed" }, seven_day: { utilization: 0.64, resetsAt: Math.floor((NOW + 30 * HOUR) / 1000), status: "allowed" } } },
        { vendor: "agy", id: "claude_gpt", windows: { five_hour: { utilization: 1, resetsAt: Math.floor((NOW + 4 * HOUR) / 1000), status: "rejected" }, seven_day: { utilization: 0.97, resetsAt: Math.floor((NOW + 50 * HOUR) / 1000), status: "allowed" } } },
      ],
    }),
  "provider-installing": (page) => providers(page, (v) => (v === "agy" ? { installed: false, version: null, accountSummary: null, canInstall: true, canUpdate: false, canSignOut: false, availability: "not_installed", job: job("running", INSTALL_LOG.split("\n").slice(0, 2).join("\n")) } : {})),
  "provider-login-code": (page) =>
    providers(page, (v) =>
      v === "deepseek"
        ? {
            authFlow: {
              flowId: "flow-1",
              methodId: "browser",
              phase: "waiting_browser",
              authorizeUrl: "https://accounts.example.com/o/oauth2/auth?client_id=demo&state=fixed",
              verificationUrl: null,
              userCode: null,
              manualInput: "code",
              ownedByOtherClient: false,
              error: null,
              expiresAt: NOW + 10 * 60_000,
            },
          }
        : {},
    ),
  "provider-failed": (page) => providers(page, (v) => (v === "agy" ? { installed: false, version: null, accountSummary: null, canInstall: true, canUpdate: false, canSignOut: false, availability: "not_installed", job: job("failed", INSTALL_LOG) } : {})),
  "vendor-sync-preview": (page) => fixedJson(page, anyDevice(API_PATHS.vendorSyncPreview), SYNC_PREVIEW),
  "browsers-multi": (page) =>
    editJson<BrowserSessionsResponse>(page, localOnly(API_PATHS.browserSessions), (body) => ({
      sessions: [
        ...body.sessions,
        { id: "iphone-1", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Mobile/15E148 Safari/604.1", createdAt: NOW - 2 * HOUR, lastSeenAt: NOW - 60_000, current: false },
        { id: "old-1", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Safari/605.1.15", createdAt: NOW - 30 * 24 * HOUR, lastSeenAt: NOW - 3 * 24 * HOUR, current: false },
      ],
    })),
  "account-approvals": (page) =>
    editJson<AccountStatusView>(page, localOnly(API_PATHS.account), (body) =>
      body.state === "signed_in"
        ? {
            ...body,
            feishuHolder: body.devices[0]?.id ?? null,
            approvals: [
              {
                requestId: "33333333-3333-4333-8333-333333333333",
                device: {
                  id: "33333333-3333-4333-8333-333333333333",
                  name: "Home Windows",
                  platform: "win32",
                  fingerprint: "a".repeat(64) as DeviceFingerprint,
                },
                requestedAt: NOW - 60_000,
                expiresAt: NOW + 540_000,
                sas: "042917",
              },
            ],
          }
        : body,
    ),
  "account-long-name": (page) =>
    fixedJson(page, localOnly(API_PATHS.account), {
      state: "signed_out",
      lastError: null,
    } satisfies AccountStatusView),
  "resources-attention": (page) =>
    fixedJson(page, anyDevice(API_PATHS.resources), {
      scannedAt: NOW - 30_000,
      database: {
        fileBytes: 18 * 1024 * 1024,
        walBytes: 420 * 1024,
        freelistBytes: 2 * 1024 * 1024,
        dbstatAvailable: true,
        tables: [
          { table: "messages", bytes: 10 * 1024 * 1024, rows: 12_400, rowLimit: null, warning: false },
          { table: "step_logs", bytes: 5 * 1024 * 1024, rows: 28_900, rowLimit: 50_000, warning: false },
          { table: "router_items", bytes: 1_200 * 1024, rows: 420, rowLimit: null, warning: false },
          { table: "task_graphs", bytes: 420 * 1024, rows: 38, rowLimit: null, warning: false },
        ],
      },
      directories: [
        { id: "worktrees", label: "Worktrees", bytes: 12 * 1024 * 1024, fileCount: 42, maxBytes: null, maxFiles: null, truncated: false, warning: false },
        { id: "sentFiles", label: "Delivered files", bytes: 4 * 1024 * 1024, fileCount: 15, maxBytes: 256 * 1024 * 1024, maxFiles: null, truncated: false, warning: false },
        { id: "uploads", label: "Uploads", bytes: 3 * 1024 * 1024, fileCount: 8, maxBytes: 256 * 1024 * 1024, maxFiles: null, truncated: false, warning: false },
        { id: "logs", label: "Logs", bytes: 1_800 * 1024, fileCount: 12, maxBytes: null, maxFiles: null, truncated: false, warning: false },
      ],
      branches: [{ projectId: 1, projectName: "agent-hub", repoFolder: "/tmp/fusa-ui-shots/projects/agent-hub", activeCount: 1, mergedCleanableCount: 3, unmergedHeldCount: 1 }],
      processes: { trackedCount: 2, leakedCount: 1 },
      held: [
        {
          kind: "worktree",
          targetKey: "42",
          reason: "uncommitted_changes",
          label: "#42 Fix auth flow",
          projectId: 1,
          projectName: "agent-hub",
          bytes: 12 * 1024 * 1024,
          detectedAt: NOW - 2 * HOUR,
          samplePaths: ["src/auth.ts", "src/auth.test.ts"],
          keptAt: null,
          workerId: 42,
          branch: "hub/42-fix-auth",
          worktreePath: "/Users/demo/.agent-hub/worktrees/1/42",
          dirtyCount: 2,
        },
        {
          kind: "git_branch",
          targetKey: "1:hub/31-experiment",
          reason: "unmerged_ended_branch",
          label: "hub/31-experiment",
          projectId: 1,
          projectName: "agent-hub",
          bytes: null,
          detectedAt: NOW - 5 * HOUR,
          samplePaths: [],
          keptAt: NOW - 3 * HOUR,
          workerId: 31,
          branch: "hub/31-experiment",
          repoFolder: "/tmp/fusa-ui-shots/projects/agent-hub",
          commitsAhead: 2,
        },
      ],
      heldTruncated: false,
      totalDiskBytes: 40 * 1024 * 1024,
      attentionCount: 1,
    } satisfies ResourcesSnapshot),
};

/**
 * 前置：在页面第一次导航之前调用。
 * 后置：之后这个页面发的相关请求拿到的是改写过的回包。name 不在 PATCH_NAMES 里抛 RangeError。
 */
export async function applyPatch(page: Page, name: string): Promise<void> {
  if (!(PATCH_NAMES as readonly string[]).includes(name)) throw new RangeError(`没有叫 ${name} 的补丁`);
  await PATCHES[name as PatchName](page);
}

/** 只是取东西、不改数据的 POST：给固定的回包，界面上的二维码才每次一样。 */
const READ_LIKE_POSTS: ReadonlyArray<{ url: RegExp; body: unknown }> = [
  { url: localOnly(API_PATHS.loginLinks), body: { url: "http://127.0.0.1:4317/auth?link=ui-polish-fixed-link", expiresAt: NOW + 10 * 60_000 } satisfies LoginLinkResponse },
];

/**
 * 截图不改数据：这个页面发出的非 GET 接口请求一律拦掉（打开总助会把简报标成已读，不拦的话第二次截出来就不一样）。
 * allow 里列的路径放行（到达步骤确实要点保存的界面才用）。
 */
export async function blockWrites(page: Page, allow?: readonly string[]): Promise<void> {
  await page.route(/\/api\//, (route: Route) => {
    const request = route.request();
    if (request.method() === "GET" || request.method() === "HEAD") return route.fallback();
    const path = new URL(request.url()).pathname;
    if (allow?.some((p) => path === p || path.endsWith(p))) return route.fallback();
    const fixed = READ_LIKE_POSTS.find((p) => p.url.test(request.url()));
    if (fixed !== undefined) return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(fixed.body) });
    return route.abort("blockedbyclient");
  });
}

