// M3 网页（W4）：项目经理会话里的 Worker 汇报那一行、点开看 Worker 的过程、左下角的额度、右边栏的 Worker 列表。接口和 WebSocket 都是假的。
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RateLimitWindow, SessionState, StateSnapshot, WsServerMessage } from "../shared/index.ts";
import { formatQuotaReset } from "./format.ts";
import { App } from "./App.tsx";
import { listConversations, quotaUsage, runningWorkerCount } from "./selectors.ts";
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

  it("Worker 网络出错在重试：状态行写“网络出错，正在重试”，“停止”照常停 Worker 的对话", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    await user.click(within(log()).getByRole("button", { name: /已派出/ }));
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
    expect(screen.getByRole("status", { name: "状态" })).toHaveTextContent("网络出错，正在重试（第 5/10 次）");
    await user.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(api.callsTo("POST", /stop$/)).toHaveLength(1));
    expect(api.callsTo("POST", /stop$/)[0]?.path).toBe("/api/conversations/30/stop");
  });

  it("31 Worker 准备中：状态行写“准备中”、有停止按钮，停的是 Worker 的对话", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    await user.click(within(log()).getByRole("button", { name: /已派出/ }));
    push(ws, sessionChange(11, makeSession({ sessionId: 2, conversationId: 30, status: "idle", activity: "preparing" })));
    const status = screen.getByRole("status", { name: "状态" });
    expect(status).toHaveTextContent("准备中：在跑项目的准备命令");
    expect(status).toHaveAttribute("data-busy", "true");
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

describe("左下角的额度", () => {
  const win = (utilization: number, over: Partial<RateLimitWindow> = {}): RateLimitWindow => ({ utilization, resetsAt: 1_793_619_600, status: "allowed", ...over });
  const limit = (windows: Record<string, RateLimitWindow>, status = "allowed") => ({ status, resetsAt: null, windows });
  const quota = (five: number, seven: number) => limit({ five_hour: win(five), seven_day: win(seven, { resetsAt: 1_793_646_000 }) });
  const withQuota = (rateLimit: ReturnType<typeof limit>) =>
    withWorker({ sessions: [makeSession({ conversationId: 1, pmId: 1, rateLimit, lastEventAt: 5 })] });
  const badge = () => screen.getByRole("button", { name: /额度/ });

  it("右上角没有额度和“N 个 Worker 在跑”了", async () => {
    await boot(withQuota(quota(0.37, 0.59)));
    expect(screen.queryByText(/额度已用/)).not.toBeInTheDocument();
    expect(screen.queryByText(/个 Worker 在跑/)).not.toBeInTheDocument();
  });

  it("还没有额度数据：不显示", async () => {
    await boot();
    expect(screen.queryByRole("button", { name: /额度/ })).not.toBeInTheDocument();
  });

  it("直接显示 5 小时额度已用的百分比，平时不是醒目色", async () => {
    await boot(withQuota(quota(0.37, 0.59)));
    expect(badge()).toHaveTextContent("37%");
    expect(badge()).toHaveAccessibleName("5 小时额度已用 37%");
    expect(badge()).not.toHaveClass("bg-warn", "bg-danger-soft");
  });

  it("推 session.status 带来新的额度：跟着变", async () => {
    const ws = await boot(withQuota(quota(0.37, 0.59)));
    push(ws, sessionChange(11, makeSession({ conversationId: 1, pmId: 1, rateLimit: quota(0.4, 0.6), lastEventAt: 9 })));
    expect(badge()).toHaveTextContent("40%");
  });

  it.each([
    [0.79, "allowed", false],
    [0.8, "allowed", true],
    [0.5, "allowed_warning", true],
  ])("快用完：已用 %s、status %s → 醒目色 %s", async (used, status, warn) => {
    await boot(withQuota(limit({ five_hour: win(used, { status }) })));
    if (warn) expect(badge()).toHaveClass("bg-warn");
    else expect(badge()).not.toHaveClass("bg-warn");
    expect(badge()).not.toHaveTextContent("已用完");
  });

  it("用完了（rejected）：显示“已用完”，不是百分比", async () => {
    await boot(withQuota(limit({ five_hour: win(1, { status: "rejected" }) }, "rejected")));
    expect(badge()).toHaveTextContent("已用完");
    expect(badge()).not.toHaveTextContent("%");
    expect(badge()).toHaveClass("bg-danger-soft");
  });

  it("点开小窗口：按厂商分组，每个窗口一行：名字、百分比、进度条、重置时间", async () => {
    const user = userEvent.setup();
    await boot(withQuota(quota(0.37, 0.59)));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(badge());
    const group = screen.getByRole("region", { name: "Claude" });
    expect(within(group).getByRole("heading", { name: "Claude" })).toBeInTheDocument();
    const five = within(group).getByRole("progressbar", { name: "5 小时额度" });
    expect(five).toHaveAttribute("aria-valuenow", "37");
    expect(within(group).getByRole("progressbar", { name: "7 天额度" })).toHaveAttribute("aria-valuenow", "59");
    expect(within(group).getByText("37%")).toBeInTheDocument();
    expect(within(group).getByText("59%")).toBeInTheDocument();
    expect(within(group).getByText(`${formatQuotaReset(1_793_619_600)} 重置`)).toBeInTheDocument();
    expect(within(group).getByText(`${formatQuotaReset(1_793_646_000)} 重置`)).toBeInTheDocument();
    expect(within(group).getAllByRole("progressbar")).toHaveLength(2);
  });

  it("只有一个窗口有数据：标识显示它，小窗口里只有一行", async () => {
    const user = userEvent.setup();
    await boot(withQuota(limit({ seven_day: win(0.2) })));
    expect(badge()).toHaveTextContent("20%");
    await user.click(badge());
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    expect(screen.getByRole("progressbar", { name: "7 天额度" })).toBeInTheDocument();
  });

  it("脏数据：超过 1 夹成 100%，负数夹成 0%，没有重置时间的不显示重置", async () => {
    const user = userEvent.setup();
    await boot(withQuota(limit({ five_hour: win(1.7, { resetsAt: 0 }), seven_day: win(-0.3) })));
    expect(badge()).toHaveTextContent("100%");
    expect(badge()).toHaveClass("bg-warn");
    await user.click(badge());
    expect(screen.getByRole("progressbar", { name: "5 小时额度" })).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByRole("progressbar", { name: "7 天额度" })).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getAllByText(/重置/)).toHaveLength(1);
  });
});

describe("右边栏的 Worker 列表", () => {
  const panel = () => screen.queryByRole("complementary", { name: "Worker" });
  const rows = () => within(panel()!).getAllByRole("button").filter((b) => b.getAttribute("aria-label") === null).map((b) => b.textContent);
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

  it("没有 Worker：整个右边栏不显示", async () => {
    await boot(makeSnapshot({ pms: [makePm({ id: 1, name: "小林" })], conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, title: "小林" } })] }));
    expect(panel()).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Worker 列表/ })).not.toBeInTheDocument();
  });

  it("一行一个：标题和状态；进行中的在前、收工的在后且淡一些", async () => {
    await boot(crowd());
    expect(rows()).toEqual(["修 X干活中", "写文档空闲", "查日志已收工"]);
    const ended = within(panel()!).getByRole("button", { name: /查日志/ });
    expect(ended).toHaveClass("opacity-60");
    expect(within(panel()!).getByRole("button", { name: /修 X/ })).not.toHaveClass("opacity-60");
  });

  it("各状态的文字：干活中、停止中、空闲、已收工；不认识的 activity 显示“进行中”", async () => {
    const stopping = makeSession({ sessionId: 3, conversationId: 30, activity: "stopping" });
    const unknown = makeSession({ sessionId: 4, conversationId: 31, activity: "bogus" as SessionState["activity"] });
    await boot(crowd({ sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1 }), stopping, unknown, makeSession({ sessionId: 5, conversationId: 32, status: "ended" })] }));
    expect(rows()).toEqual(["修 X停止中", "写文档进行中", "查日志已收工"]);
  });

  it("准备中（在跑项目的准备命令）：显示“准备中”", async () => {
    const preparing = makeSession({ sessionId: 3, conversationId: 30, activity: "preparing" });
    await boot(crowd({ sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1 }), preparing] }));
    expect(rows()[0]).toBe("修 X准备中");
  });

  it("项目经理的会话里有“收工”那一行也算收工；会话还没有的 Worker 当空闲", async () => {
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
    expect(rows()).toEqual(["修 X空闲", "写文档已收工", "查日志已收工"]);
  });

  it("点一行打开那个 Worker 的对话，当前打开的那行高亮；选左栏回到项目经理时不再高亮", async () => {
    const user = userEvent.setup();
    await boot(crowd());
    const row = (name: RegExp) => within(panel()!).getByRole("button", { name });
    expect(row(/修 X/)).not.toHaveAttribute("aria-current");
    await user.click(row(/修 X/));
    expect(screen.getByRole("region", { name: "Worker · 修 X" })).toBeInTheDocument();
    expect(row(/修 X/)).toHaveAttribute("aria-current", "true");
    expect(row(/写文档/)).not.toHaveAttribute("aria-current");
    await user.click(row(/写文档/));
    expect(screen.getByRole("region", { name: "Worker · 写文档" })).toBeInTheDocument();
    expect(row(/写文档/)).toHaveAttribute("aria-current", "true");
    await user.click(within(nav()).getByRole("button", { name: /小林/ }));
    expect(row(/写文档/)).not.toHaveAttribute("aria-current");
  });

  it("切换项目经理：列表跟着变；对方没有 Worker 就整个不显示", async () => {
    const user = userEvent.setup();
    await boot(crowd());
    await user.click(within(nav()).getByRole("button", { name: /老马/ }));
    expect(rows()).toEqual(["老马的活空闲"]);
    await user.click(within(nav()).getByRole("button", { name: /小林/ }));
    expect(rows()).toEqual(["修 X干活中", "写文档空闲", "查日志已收工"]);
  });

  it("没有 Worker 的项目经理：右边栏不显示", async () => {
    const user = userEvent.setup();
    await boot(crowd({ conversations: crowd().conversations.filter((c) => c.conversation.id !== 40) }));
    await user.click(within(nav()).getByRole("button", { name: /老马/ }));
    expect(panel()).not.toBeInTheDocument();
  });

  it("实时变：会话状态一推就变；收工那一行一来，这个 Worker 排到后面、变淡", async () => {
    const ws = await boot(crowd());
    push(ws, sessionChange(11, makeSession({ sessionId: 4, conversationId: 31, status: "running", activity: "working" })));
    expect(rows()).toEqual(["修 X干活中", "写文档干活中", "查日志已收工"]);
    push(ws, messageChange(12, "message.created", makeWorkerLine({ id: 50, conversationId: 1, line: { workerConversationId: 30, event: "ended" } })));
    expect(rows()).toEqual(["写文档干活中", "修 X已收工", "查日志已收工"]);
    expect(within(panel()!).getByRole("button", { name: /修 X/ })).toHaveClass("opacity-60");
  });

  it("新派的 Worker 一出现就在列表里", async () => {
    const ws = await boot(crowd());
    push(ws, changeOf(11, "conversation.created", { conversation: makeWorkerConversation({ id: 33, title: "新活" }) }));
    expect(rows()).toContain("新活空闲");
  });
});

describe("selectors", () => {
  const loaded = (snapshot: StateSnapshot) => reducer(initialState, { type: "loaded", snapshot });

  it("listConversations 不含 kind worker 的对话", () => {
    expect(listConversations(loaded(withWorker())).map((e) => e.id)).toEqual([1]);
  });

  it("quotaUsage：厂商 → 窗口；每个窗口各取最近一次事件（lastEventAt 最大）的那个会话；没有数据的窗口、厂商不返回", () => {
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
    expect(quotaUsage(state)).toEqual([
      { id: "claude", name: "Claude", exhausted: false, windows: [{ key: "five_hour", label: "5 小时", percent: 30, resetsAt: 7, warning: false }] },
    ]);
    expect(quotaUsage(loaded(withWorker()))).toEqual([]);
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
