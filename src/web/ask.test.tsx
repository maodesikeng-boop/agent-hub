// 网页：hub ask 发的“等你确定”（M5）：右栏里的那一组、展开全文和跳转、已回答（守护进程标的 meta.answered）就消失、左栏标签和标题数字、立刻弹通知。接口、WebSocket、Notification 都是假的。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, StateSnapshot } from "../shared/index.ts";
import { PRODUCT_NAME } from "../shared/names.ts";
import { App } from "./App.tsx";
import { NOTIFY_ENABLED_KEY } from "./notify.ts";
import { stripMarkdown } from "./plainText.ts";
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
  makeWorkerConversation,
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

const QUESTION = "用 **方案 A** 还是方案 B？\n\n- A：保留三栏\n- B：单栏信息流";
const rail = () => screen.queryByRole("complementary", { name: "右栏" });
/** 右栏里的“等你确定”组；没有是 null。 */
const asksGroup = () => (rail() === null ? null : within(rail()!).queryByRole("region", { name: /^等你确定/ }));
const askRows = () => within(asksGroup()!).getAllByRole("button");
const nav = () => screen.getByRole("navigation", { name: "对话列表" });
const row = (name: string) => within(nav()).getByRole("button", { name: new RegExp(name) });
const hasTag = (name: string) => within(row(name)).queryByText("等你确定") !== null;
const askedByOldMa = () => twoPms([makeUserMessage({ id: 1, text: "小林说话了", createdAt: 20_000 })], [ask({ id: 22, conversationId: 2, text: QUESTION, createdAt: 9_000 })]);
const answered = (over: Partial<Message> & Pick<Message, "id">) => ask({ ...over, meta: { needsUser: true, answered: true } });

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

describe("右栏的“等你确定”", () => {
  it("有提问：右栏自动展开，“等你确定”一组，一个问题一行；没有提问：没有这一组（也没有 Worker 就没有右栏）；普通消息不算", async () => {
    await boot(twoPms([makeUserMessage({ id: 1, text: "普通的话" })]));
    expect(rail()).not.toBeInTheDocument();
    unmountApp();
    await boot(twoPms([ask({ id: 1, text: QUESTION }), ask({ id: 2, text: "再问一个" })]));
    expect(within(asksGroup()!).getByRole("heading")).toHaveTextContent("等你确定2");
    expect(askRows().map((b) => b.textContent)).toEqual(["用 方案 A 还是方案 B？", "再问一个"]);
  });

  it("对话顶部没有横条，也没有“知道了”按钮", async () => {
    await boot(twoPms([ask({ id: 1, text: QUESTION })]));
    expect(screen.queryByRole("button", { name: "知道了" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("main")).queryByRole("button", { name: /等你确定/ })).not.toBeInTheDocument();
  });

  it("点一行：在右栏里展开全文（Markdown），对话滚到那条消息并高亮；再点收起", async () => {
    await boot(twoPms([ask({ id: 1, text: QUESTION }), makeMessage({ id: 2, text: "中间的话" }), ask({ id: 3, text: "再问一个" })]));
    const first = askRows()[0]!;
    expect(first).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(first);
    expect(first).toHaveAttribute("aria-expanded", "true");
    const body = first.parentElement!;
    expect(within(body).getByText("方案 A").tagName).toBe("STRONG");
    expect(within(body).getByText("B：单栏信息流")).toBeInTheDocument();
    const target = document.querySelector('[data-message-id="1"]')!;
    expect(scrolled).toEqual([target]);
    expect(target).toHaveAttribute("data-highlighted", "true");
    fireEvent.click(first);
    expect(first).toHaveAttribute("aria-expanded", "false");
    expect(within(body).queryByText("B：单栏信息流")).not.toBeInTheDocument();
  });

  it("那条消息上不另挂“等你确定”标签（细节藏起来，提问在别处列着）", async () => {
    await boot(twoPms([ask({ id: 1, text: QUESTION })]));
    expect(within(document.querySelector('[data-message-id="1"]') as HTMLElement).queryByText("等你确定")).not.toBeInTheDocument();
  });

  it("有新 Worker 消息和新的普通消息进来，提问还在", async () => {
    const ws = await boot(twoPms([ask({ id: 1, text: QUESTION })]));
    act(() => ws.push(messageChange(11, "message.created", makeWorkerLine({ id: 2, line: { event: "report", status: "done", summary: "好了" } }))));
    act(() => ws.push(messageChange(12, "message.created", makeMessage({ id: 3, text: "Worker 说完了" }))));
    expect(askRows()).toHaveLength(1);
  });

  it("守护进程标成已回答（推 message.updated）：从右栏消失；没有提问也没有 Worker 时右栏整个收起", async () => {
    const ws = await boot(twoPms([ask({ id: 1, text: QUESTION }), ask({ id: 2, text: "再问一个" })]));
    act(() => ws.push(messageChange(11, "message.created", makeUserMessage({ id: 3, text: "用 A", createdAt: Date.now() }))));
    act(() => ws.push(messageChange(12, "message.updated", answered({ id: 1, text: QUESTION }))));
    expect(askRows().map((b) => b.textContent)).toEqual(["再问一个"]);
    act(() => ws.push(messageChange(13, "message.updated", answered({ id: 2, text: "再问一个" }))));
    expect(rail()).not.toBeInTheDocument();
  });

  it("在输入框里发出去：马上消失，不等服务端确认", async () => {
    await boot(twoPms([ask({ id: 1, text: QUESTION })]));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "用 A" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() => expect(asksGroup()).toBeNull());
  });

  it("用户先发的消息不算：提问在用户消息之后，照样显示", async () => {
    await boot(twoPms([makeUserMessage({ id: 1, text: "帮我选" }), ask({ id: 2, text: QUESTION })]));
    expect(askRows()).toHaveLength(1);
  });

  it("刷新页面、重启后：已回答的（包括老数据里点过“知道了”的）不再出现", async () => {
    setForeground(true);
    await boot(twoPms([answered({ id: 1, text: QUESTION }), ask({ id: 2, text: "老的", meta: { needsUser: true, dismissed: true } })]));
    expect(rail()).not.toBeInTheDocument();
    expect(hasTag("小林")).toBe(false);
    expect(document.title).toBe(PRODUCT_NAME);
  });

  it("在 Worker 的对话里：右栏照样列它的项目经理的提问；点一行回到项目经理的对话并滚到那条", async () => {
    const snapshot = twoPms([ask({ id: 1, text: QUESTION })]);
    snapshot.conversations.push(makeConvSnapshot([makeMessage({ id: 40, conversationId: 30, text: "在干活" })], { conversation: makeWorkerConversation({ id: 30, pmId: 1, title: "修 X" }) }));
    await boot(snapshot);
    fireEvent.click(within(rail()!).getByRole("button", { name: /修 X/ }));
    expect(screen.getByRole("region", { name: "Worker 修 X" })).toBeInTheDocument();
    fireEvent.click(askRows()[0]!);
    expect(screen.queryByRole("region", { name: "Worker 修 X" })).not.toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[data-message-id="1"]')).toHaveAttribute("data-highlighted", "true"));
  });
});

describe("跳到提问只生效一次", () => {
  const messageOne = () => document.querySelector('[data-message-id="1"]');

  it("点了提问、切到别的对话再切回来：不再跳到那条提问，也没有高亮", async () => {
    await boot(twoPms([ask({ id: 1, text: QUESTION }), makeMessage({ id: 2, text: "后来的话" })]));
    fireEvent.click(askRows()[0]!);
    expect(scrolled).toHaveLength(1);
    fireEvent.click(row("老马"));
    fireEvent.click(row("小林"));
    await waitFor(() => expect(messageOne()).toBeInTheDocument());
    expect(scrolled).toHaveLength(1);
    expect(messageOne()).not.toHaveAttribute("data-highlighted", "true");
  });

  it("点了提问、去 Worker 的对话再回来：不再跳", async () => {
    const snapshot = twoPms([ask({ id: 1, text: QUESTION })]);
    snapshot.conversations.push(makeConvSnapshot([makeMessage({ id: 40, conversationId: 30, text: "在干活" })], { conversation: makeWorkerConversation({ id: 30, pmId: 1, title: "修 X" }) }));
    await boot(snapshot);
    fireEvent.click(askRows()[0]!);
    expect(scrolled).toHaveLength(1);
    fireEvent.click(within(rail()!).getByRole("button", { name: /修 X/ }));
    fireEvent.click(row("小林"));
    await waitFor(() => expect(messageOne()).toBeInTheDocument());
    expect(scrolled).toHaveLength(1);
    expect(messageOne()).not.toHaveAttribute("data-highlighted", "true");
  });

  it("再点同一条提问照样跳、照样高亮", async () => {
    await boot(twoPms([ask({ id: 1, text: QUESTION })]));
    fireEvent.click(askRows()[0]!);
    fireEvent.click(askRows()[0]!);
    fireEvent.click(askRows()[0]!);
    expect(scrolled).toHaveLength(2);
    expect(messageOne()).toHaveAttribute("data-highlighted", "true");
  });
});

describe("左栏标签和标题数字", () => {
  it("有提问的项目经理那一行显示“等你确定”；标题数字算上；守护进程标成已回答后都消失", async () => {
    const ws = await boot(askedByOldMa());
    expect(hasTag("老马")).toBe(true);
    // 左栏不属于任何项目经理：实心的前景色（深底白字），不带主色
    expect(within(row("老马")).getByText("等你确定")).toHaveClass("bg-foreground", "text-background");
    expect(hasTag("小林")).toBe(false);
    expect(document.title).toBe(`(1) ${PRODUCT_NAME}`);
    // 老马还在干活（Worker 在跑也一样）：照样显示
    act(() => ws.push(sessionChange(11, makeSession({ sessionId: 2, conversationId: 2, pmId: 2, activity: "working" }))));
    expect(hasTag("老马")).toBe(true);
    act(() => ws.push(messageChange(12, "message.created", makeUserMessage({ id: 23, conversationId: 2, createdAt: Date.now() }))));
    act(() => ws.push(messageChange(13, "message.updated", answered({ id: 22, conversationId: 2, text: QUESTION, createdAt: 9_000 }))));
    expect(hasTag("老马")).toBe(false);
    expect(document.title).toBe(PRODUCT_NAME);
  });

  it("用户在别的对话里发消息：这个对话的提问照旧", async () => {
    const ws = await boot(askedByOldMa());
    act(() => ws.push(messageChange(12, "message.created", makeUserMessage({ id: 30, conversationId: 1, createdAt: Date.now() }))));
    expect(hasTag("老马")).toBe(true);
    expect(document.title).toBe(`(1) ${PRODUCT_NAME}`);
  });

  it("同一个项目经理又“等你”又有提问：只算一个，行上只显示“等你确定”", async () => {
    // 老马停稳了、最后一条是 agent 的话（提问本身），所以也算“等你”
    await boot(askedByOldMa());
    expect(within(row("老马")).queryByText("等你")).not.toBeInTheDocument();
    expect(document.title).toBe(`(1) ${PRODUCT_NAME}`);
  });

  it("点那一行打开老马的对话，右栏里是它的提问", async () => {
    await boot(askedByOldMa());
    expect(asksGroup()).toBeNull();
    fireEvent.click(row("老马"));
    expect(askRows().map((b) => b.textContent)).toEqual(["用 方案 A 还是方案 B？"]);
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
    expect(FakeNotification.last.options.body).toBe(stripMarkdown(QUESTION));
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
    expect(askRows()).toHaveLength(1);
  });
});
