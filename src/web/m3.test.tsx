// M3 网页（W4）：项目经理会话里的 Worker 汇报那一行、点开看 Worker 的过程、顶栏的额度和在跑的 Worker 数。接口和 WebSocket 都是假的。
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateSnapshot, WsServerMessage } from "../shared/index.ts";
import { App } from "./App.tsx";
import { listConversations, quotaUsage, runningWorkerCount } from "./selectors.ts";
import { initialState, reducer } from "./state.ts";
import {
  FakeApi,
  FakeWebSocket,
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
  sessionChange,
} from "./test-utils.ts";

let api: FakeApi;

async function boot(snapshot: StateSnapshot = withWorker()) {
  api = new FakeApi(snapshot);
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

function nav() {
  return screen.getByRole("navigation", { name: "对话列表" });
}
function log() {
  return screen.getByRole("log", { name: "消息" });
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("那一行", () => {
  it("kind worker 的消息显示成“Worker · 标题 · 状态：摘要”，是一个按钮，不是普通的气泡", async () => {
    await boot();
    expect(within(log()).getByRole("button", { name: "Worker · 修 X · 已派出" })).toBeInTheDocument();
    const done = within(log()).getByRole("button", { name: "Worker · 修 X · 做完了：改好了，测试通过" });
    expect(done.closest("article")).toBeNull();
    // 汇报原文（给项目经理的那段）不显示给人看
    expect(within(log()).queryByText(/的汇报】/)).not.toBeInTheDocument();
  });

  it("只读的“已派出”能看出来", async () => {
    await boot(
      withWorker({
        conversations: [
          makeConvSnapshot([makeWorkerLine({ id: 2, conversationId: 1, line: { event: "started", readonly: true, title: "调查 Y" } })], {
            conversation: { id: 1, pmId: 1, title: "小林" },
          }),
        ],
      }),
    );
    expect(within(log()).getByRole("button", { name: "Worker · 调查 Y · 已派出（只读）" })).toBeInTheDocument();
  });

  it("各种事件：有问题、放弃了、没按格式、这一轮没做完、建 worktree 失败、已收工", async () => {
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
    const texts = within(log())
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(texts).toEqual([
      "Worker · 修 X · 有问题：缺一个 key",
      "Worker · 修 X · 放弃了：做不了",
      "Worker · 修 X · 没按格式：我改完了",
      "Worker · 修 X · 这一轮没做完：被停止了",
      "Worker · 修 X · 建 worktree 失败：目录被占用",
      "Worker · 修 X · 已收工",
    ]);
  });

  it("推一条新的 worker 消息，会话里多一行；左栏的预览还是最后一条文字", async () => {
    const ws = await boot();
    push(ws, messageChange(11, "message.created", makeWorkerLine({ id: 4, conversationId: 1, line: { event: "ended" } })));
    expect(within(log()).getByRole("button", { name: "Worker · 修 X · 已收工" })).toBeInTheDocument();
    expect(within(nav()).getByRole("button", { name: /派个 Worker 修 X/ })).toBeInTheDocument();
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

describe("左栏", () => {
  it("不显示 Worker 的对话", async () => {
    await boot();
    expect(within(nav()).getAllByRole("button")).toHaveLength(1);
    expect(within(nav()).queryByText("修 X")).not.toBeInTheDocument();
  });
});

describe("点开 Worker", () => {
  it("点那一行：右边是 Worker 的对话，有任务、回复和折叠的操作；只看不发，没有输入框", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(within(log()).getByRole("button", { name: /做完了/ }));
    const section = screen.getByRole("region", { name: "Worker · 修 X" });
    expect(within(section).getByRole("heading", { name: "修 X" })).toBeInTheDocument();
    expect(within(section).getByText("任务：修 X")).toBeInTheDocument();
    expect(within(section).getByText("已经修好了")).toBeInTheDocument();
    await user.click(within(section).getByRole("button", { name: /执行了 2 个操作/ }));
    expect(within(section).getByText("Bash: git status")).toBeInTheDocument();
    expect(within(section).getByText("Edit: src/x.ts")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    // 项目经理的会话不见了，左栏还停在项目经理上
    expect(screen.queryByRole("region", { name: "小林" })).not.toBeInTheDocument();
    expect(within(nav()).getByRole("button", { name: /小林/ })).toHaveAttribute("aria-current", "true");
  });

  it("项目经理在 Worker 对话里说的话：靠左，带项目经理的头像和名字，不带只有用户消息才有的投递状态，也没有重试", async () => {
    const user = userEvent.setup();
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
    await user.click(within(log()).getByRole("button", { name: /已派出/ }));
    const section = screen.getByRole("region", { name: "Worker · 修 X" });
    const task = within(section).getByText("任务：修 X").closest("article")!;
    expect(task).toHaveAttribute("data-side", "left");
    expect(task).toHaveAttribute("data-head", "true");
    expect(within(task).getByText("小林")).toBeInTheDocument();
    // Worker 自己的话署 Worker 的标题，两边不会混
    const reply = within(section).getByText("收到").closest("article")!;
    expect(within(reply).getByText("修 X")).toBeInTheDocument();
    expect(within(section).getByText("再改一下").closest("article")).toHaveAttribute("data-head", "true");
    expect(within(section).queryByText("已回复")).not.toBeInTheDocument();
    expect(within(section).queryByText("发送失败")).not.toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
    expect(within(section).queryByText(/^(已送达|处理中|排队中|失败)/)).not.toBeInTheDocument();
  });

  it("项目经理连着说两句：第二句不重复头像和名字", async () => {
    const user = userEvent.setup();
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
    await user.click(within(log()).getByRole("button", { name: /已派出/ }));
    expect(screen.getByText("第二句").closest("article")).toHaveAttribute("data-head", "false");
  });

  it("Worker 在干活：状态行显示它在做什么，“停止”停的是 Worker 的对话", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    await user.click(within(log()).getByRole("button", { name: /已派出/ }));
    push(ws, sessionChange(11, makeSession({ sessionId: 2, conversationId: 30, status: "running", activity: "working", currentTool: "Bash" })));
    const status = screen.getByRole("status", { name: "状态" });
    expect(status).toHaveTextContent("Bash");
    await user.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(api.callsTo("POST", /stop$/)).toHaveLength(1));
    expect(api.callsTo("POST", /stop$/)[0]?.path).toBe("/api/conversations/30/stop");
  });

  it("新消息推来就接在后面", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    await user.click(within(log()).getByRole("button", { name: /已派出/ }));
    push(ws, messageChange(11, "message.created", makeMessage({ id: 14, conversationId: 30, workerId: 3, text: "再补一句" })));
    expect(within(screen.getByRole("region", { name: "Worker · 修 X" })).getByText("再补一句")).toBeInTheDocument();
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
    await user.click(within(log()).getByRole("button", { name: /已派出/ }));
    await user.click(screen.getByRole("button", { name: "加载更早的消息" }));
    await waitFor(() => expect(screen.getByText("早先的话")).toBeInTheDocument());
    const call = api.callsTo("GET", /\/messages$/)[0];
    expect(call?.path).toBe("/api/conversations/30/messages");
    expect(call?.query.get("before")).toBe("10");
  });

  it("没有消息：写“还没有消息”", async () => {
    const user = userEvent.setup();
    await boot(
      withWorker({
        conversations: [
          makeConvSnapshot([makeWorkerLine({ id: 2, conversationId: 1 })], { conversation: { id: 1, pmId: 1, title: "小林" } }),
          makeConvSnapshot([], { conversation: makeWorkerConversation() }),
        ],
      }),
    );
    await user.click(within(log()).getByRole("button", { name: /已派出/ }));
    expect(screen.getByText("还没有消息")).toBeInTheDocument();
  });

  it("找不到这个 Worker 的对话：写出来，能回去", async () => {
    const user = userEvent.setup();
    await boot(
      withWorker({
        conversations: [makeConvSnapshot([makeWorkerLine({ id: 2, conversationId: 1 })], { conversation: { id: 1, pmId: 1, title: "小林" } })],
      }),
    );
    await user.click(within(log()).getByRole("button", { name: /已派出/ }));
    expect(screen.getByText("找不到这个 Worker 的对话")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "返回 小林" }));
    expect(screen.getByRole("region", { name: "小林" })).toBeInTheDocument();
  });

  it("“返回”回到项目经理的会话；点左栏也回去", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(within(log()).getByRole("button", { name: /已派出/ }));
    await user.click(screen.getByRole("button", { name: "返回 小林" }));
    expect(screen.getByRole("region", { name: "小林" })).toBeInTheDocument();
    await user.click(within(log()).getByRole("button", { name: /已派出/ }));
    await user.click(within(nav()).getByRole("button", { name: /小林/ }));
    expect(screen.getByRole("region", { name: "小林" })).toBeInTheDocument();
  });

  it("Worker 的标题栏显示只读（取自项目经理会话里的“已派出”那一行）", async () => {
    const user = userEvent.setup();
    await boot(
      withWorker({
        conversations: [
          makeConvSnapshot([makeWorkerLine({ id: 2, conversationId: 1, line: { readonly: true } })], { conversation: { id: 1, pmId: 1, title: "小林" } }),
          makeConvSnapshot([makeMessage({ id: 10, conversationId: 30, text: "x" })], { conversation: makeWorkerConversation() }),
        ],
      }),
    );
    await user.click(within(log()).getByRole("button", { name: /已派出/ }));
    expect(within(screen.getByRole("region", { name: "Worker · 修 X" })).getByText("只读")).toBeInTheDocument();
  });
});

describe("顶栏", () => {
  const quota = (five: number, seven: number) => ({
    status: "allowed",
    resetsAt: null,
    windows: {
      five_hour: { utilization: five, resetsAt: 1_793_619_600, status: "allowed" },
      seven_day: { utilization: seven, resetsAt: 1_793_646_000, status: "allowed" },
    },
  });

  it("额度：5 小时和 7 天的已用百分比", async () => {
    await boot(withWorker({ sessions: [makeSession({ conversationId: 1, pmId: 1, rateLimit: quota(0.37, 0.59), lastEventAt: 5 })] }));
    expect(screen.getByText("5 小时额度已用 37% · 7 天 59%")).toBeInTheDocument();
  });

  it("推 session.status 带来新的额度：跟着变", async () => {
    const ws = await boot(withWorker({ sessions: [makeSession({ conversationId: 1, pmId: 1, rateLimit: quota(0.37, 0.59), lastEventAt: 5 })] }));
    push(ws, sessionChange(11, makeSession({ conversationId: 1, pmId: 1, rateLimit: quota(0.4, 0.6), lastEventAt: 9 })));
    expect(screen.getByText("5 小时额度已用 40% · 7 天 60%")).toBeInTheDocument();
  });

  it("还没有额度数据：不显示", async () => {
    await boot();
    expect(screen.queryByText(/额度已用/)).not.toBeInTheDocument();
  });

  it("N 个 Worker 在跑：只数这个项目经理的、会话不是空闲的；一个都没在跑就不显示", async () => {
    const ws = await boot();
    expect(screen.queryByText(/个 Worker 在跑/)).not.toBeInTheDocument();
    push(ws, sessionChange(11, makeSession({ sessionId: 2, conversationId: 30, status: "running", activity: "working" })));
    expect(screen.getByText("1 个 Worker 在跑")).toBeInTheDocument();
    push(ws, sessionChange(12, makeSession({ sessionId: 2, conversationId: 30, status: "idle", activity: "idle" })));
    expect(screen.queryByText(/个 Worker 在跑/)).not.toBeInTheDocument();
  });

  it("点开 Worker 后顶栏还在", async () => {
    const user = userEvent.setup();
    await boot(withWorker({ sessions: [makeSession({ sessionId: 2, conversationId: 30, activity: "working", status: "running", rateLimit: quota(0.1, 0.2), lastEventAt: 1 })] }));
    await user.click(within(log()).getByRole("button", { name: /已派出/ }));
    expect(screen.getByText("1 个 Worker 在跑")).toBeInTheDocument();
    expect(screen.getByText("5 小时额度已用 10% · 7 天 20%")).toBeInTheDocument();
  });
});

describe("selectors", () => {
  const loaded = (snapshot: StateSnapshot) => reducer(initialState, { type: "loaded", snapshot });

  it("listConversations 不含 kind worker 的对话", () => {
    expect(listConversations(loaded(withWorker())).map((e) => e.id)).toEqual([1]);
  });

  it("quotaUsage：每个窗口各取最近一次事件（lastEventAt 最大）的那个会话；没有的窗口是 null", () => {
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
            rateLimit: { status: "allowed", resetsAt: null, windows: { five_hour: { utilization: 0.3, resetsAt: 1, status: "allowed" } } },
          }),
          makeSession({ sessionId: 3, conversationId: 31, lastEventAt: 300, rateLimit: null }),
        ],
      }),
    );
    expect(quotaUsage(state)).toEqual({ fiveHour: 30, sevenDay: null });
    expect(quotaUsage(loaded(withWorker()))).toEqual({ fiveHour: null, sevenDay: null });
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
});
