// App 顶层接通右栏果皮轨（docs/ui-standard.md 第 12 / 12.1 条）：桌面右栏、手机抽屉都拿到当前项目的活跃任务图，
// 绑图 Piece 与门禁提问去重；拍板、取消走当前设备的接口（DeviceScope），跨设备看远端项目经理时发到 /d/<设备>/...；
// Cancel graph 要二次确认；连续流式帧里右栏零重画。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo, StateSnapshot, TaskGraph, TaskNode } from "../shared/index.ts";
import { App } from "./App.tsx";
import * as RightRailMod from "./components/RightRail.tsx";
import { TaskGraphDialog } from "./components/TaskGraphDialog.tsx";
import * as PiecesDrawerMod from "./mobile/PiecesDrawer.tsx";
import {
  FakeApi,
  FakeWebSocket,
  installFakeWebSocket,
  makeConvSnapshot,
  makeMessage,
  makePm,
  makeProject,
  makeSession,
  makeSnapshot,
  makeUserMessage,
  makeWorkerConversation,
  makeWorkerLine,
  sessionChange,
} from "./test-utils.ts";

const GRAPH_ID = 7;
const DECIDE_PATH = new RegExp(`^/api/task-graphs/${GRAPH_ID}/nodes/gate/decide$`);
const CANCEL_PATH = new RegExp(`^/api/task-graphs/${GRAPH_ID}/cancel$`);

function makeNode(over: Partial<TaskNode> & Pick<TaskNode, "key" | "title">): TaskNode {
  return {
    status: "pending",
    waitingFor: null,
    skipped: false,
    sortOrder: 0,
    activeWorkerId: null,
    workerIds: [],
    artifact: null,
    gateQuestion: null,
    gateOptions: [],
    gateSummaryMd: null,
    gateRecommended: null,
    gateAskMessageId: null,
    decision: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

function graph(): TaskGraph {
  return {
    id: GRAPH_ID,
    projectId: 1,
    pmId: 1,
    conversationId: 1,
    title: "发布流水线",
    status: "active",
    originMsgId: null,
    nodes: [
      makeNode({ key: "build", title: "构建产物", status: "running", sortOrder: 0, activeWorkerId: 3, workerIds: [3] }),
      makeNode({
        key: "gate",
        title: "确认上线",
        status: "waiting",
        waitingFor: "user",
        skipped: false,
        sortOrder: 1,
        gateQuestion: "现在上线吗？",
        gateOptions: ["上线", "再等等"],
        gateRecommended: "上线",
        gateAskMessageId: 99,
      }),
    ],
    edges: [{ fromKey: "build", toKey: "gate" }],
    createdAt: 1_000,
    updatedAt: 1_000,
    completedAt: null,
  };
}

/** 项目经理 1（项目 1）：Worker #3（对话 30）绑在任务图节点上，Worker #4（对话 31）是零散的；一条门禁提问、一条独立提问。 */
function graphSnapshot(name = "小林"): StateSnapshot {
  return makeSnapshot({
    pms: [makePm({ id: 1, name })],
    projects: [makeProject({ id: 1, pmId: 1, conversationId: 1 })],
    conversations: [
      makeConvSnapshot(
        [
          makeUserMessage({ id: 1, conversationId: 1, text: "开始吧", createdAt: 5_000 }),
          makeWorkerLine({ id: 10, line: { workerId: 3, workerConversationId: 30, title: "绑图的活" } }),
          makeWorkerLine({ id: 11, line: { workerId: 4, workerConversationId: 31, title: "零散的活" } }),
          makeMessage({ id: 98, text: "独立提问：要不要加日志？", meta: { needsUser: true }, dedupeKey: "ask:1:98" }),
          makeMessage({
            id: 99,
            text: "门禁提问：现在上线吗？",
            meta: { needsUser: true, gateRef: { graphId: GRAPH_ID, nodeKey: "gate" } },
            dedupeKey: "ask:1:99",
          }),
        ],
        { conversation: { id: 1, pmId: 1, title: name } },
      ),
      makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 30, title: "绑图的活" }) }),
      makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 31, title: "零散的活" }) }),
    ],
    sessions: [makeSession({ sessionId: 10, conversationId: 1, pmId: 1, status: "running", activity: "working", step: { type: "text" } })],
    activeTaskGraphs: [graph()],
  });
}

function plainSnapshot(name: string): StateSnapshot {
  return makeSnapshot({
    pms: [makePm({ id: 1, name })],
    conversations: [makeConvSnapshot([makeUserMessage({ id: 1, conversationId: 1, text: `${name}你好` })], { conversation: { id: 1, pmId: 1, title: name } })],
  });
}

const sidePanel = () => screen.getByRole("complementary", { name: "Side panel" });

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function bootSingle(snapshot: StateSnapshot) {
  window.history.replaceState(null, "", "/#/c/1");
  const api = new FakeApi(snapshot);
  api.install();
  installFakeWebSocket();
  render(<App />);
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  act(() => FakeWebSocket.last.open());
  return { api, ws: FakeWebSocket.last };
}

describe("桌面右栏：App 接通果皮轨与切面轮", () => {
  it("渲染当前项目的活跃任务图；绑图 Piece 不进 Pieces，门禁提问不进 Needs You；点节点进那个 Piece 的对话", async () => {
    const user = userEvent.setup();
    await bootSingle(graphSnapshot());
    const rail = await waitFor(sidePanel);

    const graphs = within(rail).getByRole("region", { name: /^Task Graph$/ });
    expect(within(graphs).getByText("发布流水线")).toBeInTheDocument();
    expect(graphs.querySelector("[data-slot='slice-wheel']")).toBeInTheDocument();
    expect(within(graphs).getByTestId("peel-gate-card")).toBeInTheDocument();

    const asks = within(rail).getByRole("region", { name: /^Needs You$/ });
    expect(within(asks).getByText("独立提问：要不要加日志？")).toBeInTheDocument();
    expect(within(asks).queryByText(/门禁提问/)).toBeNull();

    const pieces = within(rail).getByRole("region", { name: /^Pieces$/ });
    expect(within(pieces).getByRole("button", { name: "零散的活" })).toBeInTheDocument();
    expect(within(pieces).queryByRole("button", { name: "绑图的活" })).toBeNull();

    await user.click(within(graphs).getByRole("button", { name: /构建产物/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/w/30"));
  });

  it("门禁卡点选项：POST 到本机的 /api/task-graphs/:id/nodes/:key/decide", async () => {
    const user = userEvent.setup();
    const { api } = await bootSingle(graphSnapshot());
    const card = await waitFor(() => within(sidePanel()).getByTestId("peel-gate-card"));
    await user.click(within(card).getByRole("button", { name: /再等等/ }));
    await waitFor(() => expect(api.callsTo("POST", DECIDE_PATH)).toHaveLength(1));
    expect(api.callsTo("POST", DECIDE_PATH)[0]!.body).toMatchObject({ choice: "再等等" });
  });

  it("对话流里的步骤拍板卡（带 gateRef）与 confirm 检查点卡：点选或填打回意见直调 /decide，不误发普通聊天消息，检查点默认展开意见框", async () => {
    const user = userEvent.setup();
    const checkpointGraph: TaskGraph = {
      id: GRAPH_ID,
      projectId: 1,
      pmId: 1,
      conversationId: 1,
      title: "检查点验收流水线",
      status: "active",
      originMsgId: null,
      nodes: [
        makeNode({
          key: "gate",
          title: "方案检查点",
          status: "waiting",
          waitingFor: "user",
          sortOrder: 0,
          activeWorkerId: 3,
          workerIds: [3],
          gateQuestion: "请确认步骤「方案检查点」的结果",
          gateOptions: ["通过", "打回"],
          gateRecommended: "通过",
          gateSummaryMd: "**摘要**：已完成方案初稿\n\n**交棒要点**：\n见 `docs/plan.md`",
          gateAskMessageId: 105,
          gateCheckpoint: true,
        }),
      ],
      edges: [],
      createdAt: 1_000,
      updatedAt: 2_000,
      completedAt: null,
    };
    const snap = makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      projects: [makeProject({ id: 1, pmId: 1, conversationId: 1 })],
      conversations: [
        makeConvSnapshot(
          [
            makeMessage({
              id: 105,
              text: "请确认步骤「方案检查点」的结果\n\n**摘要**：已完成方案初稿\n\n**交棒要点**：\n见 `docs/plan.md`",
              meta: {
                needsUser: true,
                options: ["通过", "打回"],
                recommended: "通过",
                gateRef: { graphId: GRAPH_ID, nodeKey: "gate", checkpoint: true },
              },
              dedupeKey: "ask:1:105",
            }),
          ],
          { conversation: { id: 1, pmId: 1, title: "小林" } },
        ),
      ],
      sessions: [makeSession({ sessionId: 10, conversationId: 1, pmId: 1 })],
      activeTaskGraphs: [checkpointGraph],
    });

    const { api } = await bootSingle(snap);
    const railCard = await waitFor(() => within(sidePanel()).getByTestId("peel-gate-card"));
    // 右栏果皮轨检查点拍板卡默认已展开补充输入框，无需先点 Add note
    expect(within(railCard).getByLabelText("Add note")).toBeInTheDocument();
    expect(within(railCard).getByRole("button", { name: /通过.*Recommended/ })).toBeInTheDocument();

    // 对话消息流里的检查点 AskCard 同样展示 Recommended 并默认展开补充输入框，点「打回」带修改意见直调 /decide，不调 /messages
    const chatArticle = document.querySelector('[data-message-id="105"]') as HTMLElement;
    const chatCard = chatArticle.querySelector("[data-ask-card]") as HTMLElement;
    expect(within(chatCard).getByText("Recommended")).toBeInTheDocument();
    const noteInput = within(chatCard).getByLabelText("Add note");
    await user.type(noteInput, "把缓存淘汰改成 lru-cache");
    await user.click(within(chatCard).getByRole("button", { name: /打回/ }));

    await waitFor(() => expect(api.callsTo("POST", DECIDE_PATH)).toHaveLength(1));
    expect(api.callsTo("POST", DECIDE_PATH)[0]!.body).toMatchObject({
      choice: "打回",
      note: "把缓存淘汰改成 lru-cache",
    });
    expect(api.callsTo("POST", /^\/api\/conversations\/1\/messages$/)).toHaveLength(0);
  });

  it("confirm 检查点卡直接点 Send 发自由文本修改意见：传 choice=null 附意见，对话卡片立即高亮「打回」且不误触通过；已取消历史图不渲染活体拍板卡", async () => {
    const user = userEvent.setup();
    const checkpointGraph: TaskGraph = {
      id: GRAPH_ID,
      projectId: 1,
      pmId: 1,
      conversationId: 1,
      title: "自定义 Send 检查点",
      status: "active",
      originMsgId: null,
      nodes: [
        makeNode({
          key: "gate",
          title: "方案检查点",
          status: "waiting",
          waitingFor: "user",
          sortOrder: 0,
          activeWorkerId: 3,
          workerIds: [3],
          gateQuestion: "请确认步骤「方案检查点」的结果",
          gateOptions: ["通过", "打回"],
          gateRecommended: "通过",
          gateSummaryMd: "**摘要**：已完成初稿",
          gateAskMessageId: 106,
          gateCheckpoint: true,
        }),
      ],
      edges: [],
      createdAt: 1_000,
      updatedAt: 2_000,
      completedAt: null,
    };
    const snap = makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      projects: [makeProject({ id: 1, pmId: 1, conversationId: 1 })],
      conversations: [
        makeConvSnapshot(
          [
            makeMessage({
              id: 106,
              text: "请确认步骤「方案检查点」的结果\n\n**摘要**：已完成初稿",
              meta: {
                needsUser: true,
                options: ["通过", "打回"],
                recommended: "通过",
                gateRef: { graphId: GRAPH_ID, nodeKey: "gate", checkpoint: true },
              },
              dedupeKey: "ask:1:106",
            }),
          ],
          { conversation: { id: 1, pmId: 1, title: "小林" } },
        ),
      ],
      sessions: [makeSession({ sessionId: 10, conversationId: 1, pmId: 1 })],
      activeTaskGraphs: [checkpointGraph],
    });

    const { api } = await bootSingle(snap);

    // 在对话检查点卡输入框填修改意见并直接点 Send（未点「通过」也未点「打回」）
    const chatArticle = await waitFor(() => document.querySelector('[data-message-id="106"]') as HTMLElement);
    const chatCard = chatArticle.querySelector("[data-ask-card]") as HTMLElement;
    await user.type(within(chatCard).getByLabelText("Add note"), "补充上限常量到 limits.ts");
    await user.click(within(chatCard).getByRole("button", { name: "Send" }));

    await waitFor(() => expect(api.callsTo("POST", DECIDE_PATH)).toHaveLength(1));
    expect(api.callsTo("POST", DECIDE_PATH)[0]!.body).toMatchObject({
      choice: null,
      note: "补充上限常量到 limits.ts",
    });
    // 乐观态立即高亮「打回」选项，不误高亮「通过」
    const passBtn = within(chatCard).getByRole("button", { name: /通过/ });
    const rejectBtn = within(chatCard).getByRole("button", { name: /打回/ });
    expect(rejectBtn.className).toContain("bg-sidebar-active");
    expect(passBtn.className).not.toContain("bg-sidebar-active");

    // 打开已取消的历史图全览弹窗：绝不渲染活体 GateDecisionCard 或 Waiting on you
    render(
      <TaskGraphDialog
        open
        graph={{
          ...checkpointGraph,
          id: 88,
          title: "已取消历史图",
          status: "cancelled",
          completedAt: 3_000,
        }}
        workers={[]}
        onOpenChange={() => {}}
        onOpenWorker={() => {}}
      />,
    );
    const histDialog = await screen.findByRole("dialog", { name: "已取消历史图" });
    expect(within(histDialog).queryByTestId("peel-gate-card")).toBeNull();
    expect(within(histDialog).queryByText("Waiting on you")).toBeNull();
  });

  it("Cancel graph 要二次确认：点一下只弹确认，Keep going 不发请求；确认后才 POST，成功后两层弹窗都关", async () => {
    const user = userEvent.setup();
    const { api } = await bootSingle(graphSnapshot());
    const graphs = await waitFor(() => within(sidePanel()).getByRole("region", { name: /^Task Graph$/ }));
    await user.click(within(graphs).getByRole("button", { name: "Zoom" }));
    const zoom = await screen.findByRole("dialog", { name: "发布流水线" });
    // running 节点展示同色系果皮浅晕圆环，且滚动视口不带 -mx-6 防止贴边裁切
    expect(zoom.querySelector("[data-running-ring]")).not.toBeNull();
    expect(zoom.querySelector("[data-slot='dialog-body']")?.className).not.toContain("-mx-6");

    await user.click(within(zoom).getByRole("button", { name: "Cancel graph" }));
    const confirm = await screen.findByRole("dialog", { name: "Cancel this task graph?" });
    expect(confirm).toHaveClass("max-w-110");
    expect(within(confirm).getByRole("button", { name: "Keep going" })).toHaveFocus();
    expect(api.callsTo("POST", CANCEL_PATH)).toHaveLength(0);

    await user.click(within(confirm).getByRole("button", { name: "Keep going" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Cancel this task graph?" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "发布流水线" })).toBeInTheDocument();
    expect(api.callsTo("POST", CANCEL_PATH)).toHaveLength(0);

    await user.click(within(screen.getByRole("dialog", { name: "发布流水线" })).getByRole("button", { name: "Cancel graph" }));
    const again = await screen.findByRole("dialog", { name: "Cancel this task graph?" });
    await user.click(within(again).getByRole("button", { name: "Cancel graph" }));
    await waitFor(() => expect(api.callsTo("POST", CANCEL_PATH)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Cancel graph 失败：确认弹窗关掉，错误显示在全览弹窗顶部", async () => {
    const user = userEvent.setup();
    const { api } = await bootSingle(graphSnapshot());
    api.cancelTaskGraph = () => ({ status: 409, body: { error: "任务图已经全部完成，无需取消", code: "conflict" } });
    await user.click(await waitFor(() => within(sidePanel()).getByRole("button", { name: "Zoom" })));
    const zoom = await screen.findByRole("dialog", { name: "发布流水线" });
    await user.click(within(zoom).getByRole("button", { name: "Cancel graph" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Cancel this task graph?" })).getByRole("button", { name: "Cancel graph" }));
    expect(await within(zoom).findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Cancel this task graph?" })).toBeNull();
    expect(api.callsTo("POST", CANCEL_PATH)).toHaveLength(1);
  });

  it("爆炸半径：带活跃任务图时连续 8 帧流式输出，RightRail 零重画", async () => {
    type MemoTarget = { type: (...args: unknown[]) => unknown };
    const railSpy = vi.spyOn(RightRailMod.RightRail as unknown as MemoTarget, "type");
    const { ws } = await bootSingle(graphSnapshot());
    await waitFor(() => expect(within(sidePanel()).getByRole("region", { name: /^Task Graph$/ })).toBeInTheDocument());
    railSpy.mockClear();
    for (let i = 1; i <= 8; i++) {
      act(() =>
        ws.push(
          sessionChange(
            20 + i,
            makeSession({ sessionId: 10, conversationId: 1, pmId: 1, status: "running", activity: "working", step: { type: "text" }, streamingText: "流式片段".repeat(i) }),
          ),
        ),
      );
    }
    expect(screen.getByText("流式片段".repeat(8))).toBeInTheDocument();
    expect(railSpy).toHaveBeenCalledTimes(0);
  });
});

describe("手机抽屉：同一份 RailGroups", () => {
  it("抽屉里有果皮轨与切面轮，门禁提问同样去重；点节点先关抽屉再进 Piece", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("coarse"),
      addEventListener() {},
      removeEventListener() {},
    }));
    await bootSingle(graphSnapshot());
    const toggle = await screen.findByRole("button", { name: "Show side panel (needs you)" });
    // vaul 的拖动手势要 setPointerCapture（jsdom 没有）：抽屉里用 fireEvent.click，和 mobile-shell.test.tsx 一样
    fireEvent.click(toggle);
    const drawer = await screen.findByRole("dialog", { name: "Pieces" });
    const graphs = within(drawer).getByRole("region", { name: /^Task Graph$/ });
    expect(graphs.querySelector("[data-slot='slice-wheel']")).toBeInTheDocument();
    expect(within(drawer).queryByText(/门禁提问/)).toBeNull();
    expect(within(drawer).queryByRole("button", { name: "绑图的活" })).toBeNull();
    fireEvent.click(within(graphs).getByRole("button", { name: /构建产物/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/w/30"));
    expect(screen.queryByRole("dialog", { name: "Pieces" })).toBeNull();
  });
});

describe("手机抽屉：流式帧", () => {
  it("抽屉开着时连续 8 帧流式输出，PiecesDrawer 零重画", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("coarse"),
      addEventListener() {},
      removeEventListener() {},
    }));
    type MemoTarget = { type: (...args: unknown[]) => unknown };
    const drawerSpy = vi.spyOn(PiecesDrawerMod.PiecesDrawer as unknown as MemoTarget, "type");
    const { ws } = await bootSingle(graphSnapshot());
    fireEvent.click(await screen.findByRole("button", { name: "Show side panel (needs you)" }));
    await screen.findByRole("dialog", { name: "Pieces" });
    drawerSpy.mockClear();
    for (let i = 1; i <= 8; i++) {
      act(() =>
        ws.push(
          sessionChange(
            20 + i,
            makeSession({ sessionId: 10, conversationId: 1, pmId: 1, status: "running", activity: "working", step: { type: "text" }, streamingText: "流式片段".repeat(i) }),
          ),
        ),
      );
    }
    expect(screen.getByText("流式片段".repeat(8))).toBeInTheDocument();
    expect(drawerSpy).toHaveBeenCalledTimes(0);
  });
});

describe("跨设备：右栏的请求走当前设备的接口", () => {
  const MAC = "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d";
  const TOKYO = "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f";
  const devices: DeviceInfo[] = [
    { id: MAC, name: "Mac", platform: "darwin", self: true, url: null },
    { id: TOKYO, name: "东京", platform: "linux", self: false, url: "https://tokyo.example.ts.net" },
  ];

  async function bootFleet() {
    const local = new FakeApi(plainSnapshot("本机经理"));
    const remote = new FakeApi(graphSnapshot("东京经理"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://127.0.0.1:1");
        if (url.pathname === "/api/devices") return Response.json({ devices });
        const proxied = /^\/d\/([^/]+)(\/.*)$/.exec(url.pathname);
        if (proxied) return proxied[1] === TOKYO ? remote.fetch(`${proxied[2]}${url.search}`, init) : Response.json({ error: "not found" }, { status: 404 });
        return local.fetch(input, init);
      }),
    );
    installFakeWebSocket();
    window.history.replaceState(null, "", `/#/d/${TOKYO}/c/1`);
    render(<App />);
    const sockets = (tokyo: boolean) => FakeWebSocket.instances.filter((ws) => ws.url.includes(`/d/${TOKYO}/`) === tokyo);
    await waitFor(() => expect(sockets(false)).toHaveLength(1));
    act(() => sockets(false)[0]!.open());
    await waitFor(() => expect(sockets(true)).toHaveLength(1));
    act(() => sockets(true)[0]!.open());
    return { local, remote };
  }

  it("看东京的项目经理：门禁拍板、Cancel graph 都发到东京（/d/<东京>/...），本机一条都不收", async () => {
    const user = userEvent.setup();
    const { local, remote } = await bootFleet();
    const rail = await waitFor(sidePanel);
    const card = within(rail).getByTestId("peel-gate-card");
    await user.click(within(card).getByRole("button", { name: /上线/ }));
    await waitFor(() => expect(remote.callsTo("POST", DECIDE_PATH)).toHaveLength(1));
    expect(local.callsTo("POST", DECIDE_PATH)).toHaveLength(0);

    await user.click(within(rail).getByRole("button", { name: "Zoom" }));
    const zoom = await screen.findByRole("dialog", { name: "发布流水线" });
    await user.click(within(zoom).getByRole("button", { name: "Cancel graph" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Cancel this task graph?" })).getByRole("button", { name: "Cancel graph" }));
    await waitFor(() => expect(remote.callsTo("POST", CANCEL_PATH)).toHaveLength(1));
    expect(local.callsTo("POST", CANCEL_PATH)).toHaveLength(0);
  });

  it("点东京任务图的节点：进东京那台的 Piece 对话（网址带设备）", async () => {
    const user = userEvent.setup();
    await bootFleet();
    const rail = await waitFor(sidePanel);
    await user.click(within(rail).getByRole("button", { name: /构建产物/ }));
    await waitFor(() => expect(window.location.hash).toBe(`#/d/${TOKYO}/w/30`));
  });
});

describe("待交付状态展示（Ready to finish）", () => {
  it("所有节点均已到达终态但图仍 active 时，果皮轨头与全览弹窗均克制显示 Ready to finish；仍有未完节点时不显示", async () => {
    const user = userEvent.setup();
    const { ws } = await bootSingle(graphSnapshot());
    const rail = await waitFor(sidePanel);
    expect(within(rail).queryByText("Ready to finish")).not.toBeInTheDocument();

    act(() =>
      ws.push({
        seq: 30,
        type: "task_graph.updated",
        data: {
          graph: {
            ...graph(),
            nodes: [
              makeNode({ key: "build", title: "构建产物", status: "done", sortOrder: 0, workerIds: [3] }),
              makeNode({ key: "gate", title: "确认上线", status: "done", waitingFor: null, skipped: true, sortOrder: 1 }),
            ],
          },
        },
      }),
    );

    expect(await within(rail).findByText("Ready to finish")).toBeInTheDocument();

    await user.click(within(rail).getByRole("button", { name: "Zoom" }));
    const zoom = await screen.findByRole("dialog", { name: "发布流水线" });
    expect(within(zoom).getByText("Ready to finish")).toBeInTheDocument();
  });
});
