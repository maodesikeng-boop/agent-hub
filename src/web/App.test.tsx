// W4 网页：按 m1-plan 第 4 节“W4 网页”的测试表写，接口和 WebSocket 都是假的。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MESSAGE_BYTES, type Message, type StateSnapshot, type WsServerMessage } from "../shared/index.ts";
import { App } from "./App.tsx";
import {
  FakeApi,
  FakeWebSocket,
  healthChange,
  installFakeWebSocket,
  makeConvSnapshot,
  makeHealth,
  makeMessage,
  makePm,
  makeSession,
  makeSnapshot,
  makeToolMessage,
  makeUserMessage,
  messageChange,
  sessionChange,
} from "./test-utils.ts";

let api: FakeApi;
let unmountApp: () => void;

/** 起网页：假接口 + 假 WebSocket，等首屏出来、WebSocket 接上。 */
async function boot(snapshot: StateSnapshot = defaultSnapshot()) {
  api = new FakeApi(snapshot);
  api.install();
  installFakeWebSocket();
  unmountApp = render(<App />).unmount;
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  act(() => FakeWebSocket.last.open());
  return FakeWebSocket.last;
}

function defaultSnapshot(): StateSnapshot {
  return makeSnapshot({
    pms: [makePm({ id: 1, name: "小林" })],
    conversations: [
      makeConvSnapshot(
        [
          makeUserMessage({ id: 1, text: "你好", status: "replied", createdAt: 5_000 }),
          makeMessage({ id: 2, text: "我在，有什么要做的？", createdAt: 6_000 }),
        ],
        { conversation: { id: 1, pmId: 1, title: "小林" } },
      ),
    ],
  });
}

function push(ws: FakeWebSocket, msg: WsServerMessage) {
  act(() => ws.push(msg));
}

function log() {
  return screen.getByRole("log", { name: "消息" });
}

function bubbles() {
  return within(log()).getAllByRole("article");
}

/** 等某段文字出现在消息区里（左栏预览里也会有同样的字，所以限定在消息区）。 */
async function findInLog(text: string) {
  await waitFor(() => expect(within(log()).getByText(text)).toBeInTheDocument());
}

function box() {
  return screen.getByRole("textbox", { name: "输入消息" });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("首屏", () => {
  it("左栏有项目经理和最后一条消息；点开看到消息，用户的靠右，agent 的靠左带名字", async () => {
    const user = userEvent.setup();
    await boot();
    const nav = screen.getByRole("navigation", { name: "对话列表" });
    const item = within(nav).getByRole("button", { name: /小林/ });
    expect(item).toHaveTextContent("我在，有什么要做的？");
    await user.click(item);
    const [mine, theirs] = bubbles() as [HTMLElement, HTMLElement];
    expect(mine).toHaveTextContent("你好");
    expect(mine).toHaveAttribute("data-side", "right");
    expect(theirs).toHaveTextContent("我在，有什么要做的？");
    expect(theirs).toHaveAttribute("data-side", "left");
    expect(within(theirs.closest("[data-turn]") as HTMLElement).getByText("小林")).toBeInTheDocument();
  });

  it("没有对话：显示空态", async () => {
    await boot(makeSnapshot({ pms: [], conversations: [] }));
    expect(screen.getByText("还没有对话")).toBeInTheDocument();
  });

  it("对话里还没有消息：显示空态，输入框照常能用", async () => {
    await boot(makeSnapshot({ conversations: [makeConvSnapshot([])] }));
    expect(screen.getByText("还没有消息")).toBeInTheDocument();
    expect(box()).toBeEnabled();
  });

  it("加载中显示加载状态，拿到数据后消失", async () => {
    api = new FakeApi(defaultSnapshot());
    const gate = deferred<void>();
    api.state = async () => {
      await gate.promise;
      return { status: 200, body: defaultSnapshot() };
    };
    api.install();
    installFakeWebSocket();
    render(<App />);
    expect(screen.getByText("加载中")).toBeInTheDocument();
    gate.resolve();
    await screen.findByRole("log", { name: "消息" });
    expect(screen.queryByText("加载中")).not.toBeInTheDocument();
  });

  it("拉不到数据（服务没开）：显示错误和重试，重试成功后进入首屏", async () => {
    const user = userEvent.setup();
    api = new FakeApi(defaultSnapshot());
    api.state = () => {
      throw new TypeError("Failed to fetch");
    };
    api.install();
    installFakeWebSocket();
    render(<App />);
    expect(await screen.findByText("连不上守护进程")).toBeInTheDocument();
    expect(FakeWebSocket.instances).toHaveLength(0);
    api.state = () => ({ status: 200, body: defaultSnapshot() });
    await user.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByRole("log", { name: "消息" });
    expect(screen.queryByText("连不上守护进程")).not.toBeInTheDocument();
  });

  it("服务返回 500：显示错误和重试", async () => {
    api = new FakeApi(defaultSnapshot());
    api.state = () => ({ status: 500, body: { error: "boom" } });
    api.install();
    installFakeWebSocket();
    render(<App />);
    expect(await screen.findByText("连不上守护进程")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});

describe("没登录", () => {
  it("/api/state 返回 401：提示用终端里打印的链接打开，不连 WebSocket", async () => {
    api = new FakeApi(defaultSnapshot());
    api.state = () => ({ status: 401, body: { error: "unauthorized" } });
    api.install();
    installFakeWebSocket();
    render(<App />);
    expect(await screen.findByText("请用守护进程在终端里打印的链接打开")).toBeInTheDocument();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});

describe("发送", () => {
  it("输入文字按 Enter：POST 带新的 clientId；消息马上出现，标“排队中”", async () => {
    const user = userEvent.setup();
    await boot();
    const gate = deferred<{ status: number; body: unknown }>();
    api.postMessage = () => gate.promise;
    await user.type(box(), "帮我看看进度{Enter}");
    await waitFor(() => expect(api.callsTo("POST", /messages$/)).toHaveLength(1));
    const call = api.callsTo("POST", /messages$/)[0];
    expect(call?.path).toBe("/api/conversations/1/messages");
    expect(call?.body).toEqual({ clientId: expect.stringMatching(/\S{8,}/), text: "帮我看看进度" });
    const mine = bubbles().at(-1);
    expect(mine).toHaveTextContent("帮我看看进度");
    expect(mine).toHaveAttribute("data-side", "right");
    expect(within(mine as HTMLElement).getByText("排队中")).toBeInTheDocument();
    expect(box()).toHaveValue("");
    gate.resolve({ status: 200, body: { messageId: 3 } });
  });

  it("两条消息用不同的 clientId", async () => {
    const user = userEvent.setup();
    await boot();
    await user.type(box(), "一{Enter}");
    await user.type(box(), "二{Enter}");
    await waitFor(() => expect(api.callsTo("POST", /messages$/)).toHaveLength(2));
    const [a, b] = api.callsTo("POST", /messages$/).map((c) => (c.body as { clientId: string }).clientId);
    expect(a).not.toBe(b);
  });

  it("Shift+Enter 不发送，输入框多一行", async () => {
    const user = userEvent.setup();
    await boot();
    await user.type(box(), "第一行{Shift>}{Enter}{/Shift}第二行");
    expect(box()).toHaveValue("第一行\n第二行");
    expect(api.callsTo("POST", /messages$/)).toHaveLength(0);
  });

  it("输入法选字时按 Enter 不发送", async () => {
    await boot();
    fireEvent.change(box(), { target: { value: "nihao" } });
    fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
    expect(api.callsTo("POST", /messages$/)).toHaveLength(0);
    expect(box()).toHaveValue("nihao");
  });

  it("空白文字不发送，发送按钮不可点", async () => {
    const user = userEvent.setup();
    await boot();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    await user.type(box(), "   {Enter}");
    expect(api.callsTo("POST", /messages$/)).toHaveLength(0);
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("超过 100 KB：不发送，提示太长", async () => {
    await boot();
    fireEvent.change(box(), { target: { value: "字".repeat(Math.ceil(MAX_MESSAGE_BYTES / 3) + 1) } });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getByText("消息太长")).toBeInTheDocument();
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(api.callsTo("POST", /messages$/)).toHaveLength(0);
  });

  it("点发送按钮也能发", async () => {
    const user = userEvent.setup();
    await boot();
    await user.type(box(), "你好呀");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.callsTo("POST", /messages$/)).toHaveLength(1));
  });

  it("服务端推回真消息后，临时消息被替换，不重复", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    await user.type(box(), "你好呀{Enter}");
    await waitFor(() => expect(api.callsTo("POST", /messages$/)).toHaveLength(1));
    const clientId = (api.callsTo("POST", /messages$/)[0]?.body as { clientId: string }).clientId;
    expect(bubbles()).toHaveLength(3);
    push(
      ws,
      messageChange(
        11,
        "message.created",
        makeUserMessage({ id: 3, text: "你好呀", status: "queued", dedupeKey: `client:1:${clientId}` }),
      ),
    );
    expect(bubbles()).toHaveLength(3);
    expect(within(bubbles()[2] as HTMLElement).getByText("排队中")).toBeInTheDocument();
  });

  it("真消息先于 POST 响应到达，也不重复", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    const gate = deferred<{ status: number; body: unknown }>();
    api.postMessage = () => gate.promise;
    await user.type(box(), "你好呀{Enter}");
    await waitFor(() => expect(api.callsTo("POST", /messages$/)).toHaveLength(1));
    const clientId = (api.callsTo("POST", /messages$/)[0]?.body as { clientId: string }).clientId;
    push(
      ws,
      messageChange(
        11,
        "message.created",
        makeUserMessage({ id: 3, text: "你好呀", status: "queued", dedupeKey: `client:1:${clientId}` }),
      ),
    );
    gate.resolve({ status: 200, body: { messageId: 3 } });
    await act(async () => {});
    expect(bubbles()).toHaveLength(3);
  });

  it("发送失败（500）：标“发送失败”有“重试”；重试用同一个 clientId，成功后恢复“排队中”", async () => {
    const user = userEvent.setup();
    await boot();
    api.postMessage = () => ({ status: 500, body: { error: "boom" } });
    await user.type(box(), "你好呀{Enter}");
    expect(await screen.findByText("发送失败")).toBeInTheDocument();
    api.postMessage = () => ({ status: 200, body: { messageId: 3 } });
    await user.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(api.callsTo("POST", /messages$/)).toHaveLength(2));
    const [first, second] = api.callsTo("POST", /messages$/);
    expect((second?.body as { clientId: string }).clientId).toBe((first?.body as { clientId: string }).clientId);
    await waitFor(() => expect(screen.queryByText("发送失败")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
    expect(bubbles()).toHaveLength(3);
    expect(within(bubbles()[2] as HTMLElement).getByText("排队中")).toBeInTheDocument();
  });

  it("发送时网络断了：同样标“发送失败”，可以重试", async () => {
    const user = userEvent.setup();
    await boot();
    api.postMessage = () => {
      throw new TypeError("Failed to fetch");
    };
    await user.type(box(), "你好呀{Enter}");
    expect(await screen.findByText("发送失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("重试再失败：仍然停在“发送失败”", async () => {
    const user = userEvent.setup();
    await boot();
    api.postMessage = () => ({ status: 500, body: { error: "boom" } });
    await user.type(box(), "你好呀{Enter}");
    await user.click(await screen.findByRole("button", { name: "重试" }));
    await waitFor(() => expect(api.callsTo("POST", /messages$/)).toHaveLength(2));
    expect(await screen.findByText("发送失败")).toBeInTheDocument();
    expect(bubbles()).toHaveLength(3);
  });

  it("对话不存在（404）：标“发送失败”", async () => {
    const user = userEvent.setup();
    await boot();
    api.postMessage = () => ({ status: 404, body: { error: "conversation not found" } });
    await user.type(box(), "你好呀{Enter}");
    expect(await screen.findByText("发送失败")).toBeInTheDocument();
  });

  it("每个对话各自保留没发出去的草稿", async () => {
    const user = userEvent.setup();
    await boot(
      makeSnapshot({
        pms: [makePm({ id: 1, name: "小林" }), makePm({ id: 2, name: "阿周" })],
        conversations: [
          makeConvSnapshot([makeMessage({ id: 1, createdAt: 9_000 })], { conversation: { id: 1, pmId: 1 } }),
          makeConvSnapshot([makeMessage({ id: 2, conversationId: 2, createdAt: 8_000 })], {
            conversation: { id: 2, pmId: 2 },
          }),
        ],
      }),
    );
    await user.type(box(), "写到一半");
    const nav = screen.getByRole("navigation", { name: "对话列表" });
    await user.click(within(nav).getByRole("button", { name: /阿周/ }));
    expect(box()).toHaveValue("");
    await user.click(within(nav).getByRole("button", { name: /小林/ }));
    expect(box()).toHaveValue("写到一半");
  });
});

describe("消息状态", () => {
  it("message.updated：同一条消息的标记跟着变（排队中 → 送达后不再显示），不多出新消息", async () => {
    const ws = await boot(
      makeSnapshot({
        pms: [makePm({ id: 1, name: "小林" })],
        conversations: [makeConvSnapshot([makeUserMessage({ id: 1, text: "查一下", status: "queued" })])],
      }),
    );
    const mine = () => bubbles()[0] as HTMLElement;
    expect(within(mine()).getByText("排队中")).toBeInTheDocument();
    // 已送达、处理中、已回复都不显示（docs/ui-standard.md 第 16 条）
    push(ws, messageChange(11, "message.updated", makeUserMessage({ id: 1, text: "查一下", status: "delivered" })));
    expect(mine().querySelector("[data-delivery]")).toBeNull();
    push(ws, messageChange(12, "message.updated", makeUserMessage({ id: 1, text: "查一下", status: "processing" })));
    expect(mine().querySelector("[data-delivery]")).toBeNull();
    push(ws, messageChange(13, "message.updated", makeUserMessage({ id: 1, text: "查一下", status: "replied" })));
    expect(mine().querySelector("[data-delivery]")).toBeNull();
    expect(within(log()).queryByText("已回复")).not.toBeInTheDocument();
    expect(bubbles()).toHaveLength(1);
  });

  it("已停止", async () => {
    await boot(
      makeSnapshot({
        conversations: [makeConvSnapshot([makeUserMessage({ id: 1, status: "stopped" })])],
      }),
    );
    expect(within(bubbles()[0] as HTMLElement).getByText("已停止")).toBeInTheDocument();
  });

  it("失败：一句人话，原始错误在 title；认不出来的写“出错了”", async () => {
    await boot(
      makeSnapshot({
        conversations: [
          makeConvSnapshot([
            makeUserMessage({ id: 1, status: "failed", failureReason: "claude_not_found: spawn claude ENOENT" }),
            makeUserMessage({ id: 2, status: "failed", failureReason: "某个没见过的原因" }),
          ]),
        ],
      }),
    );
    const [a, b] = bubbles() as [HTMLElement, HTMLElement];
    expect(within(a).getByText("Claude 没能启动")).toHaveAttribute("title", "claude_not_found: spawn claude ENOENT");
    expect(within(b).getByText("出错了")).toHaveAttribute("title", "某个没见过的原因");
  });

  it("message.created：agent 的新消息出现在最后", async () => {
    const ws = await boot();
    push(ws, messageChange(11, "message.created", makeMessage({ id: 3, text: "做完了" })));
    expect(bubbles().at(-1)).toHaveTextContent("做完了");
    expect(bubbles()).toHaveLength(3);
  });

  it("系统消息是靠左很淡的一行，不是气泡", async () => {
    const ws = await boot();
    push(ws, messageChange(11, "message.created", makeMessage({ id: 3, sender: "system", text: "已建工单" })));
    const notice = within(log()).getByText("已建工单").closest("[data-notice]");
    expect(notice).toHaveAttribute("data-side", "left");
    expect(notice).toHaveClass("text-xs", "text-muted-foreground");
  });

  it("别的对话的消息不出现在当前对话，但更新左栏预览", async () => {
    const ws = await boot(
      makeSnapshot({
        pms: [makePm({ id: 1, name: "小林" }), makePm({ id: 2, name: "阿周" })],
        conversations: [
          makeConvSnapshot([makeMessage({ id: 1, text: "旧消息", createdAt: 9_000 })], {
            conversation: { id: 1, pmId: 1 },
          }),
          makeConvSnapshot([makeMessage({ id: 2, conversationId: 2, text: "更旧", createdAt: 8_000 })], {
            conversation: { id: 2, pmId: 2 },
          }),
        ],
      }),
    );
    push(ws, messageChange(11, "message.created", makeMessage({ id: 3, conversationId: 2, text: "阿周的新消息" })));
    expect(within(log()).queryByText("阿周的新消息")).not.toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "对话列表" });
    expect(within(nav).getByRole("button", { name: /阿周/ })).toHaveTextContent("阿周的新消息");
  });
});

describe("操作折叠", () => {
  it("一轮里推 3 个工具调用：合成一行“Worked for …”，点开看到 3 条", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    push(ws, messageChange(11, "message.created", makeToolMessage({ id: 3, text: "Read: src/a.ts" })));
    push(ws, messageChange(12, "message.created", makeToolMessage({ id: 4, text: "Bash: pnpm test" })));
    expect(screen.getAllByRole("button", { name: /Worked for/ })).toHaveLength(1);
    push(ws, messageChange(13, "message.created", makeToolMessage({ id: 5, text: "Edit: src/b.ts" })));
    const toggle = screen.getByRole("button", { name: /Worked for/ });
    expect(screen.queryByText("Bash: pnpm test")).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Read: src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("Bash: pnpm test")).toBeInTheDocument();
    expect(screen.getByText("Edit: src/b.ts")).toBeInTheDocument();
    await user.click(toggle);
    expect(screen.queryByText("Bash: pnpm test")).not.toBeInTheDocument();
  });

  it("中间夹着文字消息：还是一行（一轮只有一行操作），文字照常显示", async () => {
    await boot(
      makeSnapshot({
        conversations: [
          makeConvSnapshot([
            makeToolMessage({ id: 1 }),
            makeToolMessage({ id: 2 }),
            makeMessage({ id: 3, text: "先看到这里" }),
            makeToolMessage({ id: 4 }),
          ]),
        ],
      }),
    );
    expect(screen.getAllByRole("button", { name: /Worked for/ })).toHaveLength(1);
    expect(within(log()).getByText("先看到这里")).toBeInTheDocument();
  });
});

describe("消息流里的状态和输入框里的停止", () => {
  it("推 session.status 为运行中：消息流里有状态，输入框的发送键变停止，点“停止”发出 POST /stop", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "状态" })).not.toBeInTheDocument();
    push(ws, sessionChange(11, makeSession({ status: "running", activity: "working", step: { type: "tool_use", name: "Bash", input: {} } })));
    const line = screen.getByRole("status", { name: "状态" });
    expect(line).toHaveTextContent("Running command");
    expect(screen.queryByRole("button", { name: "发送" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(api.callsTo("POST", /stop$/)).toHaveLength(1));
    expect(api.callsTo("POST", /stop$/)[0]?.path).toBe("/api/conversations/1/stop");
    // 真界面服务对“声明 JSON 却没有请求体”回 400，假后端照着做；停止请求要被接受
    await waitFor(() => expect(screen.getByRole("button", { name: "停止" })).toBeDisabled());
    expect(screen.queryByText("停止失败")).not.toBeInTheDocument();
  });

  it("状态条已不存在：状态只在消息列表里（这一轮最下面），输入框旁边没有", async () => {
    const ws = await boot();
    push(ws, sessionChange(11, makeSession({ status: "running", activity: "working", step: { type: "thinking" } })));
    const status = screen.getByRole("status", { name: "状态" });
    expect(log()).toContainElement(status);
    expect(status.closest("[data-work-line]")).not.toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(box().closest("div[class*='max-w-[888px]']")).not.toContainElement(status);
  });

  it("忙时输入框有字：发送键（发出去照常排队）；清空又是停止", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    push(ws, sessionChange(11, makeSession({ status: "running", activity: "working" })));
    await user.type(box(), "补一句");
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.callsTo("POST", /messages$/)).toHaveLength(1));
    expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();
  });

  it("agent 这一轮还没出回复：消息列表底部先出“头像 名字”和一行状态，这一轮结束就消失", async () => {
    const ws = await boot(makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      conversations: [makeConvSnapshot([makeUserMessage({ id: 1, text: "查一下", status: "processing", createdAt: 5_000 })], { conversation: { id: 1, pmId: 1, title: "小林" } })],
    }));
    push(ws, sessionChange(11, makeSession({ status: "running", activity: "working", step: { type: "thinking" } })));
    const turn = within(log()).getByRole("status", { name: "状态" }).closest("[data-turn]") as HTMLElement;
    expect(turn.querySelector("[data-slot='agent-head']")).toHaveTextContent(/^小林$/);
    expect(screen.getByRole("status", { name: "状态" })).toHaveTextContent("Thinking");
    push(ws, sessionChange(12, makeSession({ status: "running", activity: "working", step: { type: "tool_use", name: "Skill", input: { skill: "frontend-rules" } } })));
    expect(screen.getByRole("status", { name: "状态" })).toHaveTextContent("Loading skill frontend-rules");
    push(ws, messageChange(13, "message.created", makeMessage({ id: 2, text: "好的", createdAt: 6_000 })));
    expect(within(log()).getByText("好的").closest("[data-turn]")).toContainElement(screen.getByRole("status", { name: "状态" }));
    push(ws, sessionChange(14, makeSession({ status: "running", activity: "idle" })));
    expect(screen.queryByRole("status", { name: "状态" })).not.toBeInTheDocument();
  });

  it("没有 step（老服务端）时只写“Working”", async () => {
    const ws = await boot();
    push(ws, sessionChange(11, makeSession({ status: "running", activity: "working" })));
    expect(screen.getByRole("status", { name: "状态" })).toHaveTextContent("Working");
  });

  it("首屏就在干活：消息流里的状态和停止按钮直接有", async () => {
    await boot(makeSnapshot({ conversations: [makeConvSnapshot([])], sessions: [makeSession({ activity: "working" })] }));
    expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();
  });

  it("正在停：显示“Stopping”，停止按钮不可点", async () => {
    const ws = await boot();
    push(ws, sessionChange(11, makeSession({ status: "running", activity: "stopping" })));
    expect(screen.getByRole("status", { name: "状态" })).toHaveTextContent("Stopping");
    expect(screen.getByRole("button", { name: "停止" })).toBeDisabled();
  });

  it("点停止后到服务端确认前，按钮不能再点第二次", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    const gate = deferred<{ status: number }>();
    api.stop = () => gate.promise;
    push(ws, sessionChange(11, makeSession({ status: "running", activity: "working" })));
    await user.click(screen.getByRole("button", { name: "停止" }));
    expect(screen.getByRole("button", { name: "停止" })).toBeDisabled();
    gate.resolve({ status: 202 });
    await act(async () => {});
    expect(api.callsTo("POST", /stop$/)).toHaveLength(1);
  });

  it("停止失败：提示“停止失败”，按钮恢复可点", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    api.stop = () => ({ status: 500, body: { error: "boom" } });
    push(ws, sessionChange(11, makeSession({ status: "running", activity: "working" })));
    await user.click(screen.getByRole("button", { name: "停止" }));
    expect(await screen.findByText("停止失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "停止" })).toBeEnabled();
  });

  it("回到空闲：状态没有了，停止键变回发送键", async () => {
    const ws = await boot();
    push(ws, sessionChange(11, makeSession({ status: "running", activity: "working" })));
    push(ws, sessionChange(12, makeSession({ status: "idle", activity: "idle" })));
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "状态" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
  });

  it("别的对话的会话状态不影响当前对话", async () => {
    const ws = await boot();
    push(ws, sessionChange(11, makeSession({ sessionId: 7, conversationId: 99, activity: "working" })));
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
  });
});

describe("网络出错重试", () => {
  const retrying = (attempt: number, over: Partial<NonNullable<ReturnType<typeof makeSession>["apiRetry"]>> = {}) =>
    makeSession({
      status: "running",
      activity: "working",
      apiRetry: { attempt, maxRetries: 10, retryAt: Date.now() + 30_000, errorStatus: null, error: "unknown", ...over },
    });
  const statusLine = () => screen.getByRole("status", { name: "状态" });

  it("session.status 带重试信息：状态行写“Retrying 3/10”和倒计时，停止照常能点", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    push(ws, sessionChange(11, retrying(3)));
    expect(statusLine()).toHaveTextContent("Retrying 3/10");
    expect(statusLine()).toHaveTextContent(/in \d+s/);
    expect(statusLine()).not.toHaveTextContent("Working");
    await user.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(api.callsTo("POST", /stop$/)).toHaveLength(1));
  });

  it("连续几条：显示最新的一次；清掉后回到“Working”", async () => {
    const ws = await boot();
    push(ws, sessionChange(11, retrying(3)));
    push(ws, sessionChange(12, retrying(4)));
    expect(statusLine()).toHaveTextContent("Retrying 4/10");
    expect(statusLine()).not.toHaveTextContent("3/10");
    push(ws, sessionChange(13, makeSession({ status: "running", activity: "working", apiRetry: null })));
    expect(statusLine()).toHaveTextContent("Working");
    expect(statusLine()).not.toHaveTextContent("Retrying");
  });

  it("下次重试时间点没有（null）：只写第几次，不写倒计时", async () => {
    const ws = await boot();
    push(ws, sessionChange(11, retrying(2, { retryAt: null })));
    expect(statusLine()).toHaveTextContent("Retrying 2/10");
    expect(statusLine()).not.toHaveTextContent(/in \d+s/);
  });

  it("老服务端（会话状态里没有 apiRetry、step 这些字段）：照常显示“Working”", async () => {
    const ws = await boot();
    const old: Partial<ReturnType<typeof makeSession>> = makeSession({ status: "running", activity: "working", currentTool: "Bash" });
    delete old.apiRetry;
    delete old.step;
    push(ws, sessionChange(11, old as ReturnType<typeof makeSession>));
    expect(statusLine()).toHaveTextContent("Working");
    expect(statusLine()).not.toHaveTextContent("Retrying");
  });

  it("点了停止（正在停止）：显示“Stopping”，不再写重试", async () => {
    const ws = await boot();
    push(ws, sessionChange(11, { ...retrying(3), activity: "stopping" }));
    expect(statusLine()).toHaveTextContent("Stopping");
    expect(statusLine()).not.toHaveTextContent("Retrying");
  });

  it("重试用完这一轮以出错结束：用户消息写一句人话（原文在 title），还有“重试”按钮；状态没有了", async () => {
    const ws = await boot();
    push(ws, sessionChange(11, retrying(10)));
    push(ws, messageChange(12, "message.created", makeUserMessage({ id: 3, text: "查一下", status: "processing", createdAt: 7_000 })));
    push(
      ws,
      messageChange(
        13,
        "message.updated",
        makeUserMessage({ id: 3, text: "查一下", status: "failed", failureReason: "API Error: Unable to connect to API (ConnectionRefused)", createdAt: 7_000 }),
      ),
    );
    push(ws, sessionChange(14, makeSession({ status: "running", activity: "idle", apiRetry: null })));
    const article = within(log()).getByText("查一下").closest("article")!;
    expect(article).toHaveAttribute("data-status", "failed");
    expect(within(article).getByText("网络断了，稍后重试")).toHaveAttribute("title", "API Error: Unable to connect to API (ConnectionRefused)");
    expect(within(article).getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "状态" })).not.toBeInTheDocument();
  });
});

describe("等额度", () => {
  it("额度状态不是 allowed：状态写“Usage limit reached”", async () => {
    const ws = await boot();
    push(
      ws,
      sessionChange(
        11,
        makeSession({
          status: "running",
          activity: "working",
          rateLimit: { status: "rejected", resetsAt: 1_900_000_000, windows: {} },
        }),
      ),
    );
    expect(screen.getByRole("status", { name: "状态" })).toHaveTextContent("Usage limit reached");
  });

  it("额度状态是 allowed：不显示“Usage limit reached”", async () => {
    const ws = await boot();
    push(
      ws,
      sessionChange(
        11,
        makeSession({
          status: "running",
          activity: "working",
          rateLimit: { status: "allowed", resetsAt: null, windows: {} },
        }),
      ),
    );
    expect(screen.queryByText(/Usage limit/)).not.toBeInTheDocument();
  });

  it("空闲时额度不够也显示“Usage limit reached”（下一条发出去会卡住）", async () => {
    await boot(
      makeSnapshot({
        sessions: [makeSession({ rateLimit: { status: "rejected", resetsAt: null, windows: {} } })],
      }),
    );
    expect(screen.getByRole("status", { name: "状态" })).toHaveTextContent("Usage limit reached");
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
  });
});

describe("断线重连", () => {
  it("WebSocket 断开显示“重连中”；重连带上最后的 seq；补齐后没有重复消息", async () => {
    const ws = await boot();
    expect(ws.since).toBe(10);
    push(ws, messageChange(11, "message.created", makeMessage({ id: 3, text: "第三条" })));
    push(ws, messageChange(12, "message.created", makeMessage({ id: 4, text: "第四条" })));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => ws.drop());
    expect(screen.getByText("重连中")).toBeInTheDocument();
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    vi.useRealTimers();
    expect(FakeWebSocket.instances).toHaveLength(2);
    const next = FakeWebSocket.last;
    expect(next.since).toBe(12);
    expect(screen.getByText("重连中")).toBeInTheDocument();
    act(() => next.open());
    expect(screen.queryByText("重连中")).not.toBeInTheDocument();
    // 补齐：服务端重发 12（已经有了）再给新的 13
    push(next, messageChange(12, "message.created", makeMessage({ id: 4, text: "第四条" })));
    push(next, messageChange(13, "message.created", makeMessage({ id: 5, text: "第五条" })));
    expect(within(log()).getAllByText("第四条")).toHaveLength(1);
    expect(within(log()).getAllByText("第五条")).toHaveLength(1);
    expect(bubbles()).toHaveLength(5);
  });

  it("重连一直连不上：继续重试，间隔变长但有上限", async () => {
    const ws = await boot();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => ws.drop());
    for (let i = 0; i < 8; i++) {
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      act(() => FakeWebSocket.last.drop());
    }
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(9);
    expect(screen.getByText("重连中")).toBeInTheDocument();
    // 间隔有上限：再等 10 秒一定有新的连接
    const before = FakeWebSocket.instances.length;
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(FakeWebSocket.instances.length).toBe(before + 1);
    vi.useRealTimers();
  });

  it("重连后服务端推 resync：重新拉 /api/state", async () => {
    const ws = await boot();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => ws.drop());
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    vi.useRealTimers();
    const next = FakeWebSocket.last;
    act(() => next.open());
    api.state = () => ({
      status: 200,
      body: makeSnapshot({
        seq: 500,
        pms: [makePm({ id: 1, name: "小林" })],
        conversations: [makeConvSnapshot([makeMessage({ id: 9, text: "守护进程重启后的消息" })])],
      }),
    });
    push(next, { type: "resync" });
    await findInLog("守护进程重启后的消息");
  });

  it("组件卸载时关掉 WebSocket，不再重连", async () => {
    const ws = await boot();
    unmountApp();
    expect(ws.closedByClient).toBe(true);
  });
});

describe("补不齐", () => {
  it("推 resync：重新拉 /api/state，界面和新数据一致，不残留旧消息", async () => {
    const ws = await boot();
    expect(api.callsTo("GET", /state$/)).toHaveLength(1);
    api.state = () => ({
      status: 200,
      body: makeSnapshot({
        seq: 50,
        pms: [makePm({ id: 1, name: "小林" })],
        conversations: [
          makeConvSnapshot([
            makeUserMessage({ id: 1, text: "你好", status: "replied" }),
            makeMessage({ id: 5, text: "新来的回复" }),
          ]),
        ],
      }),
    });
    push(ws, { type: "resync" });
    await findInLog("新来的回复");
    expect(api.callsTo("GET", /state$/)).toHaveLength(2);
    expect(within(log()).queryByText("我在，有什么要做的？")).not.toBeInTheDocument();
    expect(bubbles()).toHaveLength(2);
  });

  it("resync 之后收到的变化 seq 以新快照为准：旧的丢掉，新的接上", async () => {
    const ws = await boot();
    api.state = () => ({
      status: 200,
      body: makeSnapshot({ seq: 50, conversations: [makeConvSnapshot([makeMessage({ id: 5, text: "快照里的" })])] }),
    });
    push(ws, { type: "resync" });
    await findInLog("快照里的");
    push(ws, messageChange(49, "message.created", makeMessage({ id: 6, text: "比快照旧的" })));
    push(ws, messageChange(51, "message.created", makeMessage({ id: 7, text: "快照之后的" })));
    expect(within(log()).queryByText("比快照旧的")).not.toBeInTheDocument();
    expect(within(log()).getByText("快照之后的")).toBeInTheDocument();
  });

  it("拉快照期间到的变化先存着，快照之后的补上", async () => {
    const ws = await boot();
    const gate = deferred<{ status: number; body: unknown }>();
    api.state = () => gate.promise;
    push(ws, { type: "resync" });
    push(ws, messageChange(52, "message.created", makeMessage({ id: 7, text: "拉的时候到的" })));
    push(ws, messageChange(40, "message.created", makeMessage({ id: 6, text: "已经包含在快照里" })));
    gate.resolve({
      status: 200,
      body: makeSnapshot({
        seq: 50,
        conversations: [makeConvSnapshot([makeMessage({ id: 6, text: "已经包含在快照里" })])],
      }),
    });
    await findInLog("拉的时候到的");
    expect(within(log()).getAllByText("已经包含在快照里")).toHaveLength(1);
  });

  it("resync 时拉快照失败：显示“重连中”，之后重试成功恢复", async () => {
    const ws = await boot();
    api.state = () => ({ status: 500, body: { error: "boom" } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    push(ws, { type: "resync" });
    await act(async () => {});
    expect(screen.getByText("重连中")).toBeInTheDocument();
    api.state = () => ({
      status: 200,
      body: makeSnapshot({ seq: 60, conversations: [makeConvSnapshot([makeMessage({ id: 8, text: "恢复了" })])] }),
    });
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    vi.useRealTimers();
    await findInLog("恢复了");
    expect(screen.queryByText("重连中")).not.toBeInTheDocument();
  });

  it("resync 时 /api/state 返回 401：提示重新打开链接", async () => {
    const ws = await boot();
    api.state = () => ({ status: 401, body: { error: "unauthorized" } });
    push(ws, { type: "resync" });
    expect(await screen.findByText("请用守护进程在终端里打印的链接打开")).toBeInTheDocument();
  });

  it("收到不认识的对话里的消息：重新拉快照", async () => {
    const ws = await boot();
    api.state = () => ({
      status: 200,
      body: makeSnapshot({
        seq: 20,
        pms: [makePm({ id: 1, name: "小林" }), makePm({ id: 2, name: "阿周" })],
        conversations: [
          makeConvSnapshot([makeMessage({ id: 1 })], { conversation: { id: 1, pmId: 1 } }),
          makeConvSnapshot([makeMessage({ id: 9, conversationId: 2 })], { conversation: { id: 2, pmId: 2 } }),
        ],
      }),
    });
    push(ws, messageChange(11, "message.created", makeMessage({ id: 9, conversationId: 2 })));
    const nav = screen.getByRole("navigation", { name: "对话列表" });
    expect(await within(nav).findByRole("button", { name: /阿周/ })).toBeInTheDocument();
  });

  it("忽略坏的 WebSocket 消息", async () => {
    const ws = await boot();
    act(() => ws.push("不是 JSON"));
    act(() => ws.push(JSON.stringify({ type: "什么都不是" })));
    expect(bubbles()).toHaveLength(2);
  });
});

describe("health", () => {
  it("快照里带着找不到 claude：界面显示", async () => {
    await boot(
      makeSnapshot({
        health: [makeHealth({ module: "driver", consecutiveFailures: 1, lastError: "claude_not_found: spawn claude ENOENT" })],
      }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("找不到 claude");
  });

  it("health.updated 实时显示；成功一次清空后消失", async () => {
    const ws = await boot();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    push(
      ws,
      healthChange(11, makeHealth({ consecutiveFailures: 1, lastError: "claude_not_found: spawn claude ENOENT" })),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("找不到 claude");
    push(ws, healthChange(12, makeHealth({ consecutiveFailures: 0, lastError: null })));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("连续失败达到 3 次标红，没到只是提醒", async () => {
    const ws = await boot();
    push(ws, healthChange(11, makeHealth({ consecutiveFailures: 1, lastError: "spawn_failed: EACCES" })));
    expect(screen.getByRole("alert")).toHaveAttribute("data-severity", "warn");
    push(ws, healthChange(12, makeHealth({ consecutiveFailures: 3, lastError: "spawn_failed: EACCES" })));
    expect(screen.getByRole("alert")).toHaveAttribute("data-severity", "error");
  });

  it("不认识的错误：原样显示；多个模块各占一行", async () => {
    const ws = await boot();
    push(ws, healthChange(11, makeHealth({ module: "store", consecutiveFailures: 1, lastError: "disk full" })));
    push(ws, healthChange(12, makeHealth({ module: "driver", consecutiveFailures: 1, lastError: "start_timeout: 60s" })));
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(2);
    expect(screen.getByText("disk full")).toBeInTheDocument();
    expect(screen.getByText("claude 启动超时")).toBeInTheDocument();
  });
});

describe("往上滚加载更早的消息", () => {
  function pagedSnapshot() {
    return makeSnapshot({
      conversations: [
        makeConvSnapshot([makeMessage({ id: 101, text: "第 101 条" }), makeMessage({ id: 102, text: "第 102 条" })], {
          hasMore: true,
        }),
      ],
    });
  }
  const older = (ids: number[], hasMore: boolean) => ({
    status: 200,
    body: { messages: ids.map((id) => makeMessage({ id, text: `第 ${id} 条` })), hasMore },
  });

  it("滚到顶：带 before=最早一条的编号请求，更早的消息接在前面，顺序对", async () => {
    await boot(pagedSnapshot());
    api.older = () => older([99, 100], false);
    fireEvent.scroll(log(), { target: { scrollTop: 0 } });
    expect(await screen.findByText("第 99 条")).toBeInTheDocument();
    const call = api.callsTo("GET", /messages$/)[0];
    expect(call?.path).toBe("/api/conversations/1/messages");
    expect(call?.query.get("before")).toBe("101");
    expect(bubbles().map((b) => b.textContent)).toEqual([
      expect.stringContaining("第 99 条"),
      expect.stringContaining("第 100 条"),
      expect.stringContaining("第 101 条"),
      expect.stringContaining("第 102 条"),
    ]);
    // 没有更多了：不再请求，按钮消失
    expect(screen.queryByRole("button", { name: "加载更早的消息" })).not.toBeInTheDocument();
    fireEvent.scroll(log(), { target: { scrollTop: 0 } });
    expect(api.callsTo("GET", /messages$/)).toHaveLength(1);
  });

  it("也可以点“加载更早的消息”", async () => {
    const user = userEvent.setup();
    await boot(pagedSnapshot());
    api.older = () => older([100], true);
    await user.click(screen.getByRole("button", { name: "加载更早的消息" }));
    expect(await screen.findByText("第 100 条")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "加载更早的消息" })).toBeInTheDocument();
  });

  it("加载过程中重复滚动只发一次请求", async () => {
    await boot(pagedSnapshot());
    const gate = deferred<{ status: number; body: unknown }>();
    api.older = () => gate.promise;
    fireEvent.scroll(log(), { target: { scrollTop: 0 } });
    fireEvent.scroll(log(), { target: { scrollTop: 0 } });
    fireEvent.scroll(log(), { target: { scrollTop: 0 } });
    expect(api.callsTo("GET", /messages$/)).toHaveLength(1);
    gate.resolve(older([100], false));
    await screen.findByText("第 100 条");
  });

  it("加载失败：显示“加载失败”，点重试成功", async () => {
    const user = userEvent.setup();
    await boot(pagedSnapshot());
    api.older = () => ({ status: 500, body: { error: "boom" } });
    fireEvent.scroll(log(), { target: { scrollTop: 0 } });
    const retry = await screen.findByRole("button", { name: "加载失败，点击重试" });
    api.older = () => older([100], false);
    await user.click(retry);
    expect(await screen.findByText("第 100 条")).toBeInTheDocument();
  });

  it("没有更早的消息时，滚到顶不请求", async () => {
    await boot();
    fireEvent.scroll(log(), { target: { scrollTop: 0 } });
    expect(api.callsTo("GET", /messages$/)).toHaveLength(0);
  });

  it("加载更早的消息后保持原来的滚动位置", async () => {
    const heights = { value: 500 };
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => heights.value);
    await boot(pagedSnapshot());
    api.older = () => {
      heights.value = 900;
      return older([99, 100], false);
    };
    log().scrollTop = 0;
    fireEvent.scroll(log());
    await screen.findByText("第 99 条");
    expect(log().scrollTop).toBe(400);
  });
});

describe("自动滚到底", () => {
  function mockLayout(scrollHeight: number, clientHeight: number) {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => scrollHeight);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => clientHeight);
  }

  it("打开对话时滚到底", async () => {
    mockLayout(1000, 400);
    await boot();
    expect(log().scrollTop).toBe(1000);
  });

  it("在底部附近时来新消息：跟着滚到底", async () => {
    mockLayout(1000, 400);
    const ws = await boot();
    log().scrollTop = 580; // 离底部 20px
    fireEvent.scroll(log());
    mockLayout(1200, 400);
    push(ws, messageChange(11, "message.created", makeMessage({ id: 3 })));
    expect(log().scrollTop).toBe(1200);
  });

  it("用户往上翻看历史时来新消息：不抢滚动位置，出现“回到底部”，点了回到底部", async () => {
    const user = userEvent.setup();
    mockLayout(1000, 400);
    const ws = await boot();
    log().scrollTop = 100;
    fireEvent.scroll(log());
    mockLayout(1200, 400);
    push(ws, messageChange(11, "message.created", makeMessage({ id: 3 })));
    expect(log().scrollTop).toBe(100);
    await user.click(screen.getByRole("button", { name: "回到底部" }));
    expect(log().scrollTop).toBe(1200);
    expect(screen.queryByRole("button", { name: "回到底部" })).not.toBeInTheDocument();
  });

  it("自己发消息时一定滚到底，即使正在往上翻", async () => {
    const user = userEvent.setup();
    mockLayout(1000, 400);
    await boot();
    log().scrollTop = 100;
    fireEvent.scroll(log());
    mockLayout(1100, 400);
    await user.type(box(), "我发一条{Enter}");
    expect(log().scrollTop).toBe(1100);
  });
});

describe("多个对话", () => {
  it("左栏按最后一条消息的时间排序，点哪个就看哪个", async () => {
    const user = userEvent.setup();
    await boot(
      makeSnapshot({
        pms: [makePm({ id: 1, name: "小林" }), makePm({ id: 2, name: "阿周" })],
        conversations: [
          makeConvSnapshot([makeMessage({ id: 1, text: "小林的消息", createdAt: 5_000 })], {
            conversation: { id: 1, pmId: 1 },
          }),
          makeConvSnapshot([makeMessage({ id: 2, conversationId: 2, text: "阿周的消息", createdAt: 9_000 })], {
            conversation: { id: 2, pmId: 2 },
          }),
        ],
      }),
    );
    const nav = screen.getByRole("navigation", { name: "对话列表" });
    const items = within(nav).getAllByRole("button");
    expect(items[0]).toHaveTextContent("阿周");
    expect(items[1]).toHaveTextContent("小林");
    expect(within(log()).getByText("阿周的消息")).toBeInTheDocument();
    await user.click(items[1] as HTMLElement);
    expect(within(log()).getByText("小林的消息")).toBeInTheDocument();
    expect(within(log()).queryByText("阿周的消息")).not.toBeInTheDocument();
  });

  it("对话列表预览跳过工具调用，显示最后一条文字", async () => {
    await boot(
      makeSnapshot({
        conversations: [
          makeConvSnapshot([makeMessage({ id: 1, text: "最后的话" }), makeToolMessage({ id: 2, text: "Bash: ls" })]),
        ],
      }),
    );
    const nav = screen.getByRole("navigation", { name: "对话列表" });
    expect(within(nav).getByRole("button")).toHaveTextContent("最后的话");
    expect(within(nav).getByRole("button")).not.toHaveTextContent("Bash: ls");
  });

  it("没有对应项目经理的对话用对话标题", async () => {
    await boot(
      makeSnapshot({
        pms: [],
        conversations: [makeConvSnapshot([], { conversation: { id: 3, kind: "assistant", pmId: null, title: "总助" } })],
      }),
    );
    const nav = screen.getByRole("navigation", { name: "对话列表" });
    expect(within(nav).getByRole("button")).toHaveTextContent("总助");
  });
});
