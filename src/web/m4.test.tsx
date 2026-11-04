// M4 网页：左栏的“等你”、标签页标题、浏览器通知、点通知回到会话、申请通知权限。接口、WebSocket、Notification 都是假的。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateSnapshot } from "../shared/index.ts";
import { PRODUCT_NAME } from "../shared/names.ts";
import { App } from "./App.tsx";
import { LAST_SEEN_KEY, WAITING_SETTLE_MS } from "./notify.ts";
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

describe("开启通知", () => {
  const button = () => screen.queryByRole("button", { name: "开启通知" });

  it("权限是 default 时显示“开启通知”，点了申请，批准以后按钮消失", async () => {
    installFakeNotification("default");
    await boot(twoPms(true));
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    expect(button()).toBeInTheDocument();
    fireEvent.click(button()!);
    await waitFor(() => expect(button()).not.toBeInTheDocument());
    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
  });

  it("用户拒绝了：按钮消失，不再问", async () => {
    installFakeNotification("default");
    FakeNotification.answer = "denied";
    await boot(twoPms(true));
    fireEvent.click(button()!);
    await waitFor(() => expect(button()).not.toBeInTheDocument());
    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
  });

  it.each(["granted", "denied"] as const)("权限已经是 %s：不显示按钮", async (permission) => {
    installFakeNotification(permission);
    await boot(twoPms(true));
    expect(button()).not.toBeInTheDocument();
  });

  it("浏览器没有 Notification：不显示按钮，不报错，左栏和标题照常", async () => {
    installFakeNotification(null);
    const ws = await boot(twoPms(true));
    vi.useFakeTimers();
    expect(button()).not.toBeInTheDocument();
    laoMaFinishes(ws, 11);
    wait(WAITING_SETTLE_MS);
    expect(hasMark("老马")).toBe(true);
    expect(document.title).toBe(`(1) ${PRODUCT_NAME}`);
  });
});
