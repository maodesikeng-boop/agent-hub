// 网页：hub ask 发的“等你确定”（M5）：对话顶部的条、跳转、清掉的规则、左栏标签和标题数字、立刻弹通知。接口、WebSocket、Notification 都是假的。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, StateSnapshot } from "../shared/index.ts";
import { PRODUCT_NAME } from "../shared/names.ts";
import { App } from "./App.tsx";
import { NOTIFY_ENABLED_KEY } from "./notify.ts";
import {
  FakeApi,
  FakeNotification,
  FakeWebSocket,
  installFakeNotification,
  installFakeWebSocket,
  makeConvSnapshot,
  makeMessage,
  makePm,
  makeSession,
  makeSnapshot,
  makeUserMessage,
  makeWorkerLine,
  messageChange,
  sessionChange,
  setForeground,
} from "./test-utils.ts";

let api: FakeApi;
let scrolled: Element[];
let unmountApp: () => void;

async function boot(snapshot: StateSnapshot) {
  api = new FakeApi(snapshot);
  api.install();
  installFakeWebSocket();
  unmountApp = render(<App />).unmount;
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  act(() => FakeWebSocket.last.open());
  return FakeWebSocket.last;
}

const ask = (over: Partial<Message> & Pick<Message, "id">): Message =>
  makeMessage({ meta: { needsUser: true }, dedupeKey: `ask:1:${over.id}`, ...over });

/** 小林（对话 1，打开着）、老马（对话 2）。onlyMessages：各自对话里的消息。 */
function twoPms(lin: Message[], ma: Message[] = [makeUserMessage({ id: 21, conversationId: 2, createdAt: 8_000 })]): StateSnapshot {
  return makeSnapshot({
    pms: [makePm({ id: 1, name: "小林" }), makePm({ id: 2, name: "老马" })],
    conversations: [
      makeConvSnapshot(lin, { conversation: { id: 1, pmId: 1, title: "小林" } }),
      makeConvSnapshot(ma, { conversation: { id: 2, pmId: 2, title: "老马" } }),
    ],
    sessions: [
      makeSession({ sessionId: 1, conversationId: 1, pmId: 1, activity: "idle" }),
      makeSession({ sessionId: 2, conversationId: 2, pmId: 2, activity: "idle" }),
    ],
  });
}

const QUESTION = "用 **方案 A** 还是方案 B？";
const bar = () => screen.queryByRole("button", { name: /^等你确定（\d+）/ });
const nav = () => screen.getByRole("navigation", { name: "对话列表" });
const row = (name: string) => within(nav()).getByRole("button", { name: new RegExp(name) });
const hasTag = (name: string) => within(row(name)).queryByText("等你确定") !== null;
const askedByOldMa = () => twoPms([makeUserMessage({ id: 1, text: "小林说话了", createdAt: 20_000 })], [ask({ id: 22, conversationId: 2, text: QUESTION, createdAt: 9_000 })]);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  localStorage.clear();
  installFakeNotification("granted");
  setForeground(false);
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "visibilityState");
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

describe("对话顶部的“等你确定”条", () => {
  it("有提问：显示“等你确定（N）”；没有提问：不显示；普通消息不算", async () => {
    await boot(twoPms([makeUserMessage({ id: 1, text: "普通的话" })]));
    expect(bar()).not.toBeInTheDocument();
    unmountApp();
    await boot(twoPms([ask({ id: 1, text: QUESTION }), ask({ id: 2, text: "再问一个" })]));
    expect(screen.getByRole("button", { name: /^等你确定（2）/ })).toBeInTheDocument();
  });

  it("点一下展开列出每个问题的摘要（去掉 Markdown 符号）；点某条跳到那条消息并高亮", async () => {
    await boot(twoPms([ask({ id: 1, text: QUESTION }), makeMessage({ id: 2, text: "中间的话" }), ask({ id: 3, text: "再问一个" })]));
    expect(screen.queryByRole("button", { name: /用 方案 A 还是方案 B？/ })).not.toBeInTheDocument();
    fireEvent.click(bar()!);
    expect(screen.getByRole("button", { name: /用 方案 A 还是方案 B？/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "再问一个" }));
    const target = document.querySelector('[data-message-id="3"]')!;
    expect(scrolled).toEqual([target]);
    expect(target).toHaveAttribute("data-highlighted", "true");
    expect(document.querySelector('[data-message-id="1"]')).not.toHaveAttribute("data-highlighted");
  });

  it("那条消息上不另挂“等你确定”标签（细节藏起来，提问在别处列着）", async () => {
    await boot(twoPms([ask({ id: 1, text: QUESTION })]));
    expect(within(document.querySelector('[data-message-id="1"]') as HTMLElement).queryByText("等你确定")).not.toBeInTheDocument();
  });

  it("有新 Worker 消息和新的普通消息进来，条还在", async () => {
    const ws = await boot(twoPms([ask({ id: 1, text: QUESTION })]));
    act(() => ws.push(messageChange(11, "message.created", makeWorkerLine({ id: 2, line: { event: "report", status: "done", summary: "好了" } }))));
    act(() => ws.push(messageChange(12, "message.created", makeMessage({ id: 3, text: "Worker 说完了" }))));
    expect(screen.getByRole("button", { name: /^等你确定（1）/ })).toBeInTheDocument();
  });

  it("用户在这条之后发了消息（对话里已有，或刚发出还没确认）：自动清掉", async () => {
    const ws = await boot(twoPms([ask({ id: 1, text: QUESTION })]));
    act(() => ws.push(messageChange(11, "message.created", makeUserMessage({ id: 2, text: "用 A", createdAt: Date.now() }))));
    expect(bar()).not.toBeInTheDocument();
    unmountApp();
    // 刚打开、用户的回复已经在对话里
    await boot(twoPms([ask({ id: 1, text: QUESTION }), makeUserMessage({ id: 2, text: "用 A" })]));
    expect(bar()).not.toBeInTheDocument();
    unmountApp();
    // 在输入框里发：马上清，不等服务端确认
    await boot(twoPms([ask({ id: 1, text: QUESTION })]));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "用 A" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() => expect(bar()).not.toBeInTheDocument());
  });

  it("用户先发的消息不算：提问在用户消息之后，条照样显示", async () => {
    await boot(twoPms([makeUserMessage({ id: 1, text: "帮我选" }), ask({ id: 2, text: QUESTION })]));
    expect(screen.getByRole("button", { name: /^等你确定（1）/ })).toBeInTheDocument();
  });

  it("“知道了”：请求服务端清掉；清掉之后（服务端推 message.updated）条消失，别的提问还在", async () => {
    const ws = await boot(twoPms([ask({ id: 1, text: QUESTION })]));
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    await waitFor(() => expect(api.callsTo("POST", /\/api\/messages\/1\/dismiss-ask$/)).toHaveLength(1));
    act(() => ws.push(messageChange(11, "message.updated", ask({ id: 1, text: QUESTION, meta: { needsUser: true, dismissed: true } }))));
    expect(bar()).not.toBeInTheDocument();
  });

  it("“知道了”清掉这个对话里所有还没处理的提问", async () => {
    await boot(twoPms([ask({ id: 1, text: QUESTION }), ask({ id: 2, text: "再问一个" })]));
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    await waitFor(() => expect(api.callsTo("POST", /dismiss-ask$/).map((c) => c.path)).toEqual(["/api/messages/1/dismiss-ask", "/api/messages/2/dismiss-ask"]));
  });

  it("刷新页面、重启后：服务端记着已经清掉的，不再出现", async () => {
    setForeground(true);
    await boot(twoPms([ask({ id: 1, text: QUESTION, meta: { needsUser: true, dismissed: true } })]));
    expect(bar()).not.toBeInTheDocument();
    expect(hasTag("小林")).toBe(false);
    expect(document.title).toBe(PRODUCT_NAME);
  });
});

describe("左栏标签和标题数字", () => {
  it("有提问的项目经理那一行显示“等你确定”；标题数字算上；处理之后都消失", async () => {
    const ws = await boot(askedByOldMa());
    expect(hasTag("老马")).toBe(true);
    expect(hasTag("小林")).toBe(false);
    expect(document.title).toBe(`(1) ${PRODUCT_NAME}`);
    // 老马还在干活（Worker 在跑也一样）：照样显示
    act(() => ws.push(sessionChange(11, makeSession({ sessionId: 2, conversationId: 2, pmId: 2, activity: "working" }))));
    expect(hasTag("老马")).toBe(true);
    act(() => ws.push(messageChange(12, "message.created", makeUserMessage({ id: 23, conversationId: 2, createdAt: Date.now() }))));
    expect(hasTag("老马")).toBe(false);
    expect(document.title).toBe(PRODUCT_NAME);
  });

  it("同一个项目经理又“等你”又有提问：只算一个，行上只显示“等你确定”", async () => {
    // 老马停稳了、最后一条是 agent 的话（提问本身），所以也算“等你”
    await boot(askedByOldMa());
    expect(within(row("老马")).queryByText("等你")).not.toBeInTheDocument();
    expect(document.title).toBe(`(1) ${PRODUCT_NAME}`);
  });

  it("点那一行打开老马的对话，顶部是它的条", async () => {
    await boot(askedByOldMa());
    expect(bar()).not.toBeInTheDocument();
    fireEvent.click(row("老马"));
    expect(screen.getByRole("button", { name: /^等你确定（1）/ })).toBeInTheDocument();
  });
});

describe("通知", () => {
  it("新的提问进来立刻弹“<名字> 等你确定”，不用等停稳，正文是问题；点通知打开那个对话", async () => {
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    const ws = await boot(twoPms([makeUserMessage({ id: 1, text: "小林说话了" })]));
    act(() => ws.push(sessionChange(11, makeSession({ sessionId: 2, conversationId: 2, pmId: 2, activity: "working" }))));
    act(() => ws.push(messageChange(12, "message.created", ask({ id: 22, conversationId: 2, text: QUESTION, createdAt: Date.now() }))));
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.last.title).toBe("老马 等你确定");
    expect(FakeNotification.last.options.body).toBe("用 方案 A 还是方案 B？");
    act(() => FakeNotification.last.onclick?.());
    expect(focus).toHaveBeenCalledOnce();
    expect(row("老马")).toHaveAttribute("aria-current", "true");
  });

  it("刚打开网页时已经有的提问不弹；同一条提问更新（比如被清掉）不再弹", async () => {
    const ws = await boot(askedByOldMa());
    expect(FakeNotification.instances).toHaveLength(0);
    act(() => ws.push(messageChange(11, "message.updated", ask({ id: 22, conversationId: 2, text: QUESTION, createdAt: 9_000 }))));
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("设置里的通知开关关着：不弹，左栏和标题照常", async () => {
    localStorage.setItem(NOTIFY_ENABLED_KEY, "0");
    const ws = await boot(twoPms([makeUserMessage({ id: 1, text: "小林说话了" })]));
    act(() => ws.push(messageChange(12, "message.created", ask({ id: 22, conversationId: 2, text: QUESTION, createdAt: Date.now() }))));
    expect(FakeNotification.instances).toHaveLength(0);
    expect(hasTag("老马")).toBe(true);
    expect(document.title).toBe(`(1) ${PRODUCT_NAME}`);
  });

  it("网页在前台、正看着提问的那个对话：不弹（条就在眼前）", async () => {
    setForeground(true);
    const ws = await boot(twoPms([makeUserMessage({ id: 1, text: "小林说话了" })]));
    act(() => ws.push(messageChange(12, "message.created", ask({ id: 2, text: QUESTION, createdAt: Date.now() }))));
    expect(FakeNotification.instances).toHaveLength(0);
    expect(screen.getByRole("button", { name: /^等你确定（1）/ })).toBeInTheDocument();
  });
});
