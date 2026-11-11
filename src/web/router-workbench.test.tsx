// Router 第 2 波前端工作台（docs/ui-standard.md 第 21 节、docs/router-design.md 第 4 节）端到端行为与守卫测试。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  DEFAULT_AGENT_VENDOR,
  ROUTER_VISIBLE_RECEIPTS_MAX,
  emptyRouterSlice,
  type DeviceInfo,
  type RouterCommandRecord,
  type RouterDecisionItem,
  type RouterReportItem,
  type StateSnapshot,
  type TaskGraph,
} from "../shared/index.ts";
import { App } from "./App.tsx";
import { OFFLINE_AFTER_MS } from "./devices.ts";
import { MOBILE_SHELL_QUERY, NARROW_QUERY } from "./useMediaQuery.ts";
import {
  FakeApi,
  FakeWebSocket,
  changeOf,
  installFakeNotification,
  installFakeWebSocket,
  makeConvSnapshot,
  makePm,
  makeProject,
  makeSnapshot,
} from "./test-utils.ts";

const LOCAL_ID = "00000000-0000-4000-8000-000000000001";
const TOKYO_ID = "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f";

let viewportMode: "wide" | "rail" | "mobile" = "wide";

function installViewport(mode: "wide" | "rail" | "mobile") {
  viewportMode = mode;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches:
      (mode === "mobile" && query === MOBILE_SHELL_QUERY) ||
      (mode === "rail" && query === NARROW_QUERY),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

function makeDecisionItem(over: Partial<RouterDecisionItem> = {}): RouterDecisionItem {
  return {
    id: 101,
    kind: "decision",
    status: "pending",
    pmId: 1,
    projectId: 10,
    conversationId: 1,
    question: "缓存层选哪种淘汰策略？",
    context: "需要同时满足 30 天驻留与引用稳定",
    options: ["(Recommended) WeakMap + 容量上限", "纯定时清理"],
    askMessageId: null,
    resolution: null,
    createdAt: 20_000,
    updatedAt: 20_000,
    ...over,
  };
}

function makeReportItem(over: Partial<RouterReportItem> = {}): RouterReportItem {
  return {
    id: 201,
    kind: "report",
    status: "unread",
    pmId: 1,
    projectId: 10,
    conversationId: 1,
    summary: "已完成第 1 波账本与快照瘦身",
    links: [
      { label: "PR #410", target: "https://github.com/example/agent-hub/pull/410" },
      { label: "Piece #30", target: "#/w/30" },
    ],
    createdAt: 18_000,
    updatedAt: 18_000,
    ...over,
  };
}

function makeCommandRecord(over: Partial<RouterCommandRecord> = {}): RouterCommandRecord {
  return {
    id: 301,
    clientId: "cmd-1",
    inputText: "让小林检查一下缓存上限",
    vendor: DEFAULT_AGENT_VENDOR,
    model: null,
    effort: null,
    status: "dispatched",
    plan: {
      intent: "dispatch",
      reply: "已派给小林检查缓存上限",
      actions: [
        {
          type: "dispatch",
          deviceId: "local",
          pmId: 1,
          message: "检查一下缓存上限",
          summary: "已派给小林检查缓存上限",
          risk: "low",
        },
      ],
    },
    dispatched: [{ deviceId: "local", pmId: 1, messageId: 88, ok: true }],
    error: null,
    durationMs: 420,
    createdAt: 25_000,
    updatedAt: 25_000,
    ...over,
  };
}

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function installFleet(opts: {
  local?: StateSnapshot;
  tokyo?: StateSnapshot;
  tokyoOnline?: boolean;
}) {
  const localSnap =
    opts.local ??
    makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      projects: [makeProject({ id: 10, name: "agent-hub", pmId: 1, conversationId: 1 })],
      conversations: [
        makeConvSnapshot([], { conversation: { id: 1, pmId: 1, projectId: 10, title: "小林" } }),
        makeConvSnapshot([], { conversation: { id: 30, kind: "worker", pmId: 1, projectId: 10, title: "修缓存" } }),
      ],
    });
  const localApi = new FakeApi(localSnap);
  const tokyoApi = opts.tokyo ? new FakeApi(opts.tokyo) : null;
  let tokyoOffline = opts.tokyoOnline === false;
  const devices: DeviceInfo[] = [
    { id: LOCAL_ID, name: "MacBook", self: true, platform: "darwin", url: null },
    ...(tokyoApi
      ? [{ id: TOKYO_ID, name: "Tokyo", self: false, platform: "linux", url: "https://tokyo.tailnet.ts.net" }]
      : []),
  ];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://127.0.0.1:1");
    if (url.pathname === "/api/devices" && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ devices }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const peerMatch = /^\/d\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (peerMatch) {
      const peerId = peerMatch[1]!;
      const rest = peerMatch[2]! + url.search;
      if (peerId === TOKYO_ID && tokyoApi) {
        if (tokyoOffline) {
          return new Response(JSON.stringify({ error: "连不上 Tokyo", code: "device_offline" }), {
            status: 502,
            headers: { "content-type": "application/json" },
          });
        }
        return tokyoApi.fetch(rest, init);
      }
      return new Response(JSON.stringify({ error: "not found", code: "device_not_found" }), { status: 404 });
    }
    return localApi.fetch(input, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    localApi,
    tokyoApi,
    fetchMock,
    setTokyoOffline: (v: boolean) => {
      tokyoOffline = v;
    },
  };
}

function openSockets() {
  for (const ws of FakeWebSocket.instances) {
    if (ws.readyState === 0) ws.open();
  }
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  installViewport("wide");
  installFakeWebSocket();
  installFakeNotification("default");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Router 第 2 波：路由与默认落地页", () => {
  it("电脑外壳空 hash 默认 replace 到 #/router，呈现纯白碳黑中性调、无右栏、无聊天气泡，全空时居中展示 All clear", async () => {
    const { localApi } = installFleet({});
    const beforeLen = window.history.length;
    const { container } = renderWithQuery(<App />);
    await waitFor(() => expect(localApi.callsTo("GET", /^\/api\/state$/).length).toBeGreaterThan(0));
    act(openSockets);

    expect(await screen.findByRole("heading", { level: 1, name: "Router" })).toBeInTheDocument();
    await waitFor(() => expect(window.location.hash).toBe("#/router"));
    expect(window.history.length).toBe(beforeLen);

    // 严禁出现聊天气泡、对话日志角色或右栏
    expect(container.querySelector("[class*='bubble-']")).toBeNull();
    expect(screen.queryByRole("log")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Pieces" })).toBeNull();

    // 空态：半透明水果刀 + All clear
    const main = container.querySelector("main")!;
    const allClear = within(main).getByText("All clear");
    expect(allClear).toBeInTheDocument();
    expect(allClear.parentElement?.querySelector("[data-slot='knife-avatar']")).toHaveClass("opacity-40");
  });

  it("手机外壳空 hash 保持列表页首页（置顶挂 Router 入口且不带激活底色），点击进入 #/router，左上角 Back 退回列表页", async () => {
    installViewport("mobile");
    const { localApi } = installFleet({});
    const user = userEvent.setup();
    renderWithQuery(<App />);
    await waitFor(() => expect(localApi.callsTo("GET", /^\/api\/state$/).length).toBeGreaterThan(0));
    act(openSockets);

    // 手机首页停在列表页，网址仍是空 hash
    const routerEntry = await screen.findByRole("button", { name: /Router/ });
    expect(window.location.hash).toBe("");
    expect(routerEntry).not.toHaveAttribute("aria-current");

    await user.click(routerEntry);
    expect(window.location.hash).toBe("#/router");
    expect(await screen.findByRole("heading", { level: 1, name: "Router" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(window.location.hash).toBe("");
    expect(await screen.findByRole("navigation", { name: "Conversations" })).toBeInTheDocument();
  });
});

describe("左栏置顶水果刀入口（宽栏 / 72px 窄栏 / 多机去重）", () => {
  it("宽栏与窄栏置顶渲染 KnifeAvatar，副标题与徽标按优先级实时刷新，选中态中性灰不含 --jelly，多设备不再重复渲染左栏 Needs You 分组", async () => {
    const localSnap = makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      projects: [makeProject({ id: 10, name: "agent-hub", pmId: 1, conversationId: 1 })],
      conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, projectId: 10, title: "小林" } })],
      router: {
        ...emptyRouterSlice(),
        items: [makeDecisionItem({ question: "本机拍板问题" }), makeReportItem({ summary: "本机里程碑汇报" })],
      },
    });
    const tokyoGate: TaskGraph = {
      id: 5,
      projectId: 20,
      pmId: 2,
      conversationId: 2,
      title: "远端发布",
      status: "active",
      originMsgId: null,
      nodes: [
        {
          key: "gate-tokyo",
          title: "远端门禁",
          kind: "gate",
          status: "waiting_user",
          sortOrder: 0,
          activeWorkerId: null,
          workerIds: [],
          gateQuestion: "Tokyo 要灰度吗？",
          gateOptions: ["灰度", "全量"],
          gateSummaryMd: "指标平稳",
          gateRecommended: "灰度",
          gateAskMessageId: null,
          decision: null,
          artifact: null,
          createdAt: 30_000,
          updatedAt: 30_000,
        },
      ],
      edges: [],
      createdAt: 30_000,
      updatedAt: 30_000,
      completedAt: null,
    };
    const tokyoSnap = makeSnapshot({
      pms: [makePm({ id: 2, name: "阿青" })],
      projects: [makeProject({ id: 20, name: "tokyo-svc", pmId: 2, conversationId: 2 })],
      conversations: [makeConvSnapshot([], { conversation: { id: 2, pmId: 2, projectId: 20, title: "阿青" } })],
      activeTaskGraphs: [tokyoGate],
    });

    const { localApi } = installFleet({ local: localSnap, tokyo: tokyoSnap });
    const { unmount } = renderWithQuery(<App />);
    await waitFor(() => expect(localApi.callsTo("GET", /^\/api\/state$/).length).toBeGreaterThan(0));
    act(openSockets);

    const aside = await screen.findByRole("complementary");
    const routerBtn = await within(aside).findByRole("button", { name: /Router/ });
    expect(routerBtn).toHaveAttribute("aria-current", "page");
    expect(routerBtn.className).toContain("bg-sidebar-active");
    expect(routerBtn.className).not.toContain("jelly");
    // 2 个跨机待决项（Tokyo gate + 本机 decision），副标题取最新待决问题
    await waitFor(() => expect(within(routerBtn).getByText("Tokyo 要灰度吗？")).toBeInTheDocument());
    expect(within(routerBtn).getByText("2")).toBeInTheDocument();

    // 左栏项目列表不再重复挂顶置 Needs You 区域
    const projectsNav = within(aside).getByRole("navigation", { name: "Conversations" });
    expect(within(projectsNav).queryByRole("region", { name: "Needs You" })).toBeNull();

    unmount();

    // 切到 72px 窄栏：只显示 40px 刀标与右下角绿点 + 分隔短横线
    installViewport("rail");
    renderWithQuery(<App />);
    await waitFor(() => expect(localApi.callsTo("GET", /^\/api\/state$/).length).toBeGreaterThan(1));
    act(openSockets);
    const railAside = await screen.findByRole("complementary");
    const railBtn = await within(railAside).findByRole("button", { name: /Router/ });
    expect(railBtn).toHaveAttribute("aria-current", "page");
    expect(railBtn.querySelector("[data-slot='knife-avatar']")).not.toBeNull();
    expect(railBtn.querySelector(".bg-status-active")).not.toBeNull();
  });
});

describe("RouterWorkbench 四段式行动工作台", () => {
  it("Needs You 拍板卡支持三合一拍板（一键点选乐观隐藏、备注+点选、纯文字回车）、失败回滚保留草稿并报中文错、离线设备灰态禁用且禁止拼接符", async () => {
    const now = Date.now();
    const d1 = makeDecisionItem({
      id: 101,
      question: "接口节流窗口设多少？",
      options: ["(Recommended) 70ms", "150ms"],
      createdAt: now - 60_000,
    });
    const d2 = makeDecisionItem({
      id: 102,
      question: "是否同步更新文档？",
      options: ["立即更新", "下轮再补"],
      createdAt: now - 120_000,
    });
    const d3 = makeDecisionItem({
      id: 103,
      question: "保留多少天历史？",
      options: ["30 天", "90 天"],
      createdAt: now - 180_000,
    });
    const localSnap = makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      projects: [makeProject({ id: 10, name: "agent-hub", pmId: 1, conversationId: 1 })],
      conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, projectId: 10, title: "小林" } })],
      router: { ...emptyRouterSlice(), items: [d1, d2, d3] },
    });
    const tokyoSnap = makeSnapshot({
      pms: [makePm({ id: 2, name: "阿青" })],
      projects: [makeProject({ id: 20, name: "tokyo-api", pmId: 2, conversationId: 2 })],
      conversations: [makeConvSnapshot([], { conversation: { id: 2, pmId: 2, projectId: 20, title: "阿青" } })],
      router: {
        ...emptyRouterSlice(),
        items: [
          makeDecisionItem({
            id: 901,
            pmId: 2,
            projectId: 20,
            conversationId: 2,
            question: "远端离线时的待决卡",
            options: ["方案甲", "方案乙"],
            createdAt: now - 240_000,
          }),
        ],
      },
    });

    const { localApi, setTokyoOffline } = installFleet({ local: localSnap, tokyo: tokyoSnap, tokyoOnline: true });
    let failNext = false;
    localApi.resolveRouterItem = (_id, _body) => {
      if (failNext) {
        failNext = false;
        return { status: 409, body: { error: "该待决项已被其他终端处理", code: "conflict" } };
      }
      return {
        status: 200,
        body: { item: { ...d1, status: "resolved" }, messageId: 501 },
      };
    };

    const user = userEvent.setup();
    renderWithQuery(<App />);
    await screen.findByRole("heading", { level: 1, name: "Router" });
    act(openSockets);

    const needsSection = await screen.findByRole("region", { name: "Needs You" });
    // 禁止出现 · / | / / 拼接分隔符
    expect(needsSection.textContent).not.toMatch(/[·|/]/);

    // 路径 A：一键纯点选秒定（乐观隐藏）
    const card1 = within(needsSection).getByText("接口节流窗口设多少？").closest("article")!;
    expect(within(card1).getByText("Recommended")).toBeInTheDocument();
    await user.click(within(card1).getByRole("button", { name: /70ms/ }));
    expect(within(needsSection).queryByText("接口节流窗口设多少？")).toBeNull();
    expect(localApi.callsTo("POST", /^\/api\/router\/items\/101\/resolve$/)[0]?.body).toMatchObject({
      optionIndex: 0,
    });

    // 路径 B + 失败回滚：输入备注后点击选项，接口报错时卡片回弹且保留输入的备注并显示中文错误
    failNext = true;
    const card2 = within(needsSection).getByText("是否同步更新文档？").closest("article")!;
    const noteInput2 = within(card2).getByPlaceholderText("Add a note, or type a custom reply…");
    await user.type(noteInput2, "补在第 21 节末尾");
    await user.click(within(card2).getByRole("button", { name: /立即更新/ }));
    const restoredCard2 = await within(needsSection).findByText("是否同步更新文档？");
    const restoredArticle2 = restoredCard2.closest("article")!;
    expect(within(restoredArticle2).getByDisplayValue("补在第 21 节末尾")).toBeInTheDocument();
    expect(within(restoredArticle2).getByRole("alert")).toHaveTextContent("该待决项已被其他终端处理");

    // 路径 C：不点选项，纯文字回车提交（optionIndex: null）
    const card3 = within(needsSection).getByText("保留多少天历史？").closest("article")!;
    const noteInput3 = within(card3).getByPlaceholderText("Add a note, or type a custom reply…");
    await user.type(noteInput3, "改成 45 天折中{Enter}");
    await waitFor(() =>
      expect(localApi.callsTo("POST", /^\/api\/router\/items\/103\/resolve$/)[0]?.body).toMatchObject({
        optionIndex: null,
        note: "改成 45 天折中",
      }),
    );

    // 远端设备断线超过 OFFLINE_AFTER_MS：卡片呈 opacity-60 + Offline，按钮禁用；重连恢复后立即可点
    const tokyoWs = FakeWebSocket.instances.find((w) => w.url.includes(`/d/${TOKYO_ID}/`));
    expect(tokyoWs).toBeDefined();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    setTokyoOffline(true);
    act(() => tokyoWs!.drop());
    act(() => void vi.advanceTimersByTime(OFFLINE_AFTER_MS + 1_000));
    vi.useRealTimers();
    const offlineCard = (await within(needsSection).findByText("远端离线时的待决卡")).closest("article")!;
    await waitFor(() => expect(within(offlineCard).getByText("Offline")).toBeInTheDocument());
    expect(offlineCard.className).toContain("opacity-60");
    expect(within(offlineCard).getByRole("button", { name: /方案甲/ })).toBeDisabled();
  });

  it("防重入：同一帧里连点同一张拍板卡只提交一次；失败回执的 Retry 在途时不再重复请求，请求失败就地报错", async () => {
    const decision = makeDecisionItem({ id: 111, question: "连点只算一次？", options: ["好", "不好"], createdAt: Date.now() - 1_000 });
    const failedCmd = makeCommandRecord({ id: 350, clientId: "cmd-failed", status: "failed", error: "规划超时", plan: null, dispatched: null, createdAt: Date.now() - 2_000 });
    const localSnap = makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      projects: [makeProject({ id: 10, name: "agent-hub", pmId: 1, conversationId: 1 })],
      conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, projectId: 10, title: "小林" } })],
      router: { ...emptyRouterSlice(), items: [decision], commands: [failedCmd] },
    });
    const { localApi } = installFleet({ local: localSnap });
    let releaseResolve: (() => void) | null = null;
    localApi.resolveRouterItem = () =>
      new Promise((resolve) => {
        releaseResolve = () => resolve({ status: 200, body: { item: { ...decision, status: "resolved" }, messageId: 502 } });
      });
    let rejectRetry: (() => void) | null = null;
    localApi.retryRouterCommand = () =>
      new Promise((resolve) => {
        rejectRetry = () => resolve({ status: 409, body: { error: "规划器正忙，稍后再试", code: "conflict" } });
      });

    renderWithQuery(<App />);
    await screen.findByRole("heading", { level: 1, name: "Router" });
    act(openSockets);

    const needsSection = await screen.findByRole("region", { name: "Needs You" });
    const option = within(needsSection).getByRole("button", { name: /^A好$/ });
    act(() => {
      fireEvent.click(option);
      fireEvent.click(option);
    });
    await waitFor(() => expect(localApi.callsTo("POST", /^\/api\/router\/items\/111\/resolve$/)).toHaveLength(1));
    await act(async () => releaseResolve!());

    const recent = await screen.findByRole("region", { name: "Recent" });
    const retry = within(recent).getByRole("button", { name: "Retry" });
    act(() => {
      fireEvent.click(retry);
      fireEvent.click(retry);
    });
    await waitFor(() => expect(localApi.callsTo("POST", /^\/api\/router\/commands\/350\/retry$/)).toHaveLength(1));
    expect(within(recent).getByText("Dispatching…")).toBeInTheDocument();
    expect(within(recent).queryByRole("button", { name: "Retry" })).toBeNull();
    await act(async () => rejectRetry!());
    expect(await within(recent).findByText(/规划器正忙，稍后再试/)).toBeInTheDocument();
    expect(within(recent).getByRole("button", { name: "Retry" })).toBeEnabled();
  });

  it("Recent（最多 5 条、流光 Dispatching…、跳转与失败 Retry/Dismiss）、Updates（Done / Archive all / 证据跳转）与 Archived（@tanstack/react-query 按需分页）协同工作", async () => {
    const commands: RouterCommandRecord[] = Array.from({ length: 7 }, (_, idx) =>
      makeCommandRecord({
        id: 300 + idx,
        clientId: `c-${idx}`,
        inputText: `指令 ${idx}`,
        status: idx === 0 ? "planning" : idx === 1 ? "failed" : "dispatched",
        error: idx === 1 ? "模型响应超时，请稍后重试" : null,
        plan:
          idx === 0 || idx === 1
            ? null
            : {
                intent: "dispatch",
                reply: `回执摘要 ${idx}`,
                actions: [
                  {
                    type: "dispatch",
                    deviceId: "local",
                    pmId: 1,
                    message: `指令 ${idx}`,
                    summary: `回执摘要 ${idx}`,
                    risk: "low",
                  },
                ],
              },
        createdAt: 50_000 - idx * 100,
        updatedAt: 50_000 - idx * 100,
      }),
    );
    const r1 = makeReportItem({ id: 201, summary: "汇报一：接口就绪", createdAt: 40_000 });
    const r2 = makeReportItem({ id: 202, summary: "汇报二：单测全绿", links: [], createdAt: 39_000 });

    const localSnap = makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      projects: [makeProject({ id: 10, name: "agent-hub", pmId: 1, conversationId: 1 })],
      conversations: [
        makeConvSnapshot([], { conversation: { id: 1, pmId: 1, projectId: 10, title: "小林" } }),
        makeConvSnapshot([], { conversation: { id: 30, kind: "worker", pmId: 1, projectId: 10, title: "修缓存" } }),
      ],
      router: { ...emptyRouterSlice(), items: [r1, r2], commands },
    });

    const { localApi } = installFleet({ local: localSnap });
    localApi.routerItems = (query) => {
      const cursor = query.get("cursor");
      if (!cursor) {
        return {
          status: 200,
          body: {
            items: [makeReportItem({ id: 501, status: "archived", summary: "归档汇报第 1 页" })],
            nextCursor: "10000:501",
            hasMore: true,
          },
        };
      }
      return {
        status: 200,
        body: {
          items: [makeReportItem({ id: 502, status: "archived", summary: "归档汇报第 2 页" })],
          nextCursor: null,
          hasMore: false,
        },
      };
    };

    const user = userEvent.setup();
    renderWithQuery(<App />);
    await screen.findByRole("heading", { level: 1, name: "Router" });
    act(openSockets);

    // Recent：最多只渲染 ROUTER_VISIBLE_RECEIPTS_MAX（5）条
    const recentSection = await screen.findByRole("region", { name: "Recent" });
    const receiptItems = within(recentSection).getAllByRole("listitem");
    expect(receiptItems).toHaveLength(ROUTER_VISIBLE_RECEIPTS_MAX);
    // 第 0 条 planning 带 .status-shimmer 的 Dispatching…
    const dispatching = within(recentSection).getByText("Dispatching…");
    expect(dispatching).toHaveClass("status-shimmer");
    // 第 1 条 failed 显示中文错误 + Retry / Dismiss
    const failedRow = within(recentSection).getByText("模型响应超时，请稍后重试").closest("li")!;
    await user.click(within(failedRow).getByRole("button", { name: "Retry" }));
    expect(localApi.callsTo("POST", /^\/api\/router\/commands\/301\/retry$/)).toHaveLength(1);
    await user.click(within(failedRow).getByRole("button", { name: "Dismiss" }));
    expect(within(recentSection).queryByText("模型响应超时，请稍后重试")).toBeNull();

    // Updates：单卡 Done 与一键 Archive all，以及 Piece #30 跳转链接
    const updatesSection = screen.getByRole("region", { name: "Updates" });
    expect(within(updatesSection).getByRole("link", { name: "PR #410" })).toHaveAttribute(
      "href",
      "https://github.com/example/agent-hub/pull/410",
    );
    const doneButtons = within(updatesSection).getAllByRole("button", { name: "Done" });
    await user.click(doneButtons[0]!);
    expect(localApi.callsTo("POST", /^\/api\/router\/items\/201\/resolve$/)[0]?.body).toEqual({ action: "archive" });

    await user.click(within(updatesSection).getByRole("button", { name: "Archive all" }));
    expect(localApi.callsTo("POST", /^\/api\/router\/reports\/archive-all$/)).toHaveLength(1);

    // Archived：默认收起不请求，展开后经 react-query 拉第 1 页，点击 Load more 游标拉第 2 页
    expect(localApi.callsTo("GET", /^\/api\/router\/items$/)).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: /Archived/ }));
    expect(await screen.findByText("归档汇报第 1 页")).toBeInTheDocument();
    expect(localApi.callsTo("GET", /^\/api\/router\/items$/)[0]?.query.get("limit")).toBe("30");

    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("归档汇报第 2 页")).toBeInTheDocument();
    expect(localApi.callsTo("GET", /^\/api\/router\/items$/)[1]?.query.get("cursor")).toBe("10000:501");
  });

  it("底部复用 DraftComposer：@ 补全跨设备项目/PM 走零模型直转（postMessage），不带 @ 走自然语言发令（postRouterCommand），切换路由保留草稿", async () => {
    const localSnap = makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      projects: [makeProject({ id: 10, name: "agent-hub", pmId: 1, conversationId: 1 })],
      conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, projectId: 10, title: "小林" } })],
    });
    const tokyoSnap = makeSnapshot({
      pms: [makePm({ id: 2, name: "阿青" })],
      projects: [makeProject({ id: 20, name: "tokyo-core", pmId: 2, conversationId: 2 })],
      conversations: [makeConvSnapshot([], { conversation: { id: 2, pmId: 2, projectId: 20, title: "阿青" } })],
    });

    const { localApi, tokyoApi } = installFleet({ local: localSnap, tokyo: tokyoSnap });
    const user = userEvent.setup();
    renderWithQuery(<App />);
    await screen.findByRole("heading", { level: 1, name: "Router" });
    act(openSockets);

    const input = screen.getByPlaceholderText("Tell Router, or type @ to pick a project…");

    // 1. 输入 @ 唤起跨设备候选菜单，选中远端 tokyo-core，生成胶囊并零模型直转给远端对话 2
    await user.type(input, "@tokyo");
    const menu = await screen.findByRole("listbox");
    await user.click(within(menu).getByRole("option", { name: /tokyo-core/ }));
    // 选中后输入框前挂出目标胶囊，继续输入正文回车直达远端 PM 对话
    await user.type(input, "把健康检查间隔改成 10 秒{Enter}");
    await waitFor(() => expect(tokyoApi!.callsTo("POST", /^\/api\/conversations\/2\/messages$/)).toHaveLength(1));
    expect(tokyoApi!.callsTo("POST", /^\/api\/conversations\/2\/messages$/)[0]?.body).toMatchObject({
      text: "把健康检查间隔改成 10 秒",
    });
    expect(localApi.callsTo("POST", /^\/api\/router\/commands$/)).toHaveLength(0);
    // Recent 立即展示直转回执
    const recent = await screen.findByRole("region", { name: "Recent" });
    expect(within(recent).getByText(/阿青/)).toBeInTheDocument();

    // 2. 不带 @ 直接输入自然语言发令，调用 POST /api/router/commands
    await user.type(input, "帮我看看哪台机器在忙{Enter}");
    await waitFor(() => expect(localApi.callsTo("POST", /^\/api\/router\/commands$/)).toHaveLength(1));
    expect(localApi.callsTo("POST", /^\/api\/router\/commands$/)[0]?.body).toMatchObject({
      text: "帮我看看哪台机器在忙",
    });

    // 3. 在 Router 输入草稿后切去具体 PM 对话再切回 Router，草稿不丢失（drafts.retain 保留 "router"）
    await user.type(input, "未发完的跨项目想法");
    const aside = screen.getByRole("complementary");
    await user.click(within(aside).getByRole("button", { name: /小林/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "小林" })).toBeInTheDocument();
    await user.click(within(aside).getByRole("button", { name: /Router/ }));
    expect(await screen.findByDisplayValue("未发完的跨项目想法")).toBeInTheDocument();
  });
});
