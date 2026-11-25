// M3 网页（W4）：项目经理会话里的 Worker 汇报那一行、点开看 Worker 的过程、顶栏的额度、顶栏的 Worker 列表面板。接口和 WebSocket 都是假的。
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundledModelCatalog, FETCHED_QUOTA_FRESH_MS, vendorSpec } from "../shared/index.ts";
import type { AgentVendor, Message, QuotaResponse, RateLimitInfo, RateLimitWindow, SessionState, StateSnapshot, WsServerMessage } from "../shared/index.ts";
import { formatContext, formatCount, formatQuotaReset, formatTokens } from "./format.ts";
import { App } from "./App.tsx";
import { fetchedQuotaUsage, isWaitingForQuota, listConversations, quotaUsage, runningWorkerCount, workerPhaseOf } from "./selectors.ts";
import { initialState, reducer } from "./state.ts";
import {
  FakeApi,
  FakeWebSocket,
  changeOf,
  installFakeWebSocket,
  makeConvSnapshot,
  makeMessage,
  makePm,
  makeSession,
  makeSnapshot,
  makeToolMessage,
  makeUserMessage,
  makeWorkerConversation,
  makeWorkerLine,
  messageChange,
  openFirstConversation,
  sessionChange,
} from "./test-utils.ts";

let api: FakeApi;

async function boot(snapshot: StateSnapshot = withWorker(), configure?: (api: FakeApi) => void) {
  openFirstConversation(snapshot);
  api = new FakeApi(snapshot);
  configure?.(api);
  api.install();
  installFakeWebSocket();
  render(<App />);
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  act(() => FakeWebSocket.last.open());
  return FakeWebSocket.last;
}

function push(ws: FakeWebSocket, msg: WsServerMessage) {
  act(() => ws.push(msg));
}

/**
 * 小林（对话 1）派了一个 Worker“修 X”（编号 3，对话 30）。小林的会话里有“已派出”“做完了”两行；
 * Worker 的对话里有任务、它的回复和两步操作。
 */
function withWorker(over: Partial<StateSnapshot> = {}): StateSnapshot {
  return makeSnapshot({
    pms: [makePm({ id: 1, name: "小林" })],
    conversations: [
      makeConvSnapshot(
        [
          makeMessage({ id: 1, conversationId: 1, text: "派个 Worker 修 X" }),
          makeWorkerLine({ id: 2, conversationId: 1, line: { event: "started" } }),
          makeWorkerLine({ id: 3, conversationId: 1, line: { event: "report", status: "done", summary: "改好了，测试通过" } }),
        ],
        { conversation: { id: 1, pmId: 1, title: "小林" } },
      ),
      makeConvSnapshot(
        [
          makeMessage({ id: 10, conversationId: 30, sender: "pm", sessionId: null, status: "replied", text: "任务：修 X" }),
          makeToolMessage({ id: 11, conversationId: 30, workerId: 3, text: "Bash: git status" }),
          makeToolMessage({ id: 12, conversationId: 30, workerId: 3, text: "Edit: src/x.ts" }),
          makeMessage({ id: 13, conversationId: 30, workerId: 3, text: "已经修好了" }),
        ],
        { conversation: makeWorkerConversation() },
      ),
    ],
    sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1 }), makeSession({ sessionId: 2, conversationId: 30 })],
    ...over,
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function nav() {
  return screen.getByRole("region", { name: "Project managers" });
}
function navRows() {
  return within(nav())
    .getAllByRole("button")
    .filter((b) => !b.closest(".row-shortcuts"));
}
function navRow(name: RegExp) {
  return within(nav())
    .getAllByRole("button", { name })
    .find((b) => !b.closest(".row-shortcuts"))!;
}
function log() {
  return screen.getByRole("log", { name: "Messages" });
}

/**
 * 在右侧面板打开 Worker：走 Pieces 和通知用的 #/w/30。对话里不显示“已派出”那一行，只有汇报的 Worker 才有可点的一行。
 */
async function showWorker() {
  window.location.hash = "#/w/30";
  await screen.findByRole("button", { name: "Close work panel" });
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("那一行", () => {
  it("Worker 的汇报是一行按钮：看得到标题，状态词和摘要在读屏名字里；“已派出”不进对话，也不进 Worked for", async () => {
    await boot();
    const done = within(log()).getByRole("button", { name: "修 X, Done, 改好了，测试通过" });
    const row = done.closest("[data-worker-report]");
    expect(row).toHaveTextContent("修 X");
    expect(row).not.toHaveTextContent("改好了，测试通过");
    expect(row).toHaveAttribute("data-tone", "success");
    expect(within(log()).queryByText(/Started/)).not.toBeInTheDocument();
    expect(within(log()).queryByRole("button", { name: /Worked for/ })).not.toBeInTheDocument();
    // 汇报原文（给项目经理的那段）不显示给人看
    expect(within(log()).queryByText(/的汇报】/)).not.toBeInTheDocument();
  });

  it("开工、收工这两行不进对话：只有它们时对话里没有按钮，也没有 Started 和 Ended", async () => {
    await boot(
      withWorker({
        conversations: [
          makeConvSnapshot(
            [
              makeWorkerLine({ id: 2, conversationId: 1, line: { event: "started", readonly: true, title: "调查 Y" } }),
              makeWorkerLine({ id: 3, conversationId: 1, line: { event: "ended", title: "调查 Y" } }),
            ],
            { conversation: { id: 1, pmId: 1, title: "小林" } },
          ),
        ],
      }),
    );
    expect(within(log()).queryAllByRole("button")).toHaveLength(0);
    expect(within(log()).queryByText(/调查 Y|Started|Ended/)).not.toBeInTheDocument();
  });

  it("opens the Worker from a legacy direct message notice", async () => {
    const user = userEvent.setup();
    await boot(
      withWorker({
        conversations: [
          makeConvSnapshot(
            [makeWorkerLine({ id: 2, conversationId: 1, line: { event: "user_message", summary: "顺便改 README" }, text: "【用户直接对 Worker #3 · 修 X 说的话（Worker 已收到）】\n\n顺便改 README" })],
            { conversation: { id: 1, pmId: 1, title: "小林" } },
          ),
          withWorker().conversations[1]!,
        ],
      }),
    );
    const line = within(log()).getByRole("button", { name: "修 X You said 顺便改 README" });
    expect(within(log()).queryByText(/Worker 已收到/)).not.toBeInTheDocument();
    await user.click(line);
    expect(screen.getByRole("region", { name: "Worker 修 X" })).toBeInTheDocument();
  });

  it("各种事件：有问题、放弃了、没按格式、这一轮没做完、建 worktree 失败各一行，已收工不显示", async () => {
    const lines = [
      { event: "report", status: "problem", summary: "缺一个 key" },
      { event: "report", status: "gave_up", summary: "做不了" },
      { event: "report", status: "unformatted", summary: "我改完了" },
      { event: "turn_failed", status: null, summary: "被停止了" },
      { event: "worktree_failed", status: null, summary: "目录被占用" },
      { event: "ended", status: null, summary: null },
    ] as const;
    await boot(
      withWorker({
        conversations: [
          makeConvSnapshot(lines.map((line, i) => makeWorkerLine({ id: i + 2, conversationId: 1, line })), {
            conversation: { id: 1, pmId: 1, title: "小林" },
          }),
        ],
      }),
    );
    const buttons = within(log()).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "修 X, Problem, 缺一个 key",
      "修 X, Gave up, 做不了",
      "修 X, 我改完了",
      "修 X, Error, 被停止了",
      "修 X, Error, 目录被占用",
    ]);
    expect(buttons.map((b) => b.closest("[data-worker-report]")?.getAttribute("data-tone"))).toEqual(["warn", "danger", "neutral", "danger", "danger"]);
    for (const button of buttons) expect(button).toHaveTextContent(/^修 X/);
    expect(within(log()).queryByText(/Ended/)).not.toBeInTheDocument();
  });

  it("推一条新的汇报，会话里多一行；推收工不多；左栏那一行只有名字，不带上这些消息", async () => {
    const ws = await boot();
    const reports = () => log().querySelectorAll("[data-worker-report]");
    expect(reports()).toHaveLength(1);
    push(ws, messageChange(11, "message.created", makeWorkerLine({ id: 4, conversationId: 1, line: { event: "ended" } })));
    expect(reports()).toHaveLength(1);
    push(ws, messageChange(12, "message.created", makeWorkerLine({ id: 5, conversationId: 1, line: { event: "report", status: "problem", summary: "缺一个 key" } })));
    expect(within(log()).getByRole("button", { name: "修 X, Problem, 缺一个 key" })).toBeInTheDocument();
    expect(reports()).toHaveLength(2);
    expect(navRow(/小林/)).toHaveAccessibleName("小林");
    expect(within(nav()).queryByText(/修 X|Ended|Problem/)).not.toBeInTheDocument();
  });

  it("meta 不认识（事件名没见过）：当普通的系统提示显示原文，不崩", async () => {
    await boot(
      withWorker({
        conversations: [
          makeConvSnapshot([makeMessage({ id: 2, conversationId: 1, sender: "system", kind: "worker", text: "奇怪的一行", meta: { event: "x" } })], {
            conversation: { id: 1, pmId: 1, title: "小林" },
          }),
        ],
      }),
    );
    expect(within(log()).getByText("奇怪的一行")).toBeInTheDocument();
  });
});

describe("Sidebar", () => {
  it("不显示 Worker 的对话", async () => {
    await boot();
    expect(navRows()).toHaveLength(1);
    expect(within(nav()).queryByText("修 X")).not.toBeInTheDocument();
  });
});

describe("点开 Worker", () => {
  it("点那一行：右边是 Worker 的对话，有任务、回复和折叠的操作", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(within(log()).getByRole("button", { name: /Done/ }));
    const panel = screen.getByRole("complementary", { name: "修 X" });
    const section = screen.getByRole("region", { name: "Worker 修 X" });
    expect(within(panel).getByRole("heading", { name: "修 X" })).toBeInTheDocument();
    expect(within(section).getByText("任务：修 X")).toBeInTheDocument();
    expect(within(section).getByText("已经修好了")).toBeInTheDocument();
    await user.click(within(section).getByRole("button", { name: /Worked for/ }));
    expect(within(section).getByText("Bash: git status")).toBeInTheDocument();
    expect(within(section).getByText("Edit: src/x.ts")).toBeInTheDocument();
    // 桌面端：项目经理会话仍在主区，Worker 在右侧面板打开，左栏停在项目经理上
    expect(screen.getByRole("region", { name: "小林" })).toBeInTheDocument();
    expect(panel).toContainElement(section);
    expect(navRow(/小林/)).toHaveAttribute("aria-current", "page");
  });

  it("项目经理在 Worker 对话里说的话：靠左，带项目经理的头像和名字，不带只有用户消息才有的投递状态，也没有重试", async () => {
    await boot(
      withWorker({
        conversations: [
          makeConvSnapshot([makeWorkerLine({ id: 2, conversationId: 1 })], { conversation: { id: 1, pmId: 1, title: "小林" } }),
          makeConvSnapshot(
            [
              makeMessage({ id: 10, conversationId: 30, sender: "pm", sessionId: null, status: "replied", text: "任务：修 X" }),
              makeMessage({ id: 11, conversationId: 30, workerId: 3, text: "收到" }),
              makeMessage({ id: 12, conversationId: 30, sender: "pm", sessionId: null, status: "failed", failureReason: "claude_not_found: x", text: "再改一下" }),
            ],
            { conversation: makeWorkerConversation() },
          ),
        ],
      }),
    );
    await showWorker();
    const section = screen.getByRole("region", { name: "Worker 修 X" });
    const task = within(section).getByText("任务：修 X").closest("[data-head]") as HTMLElement;
    expect(task).toHaveAttribute("data-side", "left");
    expect(task).toHaveAttribute("data-head", "true");
    expect(within(task).getByText("小林")).toBeInTheDocument();
    // Worker 自己的话署 Worker 的标题，两边不会混
    const reply = within(section).getByText("收到").closest("[data-turn]") as HTMLElement;
    expect(within(reply).getByText("修 X")).toBeInTheDocument();
    expect(within(section).getByText("再改一下").closest("[data-head]")).toHaveAttribute("data-head", "true");
    expect(within(section).queryByText("已回复")).not.toBeInTheDocument();
    expect(within(section).queryByText("发送失败")).not.toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: "Not sent. Click to resend" })).not.toBeInTheDocument();
    expect(within(section).queryByText(/^(已送达|处理中|排队中|失败)/)).not.toBeInTheDocument();
  });

  it("项目经理连着说两句：第二句不重复头像和名字", async () => {
    await boot(
      withWorker({
        conversations: [
          makeConvSnapshot([makeWorkerLine({ id: 2, conversationId: 1 })], { conversation: { id: 1, pmId: 1, title: "小林" } }),
          makeConvSnapshot(
            [
              makeMessage({ id: 10, conversationId: 30, sender: "pm", sessionId: null, text: "第一句" }),
              makeMessage({ id: 11, conversationId: 30, sender: "pm", sessionId: null, text: "第二句" }),
            ],
            { conversation: makeWorkerConversation() },
          ),
        ],
      }),
    );
    await showWorker();
    expect(screen.getByText("第二句").closest("[data-head]")).toHaveAttribute("data-head", "false");
  });

  it("Worker 在干活：消息流里显示它在做什么，“停止”停的是 Worker 的对话", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    await showWorker();
    push(ws, sessionChange(11, makeSession({ sessionId: 2, conversationId: 30, status: "running", activity: "working", step: { type: "tool_use", name: "Bash", input: {} } })));
    const status = screen.getByRole("status", { name: "Status" });
    expect(status).toHaveTextContent("Running command");
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(api.callsTo("POST", /stop$/)).toHaveLength(1));
    expect(api.callsTo("POST", /stop$/)[0]?.path).toBe("/api/conversations/30/stop");
  });

  it("Worker 网络出错在重试：状态写“Retrying”，“停止”照常停 Worker 的对话", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    await showWorker();
    push(
      ws,
      sessionChange(
        11,
        makeSession({
          sessionId: 2,
          conversationId: 30,
          status: "running",
          activity: "working",
          apiRetry: { attempt: 5, maxRetries: 10, retryAt: null, errorStatus: null, error: "unknown" },
        }),
      ),
    );
    expect(screen.getByRole("status", { name: "Status" })).toHaveTextContent("Retrying 5/10");
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(api.callsTo("POST", /stop$/)).toHaveLength(1));
    expect(api.callsTo("POST", /stop$/)[0]?.path).toBe("/api/conversations/30/stop");
  });

  it("31 Worker 准备中：状态写“Running setup”、有停止按钮，停的是 Worker 的对话", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    await showWorker();
    push(ws, sessionChange(11, makeSession({ sessionId: 2, conversationId: 30, status: "idle", activity: "preparing" })));
    const status = screen.getByRole("status", { name: "Status" });
    expect(status).toHaveTextContent("Running setup");
    expect(status).toHaveAttribute("data-busy", "true");
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(api.callsTo("POST", /stop$/)).toHaveLength(1));
    expect(api.callsTo("POST", /stop$/)[0]?.path).toBe("/api/conversations/30/stop");
  });

  it("新消息推来就接在后面", async () => {
    const ws = await boot();
    await showWorker();
    push(ws, messageChange(11, "message.created", makeMessage({ id: 14, conversationId: 30, workerId: 3, text: "再补一句" })));
    expect(within(screen.getByRole("region", { name: "Worker 修 X" })).getByText("再补一句")).toBeInTheDocument();
  });

  it("翻页：有更早的就显示“加载更早的消息”，点了按 GET /messages?before= 取", async () => {
    const user = userEvent.setup();
    await boot(
      withWorker({
        conversations: [
          makeConvSnapshot([makeWorkerLine({ id: 2, conversationId: 1 })], { conversation: { id: 1, pmId: 1, title: "小林" } }),
          makeConvSnapshot([makeMessage({ id: 10, conversationId: 30, workerId: 3, text: "后来的话" })], {
            conversation: makeWorkerConversation(),
            hasMore: true,
          }),
        ],
      }),
    );
    api.older = () => ({ status: 200, body: { messages: [makeMessage({ id: 5, conversationId: 30, workerId: 3, text: "早先的话" })], hasMore: false } });
    await showWorker();
    await user.click(screen.getByRole("button", { name: "Load earlier messages" }));
    await waitFor(() => expect(screen.getByText("早先的话")).toBeInTheDocument());
    const call = api.callsTo("GET", /\/messages$/)[0];
    expect(call?.path).toBe("/api/conversations/30/messages");
    expect(call?.query.get("before")).toBe("10");
  });

  it("没有消息：写“还没有消息”", async () => {
    await boot(
      withWorker({
        conversations: [
          makeConvSnapshot([makeWorkerLine({ id: 2, conversationId: 1 })], { conversation: { id: 1, pmId: 1, title: "小林" } }),
          makeConvSnapshot([], { conversation: makeWorkerConversation() }),
        ],
      }),
    );
    await showWorker();
    expect(within(screen.getByRole("region", { name: "Worker 修 X" })).getByText("No messages yet")).toBeInTheDocument();
  });

  it("对话被保留期清理过（conversation.purgedAt）：写清 14 天和 300 个两条保留规则，不显示“No messages yet”和输入框；实时收到 conversation.purged 同样", async () => {
    const ws = await boot(
      withWorker({
        conversations: [
          makeConvSnapshot([makeWorkerLine({ id: 2, conversationId: 1 })], { conversation: { id: 1, pmId: 1, title: "小林" } }),
          makeConvSnapshot([makeMessage({ id: 10, conversationId: 30, workerId: 3, text: "还在的话" })], { conversation: makeWorkerConversation() }),
        ],
      }),
    );
    await showWorker();
    const region = screen.getByRole("region", { name: "Worker 修 X" });
    expect(within(region).getByText("还在的话")).toBeInTheDocument();
    push(ws, changeOf(11, "conversation.purged", { conversationId: 30, purgedAt: 5 }));
    await waitFor(() => expect(within(region).getByRole("status")).toHaveTextContent("Conversation cleared. Finished Workers keep their conversations for up to 14 days, and only the latest 300."));
    expect(within(region).queryByText("还在的话")).not.toBeInTheDocument();
    expect(within(region).queryByText("No messages yet")).not.toBeInTheDocument();
  });

  it("clicking a one-row report for a cleared Worker keeps the row compact and renders the retained PM report body in the panel", async () => {
    const user = userEvent.setup();
    const summary = "阈值挪进 VENDOR_SPECS，32 条测试通过，PR #142。";
    const reportBody = `=== 汇报 ===\n状态: 做完了\n摘要: ${summary}\nPR: https://github.com/example/agent-hub/pull/142\n=== 汇报结束 ===`;
    await boot(
      withWorker({
        conversations: [
          makeConvSnapshot(
            [
              makeWorkerLine({ id: 2, conversationId: 1, line: { event: "started", title: "按厂商配置换会话阈值" } }),
              makeWorkerLine({
                id: 3,
                conversationId: 1,
                line: { event: "report", status: "done", title: "按厂商配置换会话阈值", summary },
                text: `【Worker #3 · 按厂商配置换会话阈值 的汇报】\n\n${reportBody}`,
              }),
              makeWorkerLine({ id: 4, conversationId: 1, line: { event: "ended", title: "按厂商配置换会话阈值" } }),
            ],
            { conversation: { id: 1, pmId: 1, title: "小林" } },
          ),
          makeConvSnapshot([], { conversation: makeWorkerConversation({ title: "按厂商配置换会话阈值", purgedAt: 50_000 }) }),
        ],
        sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1 }), makeSession({ sessionId: 2, conversationId: 30, status: "ended" })],
      }),
    );

    const row = within(log()).getByRole("button", { name: `按厂商配置换会话阈值, Done, ${summary}` });
    expect(row).not.toHaveTextContent(summary);
    await user.click(row);

    const region = screen.getByRole("region", { name: "Worker 按厂商配置换会话阈值" });
    expect(within(region).getByRole("status")).toHaveTextContent(
      "Conversation cleared. Finished Workers keep their conversations for up to 14 days, and only the latest 300.",
    );
    expect(within(region).getByText(new RegExp(summary))).toBeInTheDocument();
    expect(within(region).getByText(/pull\/142/)).toBeInTheDocument();
    expect(within(region).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("shows the PM report summary when a cleared Worker receives conversation.purged live and only the summary is stored", async () => {
    const ws = await boot(
      withWorker({
        conversations: [
          makeConvSnapshot(
            [makeWorkerLine({ id: 3, conversationId: 1, line: { event: "report", status: "done", summary: "改好了，测试通过" } })],
            { conversation: { id: 1, pmId: 1, title: "小林" } },
          ),
          makeConvSnapshot([makeMessage({ id: 10, conversationId: 30, workerId: 3, text: "还在的话" })], { conversation: makeWorkerConversation() }),
        ],
      }),
    );
    await showWorker();
    const region = screen.getByRole("region", { name: "Worker 修 X" });
    push(ws, changeOf(11, "conversation.purged", { conversationId: 30, purgedAt: 5 }));
    await waitFor(() => expect(within(region).getByRole("status")).toHaveTextContent("Conversation cleared."));
    expect(within(region).getByText("改好了，测试通过")).toBeInTheDocument();
  });

  it("clicking a red-dot worktree_failed row shows the PM failure reason in the panel instead of Completed", async () => {
    const user = userEvent.setup();
    const reason = "git worktree add failed: fixture disk full";
    await boot(
      withWorker({
        conversations: [
          makeConvSnapshot(
            [
              makeWorkerLine({ id: 2, conversationId: 1, line: { event: "started", title: "Review fixture: worktree failure" } }),
              makeWorkerLine({
                id: 3,
                conversationId: 1,
                line: { event: "worktree_failed", title: "Review fixture: worktree failure", summary: reason },
                text: `【Worker #3 · Review fixture: worktree failure 的汇报】\n\n建 worktree 失败：${reason}`,
              }),
            ],
            { conversation: { id: 1, pmId: 1, title: "小林" } },
          ),
          makeConvSnapshot(
            [makeMessage({ id: 10, conversationId: 30, sender: "pm", sessionId: null, status: "failed", failureReason: reason, text: "任务：建 worktree" })],
            { conversation: makeWorkerConversation({ title: "Review fixture: worktree failure" }) },
          ),
        ],
        sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1 }), makeSession({ sessionId: 2, conversationId: 30, status: "ended" })],
      }),
    );

    const row = within(log()).getByRole("button", { name: `Review fixture: worktree failure, Error, ${reason}` });
    expect(row).not.toHaveTextContent(reason);
    await user.click(row);

    const region = screen.getByRole("region", { name: "Worker Review fixture: worktree failure" });
    expect(within(region).getByText("任务：建 worktree")).toBeInTheDocument();
    const alert = within(region).getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't create worktree");
    expect(alert).toHaveTextContent(reason);
    expect(within(region).queryByText("Completed")).not.toBeInTheDocument();
    expect(within(region).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("shows a turn_failed reason with raw tooltip when opening a failed Worker and clears it once a new report arrives", async () => {
    const user = userEvent.setup();
    const raw = "error_during_execution: API Error: 529 Overloaded";
    const ws = await boot(
      withWorker({
        conversations: [
          makeConvSnapshot(
            [makeWorkerLine({ id: 3, conversationId: 1, line: { event: "turn_failed", summary: raw } })],
            { conversation: { id: 1, pmId: 1, title: "小林" } },
          ),
          makeConvSnapshot(
            [makeMessage({ id: 10, conversationId: 30, sender: "pm", sessionId: null, status: "failed", failureReason: raw, text: "任务：修 X" })],
            { conversation: makeWorkerConversation() },
          ),
        ],
      }),
    );

    await user.click(within(log()).getByRole("button", { name: "修 X, Error, Claude 服务繁忙，稍后重试" }));
    const region = screen.getByRole("region", { name: "Worker 修 X" });
    const alert = within(region).getByRole("alert");
    expect(alert).toHaveTextContent("Turn failed");
    expect(alert).toHaveTextContent("Claude 服务繁忙，稍后重试");
    expect(alert.querySelector("[title]")).toHaveAttribute("title", raw);
    expect(within(region).getByRole("textbox")).toBeInTheDocument();

    push(ws, messageChange(11, "message.created", makeWorkerLine({ id: 4, conversationId: 1, line: { event: "report", status: "done", summary: "重试后修好了" } })));
    await waitFor(() => expect(within(region).queryByRole("alert")).not.toBeInTheDocument());
  });

  it("keeps the worktree failure reason visible from a slimmed snapshot workerLine when PM messages were truncated", async () => {
    const reason = "git worktree add failed: no space left";
    const workerLine = {
      messageId: 9,
      at: 20_000,
      endedAt: 20_000,
      line: {
        workerId: 3,
        workerConversationId: 30,
        title: "修 X",
        readonly: false,
        event: "worktree_failed" as const,
        status: null,
        summary: reason,
      },
    };
    await boot(
      withWorker({
        conversations: [
          makeConvSnapshot([makeMessage({ id: 100, conversationId: 1, text: "后来的消息" })], { conversation: { id: 1, pmId: 1, title: "小林" } }),
          {
            ...makeConvSnapshot(
              [makeMessage({ id: 10, conversationId: 30, sender: "pm", sessionId: null, status: "failed", failureReason: reason, text: "任务：修 X" })],
              { conversation: makeWorkerConversation() },
            ),
            workerLine,
          },
        ],
        sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1 }), makeSession({ sessionId: 2, conversationId: 30, status: "ended" })],
      }),
    );
    await showWorker();
    const region = screen.getByRole("region", { name: "Worker 修 X" });
    expect(within(region).getByRole("alert")).toHaveTextContent(`Couldn't create worktree ${reason}`);
    expect(within(region).queryByText("Completed")).not.toBeInTheDocument();
  });

  it("快照里没有的早收工 Worker：点开先单拉一次，拉到就显示它的对话", async () => {
    const full = withWorker();
    const worker = full.conversations.find((c) => c.conversation.id === 30)!;
    await boot({ ...full, conversations: full.conversations.filter((c) => c.conversation.id !== 30) });
    api.lookup = (query) => ({ status: 200, body: { conversations: query.get("ids") === "30" ? [worker] : [], sessions: [] } });
    await showWorker();
    const region = await screen.findByRole("region", { name: "Worker 修 X" });
    expect(await within(region).findByText("已经修好了")).toBeInTheDocument();
    expect(api.calls.filter((c) => c.path === "/api/conversations/lookup")).toHaveLength(1);
  });

  it("找不到这个 Worker 的对话：单拉过也没有，写出来，能回去", async () => {
    const user = userEvent.setup();
    await boot(
      withWorker({
        conversations: [makeConvSnapshot([makeWorkerLine({ id: 2, conversationId: 1 })], { conversation: { id: 1, pmId: 1, title: "小林" } })],
      }),
    );
    await showWorker();
    expect(await screen.findByText("Worker not found")).toBeInTheDocument();
    expect(api.calls.filter((c) => c.path === "/api/conversations/lookup").map((c) => c.query.get("ids"))).toEqual(["30"]);
    await user.click(screen.getByRole("button", { name: "Close work panel" }));
    expect(screen.queryByRole("complementary", { name: "修 X" })).toBeNull();
    expect(screen.getByRole("region", { name: "小林" })).toBeInTheDocument();
  });

  it("关闭右侧面板回到项目经理的会话", async () => {
    const user = userEvent.setup();
    await boot();
    await showWorker();
    await user.click(screen.getByRole("button", { name: "Close work panel" }));
    expect(screen.queryByRole("complementary", { name: "修 X" })).toBeNull();
    expect(screen.getByRole("region", { name: "小林" })).toBeInTheDocument();
  });

  it("Worker 的标题栏 ⋯ 菜单显示只读（取自项目经理会话里的“已派出”那一行）", async () => {
    const user = userEvent.setup();
    await boot(
      withWorker({
        conversations: [
          makeConvSnapshot([makeWorkerLine({ id: 2, conversationId: 1, line: { readonly: true } })], { conversation: { id: 1, pmId: 1, title: "小林" } }),
          makeConvSnapshot([makeMessage({ id: 10, conversationId: 30, text: "x" })], { conversation: makeWorkerConversation() }),
        ],
      }),
    );
    await showWorker();
    const panel = screen.getByRole("complementary", { name: "修 X" });
    await user.click(within(panel).getByRole("button", { name: "More worker actions" }));
    expect(await screen.findByText("Read-only")).toBeInTheDocument();
  });
});

describe("最左栏的额度", () => {
  const win = (utilization: number, over: Partial<RateLimitWindow> = {}): RateLimitWindow => ({ utilization, resetsAt: 1_793_619_600, status: "allowed", ...over });
  const limit = (windows: Record<string, RateLimitWindow>, status = "allowed"): RateLimitInfo => ({ status, resetsAt: null, windows });
  const quota = (five: number, seven: number) => limit({ five_hour: win(five), seven_day: win(seven, { resetsAt: 1_793_646_000 }) });
  const withQuota = (rateLimit: RateLimitInfo) =>
    withWorker({ sessions: [makeSession({ conversationId: 1, pmId: 1, rateLimit, lastEventAt: 5 })] });
  const railNav = () => screen.getByRole("navigation", { name: "Workspace" });
  const badge = () => within(railNav()).getByRole("button", { name: /usage/i });
  const sandTone = () => badge().querySelector("svg.hourglass")?.getAttribute("data-tone");
  // 样例里的重置时间（1_793_619_600、1_793_646_000）要在“现在”之后，不然窗口算已重置
  const T_BEFORE_RESET = (1_793_619_600 - 3600) * 1000;
  const currentQuotaServer = { platform: "darwin", folderPicker: true, fileActions: true, currentQuota: true } as const;
  beforeEach(() => void vi.useFakeTimers({ toFake: ["Date"], now: T_BEFORE_RESET }));
  afterEach(() => void vi.useRealTimers());

  it("uses the current Codex account instead of the 30-day window from ledger session 201", async () => {
    vi.setSystemTime(new Date("2026-11-24T05:47:00Z"));
    const user = userEvent.setup();
    await boot(withWorker({
      server: currentQuotaServer,
      sessions: [
        makeSession({ sessionId: 201, vendor: "codex", lastEventAt: 1_794_118_727_948, rateLimit: {
          status: "allowed", resetsAt: 1_796_193_546, windows: { thirty_day: win(0.4, { resetsAt: 1_796_193_546 }) },
        } }),
        makeSession({ sessionId: 1221, vendor: "codex", lastEventAt: 1_795_409_451_168, rateLimit: limit({}, "rejected") }),
      ],
    }), (fake) => { fake.quota = () => ({ status: 200, body: {
      groups: [{ vendor: "codex", id: "codex", windows: { seven_day: win(0, { resetsAt: 1_796_104_026 }) } }],
    } }); });
    await within(railNav()).findByRole("button", { name: /usage/i });
    await user.click(badge());
    expect(screen.queryByRole("progressbar", { name: "30d usage" })).not.toBeInTheDocument();
    expect(await screen.findByRole("progressbar", { name: "7d usage" })).toHaveAttribute("aria-valuenow", "0");
  });

  it("shows current Claude and Antigravity quota before any session and omits expired windows", async () => {
    const user = userEvent.setup();
    await boot(withWorker({ server: currentQuotaServer, sessions: [] }), (fake) => {
      fake.quota = () => ({ status: 200, body: {
        groups: [
          { vendor: "claude", id: "claude", windows: { five_hour: win(0.9, { resetsAt: T_BEFORE_RESET / 1000 }), seven_day: win(0.05) } },
          { vendor: "agy", id: "gemini", windows: { five_hour: win(0.25) } },
        ],
      } });
    });
    await user.click(await within(railNav()).findByRole("button", { name: /5h usage 25%/ }));
    const claude = screen.getByRole("region", { name: "Claude" });
    expect(within(claude).queryByRole("progressbar", { name: "5h usage" })).not.toBeInTheDocument();
    expect(within(claude).getByRole("progressbar", { name: "7d usage" })).toHaveAttribute("aria-valuenow", "5");
    expect(within(screen.getByRole("group", { name: "Gemini" })).getByRole("progressbar", { name: "5h usage" })).toHaveAttribute("aria-valuenow", "25");
  });

  it("requests current quota while Usage is open and stops after it closes", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({
      toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
      shouldAdvanceTime: true,
      now: T_BEFORE_RESET,
    });
    const user = userEvent.setup();
    let utilization = 0.25;
    const readQuota = vi.fn(() => ({ status: 200, body: {
      groups: [{ vendor: "codex", id: "codex", windows: { five_hour: win(utilization) } }],
    } }));
    await boot(withWorker({ server: currentQuotaServer, sessions: [] }), (fake) => { fake.quota = readQuota; });
    await within(railNav()).findByRole("button", { name: /5h usage 25%/ });
    await act(() => vi.advanceTimersByTimeAsync(10 * FETCHED_QUOTA_FRESH_MS));
    expect(readQuota).toHaveBeenCalledTimes(1);
    expect(badge()).toHaveAccessibleName("Usage");

    utilization = 0.5;
    await user.click(badge());
    expect(await screen.findByRole("progressbar", { name: "5h usage" })).toHaveAttribute("aria-valuenow", "50");
    expect(readQuota).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(FETCHED_QUOTA_FRESH_MS));
    expect(readQuota).toHaveBeenCalledTimes(3);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Usage" })).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(10 * FETCHED_QUOTA_FRESH_MS));
    expect(readQuota).toHaveBeenCalledTimes(3);
  });

  describe("按需查的额度（agy）", () => {
    const agySession = () => makeSession({ sessionId: 9, conversationId: 30, vendor: "agy", lastEventAt: 5 });
    const agyWorker = () => withWorker({ sessions: [agySession()] });
    const claudeAndAgy = () =>
      withWorker({ sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1, rateLimit: quota(0.37, 0.59), lastEventAt: 5 }), agySession()] });
    const reply = {
      groups: [
        { vendor: "agy", id: "gemini", windows: { five_hour: win(0.25), seven_day: win(0.5, { resetsAt: 1_793_646_000 }) } },
        { vendor: "agy", id: "claude_gpt", windows: { five_hour: win(0.9) } },
      ],
    };
    const ask = () => api.calls.filter((c) => c.path === "/api/quota").length;

    it("打开面板才问；问到的每一组一块，窗口各一行；不改最左栏仪表", async () => {
      const user = userEvent.setup();
      await boot(claudeAndAgy());
      api.quota = () => ({ status: 200, body: reply });
      expect(ask()).toBe(0);
      await user.click(badge());
      const gemini = await screen.findByRole("group", { name: "Gemini" });
      expect(within(gemini).getByRole("progressbar", { name: "5h usage" })).toHaveAttribute("aria-valuenow", "25");
      expect(within(gemini).getByRole("progressbar", { name: "7d usage" })).toHaveAttribute("aria-valuenow", "50");
      expect(within(screen.getByRole("group", { name: "Claude and GPT" })).getByRole("progressbar", { name: "5h usage" })).toHaveAttribute("aria-valuenow", "90");
      expect(ask()).toBe(1);
      expect(badge()).toHaveAccessibleName(/7d usage 59%/);
    });

    it("没有别家的事件额度、有 agy 会话：按钮也在（沙漏图标），打开后先显示 Loading…，拉到后显示 agy 的", async () => {
      const user = userEvent.setup();
      await boot(agyWorker());
      expect(badge()).toHaveAccessibleName("Usage");
      expect(badge().querySelector("svg")).toHaveAttribute("data-icon", "line");
      const gate = deferred<{ status: number; body: unknown }>();
      api.quota = () => gate.promise;
      await user.click(badge());
      expect(await screen.findByText("Loading…")).toHaveClass("text-xs", "text-muted-foreground");
      gate.resolve({ status: 200, body: reply });
      expect(await screen.findByRole("group", { name: "Gemini" })).toBeInTheDocument();
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    });

    it("现查厂商（agy）某个窗口耗尽时面板照常显示各组窗口，最左栏仪表读本地事件占比", async () => {
      const user = userEvent.setup();
      await boot(claudeAndAgy());
      api.quota = () => ({
        status: 200,
        body: {
          groups: [{ vendor: "agy", id: "gemini", windows: { five_hour: win(1) } }],
        },
      });
      await user.click(badge());
      await screen.findByRole("group", { name: "Gemini" });
      expect(badge()).toHaveAccessibleName(/7d usage 59%/);
    });

    it("查失败或没有：不显示 agy 那块，别家的照常", async () => {
      const user = userEvent.setup();
      await boot(claudeAndAgy());
      await user.click(badge());
      await waitFor(() => expect(ask()).toBe(1));
      expect(screen.getByRole("region", { name: "Claude" })).toBeInTheDocument();
      expect(screen.queryByRole("region", { name: /Antigravity/ })).not.toBeInTheDocument();
    });

    it("没有任何额度来源（没有事件额度、没有 agy 会话）：不显示按钮，也不问", async () => {
      await boot();
      expect(screen.queryByRole("button", { name: /usage/i })).not.toBeInTheDocument();
      expect(ask()).toBe(0);
    });
  });

  it("右上角没有额度和“N 个 Worker 在跑”了", async () => {
    await boot(withQuota(quota(0.37, 0.59)));
    expect(screen.queryByText(/额度已用/)).not.toBeInTheDocument();
    expect(screen.queryByText(/个 Worker 在跑/)).not.toBeInTheDocument();
  });

  it("还没有额度数据：不显示", async () => {
    await boot();
    expect(screen.queryByRole("button", { name: /usage/i })).not.toBeInTheDocument();
  });

  it("最左栏只画沙漏、不写百分比，悬停和读屏带窗口信息", async () => {
    await boot(withQuota(quota(0.37, 0.59)));
    expect(badge().textContent).toBe("");
    expect(badge()).toHaveAccessibleName(/7d usage 59%/);
    expect(badge().getAttribute("title")).toMatch(/7d usage 59%/);
    expect(sandTone()).toBe("normal");
  });

  it("推 session.status 带来新的额度：跟着变", async () => {
    const ws = await boot(withQuota(quota(0.37, 0.59)));
    push(ws, sessionChange(11, makeSession({ conversationId: 1, pmId: 1, rateLimit: quota(0.4, 0.6), lastEventAt: 9 })));
    expect(badge()).toHaveAccessibleName(/7d usage 60%/);
  });

  describe("到了重置时间", () => {
    const RESET = 1_793_773_800;
    const NEXT_RESET = 1_793_791_800;
    const rl = (five: number, fiveReset: number, status = "allowed") => ({
      ...limit({ five_hour: win(five, { resetsAt: fiveReset, status }), seven_day: win(0.31, { resetsAt: 1_794_250_800 }) }, status),
      resetsAt: fiveReset,
    });
    const clock = (nowSeconds: number) => vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true, now: nowSeconds * 1000 });
    const advance = (seconds: number) => act(() => void vi.advanceTimersByTime(seconds * 1000));

    it("页面开着不动：到了 resetsAt 自己从 99% 落回仍未重置窗口（31%），5h 重置字样消失", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      clock(RESET - 600);
      await boot(withQuota(rl(0.99, RESET, "allowed_warning")));
      expect(badge()).toHaveAccessibleName(/5h usage 99%/);
      expect(sandTone()).toBe("warning");
      advance(599);
      expect(badge()).toHaveAccessibleName(/5h usage 99%/);
      advance(2);
      expect(badge()).toHaveAccessibleName(/7d usage 31%/);
      expect(sandTone()).toBe("normal");
      await user.click(badge());
      expect(screen.getByRole("progressbar", { name: "5h usage" })).toHaveAttribute("aria-valuenow", "0");
      expect(screen.getByRole("progressbar", { name: "7d usage" })).toHaveAttribute("aria-valuenow", "31");
      expect(screen.getAllByText(/Resets/)).toHaveLength(1);
    });

    it("重置后新的 rate_limit_event 一到（新 resetsAt）：马上显示新窗口的值", async () => {
      clock(RESET - 600);
      await boot(withQuota(rl(0.99, RESET, "allowed_warning")));
      advance(601);
      expect(badge()).toHaveAccessibleName(/7d usage 31%/);
      act(() => window.dispatchEvent(new Event("online")));
      act(() => FakeWebSocket.last.open());
      push(FakeWebSocket.last, sessionChange(11, makeSession({ conversationId: 1, pmId: 1, rateLimit: rl(0.03, NEXT_RESET), lastEventAt: 9 })));
      expect(badge()).toHaveAccessibleName(/7d usage 31%|5h usage 3%/);
    });

    it("用完了（已用完）：到了 resetsAt 自己恢复正常状态", async () => {
      clock(RESET - 600);
      await boot(withQuota(rl(1, RESET, "rejected")));
      expect(badge()).toHaveAccessibleName(/5h usage 100%/);
      expect(sandTone()).toBe("full");
      advance(601);
      expect(badge()).toHaveAccessibleName(/7d usage 31%/);
      expect(sandTone()).toBe("normal");
    });
  });

  it("按 80% 警告和 100% 满格区分沙子颜色，普通用量保持默认沙色", async () => {
    const ws = await boot(withQuota(limit({ five_hour: win(0.79, { status: "allowed" }) })));
    expect(sandTone()).toBe("normal");
    push(ws, sessionChange(12, makeSession({ conversationId: 1, pmId: 1, rateLimit: limit({ five_hour: win(0.85, { status: "allowed_warning" }) }), lastEventAt: 8 })));
    expect(sandTone()).toBe("warning");
  });

  it("用完了（rejected）：仪表读作 100% 且沙子用危险色", async () => {
    await boot(withQuota(limit({ five_hour: win(1, { status: "rejected" }) }, "rejected")));
    expect(badge()).toHaveAccessibleName(/5h usage 100%/);
    expect(sandTone()).toBe("full");
  });

  it("点开小窗口：按厂商分组，每个窗口一行：名字、百分比、进度条、重置时间", async () => {
    const user = userEvent.setup();
    await boot(withQuota(quota(0.37, 0.59)));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(badge());
    const group = screen.getByRole("region", { name: "Claude" });
    expect(within(group).getByRole("heading", { name: "Claude" })).toBeInTheDocument();
    const five = within(group).getByRole("progressbar", { name: "5h usage" });
    expect(five).toHaveAttribute("aria-valuenow", "37");
    expect(within(group).getByRole("progressbar", { name: "7d usage" })).toHaveAttribute("aria-valuenow", "59");
    expect(within(group).getByText("37%")).toBeInTheDocument();
    expect(within(group).getByText("59%")).toBeInTheDocument();
    expect(within(group).getByText(`Resets ${formatQuotaReset(1_793_619_600)}`)).toBeInTheDocument();
    expect(within(group).getByText(`Resets ${formatQuotaReset(1_793_646_000)}`)).toBeInTheDocument();
    expect(within(group).getAllByRole("progressbar")).toHaveLength(2);
  });

  it("小窗口高度受可用空间限制、里面能滚：窗口矮时顶部的厂商标题不会被切掉", async () => {
    const user = userEvent.setup();
    await boot(withQuota(quota(0.37, 0.59)));
    await user.click(badge());
    // jsdom 量不了版面：锁住用了 Radix 的 available-height 变量和 overflow 设置（collisionPadding 12px 已在变量里扣掉）
    const panel = screen.getByRole("dialog", { name: "Usage" });
    expect(panel).toHaveClass("max-h-(--radix-popover-content-available-height)", "overflow-y-auto");
  });

  it("用量条颜色：正常暖棕（brand-ink）、偏高琥珀（caution）、用满红色（danger）；未用满时百分比不上告警色", async () => {
    const user = userEvent.setup();
    await boot(withQuota(limit({ five_hour: win(0.37), seven_day: win(0.85, { resetsAt: 1_793_646_000 }) })));
    await user.click(badge());
    const fill = (name: string) => screen.getByRole("progressbar", { name }).firstElementChild!.className;
    expect(fill("5h usage")).toContain("bg-brand-ink");
    expect(fill("7d usage")).toContain("bg-caution");
    expect(within(screen.getByRole("dialog", { name: "Usage" })).getByText("85%")).not.toHaveClass("text-danger", "text-warn-foreground", "text-rail-danger", "text-rail-warn");
  });

  it("只有一个窗口有数据：标识显示它，小窗口里只有一行", async () => {
    const user = userEvent.setup();
    await boot(withQuota(limit({ seven_day: win(0.2) })));
    expect(badge()).toHaveAccessibleName(/7d usage 20%/);
    await user.click(badge());
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    expect(screen.getByRole("progressbar", { name: "7d usage" })).toBeInTheDocument();
  });

  it("脏数据：超过 1 夹成 100%，负数夹成 0%，没有重置时间的不显示重置", async () => {
    const user = userEvent.setup();
    await boot(withQuota(limit({ five_hour: win(1.7, { resetsAt: 0 }), seven_day: win(-0.3) })));
    expect(badge()).toHaveAccessibleName(/5h usage 100%/);
    await user.click(badge());
    expect(screen.getByRole("progressbar", { name: "5h usage" })).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByRole("progressbar", { name: "7d usage" })).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getAllByText(/Resets/)).toHaveLength(1);
  });
});

describe("右栏工作面板（Active、Completed、Info 与 Worker 详情，推开对话）", () => {
  const toggle = () => screen.queryByRole("button", { name: /(?:Show|Hide) work panel/ });
  const closeRail = () => within(rail()!).getByRole("button", { name: "Close work panel" });
  const rail = () => screen.queryByRole("complementary", { name: "Work panel" });
  const workerGroup = () => within(rail()!).getByRole("region", { name: "Workers" });
  const rows = () =>
    within(workerGroup())
      .getAllByRole("button")
      .map((b) => b.textContent);
  /** 小林（对话 1）派了 30 修 X、31 写文档、32 查日志；老马（对话 2）派了 40 老马的活。 */
  const crowd = (over: Partial<StateSnapshot> = {}) =>
    withWorker({
      pms: [makePm({ id: 1, name: "小林" }), makePm({ id: 2, name: "老马" })],
      conversations: [
        makeConvSnapshot([makeWorkerLine({ id: 2, conversationId: 1, line: { event: "started" } })], { conversation: { id: 1, pmId: 1, title: "小林" } }),
        makeConvSnapshot([], { conversation: { id: 2, pmId: 2, title: "老马" } }),
        makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 30, title: "修 X" }) }),
        makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 31, title: "写文档" }) }),
        makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 32, title: "查日志" }) }),
        makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 40, pmId: 2, title: "老马的活" }) }),
      ],
      sessions: [
        makeSession({ sessionId: 1, conversationId: 1, pmId: 1 }),
        makeSession({ sessionId: 2, conversationId: 2, pmId: 2 }),
        makeSession({ sessionId: 3, conversationId: 30, status: "running", activity: "working" }),
        makeSession({ sessionId: 4, conversationId: 31 }),
        makeSession({ sessionId: 5, conversationId: 32, status: "ended" }),
        makeSession({ sessionId: 6, conversationId: 40 }),
      ],
      ...over,
    });
  const alone = () => makeSnapshot({ pms: [makePm({ id: 1, name: "小林" })], conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, title: "小林" } })] });
  const installShellSize = () => {
    const observers: { cb: ResizeObserverCallback; targets: Set<Element> }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private entry: { cb: ResizeObserverCallback; targets: Set<Element> };
        constructor(cb: ResizeObserverCallback) {
          this.entry = { cb, targets: new Set() };
          observers.push(this.entry);
        }
        observe(target: Element) {
          this.entry.targets.add(target);
        }
        disconnect() {
          this.entry.targets.clear();
        }
        unobserve(target: Element) {
          this.entry.targets.delete(target);
        }
      },
    );
    return (width: number) => {
      const shell = document.querySelector<HTMLElement>("[data-shell='desktop']")!;
      shell.getBoundingClientRect = () => ({ width, height: 800, top: 0, left: 0, right: width, bottom: 800, x: 0, y: 0, toJSON: () => ({}) });
      act(() => {
        for (const { cb, targets } of observers) {
          if (targets.has(shell)) cb([{ target: shell, contentRect: { width } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
        }
      });
    };
  };

  it("没有活跃任务图和 Worker：右栏默认收起，顶栏开关仍在，点开看到空态", async () => {
    const user = userEvent.setup();
    await boot(alone());
    expect(toggle()).toHaveAccessibleName("Show work panel");
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(rail()).not.toBeInTheDocument();
    await user.click(toggle()!);
    expect(rail()).toBeInTheDocument();
    expect(within(rail()!).getByText("Nothing running")).toBeInTheDocument();
  });

  it("有 Worker：自动展开；和对话在同一个 PaneGroup 并排，不浮在对话上面；对话和输入框一直在", async () => {
    await boot(crowd());
    const aside = rail()!;
    const main = screen.getByRole("main");
    expect(aside.closest("main")).toBeNull();
    expect(aside.closest("[data-panel]")?.parentElement).toBe(main.closest("[data-panel]")?.parentElement);
    const classes = aside.className.split(" ");
    expect(classes.some((c) => /(^|:)(fixed|absolute)$/.test(c))).toBe(false);
    // Both content panes are white sheets in one inlaid block: the conversation joins the list, the side panel stands alone.
    const sheetOf = (el: Element) => el.closest(".shell-sheet");
    expect(sheetOf(aside)).not.toBeNull();
    expect(sheetOf(aside)).not.toHaveClass("shell-sheet-joined");
    expect(sheetOf(main)).toHaveClass("shell-sheet-joined");
    expect(sheetOf(aside)!.closest(".shell-group")).toBe(sheetOf(main)!.closest(".shell-group"));
    expect(screen.getByRole("separator", { name: "Resize side panel" })).toHaveAttribute("data-seam", "gap");
    expect(screen.getByRole("separator", { name: "Resize project list" })).toHaveAttribute("data-seam", "joint");
    expect(within(main).getByRole("heading", { name: "小林" })).toBeInTheDocument();
    expect(within(main).getByRole("textbox")).toBeVisible();
  });

  it("顶栏显示 Active、Completed、Info 三个页签，无 Needs You 组也不出现 Pieces", async () => {
    await boot(
      crowd({
        conversations: [
          makeConvSnapshot([makeMessage({ id: 5, conversationId: 1, text: "用 A 还是 B？", meta: { needsUser: true } })], { conversation: { id: 1, pmId: 1, title: "小林" } }),
          makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 30, title: "修 X" }) }),
        ],
      }),
    );
    const tabs = within(rail()!).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual(["Active", "Completed", "Info"]);
    expect(tabs[0]).toHaveTextContent("Active1");
    expect(within(rail()!).queryByRole("region", { name: /^Needs You/ })).toBeNull();
    expect(rail()!.textContent).not.toMatch(/\bPieces?\b/i);
  });

  it("开关：对话顶栏的工作面板按钮和面板关闭按钮都能收起与展开", async () => {
    const user = userEvent.setup();
    await boot(crowd());
    const header = screen.getByRole("heading", { name: "小林" }).closest("header")!;
    expect(within(header).getByRole("button", { name: "Hide work panel" })).toBe(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(toggle()).toHaveClass("aria-expanded:bg-hover");
    await user.click(closeRail());
    expect(rail()).not.toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Show work panel" })).toBe(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle()!);
    expect(rail()).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Hide work panel" })).toBe(toggle());
  });

  it("手动收起后记住：刷新后还是收着；之后来了新的 Worker 也不自己弹开", async () => {
    const user = userEvent.setup();
    await boot(crowd());
    await user.click(toggle()!);
    cleanup();
    const ws = await boot(crowd());
    expect(rail()).not.toBeInTheDocument();
    push(ws, changeOf(11, "conversation.created", { conversation: makeWorkerConversation({ id: 33, title: "新活" }) }));
    expect(rail()).not.toBeInTheDocument();
    await user.click(toggle()!);
    cleanup();
    await boot(crowd());
    expect(rail()).toBeInTheDocument();
  });

  it("独立 Worker 行只有状态图标、标题和右箭头，不写状态词", async () => {
    await boot(crowd());
    expect(rail()!).not.toHaveTextContent(/Working…|Idle/);
    expect(rows()).toEqual(["修 X", "写文档"]);
    expect(within(rail()!).queryByRole("button", { name: /查日志/ })).not.toBeInTheDocument();
    const rowBtn = within(workerGroup()).getByRole("button", { name: /修 X/ });
    expect(rowBtn.querySelector("[data-status='running']")).not.toBeNull();
  });

  it("Completed 页签按需拉取 /api/pms/:id/completed 并显示已完成工作", async () => {
    const user = userEvent.setup();
    await boot(crowd(), (fake) => {
      fake.completedWork = () => ({
        status: 200,
        body: {
          total: 1,
          next: null,
          items: [
            {
              kind: "worker",
              conversationId: 32,
              workerId: 32,
              title: "查日志",
              outcome: "done",
              finishedAt: Date.now(),
              prUrl: null,
            },
          ],
        },
      });
    });
    await waitFor(() => expect(within(rail()!).getByRole("tab", { name: /Completed/ })).toHaveTextContent("Completed1"));
    await user.click(within(rail()!).getByRole("tab", { name: /Completed/ }));
    expect(await within(rail()!).findByRole("button", { name: /查日志/ })).toBeInTheDocument();
  });

  it("一堆收工的 Worker：Active 页签只列在干活的", async () => {
    const ended = Array.from({ length: 30 }, (_, i) => 100 + i);
    await boot(
      crowd({
        conversations: [
          makeConvSnapshot([], { conversation: { id: 1, pmId: 1, title: "小林" } }),
          makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 30, title: "修 X" }) }),
          ...ended.map((id) => makeConvSnapshot([], { conversation: makeWorkerConversation({ id, title: `旧活 ${id}` }) })),
        ],
        sessions: [
          makeSession({ sessionId: 1, conversationId: 1, pmId: 1 }),
          makeSession({ sessionId: 3, conversationId: 30, status: "running", activity: "working" }),
          ...ended.map((id) => makeSession({ sessionId: id, conversationId: id, status: "ended" })),
        ],
      }),
    );
    expect(rows()).toEqual(["修 X"]);
    expect(within(rail()!).getByRole("tab", { name: /Active/ })).toHaveTextContent("Active1");
  });

  it("打开一个已收工的 Worker 的对话：在右侧面板打开详情，点返回切回工作面板", async () => {
    const user = userEvent.setup();
    await boot(crowd());
    window.location.hash = "#/w/32";
    const panel = await screen.findByRole("complementary", { name: "查日志" });
    expect(within(panel).getByRole("region", { name: "Worker 查日志" })).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Back to 小林" }));
    expect(rail()).toBeInTheDocument();
  });

  it("各状态：准备中算在跑排前面，停止中不算；不认识的 activity 当在跑；行里都不写状态词", async () => {
    const stopping = makeSession({ sessionId: 3, conversationId: 30, activity: "stopping" });
    const preparing = makeSession({ sessionId: 4, conversationId: 31, activity: "preparing" });
    const unknown = makeSession({ sessionId: 6, conversationId: 40, activity: "bogus" as SessionState["activity"] });
    await boot(crowd({ sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1 }), stopping, preparing, makeSession({ sessionId: 5, conversationId: 32, status: "ended" }), unknown] }));
    expect(rows()).toEqual(["写文档", "修 X"]);
    await userEvent.setup().click(navRow(/老马/));
    expect(rows()).toEqual(["老马的活"]);
  });

  it("项目经理的会话里有“收工”那一行也算收工；会话还没有的 Worker 照常列出", async () => {
    const lines = [
      makeWorkerLine({ id: 2, conversationId: 1, line: { workerConversationId: 31, event: "ended" } }),
      makeWorkerLine({ id: 3, conversationId: 1, line: { workerConversationId: 32, event: "worktree_failed" } }),
    ];
    await boot(
      crowd({
        conversations: [
          makeConvSnapshot(lines, { conversation: { id: 1, pmId: 1, title: "小林" } }),
          makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 30, title: "修 X" }) }),
          makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 31, title: "写文档" }) }),
          makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 32, title: "查日志" }) }),
        ],
        sessions: [],
      }),
    );
    expect(rows()).toEqual(["修 X"]);
  });

  describe("模型、思考程度、token", () => {
    const usage = { input: 392, cacheRead: 47_000_000, cacheWrite: 448_354, output: 154_408, context: 117_000 };
    const withAgent = (over: Partial<SessionState>) =>
      crowd({
        sessions: [
          makeSession({ sessionId: 1, conversationId: 1, pmId: 1 }),
          makeSession({ sessionId: 3, conversationId: 30, status: "running", activity: "working", ...over }),
        ],
      });

    it("点进 Worker 详情：顶栏无 meta 行，⋯ 菜单显示模型与思考程度", async () => {
      const user = userEvent.setup();
      await boot(withAgent({ vendor: "claude", model: "sonnet", effort: "high", usage }));
      await user.click(within(workerGroup()).getByRole("button", { name: /修 X/ }));
      const panel = screen.getByRole("complementary", { name: "修 X" });
      expect(within(panel).queryByTestId("piece-meta")).toBeNull();
      await user.click(within(panel).getByRole("button", { name: "More worker actions" }));
      expect(await screen.findByText("Sonnet High")).toBeInTheDocument();
    });

    it("默认模型：厂商的模型名单说了实际是哪个（defaultModel），⋯ 菜单就写它", async () => {
      const user = userEvent.setup();
      const snap = withAgent({ vendor: "claude", model: null, effort: null, usage });
      openFirstConversation(snap);
      const fake = new FakeApi(snap);
      fake.models = () => ({ status: 200, body: { catalogs: [{ ...bundledModelCatalog("claude"), source: "vendor", defaultModel: "Opus 5.5" }] } });
      fake.install();
      installFakeWebSocket();
      render(<App />);
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      act(() => FakeWebSocket.last.open());
      await user.click(within(workerGroup()).getByRole("button", { name: /修 X/ }));
      const panel = screen.getByRole("complementary", { name: "修 X" });
      await user.click(within(panel).getByRole("button", { name: "More worker actions" }));
      expect(await screen.findByText("Opus 5.5")).toBeInTheDocument();
    });

    it("标题超长时截断，不撑破", async () => {
      await boot(withAgent({ vendor: "claude", model: "sonnet", usage }));
      const row = within(workerGroup()).getByRole("button", { name: /修 X/ });
      expect(within(row).getByText("修 X")).toHaveClass("truncate");
    });
  });

  it("点一行在右侧面板打开那个 Worker 的对话（网址跟着变），返回回到工作面板", async () => {
    const user = userEvent.setup();
    await boot(crowd());
    const row = (name: RegExp) => within(workerGroup()).getByRole("button", { name });
    await user.click(row(/修 X/));
    expect(screen.getByRole("region", { name: "Worker 修 X" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#/w/30");
    await user.click(screen.getByRole("button", { name: "Back to 小林" }));
    expect(rail()).toBeInTheDocument();
    expect(window.location.hash).toBe("#/c/1");
    await user.click(row(/写文档/));
    expect(screen.getByRole("region", { name: "Worker 写文档" })).toBeInTheDocument();
    await user.click(navRow(/小林/));
    expect(window.location.hash).toBe("#/c/1");
  });

  it("切换项目经理：列表跟着变；对方没有活跃工作时自动收起面板但保留开关", async () => {
    const user = userEvent.setup();
    await boot(crowd());
    await user.click(navRow(/老马/));
    expect(rows()).toEqual(["老马的活"]);
    cleanup();
    await boot(crowd({ conversations: crowd().conversations.filter((c) => c.conversation.id !== 40) }));
    await user.click(navRow(/老马/));
    expect(toggle()).toBeInTheDocument();
    expect(rail()).not.toBeInTheDocument();
  });

  it("实时变：收工那一行一来，这个 Worker 从 Active 列表移出", async () => {
    const ws = await boot(crowd());
    expect(rows()).toEqual(["修 X", "写文档"]);
    push(ws, messageChange(12, "message.created", makeWorkerLine({ id: 50, conversationId: 1, line: { workerConversationId: 30, event: "ended" } })));
    expect(rows()).toEqual(["写文档"]);
  });

  it("第一个 Worker 一派出来，右栏自己展开", async () => {
    const ws = await boot(alone());
    expect(rail()).not.toBeInTheDocument();
    push(ws, changeOf(11, "conversation.created", { conversation: makeWorkerConversation({ id: 33, title: "新活" }) }));
    expect(rows()).toEqual(["新活"]);
  });

  describe("没有活跃工作（没有在干活的 Worker 或活跃任务图）：右栏默认收起", () => {
    const onlyEnded = () => crowd({ sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1 }), makeSession({ sessionId: 3, conversationId: 30, status: "ended" })], conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, title: "小林" } }), makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 30, title: "修 X" }) })] });
    const header = () => screen.getByRole("heading", { name: "小林" }).closest("header")!;

    it("只有收工的 Worker：右栏默认收起，顶栏按钮在；点开关打开，再点关闭并记住", async () => {
      const user = userEvent.setup();
      await boot(onlyEnded());
      expect(rail()).not.toBeInTheDocument();
      expect(within(header()).getByRole("button", { name: "Show work panel" })).toBeInTheDocument();
      await user.click(toggle()!);
      expect(rail()).toBeInTheDocument();
      await user.click(closeRail());
      expect(rail()).not.toBeInTheDocument();
      expect(localStorage.getItem("agent-hub.rightRail")).toBe("closed");
    });

    it("手动打开后，来了在干活的 Worker 照样开着；手动打开的不记成“收起”", async () => {
      const user = userEvent.setup();
      const ws = await boot(onlyEnded());
      await user.click(toggle()!);
      expect(localStorage.getItem("agent-hub.rightRail")).toBeNull();
      push(ws, changeOf(11, "conversation.created", { conversation: makeWorkerConversation({ id: 33, title: "新活" }) }));
      expect(rows()).toEqual(["新活"]);
    });

    it("来了新的未收工 Worker：右栏自动出来", async () => {
      const ws = await boot(onlyEnded());
      expect(rail()).not.toBeInTheDocument();
      push(ws, changeOf(11, "conversation.created", { conversation: makeWorkerConversation({ id: 33, title: "新活" }) }));
      expect(rows()).toEqual(["新活"]);
    });

    it("在干活的 Worker 都收工了：右栏自己收起，开关还在", async () => {
      const ws = await boot(crowd({ sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1 }), makeSession({ sessionId: 3, conversationId: 30, status: "running", activity: "working" })], conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, title: "小林" } }), makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 30, title: "修 X" }) })] }));
      expect(rail()).toBeInTheDocument();
      push(ws, messageChange(12, "message.created", makeWorkerLine({ id: 50, conversationId: 1, line: { workerConversationId: 30, event: "ended" } })));
      expect(rail()).not.toBeInTheDocument();
      expect(toggle()).toHaveAttribute("aria-expanded", "false");
    });
  });

  it("窄窗：项目列表在原头像条宽度区间和窗口下限都保留搜索框、头像和名字，右栏盖住对话", async () => {
    const resizeShell = installShellSize();
    await boot(crowd());
    for (const width of [1141, 1100, 994, 860]) {
      resizeShell(width);
      const listRegion = screen.getByRole("region", { name: "This computer" });
      expect(listRegion).not.toHaveClass("w-18");
      expect(within(listRegion).getByRole("searchbox", { name: "Search conversations" })).toBeInTheDocument();
      expect(within(listRegion).getByTitle("老马").closest(".project-row")?.querySelector(".avatar-tile")).not.toBeNull();
      expect(rail()).toHaveAttribute("data-layout", "stack");
    }
    resizeShell(1249);
    expect(rail()).not.toHaveAttribute("data-layout", "stack");
    expect(screen.getByRole("region", { name: "This computer" })).not.toHaveClass("w-18");
  });

  it("宽屏带完整项目列表和搜索框，没有抽屉切换按钮", async () => {
    await boot(crowd());
    const listRegion = screen.getByRole("region", { name: "This computer" });
    expect(within(listRegion).getByRole("searchbox", { name: "Search conversations" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Conversations" })).not.toBeInTheDocument();
  });

  it("Worker 详情点 Back 回到工作面板且不写入 closed；点 Close work panel 关掉整栏并写 closed", async () => {
    const user = userEvent.setup();
    await boot(crowd());
    expect(rail()).toBeInTheDocument();
    expect(localStorage.getItem("agent-hub.rightRail")).toBeNull();

    await user.click(within(workerGroup()).getByRole("button", { name: /修 X/ }));
    expect(screen.getByRole("complementary", { name: "修 X" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to 小林" }));
    expect(localStorage.getItem("agent-hub.rightRail")).toBeNull();
    expect(rail()).toBeInTheDocument();

    await user.click(within(workerGroup()).getByRole("button", { name: /修 X/ }));
    await user.click(screen.getByRole("button", { name: "Close work panel" }));
    expect(localStorage.getItem("agent-hub.rightRail")).toBe("closed");
    expect(rail()).not.toBeInTheDocument();
  });

  it("窄窗 stack 档：侧栏叠盖主对话且不销毁聊天状态，点 Worker 切换详情、返回工作面板再关掉恢复对话", async () => {
    const resizeShell = installShellSize();
    const user = userEvent.setup();
    await boot(crowd());
    resizeShell(720);
    expect(rail()).toHaveAttribute("data-layout", "stack");
    expect(document.querySelector("main")!.closest("[hidden], .hidden")).not.toBeNull();
    await user.click(within(workerGroup()).getByRole("button", { name: /修 X/ }));
    expect(screen.getByRole("complementary", { name: "修 X" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to 小林" }));
    expect(rail()).toBeInTheDocument();
    expect(localStorage.getItem("agent-hub.rightRail")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Close work panel" }));
    expect(screen.getByRole("main")).toBeVisible();
  });
});

describe("formatTokens / formatCount", () => {
  it("不到 1000 原样；1000 以上用 K、M，3 位有效数字，去掉多余的 0", () => {
    expect(formatTokens(0)).toBe("0 tokens");
    expect(formatTokens(1)).toBe("1 token");
    expect(formatTokens(820)).toBe("820 tokens");
    expect(formatTokens(999)).toBe("999 tokens");
    expect(formatTokens(1000)).toBe("1K tokens");
    expect(formatTokens(1234)).toBe("1.23K tokens");
    expect(formatTokens(12_340)).toBe("12.3K tokens");
    expect(formatTokens(291_000)).toBe("291K tokens");
    expect(formatTokens(6_480_000)).toBe("6.48M tokens");
    expect(formatTokens(64_800_000)).toBe("64.8M tokens");
    expect(formatTokens(648_000_000)).toBe("648M tokens");
    expect(formatTokens(1_234_000_000)).toBe("1234M tokens");
  });

  it("K 和 M 的边界：999_999 进到 1M，不写成 1000K", () => {
    expect(formatCount(999_499)).toBe("999K");
    expect(formatCount(999_500)).toBe("1M");
    expect(formatCount(999_999)).toBe("1M");
    expect(formatCount(1_000_000)).toBe("1M");
  });

  it("formatContext：现在的对话长度（不是累计）；没有记录（老 Worker、还没干过活）显示“—”", () => {
    expect(formatContext({ input: 100, cacheRead: 200_000, cacheWrite: 90_000, output: 1000, context: 158_000 })).toBe("158K context");
    expect(formatContext({ input: 100, cacheRead: 200_000, cacheWrite: 90_000, output: 1000, context: 820 })).toBe("820 context");
    expect(formatContext({ input: 100, cacheRead: 200_000, cacheWrite: 90_000, output: 1000, context: 0 })).toBe("—");
  });
});

describe("selectors", () => {
  const loaded = (snapshot: StateSnapshot) => reducer(initialState, { type: "loaded", snapshot });

  it("workerPhaseOf：收工（已收工、建 worktree 失败那一行，或会话 ended）/ 准备中（任务说明还在排队）/ 能接话", () => {
    const at = (workerMessages: Message[], lines: Message[] = [], status: "idle" | "ended" = "idle", activity: SessionState["activity"] = "idle") =>
      workerPhaseOf(
        loaded(
          withWorker({
            conversations: [
              makeConvSnapshot([makeWorkerLine({ id: 2, conversationId: 1 }), ...lines], { conversation: { id: 1, pmId: 1, title: "小林" } }),
              makeConvSnapshot(workerMessages, { conversation: makeWorkerConversation() }),
            ],
            sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1 }), makeSession({ sessionId: 2, conversationId: 30, status, activity })],
          }),
        ),
        30,
      );
    const task = (status: Message["status"]) => makeMessage({ id: 10, conversationId: 30, sender: "pm", status, text: "任务" });
    expect(at([task("queued")])).toBe("preparing");
    expect(at([task("delivered")])).toBe("open");
    expect(at([task("replied"), makeMessage({ id: 11, conversationId: 30, sender: "pm", status: "queued", text: "打回" })])).toBe("open");
    expect(at([task("replied")], [makeWorkerLine({ id: 3, conversationId: 1, line: { event: "ended" } })])).toBe("ended");
    expect(at([task("failed")], [makeWorkerLine({ id: 3, conversationId: 1, line: { event: "worktree_failed" } })])).toBe("ended");
    expect(at([task("queued")], [], "ended")).toBe("ended");
    // 正在跑准备命令（PR #47）
    expect(at([task("delivered")], [], "idle", "preparing")).toBe("preparing");
  });

  it("listConversations 不含 kind worker 的对话", () => {
    expect(listConversations(loaded(withWorker())).map((e) => e.id)).toEqual([1]);
  });

  it("quotaUsage：厂商 → 窗口；每个窗口各取最新的那个值（重置时间晚的）；没有数据的窗口、厂商不返回", () => {
    const state = loaded(
      withWorker({
        sessions: [
          makeSession({
            sessionId: 1,
            conversationId: 1,
            lastEventAt: 100,
            rateLimit: { status: "allowed", resetsAt: null, windows: { five_hour: { utilization: 0.2, resetsAt: 1, status: "allowed" } } },
          }),
          makeSession({
            sessionId: 2,
            conversationId: 30,
            lastEventAt: 200,
            rateLimit: { status: "allowed", resetsAt: null, windows: { five_hour: { utilization: 0.3, resetsAt: 7, status: "allowed" } } },
          }),
          makeSession({ sessionId: 3, conversationId: 31, lastEventAt: 300, rateLimit: null }),
        ],
      }),
    );
    expect(quotaUsage(state, 0)).toEqual([
      { id: "claude", name: "Claude", exhausted: false, windows: [{ key: "five_hour", short: "5h", percent: 30, resetsAt: 7, warning: false }] },
    ]);
    expect(quotaUsage(loaded(withWorker()), 0)).toEqual([]);
  });

  it("fetchedQuotaUsage：服务端回的每一组是一块（name 是厂商名，group 是组名，都按 vendor + 组 id 从 spec 取，不拼“·”），窗口按 5 小时、7 天；已过重置时间的算 0%；认不出的组、厂商跳过", () => {
    const res: QuotaResponse = {
      groups: [
        { vendor: "agy", id: "gemini", windows: { seven_day: { utilization: 0.1, resetsAt: 9_000, status: "allowed" }, five_hour: { utilization: 0.85, resetsAt: 5_000, status: "allowed" } } },
        { vendor: "agy", id: "不认识的组", windows: { five_hour: { utilization: 0.5, resetsAt: 9_000, status: "allowed" } } },
        // 同一个组 id 但这家没有按需查的额度（不是 agy 的组）：不当成 agy 的
        { vendor: "codex", id: "gemini", windows: { five_hour: { utilization: 0.5, resetsAt: 9_000, status: "allowed" } } },
        { vendor: "不认识的厂商" as AgentVendor, id: "gemini", windows: { five_hour: { utilization: 0.5, resetsAt: 9_000, status: "allowed" } } },
      ],
    };
    expect(fetchedQuotaUsage(res, 0)).toEqual([
      {
        id: "gemini",
        name: "Antigravity",
        group: "Gemini",
        exhausted: false,
        windows: [
          { key: "five_hour", short: "5h", percent: 85, resetsAt: 5_000, warning: true },
          { key: "seven_day", short: "7d", percent: 10, resetsAt: 9_000, warning: false },
        ],
      },
    ]);
    expect(fetchedQuotaUsage(res, 6_000_000)[0]!.windows[0]).toMatchObject({ percent: 0, resetsAt: null, warning: false });
    expect(fetchedQuotaUsage({ groups: [] }, 0)).toEqual([]);
  });

  it("新网页兼容旧后台不带 vendor 的 quota；旧网页按组 id 仍能读新响应", () => {
    const windows = { five_hour: { utilization: 0.85, resetsAt: 5000, status: "allowed" as const } };
    const legacy = { groups: [{ id: "gemini", name: "Gemini", windows }] };
    const current: QuotaResponse = { groups: [{ vendor: "agy", id: "gemini", windows }] };
    expect(fetchedQuotaUsage(legacy, 0)).toEqual(fetchedQuotaUsage(current, 0));
    expect(fetchedQuotaUsage(legacy, 0)[0]).toMatchObject({ name: "Antigravity", group: "Gemini" });
    // 旧网页只读取 id/windows，再从本地 spec 取组名。
    const oldGroup = vendorSpec("agy").quota!.fetched!.groups.find((g) => g.key === current.groups[0]!.id);
    expect(oldGroup?.name).toBe("Gemini");
  });

  // 真实数据（2026-11-07 21:04）：codex 会话的 30 天窗口 resetsAt 1796193545（12/2 14:39）比 claude 会话的 5 小时窗口 1794070800 晚，
  // 以前各家的会话混着挑“重置时间晚的”，claude 的 5 小时就显示成了 codex 的时间。
  it("quotaUsage：每家厂商只看自己会话的额度，不混", () => {
    const state = loaded(
      withWorker({
        sessions: [
          makeSession({
            sessionId: 1,
            conversationId: 1,
            vendor: "claude",
            lastEventAt: 100,
            rateLimit: { status: "allowed", resetsAt: null, windows: { five_hour: { utilization: 0.06, resetsAt: 1_794_070_800, status: "allowed" } } },
          }),
          makeSession({
            sessionId: 2,
            conversationId: 30,
            vendor: "codex",
            lastEventAt: 200,
            rateLimit: { status: "allowed", resetsAt: null, windows: { thirty_day: { utilization: 0.19, resetsAt: 1_796_193_545, status: "allowed" } } },
          }),
        ],
      }),
    );
    expect(quotaUsage(state, 0)).toEqual([
      { id: "claude", name: "Claude", exhausted: false, windows: [{ key: "five_hour", short: "5h", percent: 6, resetsAt: 1_794_070_800, warning: false }] },
      { id: "codex", name: "Codex", exhausted: false, windows: [{ key: "thirty_day", short: "30d", percent: 19, resetsAt: 1_796_193_545, warning: false }] },
    ]);
  });

  // 真实数据（2026-11-09 16:42）：
  // 1) 旧会话 159（11-07，PR #170 前）把 30 天窗口 resetsAt 1796193546（12/2 14:39，距事件 592 小时）误写进 five_hour（26%）；
  // 2) 旧会话 201（11-08，free 套餐）只有 thirty_day（40%，resetsAt 1796193546）；
  // 3) 新会话 306、309（11-09，切到 plus 套餐）只有 five_hour（resetsAt 1794219196，18:13）和 seven_day（16%，resetsAt 1794805996，11/16 13:13）；
  // 4) 16:37 会话 309（Worker #266，对话 275）因 5 小时额度耗尽 turn_failed（You’ve hit your usage limit ... try again at 6:13 PM.）。
  it("quotaUsage：2026-11-09 真实数据：过滤跨度超出窗口时长的旧脏数据与旧套餐残留的 30 天窗口，并在会话因额度 turn_failed 时反映 100% 耗尽", () => {
    const now = 1_794_213_754_000; // 2026-11-09 16:42:34
    const state = loaded(
      withWorker({
        conversations: [
          makeConvSnapshot(
            [
              makeWorkerLine({
                id: 26171,
                conversationId: 1,
                createdAt: 1_794_213_423_022,
                line: {
                  workerId: 266,
                  workerConversationId: 275,
                  title: "审查 PR #196",
                  event: "turn_failed",
                  status: null,
                  summary:
                    "failed: You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 6:13 PM.",
                },
              }),
            ],
            { conversation: { id: 1, pmId: 1, title: "小林" } },
          ),
          makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 275, pmId: 1, title: "审查 PR #196" }) }),
        ],
        sessions: [
          makeSession({
            sessionId: 159,
            conversationId: 150,
            vendor: "codex",
            lastEventAt: 1_794_059_960_242,
            rateLimit: {
              status: "allowed",
              resetsAt: 1_796_193_546,
              windows: { five_hour: { utilization: 0.26, resetsAt: 1_796_193_546, status: "allowed" } },
            },
          }),
          makeSession({
            sessionId: 201,
            conversationId: 190,
            vendor: "codex",
            lastEventAt: 1_794_118_727_948,
            rateLimit: {
              status: "allowed",
              resetsAt: 1_796_193_546,
              windows: { thirty_day: { utilization: 0.4, resetsAt: 1_796_193_546, status: "allowed" } },
            },
          }),
          makeSession({
            sessionId: 306,
            conversationId: 272,
            vendor: "codex",
            lastEventAt: 1_794_212_831_606,
            rateLimit: {
              status: "allowed",
              resetsAt: 1_794_219_196,
              windows: {
                five_hour: { utilization: 0.88, resetsAt: 1_794_219_196, status: "allowed" },
                seven_day: { utilization: 0.14, resetsAt: 1_794_805_996, status: "allowed" },
              },
            },
          }),
          makeSession({
            sessionId: 309,
            conversationId: 275,
            vendor: "codex",
            lastEventAt: 1_794_213_440_509,
            rateLimit: {
              status: "allowed",
              resetsAt: 1_794_219_196,
              windows: {
                five_hour: { utilization: 0.99, resetsAt: 1_794_219_196, status: "allowed" },
                seven_day: { utilization: 0.16, resetsAt: 1_794_805_996, status: "allowed" },
              },
            },
          }),
        ],
      }),
    );
    expect(quotaUsage(state, now)).toEqual([
      {
        id: "codex",
        name: "Codex",
        exhausted: true,
        windows: [
          { key: "five_hour", short: "5h", percent: 100, resetsAt: 1_794_219_196, warning: true },
          { key: "seven_day", short: "7d", percent: 16, resetsAt: 1_794_805_996, warning: false },
        ],
      },
    ]);
  });

  // 2026-11-18 对话 #205：会话 #867 12:25 因额度失败，12:26 切到另一个模型后发“继续”，新一轮正常在跑
  describe("quotaUsage：会话因额度失败后又开始了新一轮", () => {
    const RESET = 1_794_990_000;
    const now = (RESET - 3600) * 1000;
    const quotaFailed = (id: number) =>
      makeUserMessage({ id, conversationId: 205, sessionId: 867, status: "failed", failureReason: "failed: You’ve hit your usage limit. Try again at 3:48 PM.", updatedAt: now - 120_000 });
    const stateOf = (messages: Message[]) =>
      loaded(
        withWorker({
          conversations: [makeConvSnapshot(messages, { conversation: { id: 205, pmId: 1, title: "PM" } })],
          sessions: [
            makeSession({
              sessionId: 867,
              conversationId: 205,
              vendor: "codex",
              lastEventAt: now - 60_000,
              rateLimit: { status: "allowed", resetsAt: null, windows: { five_hour: { utilization: 1, resetsAt: RESET, status: "allowed" } } },
            }),
          ],
        }),
      );

    it("最近一轮就是这次额度失败：标用完", () => {
      expect(quotaUsage(stateOf([quotaFailed(1)]), now)[0]!.exhausted).toBe(true);
    });

    it("失败之后又有一条开始处理了：旧的失败不再把它标回用完", () => {
      const state = stateOf([quotaFailed(1), makeMessage({ id: 2, conversationId: 205, sessionId: 867 }), makeUserMessage({ id: 3, conversationId: 205, sessionId: 867, status: "processing", text: "继续" })]);
      expect(quotaUsage(state, now)[0]!.exhausted).toBe(false);
    });

    it("失败之后只是又排了一条（还没开始）：仍是用完", () => {
      const state = stateOf([quotaFailed(1), makeUserMessage({ id: 3, conversationId: 205, sessionId: 867, status: "queued", text: "继续" })]);
      expect(quotaUsage(state, now)[0]!.exhausted).toBe(true);
    });
  });

  // 真实日志（2026-11-04）：5 小时窗口 14:30 重置（resetsAt 1793773800），重置前 0.96~0.99；重置后第一条事件 14:3x 才带来新窗口 resetsAt 1793791800
  describe("quotaUsage：重置前后的真实序列", () => {
    const RESET = 1_793_773_800;
    const NEXT_RESET = 1_793_791_800;
    const SEVEN_DAY_RESET = 1_794_250_800;
    const rl = (five: number, fiveReset: number, seven: number, status = "allowed") => ({
      status,
      resetsAt: fiveReset,
      windows: {
        five_hour: { utilization: five, resetsAt: fiveReset, status },
        seven_day: { utilization: seven, resetsAt: SEVEN_DAY_RESET, status: "allowed" },
      },
    });
    const stateOf = (sessions: ReturnType<typeof makeSession>[]) => loaded(withWorker({ sessions }));
    const five = (state: ReturnType<typeof stateOf>, now: number) => quotaUsage(state, now)[0]?.windows.find((w) => w.key === "five_hour");
    const before = (RESET - 600) * 1000;
    const after = (RESET + 600) * 1000;

    it("重置前：照常显示 99%、带重置时间、快用完", () => {
      const state = stateOf([makeSession({ sessionId: 18, conversationId: 30, lastEventAt: 100, rateLimit: rl(0.99, RESET, 0.31, "allowed_warning") })]);
      expect(five(state, before)).toEqual({ key: "five_hour", short: "5h", percent: 99, resetsAt: RESET, warning: true });
    });

    it("过了 resetsAt 还没有新事件：5 小时窗口算已重置，显示 0%、没有重置时间、不标快用完；7 天窗口不受影响", () => {
      const state = stateOf([makeSession({ sessionId: 18, conversationId: 30, lastEventAt: 100, rateLimit: rl(0.99, RESET, 0.31, "allowed_warning") })]);
      expect(five(state, after)).toEqual({ key: "five_hour", short: "5h", percent: 0, resetsAt: null, warning: false });
      expect(quotaUsage(state, after)[0]!.windows.find((w) => w.key === "seven_day")).toMatchObject({ percent: 31, resetsAt: SEVEN_DAY_RESET });
    });

    it("重置后第一条新事件到了（新 resetsAt、utilization 0）：显示新窗口的值和新的重置时间", () => {
      const state = stateOf([makeSession({ sessionId: 1, conversationId: 1, lastEventAt: 200, rateLimit: rl(0, NEXT_RESET, 0.31) })]);
      expect(five(state, after)).toEqual({ key: "five_hour", short: "5h", percent: 0, resetsAt: NEXT_RESET, warning: false });
    });

    it("旧会话（重置前的 99%，lastEventAt 更新）和新会话（重置后的 3%）并存：取新窗口的，不按 lastEventAt 选", () => {
      const state = stateOf([
        makeSession({ sessionId: 3, conversationId: 30, lastEventAt: 900, rateLimit: rl(0.98, RESET, 0.31, "allowed_warning") }),
        makeSession({ sessionId: 21, conversationId: 31, lastEventAt: 300, rateLimit: rl(0.03, NEXT_RESET, 0.31) }),
      ]);
      expect(five(state, after)).toMatchObject({ percent: 3, resetsAt: NEXT_RESET, warning: false });
    });

    it("同一个窗口里几个会话的值不一样：取最高的（窗口里只增不减，高的是最新的），不管 lastEventAt", () => {
      const state = stateOf([
        makeSession({ sessionId: 17, conversationId: 30, lastEventAt: 900, rateLimit: rl(0.96, RESET, 0.31) }),
        makeSession({ sessionId: 18, conversationId: 31, lastEventAt: 100, rateLimit: rl(0.99, RESET, 0.31) }),
      ]);
      expect(five(state, before)).toMatchObject({ percent: 99 });
    });

    it("用完（rejected）：重置前是已用完；过了 resetsAt 不再是已用完", () => {
      const state = stateOf([makeSession({ sessionId: 3, conversationId: 30, lastEventAt: 100, rateLimit: rl(1, RESET, 0.31, "rejected") })]);
      expect(quotaUsage(state, before)[0]!.exhausted).toBe(true);
      expect(quotaUsage(state, after)[0]!.exhausted).toBe(false);
    });

    it("isWaitingForQuota：rejected 且 resetsAt 已过，不再算等额度", () => {
      const session = makeSession({ rateLimit: rl(1, RESET, 0.31, "rejected") });
      expect(isWaitingForQuota(session, before)).toBe(true);
      expect(isWaitingForQuota(session, after)).toBe(false);
    });
  });

  it("runningWorkerCount：只数这个项目经理派的 Worker 对话里最新一代会话不是 idle 的", () => {
    const state = loaded(
      withWorker({
        conversations: [
          makeConvSnapshot([], { conversation: { id: 1, pmId: 1, title: "小林" } }),
          makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 30, pmId: 1 }) }),
          makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 31, pmId: 1 }) }),
          makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 40, pmId: 2 }) }),
        ],
        sessions: [
          makeSession({ sessionId: 2, conversationId: 30, generation: 1, activity: "working" }),
          // 31：旧一代在跑，最新一代空闲 → 不算
          makeSession({ sessionId: 3, conversationId: 31, generation: 1, activity: "working" }),
          makeSession({ sessionId: 4, conversationId: 31, generation: 2, activity: "idle" }),
          makeSession({ sessionId: 5, conversationId: 40, activity: "working" }),
        ],
      }),
    );
    expect(runningWorkerCount(state, 1)).toBe(1);
    expect(runningWorkerCount(state, 2)).toBe(1);
    expect(runningWorkerCount(state, 3)).toBe(0);
  });

  it("31b runningWorkerCount：准备中的 Worker 也算在跑", () => {
    const state = loaded(
      withWorker({
        conversations: [
          makeConvSnapshot([], { conversation: { id: 1, pmId: 1, title: "小林" } }),
          makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 30, pmId: 1 }) }),
        ],
        sessions: [makeSession({ sessionId: 2, conversationId: 30, activity: "preparing" })],
      }),
    );
    expect(runningWorkerCount(state, 1)).toBe(1);
  });
});

describe("在 Worker 页面直接对它说话", () => {
  async function openWorker(snapshot?: StateSnapshot) {
    const user = userEvent.setup();
    const ws = await boot(snapshot);
    await showWorker();
    const section = screen.getByRole("region", { name: "Worker 修 X" });
    return { user, ws, section, box: () => within(section).getByRole("textbox", { name: "Message" }) };
  }

  it("有和项目经理页面一样的输入框；回车发到 Worker 的对话，先乐观显示成我的气泡，真消息到了不重复", async () => {
    const { user, ws, section, box } = await openWorker();
    expect(box()).toHaveAttribute("placeholder", "Message 修 X…");
    const gate = deferred<{ status: number; body: unknown }>();
    api.postMessage = () => gate.promise;
    await user.type(box(), "顺便改 README{Enter}");
    await waitFor(() => expect(api.callsTo("POST", /messages$/)).toHaveLength(1));
    const call = api.callsTo("POST", /messages$/)[0]!;
    expect(call.path).toBe("/api/conversations/30/messages");
    expect(call.body).toMatchObject({ text: "顺便改 README" });
    expect(box()).toHaveValue("");
    const mine = within(section).getByText("顺便改 README").closest("article")!;
    expect(mine).toHaveAttribute("data-side", "right");
    expect(within(mine).queryByText("Queued")).toBeNull();
    const clientId = (call.body as { clientId: string }).clientId;
    push(
      ws,
      messageChange(11, "message.created", makeUserMessage({ id: 40, conversationId: 30, workerId: 3, text: "顺便改 README", status: "queued", dedupeKey: `client:30:${clientId}` })),
    );
    gate.resolve({ status: 200, body: { messageId: 40 } });
    await act(async () => {});
    expect(within(section).getAllByText("顺便改 README")).toHaveLength(1);
    expect(within(within(section).getByText("顺便改 README").closest("article")!).queryByText("Queued")).toBeNull();
  });

  it("我说的靠右、项目经理说的靠左带它的名字，两种署名分得清", async () => {
    const { section } = await openWorker(
      withWorker({
        conversations: [
          makeConvSnapshot([makeWorkerLine({ id: 2, conversationId: 1 })], { conversation: { id: 1, pmId: 1, title: "小林" } }),
          makeConvSnapshot(
            [
              makeMessage({ id: 10, conversationId: 30, sender: "pm", sessionId: null, status: "replied", text: "任务：修 X" }),
              makeUserMessage({ id: 11, conversationId: 30, workerId: 3, text: "我插一句" }),
            ],
            { conversation: makeWorkerConversation() },
          ),
        ],
      }),
    );
    expect(within(section).getByText("任务：修 X").closest("article")).toHaveAttribute("data-side", "left");
    const mine = within(section).getByText("我插一句").closest("article")!;
    expect(mine).toHaveAttribute("data-side", "right");
    expect(within(mine).queryByText("小林")).not.toBeInTheDocument();
  });

  it("草稿按对话分开：Worker 页面打了一半回到项目经理，项目经理的输入框是空的；再回来草稿还在", async () => {
    const { user, box } = await openWorker();
    await user.type(box(), "写了一半");
    await user.click(screen.getByRole("button", { name: "Close work panel" }));
    expect(within(screen.getByRole("region", { name: "小林" })).getByRole("textbox")).toHaveValue("");
    await showWorker();
    expect(box()).toHaveValue("写了一半");
  });

  it("Worker 正忙：输入框照样能发，和项目经理页面一样", async () => {
    const { user, ws, box } = await openWorker();
    push(ws, sessionChange(11, makeSession({ sessionId: 2, conversationId: 30, status: "running", activity: "working", currentTool: "Bash" })));
    expect(box()).toBeEnabled();
    await user.type(box(), "忙完看一下这个{Enter}");
    await waitFor(() => expect(api.callsTo("POST", /messages$/)).toHaveLength(1));
  });

  it("Worker 已收工（会话 ended）：不显示输入框", async () => {
    const { ws, section } = await openWorker();
    expect(within(section).getByRole("textbox")).toBeInTheDocument();
    push(ws, sessionChange(11, makeSession({ sessionId: 2, conversationId: 30, status: "ended" })));
    expect(within(section).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(section).getByText("已经修好了")).toBeInTheDocument();
  });

  it("项目经理已经让它收工（有“已收工”那一行），会话还在跑完这一轮：Worker 页面不显示输入框，工作面板也算收工", async () => {
    const user = userEvent.setup();
    const { ws, section } = await openWorker();
    push(ws, sessionChange(11, makeSession({ sessionId: 2, conversationId: 30, status: "running", activity: "working" })));
    push(ws, messageChange(12, "message.created", makeWorkerLine({ id: 20, conversationId: 1, line: { event: "ended" } })));
    expect(within(section).queryByRole("textbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to 小林" }));
    const aside = screen.getByRole("complementary", { name: "Work panel" });
    expect(within(aside).getByText("Nothing running")).toBeInTheDocument();
    expect(within(aside).getByRole("tab", { name: /Completed/ })).toBeInTheDocument();
  });

  it("建 worktree 失败（worktree_failed 那一行）：不显示输入框，显示失败原因而非 Completed", async () => {
    const { ws, section } = await openWorker();
    push(ws, messageChange(12, "message.created", makeWorkerLine({ id: 20, conversationId: 1, line: { event: "worktree_failed", summary: "目录被占用" } })));
    expect(within(section).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(section).getByRole("alert")).toHaveTextContent("Couldn't create worktree");
    expect(within(section).getByRole("alert")).toHaveTextContent("目录被占用");
    expect(within(section).queryByText("Completed")).not.toBeInTheDocument();
  });

  it("还在准备（任务说明还在排队，worktree 没建好）：输入框不可用；任务说明送达后能用", async () => {
    const { ws, box, section } = await openWorker(
      withWorker({
        conversations: [
          makeConvSnapshot([makeWorkerLine({ id: 2, conversationId: 1 })], { conversation: { id: 1, pmId: 1, title: "小林" } }),
          makeConvSnapshot([makeMessage({ id: 10, conversationId: 30, sender: "pm", status: "queued", text: "任务：修 X" })], {
            conversation: makeWorkerConversation(),
          }),
        ],
      }),
    );
    expect(box()).toBeDisabled();
    expect(box()).toHaveAttribute("placeholder", "修 X is setting up…");
    expect(within(section).getByRole("button", { name: "Send" })).toBeDisabled();
    push(ws, messageChange(11, "message.updated", makeMessage({ id: 10, conversationId: 30, sender: "pm", status: "delivered", text: "任务：修 X" })));
    expect(box()).toBeEnabled();
    expect(box()).toHaveAttribute("placeholder", "Message 修 X…");
  });

  it("和项目经理页面一样能带文件：回形针选文件，先上传、再发到 Worker 的对话；草稿和待发文件按对话分开", async () => {
    const { user, section, box } = await openWorker();
    await user.type(box(), "看这个");
    await user.upload(within(section).getByLabelText("Choose files") as HTMLInputElement, [new File(["内容"], "日志.txt", { type: "text/plain" })]);
    expect(within(within(section).getByRole("list", { name: "Files to send" })).getByText("日志.txt")).toBeInTheDocument();
    // 回到项目经理：它的输入框上没有这份待发文件
    await user.click(screen.getByRole("button", { name: "Close work panel" }));
    expect(within(screen.getByRole("region", { name: "小林" })).queryByRole("list", { name: "Files to send" })).not.toBeInTheDocument();
    await showWorker();
    const again = screen.getByRole("region", { name: "Worker 修 X" });
    await user.click(within(again).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(api.callsTo("POST", /messages$/)).toHaveLength(1));
    const call = api.callsTo("POST", /messages$/)[0]!;
    expect(call.path).toBe("/api/conversations/30/messages");
    expect(call.body).toMatchObject({ text: "看这个", attachmentIds: [expect.any(String)] });
    expect(api.uploads.map((u) => u.name)).toEqual(["日志.txt"]);
  });

  it("切对话不重复发：Worker 页面带文件发出去以后回到项目经理再发，只多一条发给项目经理的、不带那份文件，也不再上传", async () => {
    const { user, section, box } = await openWorker();
    await user.upload(within(section).getByLabelText("Choose files") as HTMLInputElement, [new File(["内容"], "日志.txt", { type: "text/plain" })]);
    await user.type(box(), "看这个{Enter}");
    await waitFor(() => expect(api.callsTo("POST", /messages$/)).toHaveLength(1));
    await waitFor(() => expect(within(section).queryByRole("list", { name: "Files to send" })).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Close work panel" }));
    const pm = screen.getByRole("region", { name: "小林" });
    expect(within(pm).queryByRole("list", { name: "Files to send" })).not.toBeInTheDocument();
    await user.type(within(pm).getByRole("textbox", { name: "Message" }), "收到了吗{Enter}");
    await waitFor(() => expect(api.callsTo("POST", /messages$/)).toHaveLength(2));
    const [toWorker, toPm] = api.callsTo("POST", /messages$/);
    expect(toWorker!.path).toBe("/api/conversations/30/messages");
    expect(toPm!.path).toBe("/api/conversations/1/messages");
    expect(toPm!.body).not.toHaveProperty("attachmentIds");
    expect(api.uploads).toHaveLength(1);
    // 再回 Worker：输入框和待发列表是空的
    await showWorker();
    const again = screen.getByRole("region", { name: "Worker 修 X" });
    expect(within(again).getByRole("textbox", { name: "Message" })).toHaveValue("");
    expect(within(again).queryByRole("list", { name: "Files to send" })).not.toBeInTheDocument();
  });

  it("还在准备时加文件按钮也不可用", async () => {
    const { section } = await openWorker(
      withWorker({
        conversations: [
          makeConvSnapshot([makeWorkerLine({ id: 2, conversationId: 1 })], { conversation: { id: 1, pmId: 1, title: "小林" } }),
          makeConvSnapshot([makeMessage({ id: 10, conversationId: 30, sender: "pm", status: "queued", text: "任务：修 X" })], {
            conversation: makeWorkerConversation(),
          }),
        ],
      }),
    );
    expect(within(section).getByRole("button", { name: "Add files" })).toBeDisabled();
  });

  it("服务端拒收（409，收工那一刻正好发出去）或断网：左边红色感叹号，点了重发", async () => {
    const { user, section, box } = await openWorker();
    api.postMessage = () => ({ status: 409, body: { error: "Worker #3 已经收工了，不能再给它发消息", code: "conflict" } });
    await user.type(box(), "还在吗{Enter}");
    expect(await within(section).findByRole("button", { name: "Not sent. Click to resend" })).toBeInTheDocument();
    api.postMessage = () => {
      throw new TypeError("Failed to fetch");
    };
    await user.click(within(section).getByRole("button", { name: "Not sent. Click to resend" }));
    await waitFor(() => expect(api.callsTo("POST", /messages$/)).toHaveLength(2));
    expect(await within(section).findByRole("button", { name: "Not sent. Click to resend" })).toBeInTheDocument();
  });

  it("已收工的历史 Worker 对话（初始快照 messages 为空、hasMore 为 true）：点开详情时自动按需拉取历史消息并展示", async () => {
    await boot(
      withWorker({
        sessions: [
          makeSession({ sessionId: 1, conversationId: 1, pmId: 1 }),
          makeSession({ sessionId: 2, conversationId: 30, status: "ended", activity: "idle" }),
        ],
        conversations: [
          makeConvSnapshot(
            [
              makeWorkerLine({ id: 2, conversationId: 1 }),
              makeWorkerLine({ id: 3, conversationId: 1, line: { event: "ended", summary: "搞定" } }),
            ],
            {
              conversation: { id: 1, pmId: 1, title: "小林" },
            },
          ),
          makeConvSnapshot([], { conversation: makeWorkerConversation(), hasMore: true }),
        ],
      }),
    );
    api.older = (conversationId, before) => {
      expect(conversationId).toBe(30);
      expect(before).toBe(Number.MAX_SAFE_INTEGER);
      return {
        status: 200,
        body: {
          messages: [
            makeMessage({ id: 10, conversationId: 30, sender: "pm", text: "任务：压缩状态快照" }),
            makeMessage({ id: 11, conversationId: 30, sender: "agent", text: "已完成快照瘦身与 gzip 压缩" }),
          ],
          hasMore: false,
        },
      };
    };
    await showWorker();
    const section = screen.getByRole("region", { name: "Worker 修 X" });
    expect(await within(section).findByText("任务：压缩状态快照")).toBeInTheDocument();
    expect(within(section).getByText("已完成快照瘦身与 gzip 压缩")).toBeInTheDocument();
    expect(within(section).queryByRole("textbox")).not.toBeInTheDocument();
  });
});
