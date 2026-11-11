// Router 工作台 v2（docs/ui-standard.md 第 21 条、docs/router-workbench-v2-design.md）：待拍板托盘 + 指令与简报时间流的端到端行为与守卫测试。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  DEFAULT_AGENT_VENDOR,
  ROUTER_STREAM_PAGE_SIZE,
  emptyRouterSlice,
  type DeviceInfo,
  type RouterCommandRecord,
  type RouterCommandsPage,
  type RouterDecisionItem,
  type RouterReportItem,
  type StateSnapshot,
  type TaskGraph,
} from "../shared/index.ts";
import { App } from "./App.tsx";
import { OFFLINE_AFTER_MS } from "./devices.ts";
import { resetQueryClient } from "./query-client.ts";
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
  makeSession,
  makeSnapshot,
  sessionChange,
} from "./test-utils.ts";

// 渲染次数守卫（第 5.3 节）：时间流组件每画一次调一次 useStickToBottom；每个回合、每条简报每画一次就会重新调一次这里的 Markdown（不是 memo）。
const renders = vi.hoisted(() => ({ stream: 0, markdown: [] as string[] }));
vi.mock("./useStickToBottom.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./useStickToBottom.ts")>();
  return {
    ...mod,
    useStickToBottom: (...args: Parameters<typeof mod.useStickToBottom>) => {
      renders.stream++;
      return mod.useStickToBottom(...args);
    },
  };
});
vi.mock("./components/Markdown.tsx", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./components/Markdown.tsx")>();
  return {
    ...mod,
    Markdown: (props: Parameters<typeof mod.Markdown>[0]) => {
      renders.markdown.push(props.text);
      return createElement(mod.Markdown, props);
    },
  };
});

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
    plan: { intent: "dispatch", reply: "已转给本机（MacBook）的小林", actions: [], track: "A" },
    // 守护进程写进账本的是本机的真实设备编号（UUID），不是网页里的 "local"
    dispatched: [
      {
        deviceId: LOCAL_ID,
        deviceName: "MacBook",
        pmId: 1,
        pmName: "小林",
        projectId: 10,
        projectName: "agent-hub",
        conversationId: 1,
        messageId: 88,
        ok: true,
        op: "pm.forward",
      },
    ],
    error: null,
    durationMs: 420,
    createdAt: Date.now() - 25_000,
    updatedAt: Date.now() - 25_000,
    ...over,
  };
}

/** jsdom 不排版：给滚动区一个可控的 scrollHeight / clientHeight / scrollTop。 */
function fakeLayout(el: HTMLElement, initial: { scrollHeight: number; clientHeight: number }) {
  const box = { ...initial, scrollTop: 0 };
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => box.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => box.clientHeight });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => box.scrollTop,
    set: (v: number) => {
      box.scrollTop = Math.max(0, Math.min(v, box.scrollHeight - box.clientHeight));
    },
  });
  return box;
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
  /** GET /api/router/commands（更早的指令）；不给就回空页。 */
  commandsPage?: (query: URLSearchParams) => RouterCommandsPage;
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

  const commandPageCalls: URLSearchParams[] = [];
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
    if (url.pathname === "/api/router/commands" && (init?.method ?? "GET") === "GET") {
      commandPageCalls.push(url.searchParams);
      const page = opts.commandsPage?.(url.searchParams) ?? { commands: [], nextCursor: null, hasMore: false };
      return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
    }
    return localApi.fetch(input, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    localApi,
    tokyoApi,
    fetchMock,
    commandPageCalls,
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

/** 入口本机的那条 WebSocket（别的设备的地址带 /d/<设备编号>/）。 */
function localSocket(): FakeWebSocket {
  const ws = FakeWebSocket.instances.findLast((w) => !w.url.includes("/d/"));
  if (!ws) throw new Error("还没有入口本机的 WebSocket");
  return ws;
}

async function openRouter() {
  const view = renderWithQuery(<App />);
  await screen.findByRole("heading", { level: 1, name: "Router" });
  act(openSockets);
  return view;
}

const timeline = () => screen.getByRole("log", { name: "Router timeline" });
/** 时间流里的回合（一条指令一个）。 */
const turns = () => [...timeline().querySelectorAll<HTMLElement>("[data-router-turn]")];
const turnOf = (text: string) => {
  const turn = turns().find((t) => t.querySelector("[data-bubble]")?.textContent === text);
  if (!turn) throw new Error(`时间流里没有这条指令：${text}`);
  return turn;
};

beforeEach(() => {
  resetQueryClient();
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
  it("电脑外壳空 hash 默认 replace 到 #/router，呈现纯白碳黑中性调、无右栏，全空时居中展示 All clear、不渲染 Needs You 托盘", async () => {
    const { localApi } = installFleet({});
    const beforeLen = window.history.length;
    const { container } = renderWithQuery(<App />);
    await waitFor(() => expect(localApi.callsTo("GET", /^\/api\/state$/).length).toBeGreaterThan(0));
    act(openSockets);

    expect(await screen.findByRole("heading", { level: 1, name: "Router" })).toBeInTheDocument();
    await waitFor(() => expect(window.location.hash).toBe("#/router"));
    expect(window.history.length).toBe(beforeLen);

    // 什么都没有：没有气泡、没有右栏；没有待拍板项时托盘整块不渲染，不留标题
    expect(container.querySelector("[class*='bubble-']")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Pieces" })).toBeNull();
    expect(screen.queryByText("Needs You")).toBeNull();
    expect(screen.queryByRole("region", { name: "Needs You" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Load earlier" })).toBeNull();

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
    // 390px 宽放不下长的那句：换短句，不缩字号
    expect(screen.getByPlaceholderText("Tell Router…")).toBeInTheDocument();

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

describe("Needs You 托盘", () => {
  it("第一张完整展开、其余收成一行；三合一拍板、失败回滚保留草稿、拍掉一张下一张自动展开、点一行换它展开、离线设备灰态禁用，不用拼接符", async () => {
    const now = Date.now();
    const d1 = makeDecisionItem({ id: 101, question: "接口节流窗口设多少？", options: ["(Recommended) 70ms", "150ms"], createdAt: now - 60_000 });
    const d2 = makeDecisionItem({ id: 102, question: "是否同步更新文档？", options: ["立即更新", "下轮再补"], createdAt: now - 120_000 });
    const d3 = makeDecisionItem({ id: 103, question: "保留多少天历史？", options: ["30 天", "90 天"], createdAt: now - 180_000 });
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
        items: [makeDecisionItem({ id: 901, pmId: 2, projectId: 20, conversationId: 2, question: "远端离线时的待决卡", options: ["方案甲", "方案乙"], createdAt: now - 240_000 })],
      },
    });

    const { localApi, setTokyoOffline } = installFleet({ local: localSnap, tokyo: tokyoSnap, tokyoOnline: true });
    let failNext = false;
    localApi.resolveRouterItem = (_id, _body) => {
      if (failNext) {
        failNext = false;
        return { status: 409, body: { error: "该待决项已被其他终端处理", code: "conflict" } };
      }
      return { status: 200, body: { item: { ...d1, status: "resolved" }, messageId: 501 } };
    };

    const user = userEvent.setup();
    await openRouter();

    const tray = await screen.findByRole("region", { name: "Needs You" });
    await waitFor(() => expect(within(tray).getByText("远端离线时的待决卡")).toBeInTheDocument());
    // 禁止出现 · / | / / 拼接分隔符
    expect(tray.textContent).not.toMatch(/[·|/]/);
    // 数量在托盘标题上，顶栏不再重复
    expect(within(tray).getByRole("button", { name: /Needs You/ })).toHaveTextContent("4");
    expect(screen.getByRole("heading", { level: 1, name: "Router" }).closest("header")!.textContent).toBe("Router");
    // 托盘和时间流、输入框左右对齐，最高半屏，超出在里面滚
    expect(tray.className).toMatch(/chat-column/);
    expect(tray.querySelector("[class*='max-h-[50dvh]']")).not.toBeNull();

    // 只有第一张是卡片，其余每张一行（问题第一行截断，全文在 title）
    expect(tray.querySelectorAll("article")).toHaveLength(1);
    const rows = within(tray).getAllByRole("button", { expanded: false });
    expect(rows.map((r) => r.querySelector("[title]")?.getAttribute("title"))).toEqual(["是否同步更新文档？", "保留多少天历史？", "远端离线时的待决卡"]);
    expect(rows[0]!.className).toContain("pointer-coarse:min-h-11");
    expect(rows[0]!.querySelector(".truncate")).toHaveTextContent("是否同步更新文档？");
    expect(within(tray).queryByRole("button", { name: "Show more" })).toBeNull();

    // 路径 A：一键纯点选秒定（乐观隐藏），下一张自动展开
    const card1 = within(tray).getByText("接口节流窗口设多少？").closest("article")!;
    expect(within(card1).getByText("Recommended")).toBeInTheDocument();
    await user.click(within(card1).getByRole("button", { name: /70ms/ }));
    expect(within(tray).queryByText("接口节流窗口设多少？")).toBeNull();
    expect(localApi.callsTo("POST", /^\/api\/router\/items\/101\/resolve$/)[0]?.body).toMatchObject({ optionIndex: 0 });
    const card2 = within(tray).getByText("是否同步更新文档？").closest("article")!;
    expect(card2).not.toBeNull();
    expect(tray.querySelectorAll("article")).toHaveLength(1);

    // 路径 B + 失败回滚：输入备注后点击选项，接口报错时卡片回弹且保留输入的备注并显示中文错误
    failNext = true;
    await user.type(within(card2).getByPlaceholderText("Add a note, or type a custom reply…"), "补在第 21 节末尾");
    await user.click(within(card2).getByRole("button", { name: /立即更新/ }));
    await waitFor(() => expect(within(tray).getByRole("alert")).toHaveTextContent("该待决项已被其他终端处理"));
    const restored = within(tray).getByText("是否同步更新文档？").closest("article")!;
    expect(within(restored).getByDisplayValue("补在第 21 节末尾")).toBeInTheDocument();

    // 点一行换它展开（同时只有一张卡）；路径 C：不点选项，纯文字回车提交（optionIndex: null）
    await user.click(within(tray).getByRole("button", { name: /保留多少天历史？/ }));
    expect(tray.querySelectorAll("article")).toHaveLength(1);
    const card3 = within(tray).getByText("保留多少天历史？").closest("article")!;
    await user.type(within(card3).getByPlaceholderText("Add a note, or type a custom reply…"), "改成 45 天折中{Enter}");
    await waitFor(() =>
      expect(localApi.callsTo("POST", /^\/api\/router\/items\/103\/resolve$/)[0]?.body).toMatchObject({ optionIndex: null, note: "改成 45 天折中" }),
    );

    // 远端设备断线超过 OFFLINE_AFTER_MS：那一行变淡；点开是 opacity-60 + Offline 的卡，按钮禁用
    const tokyoWs = FakeWebSocket.instances.find((w) => w.url.includes(`/d/${TOKYO_ID}/`));
    expect(tokyoWs).toBeDefined();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    setTokyoOffline(true);
    act(() => tokyoWs!.drop());
    act(() => void vi.advanceTimersByTime(OFFLINE_AFTER_MS + 1_000));
    vi.useRealTimers();
    await waitFor(() => expect(within(tray).getByRole("button", { name: /远端离线时的待决卡/ }).className).toContain("opacity-60"));
    await user.click(within(tray).getByRole("button", { name: /远端离线时的待决卡/ }));
    const offlineCard = within(tray).getByText("远端离线时的待决卡").closest("article")!;
    expect(within(offlineCard).getByText("Offline")).toBeInTheDocument();
    expect(offlineCard.className).toContain("opacity-60");
    expect(within(offlineCard).getByRole("button", { name: /方案甲/ })).toBeDisabled();
  });

  it("收起的行超过 3 条出 Show more；标题整行可点收起，收起后时间流照常；防重入：同一帧连点同一张卡只提交一次", async () => {
    const now = Date.now();
    const decisions = Array.from({ length: 6 }, (_, i) => makeDecisionItem({ id: 111 + i, question: `第 ${i + 1} 个问题`, options: ["好", "不好"], createdAt: now - (i + 1) * 1_000 }));
    const localSnap = makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      projects: [makeProject({ id: 10, name: "agent-hub", pmId: 1, conversationId: 1 })],
      conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, projectId: 10, title: "小林" } })],
      router: { ...emptyRouterSlice(), items: decisions, commands: [makeCommandRecord()] },
    });
    const { localApi } = installFleet({ local: localSnap });
    let releaseResolve: (() => void) | null = null;
    localApi.resolveRouterItem = () =>
      new Promise((resolve) => {
        releaseResolve = () => resolve({ status: 200, body: { item: { ...decisions[0]!, status: "resolved" }, messageId: 502 } });
      });
    const user = userEvent.setup();
    await openRouter();

    const tray = await screen.findByRole("region", { name: "Needs You" });
    expect(tray.querySelectorAll("article")).toHaveLength(1);
    expect(within(tray).getAllByRole("button", { expanded: false }).filter((b) => /个问题/.test(b.textContent ?? ""))).toHaveLength(3);
    await user.click(within(tray).getByRole("button", { name: "Show more" }));
    expect(within(tray).getAllByRole("button", { expanded: false }).filter((b) => /个问题/.test(b.textContent ?? ""))).toHaveLength(5);
    expect(within(tray).getByRole("button", { name: "Show less" })).toBeInTheDocument();

    // 收起托盘：只剩标题一行，时间流和输入框都在
    const title = within(tray).getByRole("button", { name: /Needs You/ });
    expect(title).toHaveAttribute("aria-expanded", "true");
    await user.click(title);
    expect(title).toHaveAttribute("aria-expanded", "false");
    expect(tray.querySelector("article")).toBeNull();
    expect(turnOf("让小林检查一下缓存上限")).toBeInTheDocument();
    await user.click(title);

    const option = within(tray.querySelector("article")!).getByRole("button", { name: /^A好$/ });
    act(() => {
      fireEvent.click(option);
      fireEvent.click(option);
    });
    await waitFor(() => expect(localApi.callsTo("POST", /^\/api\/router\/items\/111\/resolve$/)).toHaveLength(1));
    await act(async () => releaseResolve!());
  });
});

describe("时间流：指令回合", () => {
  it("回答用 Markdown 完整渲染（**加粗** 是 <strong>、全文在 DOM 里、不截断），用户原话在右边的气泡里；没有 Dismiss、关闭键和通知式分区", async () => {
    const longTail = `结尾标记-${"很长的回答".repeat(120)}`;
    const answered = makeCommandRecord({
      id: 310,
      clientId: "c-answer",
      inputText: "现在谁在干活？",
      status: "answered",
      plan: { intent: "answer", reply: `目前没有正在干活的 PM。\n\n**本机（MacBook）**\n\n- 小林（agent-hub）：空闲\n\n${longTail}`, actions: [], track: "B" },
      dispatched: null,
    });
    const truncated = makeCommandRecord({
      id: 311,
      clientId: "c-truncated",
      inputText: "把所有项目的状态都列出来",
      status: "answered",
      plan: { intent: "answer", reply: "太长被截了", actions: [], track: "B", replyTruncated: true },
      dispatched: null,
      createdAt: Date.now() - 10_000,
    });
    const localSnap = makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      projects: [makeProject({ id: 10, name: "agent-hub", pmId: 1, conversationId: 1 })],
      conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, projectId: 10, title: "小林" } })],
      router: { ...emptyRouterSlice(), commands: [truncated, answered] },
    });
    installFleet({ local: localSnap });
    await openRouter();

    const turn = await waitFor(() => turnOf("现在谁在干活？"));
    // 用户说的话：靠右的气泡，和项目经理对话里的用户气泡同一套
    const bubble = turn.querySelector("[data-bubble]")!;
    expect(bubble.className).toContain("bg-bubble-me");
    expect(bubble.className).toContain("rounded-[22px]");
    expect(bubble.closest("[data-side='right']")).not.toBeNull();
    // 总助的结果：水果刀头像 + Router，Markdown 全文
    expect(within(turn).getByText("Router")).toBeInTheDocument();
    expect(turn.querySelector("[data-slot='knife-avatar']")).not.toBeNull();
    const reply = turn.querySelector(".markdown")!;
    expect(reply.querySelector("strong")).toHaveTextContent("本机（MacBook）");
    expect(reply.textContent).not.toContain("**");
    expect(reply.querySelector("li")).toHaveTextContent("小林（agent-hub）：空闲");
    expect(reply.textContent).toContain(longTail);
    expect(reply.closest(".truncate, [class*='line-clamp']")).toBeNull();
    expect(reply.querySelector(".truncate, [class*='line-clamp']")).toBeNull();
    expect(within(turn).getByRole("button", { name: "Copy" })).toBeInTheDocument();
    // 回合没有外框和底色
    expect(turn.className).not.toMatch(/border|bg-sidebar|rounded-2xl/);

    expect(within(turnOf("把所有项目的状态都列出来")).getByText("Reply truncated")).toHaveClass("text-muted-foreground");
    expect(within(turn).queryByText("Reply truncated")).toBeNull();

    // 通知式的家务都没了
    for (const name of ["Dismiss", "Done", "Archive all", "Close", "Retry"]) expect(screen.queryByRole("button", { name })).toBeNull();
    for (const word of ["Recent", "Updates", "Archived", "Dispatching…", "Needs You"]) expect(screen.queryByText(word)).toBeNull();
    expect(within(timeline()).queryByText("All clear")).toBeNull();
  });

  it("去向行直接用分派记录里的对话编号：本机真实设备编号（UUID）的分派点了进项目经理对话，Piece 进 Piece 对话，远端进那台设备；轨道 A 成功不画冗余回复", async () => {
    const now = Date.now();
    const toPm = makeCommandRecord({ id: 311, clientId: "c-pm", createdAt: now - 30_000 });
    const toPiece = makeCommandRecord({
      id: 312,
      clientId: "c-piece",
      inputText: "开个 Piece 查慢测",
      plan: { intent: "dispatch", reply: "先查 CI 缓存，再看并发数。", actions: [], track: "B" },
      dispatched: [
        { deviceId: LOCAL_ID, deviceName: "MacBook", pmId: 1, pmName: "小林", projectId: 10, projectName: "agent-hub", workerId: 7, workerConversationId: 30, title: "排查 vitest 慢测", messageId: 90, ok: true, op: "worker.start" },
        { deviceId: LOCAL_ID, deviceName: "MacBook", pmId: 1, messageId: 0, ok: false, error: "没投出去", op: "pm.forward" },
      ],
      createdAt: now - 20_000,
    });
    const toTokyo = makeCommandRecord({
      id: 313,
      clientId: "c-tokyo",
      inputText: "让阿青回滚",
      dispatched: [{ deviceId: TOKYO_ID, deviceName: "Tokyo", pmId: 2, pmName: "阿青", projectId: 20, projectName: "tokyo-svc", conversationId: 2, messageId: 91, ok: true, op: "pm.forward" }],
      createdAt: now - 10_000,
    });
    const tokyoSnap = makeSnapshot({
      pms: [makePm({ id: 2, name: "阿青" })],
      projects: [makeProject({ id: 20, name: "tokyo-svc", pmId: 2, conversationId: 2 })],
      conversations: [makeConvSnapshot([], { conversation: { id: 2, pmId: 2, projectId: 20, title: "阿青" } })],
    });
    const localSnap = makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      projects: [makeProject({ id: 10, name: "agent-hub", pmId: 1, conversationId: 1 })],
      conversations: [
        makeConvSnapshot([], { conversation: { id: 1, pmId: 1, projectId: 10, title: "小林" } }),
        makeConvSnapshot([], { conversation: { id: 30, kind: "worker", pmId: 1, projectId: 10, title: "排查 vitest 慢测" } }),
      ],
      router: { ...emptyRouterSlice(), commands: [toTokyo, toPiece, toPm] },
    });
    installFleet({ local: localSnap, tokyo: tokyoSnap });
    const user = userEvent.setup();
    await openRouter();
    const backToRouter = () => user.click(within(screen.getByRole("complementary", { name: "Sidebar" })).getByRole("button", { name: /Router/ }));

    // 按时间从上到下
    await waitFor(() => expect(turns().map((t) => t.querySelector("[data-bubble]")!.textContent)).toEqual(["让小林检查一下缓存上限", "开个 Piece 查慢测", "让阿青回滚"]));

    // 项目经理：整行是一个按钮，名字、项目名、设备名用间距隔开，不用拼接符
    const pmTurn = turnOf("让小林检查一下缓存上限");
    const pmRow = within(pmTurn).getByRole("button", { name: /小林/ });
    expect(pmRow).toHaveTextContent("agent-hub");
    expect(pmRow).toHaveTextContent("MacBook");
    expect(pmRow.textContent).not.toMatch(/[·|/]/);
    expect(pmRow.className).toContain("pointer-coarse:min-h-11");
    expect(pmRow.className).toContain("hover:bg-jelly-hover");
    // 轨道 A 成功：回执那句话和去向行重复，不画；也就没有复制键
    expect(within(pmTurn).queryByText(/已转给本机/)).toBeNull();
    expect(within(pmTurn).queryByRole("button", { name: "Copy" })).toBeNull();
    await user.click(pmRow);
    expect(window.location.hash).toBe("#/c/1");
    await backToRouter();

    // Piece：果瓣头像、标题、状态词；没投出去的目标不画行；轨道 B 的补充说明照常是 Markdown
    const pieceTurn = turnOf("开个 Piece 查慢测");
    const rows = within(pieceTurn).getAllByRole("button").filter((b) => b.hasAttribute("data-destination"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("排查 vitest 慢测");
    expect(rows[0]).toHaveTextContent("Started");
    expect(rows[0]!.querySelector("[data-neutral='true']")).not.toBeNull();
    expect(within(pieceTurn).getByText("先查 CI 缓存，再看并发数。")).toBeInTheDocument();
    await user.click(rows[0]!);
    expect(window.location.hash).toBe("#/w/30");
    await backToRouter();

    // 远端设备
    await user.click(within(turnOf("让阿青回滚")).getByRole("button", { name: /阿青/ }));
    expect(window.location.hash).toBe(`#/d/${TOKYO_ID}/c/2`);
  });

  it("失败回合留在时间流里：人话原因（原文在 title）+ Retry，点了回到 Working…、不新开回合，连点只发一次，请求失败就地报错；已有目标成功又没有明确失败项的不给 Retry", async () => {
    const now = Date.now();
    const failed = makeCommandRecord({
      id: 350,
      clientId: "c-failed",
      inputText: "把刚才那个停掉",
      status: "failed",
      error: "总助这次没能完成，请重试",
      plan: { intent: "ambiguous", reply: "", actions: [], track: "B", errorRaw: "session_ended: session 512 has been ended" },
      dispatched: null,
      createdAt: now - 20_000,
    });
    const partial = makeCommandRecord({
      id: 351,
      clientId: "c-partial",
      inputText: "两个项目都说一声",
      status: "failed",
      error: "还有没交代到的请重新发一条",
      plan: { intent: "dispatch", reply: "", actions: [], track: "B" },
      createdAt: now - 10_000,
    });
    const localSnap = makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      projects: [makeProject({ id: 10, name: "agent-hub", pmId: 1, conversationId: 1 })],
      conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, projectId: 10, title: "小林" } })],
      router: { ...emptyRouterSlice(), commands: [partial, failed] },
    });
    const { localApi } = installFleet({ local: localSnap });
    let settleRetry: ((reply: { status: number; body: unknown }) => void) | null = null;
    localApi.retryRouterCommand = () =>
      new Promise((resolve) => {
        settleRetry = resolve;
      });
    await openRouter();

    const turn = await waitFor(() => turnOf("把刚才那个停掉"));
    expect(turn).toHaveAttribute("data-status", "failed");
    const reason = within(turn).getByText("总助这次没能完成，请重试");
    expect(reason).toHaveAttribute("title", "session_ended: session 512 has been ended");
    expect(reason.className).toContain("text-minor");
    expect(turn.querySelector("svg.text-danger")).not.toBeNull();
    expect(within(turn).queryByRole("button", { name: "Dismiss" })).toBeNull();

    // 已成功的去向行照常；这种情况不给 Retry
    const partialTurn = turnOf("两个项目都说一声");
    expect(within(partialTurn).getByRole("button", { name: /小林/ })).toBeInTheDocument();
    expect(within(partialTurn).getByText("还有没交代到的请重新发一条")).toBeInTheDocument();
    expect(within(partialTurn).queryByRole("button", { name: "Retry" })).toBeNull();

    const retry = within(turn).getByRole("button", { name: "Retry" });
    act(() => {
      fireEvent.click(retry);
      fireEvent.click(retry);
    });
    await waitFor(() => expect(localApi.callsTo("POST", /^\/api\/router\/commands\/350\/retry$/)).toHaveLength(1));
    expect(within(turn).getByText("Working…")).toHaveClass("status-shimmer");
    expect(within(turn).queryByRole("button", { name: "Retry" })).toBeNull();
    expect(turns()).toHaveLength(2);

    // 重试请求本身失败（规划器正忙）：就地报错，还能再点
    await act(async () => settleRetry!({ status: 409, body: { error: "规划器正忙，稍后再试", code: "conflict" } }));
    expect(await within(turn).findByText(/规划器正忙，稍后再试/)).toBeInTheDocument();
    expect(within(turn).getByRole("button", { name: "Retry" })).toBeEnabled();

    // 再点一次成功：服务端把这一行改回 planning，再改成 answered，同一个回合原地更新
    fireEvent.click(within(turn).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(localApi.callsTo("POST", /^\/api\/router\/commands\/350\/retry$/)).toHaveLength(2));
    await act(async () => settleRetry!({ status: 200, body: { command: { ...failed, status: "planning", error: null } } }));
    expect(within(turn).getByText("Working…")).toBeInTheDocument();
    act(() => localSocket().push(changeOf(11, "router.command.updated", { command: { ...failed, status: "planning", error: null, updatedAt: now } })));
    expect(within(turn).getByText("Working…")).toBeInTheDocument();
    act(() =>
      localSocket().push(
        changeOf(12, "router.command.updated", {
          command: { ...failed, status: "answered", error: null, plan: { intent: "answer", reply: "已经停掉了。", actions: [], track: "B" }, updatedAt: now },
        }),
      ),
    );
    expect(await within(turn).findByText("已经停掉了。")).toBeInTheDocument();
    expect(within(turn).queryByText("Working…")).toBeNull();
    expect(turns()).toHaveLength(2);
  });

  it("底部复用 DraftComposer：@ 选了目标也走 postRouterCommand 并带 target（不再直接发到目标对话），不带 @ 走自然语言发令；发出去立刻有气泡，切换路由保留草稿", async () => {
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
    await openRouter();
    const commandCalls = () => localApi.callsTo("POST", /^\/api\/router\/commands$/);

    const input = screen.getByPlaceholderText("Tell Router, or type @ to pick a project…");

    // 1. 输入 @ 唤起跨设备候选菜单，选中远端 tokyo-core：指令经入口本机的 /api/router/commands 落库，带显式目标
    await user.type(input, "@tokyo");
    await user.click(within(await screen.findByRole("listbox")).getByRole("option", { name: /tokyo-core/ }));
    await user.type(input, "把健康检查间隔改成 10 秒{Enter}");
    await waitFor(() => expect(commandCalls()).toHaveLength(1));
    expect(commandCalls()[0]?.body).toMatchObject({ text: "把健康检查间隔改成 10 秒", target: { deviceId: TOKYO_ID, pmId: 2, projectId: 20 } });
    expect((commandCalls()[0]?.body as { clientId: string }).clientId).not.toBe("");
    expect(tokyoApi!.callsTo("POST", /^\/api\/conversations\/2\/messages$/)).toHaveLength(0);
    // 时间流里立刻有自己的气泡；服务端确认后是 Working…
    const sent = await waitFor(() => turnOf("把健康检查间隔改成 10 秒"));
    expect(await within(sent).findByText("Working…")).toHaveClass("status-shimmer");
    // 目标胶囊用完就收起
    expect(screen.queryByRole("button", { name: /Remove target/ })).toBeNull();

    // 2. 本机目标不写设备（守护进程按本机处理）
    await user.type(input, "@agent");
    await user.click(within(await screen.findByRole("listbox")).getByRole("option", { name: /agent-hub/ }));
    await user.type(input, "跑一遍全量测试{Enter}");
    await waitFor(() => expect(commandCalls()).toHaveLength(2));
    expect((commandCalls()[1]?.body as { target: unknown }).target).toEqual({ pmId: 1, projectId: 10 });

    // 3. 不带 @ 直接输入自然语言发令：没有 target
    await user.type(input, "帮我看看哪台机器在忙{Enter}");
    await waitFor(() => expect(commandCalls()).toHaveLength(3));
    expect(commandCalls()[2]?.body).toMatchObject({ text: "帮我看看哪台机器在忙" });
    expect(commandCalls()[2]?.body).not.toHaveProperty("target");
    expect(turns().map((t) => t.querySelector("[data-bubble]")!.textContent)).toEqual(["把健康检查间隔改成 10 秒", "跑一遍全量测试", "帮我看看哪台机器在忙"]);

    // 4. 在 Router 输入草稿后切去具体 PM 对话再切回 Router，草稿不丢失
    await user.type(input, "未发完的跨项目想法");
    const aside = screen.getByRole("complementary");
    await user.click(within(aside).getByRole("button", { name: /小林/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "小林" })).toBeInTheDocument();
    await user.click(within(aside).getByRole("button", { name: /Router/ }));
    expect(await screen.findByDisplayValue("未发完的跨项目想法")).toBeInTheDocument();
  });

  it("没确认的发送放在 react-query 的 mutation 缓存里：切到别的对话再回来还在；发送中不写状态字，没发出去是气泡左边的红色感叹号，点了用同一个 clientId 重发", async () => {
    const { localApi } = installFleet({});
    const user = userEvent.setup();
    await openRouter();
    const aside = screen.getByRole("complementary");
    const leaveAndComeBack = async () => {
      await user.click(within(aside).getByRole("button", { name: /小林/ }));
      expect(await screen.findByRole("heading", { level: 1, name: "小林" })).toBeInTheDocument();
      await user.click(within(aside).getByRole("button", { name: /Router/ }));
      await screen.findByRole("heading", { level: 1, name: "Router" });
    };
    const commandCalls = () => localApi.callsTo("POST", /^\/api\/router\/commands$/);
    const planning = (clientId: string, text: string, id: number): RouterCommandRecord =>
      makeCommandRecord({ id, clientId, inputText: text, status: "planning", plan: null, dispatched: null, createdAt: Date.now(), updatedAt: Date.now() });

    // 在途：请求还没回来
    let release: (() => void) | null = null;
    localApi.postRouterCommand = (body) =>
      new Promise((resolve) => {
        release = () => resolve({ status: 200, body: { command: planning(body.clientId, body.text, 801) } });
      });
    const input = () => screen.getByPlaceholderText("Tell Router, or type @ to pick a project…");
    await user.type(input(), "在途的指令{Enter}");
    await waitFor(() => expect(commandCalls()).toHaveLength(1));
    let turn = turnOf("在途的指令");
    expect(turn).toHaveAttribute("data-status", "sending");
    expect(within(turn).queryByText("Working…")).toBeNull();
    expect(turn.querySelector("[data-unsent]")).toBeNull();
    expect(within(timeline()).queryByText("All clear")).toBeNull();

    await leaveAndComeBack();
    turn = turnOf("在途的指令");
    expect(turn).toHaveAttribute("data-status", "sending");
    await act(async () => release!());
    expect(await within(turnOf("在途的指令")).findByText("Working…")).toBeInTheDocument();

    // 没发出去：红色感叹号，切走再回来还在
    localApi.postRouterCommand = () => ({ status: 503, body: { error: "守护进程暂时不可用", code: "unavailable" } });
    await user.type(input(), "发不出去的指令{Enter}");
    await waitFor(() => expect(commandCalls()).toHaveLength(2));
    const failedClientId = (commandCalls()[1]!.body as { clientId: string }).clientId;
    expect(await within(turnOf("发不出去的指令")).findByRole("button", { name: "没发出去，点击重发" })).toBeInTheDocument();
    // 文字不退回输入框（发送被拦才留在输入框里）
    expect(input()).toHaveValue("");
    await leaveAndComeBack();
    const unsent = within(turnOf("发不出去的指令")).getByRole("button", { name: "没发出去，点击重发" });

    // 重发：同一个 clientId（router_commands.client_id 唯一，服务端命中就返回已有记录）
    localApi.postRouterCommand = (body) => ({ status: 200, body: { command: planning(body.clientId, body.text, 802) } });
    await user.click(unsent);
    await waitFor(() => expect(commandCalls()).toHaveLength(3));
    expect((commandCalls()[2]!.body as { clientId: string }).clientId).toBe(failedClientId);
    await waitFor(() => expect(turnOf("发不出去的指令").querySelector("[data-unsent]")).toBeNull());
    expect(turns().filter((t) => t.querySelector("[data-bubble]")?.textContent === "发不出去的指令")).toHaveLength(1);

    // 服务端的行到了近窗：以它为准，同一个回合原地更新，不多出一个
    act(() =>
      localSocket().push(
        changeOf(11, "router.command.created", {
          command: { ...planning(failedClientId, "发不出去的指令", 802), status: "answered", plan: { intent: "answer", reply: "收到。", actions: [], track: "B" } },
        }),
      ),
    );
    expect(await within(turnOf("发不出去的指令")).findByText("收到。")).toBeInTheDocument();
    expect(turns().filter((t) => t.querySelector("[data-bubble]")?.textContent === "发不出去的指令")).toHaveLength(1);
  });
});

describe("时间流：简报、已读、贴底和历史", () => {
  it("简报是安静的条目：Markdown 正文、可点的名字、连着几条同一个项目经理只有第一条带头像；打开就标已读（按未读集合去重、每台在线设备一次），New 分隔线冻结在最早一条未读上面", async () => {
    const now = Date.now();
    const read = makeReportItem({ id: 201, status: "archived", summary: "旧简报：上周已经看过", links: [], createdAt: now - 50_000 });
    const unread1 = makeReportItem({
      id: 202,
      summary: "PR #398 **已合并**，回归全绿",
      links: [
        { label: "PR #398", target: "https://github.com/example/agent-hub/pull/398" },
        { label: "Piece #30", target: "worker:30" },
        { label: "回归报告", target: "/Users/me/agent-hub/report.md" },
      ],
      createdAt: now - 40_000,
    });
    const unread2 = makeReportItem({ id: 203, summary: "第二条未读", links: [], createdAt: now - 30_000 });
    const localSnap = makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      projects: [makeProject({ id: 10, name: "agent-hub", pmId: 1, conversationId: 1 })],
      conversations: [
        makeConvSnapshot([], { conversation: { id: 1, pmId: 1, projectId: 10, title: "小林" } }),
        makeConvSnapshot([], { conversation: { id: 30, kind: "worker", pmId: 1, projectId: 10, title: "修缓存" } }),
      ],
      router: { ...emptyRouterSlice(), items: [unread2, unread1, read] },
    });
    const tokyoSnap = makeSnapshot({
      pms: [makePm({ id: 2, name: "阿青" })],
      projects: [makeProject({ id: 20, name: "tokyo-svc", pmId: 2, conversationId: 2 })],
      conversations: [makeConvSnapshot([], { conversation: { id: 2, pmId: 2, projectId: 20, title: "阿青" } })],
      router: { ...emptyRouterSlice(), items: [makeReportItem({ id: 301, pmId: 2, projectId: 20, conversationId: 2, summary: "Tokyo 部署完成", links: [], createdAt: now - 20_000 })] },
    });
    const { localApi, tokyoApi } = installFleet({ local: localSnap, tokyo: tokyoSnap });
    const user = userEvent.setup();
    await openRouter();
    const archiveCalls = (api: FakeApi) => api.callsTo("POST", /^\/api\/router\/reports\/archive-all$/);

    const briefings = () => [...timeline().querySelectorAll<HTMLElement>("[data-router-briefing]")];
    await waitFor(() => expect(briefings().map((b) => b.querySelector(".markdown")!.textContent)).toEqual(["旧简报：上周已经看过", "PR #398 已合并，回归全绿", "第二条未读", "Tokyo 部署完成"]));

    // 没有容器、没有 Done
    expect(briefings()[1]!.className).not.toMatch(/border|bg-sidebar|bg-background|rounded-2xl/);
    expect(briefings()[1]!.querySelector("strong")).toHaveTextContent("已合并");
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive all" })).toBeNull();

    // 同一个项目经理连着三条：只有第一条带头像和名字；换了项目经理（另一台设备）重新带，后面是项目名、设备名
    expect(within(timeline()).getAllByRole("button", { name: "小林" })).toHaveLength(1);
    expect(briefings()[0]!.querySelector("[data-slot='agent-head']")).not.toBeNull();
    expect(briefings()[1]!.querySelector("[data-slot='agent-head']")).toBeNull();
    const tokyoHead = briefings()[3]!.querySelector("[data-slot='agent-head']")!;
    expect(tokyoHead).toHaveTextContent("阿青");
    expect(tokyoHead).toHaveTextContent("tokyo-svc");
    expect(tokyoHead).toHaveTextContent("Tokyo");
    expect(tokyoHead.textContent).not.toMatch(/[·|/]/);

    // 链接：外链是普通行内链接（带图标，不用胶囊）；worker:N 可点；文件路径没有可预览的副本，画成普通文字
    const external = within(briefings()[1]!).getByRole("link", { name: /PR #398/ });
    expect(external).toHaveAttribute("href", "https://github.com/example/agent-hub/pull/398");
    expect(external).toHaveAttribute("target", "_blank");
    expect(external.className).not.toMatch(/rounded-full|bg-sidebar/);
    expect(external.querySelector("svg")).not.toBeNull();
    const fileLabel = within(briefings()[1]!).getByText("回归报告");
    expect(fileLabel.closest("a, button")).toBeNull();

    // 看到就算已读：每台有未读简报的在线设备各调一次 archive-all
    await waitFor(() => expect(archiveCalls(localApi)).toHaveLength(1));
    await waitFor(() => expect(archiveCalls(tokyoApi!)).toHaveLength(1));
    // New 分隔线在最早一条未读上面
    const dividers = () => [...timeline().querySelectorAll("[data-new-divider]")];
    expect(dividers()).toHaveLength(1);
    expect(dividers()[0]).toHaveTextContent("New");
    expect(dividers()[0]!.closest("[data-stream-entry]")).toContainElement(briefings()[1]!);

    // 标成已读之后：简报留在时间流里，分隔线不动，也不重复发请求
    act(() => localSocket().push(changeOf(11, "router.reports.archived_all", { archivedIds: [202, 203], updatedAt: now })));
    expect(briefings()).toHaveLength(4);
    expect(dividers()[0]!.closest("[data-stream-entry]")).toContainElement(briefings()[1]!);
    expect(archiveCalls(localApi)).toHaveLength(1);

    // 工作台开着时进来的新简报：直接出现在底部并标已读，不再多画分隔线
    act(() => localSocket().push(changeOf(12, "router.item.created", { item: makeReportItem({ id: 204, summary: "开着时进来的新简报", links: [], createdAt: now }) })));
    expect(await within(timeline()).findByText("开着时进来的新简报")).toBeInTheDocument();
    await waitFor(() => expect(archiveCalls(localApi)).toHaveLength(2));
    expect(dividers()).toHaveLength(1);
    expect(archiveCalls(tokyoApi!)).toHaveLength(1);

    // 链接和名字都能跳
    await user.click(within(briefings()[1]!).getByRole("button", { name: "Piece #30" }));
    expect(window.location.hash).toBe("#/w/30");
    await user.click(within(screen.getByRole("complementary", { name: "Sidebar" })).getByRole("button", { name: /Router/ }));
    // 离开再回来：都读过了，分隔线没了
    await waitFor(() => expect(timeline().querySelector("[data-new-divider]")).toBeNull());
    await user.click(within(timeline()).getByRole("button", { name: "阿青" }));
    expect(window.location.hash).toBe(`#/d/${TOKYO_ID}/c/2`);
  });

  it("贴底：往上翻超过 80px 出“回到底部”，自己发一条一定滚到底", async () => {
    const commands = Array.from({ length: 6 }, (_, i) =>
      makeCommandRecord({ id: 400 + i, clientId: `s-${i}`, inputText: `指令 ${i}`, status: "answered", plan: { intent: "answer", reply: `回答 ${i}`, actions: [], track: "B" }, dispatched: null, createdAt: Date.now() - (i + 1) * 60_000 }),
    );
    const localSnap = makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, title: "小林" } })],
      router: { ...emptyRouterSlice(), commands },
    });
    installFleet({ local: localSnap });
    const user = userEvent.setup();
    await openRouter();
    await waitFor(() => expect(turns()).toHaveLength(6));

    const log = timeline();
    const box = fakeLayout(log, { scrollHeight: 2_000, clientHeight: 400 });
    log.scrollTop = 1_600;
    fireEvent.scroll(log);
    expect(screen.queryByRole("button", { name: "Scroll to bottom" })).toBeNull();
    log.scrollTop = 1_000;
    fireEvent.scroll(log);
    expect(screen.getByRole("button", { name: "Scroll to bottom" })).toBeInTheDocument();

    box.scrollHeight = 2_200;
    await user.type(screen.getByPlaceholderText("Tell Router, or type @ to pick a project…"), "我自己发的{Enter}");
    await waitFor(() => expect(turnOf("我自己发的")).toBeInTheDocument());
    await waitFor(() => expect(log.scrollTop).toBe(1_800));
    expect(screen.queryByRole("button", { name: "Scroll to bottom" })).toBeNull();
  });

  it("Load earlier：各来源按近窗最旧一条的游标往前各翻一页，按水位线合并（更早的条目不插到看过的内容中间）；旧版设备回的非简报项被滤掉；翻出来的失败回合不能 Retry；失败可重试", async () => {
    const now = Date.now();
    // 近窗：10 条指令（够一页快照，前面可能还有）、1 条比它们都早的简报
    const commands = Array.from({ length: 10 }, (_, i) =>
      makeCommandRecord({ id: 500 - i, clientId: `w-${i}`, inputText: `近窗指令 ${i}`, status: "answered", plan: { intent: "answer", reply: `近窗回答 ${i}`, actions: [], track: "B" }, dispatched: null, createdAt: now - (i + 1) * 60_000 }),
    );
    const oldBriefing = makeReportItem({ id: 210, status: "archived", summary: "一小时前的简报", links: [], createdAt: now - 3_600_000 });
    const localSnap = makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      projects: [makeProject({ id: 10, name: "agent-hub", pmId: 1, conversationId: 1 })],
      conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, projectId: 10, title: "小林" } })],
      router: { ...emptyRouterSlice(), items: [oldBriefing], commands },
    });
    const olderFailed = makeCommandRecord({ id: 480, clientId: "h-failed", inputText: "更早的失败指令", status: "failed", error: "模型响应超时，请稍后重试", plan: null, dispatched: null, createdAt: now - 1_800_000 });
    const olderAnswered = makeCommandRecord({ id: 470, clientId: "h-ok", inputText: "两小时前的指令", status: "answered", plan: { intent: "answer", reply: "两小时前的回答", actions: [], track: "B" }, dispatched: null, createdAt: now - 7_200_000 });
    const { localApi, commandPageCalls } = installFleet({
      local: localSnap,
      commandsPage: () => ({ commands: [olderFailed, olderAnswered], nextCursor: null, hasMore: false }),
    });
    let failItems = true;
    localApi.routerItems = () => {
      if (failItems) {
        failItems = false;
        return { status: 500, body: { error: "内部错误", code: "internal" } };
      }
      return {
        status: 200,
        body: {
          items: [
            makeReportItem({ id: 205, status: "archived", summary: "三小时前的简报", links: [], createdAt: now - 10_800_000 }),
            // 旧版设备不认识 kind=report，会把已拍板的也回来：网页再滤一次
            makeDecisionItem({ id: 190, status: "resolved", question: "早就拍过板的问题", createdAt: now - 10_900_000 }),
          ],
          nextCursor: null,
          hasMore: false,
        },
      };
    };
    const user = userEvent.setup();
    await openRouter();
    await waitFor(() => expect(turns()).toHaveLength(10));
    const itemCalls = () => localApi.callsTo("GET", /^\/api\/router\/items$/);

    // 打开工作台不多发请求；比指令近窗更早的简报先不显示（指令前面可能还有，显示了以后翻页会插到它后面）
    expect(commandPageCalls).toHaveLength(0);
    expect(itemCalls()).toHaveLength(0);
    expect(within(timeline()).queryByText("一小时前的简报")).toBeNull();

    await user.click(within(timeline()).getByRole("button", { name: "Load earlier" }));
    await waitFor(() => expect(commandPageCalls).toHaveLength(1));
    expect(commandPageCalls[0]!.get("cursor")).toBe(`${commands[9]!.createdAt}:${commands[9]!.id}`);
    expect(commandPageCalls[0]!.get("limit")).toBe(String(ROUTER_STREAM_PAGE_SIZE));
    await waitFor(() => expect(itemCalls()).toHaveLength(1));
    expect(itemCalls()[0]!.query.get("kind")).toBe("report");
    expect(itemCalls()[0]!.query.get("cursor")).toBe(`${oldBriefing.createdAt}:${oldBriefing.id}`);
    expect(itemCalls()[0]!.query.get("limit")).toBe(String(ROUTER_STREAM_PAGE_SIZE));

    // 指令翻到头了；简报那一页失败：不缓存空页，原地可重试
    expect(await within(timeline()).findByText("更早的失败指令")).toBeInTheDocument();
    const retryLoad = await within(timeline()).findByRole("button", { name: "Couldn't load. Click to retry" });
    await user.click(retryLoad);
    await waitFor(() => expect(itemCalls()).toHaveLength(2));
    expect(commandPageCalls).toHaveLength(1);
    expect(await within(timeline()).findByText("三小时前的简报")).toBeInTheDocument();
    expect(within(timeline()).queryByText("早就拍过板的问题")).toBeNull();

    // 全部按时间从上到下排
    const order = [...timeline().querySelectorAll<HTMLElement>("[data-stream-entry]")].map(
      (e) => e.querySelector("[data-bubble]")?.textContent ?? e.querySelector(".markdown")?.textContent,
    );
    expect(order.slice(0, 5)).toEqual(["三小时前的简报", "两小时前的指令", "一小时前的简报", "更早的失败指令", "近窗指令 9"]);
    expect(order.at(-1)).toBe("近窗指令 0");

    // 翻历史翻出来的失败回合只显示原因，不能重试；都翻到头了就不再出 Load earlier
    const historyFailed = turnOf("更早的失败指令");
    expect(within(historyFailed).getByText("模型响应超时，请稍后重试")).toBeInTheDocument();
    expect(within(historyFailed).queryByRole("button", { name: "Retry" })).toBeNull();
    expect(within(timeline()).queryByRole("button", { name: /Load earlier|Couldn't load/ })).toBeNull();
  });

  it("长回答把指令快照截到不满 10 条（字节上限）时照样能 Load earlier；附件按 plan.attachments 画在气泡下面", async () => {
    const now = Date.now();
    const longReply = `第一段：${"很长的回答".repeat(400)}\n\n第二段：收尾`;
    const commands = [
      makeCommandRecord({ id: 702, clientId: "t-2", inputText: "最近一条", status: "answered", plan: { intent: "answer", reply: longReply, actions: [], track: "B" }, dispatched: null, createdAt: now - 60_000 }),
      makeCommandRecord({
        id: 701,
        clientId: "t-1",
        inputText: "带附件的一条",
        status: "answered",
        plan: { intent: "answer", reply: longReply, actions: [], track: "B", attachments: [{ id: "u-1", name: "spec.pdf", mime: "application/pdf", size: 2048 }] },
        dispatched: null,
        createdAt: now - 120_000,
      }),
    ];
    const localSnap = makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, title: "小林" } })],
      router: { ...emptyRouterSlice(), commands },
    });
    const older = makeCommandRecord({ id: 650, clientId: "t-0", inputText: "被字节上限挤出快照的指令", status: "answered", plan: { intent: "answer", reply: "更早的回答", actions: [], track: "B" }, dispatched: null, createdAt: now - 3_600_000 });
    const { commandPageCalls } = installFleet({
      local: localSnap,
      commandsPage: () => ({ commands: [older], nextCursor: null, hasMore: false }),
    });
    const user = userEvent.setup();
    await openRouter();
    await waitFor(() => expect(turns()).toHaveLength(2));
    expect(within(turnOf("带附件的一条")).getByText("spec.pdf")).toBeInTheDocument();

    await user.click(within(timeline()).getByRole("button", { name: "Load earlier" }));
    await waitFor(() => expect(commandPageCalls).toHaveLength(1));
    expect(commandPageCalls[0]!.get("cursor")).toBe(`${commands[1]!.createdAt}:${commands[1]!.id}`);
    expect(await within(timeline()).findByText("被字节上限挤出快照的指令")).toBeInTheDocument();
    expect(turns()[0]).toBe(turnOf("被字节上限挤出快照的指令"));
    // 服务端说到头了：不再出 Load earlier
    expect(within(timeline()).queryByRole("button", { name: /Load earlier|Couldn't load/ })).toBeNull();
  });

  it("标已读失败：不因为别的流更新（指令变了、项目经理改了）重发，页面重新可见或来了新简报才再试", async () => {
    const now = Date.now();
    const unread = makeReportItem({ id: 230, summary: "一条未读简报", links: [], createdAt: now - 30_000 });
    const planning = makeCommandRecord({ id: 720, clientId: "v-1", inputText: "跑一下回归", status: "planning", plan: null, dispatched: null, createdAt: now - 20_000 });
    const localSnap = makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      projects: [makeProject({ id: 10, name: "agent-hub", pmId: 1, conversationId: 1 })],
      conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, projectId: 10, title: "小林" } })],
      router: { ...emptyRouterSlice(), items: [unread], commands: [planning] },
    });
    const { localApi } = installFleet({ local: localSnap });
    let failing = true;
    localApi.archiveAllRouterReports = () =>
      failing
        ? { status: 500, body: { error: "内部错误", code: "internal" } }
        : { status: 200, body: { archivedIds: [], updatedAt: Date.now() } };
    const archiveCalls = () => localApi.callsTo("POST", /^\/api\/router\/reports\/archive-all$/);
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);

    await openRouter();
    await waitFor(() => expect(archiveCalls()).toHaveLength(1));
    // 让失败的那次请求落地
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // 流在更新（指令出结果、项目经理改名），未读集合没变：不重发
    act(() =>
      localSocket().push(
        changeOf(11, "router.command.updated", { command: { ...planning, status: "answered", plan: { intent: "answer", reply: "回归全绿", actions: [], track: "B" }, updatedAt: now } }),
      ),
    );
    expect(await within(timeline()).findByText("回归全绿")).toBeInTheDocument();
    act(() => localSocket().push(changeOf(12, "pm.updated", { pm: makePm({ id: 1, name: "小林二号" }) })));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(archiveCalls()).toHaveLength(1);

    // 切到后台不发；回到前台再试一次
    failing = false;
    visibility = "hidden";
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(archiveCalls()).toHaveLength(1);
    visibility = "visible";
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(archiveCalls()).toHaveLength(2));

    // 来了新简报：未读集合变了，照常发
    act(() => localSocket().push(changeOf(13, "router.item.created", { item: makeReportItem({ id: 231, summary: "又一条", links: [], createdAt: now }) })));
    await waitFor(() => expect(archiveCalls()).toHaveLength(3));
  });

  it("渲染次数守卫（第 5.3 节）：100 次无关的流式更新期间时间流 0 次重画；更新一条指令时只有那一个回合重画一次", async () => {
    const now = Date.now();
    const commands = Array.from({ length: 5 }, (_, i) =>
      makeCommandRecord({ id: 600 + i, clientId: `r-${i}`, inputText: `指令 ${i}`, status: "answered", plan: { intent: "answer", reply: `回答 ${i}`, actions: [], track: "B" }, dispatched: null, createdAt: now - (i + 1) * 60_000 }),
    );
    const briefings = Array.from({ length: 3 }, (_, i) => makeReportItem({ id: 220 + i, status: "archived", summary: `简报 ${i}`, links: [], createdAt: now - (i + 1) * 90_000 }));
    const localSnap = makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      projects: [makeProject({ id: 10, name: "agent-hub", pmId: 1, conversationId: 1 })],
      conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, projectId: 10, title: "小林" } })],
      router: { ...emptyRouterSlice(), items: [makeDecisionItem({ createdAt: now }), ...briefings], commands },
    });
    installFleet({ local: localSnap });
    await openRouter();
    await waitFor(() => expect(turns()).toHaveLength(5));
    await screen.findByRole("region", { name: "Needs You" });

    const session = makeSession({ sessionId: 9, conversationId: 1, pmId: 1, status: "running", activity: "working", step: { type: "text" }, streamingText: "片段" });
    act(() => localSocket().push(sessionChange(11, session)));
    const streamBefore = renders.stream;
    const markdownBefore = renders.markdown.length;
    for (let i = 0; i < 100; i++) act(() => localSocket().push(sessionChange(12 + i, { ...session, streamingText: `片段 ${i}` })));
    expect(renders.stream - streamBefore).toBe(0);
    expect(renders.markdown.length - markdownBefore).toBe(0);

    // 一个回合的结果变了：只重画它
    act(() =>
      localSocket().push(
        changeOf(200, "router.command.updated", { command: { ...commands[2]!, plan: { intent: "answer", reply: "改过的回答", actions: [], track: "B" }, updatedAt: now } }),
      ),
    );
    expect(await within(timeline()).findByText("改过的回答")).toBeInTheDocument();
    expect(renders.markdown.slice(markdownBefore)).toEqual(["改过的回答"]);
    expect(renders.stream - streamBefore).toBe(1);
  });
});
