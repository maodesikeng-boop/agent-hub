// M3 网页（W4）：项目经理会话里的 Worker 汇报那一行、点开看 Worker 的过程、左下角的额度、右边栏的 Worker 列表。接口和 WebSocket 都是假的。
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, RateLimitInfo, RateLimitWindow, SessionState, StateSnapshot, WsServerMessage } from "../shared/index.ts";
import { formatQuotaReset } from "./format.ts";
import { App } from "./App.tsx";
import { isWaitingForQuota, listConversations, quotaUsage, runningWorkerCount, workerPhaseOf } from "./selectors.ts";
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

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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

  it("用户直接对 Worker 说的话：一行“Worker · 标题 · 你对它说：原文”，点开是 Worker 的对话", async () => {
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
    const line = within(log()).getByRole("button", { name: "Worker · 修 X · 你对它说：顺便改 README" });
    expect(within(log()).queryByText(/Worker 已收到/)).not.toBeInTheDocument();
    await user.click(line);
    expect(screen.getByRole("region", { name: "Worker · 修 X" })).toBeInTheDocument();
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
  it("点那一行：右边是 Worker 的对话，有任务、回复和折叠的操作", async () => {
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
  const limit = (windows: Record<string, RateLimitWindow>, status = "allowed"): RateLimitInfo => ({ status, resetsAt: null, windows });
  const quota = (five: number, seven: number) => limit({ five_hour: win(five), seven_day: win(seven, { resetsAt: 1_793_646_000 }) });
  const withQuota = (rateLimit: RateLimitInfo) =>
    withWorker({ sessions: [makeSession({ conversationId: 1, pmId: 1, rateLimit, lastEventAt: 5 })] });
  const badge = () => screen.getByRole("button", { name: /额度/ });
  // 样例里的重置时间（1_793_619_600、1_793_646_000）要在“现在”之后，不然窗口算已重置
  const T_BEFORE_RESET = (1_793_619_600 - 3600) * 1000;
  beforeEach(() => void vi.useFakeTimers({ toFake: ["Date"], now: T_BEFORE_RESET }));
  afterEach(() => void vi.useRealTimers());

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

  describe("到了重置时间", () => {
    const RESET = 1_793_773_800;
    const NEXT_RESET = 1_793_791_800;
    // 真实事件的顶层 resetsAt 就是触发这条的窗口（5 小时）的
    const rl = (five: number, fiveReset: number, status = "allowed") => ({
      ...limit({ five_hour: win(five, { resetsAt: fiveReset, status }), seven_day: win(0.31, { resetsAt: 1_794_250_800 }) }, status),
      resetsAt: fiveReset,
    });
    // 假时钟只换 Date 和 setTimeout，waitFor 照常轮询
    const clock = (nowSeconds: number) => vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true, now: nowSeconds * 1000 });
    const advance = (seconds: number) => act(() => void vi.advanceTimersByTime(seconds * 1000));

    it("页面开着不动：到了 resetsAt 自己从 99% 变成 0%，重置时间的字也没了；不用刷新", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      clock(RESET - 600);
      await boot(withQuota(rl(0.99, RESET, "allowed_warning")));
      expect(badge()).toHaveTextContent("99%");
      expect(badge()).toHaveClass("bg-warn");
      advance(599);
      expect(badge()).toHaveTextContent("99%");
      advance(2);
      expect(badge()).toHaveTextContent("0%");
      expect(badge()).toHaveAccessibleName("5 小时额度已用 0%");
      expect(badge()).not.toHaveClass("bg-warn");
      await user.click(badge());
      expect(screen.getByRole("progressbar", { name: "5 小时额度" })).toHaveAttribute("aria-valuenow", "0");
      expect(screen.getByRole("progressbar", { name: "7 天额度" })).toHaveAttribute("aria-valuenow", "31");
      expect(screen.getAllByText(/重置/)).toHaveLength(1); // 只剩 7 天窗口的
    });

    it("重置后新的 rate_limit_event 一到（新 resetsAt）：马上显示新窗口的值", async () => {
      clock(RESET - 600);
      const ws = await boot(withQuota(rl(0.99, RESET, "allowed_warning")));
      advance(601);
      expect(badge()).toHaveTextContent("0%");
      push(ws, sessionChange(11, makeSession({ conversationId: 1, pmId: 1, rateLimit: rl(0.03, NEXT_RESET), lastEventAt: 9 })));
      expect(badge()).toHaveTextContent("3%");
    });

    it("用完了（已用完）：到了 resetsAt 自己变回百分比", async () => {
      clock(RESET - 600);
      await boot(withQuota(rl(1, RESET, "rejected")));
      expect(badge()).toHaveTextContent("已用完");
      advance(601);
      expect(badge()).toHaveTextContent("0%");
      expect(badge()).not.toHaveClass("bg-danger-soft");
    });
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
    // 和“干活中”一样用主色
    expect(screen.getByText("准备中")).toHaveClass("text-primary");
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
      { id: "claude", name: "Claude", exhausted: false, windows: [{ key: "five_hour", label: "5 小时", percent: 30, resetsAt: 7, warning: false }] },
    ]);
    expect(quotaUsage(loaded(withWorker()), 0)).toEqual([]);
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
      expect(five(state, before)).toEqual({ key: "five_hour", label: "5 小时", percent: 99, resetsAt: RESET, warning: true });
    });

    it("过了 resetsAt 还没有新事件：5 小时窗口算已重置，显示 0%、没有重置时间、不标快用完；7 天窗口不受影响", () => {
      const state = stateOf([makeSession({ sessionId: 18, conversationId: 30, lastEventAt: 100, rateLimit: rl(0.99, RESET, 0.31, "allowed_warning") })]);
      expect(five(state, after)).toEqual({ key: "five_hour", label: "5 小时", percent: 0, resetsAt: null, warning: false });
      expect(quotaUsage(state, after)[0]!.windows.find((w) => w.key === "seven_day")).toMatchObject({ percent: 31, resetsAt: SEVEN_DAY_RESET });
    });

    it("重置后第一条新事件到了（新 resetsAt、utilization 0）：显示新窗口的值和新的重置时间", () => {
      const state = stateOf([makeSession({ sessionId: 1, conversationId: 1, lastEventAt: 200, rateLimit: rl(0, NEXT_RESET, 0.31) })]);
      expect(five(state, after)).toEqual({ key: "five_hour", label: "5 小时", percent: 0, resetsAt: NEXT_RESET, warning: false });
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
    await user.click(within(log()).getByRole("button", { name: /已派出/ }));
    const section = screen.getByRole("region", { name: "Worker · 修 X" });
    return { user, ws, section, box: () => within(section).getByRole("textbox", { name: "输入消息" }) };
  }

  it("有和项目经理页面一样的输入框；回车发到 Worker 的对话，先乐观显示成我的气泡，真消息到了不重复", async () => {
    const { user, ws, section, box } = await openWorker();
    expect(box()).toHaveAttribute("placeholder", "给 修 X 发消息");
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
    expect(within(mine).getByText("排队中")).toBeInTheDocument();
    const clientId = (call.body as { clientId: string }).clientId;
    push(
      ws,
      messageChange(11, "message.created", makeUserMessage({ id: 40, conversationId: 30, workerId: 3, text: "顺便改 README", status: "queued", dedupeKey: `client:30:${clientId}` })),
    );
    gate.resolve({ status: 200, body: { messageId: 40 } });
    await act(async () => {});
    expect(within(section).getAllByText("顺便改 README")).toHaveLength(1);
    expect(within(within(section).getByText("顺便改 README").closest("article")!).getByText("排队中")).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "返回 小林" }));
    expect(within(screen.getByRole("region", { name: "小林" })).getByRole("textbox")).toHaveValue("");
    await user.click(within(log()).getByRole("button", { name: /已派出/ }));
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

  it("项目经理已经让它收工（有“已收工”那一行），会话还在跑完这一轮：Worker 页面不显示输入框，右边栏也算收工", async () => {
    const { ws, section } = await openWorker();
    push(ws, sessionChange(11, makeSession({ sessionId: 2, conversationId: 30, status: "running", activity: "working" })));
    push(ws, messageChange(12, "message.created", makeWorkerLine({ id: 20, conversationId: 1, line: { event: "ended" } })));
    expect(within(section).queryByRole("textbox")).not.toBeInTheDocument();
    const panel = screen.getByRole("complementary", { name: "Worker" });
    expect(within(panel).getByText("已收工")).toBeInTheDocument();
  });

  it("建 worktree 失败（worktree_failed 那一行）：不显示输入框", async () => {
    const { ws, section } = await openWorker();
    push(ws, messageChange(12, "message.created", makeWorkerLine({ id: 20, conversationId: 1, line: { event: "worktree_failed", summary: "目录被占用" } })));
    expect(within(section).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("还在准备（任务说明还在排队，worktree 没建好）：输入框不可用；任务说明送达后能用", async () => {
    const { ws, box } = await openWorker(
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
    expect(box()).toHaveAttribute("placeholder", "修 X 还在准备");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    push(ws, messageChange(11, "message.updated", makeMessage({ id: 10, conversationId: 30, sender: "pm", status: "delivered", text: "任务：修 X" })));
    expect(box()).toBeEnabled();
    expect(box()).toHaveAttribute("placeholder", "给 修 X 发消息");
  });

  it("和项目经理页面一样能带文件：回形针选文件，先上传、再发到 Worker 的对话；草稿和待发文件按对话分开", async () => {
    const { user, section, box } = await openWorker();
    await user.type(box(), "看这个");
    await user.upload(within(section).getByLabelText("选择文件") as HTMLInputElement, [new File(["内容"], "日志.txt", { type: "text/plain" })]);
    expect(within(within(section).getByRole("list", { name: "待发送的文件" })).getByText("日志.txt")).toBeInTheDocument();
    // 回到项目经理：它的输入框上没有这份待发文件
    await user.click(screen.getByRole("button", { name: "返回 小林" }));
    expect(within(screen.getByRole("region", { name: "小林" })).queryByRole("list", { name: "待发送的文件" })).not.toBeInTheDocument();
    await user.click(within(log()).getByRole("button", { name: /已派出/ }));
    const again = screen.getByRole("region", { name: "Worker · 修 X" });
    await user.click(within(again).getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.callsTo("POST", /messages$/)).toHaveLength(1));
    const call = api.callsTo("POST", /messages$/)[0]!;
    expect(call.path).toBe("/api/conversations/30/messages");
    expect(call.body).toMatchObject({ text: "看这个", attachmentIds: [expect.any(String)] });
    expect(api.uploads.map((u) => u.name)).toEqual(["日志.txt"]);
  });

  it("切对话不重复发：Worker 页面带文件发出去以后回到项目经理再发，只多一条发给项目经理的、不带那份文件，也不再上传", async () => {
    const { user, section, box } = await openWorker();
    await user.upload(within(section).getByLabelText("选择文件") as HTMLInputElement, [new File(["内容"], "日志.txt", { type: "text/plain" })]);
    await user.type(box(), "看这个{Enter}");
    await waitFor(() => expect(api.callsTo("POST", /messages$/)).toHaveLength(1));
    await waitFor(() => expect(within(section).queryByRole("list", { name: "待发送的文件" })).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "返回 小林" }));
    const pm = screen.getByRole("region", { name: "小林" });
    expect(within(pm).queryByRole("list", { name: "待发送的文件" })).not.toBeInTheDocument();
    await user.type(within(pm).getByRole("textbox", { name: "输入消息" }), "收到了吗{Enter}");
    await waitFor(() => expect(api.callsTo("POST", /messages$/)).toHaveLength(2));
    const [toWorker, toPm] = api.callsTo("POST", /messages$/);
    expect(toWorker!.path).toBe("/api/conversations/30/messages");
    expect(toPm!.path).toBe("/api/conversations/1/messages");
    expect(toPm!.body).not.toHaveProperty("attachmentIds");
    expect(api.uploads).toHaveLength(1);
    // 再回 Worker：输入框和待发列表是空的
    await user.click(within(log()).getByRole("button", { name: /已派出/ }));
    const again = screen.getByRole("region", { name: "Worker · 修 X" });
    expect(within(again).getByRole("textbox", { name: "输入消息" })).toHaveValue("");
    expect(within(again).queryByRole("list", { name: "待发送的文件" })).not.toBeInTheDocument();
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
    expect(within(section).getByRole("button", { name: "添加文件" })).toBeDisabled();
  });

  it("服务端拒收（409，收工那一刻正好发出去）或断网：标“发送失败”，可以重试", async () => {
    const { user, section, box } = await openWorker();
    api.postMessage = () => ({ status: 409, body: { error: "Worker #3 已经收工了，不能再给它发消息", code: "conflict" } });
    await user.type(box(), "还在吗{Enter}");
    expect(await within(section).findByText("发送失败")).toBeInTheDocument();
    api.postMessage = () => {
      throw new TypeError("Failed to fetch");
    };
    await user.click(within(section).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(api.callsTo("POST", /messages$/)).toHaveLength(2));
    expect(await within(section).findByText("发送失败")).toBeInTheDocument();
  });
});
