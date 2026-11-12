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
import { pendingDecisionsOf, type Change, type Message, type SessionState, type StateSnapshot, type TaskGraph } from "./index.ts";
import {
  ReminderTracker,
  WAITING_SETTLE_MS,
  applyReminderChange,
  askingConversations,
  pendingAsks,
  reminderPayload,
  reminderStateFrom,
  routerReminderSummary,
  unreadRouterReports,
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

  it("Worker 超时静默触发消息（worker.max_time_exceeded）算安静消息，不把会话标成异常或改变等你状态，PM 随后回复照常触发等你", () => {
    const trigger = makeMessage({
      id: 3,
      sender: "system",
      kind: "text",
      status: "replied",
      text: "【系统】【Worker #1 · 修 X 已超过最大时间（20m）】...",
      meta: { event: "worker.max_time_exceeded", workerId: 1, workerConversationId: 30, maxTimeMs: 1_200_000 },
      createdAt: T0 - 2_000,
    });
    // 只有用户消息 + 超时触发消息时，最后一条非静默消息仍是用户的，不算“等你”
    const beforeReply = reminderStateFrom(snapshot({ pm1: [makeUserMessage({ id: 1, createdAt: T0 - 5_000 }), trigger] }));
    expect(waitingConversations(beforeReply, {})).toEqual([]);

    // PM 随后给用户回复了进展，且 Worker 也闲下来时，正常算“等你”
    const pmReply = makeMessage({ id: 4, text: "我刚看了一眼 #1，它在收尾", createdAt: T0 - 1_000 });
    const afterReply = reminderStateFrom(snapshot({ pm1: [makeUserMessage({ id: 1, createdAt: T0 - 5_000 }), trigger, pmReply] }));
    expect(waitingConversations(afterReply, {})).toEqual([1]);
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

  it("Worker 对话不保存消息：Worker 发消息不会更换 conversations 引用（避免守护进程推送白算）", () => {
    const snap = makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      conversations: [
        makeConvSnapshot([ask({ id: 99, conversationId: 30 })], { conversation: makeWorkerConversation() }),
      ],
    });
    const state = reminderStateFrom(snap);
    expect(state.conversations[30]?.messages).toEqual([]);
    expect(pendingAsks(state, 30)).toEqual([]);
    const afterCreate = applyReminderChange(state, change({ type: "message.created", data: { message: makeMessage({ id: 101, conversationId: 30 }) } }));
    expect(afterCreate.conversations).toBe(state.conversations);
    const afterUpdate = applyReminderChange(afterCreate, change({ type: "message.updated", data: { message: makeMessage({ id: 101, conversationId: 30, text: "改" }) } }));
    expect(afterUpdate.conversations).toBe(state.conversations);
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

describe("Router 跨设备汇总：PendingDecision 与未读 Router 汇报", () => {
  it("汇总跨设备待决项与未读汇报，不重复计入已有 hub ask 的对话，归档 PM 自动排除，副标题优先级严格为待决问题 > 未读摘要 > All clear", () => {
    const localSnap = snapshot({
      pm1: [ask({ id: 5 })],
    });
    localSnap.router = {
      ...localSnap.router,
      items: [
        {
          id: 11,
          kind: "decision",
          status: "pending",
          pmId: 1,
          projectId: null,
          conversationId: 1,
          question: "本地要先升级 schema 吗？",
          context: "迁移前确认",
          options: ["现在升", "等下周"],
          askMessageId: 5,
          resolution: null,
          createdAt: T0 - 1_000,
          updatedAt: T0 - 1_000,
        },
        {
          id: 12,
          kind: "report",
          status: "unread",
          pmId: 2,
          projectId: null,
          conversationId: 2,
          summary: "老马完成了第 1 波接口验收",
          links: [],
          createdAt: T0 - 500,
          updatedAt: T0 - 500,
        },
      ],
    };

    const remoteSnap = makeSnapshot({
      pms: [makePm({ id: 3, name: "阿青" }), makePm({ id: 4, name: "已归档", archivedAt: T0 - 10_000 })],
      conversations: [
        makeConvSnapshot([], { conversation: { id: 3, pmId: 3, title: "阿青" } }),
        makeConvSnapshot([], { conversation: { id: 4, pmId: 4, title: "已归档" } }),
      ],
      activeTaskGraphs: [
        {
          id: 9,
          projectId: 1,
          pmId: 3,
          conversationId: 3,
          title: "远端发版",
          status: "active",
          originMsgId: null,
          nodes: [
            {
              key: "gate-1",
              title: "切流确认",
              status: "waiting",
              waitingFor: "user",
              skipped: false,
              sortOrder: 0,
              activeWorkerId: null,
              workerIds: [],
              gateQuestion: "远端切 50% 流量？",
              gateOptions: ["切 50%", "先 10%"],
              gateSummaryMd: "监控全绿",
              gateRecommended: "先 10%",
              gateAskMessageId: null,
              decision: null,
              artifact: null,
              createdAt: T0,
              updatedAt: T0,
            },
          ],
          edges: [],
          createdAt: T0,
          updatedAt: T0,
          completedAt: null,
        },
      ],
      router: {
        settings: localSnap.router.settings,
        notes: [],
        commands: [],
        commandsHasMore: false,
        briefingsHasMore: false,
        items: [
          {
            id: 21,
            kind: "decision",
            status: "pending",
            pmId: 4,
            projectId: null,
            conversationId: 4,
            question: "归档 PM 的旧问题不应计入",
            context: "",
            options: ["A", "B"],
            askMessageId: null,
            resolution: null,
            createdAt: T0 + 100,
            updatedAt: T0 + 100,
          },
        ],
      },
    });

    const localState = reminderStateFrom(localSnap);
    const remoteState = reminderStateFrom(remoteSnap);

    // 对话 1 同时有 ask#5 与绑着 ask#5 的 decision#11，只算一次对话 1；对话 3 有无 ask 消息的 gate-1，也算在等你确定里
    expect([...askingConversations(localState)]).toEqual([1]);
    expect([...askingConversations(remoteState)]).toEqual([3]);
    expect(unreadRouterReports(localState).map((r) => r.id)).toEqual([12]);

    const both = routerReminderSummary([
      { deviceId: "local", state: localState },
      { deviceId: DEVICE, state: remoteState },
    ]);
    expect(both.pendingCount).toBe(2);
    expect(both.unreadReportCount).toBe(1);
    expect(both.subtitle).toBe("远端切 50% 流量？");

    // 拍板完所有待决项后，副标题降级到最新未读汇报摘要；再全部归档后回到 All clear
    const afterResolveLocal = applyReminderChange(
      localState,
      change({
        type: "router.item.updated",
        data: {
          item: {
            ...(localSnap.router.items[0] as Extract<(typeof localSnap.router.items)[number], { kind: "decision" }>),
            status: "resolved",
          },
        },
      }),
    );
    const afterResolveRemote = applyReminderChange(
      remoteState,
      change({
        type: "task_graph.updated",
        data: {
          graph: {
            ...remoteSnap.activeTaskGraphs[0]!,
            nodes: [{ ...remoteSnap.activeTaskGraphs[0]!.nodes[0]!, status: "done" }],
          },
        },
      }),
    );
    const onlyReport = routerReminderSummary([
      { deviceId: "local", state: afterResolveLocal },
      { deviceId: DEVICE, state: afterResolveRemote },
    ]);
    expect(onlyReport).toEqual({
      pendingCount: 0,
      unreadReportCount: 1,
      subtitle: "老马完成了第 1 波接口验收",
    });

    const archivedAll = applyReminderChange(
      afterResolveLocal,
      change({ type: "router.reports.archived_all", data: { archivedIds: [12], updatedAt: T0 + 200 } }),
    );
    expect(
      routerReminderSummary([
        { deviceId: "local", state: archivedAll },
        { deviceId: DEVICE, state: afterResolveRemote },
      ]),
    ).toEqual({
      pendingCount: 0,
      unreadReportCount: 0,
      subtitle: "All clear",
    });
  });

  it("跨端旧版本 Peer 兼容：未升级远端推来 waiting_user / skipped 旧节点时，提醒与待拍板投影正常识别且保持 === 引用稳定", () => {
    const legacyRemoteGraph = {
      id: 77,
      projectId: 1,
      pmId: 1,
      conversationId: 1,
      title: "远端旧版流水线",
      status: "active" as const,
      originMsgId: null,
      nodes: [
        {
          key: "gate-old",
          title: "远端旧门禁",
          kind: "gate",
          status: "waiting_user",
          sortOrder: 0,
          activeWorkerId: null,
          workerIds: [],
          artifact: null,
          gateQuestion: "远端旧门禁要不要放行？",
          gateOptions: ["放行", "暂缓"],
          gateSummaryMd: null,
          gateRecommended: "放行",
          gateAskMessageId: null,
          decision: null,
          createdAt: T0,
          updatedAt: T0,
        },
        {
          key: "skip-old",
          title: "已跳过的下游",
          kind: "piece",
          status: "skipped",
          sortOrder: 1,
          activeWorkerId: null,
          workerIds: [],
          artifact: null,
          gateQuestion: null,
          gateOptions: [],
          gateSummaryMd: null,
          gateRecommended: null,
          gateAskMessageId: null,
          decision: null,
          createdAt: T0,
          updatedAt: T0,
        },
        {
          key: "next-old",
          title: "真正受阻的下游",
          kind: "piece",
          status: "pending",
          sortOrder: 2,
          activeWorkerId: null,
          workerIds: [],
          artifact: null,
          gateQuestion: null,
          gateOptions: [],
          gateSummaryMd: null,
          gateRecommended: null,
          gateAskMessageId: null,
          decision: null,
          createdAt: T0,
          updatedAt: T0,
        },
      ] as unknown as TaskGraph["nodes"],
      edges: [
        { fromKey: "gate-old", toKey: "skip-old" },
        { fromKey: "gate-old", toKey: "next-old" },
      ],
      createdAt: T0,
      updatedAt: T0,
      completedAt: null,
    };
    const rawSnap = makeSnapshot({ ...snapshot(), activeTaskGraphs: [legacyRemoteGraph] });
    const firstDirect = pendingDecisionsOf(rawSnap, DEVICE);
    expect(pendingDecisionsOf(rawSnap, DEVICE)).toBe(firstDirect);
    expect(firstDirect).toHaveLength(1);
    expect(firstDirect[0]).toMatchObject({
      question: "远端旧门禁要不要放行？",
      source: { kind: "gate", blockedNodeCount: 1, nextNodeTitles: ["真正受阻的下游"] },
    });

    const state = reminderStateFrom(rawSnap);
    expect(askingConversations(state, DEVICE).has(1)).toBe(true);
    expect(routerReminderSummary([{ deviceId: DEVICE, state }])).toEqual({
      pendingCount: 1,
      unreadReportCount: 0,
      subtitle: "远端旧门禁要不要放行？",
    });
  });
});
