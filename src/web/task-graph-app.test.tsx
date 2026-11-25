// App 顶层接通右栏果皮轨（docs/ui-standard.md 第 12 / 12.1 条）：桌面右栏、手机抽屉都拿到当前项目的活跃任务图，
// 绑图 Piece 与门禁提问去重；拍板、取消走当前设备的接口（DeviceScope），跨设备看远端项目经理时发到 /d/<设备>/...；
// Cancel graph 要二次确认；连续流式帧里右栏零重画。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo, StateSnapshot, TaskGraph, TaskNode } from "../shared/index.ts";
import { App } from "./App.tsx";
import * as ActiveTabMod from "./components/ActiveTab.tsx";
import { TaskGraphDialog } from "./components/TaskGraphDialog.tsx";
import {
  FakeApi,
  changeOf,
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
  messageChange,
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

const sidePanel = () => screen.getByRole("complementary", { name: "Work panel" });

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function bootSingle(snapshot: StateSnapshot, configure?: (api: FakeApi) => void) {
  window.history.replaceState(null, "", "/#/c/1");
  const api = new FakeApi(snapshot);
  configure?.(api);
  api.install();
  installFakeWebSocket();
  render(<App />);
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  act(() => FakeWebSocket.last.open());
  return { api, ws: FakeWebSocket.last };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("桌面右栏：App 接通工作面板任务图画布", () => {
  it("渲染当前项目的活跃任务图与单独 Workers；绑图 Worker 不重复列出，无 Needs You 组；点节点进那个 Worker 的对话", async () => {
    const user = userEvent.setup();
    await bootSingle(graphSnapshot());
    const rail = await waitFor(sidePanel);

    const graphSection = within(rail).getByRole("region", { name: "发布流水线" });
    expect(within(graphSection).getByText("发布流水线")).toBeInTheDocument();
    expect(within(graphSection).getByText("0/2")).toBeInTheDocument();
    expect(within(graphSection).getByRole("button", { name: /确认上线/ })).toBeInTheDocument();
    expect(within(graphSection).queryByTestId("peel-gate-card")).toBeNull();
    expect(within(rail).queryByRole("region", { name: /^Needs You$/ })).toBeNull();

    const workersSection = within(rail).getByRole("region", { name: "Workers" });
    expect(within(workersSection).getByRole("button", { name: /零散的活/ })).toBeInTheDocument();
    expect(within(workersSection).queryByRole("button", { name: /绑图的活/ })).toBeNull();

    await user.click(within(graphSection).getByRole("button", { name: /构建产物/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/w/30"));
  });

  it("keeps keyboard focus across the Info route and exposes a panel for every tab", async () => {
    const user = userEvent.setup();
    await bootSingle(graphSnapshot());
    const active = await within(sidePanel()).findByRole("tab", { name: /^Active/ });
    active.focus();
    await user.keyboard("{End}");
    const info = await screen.findByRole("tab", { name: "Info", selected: true });
    expect(info).toHaveFocus();
    expect(window.location.hash).toBe("#/pm/1");
    for (const tab of screen.getAllByRole("tab")) {
      const target = document.getElementById(tab.getAttribute("aria-controls") ?? "");
      expect(target).toHaveAttribute("role", "tabpanel");
      expect(target).toHaveAttribute("aria-labelledby", tab.id);
      expect(target?.hidden).toBe(tab !== info);
    }
    await user.keyboard("{Home}");
    await waitFor(() => expect(active).toHaveAttribute("aria-selected", "true"));
    expect(active).toHaveFocus();
    expect(window.location.hash).toBe("#/c/1");
  });

  it("opens the decision card ahead of a bound Worker, with the dialog as a fallback", async () => {
    const user = userEvent.setup();
    const snapshot = graphSnapshot();
    const waiting = graph();
    waiting.nodes = waiting.nodes.map((node) => node.key === "gate"
      ? { ...node, activeWorkerId: 3, workerIds: [3], gateAskPending: true }
      : { ...node, activeWorkerId: null, workerIds: [] });
    snapshot.activeTaskGraphs = [waiting];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = vi.fn();
    const { ws } = await bootSingle(snapshot);
    const step = await within(sidePanel()).findByRole("button", { name: /确认上线/ });
    await user.click(step);
    const message = document.querySelector('[data-message-id="99"]');
    await waitFor(() => expect(message).toHaveAttribute("data-highlighted", "true"));
    expect(window.location.hash).toBe("#/c/1");

    const closed = snapshot.conversations[0]?.messages.find((item) => item.id === 99);
    if (closed === undefined) throw new Error("Missing gate message");
    act(() => ws.push(messageChange(11, "message.updated", { ...closed, meta: { ...closed.meta, answered: true } })));
    await user.click(step);
    const dialog = await screen.findByRole("dialog", { name: waiting.title });
    expect(within(dialog).getByTestId("peel-gate-card")).toBeInTheDocument();
    expect(within(dialog).getByText("Waiting on you").closest("[data-decision-key]")).toHaveFocus();
    expect(window.location.hash).toBe("#/c/1");
    Element.prototype.scrollIntoView = original;
  });

  it("updates an open graph and dismisses its cancel confirmation when another window cancels it", async () => {
    const user = userEvent.setup();
    const { ws } = await bootSingle(graphSnapshot());
    await user.click(within(sidePanel()).getByRole("button", { name: "Expand 发布流水线" }));
    const dialog = await screen.findByRole("dialog", { name: "发布流水线" });
    expect(within(dialog).getByText("Waiting on you")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel graph" }));
    expect(screen.getByRole("dialog", { name: "Cancel this task graph?" })).toBeInTheDocument();
    act(() => ws.push(changeOf(11, "task_graph.updated", { graph: { ...graph(), status: "cancelled", completedAt: 4_000 } })));
    expect(await screen.findByRole("dialog", { name: "发布流水线" })).toBe(dialog);
    expect(within(dialog).getAllByText("Cancelled").length).toBeGreaterThan(0);
    expect(within(dialog).queryByText("Waiting on you")).not.toBeInTheDocument();
    expect(dialog.querySelector('[data-step-key="gate"]')).toHaveAttribute("data-status", "cancelled");
    expect(within(dialog).queryByRole("button", { name: "Cancel graph" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Cancel this task graph?" })).not.toBeInTheDocument();
  });

  it("refreshes the count and row after a standalone Worker ends while Completed is unmounted", async () => {
    const user = userEvent.setup();
    let ended = false;
    const { api, ws } = await bootSingle(graphSnapshot(), (api) => {
      api.completedWork = () => ({ status: 200, body: {
        items: ended ? [{ kind: "worker", workerId: 4, conversationId: 31, title: "零散的活", outcome: "done", finishedAt: Date.now(), prUrl: null }] : [],
        total: ended ? 1 : 0,
        next: null,
      } });
    });
    await user.click(await within(sidePanel()).findByRole("tab", { name: "Completed 0" }));
    expect(await within(sidePanel()).findByText("Nothing completed yet")).toBeInTheDocument();
    await user.click(within(sidePanel()).getByRole("tab", { name: /^Active/ }));
    await user.click(within(sidePanel()).getByRole("button", { name: /零散的活/ }));
    await user.click(await screen.findByRole("button", { name: "More worker actions" }));
    await user.click(screen.getByRole("button", { name: "End" }));
    expect(api.callsTo("POST", /^\/api\/conversations\/31\/end$/)).toHaveLength(1);
    ended = true;
    act(() => ws.push(messageChange(11, "message.created", makeWorkerLine({
      id: 101, line: { workerId: 4, workerConversationId: 31, title: "零散的活", event: "ended" },
    }))));
    await user.click(screen.getByRole("button", { name: "Back to 小林" }));
    await user.click(await within(sidePanel()).findByRole("tab", { name: "Completed 1" }));
    expect(await within(sidePanel()).findByRole("button", { name: /零散的活/ })).toBeInTheDocument();
    expect(api.callsTo("GET", /\/completed$/)).toHaveLength(2);
  });

  it("does not let an in-flight first page overwrite a Worker finish", async () => {
    const user = userEvent.setup();
    const firstRead = deferred();
    const { ws, api } = await bootSingle(graphSnapshot(), (api) => {
      api.completedWork = vi
        .fn<FakeApi["completedWork"]>(() => ({
          status: 200,
          body: {
            items: [{ kind: "worker", workerId: 4, conversationId: 31, title: "零散的活", outcome: "done", finishedAt: Date.now(), prUrl: null }],
            total: 1,
            next: null,
          },
        }))
        .mockImplementationOnce(async () => {
          await firstRead.promise;
          return { status: 200, body: { items: [], total: 0, next: null } };
        });
    });
    await user.click(await within(sidePanel()).findByRole("tab", { name: "Completed" }));
    await waitFor(() => expect(api.callsTo("GET", /\/completed$/)).toHaveLength(1));
    act(() => ws.push(messageChange(11, "message.created", makeWorkerLine({
      id: 101, line: { workerId: 4, workerConversationId: 31, title: "零散的活", event: "ended" },
    }))));
    expect(await within(sidePanel()).findByRole("tab", { name: "Completed 1" })).toBeInTheDocument();
    await act(async () => firstRead.resolve());
    expect(within(sidePanel()).getByRole("tab", { name: "Completed 1" })).toBeInTheDocument();
    expect(within(sidePanel()).getByRole("button", { name: /零散的活/ })).toBeInTheDocument();
  });

  it("点右栏里等你拍板的步骤：对话滚到那张拍板卡并高亮，不发请求；点放大按钮打开弹窗才 POST /decide", async () => {
    const user = userEvent.setup();
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    const { api } = await bootSingle(graphSnapshot());
    const step = await waitFor(() => within(sidePanel()).getByRole("button", { name: /确认上线/ }));
    await user.click(step);
    const target = document.querySelector('[data-message-id="99"]')!;
    await waitFor(() => expect(target).toHaveAttribute("data-highlighted", "true"));
    expect(scrolled).toEqual([target]);
    expect(api.callsTo("POST", DECIDE_PATH)).toHaveLength(0);
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");

    await user.click(within(sidePanel()).getByRole("button", { name: "Expand 发布流水线" }));
    const card = within(await screen.findByRole("dialog", { name: "发布流水线" })).getByTestId("peel-gate-card");
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
          status: "running",
          sortOrder: 0,
          activeWorkerId: 3,
          workerIds: [3],
          gateQuestion: "请确认步骤「方案检查点」的结果",
          gateOptions: ["通过", "打回"],
          gateRecommended: "通过",
          gateSummaryMd: "**摘要**：已完成方案初稿\n\n**交棒要点**：\n见 `docs/plan.md`",
          gateAskMessageId: 105,
          gateAskPending: true,
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
    // The work panel shows the checkpoint as a single step box, without options or a reply form.
    const railStep = await waitFor(() => within(sidePanel()).getByRole("button", { name: /方案检查点/ }));
    expect(within(sidePanel()).queryByLabelText("Your reply")).toBeNull();
    expect(within(sidePanel()).queryByText("Recommended")).toBeNull();
    expect(railStep.tagName).toBe("BUTTON");

    // 对话消息流里的检查点 AskCard 展示 Recommended 并常驻回复输入框，点「打回」带修改意见直调 /decide，不调 /messages
    const chatArticle = document.querySelector('[data-message-id="105"]') as HTMLElement;
    const chatCard = chatArticle.querySelector("[data-ask-card]") as HTMLElement;
    expect(within(chatCard).getByText("Recommended")).toBeInTheDocument();
    const noteInput = within(chatCard).getByLabelText("Your reply");
    await user.type(noteInput, "把缓存淘汰改成 lru-cache");
    await user.click(within(chatCard).getByRole("button", { name: /打回/ }));

    await waitFor(() => expect(api.callsTo("POST", DECIDE_PATH)).toHaveLength(1));
    expect(api.callsTo("POST", DECIDE_PATH)[0]!.body).toMatchObject({
      askMessageId: 105,
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
    await user.type(within(chatCard).getByLabelText("Your reply"), "补充上限常量到 limits.ts");
    await user.click(within(chatCard).getByRole("button", { name: "Send" }));

    await waitFor(() => expect(api.callsTo("POST", DECIDE_PATH)).toHaveLength(1));
    expect(api.callsTo("POST", DECIDE_PATH)[0]!.body).toMatchObject({
      choice: null,
      note: "补充上限常量到 limits.ts",
    });
    // 乐观态立即高亮「打回」选项（data-chosen 暖黄底行），不误高亮「通过」
    const passBtn = within(chatCard).getByRole("button", { name: /通过/ });
    const rejectBtn = within(chatCard).getByRole("button", { name: /打回/ });
    expect(rejectBtn).toHaveAttribute("data-chosen");
    expect(passBtn).not.toHaveAttribute("data-chosen");

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
    const graphs = await waitFor(() => within(sidePanel()).getByRole("region", { name: "发布流水线" }));
    await user.click(within(graphs).getByRole("button", { name: "Expand 发布流水线" }));
    const zoom = await screen.findByRole("dialog", { name: "发布流水线" });
    expect(zoom.querySelector("[data-step='running']")).toHaveTextContent("构建产物");
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
    await user.click(await waitFor(() => within(sidePanel()).getByRole("button", { name: "Expand 发布流水线" })));
    const zoom = await screen.findByRole("dialog", { name: "发布流水线" });
    await user.click(within(zoom).getByRole("button", { name: "Cancel graph" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Cancel this task graph?" })).getByRole("button", { name: "Cancel graph" }));
    expect(await within(zoom).findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Cancel this task graph?" })).toBeNull();
    expect(api.callsTo("POST", CANCEL_PATH)).toHaveLength(1);
  });

  it("爆炸半径：带活跃任务图时连续 8 帧流式输出，ActiveTab 零重画", async () => {
    type MemoTarget = { type: (...args: unknown[]) => unknown };
    const railSpy = vi.spyOn(ActiveTabMod.ActiveTab as unknown as MemoTarget, "type");
    const { ws } = await bootSingle(graphSnapshot());
    await waitFor(() => expect(within(sidePanel()).getByRole("region", { name: "发布流水线" })).toBeInTheDocument());
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

describe("手机整页工作面板：同一份 ActiveTab", () => {
  it("marks Work panel as needing attention when a running step still has a pending card", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("coarse"),
      addEventListener() {},
      removeEventListener() {},
    }));
    const active = graph();
    active.nodes = [makeNode({ key: "gate", title: "Confirm", status: "running", gateAskMessageId: 99, gateAskPending: true })];
    active.edges = [];
    await bootSingle(makeSnapshot({
      pms: [makePm({ id: 1 })],
      projects: [makeProject({ id: 1, pmId: 1, conversationId: 1 })],
      conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1 } })],
      activeTaskGraphs: [active],
    }));
    const toggle = await screen.findByRole("button", { name: "Show work panel (needs you)" });
    fireEvent.click(toggle);
    const panel = await screen.findByRole("complementary", { name: "Work panel" });
    expect(within(panel).getByRole("button", { name: /Confirm/ })).toBeInTheDocument();
  });

  it("手机打开整页 WorkPanel，绑图 Worker 不重复列出；点步骤关闭面板并进入 Worker", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("coarse"),
      addEventListener() {},
      removeEventListener() {},
    }));
    await bootSingle(graphSnapshot());
    const toggle = await screen.findByRole("button", { name: "Show work panel (needs you)" });
    fireEvent.click(toggle);
    const panel = await screen.findByRole("complementary", { name: "Work panel" });
    expect(panel).toHaveAttribute("data-layout", "page");
    const graphs = within(panel).getByRole("region", { name: "发布流水线" });
    expect(within(graphs).getByText("发布流水线")).toBeInTheDocument();
    expect(within(panel).queryByText(/门禁提问/)).toBeNull();
    expect(within(panel).queryByRole("button", { name: /绑图的活/ })).toBeNull();
    fireEvent.click(within(graphs).getByRole("button", { name: /构建产物/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/w/30"));
    expect(screen.queryByRole("complementary", { name: "Work panel" })).toBeNull();
  });
});

describe("手机整页工作面板：流式帧", () => {
  it("手机面板开着时连续 8 帧流式输出，ActiveTab 零重画", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("coarse"),
      addEventListener() {},
      removeEventListener() {},
    }));
    type MemoTarget = { type: (...args: unknown[]) => unknown };
    const tabSpy = vi.spyOn(ActiveTabMod.ActiveTab as unknown as MemoTarget, "type");
    const { ws } = await bootSingle(graphSnapshot());
    fireEvent.click(await screen.findByRole("button", { name: "Show work panel (needs you)" }));
    await screen.findByRole("complementary", { name: "Work panel" });
    tabSpy.mockClear();
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
    expect(tabSpy).toHaveBeenCalledTimes(0);
  });
});

function historyFixture(status: "completed" | "cancelled") {
  const message = makeMessage({
    id: 99,
    text: "Keep the notes?",
    dedupeKey: "ask:1:99",
    meta: { needsUser: true, options: ["Keep", "Discard"], gateRef: { graphId: GRAPH_ID, nodeKey: "gate" } },
  });
  const gate = makeNode({
    key: "gate", title: "Review notes", status: status === "completed" ? "done" : "waiting",
    waitingFor: status === "completed" ? null : "user", gateAskPending: true, gateAskMessageId: message.id,
    gateOptions: ["Keep", "Discard"],
  });
  const pending: TaskGraph = { ...graph(), title: "Release history", status, completedAt: 2_000, nodes: [gate], edges: [] };
  const settled: TaskGraph = {
    ...pending,
    nodes: [{ ...gate, waitingFor: status === "completed" ? null : "pm", gateAskPending: false }],
  };
  const snapshot = makeSnapshot({
    pms: [makePm()],
    projects: [makeProject({ conversationId: 1 })],
    conversations: [
      makeConvSnapshot([makeUserMessage({ id: 1 }), makeWorkerLine({ id: 10, line: { event: "ended" } }), message]),
      makeConvSnapshot([], { conversation: makeWorkerConversation() }),
    ],
  });
  return { pending, settled, snapshot, message };
}

function completedPageFor(title: string, outcome: "done" | "cancelled") {
  return {
    status: 200,
    body: {
      items: [
        {
          kind: "graph" as const,
          graphId: GRAPH_ID,
          title,
          outcome,
          finishedAt: 2_000,
          prUrl: null,
          steps: [{ key: "gate", title: "Review notes", skipped: false, done: outcome === "done" }],
          edges: [],
        },
      ],
      total: 1,
      next: null,
    },
  };
}

describe("Settling a card in task graph history", () => {
  it("keeps a pending card open in TaskGraphDialog on a completed graph and sends askMessageId when decided", async () => {
    const user = userEvent.setup();
    const { pending, settled, message } = historyFixture("completed");
    const api = new FakeApi(makeSnapshot());
    api.install();
    const { rerender } = render(
      <TaskGraphDialog open graph={pending} workers={[]} onOpenChange={() => {}} onOpenWorker={() => {}} />,
    );
    const dialog = await screen.findByRole("dialog", { name: "Release history" });
    expect(within(dialog).getByText("Waiting on you")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Keep" }));
    await waitFor(() => expect(api.callsTo("POST", DECIDE_PATH)[0]?.body).toMatchObject({ askMessageId: message.id, choice: "Keep" }));

    rerender(<TaskGraphDialog open graph={settled} workers={[]} onOpenChange={() => {}} onOpenWorker={() => {}} />);
    expect(within(dialog).queryByText("Waiting on you")).toBeNull();
    expect(within(dialog).queryByTestId("peel-gate-card")).toBeNull();
  });

  it("refreshes the Completed feed when a graph settles after an in-flight first read", async () => {
    const user = userEvent.setup();
    const { settled, snapshot, message } = historyFixture("cancelled");
    const { api, ws } = await bootSingle(snapshot);
    const firstRead = deferred();
    api.completedWork = vi
      .fn<FakeApi["completedWork"]>(() => completedPageFor("Release history settled", "cancelled"))
      .mockImplementationOnce(async () => {
        await firstRead.promise;
        return completedPageFor("Release history stale", "cancelled");
      });

    await user.click(screen.getByRole("button", { name: /Show work panel/ }));
    await user.click(within(sidePanel()).getByRole("tab", { name: /^Completed/ }));
    await waitFor(() => expect(api.callsTo("GET", /\/completed$/)).toHaveLength(1));
    act(() => {
      ws.push(messageChange(30, "message.updated", { ...message, meta: { ...message.meta, closed: true } }));
      ws.push({ seq: 31, type: "task_graph.updated", data: { graph: settled } });
    });
    await act(async () => firstRead.resolve());
    expect(await within(sidePanel()).findByRole("button", { name: /Release history settled/ })).toBeInTheDocument();
  });
});

describe("跨设备：右栏的请求走当前设备的接口", () => {
  const MAC = "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d";
  const TOKYO = "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f";
  const devices: DeviceInfo[] = [
    { id: MAC, name: "Mac", platform: "darwin", self: true, online: true, link: "local", fingerprint: null },
    { id: TOKYO, name: "东京", platform: "linux", self: false, online: true, link: "relay", fingerprint: null },
  ];

  async function bootFleet(remoteSnapshot = graphSnapshot("东京经理")) {
    const local = new FakeApi(plainSnapshot("本机经理"));
    const remote = new FakeApi(remoteSnapshot);
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
    return { local, remote, ws: sockets(true)[0]! };
  }

  it("refreshes the Completed feed on the remote device when its PM closes a graph card", async () => {
    const user = userEvent.setup();
    const { settled, snapshot, message } = historyFixture("cancelled");
    const { local, remote, ws } = await bootFleet(snapshot);
    let title = "Release history";
    remote.completedWork = () => completedPageFor(title, "cancelled");
    await user.click(screen.getByRole("button", { name: /Show work panel/ }));
    await user.click(within(sidePanel()).getByRole("tab", { name: /^Completed/ }));
    expect(await within(sidePanel()).findByRole("button", { name: /Release history/ })).toBeInTheDocument();

    title = "Release history updated";
    act(() => {
      ws.push(messageChange(30, "message.updated", { ...message, meta: { ...message.meta, closed: true } }));
      ws.push({ seq: 31, type: "task_graph.updated", data: { graph: settled } });
    });

    expect(await within(sidePanel()).findByRole("button", { name: /Release history updated/ })).toBeInTheDocument();
    expect(local.callsTo("GET", /\/completed$/)).toHaveLength(0);
  });

  it("看东京的项目经理：门禁拍板、Cancel graph 都发到东京（/d/<东京>/...），本机一条都不收", async () => {
    const user = userEvent.setup();
    const { local, remote } = await bootFleet();
    const rail = await waitFor(sidePanel);
    await user.click(within(rail).getByRole("button", { name: "Expand 发布流水线" }));
    const zoom = await screen.findByRole("dialog", { name: "发布流水线" });
    const card = within(zoom).getByTestId("peel-gate-card");
    await user.click(within(card).getByRole("button", { name: /上线/ }));
    await waitFor(() => expect(remote.callsTo("POST", DECIDE_PATH)).toHaveLength(1));
    expect(local.callsTo("POST", DECIDE_PATH)).toHaveLength(0);

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
  it("所有节点均已到达终态但图仍 active 时，右栏显示 2/2 进度，全览弹窗显示 Ready to finish", async () => {
    const user = userEvent.setup();
    const { ws } = await bootSingle(graphSnapshot());
    const rail = await waitFor(sidePanel);
    expect(within(rail).getByText("0/2")).toBeInTheDocument();

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

    expect(await within(rail).findByText("2/2")).toBeInTheDocument();

    await user.click(within(rail).getByRole("button", { name: "Expand 发布流水线" }));
    const zoom = await screen.findByRole("dialog", { name: "发布流水线" });
    expect(within(zoom).getByText("Ready to finish")).toBeInTheDocument();
  });

  it("任务图门禁卡草稿跨开关弹窗与对话 AskCard 共享；远端定案离开 waiting:user 后在节点上保留只读可复制未发草稿", async () => {
    const user = userEvent.setup();
    const { ws } = await bootSingle(graphSnapshot());
    const rail = await waitFor(sidePanel);

    await user.click(within(rail).getByRole("button", { name: "Expand 发布流水线" }));
    const zoom = await screen.findByRole("dialog", { name: "发布流水线" });
    const gateCard = within(zoom).getByTestId("peel-gate-card");
    await user.type(within(gateCard).getByLabelText("Your reply"), "补充回滚方案");

    // 关掉全览弹窗再打开，草稿仍在，且对话里同一门禁 AskCard 同步显示同一份草稿
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "发布流水线" })).toBeNull());
    const chatCard = document.querySelector<HTMLElement>('[data-message-id="99"] [data-ask-card]')!;
    expect((within(chatCard).getByLabelText("Your reply") as HTMLTextAreaElement).value).toBe("补充回滚方案");

    await user.click(within(rail).getByRole("button", { name: "Expand 发布流水线" }));
    const zoomReopened = await screen.findByRole("dialog", { name: "发布流水线" });
    expect((within(within(zoomReopened).getByTestId("peel-gate-card")).getByLabelText("Your reply") as HTMLTextAreaElement).value).toBe("补充回滚方案");

    // 远端定案离开 waiting:user（即使 gateAskMessageId 被清空，也靠活跃时记住的 key 保住未发草稿）
    act(() =>
      ws.push({
        seq: 31,
        type: "task_graph.updated",
        data: {
          graph: {
            ...graph(),
            nodes: [
              makeNode({ key: "build", title: "构建产物", status: "done", sortOrder: 0, workerIds: [3] }),
              makeNode({
                key: "gate",
                title: "确认上线",
                status: "done",
                waitingFor: null,
                sortOrder: 1,
                gateAskMessageId: null,
                decision: { choice: "上线", note: null, decidedAt: 2_000, decidedBy: "user" },
              }),
            ],
          },
        },
      }),
    );

    const unsent = await waitFor(() => {
      const el = zoomReopened.querySelector<HTMLElement>("[data-unsent-draft]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(unsent).toHaveTextContent("Unsent reply");
    expect(unsent).toHaveTextContent("补充回滚方案");
    expect(within(unsent).getByRole("button", { name: "Copy" })).toBeInTheDocument();

    await user.click(within(unsent).getByRole("button", { name: "Dismiss" }));
    expect(zoomReopened.querySelector("[data-unsent-draft]")).toBeNull();
  });
});
