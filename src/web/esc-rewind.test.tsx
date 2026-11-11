// 聊天界面 Esc 暂停与再按一次 Esc 回退到输入框（对标 Claude Code 手感）：
// 覆盖第一次 Esc 暂停、补全菜单 / 弹窗 / IME / 其他输入框冲突保护、第二次 Esc 恢复文字与 workerPick 并聚焦光标到末尾、
// 多次连按幂等、草稿保护、Agent 半截步骤保留，以及项目经理与 Worker 对话、全部 6 家厂商一致生效。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VENDOR_LIST, type StateSnapshot, type WorkerPick, type WsServerMessage } from "../shared/index.ts";
import { App } from "./App.tsx";
import {
  FakeApi,
  FakeWebSocket,
  installFakeWebSocket,
  makeAttachment,
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
let unmountApp: (() => void) | undefined;

async function boot(snapshot: StateSnapshot = defaultSnapshot()) {
  unmountApp?.();
  window.location.hash = "";
  api = new FakeApi(snapshot);
  api.install();
  installFakeWebSocket();
  unmountApp = render(<App />).unmount;
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  act(() => FakeWebSocket.last.open());
  await screen.findByRole("log", { name: "Messages" });
  return FakeWebSocket.last;
}

function defaultSnapshot(): StateSnapshot {
  return makeSnapshot({
    pms: [makePm({ id: 1, name: "小林" })],
    conversations: [
      makeConvSnapshot(
        [
          makeUserMessage({ id: 1, text: "早安", status: "replied", createdAt: 5_000 }),
          makeMessage({ id: 2, text: "早，要做什么？", createdAt: 6_000 }),
        ],
        { conversation: { id: 1, pmId: 1, title: "小林" } },
      ),
    ],
    sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1, status: "running", activity: "idle" })],
  });
}

const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const log = () => screen.getByRole("log", { name: "Messages" });
const push = (ws: FakeWebSocket, msg: WsServerMessage) => act(() => ws.push(msg));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  unmountApp?.();
  unmountApp = undefined;
  window.location.hash = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("第一次 Esc 暂停", () => {
  it("Agent 正在思考或执行时：焦点在输入框内或页面其他位置按 Esc 都立即发出 POST /stop，且保留输入框新打的草稿", async () => {
    const user = userEvent.setup();
    const ws = await boot();

    // 焦点在输入框内，且正在打半句草稿
    push(ws, sessionChange(11, makeSession({ status: "running", activity: "working", step: { type: "thinking" } })));
    await user.type(box(), "等下补一句");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(api.callsTo("POST", /\/conversations\/1\/stop$/)).toHaveLength(1));
    expect(box().value).toBe("等下补一句");

    // 停完再来一轮，这次焦点不在输入框（点过消息区）
    push(ws, sessionChange(12, makeSession({ status: "running", activity: "idle" })));
    push(ws, sessionChange(13, makeSession({ status: "running", activity: "working" })));
    box().blur();
    expect(document.activeElement).not.toBe(box());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(api.callsTo("POST", /\/conversations\/1\/stop$/)).toHaveLength(2));
  });

  it("消息刚发出正在排队（status=queued）且会话尚未转成 working 时，按第一次 Esc 也能立即停止取消", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    push(ws, messageChange(11, "message.created", makeUserMessage({ id: 3, text: "排队中的问题", status: "queued", createdAt: 7_000 })));

    await user.keyboard("{Escape}");
    await waitFor(() => expect(api.callsTo("POST", /\/conversations\/1\/stop$/)).toHaveLength(1));
  });
});

describe("按键冲突优先级守卫（不误触）", () => {
  it("/ 补全菜单打开时按 Esc 只关菜单、不动文字也不暂停；再按一次才暂停", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    push(ws, sessionChange(11, makeSession({ status: "running", activity: "working" })));

    await user.type(box(), "/hub");
    expect(await screen.findByRole("listbox")).toBeInTheDocument();

    // 第一次按 Esc：只关补全菜单，不发 stop，输入框文字原样留着
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(box().value).toBe("/hub");
    expect(api.callsTo("POST", /\/stop$/)).toHaveLength(0);

    // 菜单已经关了，再按 Esc 才触发暂停
    await user.keyboard("{Escape}");
    await waitFor(() => expect(api.callsTo("POST", /\/conversations\/1\/stop$/)).toHaveLength(1));
    expect(box().value).toBe("/hub");
  });

  it("输入法正在选字（isComposing / keyCode 229）、长按连发（repeat）或带修饰键时忽略 Esc", async () => {
    const ws = await boot();
    push(ws, sessionChange(11, makeSession({ status: "running", activity: "working" })));

    fireEvent.keyDown(box(), { key: "Escape", isComposing: true });
    fireEvent.keyDown(box(), { key: "Escape", keyCode: 229 });
    fireEvent.keyDown(box(), { key: "Escape", repeat: true });
    fireEvent.keyDown(box(), { key: "Escape", shiftKey: true });
    fireEvent.keyDown(box(), { key: "Escape", metaKey: true });
    expect(api.callsTo("POST", /\/stop$/)).toHaveLength(0);
  });

  it("弹窗（Dialog）打开或焦点在左栏搜索框时，按 Esc 只处理弹层/搜索框，绝不误暂停或回退底层对话", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    push(ws, messageChange(11, "message.created", makeUserMessage({ id: 3, text: "正在跑的请求", status: "processing", createdAt: 7_000 })));
    push(ws, sessionChange(12, makeSession({ status: "running", activity: "working" })));

    // 打开设置弹窗 -> 按 Esc 只关弹窗，不暂停对话
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.callsTo("POST", /\/stop$/)).toHaveLength(0);

    // 聚焦左栏搜索框（两个以上对话时出现搜索框）
    push(ws, { seq: 13, type: "pm.created", data: { pm: makePm({ id: 2, name: "老马" }) } });
    push(ws, { seq: 14, type: "conversation.created", data: { conversation: { id: 2, kind: "pm", pmId: 2, projectId: null, title: "老马", createdAt: 8_000 } } });
    const search = await screen.findByRole("searchbox");
    await user.click(search);
    await user.keyboard("{Escape}");
    expect(api.callsTo("POST", /\/stop$/)).toHaveLength(0);
  });
});

describe("第二次 Esc 回退内容到输入框", () => {
  it("带文字与 workerPick 的消息：第一次 Esc 暂停，停下后第二次 Esc 恢复文字与 workerPick 标签、聚焦光标到末尾，气泡收起且左栏预览还原", async () => {
    const user = userEvent.setup();
    const pick: WorkerPick = { vendor: "codex", model: "gpt-5.4", effort: "high" };
    const ws = await boot();

    // 模拟用户刚发出一条带 workerPick 的消息，Agent 正在处理
    push(
      ws,
      messageChange(
        11,
        "message.created",
        makeUserMessage({ id: 3, text: "把鉴权逻辑抽成中间件", status: "processing", meta: { workerPick: pick }, createdAt: 7_000 }),
      ),
    );
    push(ws, sessionChange(12, makeSession({ status: "running", activity: "working" })));
    const nav = screen.getByRole("navigation", { name: "Conversations" });
    expect(within(nav).getByRole("button", { name: /小林/ })).toHaveTextContent("把鉴权逻辑抽成中间件");

    // 焦点故意离开输入框，验证第二次 Esc 会主动聚焦回输入框并把光标放到末尾
    box().blur();

    // 第一次 Esc：暂停
    await user.keyboard("{Escape}");
    await waitFor(() => expect(api.callsTo("POST", /\/conversations\/1\/stop$/)).toHaveLength(1));
    push(
      ws,
      messageChange(
        13,
        "message.updated",
        makeUserMessage({ id: 3, text: "把鉴权逻辑抽成中间件", status: "stopped", meta: { workerPick: pick, deliveryConfirmed: true }, createdAt: 7_000 }),
      ),
    );
    push(ws, sessionChange(14, makeSession({ status: "running", activity: "idle" })));

    // 第二次 Esc：文字和 workerPick 都回到输入框，光标在末尾，气泡消失，左栏预览回到上一句
    await user.keyboard("{Escape}");
    expect(box().value).toBe("把鉴权逻辑抽成中间件");
    expect(document.activeElement).toBe(box());
    expect(box().selectionStart).toBe("把鉴权逻辑抽成中间件".length);
    expect(box().selectionEnd).toBe("把鉴权逻辑抽成中间件".length);
    expect(screen.getByRole("button", { name: /^Worker model:/ })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Worker model" })).not.toBeInTheDocument();
    expect(within(log()).queryByText("把鉴权逻辑抽成中间件")).not.toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: /小林/ })).toHaveTextContent("早，要做什么？");
    await waitFor(() => expect(api.callsTo("POST", /\/conversations\/1\/rewind$/)).toHaveLength(1));
  });

  it("在正在停止（stopping）期间不等服务端停稳就紧按第二次 Esc：立即回退并收起气泡，后续 stopped 推送不反扑", async () => {
    const user = userEvent.setup();
    const ws = await boot();

    await user.type(box(), "帮我跑全量测试{Enter}");
    await waitFor(() => expect(api.callsTo("POST", /\/conversations\/1\/messages$/)).toHaveLength(1));
    const clientId = (api.callsTo("POST", /\/conversations\/1\/messages$/)[0]!.body as { clientId: string }).clientId;
    push(ws, messageChange(11, "message.created", makeUserMessage({ id: 3, text: "帮我跑全量测试", status: "processing", dedupeKey: `client:1:${clientId}`, createdAt: 7_000 })));
    push(ws, sessionChange(12, makeSession({ status: "running", activity: "working" })));

    // 连按两次 Esc（服务端还没回 stopped，仍在 stopping）
    await user.keyboard("{Escape}");
    await user.keyboard("{Escape}");

    expect(box().value).toBe("帮我跑全量测试");
    expect(box().selectionStart).toBe("帮我跑全量测试".length);
    expect(within(log()).queryByText("帮我跑全量测试")).not.toBeInTheDocument();

    // 随后服务端才把旧的 stopped 事件推过来（甚至还没带上 rewound）：气泡也不能重新冒出来
    push(ws, messageChange(13, "message.updated", makeUserMessage({ id: 3, text: "帮我跑全量测试", status: "stopped", dedupeKey: `client:1:${clientId}`, createdAt: 7_000 })));
    push(ws, sessionChange(14, makeSession({ status: "running", activity: "idle" })));
    expect(within(log()).queryByText("帮我跑全量测试")).not.toBeInTheDocument();
  });

  it("乐观待发（POST /messages 尚在路上、服务端未推回 message.created）时连按两次 Esc：立即撤回临时气泡并恢复文字，入库返回后补发 rewind 且不闪现", async () => {
    const user = userEvent.setup();
    const ws = await boot();

    let resolvePost!: (reply: { status: number; body: unknown }) => void;
    api.postMessage = () =>
      new Promise((resolve) => {
        resolvePost = resolve;
      });

    await user.type(box(), "慢网刚发出的话{Enter}");
    expect(box().value).toBe("");
    expect(within(log()).getByText("慢网刚发出的话")).toBeInTheDocument();

    // POST /messages 还没返回，连按两次 Esc：第一次发 stop，第二次立即把乐观气泡退回输入框
    await user.keyboard("{Escape}");
    await waitFor(() => expect(api.callsTo("POST", /\/conversations\/1\/stop$/)).toHaveLength(1));
    await user.keyboard("{Escape}");
    expect(box().value).toBe("慢网刚发出的话");
    expect(within(log()).queryByText("慢网刚发出的话")).not.toBeInTheDocument();

    // 之后慢网的 POST /messages 才返回，并且 WS 推来尚未带 rewound 的 message.created：自动补发 rewind，气泡绝不闪现
    const clientId = (api.callsTo("POST", /\/conversations\/1\/messages$/)[0]!.body as { clientId: string }).clientId;
    await act(async () => {
      resolvePost({ status: 200, body: { messageId: 99 } });
    });
    await waitFor(() => expect(api.callsTo("POST", /\/conversations\/1\/rewind$/)).toHaveLength(2));
    push(ws, messageChange(11, "message.created", makeUserMessage({ id: 99, text: "慢网刚发出的话", status: "cancelled", dedupeKey: `client:1:${clientId}`, createdAt: 7_000 })));
    expect(within(log()).queryByText("慢网刚发出的话")).not.toBeInTheDocument();
  });

  it("幂等性：回退一次后继续连按第 3、4、5 次 Esc，不会重复塞入，也绝不会翻出更早的历史消息", async () => {
    const user = userEvent.setup();
    const ws = await boot(
      makeSnapshot({
        pms: [makePm({ id: 1, name: "小林" })],
        conversations: [
          makeConvSnapshot(
            [
              makeUserMessage({ id: 1, text: "很久以前停掉的话", status: "stopped", createdAt: 4_000 }),
              makeUserMessage({ id: 2, text: "上一轮正常答完的话", status: "replied", createdAt: 5_000 }),
              makeMessage({ id: 3, text: "好的", createdAt: 6_000 }),
              makeUserMessage({ id: 4, text: "刚被取消的这一句", status: "cancelled", createdAt: 7_000 }),
            ],
            { conversation: { id: 1, pmId: 1, title: "小林" } },
          ),
        ],
      }),
    );

    // 第一次按 Esc（此时对话已停下，这一下直接回退刚被取消的第 4 条）
    await user.keyboard("{Escape}");
    expect(box().value).toBe("刚被取消的这一句");
    await waitFor(() => expect(api.callsTo("POST", /\/conversations\/1\/rewind$/)).toHaveLength(1));

    // 用户删改了几个字，接着手滑连按三次 Esc：输入框保持用户改过的字，不覆盖、不翻出 id=1 或 id=2、不再多发请求
    await user.type(box(), "（改）");
    await user.keyboard("{Escape}{Escape}{Escape}");
    expect(box().value).toBe("刚被取消的这一句（改）");
    expect(api.callsTo("POST", /\/conversations\/1\/rewind$/)).toHaveLength(1);
    expect(within(log()).getByText("很久以前停掉的话")).toBeInTheDocument();
    expect(within(log()).getByText("上一轮正常答完的话")).toBeInTheDocument();
  });

  it("草稿保护与半截回合隔离：按第二次 Esc 前若已新打了字则换行拼接不丢字；Agent 已输出的半截工具调用保持独立一轮", async () => {
    const user = userEvent.setup();
    const ws = await boot();

    push(ws, messageChange(11, "message.created", makeUserMessage({ id: 3, text: "帮我重构登录页", status: "stopped", createdAt: 7_000 })));
    push(ws, messageChange(12, "message.created", makeToolMessage({ id: 4, text: "Read: src/Login.tsx", createdAt: 8_000 })));

    // 用户先在输入框里打了一句补充，再按 Esc 回退上一条
    await user.type(box(), "记得保留记住密码勾选框");
    await user.keyboard("{Escape}");

    expect(box().value).toBe("帮我重构登录页\n记得保留记住密码勾选框");
    expect(box().selectionStart).toBe(box().value.length);
    expect(within(log()).queryByText("帮我重构登录页")).not.toBeInTheDocument();

    // Agent 之前那轮（id=2）和被打断这一轮的工具步骤（id=4）分成独立的两个 turn，不混进上一轮
    expect(log().querySelectorAll("[data-turn]")).toHaveLength(2);
  });

  it("带已上传附件的消息：文字回退进输入框，附件卡片变淡留在消息流不丢失；纯附件无文字消息不回退", async () => {
    const user = userEvent.setup();
    const pdf = makeAttachment({ id: "0000000000000001", name: "设计稿.pdf" });
    const ws = await boot();

    push(
      ws,
      messageChange(11, "message.created", makeUserMessage({ id: 3, text: "按这份改", status: "cancelled", meta: { attachments: [pdf] }, createdAt: 7_000 })),
    );
    await user.keyboard("{Escape}");
    expect(box().value).toBe("按这份改");
    expect(within(log()).queryByText("按这份改")).not.toBeInTheDocument();
    expect(within(log()).getByText("设计稿.pdf")).toBeInTheDocument();
  });
});

describe("跨项目经理（6 家厂商）与 Worker 对话一致生效", () => {
  it.each(VENDOR_LIST.map((v) => v.id))("项目经理使用厂商 %s 时 Esc 暂停与二次 Esc 回退一致生效", async (vendor) => {
    const user = userEvent.setup();
    const ws = await boot(
      makeSnapshot({
        pms: [makePm({ id: 1, name: "小林", vendor })],
        conversations: [
          makeConvSnapshot([makeUserMessage({ id: 1, text: "看看性能", status: "processing", createdAt: 5_000 })], {
            conversation: { id: 1, pmId: 1, title: "小林" },
          }),
        ],
        sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1, vendor, status: "running", activity: "working" })],
      }),
    );

    await user.keyboard("{Escape}");
    await waitFor(() => expect(api.callsTo("POST", /\/conversations\/1\/stop$/)).toHaveLength(1));
    await user.keyboard("{Escape}");
    expect(box().value).toBe("看看性能");
    expect(box().selectionStart).toBe("看看性能".length);
  });

  it("Worker（Piece）对话里给 Worker 发消息后：第一次 Esc 暂停 Worker，第二次 Esc 回退到 Worker 输入框，不影响项目经理草稿", async () => {
    const user = userEvent.setup();
    const ws = await boot(
      makeSnapshot({
        pms: [makePm({ id: 1, name: "小林" })],
        conversations: [
          makeConvSnapshot([makeWorkerLine({ id: 2, conversationId: 1, line: { workerId: 3, workerConversationId: 30, title: "修表格", event: "started" } })], {
            conversation: { id: 1, pmId: 1, title: "小林" },
          }),
          makeConvSnapshot(
            [
              makeMessage({ id: 10, conversationId: 30, sender: "pm", status: "replied", text: "任务：修表格对齐", createdAt: 5_000 }),
              makeMessage({ id: 11, conversationId: 30, sender: "agent", text: "收到，开始排查", createdAt: 6_000 }),
              makeUserMessage({ id: 12, conversationId: 30, workerId: 3, text: "顺便检查窄屏折行", status: "processing", createdAt: 7_000 }),
            ],
            { conversation: makeWorkerConversation({ id: 30, pmId: 1, title: "修表格" }) },
          ),
        ],
        sessions: [
          makeSession({ sessionId: 1, conversationId: 1, pmId: 1, status: "idle", activity: "idle" }),
          makeSession({ sessionId: 30, conversationId: 30, status: "running", activity: "working" }),
        ],
      }),
    );

    // 先在项目经理输入框留一句草稿，再点进 Worker 对话
    await user.type(box(), "给项目经理留的话");
    await user.click(within(log()).getByRole("button", { name: /Piece.*修表格/ }));
    const workerBox = await screen.findByPlaceholderText("Message 修表格…") as HTMLTextAreaElement;

    // 在 Worker 对话按第一次 Esc 暂停，按第二次 Esc 回退到 Worker 输入框
    await user.keyboard("{Escape}");
    await waitFor(() => expect(api.callsTo("POST", /\/conversations\/30\/stop$/)).toHaveLength(1));
    await user.keyboard("{Escape}");
    expect(workerBox.value).toBe("顺便检查窄屏折行");
    expect(document.activeElement).toBe(workerBox);
    expect(workerBox.selectionStart).toBe("顺便检查窄屏折行".length);
    await waitFor(() => expect(api.callsTo("POST", /\/conversations\/30\/rewind$/)).toHaveLength(1));

    // 返回项目经理对话，项目经理自己的草稿完好无损
    await user.click(screen.getByRole("button", { name: "Back to 小林" }));
    expect(box().value).toBe("给项目经理留的话");
  });
});

