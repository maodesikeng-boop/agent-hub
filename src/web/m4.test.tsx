// M4 网页：左栏的“等你”、标签页标题、浏览器通知、点通知回到会话、申请通知权限。接口、WebSocket、Notification 都是假的。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateSnapshot } from "../shared/index.ts";
import { PRODUCT_NAME } from "../shared/names.ts";
import { App } from "./App.tsx";
import { LAST_SEEN_KEY, NOTIFY_ENABLED_KEY, WAITING_SETTLE_MS } from "./notify.ts";
import {
  FakeApi,
  FakeNotification,
  FakeWebSocket,
  installFakeNotification,
  installFakeWebSocket,
  makeConvSnapshot,
  makeMessage,
  makePm,
  makeProject,
  makeSession,
  makeSnapshot,
  makeUserMessage,
  makeWorkerConversation,
  messageChange,
  sessionChange,
  setForeground,
} from "./test-utils.ts";

let unmountApp: () => void;

/** 起网页：假接口 + 假 WebSocket，等首屏出来、WebSocket 接上。 */
async function boot(snapshot: StateSnapshot) {
  new FakeApi(snapshot).install();
  installFakeWebSocket();
  unmountApp = render(<App />).unmount;
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  act(() => FakeWebSocket.last.open());
  return FakeWebSocket.last;
}

/**
 * 小林（对话 1）在上面，有一个 Worker（对话 30）；老马（对话 2）在下面。
 * busy：两个项目经理都在干活；否则都停了，最后一条是 agent 的话。
 */
function twoPms(busy: boolean): StateSnapshot {
  const activity = busy ? "working" : "idle";
  return makeSnapshot({
    pms: [makePm({ id: 1, name: "小林" }), makePm({ id: 2, name: "老马" })],
    conversations: [
      makeConvSnapshot([makeUserMessage({ id: 1, createdAt: 5_000 }), makeMessage({ id: 2, text: "小林做完了", createdAt: 9_000 })], {
        conversation: { id: 1, pmId: 1, title: "小林" },
      }),
      makeConvSnapshot(
        [makeUserMessage({ id: 20, conversationId: 2, createdAt: 4_000 }), makeMessage({ id: 21, conversationId: 2, text: "老马做完了", createdAt: 8_000 })],
        { conversation: { id: 2, pmId: 2, title: "老马" } },
      ),
      makeConvSnapshot([], { conversation: makeWorkerConversation() }),
    ],
    sessions: [
      makeSession({ sessionId: 1, conversationId: 1, pmId: 1, activity }),
      makeSession({ sessionId: 2, conversationId: 2, pmId: 2, activity }),
      makeSession({ sessionId: 3, conversationId: 30, activity: "idle" }),
    ],
  });
}

const nav = () => screen.getByRole("navigation", { name: "对话列表" });
const row = (name: string) => within(nav()).getByRole("button", { name: new RegExp(name) });
const hasName = (name: string) => within(nav()).queryByRole("button", { name: new RegExp(name) }) !== null;
const hasMark = (name: string) => within(row(name)).queryByText("等你") !== null;
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

/** 老马停下来，说了一句新的话。 */
function laoMaFinishes(ws: FakeWebSocket, seq: number) {
  act(() => ws.push(messageChange(seq, "message.created", makeMessage({ id: 22 + seq, conversationId: 2, text: "老马又做完了一件", createdAt: Date.now() }))));
  act(() => ws.push(sessionChange(seq + 1, makeSession({ sessionId: 2, conversationId: 2, pmId: 2, activity: "idle" }))));
}
function laoMaWorks(ws: FakeWebSocket, seq: number) {
  act(() => ws.push(sessionChange(seq, makeSession({ sessionId: 2, conversationId: 2, pmId: 2, activity: "working" }))));
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  localStorage.clear();
  installFakeNotification("granted");
  setForeground(false);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "visibilityState");
});

describe("左栏和标题", () => {
  it("停稳的那个项目经理那一行显示“等你”，标题是“(N) 产品名”；没有时没有括号", async () => {
    const ws = await boot(twoPms(true));
    vi.useFakeTimers();
    expect(document.title).toBe(PRODUCT_NAME);
    expect(hasMark("老马")).toBe(false);

    laoMaFinishes(ws, 11);
    wait(WAITING_SETTLE_MS - 1);
    expect(hasMark("老马")).toBe(false);
    expect(document.title).toBe(PRODUCT_NAME);
    wait(1);
    expect(hasMark("老马")).toBe(true);
    // 左栏不属于任何项目经理：标签是中性色，不带主色
    expect(within(row("老马")).getByText("等你").className).not.toMatch(/primary/);
    expect(hasMark("小林")).toBe(false);
    expect(document.title).toBe(`(1) ${PRODUCT_NAME}`);

    act(() => ws.push(sessionChange(13, makeSession({ sessionId: 1, conversationId: 1, pmId: 1, activity: "idle" }))));
    act(() => ws.push(messageChange(14, "message.created", makeMessage({ id: 3, text: "小林也好了", createdAt: Date.now() }))));
    wait(WAITING_SETTLE_MS);
    expect(hasMark("小林")).toBe(true);
    expect(document.title).toBe(`(2) ${PRODUCT_NAME}`);

    laoMaWorks(ws, 15);
    expect(hasMark("老马")).toBe(false);
    expect(document.title).toBe(`(1) ${PRODUCT_NAME}`);
  });
});

describe("通知和点通知", () => {
  it("停稳了弹一次“<名字> 等你”；点通知回到前台、打开那个会话，“等你”和标题里的数字随之消失", async () => {
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    const ws = await boot(twoPms(true));
    vi.useFakeTimers();
    expect(row("小林")).toHaveAttribute("aria-current", "true");

    laoMaFinishes(ws, 11);
    wait(WAITING_SETTLE_MS);
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.last.title).toBe("老马 等你");
    expect(FakeNotification.last.options.body).toBe("老马又做完了一件");
    expect(FakeNotification.last.options.tag).toBe("pm-2");

    act(() => FakeNotification.last.onclick?.());
    act(() => setForeground(true)); // 浏览器听 window.focus() 回到前台
    expect(focus).toHaveBeenCalledOnce();
    expect(row("老马")).toHaveAttribute("aria-current", "true");
    expect(hasMark("老马")).toBe(false);
    expect(document.title).toBe(PRODUCT_NAME);
  });

  it("网页在前台、正看着这个会话：不弹，也不显示", async () => {
    setForeground(true);
    const ws = await boot(twoPms(true));
    vi.useFakeTimers();
    act(() => ws.push(sessionChange(11, makeSession({ sessionId: 1, conversationId: 1, pmId: 1, activity: "idle" }))));
    act(() => ws.push(messageChange(12, "message.created", makeMessage({ id: 3, text: "小林做完了一件", createdAt: Date.now() }))));
    wait(WAITING_SETTLE_MS * 2);
    expect(FakeNotification.instances).toHaveLength(0);
    expect(hasMark("小林")).toBe(false);
    expect(document.title).toBe(PRODUCT_NAME);
  });

  it("两个项目经理：哪个先停下来，就先弹哪个的通知", async () => {
    const ws = await boot(twoPms(true));
    vi.useFakeTimers();
    laoMaFinishes(ws, 11);
    wait(WAITING_SETTLE_MS);
    act(() => ws.push(sessionChange(13, makeSession({ sessionId: 1, conversationId: 1, pmId: 1, activity: "idle" }))));
    act(() => ws.push(messageChange(14, "message.created", makeMessage({ id: 3, text: "小林也好了", createdAt: Date.now() }))));
    wait(WAITING_SETTLE_MS);
    expect(FakeNotification.instances.map((n) => n.title)).toEqual(["老马 等你", "小林 等你"]);
  });
});

describe("网页重开", () => {
  it("看过的不会又显示“等你”；没看过的照样显示，但不会补弹通知", async () => {
    setForeground(true);
    await boot(twoPms(false));
    // 小林是默认打开的，看过了；老马没看过，刚打开就显示，不弹
    expect(hasMark("小林")).toBe(false);
    expect(hasMark("老马")).toBe(true);
    expect(document.title).toBe(`(1) ${PRODUCT_NAME}`);
    fireEvent.click(row("老马"));
    expect(hasMark("老马")).toBe(false);
    expect(Object.keys(JSON.parse(localStorage.getItem(LAST_SEEN_KEY) ?? "{}")).toSorted()).toEqual(["1", "2"]);
    unmountApp();

    // 关掉再打开（这次网页在后台，什么也不会被看到）：都看过了
    setForeground(false);
    await boot(twoPms(false));
    expect(hasMark("小林")).toBe(false);
    expect(hasMark("老马")).toBe(false);

    // 清掉记录，再打开：都没看过，都显示，但不弹
    unmountApp();
    localStorage.clear();
    await boot(twoPms(false));
    expect(hasMark("小林")).toBe(true);
    expect(hasMark("老马")).toBe(true);
    expect(FakeNotification.instances).toHaveLength(0);
  });
});

/** 点齿轮，拿到设置面板里的“通知”开关。 */
function openSettings() {
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  return screen.getByRole("dialog", { name: "设置" });
}
const notifySwitch = () => within(screen.getByRole("dialog", { name: "设置" })).getByRole("switch", { name: "通知" });

describe("设置面板里的通知开关", () => {
  it("左栏底部只有齿轮，没有“开启通知”和“＋ 项目经理”；点齿轮打开设置", async () => {
    installFakeNotification("default");
    await boot(twoPms(true));
    expect(screen.queryByRole("button", { name: "开启通知" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "项目经理" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    openSettings();
    expect(notifySwitch()).toBeInTheDocument();
  });

  it("权限是 default：开关是关；拨开才申请，批准以后开关是开、存下来", async () => {
    installFakeNotification("default");
    await boot(twoPms(true));
    openSettings();
    expect(notifySwitch()).toHaveAttribute("aria-checked", "false");
    expect(notifySwitch()).toBeEnabled();
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    fireEvent.click(notifySwitch());
    await waitFor(() => expect(notifySwitch()).toHaveAttribute("aria-checked", "true"));
    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
    expect(localStorage.getItem(NOTIFY_ENABLED_KEY)).toBe("1");
  });

  it("申请被拒：开关回到关，不能再拨（浏览器拒绝了）", async () => {
    installFakeNotification("default");
    FakeNotification.answer = "denied";
    await boot(twoPms(true));
    openSettings();
    fireEvent.click(notifySwitch());
    await waitFor(() => expect(notifySwitch()).toBeDisabled());
    expect(notifySwitch()).toHaveAttribute("aria-checked", "false");
    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
    expect(localStorage.getItem(NOTIFY_ENABLED_KEY)).toBe("0");
  });

  it("权限已经是 granted 又没存过偏好（老用户）：开关默认是开，不再申请", async () => {
    await boot(twoPms(true));
    openSettings();
    expect(notifySwitch()).toHaveAttribute("aria-checked", "true");
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it("权限是 denied：开关是关，用不了", async () => {
    installFakeNotification("denied");
    await boot(twoPms(true));
    openSettings();
    expect(notifySwitch()).toHaveAttribute("aria-checked", "false");
    expect(notifySwitch()).toBeDisabled();
  });

  it("浏览器没有 Notification：开关是关，用不了，不报错，左栏和标题照常", async () => {
    installFakeNotification(null);
    const ws = await boot(twoPms(true));
    openSettings();
    expect(notifySwitch()).toHaveAttribute("aria-checked", "false");
    expect(notifySwitch()).toBeDisabled();
    fireEvent.keyDown(notifySwitch(), { key: "Escape" });
    vi.useFakeTimers();
    laoMaFinishes(ws, 11);
    wait(WAITING_SETTLE_MS);
    expect(hasMark("老马")).toBe(true);
    expect(document.title).toBe(`(1) ${PRODUCT_NAME}`);
  });

  it("关掉以后不再弹，左栏和标题照常；重开网页还是关", async () => {
    const ws = await boot(twoPms(true));
    openSettings();
    fireEvent.click(notifySwitch());
    expect(notifySwitch()).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem(NOTIFY_ENABLED_KEY)).toBe("0");
    fireEvent.keyDown(notifySwitch(), { key: "Escape" });
    vi.useFakeTimers();
    laoMaFinishes(ws, 11);
    wait(WAITING_SETTLE_MS);
    expect(FakeNotification.instances).toHaveLength(0);
    expect(hasMark("老马")).toBe(true);
    expect(document.title).toBe(`(1) ${PRODUCT_NAME}`);
    unmountApp();

    vi.useRealTimers();
    await boot(twoPms(true));
    openSettings();
    expect(notifySwitch()).toHaveAttribute("aria-checked", "false");
  });

  it("localStorage 里是脏值：当作没存过，已授权就是开", async () => {
    localStorage.setItem(NOTIFY_ENABLED_KEY, "也许");
    await boot(twoPms(true));
    openSettings();
    expect(notifySwitch()).toHaveAttribute("aria-checked", "true");
  });
});

describe("搜索", () => {
  const search = () => screen.getByRole("searchbox", { name: "搜索" });
  const names = () => within(nav()).queryAllByRole("button").map((b) => b.textContent ?? "");
  const type = (value: string) => fireEvent.change(search(), { target: { value } });
  const withProjects = () => {
    const snapshot = twoPms(false);
    snapshot.projects = [
      makeProject({ id: 1, name: "Alpha 网站", pmId: 1, conversationId: 1 }),
      makeProject({ id: 2, name: "支付", pmId: 2, conversationId: 2 }),
    ];
    return snapshot;
  };

  it("顶部是搜索框和“新建项目经理”，没有产品名", async () => {
    await boot(withProjects());
    expect(search()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建项目经理" })).toBeInTheDocument();
    expect(screen.queryByText(PRODUCT_NAME)).not.toBeInTheDocument();
  });

  it("边输入边筛：按项目经理名字、按项目名；不搜聊天内容", async () => {
    await boot(withProjects());
    expect(names()).toHaveLength(2);
    type("老");
    expect(names()).toHaveLength(1);
    expect(hasName("老马")).toBe(true);
    type("支付"); // 老马的项目名
    expect(names()).toHaveLength(1);
    expect(hasName("老马")).toBe(true);
    type("alpha"); // 小林的项目名
    expect(names()).toHaveLength(1);
    expect(hasName("小林")).toBe(true);
    type("做完了"); // 只在聊天内容里
    expect(names()).toHaveLength(0);
  });

  it("不区分大小写，前后空格忽略；中间的空格照常算", async () => {
    await boot(withProjects());
    type("  ALPHA  ");
    expect(names()).toHaveLength(1);
    expect(hasName("小林")).toBe(true);
    type("alpha 网");
    expect(names()).toHaveLength(1);
    type("   ");
    expect(names()).toHaveLength(2);
  });

  it("清空恢复全部；没有匹配时列表是空的，没有说明文字", async () => {
    await boot(withProjects());
    type("没有这个");
    expect(names()).toEqual([]);
    expect(nav()).toBeEmptyDOMElement();
    type("");
    expect(names()).toHaveLength(2);
  });

  it("筛掉了当前打开的对话：右边照常显示，不切换；清空后左栏还是它选中", async () => {
    await boot(withProjects());
    expect(row("小林")).toHaveAttribute("aria-current", "true");
    type("老马");
    expect(names()).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "小林" })).toBeInTheDocument();
    type("");
    expect(row("小林")).toHaveAttribute("aria-current", "true");
  });

  it("筛选时“等你”标签照旧在；标题数字不受筛选影响", async () => {
    const ws = await boot({ ...withProjects(), sessions: twoPms(true).sessions });
    vi.useFakeTimers();
    laoMaFinishes(ws, 11);
    wait(WAITING_SETTLE_MS);
    type("老马");
    expect(hasMark("老马")).toBe(true);
    type("小林");
    expect(document.title).toBe(`(1) ${PRODUCT_NAME}`);
  });

  it("“＋”打开新建项目经理的对话框", async () => {
    await boot(withProjects());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "新建项目经理" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
