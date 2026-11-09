// M3 网页（W4）：项目经理会话里的 Worker 汇报那一行、点开看 Worker 的过程、左下角的额度、顶栏的 Worker 列表面板。接口和 WebSocket 都是假的。
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundledModelCatalog } from "../shared/index.ts";
import type { Message, QuotaResponse, RateLimitInfo, RateLimitWindow, SessionState, StateSnapshot, WsServerMessage } from "../shared/index.ts";
import { COMPACT_QUERY, NARROW_QUERY } from "./useMediaQuery.ts";
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

/**
 * 点开 Worker 的那个按钮：Worker 的汇报（默认数据里“已派出”在项目经理那一轮里，收在 Worked for 里看不见），
 * 或者只有“已派出”一行时那很淡的一行。
 */
function workerButton() {
  return within(log()).getByRole("button", { name: /已派出|做完了/ });
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
  it("Worker 的汇报是“头像 + 标题”加一个摘要气泡，整个气泡是一个按钮（状态是颜色，字在 aria-label）；“已派出”收在项目经理那一轮的 Worked for 里", async () => {
    const user = userEvent.setup();
    await boot();
    const done = within(log()).getByRole("button", { name: /做完了/ });
    expect(done.closest("[data-worker-report]")).toHaveTextContent("修 X");
    expect(done).toHaveTextContent("改好了，测试通过");
    expect(done.closest("[data-worker-report]")).toHaveAttribute("data-tone", "success");
    expect(done.closest("[data-worker-report]")).not.toBeNull();
    expect(within(log()).queryByRole("button", { name: "Worker「修 X」已派出" })).not.toBeInTheDocument();
    await user.click(within(log()).getByRole("button", { name: /Worked for/ }));
    expect(within(log()).getByRole("button", { name: "Worker「修 X」已派出" })).toBeInTheDocument();
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
    expect(within(log()).getByRole("button", { name: "Worker「调查 Y」已派出（只读）" })).toBeInTheDocument();
  });

  it("用户直接对 Worker 说的话：一行“Worker「标题」你对它说：原文”，点开是 Worker 的对话", async () => {
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
    const line = within(log()).getByRole("button", { name: "Worker「修 X」你对它说：顺便改 README" });
    expect(within(log()).queryByText(/Worker 已收到/)).not.toBeInTheDocument();
    await user.click(line);
    expect(screen.getByRole("region", { name: "Worker 修 X" })).toBeInTheDocument();
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
    const buttons = within(log()).getAllByRole("button");
    expect(buttons).toHaveLength(6);
    const expected = [
      ["warn", "缺一个 key"],
      ["danger", "做不了"],
      ["neutral", "我改完了"],
      ["danger", "被停止了"],
      ["danger", "目录被占用"],
    ] as const;
    expected.forEach(([tone, summary], i) => {
      const row = buttons[i]!.closest("[data-worker-report]") as HTMLElement;
      expect(row).toHaveTextContent("修 X");
      expect(row).toHaveAttribute("data-tone", tone);
      expect(row).toHaveTextContent(summary);
    });
    // 收工：不在一轮里，很淡的一行
    expect(buttons[5]).toHaveTextContent("Worker「修 X」已收工");
    expect(buttons[5]!.closest("[data-notice]")).not.toBeNull();
  });

  it("推一条新的 worker 消息，会话里多一行；左栏的预览还是最后一条文字", async () => {
    const ws = await boot();
    push(ws, messageChange(11, "message.created", makeWorkerLine({ id: 4, conversationId: 1, line: { event: "ended" } })));
    expect(within(log()).getByRole("button", { name: "Worker「修 X」已收工" })).toBeInTheDocument();
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
    const section = screen.getByRole("region", { name: "Worker 修 X" });
    expect(within(section).getByRole("heading", { name: "修 X" })).toBeInTheDocument();
    expect(within(section).getByText("任务：修 X")).toBeInTheDocument();
    expect(within(section).getByText("已经修好了")).toBeInTheDocument();
    await user.click(within(section).getByRole("button", { name: /Worked for/ }));
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
    await user.click(workerButton());
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
    await user.click(workerButton());
    expect(screen.getByText("第二句").closest("[data-head]")).toHaveAttribute("data-head", "false");
  });

  it("Worker 在干活：消息流里显示它在做什么，“停止”停的是 Worker 的对话", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    await user.click(workerButton());
    push(ws, sessionChange(11, makeSession({ sessionId: 2, conversationId: 30, status: "running", activity: "working", step: { type: "tool_use", name: "Bash", input: {} } })));
    const status = screen.getByRole("status", { name: "状态" });
    expect(status).toHaveTextContent("Running command");
    await user.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(api.callsTo("POST", /stop$/)).toHaveLength(1));
    expect(api.callsTo("POST", /stop$/)[0]?.path).toBe("/api/conversations/30/stop");
  });

  it("Worker 网络出错在重试：状态写“Retrying”，“停止”照常停 Worker 的对话", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    await user.click(workerButton());
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
    expect(screen.getByRole("status", { name: "状态" })).toHaveTextContent("Retrying 5/10");
    await user.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(api.callsTo("POST", /stop$/)).toHaveLength(1));
    expect(api.callsTo("POST", /stop$/)[0]?.path).toBe("/api/conversations/30/stop");
  });

  it("31 Worker 准备中：状态写“Running setup”、有停止按钮，停的是 Worker 的对话", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    await user.click(workerButton());
    push(ws, sessionChange(11, makeSession({ sessionId: 2, conversationId: 30, status: "idle", activity: "preparing" })));
    const status = screen.getByRole("status", { name: "状态" });
    expect(status).toHaveTextContent("Running setup");
    expect(status).toHaveAttribute("data-busy", "true");
    await user.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(api.callsTo("POST", /stop$/)).toHaveLength(1));
    expect(api.callsTo("POST", /stop$/)[0]?.path).toBe("/api/conversations/30/stop");
  });

  it("新消息推来就接在后面", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    await user.click(workerButton());
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
    await user.click(workerButton());
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
    await user.click(workerButton());
    expect(screen.getByText("还没有消息")).toBeInTheDocument();
  });

  it("找不到这个 Worker 的对话：写出来，能回去", async () => {
    const user = userEvent.setup();
    await boot(
      withWorker({
        conversations: [makeConvSnapshot([makeWorkerLine({ id: 2, conversationId: 1 })], { conversation: { id: 1, pmId: 1, title: "小林" } })],
      }),
    );
    await user.click(workerButton());
    expect(screen.getByText("找不到这个 Worker 的对话")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "返回 小林" }));
    expect(screen.getByRole("region", { name: "小林" })).toBeInTheDocument();
  });

  it("“返回”回到项目经理的会话；点左栏也回去", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(workerButton());
    await user.click(screen.getByRole("button", { name: "返回 小林" }));
    expect(screen.getByRole("region", { name: "小林" })).toBeInTheDocument();
    await user.click(workerButton());
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
    await user.click(workerButton());
    expect(within(screen.getByRole("region", { name: "Worker 修 X" })).getByText("只读")).toBeInTheDocument();
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

  describe("按需查的额度（agy）", () => {
    const agySession = () => makeSession({ sessionId: 9, conversationId: 30, vendor: "agy", lastEventAt: 5 });
    const agyWorker = () => withWorker({ sessions: [agySession()] });
    const claudeAndAgy = () =>
      withWorker({ sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1, rateLimit: quota(0.37, 0.59), lastEventAt: 5 }), agySession()] });
    const reply = {
      groups: [
        { id: "gemini", name: "Gemini", windows: { five_hour: win(0.25), seven_day: win(0.5, { resetsAt: 1_793_646_000 }) } },
        { id: "claude_gpt", name: "Claude 和 GPT", windows: { five_hour: win(0.9) } },
      ],
    };
    const ask = () => api.calls.filter((c) => c.path === "/api/quota").length;

    it("打开面板才问；问到的每一组一块，窗口各一行；不改左下角按钮", async () => {
      const user = userEvent.setup();
      await boot(claudeAndAgy());
      api.quota = () => ({ status: 200, body: reply });
      expect(ask()).toBe(0);
      await user.click(badge());
      const gemini = await screen.findByRole("region", { name: "Antigravity · Gemini" });
      expect(within(gemini).getByRole("progressbar", { name: "5 小时额度" })).toHaveAttribute("aria-valuenow", "25");
      expect(within(gemini).getByRole("progressbar", { name: "7 天额度" })).toHaveAttribute("aria-valuenow", "50");
      expect(within(screen.getByRole("region", { name: "Antigravity · Claude 和 GPT" })).getByRole("progressbar", { name: "5 小时额度" })).toHaveAttribute("aria-valuenow", "90");
      expect(ask()).toBe(1);
      expect(badge()).toHaveAccessibleName("5 小时额度已用 37%");
      expect(badge().textContent).toBe("");
    });

    it("没有别家的事件额度、有 agy 会话：按钮也在（只显示圆环图标，不带旁白文字），打开后先显示 Loading…，拉到后显示 agy 的", async () => {
      const user = userEvent.setup();
      await boot(agyWorker());
      expect(badge()).toHaveAccessibleName("额度");
      expect(badge().textContent).toBe("");
      const gate = deferred<{ status: number; body: unknown }>();
      api.quota = () => gate.promise;
      await user.click(badge());
      expect(await screen.findByText("Loading…")).toHaveClass("text-xs", "text-muted-foreground");
      gate.resolve({ status: 200, body: reply });
      expect(await screen.findByRole("region", { name: "Antigravity · Gemini" })).toBeInTheDocument();
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    });

    it("现查厂商（agy）某个窗口耗尽（100% 已用 / 0% 剩余）：左下角圆环按钮变成红色，不显示“额度用完”文字", async () => {
      const user = userEvent.setup();
      await boot(claudeAndAgy());
      api.quota = () => ({
        status: 200,
        body: {
          groups: [{ id: "gemini", name: "Gemini", windows: { five_hour: win(1) } }],
        },
      });
      await user.click(badge());
      await screen.findByRole("region", { name: "Antigravity · Gemini" });
      expect(badge()).toHaveAccessibleName("额度已用完");
      expect(badge().textContent).toBe("");
      expect(badge()).toHaveClass("text-danger");
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
      expect(screen.queryByRole("button", { name: /额度/ })).not.toBeInTheDocument();
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
    expect(screen.queryByRole("button", { name: /额度/ })).not.toBeInTheDocument();
  });

  it("只渲染干净的圆环图标按钮（无旁白文字），保留 aria-label 与 title；和设置按钮同一种 ghost icon-sm 按钮，不是胶囊底色", async () => {
    await boot(withQuota(quota(0.37, 0.59)));
    expect(badge().textContent).toBe("");
    expect(badge()).toHaveAccessibleName("5 小时额度已用 37%");
    expect(badge()).toHaveAttribute("title", "5 小时额度已用 37%");
    expect(badge()).not.toHaveClass("text-warn-foreground", "text-danger");
    expect(badge()).toHaveClass("size-8", "text-muted-foreground", "hover:bg-accent");
    expect(badge().className).not.toMatch(/(^|\s)bg-/);
    expect(badge().querySelector("svg")).toBeInTheDocument();
  });

  it("推 session.status 带来新的额度：跟着变", async () => {
    const ws = await boot(withQuota(quota(0.37, 0.59)));
    push(ws, sessionChange(11, makeSession({ conversationId: 1, pmId: 1, rateLimit: quota(0.4, 0.6), lastEventAt: 9 })));
    expect(badge()).toHaveAccessibleName("5 小时额度已用 40%");
    expect(badge().textContent).toBe("");
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
      expect(badge()).toHaveAccessibleName("5 小时额度已用 99%");
      expect(badge()).toHaveClass("text-warn-foreground");
      advance(599);
      expect(badge()).toHaveAccessibleName("5 小时额度已用 99%");
      advance(2);
      expect(badge()).toHaveAccessibleName("5 小时额度已用 0%");
      expect(badge()).not.toHaveClass("text-warn-foreground");
      await user.click(badge());
      expect(screen.getByRole("progressbar", { name: "5 小时额度" })).toHaveAttribute("aria-valuenow", "0");
      expect(screen.getByRole("progressbar", { name: "7 天额度" })).toHaveAttribute("aria-valuenow", "31");
      expect(screen.getAllByText(/重置/)).toHaveLength(1); // 只剩 7 天窗口的
    });

    it("重置后新的 rate_limit_event 一到（新 resetsAt）：马上显示新窗口的值", async () => {
      clock(RESET - 600);
      const ws = await boot(withQuota(rl(0.99, RESET, "allowed_warning")));
      advance(601);
      expect(badge()).toHaveAccessibleName("5 小时额度已用 0%");
      push(ws, sessionChange(11, makeSession({ conversationId: 1, pmId: 1, rateLimit: rl(0.03, NEXT_RESET), lastEventAt: 9 })));
      expect(badge()).toHaveAccessibleName("5 小时额度已用 3%");
    });

    it("用完了（已用完）：到了 resetsAt 自己恢复正常状态", async () => {
      clock(RESET - 600);
      await boot(withQuota(rl(1, RESET, "rejected")));
      expect(badge()).toHaveAccessibleName("额度已用完");
      expect(badge().textContent).toBe("");
      advance(601);
      expect(badge()).toHaveAccessibleName("5 小时额度已用 0%");
      expect(badge()).not.toHaveClass("text-danger");
    });
  });

  it.each([
    [0.79, "allowed", false],
    [0.8, "allowed", true],
    [0.5, "allowed_warning", true],
  ])("快用完：已用 %s、status %s → 醒目色 %s", async (used, status, warn) => {
    await boot(withQuota(limit({ five_hour: win(used, { status }) })));
    if (warn) expect(badge()).toHaveClass("text-warn-foreground");
    else expect(badge()).not.toHaveClass("text-warn-foreground");
    expect(badge().textContent).toBe("");
  });

  it("用完了（rejected）：只渲染红色圆环图标，不显示“额度用完”或百分比旁白文字", async () => {
    await boot(withQuota(limit({ five_hour: win(1, { status: "rejected" }) }, "rejected")));
    expect(badge()).toHaveAccessibleName("额度已用完");
    expect(badge()).toHaveAttribute("title", "额度已用完");
    expect(badge().textContent).toBe("");
    expect(badge()).toHaveClass("text-danger");
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
    expect(badge()).toHaveAccessibleName("7 天额度已用 20%");
    expect(badge().textContent).toBe("");
    await user.click(badge());
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    expect(screen.getByRole("progressbar", { name: "7 天额度" })).toBeInTheDocument();
  });

  it("脏数据：超过 1 夹成 100%，负数夹成 0%，没有重置时间的不显示重置", async () => {
    const user = userEvent.setup();
    await boot(withQuota(limit({ five_hour: win(1.7, { resetsAt: 0 }), seven_day: win(-0.3) })));
    expect(badge()).toHaveAccessibleName("5 小时额度已用 100%");
    expect(badge()).toHaveClass("text-warn-foreground");
    await user.click(badge());
    expect(screen.getByRole("progressbar", { name: "5 小时额度" })).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByRole("progressbar", { name: "7 天额度" })).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getAllByText(/重置/)).toHaveLength(1);
  });
});

describe("右栏（等你确定和 Worker，推开对话）", () => {
  const toggle = () => screen.queryByRole("button", { name: /右栏/ });
  const rail = () => screen.queryByRole("complementary", { name: "右栏" });
  const workerGroup = () => within(rail()!).getByRole("region", { name: /^Worker/ });
  /** 每个 Worker 行第一行的字：标题 + 状态。 */
  const rows = () =>
    within(workerGroup())
      .getAllByRole("button")
      .filter((b) => b.querySelector('[data-testid="worker-meta"]') !== null)
      .map((b) => b.querySelector('[data-testid="worker-meta"]')!.previousElementSibling!.textContent);
  /** 最下面的“已收工 N ›”一行；没有收工的 Worker 就没有。 */
  const endedToggle = () => within(workerGroup()).queryByRole("button", { name: /^已收工/ });
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
  /** 换掉 matchMedia：queries 里的成立。 */
  const media = (...queries: string[]) => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: queries.includes(query), addEventListener() {}, removeEventListener() {} }));
  };

  it("没有 Worker、也没有等你确定：没有开关，右栏不占位置", async () => {
    await boot(alone());
    expect(toggle()).not.toBeInTheDocument();
    expect(rail()).not.toBeInTheDocument();
  });

  it("有 Worker：自动展开；和对话并排（main 的兄弟），不浮在对话上面；对话和输入框一直在", async () => {
    await boot(crowd());
    const aside = rail()!;
    const main = screen.getByRole("main");
    expect(aside.closest("main")).toBeNull();
    expect(aside.parentElement).toBe(main.parentElement);
    const classes = aside.className.split(" ");
    expect(classes.some((c) => /(^|:)(fixed|absolute)$/.test(c))).toBe(false);
    expect(classes).toEqual(expect.arrayContaining(["shrink-0", "w-[320px]", "border-l"]));
    expect(aside.className).not.toMatch(/shadow|rounded/);
    expect(within(main).getByRole("heading", { name: "小林" })).toBeInTheDocument();
    expect(within(main).getByRole("textbox")).toBeVisible();
  });

  it("只有两组：等你确定、Worker；没有提问时只有 Worker 一组", async () => {
    await boot(
      crowd({
        conversations: [
          makeConvSnapshot([makeMessage({ id: 5, conversationId: 1, text: "用 A 还是 B？", meta: { needsUser: true } })], { conversation: { id: 1, pmId: 1, title: "小林" } }),
          makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 30, title: "修 X" }) }),
        ],
      }),
    );
    expect(within(rail()!).getAllByRole("heading").map((h) => h.textContent)).toEqual(["等你确定", "Worker"]);
    cleanup();
    await boot(crowd());
    expect(within(rail()!).getAllByRole("heading").map((h) => h.textContent)).toEqual(["Worker"]);
  });

  it("开关：右栏展开时在右栏顶部、收起时回到窗口右上角（顶栏右边）；ghost 图标按钮（没有底色、描边、字）；点一下收起，再点展开", async () => {
    const user = userEvent.setup();
    await boot(crowd());
    const header = screen.getByRole("heading", { name: "小林" }).closest("header")!;
    expect(within(rail()!).getByRole("button", { name: "收起右栏" })).toBe(toggle());
    expect(within(header).queryByRole("button", { name: /右栏/ })).not.toBeInTheDocument();
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(toggle()).toHaveClass("text-foreground", "hover:bg-accent");
    expect(toggle()!.className).not.toMatch(/(^|\s)(bg-|border)/);
    expect(toggle()).toHaveTextContent("");
    await user.click(toggle()!);
    expect(rail()).not.toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "展开右栏" })).toBe(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle()!);
    expect(rail()).toBeInTheDocument();
    expect(within(rail()!).getByRole("button", { name: "收起右栏" })).toBe(toggle());
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
    // 再手动展开：忘掉收起的选择
    await user.click(toggle()!);
    cleanup();
    await boot(crowd());
    expect(rail()).toBeInTheDocument();
  });

  it("Worker 的小圆点跟着项目经理会话里最近一行汇报的状态色（worker-status）：做完了绿、有问题黄；在忙的是强调色", async () => {
    await boot(
      crowd({
        conversations: [
          makeConvSnapshot(
            [
              makeWorkerLine({ id: 2, conversationId: 1, line: { workerConversationId: 31, event: "report", status: "done", summary: "好了" } }),
              makeWorkerLine({ id: 3, conversationId: 1, line: { workerConversationId: 30, event: "report", status: "problem", summary: "卡住了" } }),
              makeWorkerLine({ id: 4, conversationId: 1, line: { workerConversationId: 32, event: "report", status: "problem", summary: "要你看一下" } }),
            ],
            { conversation: { id: 1, pmId: 1, title: "小林" } },
          ),
          makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 30, title: "修 X" }) }),
          makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 31, title: "写文档" }) }),
          makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 32, title: "查日志" }) }),
        ],
        sessions: [makeSession({ sessionId: 3, conversationId: 30, status: "running", activity: "working" }), makeSession({ sessionId: 4, conversationId: 31 }), makeSession({ sessionId: 5, conversationId: 32 })],
      }),
    );
    const dot = (name: RegExp) => within(within(workerGroup()).getByRole("button", { name })).getByTestId("status-dot");
    expect(dot(/修 X/)).toHaveClass("bg-primary");
    expect(dot(/写文档/)).toHaveClass("bg-success");
    expect(dot(/查日志/)).toHaveClass("bg-caution");
  });

  it("Worker 一行一个：标题和状态（英文状态词）；干活的、Idle 的照常列出，收工的收成最下面一行“已收工 N ›”，点开才展开，展开后淡一些", async () => {
    const user = userEvent.setup();
    await boot(crowd());
    expect(rows()).toEqual(["修 XWorking…", "写文档Idle"]);
    expect(within(workerGroup()).queryByRole("button", { name: /查日志/ })).not.toBeInTheDocument();
    const toggleEnded = endedToggle()!;
    expect(toggleEnded).toHaveTextContent("已收工 1");
    expect(toggleEnded).toHaveAttribute("aria-expanded", "false");
    expect(within(toggleEnded).getByText("1")).toHaveClass("tabular-nums");
    expect(workerGroup().querySelector("[data-group-body] > div")!.lastElementChild).toBe(toggleEnded);
    await user.click(toggleEnded);
    expect(toggleEnded).toHaveAttribute("aria-expanded", "true");
    expect(rows()).toEqual(["修 XWorking…", "写文档Idle", "查日志Ended"]);
    expect(within(workerGroup()).getByRole("button", { name: /查日志/ })).toHaveClass("opacity-60");
    expect(within(workerGroup()).getByRole("button", { name: /修 X/ })).not.toHaveClass("opacity-60");
    await user.click(toggleEnded);
    expect(rows()).toEqual(["修 XWorking…", "写文档Idle"]);
    expect(within(workerGroup()).getByText("Working…")).toHaveClass("text-primary");
    expect(within(workerGroup()).getByText("Idle")).toHaveClass("text-muted-foreground");
  });

  it("一堆收工的 Worker：只列在干活的，收工的数量写在最下面一行", async () => {
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
    expect(rows()).toEqual(["修 XWorking…"]);
    expect(within(rail()!).getAllByRole("heading").map((h) => h.textContent)).toEqual(["Worker"]);
    expect(endedToggle()).toHaveTextContent("已收工 30");
  });

  it("打开一个已收工的 Worker 的对话：已收工那一行自动展开，当前那行看得见", async () => {
    await boot(crowd());
    window.location.hash = "#/w/32";
    await waitFor(() => expect(within(workerGroup()).getByRole("button", { name: /查日志/ })).toHaveAttribute("aria-current", "true"));
    expect(endedToggle()).toHaveAttribute("aria-expanded", "true");
  });

  it("各状态：Stopping…、Running setup…（主色）；不认识的 activity 当在忙", async () => {
    const stopping = makeSession({ sessionId: 3, conversationId: 30, activity: "stopping" });
    const preparing = makeSession({ sessionId: 4, conversationId: 31, activity: "preparing" });
    const unknown = makeSession({ sessionId: 6, conversationId: 40, activity: "bogus" as SessionState["activity"] });
    await boot(crowd({ sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1 }), stopping, preparing, makeSession({ sessionId: 5, conversationId: 32, status: "ended" }), unknown] }));
    // 在忙的（准备中）排在前面
    expect(rows()).toEqual(["写文档Running setup…", "修 XStopping…"]);
    expect(within(workerGroup()).getByText("Running setup…")).toHaveClass("text-primary");
    await userEvent.setup().click(within(nav()).getByRole("button", { name: /老马/ }));
    expect(rows()).toEqual(["老马的活Working…"]);
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
    expect(rows()).toEqual(["修 XIdle"]);
    expect(endedToggle()).toHaveTextContent("已收工 2");
    await userEvent.setup().click(endedToggle()!);
    expect(rows()).toEqual(["修 XIdle", "查日志Ended", "写文档Ended"]);
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
    const metaOf = () => within(workerGroup()).getByRole("button", { name: /修 X/ }).querySelector('[data-testid="worker-meta"]')!;

    it("第二行：模型的显示名（模型目录里的名字）、思考程度、现在的对话长度（158K context 这样，不是累计 token）；不写厂商，也没有“·”；小一号灰字", async () => {
      await boot(withAgent({ vendor: "claude", model: "sonnet", effort: "high", usage }));
      const row = within(workerGroup()).getByRole("button", { name: /修 X/ });
      expect([...metaOf().children].map((c) => c.textContent)).toEqual(["Sonnet", "high", "117K context"]);
      expect(row).not.toHaveTextContent("Claude Code");
      expect(row).not.toHaveTextContent("·");
      expect(metaOf()).toHaveClass("text-[13px]", "leading-[18px]", "text-muted-foreground");
      expect(within(row).getByText("117K context")).toHaveClass("tabular-nums");
    });

    it("默认模型显示“默认”；没设思考程度就不显示这一项", async () => {
      await boot(withAgent({ vendor: "claude", model: null, effort: null, usage }));
      expect([...metaOf().children].map((c) => c.textContent)).toEqual(["默认", "117K context"]);
    });

    it("默认模型：厂商的模型名单说了实际是哪个（defaultModel），就写它，不写“默认”", async () => {
      const fake = new FakeApi(withAgent({ vendor: "claude", model: null, effort: null, usage }));
      fake.models = () => ({ status: 200, body: { catalogs: [{ ...bundledModelCatalog("claude"), source: "vendor", defaultModel: "Opus 5.5" }] } });
      fake.install();
      installFakeWebSocket();
      render(<App />);
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      act(() => FakeWebSocket.last.open());
      await waitFor(() => expect([...metaOf().children].map((c) => c.textContent)).toEqual(["Opus 5.5", "117K context"]));
    });

    it("老服务端没带厂商、模型、用量：不显示模型，对话长度显示“—”而不是 0", async () => {
      await boot(withAgent({}));
      expect([...metaOf().children].map((c) => c.textContent)).toEqual(["—"]);
    });

    it("悬停 context 显示明细（累计的各项，英文单位）", async () => {
      await boot(withAgent({ vendor: "claude", model: "sonnet", usage }));
      expect(within(workerGroup()).getByText("117K context")).toHaveAttribute(
        "title",
        ["Context 117,000 tokens", "Cumulative so far", "Input 392 tokens", "Cache read 47,000,000 tokens", "Cache write 448,354 tokens", "Output 154,408 tokens"].join("\n"),
      );
    });

    it("标题和模型超长时截断，不撑破", async () => {
      await boot(withAgent({ vendor: "claude", model: "sonnet", usage }));
      const row = within(workerGroup()).getByRole("button", { name: /修 X/ });
      expect(within(row).getByText("修 X")).toHaveClass("truncate");
      expect(within(row).getByText("Sonnet")).toHaveClass("truncate");
    });
  });

  it("点一行打开那个 Worker 的对话（网址跟着变），右栏保持展开，当前那行高亮；选左栏回到项目经理时不再高亮", async () => {
    const user = userEvent.setup();
    await boot(crowd());
    const row = (name: RegExp) => within(workerGroup()).getByRole("button", { name });
    await user.click(row(/修 X/));
    expect(screen.getByRole("region", { name: "Worker 修 X" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#/w/30");
    expect(rail()).toBeInTheDocument();
    expect(row(/修 X/)).toHaveAttribute("aria-current", "true");
    expect(row(/修 X/)).toHaveClass("bg-sidebar-active");
    // 选中只靠底色，标题字重不变
    expect(within(row(/修 X/)).getByText("修 X")).not.toHaveClass("font-semibold");
    expect(row(/写文档/)).not.toHaveAttribute("aria-current");
    await user.click(row(/写文档/));
    expect(screen.getByRole("region", { name: "Worker 写文档" })).toBeInTheDocument();
    await user.click(within(nav()).getByRole("button", { name: /小林/ }));
    expect(row(/写文档/)).not.toHaveAttribute("aria-current");
    expect(window.location.hash).toBe("#/c/1");
  });

  it("切换项目经理：列表跟着变；对方没有 Worker 也没有提问就没有右栏和开关", async () => {
    const user = userEvent.setup();
    await boot(crowd());
    await user.click(within(nav()).getByRole("button", { name: /老马/ }));
    expect(rows()).toEqual(["老马的活Idle"]);
    cleanup();
    await boot(crowd({ conversations: crowd().conversations.filter((c) => c.conversation.id !== 40) }));
    await user.click(within(nav()).getByRole("button", { name: /老马/ }));
    expect(toggle()).not.toBeInTheDocument();
    expect(rail()).not.toBeInTheDocument();
  });

  it("实时变：会话状态一推就变；收工那一行一来，这个 Worker 收进“已收工”", async () => {
    const ws = await boot(crowd());
    push(ws, sessionChange(11, makeSession({ sessionId: 4, conversationId: 31, status: "running", activity: "working" })));
    expect(rows()).toEqual(["修 XWorking…", "写文档Working…"]);
    expect(endedToggle()).toHaveTextContent("已收工 1");
    push(ws, messageChange(12, "message.created", makeWorkerLine({ id: 50, conversationId: 1, line: { workerConversationId: 30, event: "ended" } })));
    expect(rows()).toEqual(["写文档Working…"]);
    expect(endedToggle()).toHaveTextContent("已收工 2");
    await userEvent.setup().click(endedToggle()!);
    expect(rows()).toEqual(["写文档Working…", "修 XEnded", "查日志Ended"]);
    expect(within(workerGroup()).getByRole("button", { name: /修 X/ })).toHaveClass("opacity-60");
  });

  it("第一个 Worker 一派出来，右栏自己展开", async () => {
    const ws = await boot(alone());
    expect(rail()).not.toBeInTheDocument();
    push(ws, changeOf(11, "conversation.created", { conversation: makeWorkerConversation({ id: 33, title: "新活" }) }));
    expect(rows()).toEqual(["新活Idle"]);
  });

  describe("没有要关心的事（没有在干活或等验收的 Worker，也没有等你确定）：右栏整栏不出来", () => {
    /** 小林只有收工的 Worker（30）。 */
    const onlyEnded = () => crowd({ sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1 }), makeSession({ sessionId: 3, conversationId: 30, status: "ended" })], conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, title: "小林" } }), makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 30, title: "修 X" }) })] });
    const header = () => screen.getByRole("heading", { name: "小林" }).closest("header")!;

    it("只有收工的 Worker：右栏不出来，开关在顶栏右上角；点开关手动打开，看到“已收工”；再点收起（并记住）", async () => {
      const user = userEvent.setup();
      await boot(onlyEnded());
      expect(rail()).not.toBeInTheDocument();
      expect(within(header()).getByRole("button", { name: "展开右栏" })).toBeInTheDocument();
      await user.click(toggle()!);
      expect(rail()).toBeInTheDocument();
      expect(endedToggle()).toHaveTextContent("已收工 1");
      expect(within(rail()!).getByRole("button", { name: "收起右栏" })).toBe(toggle());
      await user.click(toggle()!);
      expect(rail()).not.toBeInTheDocument();
      expect(localStorage.getItem("agent-hub.rightRail")).toBe("closed");
    });

    it("手动打开后，来了在干活的 Worker 照样开着；手动打开的不记成“收起”", async () => {
      const user = userEvent.setup();
      const ws = await boot(onlyEnded());
      await user.click(toggle()!);
      expect(localStorage.getItem("agent-hub.rightRail")).toBeNull();
      push(ws, changeOf(11, "conversation.created", { conversation: makeWorkerConversation({ id: 33, title: "新活" }) }));
      expect(rows()).toEqual(["新活Idle"]);
    });

    it("来了新的 Worker（没收工的）或新的提问：右栏自动出来；用户手动收起过的不弹", async () => {
      const ws = await boot(onlyEnded());
      expect(rail()).not.toBeInTheDocument();
      push(ws, changeOf(11, "conversation.created", { conversation: makeWorkerConversation({ id: 33, title: "新活" }) }));
      expect(rows()).toEqual(["新活Idle"]);
      cleanup();
      const ws2 = await boot(onlyEnded());
      push(ws2, messageChange(12, "message.created", makeMessage({ id: 9, conversationId: 1, text: "用 A 还是 B？", meta: { needsUser: true } })));
      expect(within(rail()!).getByRole("region", { name: /^等你确定/ })).toBeInTheDocument();
    });

    it("在干活的 Worker 都收工了：右栏自己收起，开关还在", async () => {
      const ws = await boot(crowd({ sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1 }), makeSession({ sessionId: 3, conversationId: 30, status: "running", activity: "working" })], conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, title: "小林" } }), makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 30, title: "修 X" }) })] }));
      expect(rail()).toBeInTheDocument();
      push(ws, messageChange(12, "message.created", makeWorkerLine({ id: 50, conversationId: 1, line: { workerConversationId: 30, event: "ended" } })));
      expect(rail()).not.toBeInTheDocument();
      expect(toggle()).toHaveAttribute("aria-expanded", "false");
    });
  });

  it("窄屏（1100px 以下）：右栏照样推开对话；左栏收成抽屉，顶栏最左边的按钮拉出来，选了对话、按 Esc、点遮罩都收起", async () => {
    media(NARROW_QUERY);
    const user = userEvent.setup();
    await boot(crowd());
    expect(rail()!.closest("main")).toBeNull();
    expect(rail()!.className.split(" ").some((c) => /(fixed|absolute)$/.test(c))).toBe(false);
    const sidebar = screen.getByRole("complementary", { name: "左栏" });
    expect(sidebar).toHaveAttribute("data-drawer", "closed");
    expect(sidebar).toHaveClass("max-[1100px]:hidden", "max-[1100px]:fixed");
    const open = screen.getByRole("button", { name: "对话列表" });
    expect(open.closest("header")).not.toBeNull();
    await user.click(open);
    expect(sidebar).toHaveAttribute("data-drawer", "open");
    expect(sidebar).not.toHaveClass("max-[1100px]:hidden");
    await user.click(within(nav()).getByRole("button", { name: /老马/ }));
    expect(sidebar).toHaveAttribute("data-drawer", "closed");
    await user.click(screen.getByRole("button", { name: "对话列表" }));
    await user.keyboard("{Escape}");
    expect(sidebar).toHaveAttribute("data-drawer", "closed");
    await user.click(screen.getByRole("button", { name: "对话列表" }));
    await user.click(screen.getByTestId("drawer-backdrop"));
    expect(sidebar).toHaveAttribute("data-drawer", "closed");
  });

  it("宽屏没有拉左栏的按钮", async () => {
    await boot(crowd());
    expect(screen.queryByRole("button", { name: "对话列表" })).not.toBeInTheDocument();
  });

  it("太窄（720px 以下）：右栏不自动展开；点开关出现在顶栏下面（main 里、把消息往下推），不浮着；点一行打开 Worker 就收起", async () => {
    media(NARROW_QUERY, COMPACT_QUERY);
    const user = userEvent.setup();
    await boot(crowd());
    expect(rail()).not.toBeInTheDocument();
    await user.click(toggle()!);
    const main = screen.getByRole("main");
    expect(main).toContainElement(rail());
    // 这一档右栏在顶栏下面，开关留在顶栏右边
    expect(within(screen.getByRole("heading", { name: "小林" }).closest("header")!).getByRole("button", { name: "收起右栏" })).toBe(toggle());
    expect(rail()!.className).not.toMatch(/fixed|absolute/);
    expect(rail()).toHaveClass("max-h-[40dvh]", "border-b");
    expect(within(main).getByRole("textbox")).toBeVisible();
    await user.click(within(workerGroup()).getByRole("button", { name: /修 X/ }));
    expect(screen.getByRole("region", { name: "Worker 修 X" })).toBeInTheDocument();
    expect(rail()).not.toBeInTheDocument();
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
      { id: "claude", name: "Claude", exhausted: false, windows: [{ key: "five_hour", label: "5 小时", short: "5h", percent: 30, resetsAt: 7, warning: false }] },
    ]);
    expect(quotaUsage(loaded(withWorker()), 0)).toEqual([]);
  });

  it("fetchedQuotaUsage：服务端回的每一组是一块（厂商名 · 组名），窗口按 5 小时、7 天；已过重置时间的算 0%", () => {
    const res: QuotaResponse = {
      groups: [
        { id: "gemini", name: "Gemini", windows: { seven_day: { utilization: 0.1, resetsAt: 9_000, status: "allowed" }, five_hour: { utilization: 0.85, resetsAt: 5_000, status: "allowed" } } },
        { id: "不认识的组", name: "x", windows: { five_hour: { utilization: 0.5, resetsAt: 9_000, status: "allowed" } } },
      ],
    };
    expect(fetchedQuotaUsage(res, 0)).toEqual([
      {
        id: "gemini",
        name: "Antigravity · Gemini",
        exhausted: false,
        windows: [
          { key: "five_hour", label: "5 小时", short: "5h", percent: 85, resetsAt: 5_000, warning: true },
          { key: "seven_day", label: "7 天", short: "7d", percent: 10, resetsAt: 9_000, warning: false },
        ],
      },
    ]);
    expect(fetchedQuotaUsage(res, 6_000_000)[0]!.windows[0]).toMatchObject({ percent: 0, resetsAt: null, warning: false });
    expect(fetchedQuotaUsage({ groups: [] }, 0)).toEqual([]);
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
      { id: "claude", name: "Claude", exhausted: false, windows: [{ key: "five_hour", label: "5 小时", short: "5h", percent: 6, resetsAt: 1_794_070_800, warning: false }] },
      { id: "codex", name: "Codex", exhausted: false, windows: [{ key: "thirty_day", label: "30 天", short: "30d", percent: 19, resetsAt: 1_796_193_545, warning: false }] },
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
          { key: "five_hour", label: "5 小时", short: "5h", percent: 100, resetsAt: 1_794_219_196, warning: true },
          { key: "seven_day", label: "7 天", short: "7d", percent: 16, resetsAt: 1_794_805_996, warning: false },
        ],
      },
    ]);
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
      expect(five(state, before)).toEqual({ key: "five_hour", label: "5 小时", short: "5h", percent: 99, resetsAt: RESET, warning: true });
    });

    it("过了 resetsAt 还没有新事件：5 小时窗口算已重置，显示 0%、没有重置时间、不标快用完；7 天窗口不受影响", () => {
      const state = stateOf([makeSession({ sessionId: 18, conversationId: 30, lastEventAt: 100, rateLimit: rl(0.99, RESET, 0.31, "allowed_warning") })]);
      expect(five(state, after)).toEqual({ key: "five_hour", label: "5 小时", short: "5h", percent: 0, resetsAt: null, warning: false });
      expect(quotaUsage(state, after)[0]!.windows.find((w) => w.key === "seven_day")).toMatchObject({ percent: 31, resetsAt: SEVEN_DAY_RESET });
    });

    it("重置后第一条新事件到了（新 resetsAt、utilization 0）：显示新窗口的值和新的重置时间", () => {
      const state = stateOf([makeSession({ sessionId: 1, conversationId: 1, lastEventAt: 200, rateLimit: rl(0, NEXT_RESET, 0.31) })]);
      expect(five(state, after)).toEqual({ key: "five_hour", label: "5 小时", short: "5h", percent: 0, resetsAt: NEXT_RESET, warning: false });
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
    await user.click(workerButton());
    const section = screen.getByRole("region", { name: "Worker 修 X" });
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
    expect(within(mine).getByText("Queued")).toBeInTheDocument();
    const clientId = (call.body as { clientId: string }).clientId;
    push(
      ws,
      messageChange(11, "message.created", makeUserMessage({ id: 40, conversationId: 30, workerId: 3, text: "顺便改 README", status: "queued", dedupeKey: `client:30:${clientId}` })),
    );
    gate.resolve({ status: 200, body: { messageId: 40 } });
    await act(async () => {});
    expect(within(section).getAllByText("顺便改 README")).toHaveLength(1);
    expect(within(within(section).getByText("顺便改 README").closest("article")!).getByText("Queued")).toBeInTheDocument();
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
    await user.click(workerButton());
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

  it("项目经理已经让它收工（有“已收工”那一行），会话还在跑完这一轮：Worker 页面不显示输入框，Worker 面板也算收工", async () => {
    const { ws, section } = await openWorker();
    push(ws, sessionChange(11, makeSession({ sessionId: 2, conversationId: 30, status: "running", activity: "working" })));
    push(ws, messageChange(12, "message.created", makeWorkerLine({ id: 20, conversationId: 1, line: { event: "ended" } })));
    expect(within(section).queryByRole("textbox")).not.toBeInTheDocument();
    // 只剩收工的 Worker：右栏自己收起，点开关才看
    await userEvent.setup().click(screen.getByRole("button", { name: "展开右栏" }));
    const aside = screen.getByRole("complementary", { name: "右栏" });
    expect(within(aside).getByRole("button", { name: /^已收工 1/ })).toBeInTheDocument();
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
    await user.click(workerButton());
    const again = screen.getByRole("region", { name: "Worker 修 X" });
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
    await user.click(workerButton());
    const again = screen.getByRole("region", { name: "Worker 修 X" });
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

  it("已收工的历史 Worker 对话（初始快照 messages 为空、hasMore 为 true）：点开详情时自动按需拉取历史消息并展示", async () => {
    const user = userEvent.setup();
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
    await user.click(workerButton());
    const section = screen.getByRole("region", { name: "Worker 修 X" });
    expect(await within(section).findByText("任务：压缩状态快照")).toBeInTheDocument();
    expect(within(section).getByText("已完成快照瘦身与 gzip 压缩")).toBeInTheDocument();
    expect(within(section).queryByRole("textbox")).not.toBeInTheDocument();
  });
});
