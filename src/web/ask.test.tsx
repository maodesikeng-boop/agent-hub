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
  openFirstConversation,
  sessionChange,
  setForeground,
} from "./test-utils.ts";

let api: FakeApi;
let scrolled: Element[];
let unmountApp: () => void;

async function boot(snapshot: StateSnapshot) {
  openFirstConversation(snapshot);
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
const rail = () => screen.queryByRole("complementary", { name: "Pieces" });
/** 右栏里的“等你确定”组；没有是 null。 */
const asksGroup = () => (rail() === null ? null : within(rail()!).queryByRole("region", { name: /^Needs You/ }));
/** 提问的行（不含组标题的收起按钮、同一行右边的整栏开关和 Show more）。 */
const askRows = () => within(asksGroup()!).getAllByRole("button").filter((b) => !b.closest("h2") && b.getAttribute("aria-controls") !== "right-rail" && b.textContent !== "Show more");
const nav = () => screen.getByRole("region", { name: "Project managers" });
const row = (name: string) => within(nav()).getAllByRole("button", { name: new RegExp(name) }).find((b) => !b.closest(".row-shortcuts"))!;
const hasTag = (name: string) => within(row(name)).queryByLabelText("Needs You") !== null;
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
    expect(within(asksGroup()!).getByRole("heading")).toHaveTextContent(/^Needs You$/);
    expect(askRows().map((b) => b.textContent)).toEqual(["用 方案 A 还是方案 B？", "再问一个"]);
  });

  it("对话顶部没有横条，也没有“知道了”按钮", async () => {
    await boot(twoPms([ask({ id: 1, text: QUESTION })]));
    expect(screen.queryByRole("button", { name: "知道了" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("main")).queryByRole("button", { name: /Needs You/ })).not.toBeInTheDocument();
  });

  it("点一行：对话滚到那条消息并高亮；右栏里不展开全文、不出选项（作答在对话里那张卡上）", async () => {
    await boot(twoPms([ask({ id: 1, text: QUESTION }), makeMessage({ id: 2, text: "中间的话" }), ask({ id: 3, text: "再问一个" })]));
    const first = askRows()[0]!;
    expect(first).not.toHaveAttribute("aria-expanded");
    fireEvent.click(first);
    expect(first).toHaveTextContent("方案 A");
    expect(within(asksGroup()!).queryByText("B：单栏信息流")).not.toBeInTheDocument();
    expect(askRows()).toHaveLength(2);
    const target = document.querySelector('[data-message-id="1"]')!;
    expect(scrolled).toEqual([target]);
    expect(target).toHaveAttribute("data-highlighted", "true");
  });

  it("那条消息上不另挂“等你确定”标签（细节藏起来，提问在别处列着）", async () => {
    await boot(twoPms([ask({ id: 1, text: QUESTION })]));
    expect(within(document.querySelector('[data-message-id="1"]') as HTMLElement).queryByText("Needs You")).not.toBeInTheDocument();
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

  it("在输入框里发一条普通消息：右栏的提问还在（发消息不回答任何卡），发送中、发完都一样", async () => {
    await boot(twoPms([ask({ id: 1, text: QUESTION })]));
    const composer = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "用 A" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(askRows()).toHaveLength(1);
    await waitFor(() => expect(api.calls.some((c) => c.path === "/api/conversations/1/messages")).toBe(true));
    expect(askRows()).toHaveLength(1);
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
    expect(screen.getByRole("complementary", { name: "修 X" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to 小林" }));
    fireEvent.click(askRows()[0]!);
    expect(screen.queryByRole("complementary", { name: "修 X" })).not.toBeInTheDocument();
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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(askRows()[0]!);
    expect(scrolled).toHaveLength(1);
    expect(messageOne()).toHaveAttribute("data-highlighted", "true");
    fireEvent.click(within(rail()!).getByRole("button", { name: /修 X/ }));
    fireEvent.click(row("小林"));
    expect(messageOne()).toBeInTheDocument();
    expect(scrolled).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(2_000));
    expect(messageOne()).not.toHaveAttribute("data-highlighted", "true");
  });

  it("再点同一条提问照样跳、照样高亮", async () => {
    await boot(twoPms([ask({ id: 1, text: QUESTION })]));
    fireEvent.click(askRows()[0]!);
    fireEvent.click(askRows()[0]!);
    fireEvent.click(askRows()[0]!);
    expect(scrolled).toHaveLength(3);
    expect(messageOne()).toHaveAttribute("data-highlighted", "true");
  });
});

describe("左栏标签和标题数字", () => {
  it("有提问的项目经理那一行显示极简无字圆点指示器（不显示中文胶囊）；标题数字算上；守护进程标成已回答后都消失", async () => {
    const ws = await boot(askedByOldMa());
    expect(hasTag("老马")).toBe(true);
    // 左栏不属于任何项目经理：实心绿色小圆点（size-2 rounded-full bg-status-active），不显示中文胶囊
    const dot = within(row("老马")).getByLabelText("Needs You");
    expect(dot).toHaveClass("size-2", "rounded-full", "bg-status-active");
    expect(dot).toHaveAttribute("title", "Needs You");
    expect(dot).toHaveTextContent("");
    expect(within(row("老马")).queryByText("Needs You")).toBeNull();
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
    expect(within(row("老马")).queryByText("Your turn")).not.toBeInTheDocument();
    expect(document.title).toBe(`(1) ${PRODUCT_NAME}`);
  });

  it("点那一行打开老马的对话，右栏里是它的提问", async () => {
    await boot(askedByOldMa());
    expect(asksGroup()).toBeNull();
    fireEvent.click(row("老马"));
    expect(askRows().map((b) => b.textContent)).toEqual(["用 方案 A 还是方案 B？"]);
  });
});

describe("Notifications", () => {
  it("新的提问进来立刻弹“<名字> 等你确定”，不用等停稳，正文是问题；点通知打开那个对话", async () => {
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    const ws = await boot(twoPms([makeUserMessage({ id: 1, text: "小林说话了" })]));
    act(() => ws.push(sessionChange(11, makeSession({ sessionId: 2, conversationId: 2, pmId: 2, activity: "working" }))));
    act(() => ws.push(messageChange(12, "message.created", ask({ id: 22, conversationId: 2, text: QUESTION, createdAt: Date.now() }))));
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.last.title).toBe("老马: Needs You");
    expect(FakeNotification.last.options.body).toBe(stripMarkdown(QUESTION));
    act(() => FakeNotification.last.onclick?.());
    expect(focus).toHaveBeenCalledOnce();
    expect(row("老马")).toHaveAttribute("aria-current", "page");
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

describe("对话流里的 A/B/C/D 选项卡片", () => {
  it("带 meta.options 或 Markdown 列表（如 QUESTION）的 hub ask 渲染出 [data-ask-card] 与 A/B 选项按钮；普通提问照旧", async () => {
    await boot(
      twoPms([
        ask({
          id: 1,
          text: "你想审什么？",
          meta: { needsUser: true, options: ["审一个 PR / 分支", "审本地代码路径"] },
        }),
        ask({ id: 2, text: QUESTION }),
        ask({ id: 3, text: "纯文本提问，没有选项" }),
      ]),
    );
    const msg1 = document.querySelector('[data-message-id="1"]') as HTMLElement;
    const card1 = msg1.querySelector("[data-ask-card]") as HTMLElement;
    expect(card1).toBeInTheDocument();
    expect(within(card1).getByText("你想审什么？")).toBeInTheDocument();
    const opts1 = within(card1).getAllByRole("button").filter((b) => b.hasAttribute("data-ask-option"));
    expect(opts1.map((b) => [b.querySelector("span")?.textContent, b.querySelectorAll("span")[1]?.textContent])).toEqual([
      ["A", "审一个 PR / 分支"],
      ["B", "审本地代码路径"],
    ]);

    const msg2 = document.querySelector('[data-message-id="2"]') as HTMLElement;
    const card2 = msg2.querySelector("[data-ask-card]") as HTMLElement;
    expect(card2).toBeInTheDocument();
    expect(within(card2).getByText("方案 A").tagName).toBe("STRONG");
    const opts2 = within(card2).getAllByRole("button").filter((b) => b.hasAttribute("data-ask-option"));
    expect(opts2.map((b) => [b.querySelector("span")?.textContent, b.querySelectorAll("span")[1]?.textContent])).toEqual([
      ["A", "保留三栏"],
      ["B", "单栏信息流"],
    ]);

    const msg3 = document.querySelector('[data-message-id="3"]') as HTMLElement;
    const card3 = msg3.querySelector("[data-ask-card]") as HTMLElement;
    expect(card3).toBeInTheDocument();
    expect(within(card3).getByText("纯文本提问，没有选项")).toBeInTheDocument();
    expect(within(card3).queryAllByRole("button").filter((b) => b.hasAttribute("data-ask-option"))).toEqual([]);
  });

  it("没有选项的独立提问也是一张卡：回复框直接展开，填一句回车只回答这一张；回答后卡变只读", async () => {
    await boot(twoPms([ask({ id: 3, text: "纯文本提问，没有选项" }), ask({ id: 4, text: "请接电源", meta: { needsUser: true, options: ["已接", "不接"] } })]));
    const card = document.querySelector('[data-message-id="3"] [data-ask-card]') as HTMLElement;
    const input = within(card).getByRole("textbox", { name: "Your reply" });
    fireEvent.change(input, { target: { value: "按第二种来" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(api.calls.filter((c) => c.path === "/api/asks/3/answer")).toEqual([
        expect.objectContaining({ method: "POST", body: expect.objectContaining({ note: "按第二种来" }) }),
      ]),
    );
    expect(api.calls.filter((c) => c.path === "/api/conversations/1/messages")).toEqual([]);
    await waitFor(() => expect(within(card).queryByRole("textbox", { name: "Your reply" })).toBeNull());
    expect(card.querySelector("[data-ask-answer]")).toHaveTextContent("按第二种来");
    const other = document.querySelector('[data-message-id="4"] [data-ask-card]') as HTMLElement;
    for (const b of within(other).getAllByRole("button").filter((x) => x.hasAttribute("data-ask-option"))) expect(b).not.toBeDisabled();
  });

  it("已回答的卡显示回答内容：选中项和补充说明都是高亮的一行，有没有选项都一样；被项目经理关掉的卡标 Closed", async () => {
    await boot(
      twoPms([
        ask({ id: 3, text: "请提供测试账号的邮箱地址", meta: { needsUser: true, answered: true, answerNote: "qa-test@example.com" } }),
        ask({ id: 4, text: "请接电源", meta: { needsUser: true, answered: true, options: ["已接", "不接"], chosenOption: "不接", answerNote: "开完会再接" } }),
        ask({ id: 5, text: "预发环境的数据库还要保留吗？", meta: { needsUser: true, answered: true, closed: true } }),
        ask({ id: 6, text: "用哪个分支？", meta: { needsUser: true, answered: true, closed: true, options: ["main", "dev"] } }),
      ]),
    );
    const card = (id: number) => document.querySelector(`[data-message-id="${id}"] [data-ask-card]`) as HTMLElement;
    // 选中的选项是带 data-chosen 的暖黄底行（不画框），用户写的原话是同色底的一行（[data-ask-answer]）
    const highlighted = (id: number) => [...card(id).querySelectorAll("[data-chosen], [data-ask-answer]")].map((el) => el.textContent?.replace(/^[A-Z](?=\S)/, ""));

    expect(highlighted(3)).toEqual(["qa-test@example.com"]);
    expect(highlighted(4)).toEqual(["不接", "开完会再接"]);
    for (const id of [3, 4, 5, 6]) expect(within(card(id)).queryByRole("textbox")).toBeNull();
    for (const id of [3, 4]) expect(within(card(id)).queryByText("Closed")).toBeNull();
    for (const id of [5, 6]) {
      expect(within(card(id)).getByText("Closed")).toBeInTheDocument();
      expect(highlighted(id)).toEqual([]);
    }
  });

  it("回复框是卡片列表的最后一行：不自带框，靠上方细线和卡片外框收住，Send 图标按钮在行里；支持 Shift+Enter 换行且输入框是 15px 正文字号", async () => {
    await boot(twoPms([ask({ id: 3, text: "纯文本提问，没有选项" })]));
    const card = document.querySelector('[data-message-id="3"] [data-ask-card]') as HTMLElement;
    const input = within(card).getByRole("textbox", { name: "Your reply" });
    const send = within(card).getByRole("button", { name: "Send" });
    expect(input.tagName).toBe("TEXTAREA");
    expect(input).toHaveClass("min-h-8", "text-body");
    expect(input).not.toHaveClass("text-minor");
    const row = input.closest("[data-card-reply]")!;
    expect(row).toContainElement(send);
    expect(row).toHaveAttribute("data-card-reply", "row");
    expect(row).toHaveClass("-mx-4", "-mb-4", "border-t", "border-border");
    expect(row.className).not.toMatch(/shadow-\[var\(--shadow-tile\)\]|border-border-strong|rounded-sm/);
    expect(card).toHaveClass("overflow-hidden", "rounded-sm");
    expect(send).toHaveClass("size-8");

    fireEvent.change(input, { target: { value: "第一行" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(api.calls.filter((c) => c.path === "/api/asks/3/answer")).toEqual([]);
  });

  it("点击某个选项按钮只回答这一张卡（POST /api/asks/:id/answer），不发用户消息；回答后选项按钮变为 disabled 并高亮所选项", async () => {
    await boot(
      twoPms([
        ask({
          id: 1,
          text: "你想审什么？",
          meta: { needsUser: true, options: ["审一个 PR / 分支", "审本地代码路径"] },
        }),
        ask({ id: 2, text: "请接电源", meta: { needsUser: true, options: ["已接", "不接"] } }),
      ]),
    );
    const card = document.querySelector('[data-message-id="1"] [data-ask-card]') as HTMLElement;
    const other = document.querySelector('[data-message-id="2"] [data-ask-card]') as HTMLElement;
    const buttons = within(card).getAllByRole("button").filter((b) => b.hasAttribute("data-ask-option"));
    expect(buttons[0]).not.toBeDisabled();
    expect(buttons[1]).not.toBeDisabled();

    fireEvent.click(buttons[1]!);

    await waitFor(() =>
      expect(api.calls.filter((c) => c.path === "/api/asks/1/answer")).toEqual([
        expect.objectContaining({ method: "POST", body: expect.objectContaining({ choice: "审本地代码路径" }) }),
      ]),
    );
    expect(api.calls.filter((c) => c.path === "/api/conversations/1/messages")).toEqual([]);
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).toBeDisabled();
    expect(buttons[1]).toHaveAttribute("data-chosen");
    expect(buttons[1]).toHaveClass("bg-open");
    expect(buttons[0]).not.toHaveAttribute("data-chosen");
    for (const b of buttons) expect(b.className).not.toMatch(/btn-raised|tile-open|shadow/);
    // 回答后卡片收在最后一行：列表贴到卡片底边，不留一截白边
    expect(buttons[1]!.closest("[role='group']")).toHaveClass("-mb-4");
    for (const b of within(other).getAllByRole("button").filter((x) => x.hasAttribute("data-ask-option"))) expect(b).not.toBeDisabled();
  });

  it("没点选项、在常驻回复框里填一句话回车：直接回答这一张卡（无需先点 Add note）", async () => {
    await boot(twoPms([ask({ id: 1, text: "请接电源", meta: { needsUser: true, options: ["已接", "不接"] } })]));
    const card = document.querySelector('[data-message-id="1"] [data-ask-card]') as HTMLElement;
    expect(within(card).queryByRole("button", { name: "Add note" })).toBeNull();
    const input = within(card).getByRole("textbox", { name: "Your reply" });
    fireEvent.change(input, { target: { value: "已经接上了" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(api.calls.filter((c) => c.path === "/api/asks/1/answer")).toEqual([
        expect.objectContaining({ method: "POST", body: expect.objectContaining({ note: "已经接上了" }) }),
      ]),
    );
    expect(api.calls.filter((c) => c.path === "/api/conversations/1/messages")).toEqual([]);
  });

  it("切到别的项目经理再切回：AskCard 未提交的 Your reply 草稿通过共享草稿库保留不丢失", async () => {
    await boot(twoPms([ask({ id: 3, text: "确认缓存策略", meta: { needsUser: true, options: ["方案 A", "方案 B"] } })]));
    const card1 = document.querySelector('[data-message-id="3"] [data-ask-card]') as HTMLElement;
    const input1 = within(card1).getByRole("textbox", { name: "Your reply" }) as HTMLTextAreaElement;
    fireEvent.change(input1, { target: { value: "第 2 节边界条件还没写清楚" } });
    expect(input1.value).toBe("第 2 节边界条件还没写清楚");

    fireEvent.click(row("老马"));
    await waitFor(() => expect(document.querySelector('[data-message-id="3"]')).toBeNull());

    fireEvent.click(row("小林"));
    const restoredCard = await waitFor(() => {
      const el = document.querySelector('[data-message-id="3"] [data-ask-card]') as HTMLElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    expect((within(restoredCard).getByRole("textbox", { name: "Your reply" }) as HTMLTextAreaElement).value).toBe("第 2 节边界条件还没写清楚");
  });

  it("远端定案或被关闭替换时：若 AskCard 已有非空未发草稿，保留只读可复制草稿提示直到手动关闭", async () => {
    const ws = await boot(twoPms([ask({ id: 3, text: "是否下线旧接口？", meta: { needsUser: true, options: ["下线", "保留"] } })]));
    const card = document.querySelector('[data-message-id="3"] [data-ask-card]') as HTMLElement;
    const input = within(card).getByRole("textbox", { name: "Your reply" });
    fireEvent.change(input, { target: { value: "请保留旧接口兼容一周" } });

    act(() =>
      ws.push(
        messageChange(
          11,
          "message.updated",
          ask({ id: 3, text: "是否下线旧接口？", meta: { needsUser: true, options: ["下线", "保留"], answered: true, closed: true } }),
        ),
      ),
    );

    await waitFor(() => expect(within(card).queryByRole("textbox", { name: "Your reply" })).toBeNull());
    const banner = card.querySelector<HTMLElement>("[data-unsent-draft]")!;
    expect(banner).not.toBeNull();
    expect(banner).toHaveTextContent("Unsent reply");
    expect(banner).toHaveTextContent("请保留旧接口兼容一周");
    expect(within(banner).getByRole("button", { name: "Copy" })).toBeInTheDocument();

    fireEvent.click(within(banner).getByRole("button", { name: "Dismiss" }));
    expect(card.querySelector("[data-unsent-draft]")).toBeNull();
  });
});
