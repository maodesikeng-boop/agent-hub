// 联机 P4：守护进程按变化流判断要不要推（规则同网页，shared/reminders.ts）；网页在前台看着时不推。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WAITING_SETTLE_MS, type Change, type Message, type PushPayload, type StateSnapshot } from "../../shared/index.ts";
import { makeConvSnapshot, makeMessage, makePm, makeSession, makeSnapshot, makeUserMessage } from "../../shared/test-helpers.ts";
import { createPresenceBoard, type PresenceBoard } from "./presence.ts";
import { createReminderWatcher } from "./watcher.ts";
import { PRESENCE_STALE_MS } from "../../shared/index.ts";

const T0 = 1_000_000;
const DEVICE = { id: "0f0e0d0c-0b0a-4908-8706-050403020100", name: "东京", self: true };

/** 小林（对话 1）在忙，最后一条是用户发的。 */
function snapshot(): StateSnapshot {
  return makeSnapshot({
    seq: 10,
    pms: [makePm({ id: 1, name: "小林" })],
    conversations: [makeConvSnapshot([makeUserMessage({ id: 1, createdAt: T0 - 5_000 })], { conversation: { id: 1, pmId: 1, title: "小林" } })],
    sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1, activity: "working" })],
  });
}

let seq = 10;
const change = (c: Omit<Change, "seq">): Change => ({ ...c, seq: ++seq }) as Change;
const reply = (id: number, over: Partial<Message> = {}) => change({ type: "message.created", data: { message: makeMessage({ id, createdAt: Date.now(), ...over }) } });
const idle = () => change({ type: "session.status", data: { session: makeSession({ sessionId: 1, conversationId: 1, pmId: 1, activity: "idle" }) } });
const ask = (id: number) => reply(id, { meta: { needsUser: true } });

let presence: PresenceBoard;
let pushed: PushPayload[];
let watcher: ReturnType<typeof createReminderWatcher>;

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  seq = 10;
  presence = createPresenceBoard();
  pushed = [];
  watcher = createReminderWatcher({ device: DEVICE, presence, notify: (p) => pushed.push(p) });
  watcher.reset(snapshot());
});
afterEach(() => {
  watcher.close();
  vi.useRealTimers();
});

describe("createReminderWatcher", () => {
  it("hub ask：一来就推一次，标题“设备 · 项目经理：等你确定”，不带正文", async () => {
    watcher.apply(ask(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(pushed).toEqual([{ title: "东京 · 小林：等你确定", url: "/#/c/1", tag: `${DEVICE.id}:ask-pm-1` }]);
    watcher.apply(change({ type: "message.updated", data: { message: makeMessage({ id: 2, meta: { needsUser: true } }) } }));
    await vi.advanceTimersByTimeAsync(WAITING_SETTLE_MS * 2);
    expect(pushed).toHaveLength(1);
  });

  it("等你：停稳 3 秒才推；没停稳又忙起来就不推", async () => {
    watcher.apply(reply(2));
    watcher.apply(idle());
    await vi.advanceTimersByTimeAsync(WAITING_SETTLE_MS - 1);
    expect(pushed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(pushed).toEqual([{ title: "东京 · 小林：等你", url: "/#/c/1", tag: `${DEVICE.id}:pm-1` }]);

    watcher.apply(change({ type: "message.created", data: { message: makeUserMessage({ id: 3, createdAt: Date.now() }) } }));
    watcher.apply(change({ type: "session.status", data: { session: makeSession({ sessionId: 1, conversationId: 1, pmId: 1, activity: "working" }) } }));
    watcher.apply(reply(4));
    watcher.apply(idle());
    await vi.advanceTimersByTimeAsync(1_000);
    watcher.apply(change({ type: "session.status", data: { session: makeSession({ sessionId: 1, conversationId: 1, pmId: 1, activity: "working" }) } }));
    await vi.advanceTimersByTimeAsync(WAITING_SETTLE_MS * 2);
    expect(pushed).toHaveLength(1);
  });

  it("刚启动时本来就在等的、本来就有的提问：不推", async () => {
    const snap = snapshot();
    snap.conversations[0]!.messages.push(makeMessage({ id: 2, createdAt: T0 - 1_000, meta: { needsUser: true } }));
    snap.sessions = [makeSession({ sessionId: 1, conversationId: 1, pmId: 1, activity: "idle" })];
    const fresh = createReminderWatcher({ device: DEVICE, presence, notify: (p) => pushed.push(p) });
    fresh.reset(snap);
    await vi.advanceTimersByTimeAsync(WAITING_SETTLE_MS * 2);
    fresh.close();
    expect(pushed).toEqual([]);
  });

  it("有网页在前台：不推（网页自己提醒）；那个网页不再上报超过 PRESENCE_STALE_MS 就当不在前台了", async () => {
    const page = {};
    presence.report(page, { type: "presence", visible: true, deviceId: null, conversationId: 7 });
    watcher.apply(ask(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(pushed).toEqual([]);

    await vi.advanceTimersByTimeAsync(PRESENCE_STALE_MS + 1);
    watcher.apply(ask(3));
    await vi.advanceTimersByTimeAsync(0);
    expect(pushed).toHaveLength(1);
  });

  it("切到后台、连接断了：照常推", async () => {
    const page = {};
    presence.report(page, { type: "presence", visible: true, deviceId: null, conversationId: null });
    presence.report(page, { type: "presence", visible: false, deviceId: null, conversationId: null });
    watcher.apply(ask(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(pushed).toHaveLength(1);

    const other = {};
    presence.report(other, { type: "presence", visible: true, deviceId: null, conversationId: null });
    presence.remove(other);
    watcher.apply(ask(3));
    await vi.advanceTimersByTimeAsync(0);
    expect(pushed).toHaveLength(2);
  });

  it("前台正看着的对话算看过：切到后台后不再为这条推“等你”", async () => {
    const page = {};
    presence.report(page, { type: "presence", visible: true, deviceId: null, conversationId: 1 });
    watcher.apply(reply(2));
    watcher.apply(idle());
    await vi.advanceTimersByTimeAsync(1);
    presence.report(page, { type: "presence", visible: false, deviceId: null, conversationId: 1 });
    watcher.apply(change({ type: "health.updated", data: { health: { module: "driver", consecutiveFailures: 0, lastError: null, updatedAt: Date.now() } } }));
    await vi.advanceTimersByTimeAsync(WAITING_SETTLE_MS * 2);
    expect(pushed).toEqual([]);
  });

  it("重新拉快照（变化流补不齐）：已经推过的不再推，断线期间来的新提问照推", async () => {
    watcher.apply(ask(2));
    await vi.advanceTimersByTimeAsync(0);
    const snap = snapshot();
    snap.seq = 50;
    snap.conversations[0]!.messages.push(makeMessage({ id: 2, meta: { needsUser: true } }), makeMessage({ id: 3, meta: { needsUser: true } }));
    watcher.reset(snap);
    await vi.advanceTimersByTimeAsync(0);
    expect(pushed.map((p) => p.tag)).toEqual([`${DEVICE.id}:ask-pm-1`, `${DEVICE.id}:ask-pm-1`]);
  });
});
