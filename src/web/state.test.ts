import { describe, expect, it } from "vitest";
import { parseServerMessage, reconnectDelay } from "./connection.ts";
import { formatArchiveRemaining, formatTime } from "./format.ts";
import { CHANGE_TYPES, PM_ARCHIVE_RETENTION_MS, applyReminderChange, pendingAsks, reminderStateFrom, waitingConversations, type ScheduleRecord } from "../shared/index.ts";
import { groupMessages, isWaitingForQuota, listConversations, sessionOf, workersOf } from "./selectors.ts";
import { MAX_LIVE_MESSAGES, applyChange, initialState, reducer, upsertMessage, type HubState } from "./state.ts";
import {
  changeOf,
  makeConvSnapshot,
  makeFolder,
  makeMessage,
  makePm,
  makeProject,
  makeSession,
  makeSnapshot,
  makeSystemMessage,
  makeToolMessage,
  makeUserMessage,
  makeWorkerLine,
  messageChange,
} from "./test-utils.ts";

function loaded(over: Parameters<typeof makeSnapshot>[0] = {}): HubState {
  return reducer(initialState, { type: "loaded", snapshot: makeSnapshot(over) });
}

describe("upsertMessage", () => {
  const a = makeMessage({ id: 1 });
  const c = makeMessage({ id: 3 });
  it("按编号插到正确的位置", () => {
    expect(upsertMessage([a, c], makeMessage({ id: 2 })).map((m) => m.id)).toEqual([1, 2, 3]);
    expect(upsertMessage([a, c], makeMessage({ id: 4 })).map((m) => m.id)).toEqual([1, 3, 4]);
    expect(upsertMessage([a, c], makeMessage({ id: 0 })).map((m) => m.id)).toEqual([0, 1, 3]);
  });
  it("同一个编号原地替换，不改原数组", () => {
    const list = [a, c];
    const updated = upsertMessage(list, makeMessage({ id: 3, text: "新" }));
    expect(updated.map((m) => m.text)).toEqual([a.text, "新"]);
    expect(list[1]).toBe(c);
  });
});

describe("applyChange", () => {
  it("seq 不比已有的大就忽略，同一条推两次只生效一次", () => {
    const s0 = loaded({ seq: 10 });
    const change = messageChange(11, "message.created", makeMessage({ id: 5 }));
    const s1 = applyChange(s0, change);
    expect(s1.seq).toBe(11);
    expect(applyChange(s1, change)).toBe(s1);
    expect(applyChange(s1, messageChange(3, "message.created", makeMessage({ id: 6 })))).toBe(s1);
  });

  it("用户消息的真消息到了，对应的临时消息被去掉", () => {
    let s = loaded({ seq: 10 });
    s = reducer(s, {
      type: "pendingAdd",
      pending: { clientId: "abc", conversationId: 1, text: "hi", attachments: [], phase: "sending", createdAt: 1 },
    });
    s = applyChange(s, messageChange(11, "message.created", makeUserMessage({ id: 7, dedupeKey: "client:1:abc" })));
    expect(s.pending).toEqual([]);
  });

  it("不认识的对话：只推进 seq，不改消息", () => {
    const s0 = loaded();
    const s1 = applyChange(s0, messageChange(11, "message.created", makeMessage({ id: 5, conversationId: 99 })));
    expect(s1.conversations).toBe(s0.conversations);
  });

  it("长时间运行累积消息：未翻页的对话最多保留最近 MAX_LIVE_MESSAGES 条并标记 hasMore，已翻页的对话不截断", () => {
    let s = loaded({
      seq: 0,
      conversations: [
        makeConvSnapshot([], { conversation: { id: 1, pmId: 1 }, hasMore: false }),
        makeConvSnapshot([makeMessage({ id: 10, conversationId: 2 })], { conversation: { id: 2, pmId: 1 }, hasMore: true }),
      ],
    });
    // 对话 2 翻过页
    s = reducer(s, {
      type: "olderDone",
      conversationId: 2,
      messages: [makeMessage({ id: 1, conversationId: 2 })],
      hasMore: false,
    });
    const total = MAX_LIVE_MESSAGES + 25;
    let seq = 0;
    for (let i = 1; i <= total; i++) {
      s = applyChange(s, messageChange(++seq, "message.created", makeToolMessage({ id: i, conversationId: 1 })));
      s = applyChange(s, messageChange(++seq, "message.created", makeToolMessage({ id: 10 + i, conversationId: 2 })));
    }
    expect(s.conversations[1]?.messages).toHaveLength(MAX_LIVE_MESSAGES);
    expect(s.conversations[1]?.messages[0]?.id).toBe(26);
    expect(s.conversations[1]?.hasMore).toBe(true);
    // 已主动翻页的对话保留全部已加载消息
    expect(s.conversations[2]?.messages).toHaveLength(total + 2);
  });

  it("olderStart 在途期间收到实时新消息不截断头部，随后 olderDone 返回时消息连续无断层", () => {
    let s = loaded({
      seq: 0,
      conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1 }, hasMore: false })],
    });
    const total = MAX_LIVE_MESSAGES + 25;
    let seq = 0;
    for (let i = 1; i <= total; i++) {
      s = applyChange(s, messageChange(++seq, "message.created", makeToolMessage({ id: i, conversationId: 1 })));
    }
    // 此时保留的是 26..225，用户向上滚动触发 olderStart（before = 26）
    expect(s.conversations[1]?.messages[0]?.id).toBe(26);
    s = reducer(s, { type: "olderStart", conversationId: 1 });
    expect(s.older[1]).toBe("loading");

    // olderDone 返回前收到实时新消息 226..228，头部不得截断
    for (let i = total + 1; i <= total + 3; i++) {
      s = applyChange(s, messageChange(++seq, "message.created", makeToolMessage({ id: i, conversationId: 1 })));
    }
    expect(s.conversations[1]?.messages[0]?.id).toBe(26);
    expect(s.conversations[1]?.messages.at(-1)?.id).toBe(228);
    expect(s.conversations[1]?.messages).toHaveLength(MAX_LIVE_MESSAGES + 3);

    // 随后 olderDone 返回 1..25，合并后 1..228 连续无丢失
    const earlier = Array.from({ length: 25 }, (_, idx) => makeToolMessage({ id: idx + 1, conversationId: 1 }));
    s = reducer(s, {
      type: "olderDone",
      conversationId: 1,
      messages: earlier,
      hasMore: false,
    });
    expect(s.conversations[1]?.messages.map((m) => m.id)).toEqual(Array.from({ length: 228 }, (_, idx) => idx + 1));
    expect(s.conversations[1]?.hasMore).toBe(false);
  });
});

describe("loaded", () => {
  it("新快照里已经有的用户消息，对应的临时消息被去掉；没有的留着", () => {
    let s = loaded();
    for (const clientId of ["a", "b"]) {
      s = reducer(s, {
        type: "pendingAdd",
        pending: { clientId, conversationId: 1, text: clientId, attachments: [], phase: "failed", createdAt: 1 },
      });
    }
    s = reducer(s, {
      type: "loaded",
      snapshot: makeSnapshot({
        seq: 20,
        conversations: [makeConvSnapshot([makeUserMessage({ id: 1, dedupeKey: "client:1:a" })])],
      }),
    });
    expect(s.pending.map((p) => p.clientId)).toEqual(["b"]);
    expect(s.seq).toBe(20);
  });

  it("重复拉取失败不会把已经显示的界面清掉", () => {
    const s = loaded();
    expect(reducer(s, { type: "loadFailed", unauthorized: false }).phase).toBe("ready");
    expect(reducer(initialState, { type: "loadFailed", unauthorized: false }).phase).toBe("error");
    expect(reducer(s, { type: "loadFailed", unauthorized: true }).phase).toBe("unauthorized");
  });
});

describe("olderDone", () => {
  it("已经有的不重复加，按编号排好", () => {
    const s0 = loaded({
      conversations: [makeConvSnapshot([makeMessage({ id: 5 }), makeMessage({ id: 6 })], { hasMore: true })],
    });
    const s1 = reducer(s0, {
      type: "olderDone",
      conversationId: 1,
      messages: [makeMessage({ id: 3 }), makeMessage({ id: 4 }), makeMessage({ id: 5 })],
      hasMore: false,
    });
    expect(s1.conversations[1]?.messages.map((m) => m.id)).toEqual([3, 4, 5, 6]);
    expect(s1.conversations[1]?.hasMore).toBe(false);
  });
});

describe("groupMessages：一轮一轮", () => {
  it("用户说一句之后 agent 的文字、工具调用、派出 Worker 合成一轮；操作进 work，文字进 parts", () => {
    const items = groupMessages([
      makeUserMessage({ id: 1 }),
      makeToolMessage({ id: 2 }),
      makeWorkerLine({ id: 3, line: { event: "started" } }),
      makeMessage({ id: 4 }),
      makeToolMessage({ id: 5 }),
      makeMessage({ id: 6 }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["message", "turn"]);
    const turn = items[1]!;
    if (turn.kind !== "turn") throw new Error("not a turn");
    expect(turn.work.map((m) => m.id)).toEqual([2, 3, 5]);
    expect(turn.parts.map((m) => m.id)).toEqual([4, 6]);
    // 从用户那句（11s）到最后一条（16s）
    expect(turn.endedAt - turn.startedAt).toBe(5_000);
  });

  it("Worker 的汇报、到点的定时任务把轮切开；新一轮从上一轮最后一条和这句话里晚的那个算起", () => {
    const items = groupMessages([
      makeMessage({ id: 1 }),
      makeWorkerLine({ id: 2, line: { event: "report", status: "done", summary: "好了" } }),
      makeMessage({ id: 3 }),
      makeSystemMessage({ id: 4, event: { event: "schedule.run", scheduleId: 1, name: "日报", scheduledAt: 0, catchUp: false } }),
      makeToolMessage({ id: 5 }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["turn", "message", "turn", "message", "turn"]);
    const first = items[0]!;
    expect(first.kind === "turn" && first.endedAt - first.startedAt).toBe(0);
  });

  it("一轮中间的系统行留在原位置；末尾的挪出去单独显示；不在一轮里的派出 Worker 单独显示", () => {
    const items = groupMessages([
      makeWorkerLine({ id: 1, line: { event: "ended" } }),
      makeMessage({ id: 2 }),
      makeSystemMessage({ id: 3 }),
      makeMessage({ id: 4 }),
      makeSystemMessage({ id: 5 }),
    ]);
    expect(items.map((i) => (i.kind === "turn" ? `turn:${i.parts.map((m) => m.id).join(",")}` : `message:${i.message.id}`))).toEqual([
      "message:1",
      "turn:2,3,4",
      "message:5",
    ]);
  });

  it("换新会话：交接请求排队时就来了、压到换代才交给新会话的 Worker 汇报，显示在分隔线下面；旧会话处理的留在上面（审查 #113 第 8 条）", () => {
    const shown = (items: ReturnType<typeof groupMessages>) => items.map((i) => (i.kind === "turn" ? `turn:${i.parts.map((m) => m.id).join(",")}` : `message:${i.message.id}`));
    const items = groupMessages([
      // 用户点开新会话时项目经理在忙（1、2 那一轮，旧会话）；交接请求 3 排着，这时来了 Worker 汇报 4（压着）
      makeUserMessage({ id: 1, sessionId: 1, status: "replied" }),
      makeSystemMessage({ id: 3, sessionId: 1, status: "replied", text: "【系统】请写交接", event: { event: "handover.requested", sessionId: 1 } }),
      makeWorkerLine({ id: 4, sessionId: 2, status: "replied", line: { event: "report", status: "done", summary: "好了" } }),
      makeMessage({ id: 5, sessionId: 1 }),
      // 6 起是写交接那一轮（turnStartId 5），换代后 4 交给新会话 2，回了 8
      makeMessage({ id: 6, sessionId: 1, meta: { handover: true } }),
      makeSystemMessage({ id: 7, text: "交接", event: { event: "session.renewed", sessionId: 2, fromSessionId: 1, turnStartId: 5 } }),
      makeMessage({ id: 8, sessionId: 2 }),
    ]);
    expect(shown(items)).toEqual(["message:1", "turn:5", "message:7", "message:4", "turn:8"]);
  });
});

describe("parseServerMessage", () => {
  it("认识 resync 和四种变化", () => {
    expect(parseServerMessage('{"type":"resync"}')).toEqual({ type: "resync" });
    expect(parseServerMessage('{"seq":3,"type":"health.updated","data":{}}')).not.toBeNull();
  });
  it("坏的、不认识的返回 null", () => {
    for (const bad of ["x", "null", "[]", '{"type":"x","seq":1}', '{"type":"message.created"}', 5, undefined]) {
      expect(parseServerMessage(bad)).toBeNull();
    }
  });
});

describe("reconnectDelay", () => {
  it("1、2、4、8 秒，最多 10 秒", () => {
    expect([0, 1, 2, 3, 4, 20].map(reconnectDelay)).toEqual([1000, 2000, 4000, 8000, 10000, 10000]);
  });
});

describe("formatTime", () => {
  const now = new Date(2026, 10, 3, 12, 0);
  it("今天时分，今年月日，更早带年", () => {
    expect(formatTime(new Date(2026, 10, 3, 9, 5).getTime(), now)).toBe("09:05");
    expect(formatTime(new Date(2026, 9, 20, 9, 5).getTime(), now)).toBe("10/20");
    expect(formatTime(new Date(2025, 0, 2, 9, 5).getTime(), now)).toBe("2025/1/2");
  });
});

describe("M2 新的变化类型", () => {
  it("pm.created / pm.updated：按编号加入或替换项目经理", () => {
    const s0 = loaded({ pms: [makePm({ id: 1, name: "小林" })] });
    const s1 = applyChange(s0, changeOf(11, "pm.created", { pm: makePm({ id: 2, name: "阿周" }) }));
    expect(s1.pms.map((p) => p.name)).toEqual(["小林", "阿周"]);
    const s2 = applyChange(s1, changeOf(12, "pm.updated", { pm: makePm({ id: 2, name: "阿周", mode: "hands_on" }) }));
    expect(s2.pms).toHaveLength(2);
    expect(s2.pms[1]?.mode).toBe("hands_on");
    // 推两次（补发）不会重复
    expect(applyChange(s2, changeOf(11, "pm.created", { pm: makePm({ id: 2 }) }))).toBe(s2);
    expect(applyChange(s1, changeOf(13, "pm.created", { pm: makePm({ id: 2, name: "阿周" }) })).pms).toHaveLength(2);
  });

  it("pm.updated：记一次修订号，资料页据此重新拉性格设定；别的项目经理不受影响", () => {
    const s0 = loaded();
    const s1 = applyChange(s0, changeOf(11, "pm.updated", { pm: makePm({ id: 1 }) }));
    const s2 = applyChange(s1, changeOf(12, "pm.updated", { pm: makePm({ id: 1 }) }));
    expect(s0.personaRev[1] ?? 0).toBe(0);
    expect(s1.personaRev[1]).toBe(1);
    expect(s2.personaRev[1]).toBe(2);
    expect(s2.personaRev[2]).toBeUndefined();
  });

  it("project.created：按编号加入项目；重复推不重复加", () => {
    const s0 = loaded();
    const s1 = applyChange(s0, changeOf(11, "project.created", { project: makeProject({ id: 1, name: "foo", pmId: 1 }) }));
    expect(s1.projects.map((p) => p.name)).toEqual(["foo"]);
    const s2 = applyChange(s1, changeOf(12, "project.created", { project: makeProject({ id: 1, name: "foo", pmId: 1 }) }));
    expect(s2.projects).toHaveLength(1);
  });

  it("folders.updated：只换这个项目的文件夹，别的项目的不动；空列表表示全移除", () => {
    const s0 = loaded({
      folders: [makeFolder({ id: 1, projectId: 1, path: "/a" }), makeFolder({ id: 2, projectId: 2, path: "/b" })],
    });
    const s1 = applyChange(s0, changeOf(11, "folders.updated", { projectId: 1, folders: [makeFolder({ id: 3, projectId: 1, path: "/c" })] }));
    expect(s1.folders.map((f) => f.path).toSorted()).toEqual(["/b", "/c"]);
    const s2 = applyChange(s1, changeOf(12, "folders.updated", { projectId: 1, folders: [] }));
    expect(s2.folders.map((f) => f.path)).toEqual(["/b"]);
  });

  it("conversation.created：加一个空对话；已经有的对话（补发）不被清空", () => {
    const s0 = loaded({ conversations: [makeConvSnapshot([makeMessage({ id: 1 })])] });
    const group = { ...makeConvSnapshot([]).conversation, id: 2, pmId: 2, title: "阿周" };
    const s1 = applyChange(s0, changeOf(11, "conversation.created", { conversation: group }));
    expect(s1.conversations[2]).toEqual({ conversation: group, messages: [], hasMore: false });
    const s2 = applyChange(
      applyChange(s1, messageChange(12, "message.created", makeMessage({ id: 9, conversationId: 2 }))),
      changeOf(13, "conversation.created", { conversation: group }),
    );
    expect(s2.conversations[2]?.messages).toHaveLength(1);
  });

  it("conversation.purged：Worker 对话的消息清空、打上 purgedAt、没有更早的；不认识的对话只推进 seq；别的对话不动", () => {
    const worker = { ...makeConvSnapshot([]).conversation, id: 30, kind: "worker" as const, pmId: 1, title: "修 X" };
    const s0 = loaded({
      conversations: [makeConvSnapshot([makeMessage({ id: 1 })]), { conversation: worker, messages: [makeMessage({ id: 5, conversationId: 30 })], hasMore: true }],
    });
    const s1 = applyChange(s0, changeOf(11, "conversation.purged", { conversationId: 30, purgedAt: 1234 }));
    expect(s1.conversations[30]).toEqual({ conversation: { ...worker, purgedAt: 1234 }, messages: [], hasMore: false });
    expect(s1.conversations[1]).toBe(s0.conversations[1]);
    const s2 = applyChange(s1, changeOf(12, "conversation.purged", { conversationId: 99, purgedAt: 1 }));
    expect(s2.seq).toBe(12);
    expect(s2.conversations).toBe(s1.conversations);
  });

  it("session.created：加入会话；同一个会话编号替换", () => {
    const s0 = loaded();
    const s1 = applyChange(s0, changeOf(11, "session.created", { session: makeSession({ sessionId: 5, conversationId: 1 }) }));
    expect(s1.sessions.map((x) => x.sessionId)).toEqual([5]);
    const s2 = applyChange(s1, changeOf(12, "session.created", { session: makeSession({ sessionId: 5, conversationId: 1, activity: "working" }) }));
    expect(s2.sessions).toHaveLength(1);
    expect(s2.sessions[0]?.activity).toBe("working");
  });

  it("每种新类型都推进 seq；过期的忽略", () => {
    for (const type of ["pm.created", "pm.updated", "project.created", "folders.updated", "conversation.created", "session.created"] as const) {
      expect(CHANGE_TYPES).toContain(type);
    }
    const s0 = loaded({ seq: 10 });
    const s1 = applyChange(s0, changeOf(11, "project.created", { project: makeProject() }));
    expect(s1.seq).toBe(11);
    expect(applyChange(s1, changeOf(11, "project.created", { project: makeProject({ id: 9 }) }))).toBe(s1);
  });

  it("parseServerMessage 认识新的变化类型", () => {
    for (const type of CHANGE_TYPES) expect(parseServerMessage(JSON.stringify({ seq: 1, type, data: {} }))).not.toBeNull();
  });

  it("快照带着 projects、folders", () => {
    const s = loaded({ projects: [makeProject()], folders: [makeFolder()] });
    expect(s.projects).toHaveLength(1);
    expect(s.folders).toHaveLength(1);
    // 重新拉快照整个换掉
    expect(reducer(s, { type: "loaded", snapshot: makeSnapshot({ seq: 30 }) }).projects).toEqual([]);
  });

  it("已按需加载过消息的历史 Worker 对话，重拉快照（messages 为空且 hasMore 为 true）时保留已加载的消息；未加载前收到实时消息保持空列表等点开时一次拉齐", () => {
    const workerConv = { id: 30, kind: "worker" as const, pmId: 1, projectId: 1, title: "修 X", createdAt: 1 };
    const endedSession = makeSession({ sessionId: 2, conversationId: 30, status: "ended" });
    const s0 = loaded({
      conversations: [{ conversation: workerConv, messages: [], hasMore: true }],
      sessions: [endedSession],
    });
    const liveMsg = makeMessage({ id: 102, conversationId: 30, text: "实时消息" });
    const sBeforeLoad = applyChange(s0, messageChange(11, "message.created", liveMsg));
    expect(sBeforeLoad.conversations[30]?.messages).toEqual([]);
    expect(sBeforeLoad.conversations[30]?.hasMore).toBe(true);

    const m1 = makeMessage({ id: 101, conversationId: 30, text: "历史消息" });
    const s1 = reducer(sBeforeLoad, { type: "olderDone", conversationId: 30, messages: [m1, liveMsg], hasMore: false });
    expect(s1.conversations[30]?.messages).toEqual([m1, liveMsg]);
    expect(s1.conversations[30]?.hasMore).toBe(false);

    const resynced = reducer(s1, {
      type: "loaded",
      snapshot: makeSnapshot({
        seq: 50,
        conversations: [{ conversation: workerConv, messages: [], hasMore: true }],
        sessions: [endedSession],
      }),
    });
    expect(resynced.conversations[30]?.messages).toEqual([m1, liveMsg]);
    expect(resynced.conversations[30]?.hasMore).toBe(false);
  });

  it("断线前还在跑的 Worker，断线期间出了最终回复并收工：重拉快照（messages 为空、hasMore 为 true）丢掉缺最终回复的旧消息，等 MessageList 重新拉最新一页", () => {
    const workerConv = { id: 30, kind: "worker" as const, pmId: 1, projectId: 1, title: "修 X", createdAt: 1 };
    const [m1, m2] = [1, 2].map((id) => makeMessage({ id, conversationId: 30 }));
    const s0 = loaded({
      seq: 10,
      conversations: [{ conversation: workerConv, messages: [m1!, m2!], hasMore: false }],
      sessions: [makeSession({ sessionId: 2, conversationId: 30, status: "running" })],
    });
    expect(s0.conversations[30]?.messages.map((m) => m.id)).toEqual([1, 2]);

    // 断线期间服务端多了 [3, 4] 并收工；快照对已收工 Worker 省略消息
    const resynced = reducer(s0, {
      type: "loaded",
      snapshot: makeSnapshot({
        seq: 50,
        conversations: [{ conversation: workerConv, messages: [], hasMore: true }],
        sessions: [makeSession({ sessionId: 2, conversationId: 30, status: "ended" })],
      }),
    });
    expect(resynced.seq).toBe(50);
    expect(resynced.conversations[30]?.messages).toEqual([]);
    expect(resynced.conversations[30]?.hasMore).toBe(true);
    expect(resynced.older[30]).toBeUndefined();

    // MessageList 自动拉最新一页，拿到完整的 [1..4]
    const [m3, m4] = [3, 4].map((id) => makeMessage({ id, conversationId: 30 }));
    const started = reducer(resynced, { type: "olderStart", conversationId: 30 });
    const done = reducer(started, { type: "olderDone", conversationId: 30, messages: [m1!, m2!, m3!, m4!], hasMore: false });
    expect(done.conversations[30]?.messages.map((m) => m.id)).toEqual([1, 2, 3, 4]);
  });

  it("没有会话记录的对话不算已收工：重拉快照省略消息时不保留旧消息", () => {
    const workerConv = { id: 30, kind: "worker" as const, pmId: 1, projectId: 1, title: "修 X", createdAt: 1 };
    const s0 = loaded({ conversations: [{ conversation: workerConv, messages: [makeMessage({ id: 1, conversationId: 30 })], hasMore: false }] });
    const resynced = reducer(s0, {
      type: "loaded",
      snapshot: makeSnapshot({ seq: 50, conversations: [{ conversation: workerConv, messages: [], hasMore: true }] }),
    });
    expect(resynced.conversations[30]?.messages).toEqual([]);
    expect(resynced.conversations[30]?.hasMore).toBe(true);
  });
});

describe("重试失败的消息的状态", () => {
  it("retryStart 标“重试中”，retryFailed 标出错，收到不再是 failed 的更新就清掉", () => {
    let s = loaded({ conversations: [makeConvSnapshot([makeUserMessage({ id: 5, status: "failed", failureReason: "x" })])] });
    s = reducer(s, { type: "retryStart", messageId: 5 });
    expect(s.retry[5]).toBe("retrying");
    s = reducer(s, { type: "retryFailed", messageId: 5 });
    expect(s.retry[5]).toBe("error");
    s = reducer(s, { type: "retryStart", messageId: 5 });
    // 仍是 failed 的更新（比如别的字段变了）不清
    s = applyChange(s, messageChange(11, "message.updated", makeUserMessage({ id: 5, status: "failed", failureReason: "x" })));
    expect(s.retry[5]).toBe("retrying");
    s = applyChange(s, messageChange(12, "message.updated", makeUserMessage({ id: 5, status: "queued" })));
    expect(s.retry[5]).toBeUndefined();
  });

  it("重新拉快照：只留下仍然 failed 的消息的状态", () => {
    let s = loaded();
    s = reducer(s, { type: "retryStart", messageId: 5 });
    s = reducer(s, { type: "retryStart", messageId: 6 });
    s = reducer(s, {
      type: "loaded",
      snapshot: makeSnapshot({
        seq: 30,
        conversations: [
          makeConvSnapshot([makeUserMessage({ id: 5, status: "failed" }), makeUserMessage({ id: 6, status: "queued" })]),
        ],
      }),
    });
    expect(s.retry).toEqual({ 5: "retrying" });
  });
});

describe("selectors", () => {
  it("sessionOf：一个对话有几代会话时取 generation 最大的，不看会话编号和先后", () => {
    const s = loaded({
      sessions: [
        makeSession({ sessionId: 9, conversationId: 1, generation: 1 }),
        makeSession({ sessionId: 3, conversationId: 1, generation: 3 }),
        makeSession({ sessionId: 7, conversationId: 1, generation: 2 }),
        makeSession({ sessionId: 20, conversationId: 2, generation: 1 }),
      ],
    });
    expect(sessionOf(s, 1)?.sessionId).toBe(3);
    expect(sessionOf(s, 2)?.sessionId).toBe(20);
    expect(sessionOf(s, 99)).toBeNull();
  });

  it("isWaitingForQuota：只有 rejected 算；allowed_warning、allowed、没有额度信息都不算", () => {
    const rl = (status: string) => makeSession({ rateLimit: { status, resetsAt: null, windows: {} } });
    expect(isWaitingForQuota(rl("rejected"))).toBe(true);
    expect(isWaitingForQuota(rl("allowed_warning"))).toBe(false);
    expect(isWaitingForQuota(rl("allowed"))).toBe(false);
    expect(isWaitingForQuota(makeSession())).toBe(false);
    expect(isWaitingForQuota(null)).toBe(false);
  });

  it("listConversations：每个项目经理一行，用它的名字；项目按对话找，文件夹主文件夹在前；按最后一条消息排序", () => {
    const s = loaded({
      pms: [makePm({ id: 1, name: "小林" }), makePm({ id: 2, name: "阿周" })],
      projects: [makeProject({ id: 1, name: "foo", pmId: 2, conversationId: 2 })],
      folders: [makeFolder({ id: 2, projectId: 1, path: "/work/docs", isMain: false }), makeFolder({ id: 1, projectId: 1, path: "/work/foo" })],
      conversations: [
        makeConvSnapshot([makeMessage({ id: 1, createdAt: 5_000 })], { conversation: { id: 1, pmId: 1 } }),
        makeConvSnapshot([makeMessage({ id: 2, conversationId: 2, createdAt: 9_000 })], { conversation: { id: 2, pmId: 2, title: "旧标题" } }),
      ],
    });
    const [zhou, lin] = listConversations(s);
    expect(zhou).toMatchObject({ id: 2, name: "阿周", project: { name: "foo" } });
    expect(zhou?.folders.map((f) => f.path)).toEqual(["/work/foo", "/work/docs"]);
    expect(lin).toMatchObject({ id: 1, name: "小林", project: null });
    expect(lin?.folders).toEqual([]);
  });

  it("workersOf：进行中的按编号；已收工的最近收工的在前，没有收工那一行的按编号倒序排在后面", () => {
    const end = (id: number, workerConversationId: number, createdAt: number, event: "ended" | "worktree_failed" = "ended") =>
      makeWorkerLine({ id, createdAt, line: { workerId: workerConversationId, workerConversationId, event } });
    const s = loaded({
      conversations: [
        makeConvSnapshot([end(1, 31, 5_000), end(2, 32, 9_000), end(3, 33, 7_000, "worktree_failed")]),
        ...[30, 31, 32, 33, 34, 35, 36].map((id) => makeConvSnapshot([], { conversation: { id, kind: "worker", pmId: 1 } })),
      ],
      sessions: [35, 36].map((conversationId) => makeSession({ sessionId: conversationId, conversationId, status: "ended" })),
    });
    expect(workersOf(s, 1).map((w) => [w.conversationId, w.ended])).toEqual([
      [30, false],
      [34, false],
      [32, true],
      [33, true],
      [31, true],
      [36, true],
      [35, true],
    ]);
  });
});

describe("定时任务（M6）：快照带上，变化实时更新", () => {
  const schedule = (id: number, over: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
    id,
    pmId: 1,
    name: "日报",
    kind: "daily",
    atTime: "09:00",
    everyMinutes: null,
    prompt: "写日报",
    enabled: true,
    nextRunAt: 5_000,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    lastMessageId: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  });

  it("快照里的定时任务进状态；schedule.updated 按编号新增或替换；schedule.removed 删掉", () => {
    let s = loaded({ schedules: [schedule(1)] });
    expect(s.schedules.map((x) => x.id)).toEqual([1]);
    s = applyChange(s, changeOf(11, "schedule.updated", { schedule: schedule(2, { name: "巡检" }) }));
    expect(s.schedules.map((x) => x.name)).toEqual(["日报", "巡检"]);
    s = applyChange(s, changeOf(12, "schedule.updated", { schedule: schedule(1, { enabled: false }) }));
    expect(s.schedules.map((x) => [x.id, x.enabled])).toEqual([
      [1, false],
      [2, true],
    ]);
    s = applyChange(s, changeOf(13, "schedule.removed", { scheduleId: 1 }));
    expect(s.schedules.map((x) => x.id)).toEqual([2]);
    // 重新拉快照以快照为准
    expect(reducer(s, { type: "loaded", snapshot: makeSnapshot({ schedules: [] }) }).schedules).toEqual([]);
  });
});

describe("归档项目经理状态与提醒（pm.removed、formatArchiveRemaining、提醒过滤）", () => {
  it("formatArchiveRemaining：向上取整剩余天数，最少显示 1 天后删除", () => {
    const t0 = 1_000_000;
    expect(formatArchiveRemaining(t0, t0)).toBe("Deletes in 7d");
    expect(formatArchiveRemaining(t0, t0 + 4 * 24 * 60 * 60 * 1000)).toBe("Deletes in 3d");
    expect(formatArchiveRemaining(t0, t0 + PM_ARCHIVE_RETENTION_MS - 1_000)).toBe("Deletes in 1d");
    expect(formatArchiveRemaining(t0, t0 + PM_ARCHIVE_RETENTION_MS + 10_000)).toBe("Deletes in 1d");
  });

  it("applyChange 处理 pm.removed：移除该 PM 及其项目、文件夹、对话、定时任务，不影响其他 PM", () => {
    const s0 = loaded({
      pms: [makePm({ id: 1, name: "小林", archivedAt: 1000 }), makePm({ id: 2, name: "阿周" })],
      projects: [makeProject({ id: 10, pmId: 1, conversationId: 1 }), makeProject({ id: 20, pmId: 2, conversationId: 2 })],
      folders: [makeFolder({ id: 100, projectId: 10, path: "/lin" }), makeFolder({ id: 200, projectId: 20, path: "/zhou" })],
      conversations: [
        makeConvSnapshot([makeMessage({ id: 1, conversationId: 1 })], { conversation: { id: 1, pmId: 1 } }),
        makeConvSnapshot([], { conversation: { id: 30, kind: "worker", pmId: 1 } }),
        makeConvSnapshot([makeMessage({ id: 2, conversationId: 2 })], { conversation: { id: 2, pmId: 2 } }),
      ],
      schedules: [
        { id: 1, pmId: 1, name: "s1", kind: "daily", atTime: "09:00", everyMinutes: null, prompt: "p", enabled: false, nextRunAt: 1, lastRunAt: null, lastStatus: null, lastError: null, lastMessageId: null, createdAt: 1, updatedAt: 1 },
        { id: 2, pmId: 2, name: "s2", kind: "daily", atTime: "09:00", everyMinutes: null, prompt: "p", enabled: true, nextRunAt: 1, lastRunAt: null, lastStatus: null, lastError: null, lastMessageId: null, createdAt: 1, updatedAt: 1 },
      ],
    });
    const s1 = applyChange(s0, changeOf(11, "pm.removed", { pmId: 1 }));
    expect(s1.pms.map((p) => p.id)).toEqual([2]);
    expect(s1.projects.map((p) => p.id)).toEqual([20]);
    expect(s1.folders.map((f) => f.id)).toEqual([200]);
    expect(Object.keys(s1.conversations).map(Number)).toEqual([2]);
    expect(s1.schedules.map((s) => s.id)).toEqual([2]);
  });

  it("已归档 PM 的对话不计入 waitingConversations 和 pendingAsks；applyReminderChange 处理 pm.removed", () => {
    const askMsg = makeMessage({ id: 1, conversationId: 1, sender: "agent", createdAt: 5_000, meta: { needsUser: true } });
    const sActive = loaded({
      pms: [makePm({ id: 1, name: "小林", archivedAt: null })],
      conversations: [makeConvSnapshot([askMsg], { conversation: { id: 1, pmId: 1 } })],
    });
    expect(waitingConversations(sActive, {})).toEqual([1]);
    expect(pendingAsks(sActive, 1)).toHaveLength(1);

    const sArchived = applyChange(sActive, changeOf(11, "pm.updated", { pm: makePm({ id: 1, name: "小林", archivedAt: 6_000 }) }));
    expect(waitingConversations(sArchived, {})).toEqual([]);
    expect(pendingAsks(sArchived, 1)).toEqual([]);

    const r0 = reminderStateFrom(makeSnapshot({ pms: [makePm({ id: 1 }), makePm({ id: 2 })], conversations: [makeConvSnapshot([askMsg], { conversation: { id: 1, pmId: 1 } })] }));
    const r1 = applyReminderChange(r0, changeOf(11, "pm.removed", { pmId: 1 }));
    expect(r1.pms.map((p) => p.id)).toEqual([2]);
    expect(r1.conversations[1]).toBeUndefined();
  });
});
