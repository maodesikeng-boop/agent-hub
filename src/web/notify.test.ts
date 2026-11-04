// M4：判断“等你”、上次看的时间、弹通知。用假时钟、假的 Notification；网页的前台状态用 setForeground 模拟。
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Change, MessageStatus, SessionActivity, StateSnapshot } from "../shared/index.ts";
import { LAST_SEEN_KEY, NOTIFY_ENABLED_KEY, WAITING_SETTLE_MS, useWaitingReminders } from "./notify.ts";
import { waitingConversations } from "./selectors.ts";
import { applyChange, initialState, reducer, type HubState } from "./state.ts";
import {
  FakeNotification,
  installFakeNotification,
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

const T0 = 1_000_000;

/** 小林（编号 1，对话 1）有一个 Worker（对话 30）；老马（编号 2，对话 2）。默认全都在忙，测试自己让它们停下来。 */
function snapshot(over: { pm1?: Parameters<typeof makeConvSnapshot>[0]; sessions?: StateSnapshot["sessions"] } = {}): StateSnapshot {
  return makeSnapshot({
    pms: [makePm({ id: 1, name: "小林" }), makePm({ id: 2, name: "老马" })],
    conversations: [
      makeConvSnapshot(
        over.pm1 ?? [makeUserMessage({ id: 1, createdAt: T0 - 5_000 }), makeMessage({ id: 2, text: "做完了，你看看", createdAt: T0 - 4_000 })],
        { conversation: { id: 1, pmId: 1, title: "小林" } },
      ),
      makeConvSnapshot([makeUserMessage({ id: 20, conversationId: 2, createdAt: T0 - 5_000 })], {
        conversation: { id: 2, pmId: 2, title: "老马" },
      }),
      makeConvSnapshot([], { conversation: makeWorkerConversation() }),
    ],
    sessions: over.sessions ?? [
      makeSession({ sessionId: 1, conversationId: 1, pmId: 1, activity: "working" }),
      makeSession({ sessionId: 2, conversationId: 2, pmId: 2, activity: "working" }),
      makeSession({ sessionId: 3, conversationId: 30, activity: "idle" }),
    ],
  });
}

const load = (snap: StateSnapshot): HubState => reducer(initialState, { type: "loaded", snapshot: snap });

let seq = 100;
const apply = (state: HubState, change: Omit<Change, "seq"> & Partial<Pick<Change, "seq">>): HubState =>
  applyChange(state, { ...change, seq: ++seq } as Change);

const activity = (state: HubState, sessionId: number, conversationId: number, a: SessionActivity, pmId: number | null = null) =>
  apply(state, sessionChange(0, makeSession({ sessionId, conversationId, pmId, activity: a })));

/** 小林停下来，最后一条是 agent 的话。 */
const pmIdle = (state: HubState) => activity(state, 1, 1, "idle", 1);

function setup(initial: HubState, viewing: number | null = null) {
  const onOpen = vi.fn();
  const view = renderHook(({ state, viewing }) => useWaitingReminders(state, viewing, onOpen), {
    initialProps: { state: initial, viewing },
  });
  let currentViewing = viewing;
  const update = (state: HubState, viewing: number | null = currentViewing) => {
    currentViewing = viewing;
    view.rerender({ state, viewing });
  };
  const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
  return { ...view, update, wait, onOpen, waiting: () => [...view.result.current.waiting].toSorted() };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  localStorage.clear();
  document.title = "agent-hub";
  installFakeNotification("granted");
  setForeground(false);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "visibilityState");
});

describe("waitingConversations（瞬时判断）", () => {
  const idle = (): HubState => pmIdle(load(snapshot()));

  it("项目经理停了、它的 Worker 也停了、最后一条是 agent 的：算", () => {
    expect(waitingConversations(idle(), {})).toEqual([1]);
  });

  it("项目经理还在干活：不算", () => {
    expect(waitingConversations(load(snapshot()), {})).toEqual([]);
  });

  it("项目经理停了，但还有一个 Worker 不是 idle：不算", () => {
    const state = activity(idle(), 3, 30, "working");
    expect(waitingConversations(state, {})).toEqual([]);
    expect(waitingConversations(activity(state, 3, 30, "stopping"), {})).toEqual([]);
  });

  it.each<MessageStatus>(["queued", "delivered", "processing"])("会话里有 %s 的消息：不算", (status) => {
    const state = apply(idle(), messageChange(0, "message.created", makeUserMessage({ id: 3, status, createdAt: T0 - 3_000 })));
    // 最后一条被改成 agent 的，单看状态也不算
    const withAgentLast = apply(state, messageChange(0, "message.created", makeMessage({ id: 4, createdAt: T0 - 2_000 })));
    expect(waitingConversations(withAgentLast, {})).toEqual([]);
  });

  it("最后一条是用户发的：不算", () => {
    const state = apply(idle(), messageChange(0, "message.created", makeUserMessage({ id: 3, status: "replied", createdAt: T0 - 3_000 })));
    expect(waitingConversations(state, {})).toEqual([]);
  });

  it("网页上还在发送的消息：不算", () => {
    const state = reducer(idle(), {
      type: "pendingAdd",
      pending: { clientId: "c1", conversationId: 1, text: "再来", attachments: [], phase: "sending", createdAt: T0 },
    });
    expect(waitingConversations(state, {})).toEqual([]);
  });

  it("最后一条消息比“上次看”早或一样：不算；晚：算", () => {
    expect(waitingConversations(idle(), { 1: T0 - 4_000 })).toEqual([]);
    expect(waitingConversations(idle(), { 1: T0 - 3_999 })).toEqual([]);
    expect(waitingConversations(idle(), { 1: T0 - 4_001 })).toEqual([1]);
  });

  it("Worker 自己的对话不算", () => {
    const state = apply(idle(), messageChange(0, "message.created", makeMessage({ id: 40, conversationId: 30, createdAt: T0 - 1_000 })));
    expect(waitingConversations(state, {})).toEqual([1]);
  });
});

describe("停稳了才算", () => {
  it("项目经理和 Worker 都停下来 3 秒以后，才算“等你”", () => {
    const s = setup(load(snapshot()));
    expect(s.waiting()).toEqual([]);
    s.update(pmIdle(load(snapshot())));
    s.wait(WAITING_SETTLE_MS - 1);
    expect(s.waiting()).toEqual([]);
    s.wait(1);
    expect(s.waiting()).toEqual([1]);
  });

  it("停了 1 秒，会话又忙起来：不算；再停下来重新数 3 秒", () => {
    const s = setup(load(snapshot()));
    const idle = pmIdle(load(snapshot()));
    s.update(idle);
    s.wait(1_000);
    const busy = activity(idle, 1, 1, "working", 1);
    s.update(busy);
    s.wait(WAITING_SETTLE_MS);
    expect(s.waiting()).toEqual([]);
    const again = activity(busy, 1, 1, "idle", 1);
    s.update(again);
    s.wait(WAITING_SETTLE_MS - 1);
    expect(s.waiting()).toEqual([]);
    s.wait(1);
    expect(s.waiting()).toEqual([1]);
  });

  it("停了 1 秒，又有新消息排队：不算", () => {
    const s = setup(load(snapshot()));
    const idle = pmIdle(load(snapshot()));
    s.update(idle);
    s.wait(1_000);
    s.update(apply(idle, messageChange(0, "message.created", makeUserMessage({ id: 3, status: "queued", createdAt: T0 + 1_000 }))));
    s.wait(WAITING_SETTLE_MS * 2);
    expect(s.waiting()).toEqual([]);
  });

  it("有一个 Worker 在跑：不算；它停下来以后再数 3 秒", () => {
    const base = activity(pmIdle(load(snapshot())), 3, 30, "working");
    const s = setup(base);
    s.wait(WAITING_SETTLE_MS * 2);
    expect(s.waiting()).toEqual([]);
    s.update(activity(base, 3, 30, "idle"));
    s.wait(WAITING_SETTLE_MS);
    expect(s.waiting()).toEqual([1]);
  });

  it.each<MessageStatus>(["queued", "delivered", "processing"])("会话里有 %s 的消息：不算；变成 replied 以后再数 3 秒", (status) => {
    const pending = snapshot({
      pm1: [makeUserMessage({ id: 1, status, createdAt: T0 - 5_000 }), makeMessage({ id: 2, createdAt: T0 - 4_000 })],
      sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1, activity: "idle" })],
    });
    const base = load(pending);
    // 第一次出现（刚打开网页）不算；用“停下来”的变化来触发
    const s = setup(activity(base, 1, 1, "working", 1));
    s.update(activity(base, 1, 1, "idle", 1));
    s.wait(WAITING_SETTLE_MS * 2);
    expect(s.waiting()).toEqual([]);
    s.update(apply(base, messageChange(0, "message.updated", makeUserMessage({ id: 1, status: "replied", createdAt: T0 - 5_000 }))));
    s.wait(WAITING_SETTLE_MS);
    expect(s.waiting()).toEqual([1]);
  });
});

describe("看过了", () => {
  it("网页在前台、正开着这个会话：不算；之后切走，又来了新消息并且停稳：重新算", () => {
    setForeground(true);
    const busy = load(snapshot());
    const s = setup(busy, 1);
    const idle = pmIdle(busy);
    s.update(idle, 1);
    s.wait(WAITING_SETTLE_MS * 2);
    expect(s.waiting()).toEqual([]);

    s.update(idle, 2); // 去看别的会话
    s.wait(WAITING_SETTLE_MS * 2);
    expect(s.waiting()).toEqual([]);

    vi.setSystemTime(T0 + 20_000);
    const busy2 = activity(idle, 1, 1, "working", 1);
    s.update(busy2, 2);
    const idle2 = apply(activity(busy2, 1, 1, "idle", 1), messageChange(0, "message.created", makeMessage({ id: 9, createdAt: T0 + 20_000 })));
    s.update(idle2, 2);
    s.wait(WAITING_SETTLE_MS);
    expect(s.waiting()).toEqual([1]);
  });

  it("网页在后台时，开着的会话不算看过；回到前台才算", () => {
    const busy = load(snapshot());
    const s = setup(busy, 1);
    s.update(pmIdle(busy), 1);
    s.wait(WAITING_SETTLE_MS);
    expect(s.waiting()).toEqual([1]);
    act(() => setForeground(true));
    expect(s.waiting()).toEqual([]);
  });

  it("“上次看”存在 localStorage 里", () => {
    setForeground(true);
    vi.setSystemTime(T0 + 7_000);
    setup(load(snapshot()), 1);
    expect(JSON.parse(localStorage.getItem(LAST_SEEN_KEY) ?? "{}")).toEqual({ 1: T0 + 7_000 });
  });
});

describe("网页重开", () => {
  it("localStorage 里看过的，不会又算“等你”；没看过的照样算，马上就算，不用再等 3 秒", () => {
    localStorage.setItem(LAST_SEEN_KEY, JSON.stringify({ 1: T0 }));
    const state = pmIdle(activity(load(snapshot()), 2, 2, "idle", 2));
    const s = setup(state);
    // 小林看过了；老马最后一条是用户发的，本来就不算。再加一条老马的 agent 消息
    expect(s.waiting()).toEqual([]);

    localStorage.setItem(LAST_SEEN_KEY, JSON.stringify({ 1: T0 - 10_000 }));
    const s2 = setup(state);
    expect(s2.waiting()).toEqual([1]);
  });

  it("localStorage 坏了或不能用：当作都没看过，不报错", () => {
    localStorage.setItem(LAST_SEEN_KEY, "不是 JSON");
    expect(() => setup(pmIdle(load(snapshot())))).not.toThrow();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    setForeground(true);
    expect(() => setup(pmIdle(load(snapshot())), 1)).not.toThrow();
  });
});

describe("标签页标题", () => {
  it("标题是“(N) 产品名”；没有时没有括号", () => {
    const busy = load(snapshot());
    const s = setup(busy);
    expect(document.title).toBe("agent-hub");
    const one = pmIdle(busy);
    s.update(one);
    s.wait(WAITING_SETTLE_MS);
    expect(document.title).toBe("(1) agent-hub");
    const two = apply(activity(one, 2, 2, "idle", 2), messageChange(0, "message.created", makeMessage({ id: 21, conversationId: 2, createdAt: T0 - 1_000 })));
    s.update(two);
    s.wait(WAITING_SETTLE_MS);
    expect(document.title).toBe("(2) agent-hub");
    s.update(activity(two, 1, 1, "working", 1));
    expect(document.title).toBe("(1) agent-hub");
  });
});

describe("弹通知", () => {
  it("从“不算”变成“等你”时弹一次，标题是“<名字> 等你”，正文是它最后说的话，tag 按项目经理区分", () => {
    const busy = load(snapshot());
    const s = setup(busy);
    const idle = pmIdle(busy);
    s.update(idle);
    s.wait(WAITING_SETTLE_MS - 1);
    expect(FakeNotification.instances).toHaveLength(0);
    s.wait(1);
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.last.title).toBe("小林 等你");
    expect(FakeNotification.last.options.body).toBe("做完了，你看看");
    expect(FakeNotification.last.options.tag).toBe("pm-1");
    // 再等也不会重复弹
    s.wait(WAITING_SETTLE_MS * 3);
    expect(FakeNotification.instances).toHaveLength(1);

    // 小林又忙了一轮、又停了：同一个 tag，会顶掉上一条
    const again = apply(activity(activity(idle, 1, 1, "working", 1), 1, 1, "idle", 1), messageChange(0, "message.created", makeMessage({ id: 5, text: "改好了", createdAt: T0 + 1 })));
    s.update(activity(idle, 1, 1, "working", 1));
    s.update(again);
    s.wait(WAITING_SETTLE_MS);
    expect(FakeNotification.instances).toHaveLength(2);
    expect(FakeNotification.last.options.tag).toBe("pm-1");

    // 老马：另一个 tag
    s.update(apply(activity(again, 2, 2, "idle", 2), messageChange(0, "message.created", makeMessage({ id: 21, conversationId: 2, createdAt: T0 + 2 }))));
    s.wait(WAITING_SETTLE_MS);
    expect(FakeNotification.last.title).toBe("老马 等你");
    expect(FakeNotification.last.options.tag).toBe("pm-2");
  });

  it("网页在前台，但开着的是另一个会话：照弹", () => {
    setForeground(true);
    const busy = load(snapshot());
    const s = setup(busy, 2);
    s.update(pmIdle(busy), 2);
    s.wait(WAITING_SETTLE_MS);
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it("网页在后台，开着的就是这个会话：照弹", () => {
    const busy = load(snapshot());
    const s = setup(busy, 1);
    s.update(pmIdle(busy), 1);
    s.wait(WAITING_SETTLE_MS);
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it("网页在前台、正开着这个会话：不弹", () => {
    setForeground(true);
    const busy = load(snapshot());
    const s = setup(busy, 1);
    s.update(pmIdle(busy), 1);
    s.wait(WAITING_SETTLE_MS * 2);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("刚打开网页时本来就在“等你”的：不弹，只显示；以后再变成“等你”照弹", () => {
    const idle = pmIdle(load(snapshot()));
    const s = setup(idle);
    expect(s.waiting()).toEqual([1]);
    s.wait(WAITING_SETTLE_MS * 2);
    expect(FakeNotification.instances).toHaveLength(0);

    const busy = activity(idle, 1, 1, "working", 1);
    s.update(busy);
    s.update(apply(activity(busy, 1, 1, "idle", 1), messageChange(0, "message.created", makeMessage({ id: 5, createdAt: T0 + 1 }))));
    s.wait(WAITING_SETTLE_MS);
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it("点通知：窗口回到前台，打开那个会话", () => {
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    const busy = load(snapshot());
    const s = setup(busy);
    s.update(pmIdle(busy));
    s.wait(WAITING_SETTLE_MS);
    act(() => FakeNotification.last.onclick?.());
    expect(focus).toHaveBeenCalledOnce();
    expect(s.onOpen).toHaveBeenCalledWith(1);
  });
});

describe("通知权限", () => {
  it("权限是 default（还没问过）：不弹；拨开关才申请，批准了以后能弹", async () => {
    installFakeNotification("default");
    const busy = load(snapshot());
    const s = setup(busy);
    expect(s.result.current.notify.permission).toBe("default");
    s.update(pmIdle(busy));
    s.wait(WAITING_SETTLE_MS);
    expect(s.waiting()).toEqual([1]); // 左栏照常
    expect(FakeNotification.instances).toHaveLength(0);

    await act(async () => {
      await s.result.current.notify.setEnabled(true);
    });
    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
    expect(s.result.current.notify.permission).toBe("granted");
    // 之后新的“等你”会弹
    const again = activity(pmIdle(busy), 1, 1, "working", 1);
    s.update(again);
    s.update(apply(activity(again, 1, 1, "idle", 1), messageChange(0, "message.created", makeMessage({ id: 5, createdAt: T0 + 1 }))));
    s.wait(WAITING_SETTLE_MS);
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it("用户拒绝了：不弹，也不会再问；左栏和标题照常", async () => {
    installFakeNotification("default");
    FakeNotification.answer = "denied";
    const busy = load(snapshot());
    const s = setup(busy);
    await act(async () => {
      await s.result.current.notify.setEnabled(true);
    });
    expect(s.result.current.notify.permission).toBe("denied");
    s.update(pmIdle(busy));
    s.wait(WAITING_SETTLE_MS);
    expect(FakeNotification.instances).toHaveLength(0);
    expect(document.title).toBe("(1) agent-hub");
  });

  it("开关关掉后不弹，左栏和标题照常；再打开又能弹", async () => {
    const busy = load(snapshot());
    const s = setup(busy);
    expect(s.result.current.notify.enabled).toBe(true); // 已授权、没存过偏好：默认开
    await act(async () => {
      await s.result.current.notify.setEnabled(false);
    });
    expect(s.result.current.notify.enabled).toBe(false);
    expect(localStorage.getItem(NOTIFY_ENABLED_KEY)).toBe("0");
    s.update(pmIdle(busy));
    s.wait(WAITING_SETTLE_MS);
    expect(FakeNotification.instances).toHaveLength(0);
    expect(s.waiting()).toEqual([1]);
    expect(document.title).toBe("(1) agent-hub");

    await act(async () => {
      await s.result.current.notify.setEnabled(true);
    });
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled(); // 已授权，不再问
    expect(localStorage.getItem(NOTIFY_ENABLED_KEY)).toBe("1");
    const again = activity(pmIdle(busy), 1, 1, "working", 1);
    s.update(again);
    s.update(apply(activity(again, 1, 1, "idle", 1), messageChange(0, "message.created", makeMessage({ id: 5, createdAt: T0 + 1 }))));
    s.wait(WAITING_SETTLE_MS);
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it("存的偏好：关着重开还是关；没存过值或值不认识就看授权（已授权是开，没问过是关）", () => {
    localStorage.setItem(NOTIFY_ENABLED_KEY, "0");
    expect(setup(load(snapshot())).result.current.notify.enabled).toBe(false);
    for (const dirty of ["abc", "true", "", "{}"]) {
      localStorage.setItem(NOTIFY_ENABLED_KEY, dirty);
      expect(setup(load(snapshot())).result.current.notify.enabled).toBe(true);
    }
    // 存的是开，但浏览器那边的授权没了：开关是关
    localStorage.setItem(NOTIFY_ENABLED_KEY, "1");
    installFakeNotification("default");
    expect(setup(load(snapshot())).result.current.notify.enabled).toBe(false);
  });

  it("弹的时候才看权限：中途在浏览器设置里关掉了，就不弹", () => {
    const busy = load(snapshot());
    const s = setup(busy);
    s.update(pmIdle(busy));
    FakeNotification.permission = "denied";
    s.wait(WAITING_SETTLE_MS);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("new Notification 抛错（有的环境不让）：不影响别的", () => {
    const busy = load(snapshot());
    vi.stubGlobal(
      "Notification",
      Object.assign(
        function Boom() {
          throw new TypeError("Illegal constructor");
        },
        { permission: "granted", requestPermission: vi.fn() },
      ),
    );
    const s = setup(busy);
    s.update(pmIdle(busy));
    expect(() => s.wait(WAITING_SETTLE_MS)).not.toThrow();
    expect(s.waiting()).toEqual([1]);
  });

  it("浏览器没有 Notification：不报错，左栏和标题照常", () => {
    installFakeNotification(null);
    const busy = load(snapshot());
    const s = setup(busy);
    expect(s.result.current.notify.permission).toBe("unsupported");
    s.update(pmIdle(busy));
    s.wait(WAITING_SETTLE_MS);
    expect(s.waiting()).toEqual([1]);
    expect(document.title).toBe("(1) agent-hub");
  });
});
