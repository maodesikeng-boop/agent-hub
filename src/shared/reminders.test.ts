// 提醒规则（联机 P4，docs/multi-device-design.md 第 6.2 节）：网页和守护进程（推送）共用的那一份。
// 网页的提醒照旧由 web/notify.test.ts、web/m4.test.tsx、web/ask.test.tsx 管；这里管规则本身和守护进程要用的部分。
import { describe, expect, it } from "vitest";
import {
  makeConvSnapshot,
  makeMessage,
  makePm,
  makeSession,
  makeSnapshot,
  makeUserMessage,
  makeWorkerConversation,
} from "./test-helpers.ts";
import type { Change, Message, SessionState, StateSnapshot } from "./index.ts";
import {
  ReminderTracker,
  WAITING_SETTLE_MS,
  applyReminderChange,
  pendingAsks,
  reminderPayload,
  reminderStateFrom,
  waitingConversations,
  type ReminderState,
} from "./reminders.ts";

const T0 = 1_000_000;
const DEVICE = "0f0e0d0c-0b0a-4908-8706-050403020100";

const ask = (over: Partial<Message> & Pick<Message, "id">): Message => makeMessage({ text: "要不要合？", meta: { needsUser: true }, ...over });

/** 小林（项目经理 1，对话 1）有一个 Worker（对话 30）；老马（项目经理 2，对话 2）只有一条用户消息。 */
function snapshot(over: { pm1?: Message[]; sessions?: SessionState[] } = {}): StateSnapshot {
  return makeSnapshot({
    pms: [makePm({ id: 1, name: "小林" }), makePm({ id: 2, name: "老马" })],
    conversations: [
      makeConvSnapshot(over.pm1 ?? [makeUserMessage({ id: 1, createdAt: T0 - 5_000 }), makeMessage({ id: 2, text: "做完了", createdAt: T0 - 4_000 })], {
        conversation: { id: 1, pmId: 1, title: "小林" },
      }),
      makeConvSnapshot([makeUserMessage({ id: 20, conversationId: 2, createdAt: T0 - 5_000 })], { conversation: { id: 2, pmId: 2, title: "老马" } }),
      makeConvSnapshot([], { conversation: makeWorkerConversation() }),
    ],
    sessions: over.sessions ?? [
      makeSession({ sessionId: 1, conversationId: 1, pmId: 1, activity: "idle" }),
      makeSession({ sessionId: 2, conversationId: 2, pmId: 2, activity: "idle" }),
      makeSession({ sessionId: 3, conversationId: 30, activity: "idle" }),
    ],
  });
}

let seq = 100;
const change = (c: Omit<Change, "seq">): Change => ({ ...c, seq: ++seq }) as Change;

describe("规则（从 web/selectors.ts 搬来，行为不变）", () => {
  it("等你：项目经理停下、最后一条是它说的、上次看之后有新消息", () => {
    const state = reminderStateFrom(snapshot());
    expect(waitingConversations(state, {})).toEqual([1]);
    expect(waitingConversations(state, { 1: T0 })).toEqual([]);
  });

  it("项目经理还在忙、它的 Worker 在跑、最后一条是用户发的：都不算", () => {
    expect(waitingConversations(reminderStateFrom(snapshot({ sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1, activity: "working" })] })), {})).toEqual([]);
    const workerBusy = snapshot({
      sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1, activity: "idle" }), makeSession({ sessionId: 3, conversationId: 30, activity: "working" })],
    });
    expect(waitingConversations(reminderStateFrom(workerBusy), {})).toEqual([]);
  });

  it("网页自己先显示的消息（pending）还在发：不算等你；守护进程没有 pending", () => {
    const state: ReminderState = { ...reminderStateFrom(snapshot()), pending: [{ conversationId: 1, phase: "sending" }] };
    expect(waitingConversations(state, {})).toEqual([]);
  });

  it("等你确定：没回答的 hub ask，从老到新", () => {
    const state = reminderStateFrom(snapshot({ pm1: [ask({ id: 5 }), ask({ id: 6, meta: { needsUser: true, answered: true } })] }));
    expect(pendingAsks(state, 1).map((m) => m.id)).toEqual([5]);
  });
});

describe("applyReminderChange：守护进程按变化流维护一份状态", () => {
  it("新消息、会话状态、新对话、项目经理改名都跟上；旧的 seq 不再应用", () => {
    let state = reminderStateFrom({ ...snapshot(), seq: 100 });
    seq = 100;
    state = applyReminderChange(state, change({ type: "message.created", data: { message: makeMessage({ id: 21, conversationId: 2, text: "好了", createdAt: T0 }) } }));
    expect(waitingConversations(state, {})).toEqual([1, 2]);
    state = applyReminderChange(state, change({ type: "session.status", data: { session: makeSession({ sessionId: 2, conversationId: 2, pmId: 2, activity: "working" }) } }));
    expect(waitingConversations(state, {})).toEqual([1]);
    state = applyReminderChange(state, change({ type: "pm.updated", data: { pm: makePm({ id: 1, name: "小林二号" }) } }));
    expect(reminderPayload(state, { kind: "waiting", conversationId: 1 }, { id: DEVICE, name: "东京", self: true })?.title).toBe("东京 · 小林二号：等你");
    state = applyReminderChange(state, change({ type: "conversation.created", data: { conversation: { id: 3, kind: "pm", pmId: 3, projectId: null, title: "新的", createdAt: T0 } } }));
    expect(state.conversations[3]?.messages).toEqual([]);
    const stale = applyReminderChange(state, { seq: 1, type: "session.status", data: { session: makeSession({ sessionId: 1, conversationId: 1, pmId: 1, activity: "working" }) } });
    expect(stale).toBe(state);
  });

  it("每个对话只留最近的消息，不会一直涨", () => {
    let state = reminderStateFrom(snapshot());
    for (let id = 100; id < 400; id++) {
      state = applyReminderChange(state, change({ type: "message.created", data: { message: makeMessage({ id, conversationId: 2 }) } }));
    }
    expect(state.conversations[2]!.messages.length).toBeLessThanOrEqual(200);
    expect(state.conversations[2]!.messages.at(-1)?.id).toBe(399);
  });
});

describe("ReminderTracker：停稳 3 秒、提问一来就提醒、刚开始时本来就有的不提醒", () => {
  it("第一次看到的等你、提问都不提醒", () => {
    const tracker = new ReminderTracker<number>();
    expect(tracker.update(T0, [1], [{ conversationId: 2, messageId: 9 }])).toEqual({ fire: [], nextCheckAt: null });
    expect(tracker.waiting()).toEqual(new Set([1]));
  });

  it("新的等你：停稳 3 秒才提醒；中途退出就重新算", () => {
    const tracker = new ReminderTracker<number>();
    tracker.update(T0, [], []);
    expect(tracker.update(T0 + 10, [1], [])).toEqual({ fire: [], nextCheckAt: T0 + 10 + WAITING_SETTLE_MS });
    expect(tracker.update(T0 + 1_000, [], []).fire).toEqual([]);
    expect(tracker.update(T0 + 2_000, [1], []).nextCheckAt).toBe(T0 + 2_000 + WAITING_SETTLE_MS);
    expect(tracker.update(T0 + 2_000 + WAITING_SETTLE_MS - 1, [1], []).fire).toEqual([]);
    expect(tracker.update(T0 + 2_000 + WAITING_SETTLE_MS, [1], [])).toEqual({ fire: [{ kind: "waiting", conversationId: 1 }], nextCheckAt: null });
    // 一直在等：不再提醒
    expect(tracker.update(T0 + 60_000, [1], []).fire).toEqual([]);
    // 退出后再进来：又要停稳 3 秒，再提醒一次
    tracker.update(T0 + 61_000, [], []);
    tracker.update(T0 + 62_000, [1], []);
    expect(tracker.update(T0 + 62_000 + WAITING_SETTLE_MS, [1], []).fire).toEqual([{ kind: "waiting", conversationId: 1 }]);
  });

  it("新提问马上提醒，同一条只提醒一次", () => {
    const tracker = new ReminderTracker<number>();
    tracker.update(T0, [], [{ conversationId: 1, messageId: 5 }]);
    expect(tracker.update(T0 + 1, [], [{ conversationId: 1, messageId: 5 }, { conversationId: 1, messageId: 6 }]).fire).toEqual([{ kind: "ask", conversationId: 1 }]);
    expect(tracker.update(T0 + 2, [], [{ conversationId: 1, messageId: 6 }]).fire).toEqual([]);
  });
});

describe("reminderPayload：推送只带标题，不带正文", () => {
  const state = reminderStateFrom(snapshot());

  it("标题“设备 · 项目经理：等你 / 等你确定”，点开回到那个对话，同一个项目经理同一个 tag", () => {
    const self = { id: DEVICE, name: "东京", self: true };
    expect(reminderPayload(state, { kind: "waiting", conversationId: 1 }, self)).toEqual({ title: "东京 · 小林：等你", url: "/#/c/1", tag: `${DEVICE}:pm-1` });
    expect(reminderPayload(state, { kind: "ask", conversationId: 1 }, self)).toEqual({ title: "东京 · 小林：等你确定", url: "/#/c/1", tag: `${DEVICE}:ask-pm-1` });
  });

  it("别的设备的对话：网址带 #/d/<设备>/", () => {
    expect(reminderPayload(state, { kind: "waiting", conversationId: 2 }, { id: DEVICE, name: "Mac", self: false })?.url).toBe(`/#/d/${DEVICE}/c/2`);
  });

  it("只有这三个字段（没有正文字段），标题里不带消息内容", () => {
    const payload = reminderPayload(state, { kind: "waiting", conversationId: 1 }, { id: DEVICE, name: "东京", self: true });
    expect(Object.keys(payload ?? {}).sort()).toEqual(["tag", "title", "url"]);
    expect(JSON.stringify(payload)).not.toContain("做完了");
  });

  it("找不到对话：不推", () => {
    expect(reminderPayload(state, { kind: "waiting", conversationId: 99 }, { id: DEVICE, name: "东京", self: true })).toBeNull();
  });
});
