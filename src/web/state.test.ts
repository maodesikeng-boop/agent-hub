import { describe, expect, it } from "vitest";
import { parseServerMessage, reconnectDelay } from "./connection.ts";
import { describeError, formatTime } from "./format.ts";
import { CHANGE_TYPES, type ScheduleRecord } from "../shared/index.ts";
import { groupMessages, isWaitingForQuota, listConversations, sessionOf } from "./selectors.ts";
import { applyChange, initialState, reducer, upsertMessage, type HubState } from "./state.ts";
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

describe("describeError", () => {
  it("认识的错误码显示中文，细节分开", () => {
    expect(describeError("claude_not_found: spawn claude ENOENT")).toEqual({
      label: "找不到 claude",
      detail: "spawn claude ENOENT",
    });
    expect(describeError("start_timeout")).toEqual({ label: "claude 启动超时", detail: "" });
  });
  it("不认识的原样", () => {
    expect(describeError("disk full: /tmp")).toEqual({ label: "disk full: /tmp", detail: "" });
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
