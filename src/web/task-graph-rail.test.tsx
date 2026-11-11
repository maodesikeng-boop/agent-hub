import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_TOKEN_USAGE,
  MAX_COMPLETED_GRAPH_PAGES,
  type DecideTaskNodeRequest,
  type Message,
  type TaskGraph,
  type TaskGraphsPage,
  type TaskNode,
} from "../shared/index.ts";
import * as RightRailMod from "./components/RightRail.tsx";
import { RightRail } from "./components/RightRail.tsx";
import { SliceWheelIcon } from "./components/SliceWheelIcon.tsx";
import { TaskGraphDialog } from "./components/TaskGraphDialog.tsx";
import { PiecesDrawer } from "./mobile/PiecesDrawer.tsx";
import { PALETTE } from "./lib/palette.ts";
import { resetQueryClient } from "./query-client.ts";
import { activeGraphsOf, pendingAsks, pendingDecisionsOf, unboundWorkersOf, workersOf, type WorkerEntry } from "./selectors.ts";
import { applyChange, initialState, type HubState } from "./state.ts";
import {
  makeConvSnapshot,
  makeMessage,
  makePm,
  makeProject,
  makeSession,
  makeWorkerConversation,
  makeWorkerLine,
  sessionChange,
} from "./test-utils.ts";

function makeNode(over: Partial<TaskNode> & Pick<TaskNode, "key" | "title">): TaskNode {
  return {
    kind: "piece",
    status: "pending",
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

function makeGraph(over: Partial<TaskGraph> & Pick<TaskGraph, "id" | "title">): TaskGraph {
  return {
    projectId: 1,
    pmId: 1,
    conversationId: 1,
    status: "active",
    originMsgId: null,
    nodes: [],
    edges: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    completedAt: null,
    ...over,
  };
}

function makeWorker(conversationId: number, over: Partial<WorkerEntry> = {}): WorkerEntry {
  return {
    conversationId,
    workerId: conversationId - 20,
    title: `Piece ${conversationId}`,
    activity: "working",
    ended: false,
    usage: EMPTY_TOKEN_USAGE,
    tone: "neutral",
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  localStorage.clear();
  resetQueryClient();
});

afterEach(() => {
  cleanup();
  resetQueryClient();
  vi.restoreAllMocks();
});

describe("SliceWheelIcon：小水果切面进度轮", () => {
  it("按总阶段数切瓣，跟随项目经理水果配色并用 rem 缩放；相邻同层并行瓣果心相连", () => {
    const graph = makeGraph({
      id: 1,
      title: "多阶段改造",
      nodes: [
        makeNode({ key: "s1", title: "调研", status: "done", sortOrder: 0 }),
        makeNode({ key: "s2", title: "前端", status: "running", sortOrder: 1 }),
        makeNode({ key: "s3", title: "接口", status: "running", sortOrder: 2 }),
        makeNode({ key: "s4", title: "拍板", kind: "gate", status: "waiting_user", sortOrder: 3 }),
        makeNode({ key: "s5", title: "回归", status: "pending", sortOrder: 4 }),
      ],
      edges: [
        { fromKey: "s1", toKey: "s2" },
        { fromKey: "s1", toKey: "s3" },
        { fromKey: "s2", toKey: "s4" },
        { fromKey: "s3", toKey: "s4" },
        { fromKey: "s4", toKey: "s5" },
      ],
    });

    const { container } = render(<SliceWheelIcon graph={graph} colorKey={1} size={20} />);
    const root = container.querySelector("[data-slot='slice-wheel']") as HTMLElement;
    expect(root).toBeInTheDocument();
    expect(root.style.width).toBe("1.25rem");
    expect(root.style.height).toBe("1.25rem");
    expect(root.style.getPropertyValue("--peel")).toBe(PALETTE[1]!.blob);

    const petals = root.querySelectorAll("[data-petal-status]");
    expect(petals).toHaveLength(5);
    expect([...petals].map((el) => el.getAttribute("data-petal-status"))).toEqual([
      "done",
      "running",
      "running",
      "waiting_user",
      "pending",
    ]);
    // 同层并行阶段 s2 与 s3 之间只切半刀（果心相连）
    expect(root.querySelectorAll("[data-cut-joined='true']")).toHaveLength(1);
  });
});

describe("右栏果皮轨（Peel Track）：折叠卷、并行分轨与水果刀门禁", () => {
  it("连续已完成上游层默认卷成 N done，下游长链路默认折成 N next；点击各自展开，并行阶段分出 parA/parB 双股轨道", async () => {
    const user = userEvent.setup();
    const onOpenWorker = vi.fn();
    const graph = makeGraph({
      id: 2,
      title: "右栏任务流重做",
      nodes: [
        makeNode({ key: "n1", title: "梳理边界", status: "done", sortOrder: 0, workerIds: [10] }),
        makeNode({ key: "n2", title: "数据层", status: "done", sortOrder: 1, workerIds: [11] }),
        makeNode({ key: "n3", title: "前端卡片", status: "running", sortOrder: 2, activeWorkerId: 12, workerIds: [12] }),
        makeNode({ key: "n4", title: "连线布局", status: "running", sortOrder: 3, activeWorkerId: 13, workerIds: [13] }),
        makeNode({ key: "n5", title: "交叉审查", status: "pending", sortOrder: 4 }),
        makeNode({ key: "n6", title: "合并收尾", status: "pending", sortOrder: 5 }),
      ],
      edges: [
        { fromKey: "n1", toKey: "n2" },
        { fromKey: "n2", toKey: "n3" },
        { fromKey: "n2", toKey: "n4" },
        { fromKey: "n3", toKey: "n5" },
        { fromKey: "n4", toKey: "n5" },
        { fromKey: "n5", toKey: "n6" },
      ],
    });
    const workers = [
      makeWorker(30, { workerId: 10, ended: true, activity: "idle" }),
      makeWorker(31, { workerId: 11, ended: true, activity: "idle" }),
      makeWorker(32, { workerId: 12 }),
      makeWorker(33, { workerId: 13 }),
    ];

    render(
      <RightRail
        asks={[]}
        workers={workers}
        activeGraphs={[graph]}
        openWorkerId={null}
        layout="side"
        avatarKey={1}
        onOpenAsk={() => {}}
        onOpenWorker={onOpenWorker}
      />,
    );

    const graphGroup = screen.getByRole("region", { name: /^Task Graph$/ });
    expect(within(graphGroup).getByText("右栏任务流重做")).toBeInTheDocument();

    // 默认折叠为 2 done 与 2 next，中间露出正在并行的两股轨道
    const doneCoil = within(graphGroup).getByRole("button", { name: /2 done/ });
    const nextFold = within(graphGroup).getByRole("button", { name: /2 next/ });
    expect(doneCoil.querySelector("[data-peel-gutter='coil']")).toBeInTheDocument();
    expect(nextFold).toBeInTheDocument();
    expect(within(graphGroup).queryByText("梳理边界")).toBeNull();
    expect(within(graphGroup).queryByText("交叉审查")).toBeNull();

    // 并行阶段无重框，带 parA / parB 分合轨与 .status-shimmer 流光，点击打开对应 Piece 对话
    expect(graphGroup.querySelector("[data-peel-gutter='parA']")).toBeInTheDocument();
    expect(graphGroup.querySelector("[data-peel-gutter='parB']")).toBeInTheDocument();
    expect(within(graphGroup).getByText("前端卡片")).toHaveClass("status-shimmer");
    await user.click(within(graphGroup).getByRole("button", { name: /前端卡片/ }));
    expect(onOpenWorker).toHaveBeenCalledWith(32);

    // 点击 2 done 展开全部已完成步骤
    await user.click(doneCoil);
    expect(within(graphGroup).getByText("梳理边界")).toBeInTheDocument();
    expect(within(graphGroup).getByText("数据层")).toBeInTheDocument();

    // 点击 2 next 展开全部下游未解锁步骤
    await user.click(nextFold);
    expect(within(graphGroup).getByText("交叉审查")).toBeInTheDocument();
    expect(within(graphGroup).getByText("合并收尾")).toBeInTheDocument();
  });

  it("waiting_user 门禁卡住微缩水果刀（useId 唯一渐变）并挂出果冻拍板卡：支持一键点选、选项+备注、纯备注提交，拍板后刀收起并显示所选简称", async () => {
    const user = userEvent.setup();
    const calls: { url: string; body: DecideTaskNodeRequest }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = JSON.parse(String(init?.body ?? "{}")) as DecideTaskNodeRequest;
      calls.push({ url, body });
      return jsonResponse({ graph: makeGraph({ id: 5, title: "ok" }), messageId: 100 });
    });

    const buildGateGraph = (id: number, updatedAt: number, decidedChoice: string | null = null): TaskGraph =>
      makeGraph({
        id,
        updatedAt,
        title: `同步任务 ${id}`,
        nodes: [
          makeNode({ key: "survey", title: "调研差异", status: "done", sortOrder: 0, workerIds: [10] }),
          makeNode({
            key: "gate-sync",
            title: "确认同步范围",
            kind: "gate",
            status: decidedChoice === null ? "waiting_user" : "done",
            sortOrder: 1,
            gateQuestion: "冲突的两个配置项如何处理？",
            gateSummaryMd: "其中 4 项完全一致，2 项存在参数差异。",
            gateOptions: ["全量同步并先备份", "仅同步无冲突项"],
            gateRecommended: "全量同步并先备份",
            gateAskMessageId: 77,
            decision:
              decidedChoice === null
                ? null
                : { choice: decidedChoice, note: null, decidedBy: "user", decidedAt: 9_000 },
          }),
          makeNode({ key: "impl", title: "执行同步", status: decidedChoice === null ? "pending" : "running", sortOrder: 2 }),
        ],
        edges: [
          { fromKey: "survey", toKey: "gate-sync" },
          { fromKey: "gate-sync", toKey: "impl" },
        ],
      });

    // 同屏渲染两个 waiting_user 任务以验证微缩水果刀渐变 ID 唯一不冲突
    const { rerender } = render(
      <RightRail
        asks={[]}
        workers={[]}
        activeGraphs={[buildGateGraph(5, 5_000), buildGateGraph(6, 4_000)]}
        openWorkerId={null}
        layout="side"
        avatarKey={1}
        onOpenAsk={() => {}}
        onOpenWorker={() => {}}
      />,
    );

    const knives = document.querySelectorAll("[data-slot='knife-avatar']");
    expect(knives.length).toBeGreaterThanOrEqual(2);
    const gradIds = new Set(
      [...knives].map((el) => el.querySelector("linearGradient")?.getAttribute("id")).filter(Boolean),
    );
    expect(gradIds.size).toBe(knives.length);

    // 1) 一键点选推荐项
    const cards = screen.getAllByTestId("peel-gate-card");
    const firstCard = cards[0]!;
    expect(firstCard).toHaveClass("rounded-2xl", "border-primary", "bg-jelly");
    await user.click(within(firstCard).getByRole("button", { name: /全量同步并先备份/ }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe("/api/task-graphs/5/nodes/gate-sync/decide");
    expect(calls[0]!.body).toMatchObject({ choice: "全量同步并先备份" });
    expect(typeof calls[0]!.body.clientId).toBe("string");

    // 2) 点选 + 补充备注
    const secondCard = cards[1]!;
    await user.click(within(secondCard).getByRole("button", { name: "Add note" }));
    const noteInput = within(secondCard).getByPlaceholderText("Add a note, or type a custom reply…");
    await user.type(noteInput, "备份放到 .bak 目录");
    await user.click(within(secondCard).getByRole("button", { name: /仅同步无冲突项/ }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.url).toBe("/api/task-graphs/6/nodes/gate-sync/decide");
    expect(calls[1]!.body).toMatchObject({ choice: "仅同步无冲突项", note: "备份放到 .bak 目录" });

    // 3) 自定义备注直接提交（choice: null）
    await user.clear(noteInput);
    await user.type(noteInput, "今天先不改生产目录");
    await user.click(within(secondCard).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]!.body).toMatchObject({ choice: null, note: "今天先不改生产目录" });

    // 拍板通过后：水果刀收起，门禁节点收合为紧凑单行并在右侧展示所选简称
    rerender(
      <RightRail
        asks={[]}
        workers={[]}
        activeGraphs={[buildGateGraph(5, 6_000, "全量同步并先备份")]}
        openWorkerId={null}
        layout="side"
        avatarKey={1}
        onOpenAsk={() => {}}
        onOpenWorker={() => {}}
      />,
    );
    expect(screen.queryByTestId("peel-gate-card")).toBeNull();
    expect(document.querySelector("[data-slot='knife-avatar']")).toBeNull();
    expect(screen.getByText("确认同步范围")).toBeInTheDocument();
    expect(screen.getByText("全量同步并先备份")).toBeInTheDocument();
  });

  it("多任务排序与手风琴：紧急任务（waiting_user / attention）排最前自动展开，后台任务收成带切面轮的单行标题，点击手风琴切换", async () => {
    const user = userEvent.setup();
    const bgGraph = makeGraph({
      id: 10,
      title: "后台签名流水线",
      updatedAt: 9_000,
      nodes: [
        makeNode({ key: "a", title: "生成证书", status: "done", sortOrder: 0 }),
        makeNode({ key: "b", title: "签名校验", status: "running", sortOrder: 1 }),
      ],
      edges: [{ fromKey: "a", toKey: "b" }],
    });
    const urgentGraph = makeGraph({
      id: 11,
      title: "紧急权限确认",
      updatedAt: 3_000,
      nodes: [
        makeNode({
          key: "g",
          title: "确认权限模型",
          kind: "gate",
          status: "waiting_user",
          gateOptions: ["RBAC", "ABAC"],
        }),
      ],
    });

    render(
      <RightRail
        asks={[]}
        workers={[]}
        activeGraphs={[bgGraph, urgentGraph]}
        openWorkerId={null}
        layout="side"
        avatarKey={2}
        onOpenAsk={() => {}}
        onOpenWorker={() => {}}
      />,
    );

    const headers = screen.getAllByTestId("peel-graph-toggle");
    expect(headers.map((h) => h.textContent)).toEqual(["紧急权限确认", "后台签名流水线"]);
    expect(headers[0]).toHaveAttribute("aria-expanded", "true");
    expect(headers[1]).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("确认权限模型")).toBeInTheDocument();
    expect(screen.queryByText("签名校验")).toBeNull();

    // 点击后台任务标题：手风琴展开后台任务，收起前一个任务
    await user.click(headers[1]!);
    expect(headers[1]).toHaveAttribute("aria-expanded", "true");
    expect(headers[0]).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("签名校验")).toBeInTheDocument();
  });

  it("同源去重与兼容：门禁 ask 不进 Needs You，绑图 Worker 不进 Pieces，独立 ask 与独立 Worker 照旧渲染", () => {
    const gateAsk: Message = makeMessage({
      id: 101,
      text: "确认门禁问题",
      meta: { needsUser: true, options: ["A", "B"], gateRef: { graphId: 20, nodeKey: "gate-1" } },
    });
    const freeAsk: Message = makeMessage({
      id: 102,
      text: "独立小问题",
      meta: { needsUser: true },
    });
    const boundWorker = makeWorker(31, { workerId: 11, title: "图内节点活" });
    const unboundWorker = makeWorker(32, { workerId: 12, title: "独立零散活" });

    const activeGraph = makeGraph({
      id: 20,
      title: "主线任务",
      nodes: [
        makeNode({ key: "step-1", title: "编码步骤", status: "running", activeWorkerId: 11, workerIds: [11] }),
        makeNode({
          key: "gate-1",
          title: "确认门禁",
          kind: "gate",
          status: "waiting_user",
          gateOptions: ["A", "B"],
          gateAskMessageId: 101,
        }),
      ],
      edges: [{ fromKey: "step-1", toKey: "gate-1" }],
    });

    render(
      <RightRail
        asks={[gateAsk, freeAsk]}
        workers={[boundWorker, unboundWorker]}
        activeGraphs={[activeGraph]}
        openWorkerId={null}
        layout="side"
        avatarKey={0}
        onOpenAsk={() => {}}
        onOpenWorker={() => {}}
      />,
    );

    const asksRegion = screen.getByRole("region", { name: /^Needs You$/ });
    expect(within(asksRegion).getByText("独立小问题")).toBeInTheDocument();
    expect(within(asksRegion).queryByText("确认门禁问题")).toBeNull();

    const piecesRegion = screen.getByRole("region", { name: /^Pieces$/ });
    expect(within(piecesRegion).getByText("独立零散活")).toBeInTheDocument();
    expect(within(piecesRegion).queryByText("图内节点活")).toBeNull();
  });

  it("Completed 展开时经 @tanstack/react-query 游标拉取历史任务图，点开历史图或右上角 Zoom 打开横向全览弹窗 TaskGraphDialog", async () => {
    const user = userEvent.setup();
    const onOpenWorker = vi.fn();
    const fetchUrls: string[] = [];

    const hist1 = makeGraph({
      id: 50,
      title: "历史五步改版",
      status: "completed",
      completedAt: 20_000,
      nodes: [
        makeNode({ key: "h1", title: "数据库迁移", status: "done", sortOrder: 0, workerIds: [91] }),
        makeNode({
          key: "h2",
          title: "上线前门禁",
          kind: "gate",
          status: "done",
          sortOrder: 1,
          decision: { choice: "立即灰度", note: null, decidedBy: "user", decidedAt: 19_000 },
        }),
      ],
      edges: [{ fromKey: "h1", toKey: "h2" }],
    });
    const hist2 = makeGraph({
      id: 40,
      title: "更早的架构清理",
      status: "completed",
      completedAt: 15_000,
      nodes: [makeNode({ key: "c1", title: "删除死代码", status: "done", sortOrder: 0 })],
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      fetchUrls.push(url);
      const page: TaskGraphsPage = url.includes("before=50")
        ? { graphs: [hist2], hasMore: false }
        : { graphs: [hist1], hasMore: true };
      return jsonResponse(page);
    });

    const liveGraph = makeGraph({
      id: 60,
      title: "正在进行的任务",
      nodes: [
        makeNode({ key: "l1", title: "第一步", status: "done", sortOrder: 0, workerIds: [81] }),
        makeNode({ key: "l2", title: "第二步", status: "running", sortOrder: 1, activeWorkerId: 82, workerIds: [82] }),
      ],
      edges: [{ fromKey: "l1", toKey: "l2" }],
    });

    render(
      <RightRail
        asks={[]}
        workers={[
          makeWorker(101, { workerId: 81, ended: true, activity: "idle" }),
          makeWorker(102, { workerId: 82 }),
          makeWorker(103, { workerId: 91, ended: true, activity: "idle", title: "历史图内部活" }),
          makeWorker(104, { workerId: 99, ended: true, activity: "idle", title: "独立已收工活" }),
        ]}
        activeGraphs={[liveGraph]}
        completedGraphCount={2}
        projectId={1}
        openWorkerId={null}
        layout="side"
        avatarKey={3}
        onOpenAsk={() => {}}
        onOpenWorker={onOpenWorker}
      />,
    );

    // Completed 折叠时不发任何请求
    expect(fetchUrls).toHaveLength(0);

    // 点击活跃任务头右上角 Zoom 打开横向 LR 全览弹窗
    await user.click(screen.getByRole("button", { name: "Zoom" }));
    const liveDialog = screen.getByRole("dialog", { name: "正在进行的任务" });
    expect(liveDialog.querySelector("[data-rankdir='LR']")).toBeInTheDocument();
    await user.click(within(liveDialog).getByRole("button", { name: /#82/ }));
    expect(onOpenWorker).toHaveBeenCalledWith(102);

    // 展开 Completed：触发首屏 GET /api/projects/1/task-graphs?status=history
    const completedRegion = screen.getByRole("region", { name: /^Completed$/ });
    await user.click(within(completedRegion).getByRole("heading").querySelector("button")!);
    await waitFor(() => expect(fetchUrls).toContain("/api/projects/1/task-graphs?status=history&limit=20"));
    expect(await within(completedRegion).findByText("历史五步改版")).toBeInTheDocument();
    expect(within(completedRegion).getByText("独立已收工活")).toBeInTheDocument();
    // 已归属 hist1 的 Worker #91 不重复列出
    expect(within(completedRegion).queryByText("历史图内部活")).toBeNull();

    // 点击 Load more 游标翻下一页
    await user.click(within(completedRegion).getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(fetchUrls).toContain("/api/projects/1/task-graphs?status=history&before=50&limit=20"));
    expect(await within(completedRegion).findByText("更早的架构清理")).toBeInTheDocument();

    // 点击历史任务图行：打开全览弹窗回看完整拓扑与历史拍板
    await user.click(within(completedRegion).getByRole("button", { name: /历史五步改版/ }));
    const histDialog = screen.getByRole("dialog", { name: "历史五步改版" });
    expect(within(histDialog).getByText("立即灰度")).toBeInTheDocument();
  });

  beforeAll(() => {
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
  });

  it("PiecesDrawer 透传新可选 props 时正常渲染果皮轨并在点击 Piece 时自动收起抽屉", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onOpenWorker = vi.fn();
    const graph = makeGraph({
      id: 70,
      title: "移动端抽屉任务",
      nodes: [makeNode({ key: "m1", title: "抽屉步骤", status: "running", activeWorkerId: 15, workerIds: [15] })],
    });

    render(
      <PiecesDrawer
        open
        onOpenChange={onOpenChange}
        asks={[]}
        workers={[makeWorker(35, { workerId: 15 })]}
        activeGraphs={[graph]}
        openWorkerId={null}
        avatarKey={0}
        onOpenAsk={() => {}}
        onOpenWorker={onOpenWorker}
      />,
    );

    expect(await screen.findByText("移动端抽屉任务")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /抽屉步骤/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenWorker).toHaveBeenCalledWith(35);
  });

  it("流式打字爆炸半径守卫：挂载 activeGraphs 后连续 8 帧 streamingText 更新，RightRail 重渲染次数严格为 0", () => {
    const g1 = makeGraph({
      id: 80,
      projectId: 1,
      pmId: 1,
      conversationId: 1,
      title: "果皮轨流式守卫",
      nodes: [
        makeNode({ key: "n1", title: "调研", status: "done", sortOrder: 0, workerIds: [3] }),
        makeNode({
          key: "n2",
          title: "确认范围",
          kind: "gate",
          status: "waiting_user",
          sortOrder: 1,
          gateOptions: ["继续", "暂停"],
          gateRecommended: "继续",
        }),
      ],
      edges: [{ fromKey: "n1", toKey: "n2" }],
    });

    let state: HubState = {
      ...initialState,
      phase: "ready",
      seq: 10,
      pms: [makePm({ id: 1, name: "小林" })],
      projects: [makeProject({ id: 1, pmId: 1, conversationId: 1 })],
      conversations: {
        1: makeConvSnapshot(
          [
            makeWorkerLine({ id: 3, conversationId: 1, line: { workerId: 3, workerConversationId: 30, title: "调研", event: "ended" } }),
            makeWorkerLine({ id: 4, conversationId: 1, line: { workerId: 4, workerConversationId: 31, title: "零散修复", event: "started" } }),
          ],
          { conversation: { id: 1, pmId: 1, title: "小林" } },
        ),
        30: makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 30, pmId: 1, title: "调研" }) }),
        31: makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 31, pmId: 1, title: "零散修复" }) }),
      },
      sessions: [
        makeSession({ sessionId: 10, conversationId: 1, pmId: 1, status: "running", activity: "working", step: { type: "text" } }),
        makeSession({ sessionId: 310, conversationId: 31, status: "running", activity: "working" }),
      ],
      activeTaskGraphs: [g1],
    };

    const noop = () => {};
    type MemoTarget = { type: (...args: unknown[]) => unknown };
    const rightRailSpy = vi.spyOn(RightRailMod.RightRail as unknown as MemoTarget, "type");

    const renderWith = (s: HubState) => (
      <RightRail
        asks={pendingAsks(s, 1)}
        workers={workersOf(s, 1)}
        activeGraphs={activeGraphsOf(s, 1)}
        projectId={1}
        openWorkerId={null}
        layout="side"
        avatarKey={1}
        onOpenAsk={noop}
        onOpenWorker={noop}
      />
    );

    const { rerender } = render(renderWith(state));
    const decisions0 = pendingDecisionsOf(state, 1);
    const unbound0 = unboundWorkersOf(state, 1);
    rightRailSpy.mockClear();

    for (let i = 1; i <= 8; i++) {
      state = applyChange(
        state,
        sessionChange(
          20 + i,
          makeSession({
            sessionId: 10,
            conversationId: 1,
            pmId: 1,
            status: "running",
            activity: "working",
            step: { type: "text" },
            streamingText: "流式增量".repeat(i),
          }),
        ),
      );
      expect(pendingDecisionsOf(state, 1)).toBe(decisions0);
      expect(unboundWorkersOf(state, 1)).toBe(unbound0);
      rerender(renderWith(state));
    }

    expect(rightRailSpy).toHaveBeenCalledTimes(0);
    rightRailSpy.mockRestore();
  });
});

describe("审查回归（PR #274）：几何边界、编号不混用、防重入与历史翻页上限", () => {
  const VALID_D = /^[MLAZ0-9 .\-]+$/;

  it.each([
    ["0 个阶段", 0, "chain", 0],
    ["1 个阶段", 1, "chain", 0],
    ["奇数 7 个阶段链路", 7, "chain", 0],
    ["超大 32 个阶段链路", 32, "chain", 0],
    ["互不相连 5 个独立阶段", 5, "isolated", 0],
    ["互不相连 32 个独立阶段", 32, "isolated", 0],
    ["一分为 4 股并行", 5, "fork", 3],
    ["一分为 31 股并行", 32, "fork", 30],
  ] as const)("SliceWheelIcon：%s 时所有 path d 合法、无 NaN/Infinity", (_name, count, shape, joinedCuts) => {
    const nodes = Array.from({ length: count }, (_, i) =>
      makeNode({ key: `n${i}`, title: `阶段 ${i}`, status: i % 3 === 0 ? "done" : i % 3 === 1 ? "running" : "pending", sortOrder: i }),
    );
    const edges =
      shape === "chain"
        ? nodes.slice(1).map((n, i) => ({ fromKey: nodes[i]!.key, toKey: n.key }))
        : shape === "fork"
          ? nodes.slice(1).map((n) => ({ fromKey: nodes[0]!.key, toKey: n.key }))
          : [];
    const { container } = render(<SliceWheelIcon graph={{ nodes, edges }} size={20} />);
    const root = container.querySelector("[data-slot='slice-wheel']") as HTMLElement;
    expect(root.style.width).toBe("1.25rem");
    expect(root.querySelectorAll("[data-petal-status]")).toHaveLength(count);
    for (const el of root.querySelectorAll("path, circle")) {
      const d = el.getAttribute("d");
      if (d !== null) {
        expect(d).not.toMatch(/NaN|Infinity/);
        expect(d).toMatch(VALID_D);
      }
      expect(el.outerHTML).not.toMatch(/NaN|Infinity/);
    }
    // 只有同一连通子图同一并行层的相邻瓣才半刀相连；互不相连的独立阶段刀口切到底
    expect(root.querySelectorAll("[data-cut-joined='true']")).toHaveLength(joinedCuts);
  });

  it("Worker 拿不到 workerId 时绝不拿 conversationId 顶替：撞号的零散 Worker 照旧留在 Pieces，图内节点也不会误链到它", () => {
    // 图内节点绑的是 Worker #12；另一个零散 Worker 的对话编号恰好也是 12，但没有 workerId
    const stray = makeWorker(12, { workerId: undefined, title: "撞号零散活" });
    const graph = makeGraph({
      id: 70,
      title: "撞号检测",
      nodes: [makeNode({ key: "s1", title: "图内步骤", status: "running", activeWorkerId: 12, workerIds: [12] })],
    });
    render(
      <RightRail
        asks={[]}
        workers={[stray]}
        activeGraphs={[graph]}
        openWorkerId={null}
        layout="side"
        avatarKey={0}
        onOpenAsk={() => {}}
        onOpenWorker={() => {}}
      />,
    );
    const piecesRegion = screen.getByRole("region", { name: /^Pieces$/ });
    expect(within(piecesRegion).getByText("撞号零散活")).toBeInTheDocument();
    const graphRegion = screen.getByRole("region", { name: /^Task Graph$/ });
    expect(within(graphRegion).queryByRole("button", { name: "图内步骤" })).toBeNull();
    expect(within(graphRegion).getByText("#12")).toBeInTheDocument();
  });

  it("unboundWorkersOf：没有汇报行（拿不到 workerId）的 Worker 不因对话编号撞上图内 Worker 编号而被误吞", () => {
    const graph = makeGraph({
      id: 71,
      title: "撞号检测",
      nodes: [makeNode({ key: "s1", title: "图内步骤", status: "running", activeWorkerId: 40, workerIds: [40] })],
    });
    const state: HubState = {
      ...initialState,
      phase: "ready",
      seq: 10,
      pms: [makePm({ id: 1, name: "小林" })],
      projects: [makeProject({ id: 1, pmId: 1, conversationId: 1 })],
      conversations: {
        1: makeConvSnapshot(
          [makeWorkerLine({ id: 5, conversationId: 1, line: { workerId: 40, workerConversationId: 41, title: "图内活", event: "started" } })],
          { conversation: { id: 1, pmId: 1, title: "小林" } },
        ),
        40: makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 40, pmId: 1, title: "刚派出的零散活" }) }),
        41: makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 41, pmId: 1, title: "图内活" }) }),
      },
      activeTaskGraphs: [graph],
    };
    const titles = unboundWorkersOf(state, 1).map((w) => w.title);
    expect(titles).toContain("刚派出的零散活");
    expect(titles).not.toContain("图内活");
  });

  it("门禁拍板同步防重入：同一帧连点只发一次；失败显示错误，重试沿用同一个 clientId", async () => {
    const calls: DecideTaskNodeRequest[] = [];
    let fail = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body ?? "{}")) as DecideTaskNodeRequest);
      if (fail) return jsonResponse({ error: "守护进程忙", code: "internal" }, 500);
      return jsonResponse({ graph: makeGraph({ id: 80, title: "ok" }), messageId: 1 });
    });
    const graph = makeGraph({
      id: 80,
      title: "防重入",
      nodes: [
        makeNode({
          key: "g",
          title: "确认",
          kind: "gate",
          status: "waiting_user",
          gateOptions: ["甲", "乙"],
          gateRecommended: "甲",
        }),
      ],
    });
    render(
      <RightRail
        asks={[]}
        workers={[]}
        activeGraphs={[graph]}
        openWorkerId={null}
        layout="side"
        avatarKey={0}
        onOpenAsk={() => {}}
        onOpenWorker={() => {}}
      />,
    );
    const card = screen.getByTestId("peel-gate-card");
    const rec = within(card).getByRole("button", { name: /甲/ });
    fireEvent.click(rec);
    fireEvent.click(rec);
    fireEvent.click(within(card).getByRole("button", { name: /乙/ }));
    expect(await within(card).findByRole("alert")).toBeInTheDocument();
    expect(calls).toHaveLength(1);

    fail = false;
    await waitFor(() => expect(within(card).getByRole("button", { name: /甲/ })).toBeEnabled());
    fireEvent.click(within(card).getByRole("button", { name: /甲/ }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.clientId).toBe(calls[0]!.clientId);
    await waitFor(() => expect(within(card).queryByRole("alert")).toBeNull());
  });

  it("全览弹窗 Skip step / Cancel graph 同步防重入：同一帧连点只发一次", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      return jsonResponse({ graph: makeGraph({ id: 90, title: "ok" }) });
    });
    const graph = makeGraph({
      id: 90,
      title: "跳过检测",
      nodes: [
        makeNode({ key: "a", title: "第一步", status: "ready", sortOrder: 0 }),
        makeNode({ key: "b", title: "第二步", status: "pending", sortOrder: 1 }),
      ],
      edges: [{ fromKey: "a", toKey: "b" }],
    });
    render(
      <TaskGraphDialog graph={graph} open onOpenChange={() => {}} workers={[]} onOpenWorker={() => {}} />,
    );
    const dialog = screen.getByRole("dialog", { name: "跳过检测" });
    const [skipA, skipB] = within(dialog).getAllByRole("button", { name: "Skip step" });
    fireEvent.click(skipA!);
    fireEvent.click(skipB!);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel graph" }));
    await waitFor(() => expect(urls).toHaveLength(1));
    expect(urls[0]).toBe("/api/task-graphs/90/nodes/a/skip");

    // Cancel graph 只弹出二次确认、不发请求（第 12.1 条）；确认按钮同一帧连点也只发一次
    const confirm = await screen.findByRole("dialog", { name: "Cancel this task graph?" });
    expect(urls).toHaveLength(1);
    const confirmButton = within(confirm).getByRole("button", { name: "Cancel graph" });
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);
    await waitFor(() => expect(urls).toHaveLength(2));
    expect(urls[1]).toBe("/api/task-graphs/90/cancel");
  });

  it(`Completed 历史任务图翻到 ${MAX_COMPLETED_GRAPH_PAGES} 页即停：不再显示 Load more，也不会把最新的第一页挤掉`, async () => {
    const user = userEvent.setup();
    let nextId = 10_000;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const id = nextId--;
      const page: TaskGraphsPage = {
        graphs: [makeGraph({ id, title: `历史图 ${id}`, status: "completed", completedAt: id })],
        hasMore: true,
      };
      return jsonResponse(page);
    });
    render(
      <RightRail
        asks={[]}
        workers={[]}
        completedGraphCount={999}
        projectId={1}
        openWorkerId={null}
        layout="side"
        avatarKey={0}
        onOpenAsk={() => {}}
        onOpenWorker={() => {}}
      />,
    );
    const completedRegion = screen.getByRole("region", { name: /^Completed$/ });
    await user.click(within(completedRegion).getByRole("heading").querySelector("button")!);
    expect(await within(completedRegion).findByText("历史图 10000")).toBeInTheDocument();
    for (let page = 2; page <= MAX_COMPLETED_GRAPH_PAGES; page++) {
      await user.click(await within(completedRegion).findByRole("button", { name: "Load more" }));
      expect(await within(completedRegion).findByText(`历史图 ${10_001 - page}`)).toBeInTheDocument();
    }
    expect(within(completedRegion).queryByRole("button", { name: "Load more" })).toBeNull();
    expect(within(completedRegion).getByText("历史图 10000")).toBeInTheDocument();
  });
});

describe("果皮轨按真实连通关系排布：独立子图不假连、多起点合流无断头线", () => {
  const GUTTER_H = 32;
  const GUTTER_CY = 16;

  /** 解析果皮轨槽里每段轨道两端的坐标（M…V… 直线或 M…C… 弧线）。 */
  function pathEnds(d: string): Array<[number, number]> {
    const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    const start: [number, number] = [nums[0]!, nums[1]!];
    if (/^M[\d. -]+V[\d.]+$/.test(d)) return [start, [nums[0]!, nums[2]!]];
    return [start, [nums.at(-2)!, nums.at(-1)!]];
  }

  /** 一行轨道槽的上口、下口（线段触到行顶 / 行底的 x）与悬空端点（既不在行边也不在圆点上）。 */
  function gutterPorts(svg: Element) {
    const kind = svg.getAttribute("data-peel-gutter")!;
    if (kind === "coil") return { kind, top: [] as number[], bottom: [11], loose: [] as string[] };
    const dots = [...svg.querySelectorAll("circle")].map((c) => Number(c.getAttribute("cx")));
    const top = new Set<number>();
    const bottom = new Set<number>();
    const loose: string[] = [];
    for (const p of svg.querySelectorAll("path")) {
      for (const [x, y] of pathEnds(p.getAttribute("d")!)) {
        if (y === 0) top.add(x);
        else if (y === GUTTER_H) bottom.add(x);
        else if (!(y === GUTTER_CY && dots.includes(x))) loose.push(`${x},${y}`);
      }
    }
    return { kind, top: [...top].toSorted(), bottom: [...bottom].toSorted(), loose };
  }

  /** 子图内上下相邻两行的轨道口逐一对上，首行无进入线、末行无伸出线，任何线段都不悬空。 */
  function expectClosedTrack(component: Element) {
    const rows = [...component.querySelectorAll("svg[data-peel-gutter]")].map(gutterPorts);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.top).toEqual([]);
    expect(rows.at(-1)!.bottom).toEqual([]);
    rows.forEach((row, i) => {
      expect(row.loose, `第 ${i + 1} 行（${row.kind}）有悬空线段`).toEqual([]);
      if (i > 0) expect(row.top, `第 ${i} 行与第 ${i + 1} 行的轨道没接上`).toEqual(rows[i - 1]!.bottom);
    });
    return rows;
  }

  function renderRail(graph: TaskGraph, workers: WorkerEntry[] = []) {
    render(
      <RightRail
        asks={[]}
        workers={workers}
        activeGraphs={[graph]}
        openWorkerId={null}
        layout="side"
        avatarKey={1}
        onOpenAsk={() => {}}
        onOpenWorker={() => {}}
      />,
    );
    return screen.getByRole("region", { name: /^Task Graph$/ });
  }

  it("一张图含 3 个互不相连的子图（独立单步 + 三步含门禁链 + 双起点合流）：分组排布，子图之间不画任何假连线", async () => {
    const user = userEvent.setup();
    const graph = makeGraph({
      id: 430,
      title: "模型统一保存、总助面板与手机设置",
      nodes: [
        makeNode({ key: "p430", title: "资料页模型选择统一保存", status: "running", sortOrder: 0, activeWorkerId: 430, workerIds: [430] }),
        makeNode({ key: "p431", title: "Fable 5.2 重规划总助面板", status: "running", sortOrder: 1, activeWorkerId: 431, workerIds: [431] }),
        makeNode({ key: "p432", title: "手机软键盘避让与新建弹窗适配", status: "running", sortOrder: 2, activeWorkerId: 432, workerIds: [432] }),
        makeNode({ key: "p433", title: "抽离共用设置模型层与原语", status: "running", sortOrder: 3, activeWorkerId: 433, workerIds: [433] }),
        makeNode({ key: "ok", title: "确认总助面板重设计方案", kind: "gate", status: "pending", sortOrder: 4 }),
        makeNode({ key: "mobile", title: "手机二级钻取设置页与验收", status: "pending", sortOrder: 5 }),
        makeNode({ key: "impl", title: "实现新版总助工作台", status: "pending", sortOrder: 6 }),
      ],
      edges: [
        { fromKey: "p431", toKey: "ok" },
        { fromKey: "ok", toKey: "impl" },
        { fromKey: "p432", toKey: "mobile" },
        { fromKey: "p433", toKey: "mobile" },
      ],
    });
    const workers = [430, 431, 432, 433].map((id) => makeWorker(id + 100, { workerId: id }));
    const graphGroup = renderRail(graph, workers);

    // 三步链尾部两层未解锁照旧折成 2 next，且只折本子图的
    await user.click(within(graphGroup).getByRole("button", { name: /2 next/ }));

    const components = [...graphGroup.querySelectorAll("[data-peel-component]")];
    expect(components.map((c) => c.textContent)).toEqual([
      expect.stringMatching(/^资料页模型选择统一保存#430$/),
      expect.stringMatching(/^Fable 5\.2 重规划总助面板#431确认总助面板重设计方案实现新版总助工作台$/),
      expect.stringMatching(/^手机软键盘避让与新建弹窗适配#432抽离共用设置模型层与原语#433手机二级钻取设置页与验收$/),
    ]);

    const kinds = components.map((c) => expectClosedTrack(c).map((r) => r.kind));
    expect(kinds).toEqual([["station"], ["station", "station", "station"], ["parA", "parB", "station"]]);
    // 独立单步只有一颗圆点，上下都不连线
    expect(components[0]!.querySelectorAll("path")).toHaveLength(0);

    // 切面轮：只有双起点合流那一层的两瓣果心相连，其余刀口切到底
    const wheel = graphGroup.querySelector("[data-slot='slice-wheel']")!;
    expect(wheel.querySelectorAll("[data-cut-joined='true']")).toHaveLength(1);
  });

  it.each([2, 3])("首层 %i 个无上游并行起点合流到同一下游：右轨逐行接上、无断头悬空线", (roots) => {
    const nodes = [
      ...Array.from({ length: roots }, (_, i) =>
        makeNode({ key: `r${i}`, title: `起点 ${i}`, status: "running", sortOrder: i }),
      ),
      makeNode({ key: "join", title: "合流验收", status: "pending", sortOrder: roots }),
    ];
    const edges = nodes.slice(0, roots).map((n) => ({ fromKey: n.key, toKey: "join" }));
    const graphGroup = renderRail(makeGraph({ id: 500 + roots, title: "多起点合流", nodes, edges }));

    const components = graphGroup.querySelectorAll("[data-peel-component]");
    expect(components).toHaveLength(1);
    const rows = expectClosedTrack(components[0]!);
    expect(rows.map((r) => r.kind)).toEqual(
      roots === 2 ? ["parA", "parB", "station"] : ["parA", "parMid", "parB", "station"],
    );
    // 没有共同上游：首行不画分叉弧线，第二个起点的右轨上方也没有进入线
    expect(rows[0]!.top).toEqual([]);
    expect(rows[1]!.top).toEqual([11]);
    // 每个起点都合流进主轨，最后一行从右轨弯回主轨接上下游
    expect(rows[roots - 1]!.bottom).toEqual([11]);
  });

  it.each([
    [
      "标准分叉合流菱形",
      [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]],
      ["station", "parA", "parB", "station"],
      true,
    ],
    ["分叉后两股都收尾（无下游）", [["a", "b"], ["a", "c"]], ["station", "parA", "parB"], false],
    ["分叉后右股收尾、左股接下游", [["a", "b"], ["a", "c"], ["b", "d"]], ["station", "parA", "parB", "station"], false],
    ["分叉后左股收尾、右股接下游", [["a", "b"], ["a", "c"], ["c", "d"]], ["station", "parA", "parB", "station"], true],
    [
      "一分三股再合流",
      [["a", "b"], ["a", "c"], ["a", "e"], ["b", "d"], ["c", "d"], ["e", "d"]],
      ["station", "parA", "parMid", "parB", "station"],
      true,
    ],
  ] as const)("单连通子图：%s 照常分轨，轨道逐行接上不悬空", (_name, pairs, expectedKinds, parLaneMerges) => {
    const keys = [...new Set(pairs.flat())].toSorted();
    const nodes = keys.map((key, i) =>
      makeNode({ key, title: `阶段 ${key}`, status: key === "a" ? "done" : key === "d" ? "pending" : "running", sortOrder: i }),
    );
    const edges = pairs.map(([fromKey, toKey]) => ({ fromKey, toKey }));
    const graphGroup = renderRail(makeGraph({ id: 600, title: "单连通", nodes, edges }));

    const components = graphGroup.querySelectorAll("[data-peel-component]");
    expect(components).toHaveLength(1);
    const rows = expectClosedTrack(components[0]!);
    expect(rows.map((r) => r.kind)).toEqual(expectedKinds);
    // 有共同上游：首个并行行从主轨顶部弧线分出右轨
    const parA = components[0]!.querySelector("[data-peel-gutter='parA']")!;
    expect([...parA.querySelectorAll("path")].some((p) => p.getAttribute("d")!.startsWith("M11 0C"))).toBe(true);
    // 右轨上的阶段都收尾（出度 0）时，不画弯回主轨的假合流弧线
    const parB = components[0]!.querySelector("[data-peel-gutter='parB']")!;
    const parBMerges = [...parB.querySelectorAll("path")].some((p) => p.getAttribute("d")!.startsWith("M29 16C"));
    expect(parBMerges).toBe(parLaneMerges);
  });
});
