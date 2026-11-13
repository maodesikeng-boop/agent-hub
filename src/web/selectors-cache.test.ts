// 网页 selector 的缓存守卫：按“跑了一个月”的规模（300 个 Worker、3 万条消息）算，重算要快，输入没变要返回同一个引用，
// 相关数据变了要跟着变。规矩见 AGENTS.md“缓存和状态快照”那一条。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_VENDOR,
  MAX_REWOUND_PENDING_KEYS,
  workerEventOf,
  workerLineSummaries,
  type Message,
  type PersonaChangeId,
  type RouterCommandRecord,
  type RouterItem,
  type SessionState,
  type TaskGraph,
  type TaskNode,
} from "../shared/index.ts";
import { revertedChangeIds } from "./components/Messages.tsx";
import { fleetRouterStream, mergeRouterStream, routerStreamOf, type RouterStreamDeviceInput } from "./router-stream.ts";
import {
  activeGraphsOf,
  deviceRouterView,
  fleetRouterView,
  groupMessages,
  listConversations,
  pendingDecisionsOf,
  previewText,
  quotaResetTimes,
  quotaUsage,
  unboundWorkersOf,
  workersOf,
} from "./selectors.ts";
import { applyChange, initialState, reducer, type ConversationView, type HubState } from "./state.ts";
import { changeOf, makeConversation, makeMessage, makePm, makeProject, makeSession, makeSystemMessage, makeToolMessage, makeUserMessage, makeWorkerLine, messageChange, sessionChange } from "./test-utils.ts";

const WORKERS = 300;
const MESSAGES_PER_WORKER = 100;
const PM_CONVERSATION = 1;
const workerConversationOf = (i: number) => 1_000 + i;
const workerSessionOf = (i: number) => 10_000 + i;

/** 一个项目经理派过 300 个 Worker（都收工了），每个 Worker 的对话里 100 条消息，加上项目经理对话最近 200 行：约 3 万条。 */
function monthState(): HubState {
  let id = 1;
  const conversations: Record<number, ConversationView> = {};
  const lines: Message[] = [];
  const sessions: SessionState[] = [];
  for (let i = 0; i < WORKERS; i++) {
    const workerConversationId = workerConversationOf(i);
    for (const event of ["started", "report", "ended"] as const) {
      lines.push(makeWorkerLine({ id: id++, conversationId: PM_CONVERSATION, line: { workerId: i, workerConversationId, title: `W${i}`, event } }));
    }
    const messages = Array.from({ length: MESSAGES_PER_WORKER }, (_, k) =>
      k % 3 === 0 ? makeToolMessage({ id: id++, conversationId: workerConversationId, sessionId: workerSessionOf(i) }) : makeMessage({ id: id++, conversationId: workerConversationId, sessionId: workerSessionOf(i) }),
    );
    conversations[workerConversationId] = {
      conversation: makeConversation({ id: workerConversationId, kind: "worker", pmId: 1, title: `W${i}` }),
      messages,
      hasMore: false,
    };
    sessions.push(makeSession({ sessionId: workerSessionOf(i), conversationId: workerConversationId, status: "ended" }));
  }
  conversations[PM_CONVERSATION] = { conversation: makeConversation({ id: PM_CONVERSATION }), messages: lines.slice(-200), hasMore: true };
  return {
    ...initialState,
    phase: "ready",
    seq: 1,
    pms: [makePm({ id: 1, name: "项目经理" })],
    projects: [makeProject({ id: 1, pmId: 1, conversationId: PM_CONVERSATION })],
    conversations,
    sessions,
  };
}

const totalMessages = (state: HubState) => Object.values(state.conversations).reduce((n, v) => n + v.messages.length, 0);

/** 中位数，毫秒。 */
function medianMs(runs: number, fn: () => void): number {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    samples.push(performance.now() - t);
  }
  return samples.sort((a, b) => a - b)[Math.floor(runs / 2)]!;
}

describe("selector 缓存：300 个 Worker、3 万条消息", () => {
  it("规模对得上", () => {
    const state = monthState();
    expect(totalMessages(state)).toBeGreaterThanOrEqual(30_000);
    expect(workersOf(state, 1)).toHaveLength(WORKERS);
  });

  it("每来一条新消息都要重算：workersOf、listConversations 中位数都在几毫秒以内（实测约 0.06 ms，留了余量防 CI 抖动）", () => {
    let state = monthState();
    let seq = state.seq;
    const next = () => {
      const i = seq % WORKERS;
      state = applyChange(state, messageChange(++seq, "message.created", makeMessage({ id: 1_000_000 + seq, conversationId: workerConversationOf(i), sessionId: workerSessionOf(i) })));
      return state;
    };
    expect(medianMs(21, () => void workersOf(next(), 1))).toBeLessThan(10);
    expect(medianMs(21, () => void listConversations(next()))).toBeLessThan(10);
    expect(medianMs(21, () => void quotaUsage(next(), 0))).toBeLessThan(10);
  });

  it("同一份 state 重复调用返回同一个数组（子组件按引用比较不会被击穿）", () => {
    const state = monthState();
    expect(workersOf(state, 1)).toBe(workersOf(state, 1));
    expect(listConversations(state)).toBe(listConversations(state));
    expect(quotaUsage(state, 0)).toBe(quotaUsage(state, 0));
  });

  it("无关的变化（连接状态、待发消息）不换引用", () => {
    const state = monthState();
    const workers = workersOf(state, 1);
    const entries = listConversations(state);
    const quota = quotaUsage(state, 0);
    const after = reducer(reducer(state, { type: "connection", status: "reconnecting" }), {
      type: "pendingAdd",
      pending: { clientId: "c1", conversationId: PM_CONVERSATION, text: "hi", attachments: [], phase: "sending", createdAt: 1 },
    });
    expect(workersOf(after, 1)).toBe(workers);
    expect(listConversations(after)).toBe(entries);
    expect(quotaUsage(after, 0)).toBe(quota);
  });

  it("会话状态变了：workersOf 跟着变（缓存按 sessions 失效）", () => {
    const state = monthState();
    const before = workersOf(state, 1).find((w) => w.conversationId === workerConversationOf(7))!;
    expect(before.activity).toBe("idle");
    const after = applyChange(state, sessionChange(state.seq + 1, makeSession({ sessionId: workerSessionOf(7), conversationId: workerConversationOf(7), status: "ended", activity: "working" })));
    expect(workersOf(after, 1).find((w) => w.conversationId === workerConversationOf(7))!.activity).toBe("working");
  });

  it("新派的 Worker 进来、项目经理改名：workersOf、listConversations 跟着变（缓存按 conversations、pms 失效）", () => {
    const state = monthState();
    const newWorker = 9_999;
    const withWorker = applyChange(state, changeOf(state.seq + 1, "conversation.created", { conversation: makeConversation({ id: newWorker, kind: "worker", pmId: 1, title: "新活" }) }));
    const workers = workersOf(withWorker, 1);
    expect(workers).toHaveLength(WORKERS + 1);
    expect(workers[0]).toMatchObject({ conversationId: newWorker, ended: false });
    const renamed = applyChange(withWorker, changeOf(withWorker.seq + 1, "pm.updated", { pm: makePm({ id: 1, name: "改了名" }) }));
    expect(listConversations(renamed)[0]!.name).toBe("改了名");
  });

  it("初始快照瘦身后的样子（Worker 对话不带消息、只挂最近一行的摘要，项目经理对话只带最近 20 条）：结果和全量一样，重算快，引用稳定", () => {
    const full = monthState();
    const conversations = Object.fromEntries(
      Object.entries(full.conversations).map(([id, view]) => {
        if (view.conversation.kind !== "worker") return [id, { ...view, messages: view.messages.slice(-20), hasMore: true }];
        const lines = full.conversations[PM_CONVERSATION]!.messages.filter((m) => workerEventOf(m)?.workerConversationId === view.conversation.id);
        const summary = workerLineSummaries(lines).get(view.conversation.id);
        return [id, { conversation: view.conversation, messages: [], hasMore: true, ...(summary ? { workerLine: summary } : {}) }];
      }),
    );
    let state: HubState = { ...full, conversations };
    expect(totalMessages(state)).toBe(20);
    expect(workersOf(state, 1)).toEqual(workersOf(full, 1));
    expect(workersOf(state, 1)).toBe(workersOf(state, 1));
    let seq = state.seq;
    const next = () => {
      state = applyChange(state, messageChange(++seq, "message.created", makeMessage({ id: 1_000_000 + seq, conversationId: PM_CONVERSATION })));
      return state;
    };
    expect(medianMs(21, () => void workersOf(next(), 1))).toBeLessThan(10);
  });

  it("groupMessages：翻过页的长对话（3000 条、换了 30 次会话）也在几十毫秒以内（实测约 1.2 ms）；压着的消息排在分隔线后面", () => {
    let id = 1;
    const all: Message[] = [];
    for (let g = 0; g < 30; g++) {
      // 95～97 是写交接期间来的用户消息，已经归新会话；98 起是写交接那一轮
      for (let k = 0; k < 100; k++) {
        const held = k >= 95 && k <= 97;
        all.push(held ? makeUserMessage({ id: id++, sessionId: g + 2 }) : makeMessage({ id: id++, sessionId: g + 1, kind: k % 4 === 0 ? "tool" : "text" }));
      }
      const turnStartId = all.at(-2)!.id;
      all.push(makeSystemMessage({ id: id++, event: { event: "session.renewed", sessionId: g + 2, fromSessionId: g + 1, turnStartId } }));
    }
    expect(medianMs(7, () => void groupMessages([...all]))).toBeLessThan(50);
    const flat = groupMessages(all).flatMap((item) => (item.kind === "message" ? [item.message] : [...item.work, ...item.parts]));
    const first = flat.findIndex((m) => m.sender === "system");
    expect(flat.slice(first, first + 4).map((m) => [m.sender, m.sessionId])).toEqual([
      ["system", null],
      ["user", 2],
      ["user", 2],
      ["user", 2],
    ]);
  });

  it("revertedChangeIds：内容一样就返回同一个 Set（来一条新消息，每一轮的 TurnView 不会因为它重画）", () => {
    const revert = (id: number, revertOf: number) =>
      makeSystemMessage({ id, event: { event: "persona.changed", pmId: 1, personaChangeId: id as PersonaChangeId, revertOf: revertOf as PersonaChangeId } });
    const a = [revert(1, 100), makeMessage({ id: 2 })];
    const b = [...a, makeMessage({ id: 3 })];
    expect(revertedChangeIds(b)).toBe(revertedChangeIds(a));
    const c = [...b, revert(4, 101)];
    expect(revertedChangeIds(c)).not.toBe(revertedChangeIds(a));
    expect([...revertedChangeIds(c)].sort()).toEqual([100, 101]);
  });

  it("流式增量文字更新（session.status 只改 streamingText）：workersOf、listConversations、quotaUsage、quotaResetTimes 全部保持同一个引用", () => {
    let state = monthState();
    const pmSession = makeSession({
      sessionId: 99_999,
      conversationId: PM_CONVERSATION,
      pmId: 1,
      status: "running",
      activity: "working",
      step: { type: "text" },
      streamingText: "第一块",
    });
    state = applyChange(state, sessionChange(state.seq + 1, pmSession));
    const workersBefore = workersOf(state, 1);
    const entriesBefore = listConversations(state);
    const quotaBefore = quotaUsage(state, 0);
    const resetsBefore = quotaResetTimes(state);

    const next = applyChange(state, sessionChange(state.seq + 1, { ...pmSession, streamingText: "第一块第二块第三块" }));
    expect(workersOf(next, 1)).toBe(workersBefore);
    expect(listConversations(next)).toBe(entriesBefore);
    expect(quotaUsage(next, 0)).toBe(quotaBefore);
    expect(quotaResetTimes(next)).toBe(resetsBefore);
  });

  it("二次 Esc 回退：pendingRewind 不击穿 conversations/workers 缓存且 rewoundKeys 严格受上限约束；messageRewind 立即失效左栏预览并保持后续引用稳定", () => {
    let state = monthState();
    const workers = workersOf(state, 1);
    const entries = listConversations(state);
    for (let i = 0; i < MAX_REWOUND_PENDING_KEYS + 10; i++) {
      state = reducer(state, {
        type: "pendingAdd",
        pending: { clientId: `p${i}`, conversationId: PM_CONVERSATION, text: `草稿 ${i}`, attachments: [], phase: "sending", createdAt: i },
      });
      state = reducer(state, { type: "pendingRewind", clientId: `p${i}` });
    }
    expect(state.rewoundKeys).toHaveLength(MAX_REWOUND_PENDING_KEYS);
    expect(workersOf(state, 1)).toBe(workers);
    expect(listConversations(state)).toBe(entries);

    const withStopped = applyChange(
      state,
      messageChange(state.seq + 1, "message.created", makeUserMessage({ id: 9_999_999, conversationId: PM_CONVERSATION, text: "刚暂停的话", status: "stopped" })),
    );
    expect(previewText(listConversations(withStopped)[0]!)).toBe("刚暂停的话");
    const rewound = reducer(withStopped, { type: "messageRewind", conversationId: PM_CONVERSATION, messageId: 9_999_999 });
    const nextEntries = listConversations(rewound);
    expect(previewText(nextEntries[0]!)).not.toBe("刚暂停的话");
    expect(listConversations(rewound)).toBe(nextEntries);
  });

  it("Router 跨设备视图（deviceRouterView / fleetRouterView）：300 Worker、3 万条消息下流式 session.status 与无关消息更新均保持 === 引用稳定且中位数 < 2 ms，router/task_graph/pm 变化立即失效", () => {
    const localBase = monthState();
    const localWithRouter: HubState = {
      ...localBase,
      router: {
        ...localBase.router,
        items: [
          {
            id: 1,
            kind: "decision",
            status: "pending",
            pmId: 1,
            projectId: 1,
            conversationId: PM_CONVERSATION,
            question: "本地拍板项",
            context: "上下文",
            options: ["A", "B"],
            askMessageId: null,
            resolution: null,
            createdAt: 10_000,
            updatedAt: 10_000,
          },
          {
            id: 2,
            kind: "report",
            status: "unread",
            pmId: 1,
            projectId: 1,
            conversationId: PM_CONVERSATION,
            summary: "本地阶段汇报",
            links: [],
            createdAt: 9_000,
            updatedAt: 9_000,
          },
        ],
      },
    };
    const remoteState: HubState = {
      ...initialState,
      phase: "ready",
      seq: 5,
      pms: [makePm({ id: 2, name: "远端 PM" })],
      projects: [makeProject({ id: 2, pmId: 2, conversationId: 2 })],
      conversations: {
        2: { conversation: makeConversation({ id: 2, pmId: 2, projectId: 2, title: "远端 PM" }), messages: [], hasMore: false },
      },
    };

    const makeDevices = (local: HubState) => [
      { id: "local-id", name: "Mac", self: true, online: true, state: local },
      { id: "tokyo-id", name: "Tokyo", self: false, online: true, state: remoteState },
    ];

    const firstDeviceView = deviceRouterView(localWithRouter, "local");
    expect(deviceRouterView(localWithRouter, "local")).toBe(firstDeviceView);

    const firstFleet = fleetRouterView(makeDevices(localWithRouter));
    expect(fleetRouterView(makeDevices(localWithRouter))).toBe(firstFleet);
    expect(firstFleet.decisions).toHaveLength(1);
    expect(firstFleet.summary.unreadReportCount).toBe(1);

    // 流式增量文字更新与 Worker 消息到达都不换 deviceRouterView / fleetRouterView 引用
    const pmSession = makeSession({
      sessionId: 88_888,
      conversationId: PM_CONVERSATION,
      pmId: 1,
      status: "running",
      activity: "working",
      step: { type: "text" },
      streamingText: "片段一",
    });
    let ticking = applyChange(localWithRouter, sessionChange(localWithRouter.seq + 1, pmSession));
    expect(deviceRouterView(ticking, "local")).toBe(firstDeviceView);
    expect(fleetRouterView(makeDevices(ticking))).toBe(firstFleet);

    let seq = ticking.seq;
    expect(
      medianMs(21, () => {
        ticking = applyChange(ticking, sessionChange(++seq, { ...pmSession, streamingText: `片段 ${seq}` }));
        fleetRouterView(makeDevices(ticking));
      }),
    ).toBeLessThan(2);
    expect(fleetRouterView(makeDevices(ticking))).toBe(firstFleet);

    // router.item.updated 后立即失效并算出新视图，再重复调用保持新引用稳定
    const resolved = applyChange(
      ticking,
      changeOf(++seq, "router.item.updated", {
        item: { ...(localWithRouter.router.items[0] as Extract<(typeof localWithRouter.router.items)[number], { kind: "decision" }>), status: "resolved" },
      }),
    );
    const afterResolve = fleetRouterView(makeDevices(resolved));
    expect(afterResolve).not.toBe(firstFleet);
    expect(afterResolve.decisions).toHaveLength(0);
    expect(fleetRouterView(makeDevices(resolved))).toBe(afterResolve);

    // 还没连上的远端设备（phase 不是 ready）不许击穿缓存：它的空视图每次都是同一份引用
    const withLoading = (local: HubState) => [...makeDevices(local), { id: "osaka-id", name: "Osaka", self: false, online: false, state: initialState }];
    const loadingFleet = fleetRouterView(withLoading(resolved));
    expect(fleetRouterView(withLoading(resolved))).toBe(loadingFleet);
  });

  it("Router 时间流（routerStreamOf / fleetRouterStream）：300 Worker、3 万条消息下连续 100 次流式更新返回同一个引用且中位数 < 2 ms；只变一条指令时别的条目对象不换", () => {
    const SELF_ID = "00000000-0000-4000-8000-000000000001";
    const TOKYO_ID = "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f";
    const command = (id: number, over: Partial<RouterCommandRecord> = {}): RouterCommandRecord => ({
      id,
      clientId: `c-${id}`,
      inputText: `指令 ${id}`,
      vendor: DEFAULT_AGENT_VENDOR,
      model: null,
      effort: null,
      status: "dispatched",
      plan: { intent: "dispatch", reply: "", actions: [], track: "A" },
      dispatched: [{ deviceId: SELF_ID, deviceName: "Mac", pmId: 1, pmName: "项目经理", projectId: 1, projectName: "agent-hub", conversationId: PM_CONVERSATION, messageId: id, ok: true, op: "pm.forward" }],
      error: null,
      durationMs: 300,
      createdAt: 50_000 + id,
      updatedAt: 50_000 + id,
      ...over,
    });
    const report = (id: number, pmId: number, conversationId: number, createdAt: number): RouterItem => ({
      id,
      kind: "report",
      status: id % 2 === 0 ? "unread" : "archived",
      pmId,
      projectId: pmId,
      conversationId,
      summary: `里程碑 ${id}`,
      links: [],
      createdAt,
      updatedAt: createdAt,
    });
    const localBase = monthState();
    const local: HubState = {
      ...localBase,
      router: {
        ...localBase.router,
        // 近窗是从新到旧的：200 条指令、200 条简报（ROUTER_STREAM_LIVE_MAX）
        commands: Array.from({ length: 200 }, (_, i) => command(200 - i)),
        items: Array.from({ length: 200 }, (_, i) => report(200 - i, 1, PM_CONVERSATION, 40_000 + (200 - i))),
      },
    };
    const remote: HubState = {
      ...initialState,
      phase: "ready",
      seq: 5,
      pms: [makePm({ id: 2, name: "远端 PM" })],
      projects: [makeProject({ id: 2, pmId: 2, conversationId: 2, name: "tokyo-svc" })],
      conversations: { 2: { conversation: makeConversation({ id: 2, pmId: 2, projectId: 2, title: "远端 PM" }), messages: [], hasMore: false } },
      router: { ...initialState.router, items: Array.from({ length: 200 }, (_, i) => report(200 - i, 2, 2, 45_000 + (200 - i))) },
    };
    const devices = (l: HubState): RouterStreamDeviceInput[] => [
      { key: "", name: "Mac", self: true, online: true, state: l },
      { key: TOKYO_ID, name: "Tokyo", self: false, online: true, state: remote },
      // 还没连上的设备不许击穿缓存
      { key: "osaka-id", name: "Osaka", self: false, online: false, state: initialState },
    ];

    const firstDevice = routerStreamOf(local);
    expect(routerStreamOf(local)).toBe(firstDevice);
    const first = fleetRouterStream(devices(local), SELF_ID);
    expect(fleetRouterStream(devices(local), SELF_ID)).toBe(first);
    expect(first.turns).toHaveLength(200);
    expect(first.devices.map((d) => d.briefings.length)).toEqual([200, 200]);
    // 从旧到新；本机真实设备编号换成网页的设备键（""），去向行才点得进去
    expect(first.turns[0]!.createdAt).toBeLessThan(first.turns.at(-1)!.createdAt);
    expect(first.turns[0]!.destinations[0]).toMatchObject({ deviceKey: "", conversationId: PM_CONVERSATION, worker: false, name: "项目经理" });

    // 100 次流式更新（那台设备的 sessions 在变，router、pms、projects 四个引用都没变）
    const pmSession = makeSession({ sessionId: 88_889, conversationId: PM_CONVERSATION, pmId: 1, status: "running", activity: "working", step: { type: "text" }, streamingText: "片段" });
    let ticking = applyChange(local, sessionChange(local.seq + 1, pmSession));
    let seq = ticking.seq;
    const samples: number[] = [];
    for (let i = 0; i < 100; i++) {
      ticking = applyChange(ticking, sessionChange(++seq, { ...pmSession, streamingText: `片段 ${seq}` }));
      const t = performance.now();
      const got = fleetRouterStream(devices(ticking), SELF_ID);
      samples.push(performance.now() - t);
      expect(got).toBe(first);
    }
    expect(samples.sort((a, b) => a - b)[50]!).toBeLessThan(2);
    expect(routerStreamOf(ticking)).toBe(firstDevice);

    // 合并（3 个来源、600 条）也在同一条线以内
    const sources = [
      { entries: first.turns, loadedDownTo: null, hasMore: false },
      ...first.devices.map((d) => ({ entries: d.briefings, loadedDownTo: null, hasMore: false })),
    ];
    expect(medianMs(21, () => void mergeRouterStream(sources))).toBeLessThan(2);
    expect(mergeRouterStream(sources).entries).toHaveLength(600);

    // 一条指令从 planning 变成 answered：只有那一个回合的条目对象换了，别的回合、所有简报都还是原来的对象
    const changed = applyChange(ticking, changeOf(++seq, "router.command.updated", { command: command(100, { status: "answered", updatedAt: 99_999 }) }));
    const after = fleetRouterStream(devices(changed), SELF_ID);
    expect(after).not.toBe(first);
    expect(fleetRouterStream(devices(changed), SELF_ID)).toBe(after);
    const changedTurns = after.turns.filter((t, i) => t !== first.turns[i]);
    expect(changedTurns.map((t) => t.command?.id)).toEqual([100]);
    expect(after.devices[0]!.briefings).toBe(first.devices[0]!.briefings);
    expect(after.devices[1]).toBe(first.devices[1]);
    // 只变指令：设备数组本身也沿用（下游“标已读”、简报分页按它做依赖，不该跟着重跑）
    expect(after.devices).toBe(first.devices);

    // 来一条简报：回合列表还是原来的那个数组，另一台设备的简报也不动
    const briefed = applyChange(changed, changeOf(++seq, "router.item.created", { item: report(900, 1, PM_CONVERSATION, 99_000) }));
    const afterBrief = fleetRouterStream(devices(briefed), SELF_ID);
    expect(afterBrief.turns).toBe(after.turns);
    expect(afterBrief.devices[1]).toBe(after.devices[1]);
    expect(afterBrief.devices[0]!.briefings.at(-1)!.report.id).toBe(900);
    expect(afterBrief.devices[0]!.briefings[5]).toBe(after.devices[0]!.briefings[6]);

    // 项目经理改名：那台设备的简报跟着变（缓存按 pms 失效）
    const renamed = applyChange(briefed, changeOf(++seq, "pm.updated", { pm: makePm({ id: 1, name: "小林" }) }));
    const afterRename = fleetRouterStream(devices(renamed), SELF_ID);
    expect(afterRename.devices[0]!.briefings.at(-1)!.pmName).toBe("小林");

    // commandsHasMore / briefingsHasMore 翻转时立即失效，且未变的条目数组保持 === 引用稳定
    const withCmdMore: HubState = { ...renamed, router: { ...renamed.router, commandsHasMore: true } };
    const afterCmdMore = fleetRouterStream(devices(withCmdMore), SELF_ID);
    expect(afterCmdMore).not.toBe(afterRename);
    expect(afterCmdMore.commandsHasMore).toBe(true);
    expect(afterCmdMore.turns).toBe(afterRename.turns);
    expect(afterCmdMore.devices).toBe(afterRename.devices);
    expect(fleetRouterStream(devices(withCmdMore), SELF_ID)).toBe(afterCmdMore);
  });

  it("activeGraphsOf、unboundWorkersOf、pendingDecisionsOf：1 个月规模下中位数 < 2 ms，流式打字与无关更新严格 === 引用稳定，变更即时失效", () => {
    const makeNode = (over: Partial<TaskNode> & Pick<TaskNode, "key" | "title">): TaskNode => ({
      status: "pending",
      waitingFor: null,
      skipped: false,
      sortOrder: 0,
      activeWorkerId: null,
      workerIds: [],
      artifact: null,
      gateQuestion: null,
      gateOptions: [],
      gateSummaryMd: null,
      gateRecommended: null,
      gateAskMessageId: null,
      decision: null,
      createdAt: 1_000,
      updatedAt: 1_000,
      ...over,
    });
    const makeGraph = (over: Partial<TaskGraph> & Pick<TaskGraph, "id" | "title">): TaskGraph => ({
      projectId: 1,
      pmId: 1,
      conversationId: PM_CONVERSATION,
      status: "active",
      originMsgId: null,
      nodes: [],
      edges: [],
      createdAt: 1_000,
      updatedAt: 1_000,
      completedAt: null,
      ...over,
    });

    const gateAskMsg = makeMessage({
      id: 8_888_001,
      conversationId: PM_CONVERSATION,
      text: "确认同步范围",
      meta: { needsUser: true, options: ["全量同步", "仅不冲突项"], gateRef: { graphId: 10, nodeKey: "gate-scope" } },
    });
    const routerDuplicateGate: RouterItem = {
      id: 501,
      kind: "decision",
      status: "pending",
      pmId: 1,
      projectId: 1,
      conversationId: PM_CONVERSATION,
      question: "确认同步范围",
      context: "",
      options: ["全量同步", "仅不冲突项"],
      askMessageId: gateAskMsg.id,
      resolution: null,
      createdAt: 2_000,
      updatedAt: 2_000,
    };
    const routerIndependent: RouterItem = {
      ...routerDuplicateGate,
      id: 502,
      question: "日志级别默认用 info 可以吗？",
      options: ["可以", "改成 warn"],
      askMessageId: null,
      createdAt: 3_000,
      updatedAt: 3_000,
    };

    const g1 = makeGraph({
      id: 10,
      title: "全厂商同步",
      updatedAt: 5_000,
      nodes: [
        makeNode({ key: "survey", title: "调研差异", status: "done", sortOrder: 0, workerIds: [295] }),
        makeNode({
          key: "gate-scope",
          title: "确认同步范围",
          status: "waiting",
          waitingFor: "user",
          skipped: false,
          sortOrder: 1,
          gateQuestion: "冲突项怎么处理？",
          gateOptions: ["全量同步", "仅不冲突项"],
          gateRecommended: "全量同步",
          gateAskMessageId: gateAskMsg.id,
        }),
        makeNode({ key: "impl", title: "落地同步器", status: "pending", sortOrder: 2 }),
      ],
      edges: [
        { fromKey: "survey", toKey: "gate-scope" },
        { fromKey: "gate-scope", toKey: "impl" },
      ],
    });
    const g2 = makeGraph({
      id: 11,
      title: "后台流水线",
      updatedAt: 9_000,
      nodes: [makeNode({ key: "step-a", title: "并行改造", status: "running", activeWorkerId: 296, workerIds: [296] })],
    });

    let state = monthState();
    state = {
      ...state,
      projects: [...state.projects, makeProject({ id: 2, pmId: 2, conversationId: 2 })],
      conversations: {
        ...state.conversations,
        [PM_CONVERSATION]: {
          ...state.conversations[PM_CONVERSATION]!,
          messages: [...state.conversations[PM_CONVERSATION]!.messages, gateAskMsg],
        },
      },
      router: { ...state.router, items: [routerDuplicateGate, routerIndependent] },
      activeTaskGraphs: [g2, g1],
    };

    // waiting_user 任务排在后台运行中任务前面
    const graphs0 = activeGraphsOf(state, 1);
    expect(graphs0.map((g) => g.id)).toEqual([10, 11]);
    expect(activeGraphsOf(state, 1)).toBe(graphs0);
    expect(activeGraphsOf(state, null)).toBe(activeGraphsOf(state, null));

    // 已绑定到活跃图节点的 Worker #295、#296 从 unboundWorkersOf 剔除
    const unbound0 = unboundWorkersOf(state, 1);
    expect(unbound0).toHaveLength(WORKERS - 2);
    expect(unbound0.some((w) => w.conversationId === workerConversationOf(295) || w.conversationId === workerConversationOf(296))).toBe(false);
    expect(unboundWorkersOf(state, 1)).toBe(unbound0);

    // pendingDecisionsOf 自动去重同源门禁与 router_item，且保持 === 引用稳定
    const decisions0 = pendingDecisionsOf(state, PM_CONVERSATION);
    expect(decisions0).toHaveLength(2);
    expect(decisions0.map((d) => d.source.kind).sort()).toEqual(["gate", "router_item"]);
    expect(pendingDecisionsOf(state, PM_CONVERSATION)).toBe(decisions0);

    // 1 个月规模快照 + 流式增量更新：耗时中位数 < 2 ms，且引用严格 === 不变
    const pmSession = makeSession({
      sessionId: 99_999,
      conversationId: PM_CONVERSATION,
      pmId: 1,
      status: "running",
      activity: "working",
      step: { type: "text" },
      streamingText: "流式第 1 块",
    });
    state = applyChange(state, sessionChange(state.seq + 1, pmSession));
    expect(activeGraphsOf(state, 1)).toBe(graphs0);
    expect(unboundWorkersOf(state, 1)).toBe(unbound0);
    expect(pendingDecisionsOf(state, PM_CONVERSATION)).toBe(decisions0);

    let seq = state.seq;
    const cachedMedian = medianMs(21, () => {
      state = applyChange(state, sessionChange(++seq, { ...pmSession, streamingText: `流式第 ${seq} 块` }));
      expect(activeGraphsOf(state, 1)).toBe(graphs0);
      expect(unboundWorkersOf(state, 1)).toBe(unbound0);
      expect(pendingDecisionsOf(state, PM_CONVERSATION)).toBe(decisions0);
    });
    console.log(`[task-graph selectors · 1-month snapshot + streaming] median=${cachedMedian.toFixed(3)}ms`);
    expect(cachedMedian).toBeLessThan(2);

    // 别的项目的任务图更新不击穿项目 1 的缓存引用
    const otherGraph = makeGraph({ id: 99, projectId: 2, pmId: 2, conversationId: 2, title: "别的项目" });
    const withOther = applyChange(state, changeOf(++seq, "task_graph.created", { graph: otherGraph }));
    expect(activeGraphsOf(withOther, 1)).toBe(graphs0);
    expect(unboundWorkersOf(withOther, 1)).toBe(unbound0);
    expect(pendingDecisionsOf(withOther, PM_CONVERSATION)).toBe(decisions0);

    // 项目 1 的门禁拍板完成：activeGraphsOf 与 pendingDecisionsOf 立即失效更新，随后再次稳定
    const decidedG1: TaskGraph = {
      ...g1,
      updatedAt: 12_000,
      nodes: g1.nodes.map((n) =>
        n.key === "gate-scope"
          ? { ...n, status: "done", decision: { choice: "全量同步", note: null, decidedBy: "user", decidedAt: 12_000 } }
          : n.key === "impl"
            ? { ...n, status: "running", activeWorkerId: 297, workerIds: [297] }
            : n,
      ),
    };
    const afterDecide = applyChange(withOther, changeOf(++seq, "task_graph.updated", { graph: decidedG1 }));
    const graphs1 = activeGraphsOf(afterDecide, 1);
    expect(graphs1).not.toBe(graphs0);
    expect(activeGraphsOf(afterDecide, 1)).toBe(graphs1);

    const unbound1 = unboundWorkersOf(afterDecide, 1);
    expect(unbound1).toHaveLength(WORKERS - 3);
    expect(unboundWorkersOf(afterDecide, 1)).toBe(unbound1);

    const decisions1 = pendingDecisionsOf(afterDecide, PM_CONVERSATION);
    expect(decisions1).toHaveLength(1);
    expect(decisions1[0]!.source.kind).toBe("router_item");
    expect(pendingDecisionsOf(afterDecide, PM_CONVERSATION)).toBe(decisions1);

    // confirm 检查点与独立提问 recommended：引用保持 === 稳定，状态切换时精确失效再稳定
    const checkpointG1: TaskGraph = {
      ...decidedG1,
      updatedAt: 15_000,
      nodes: decidedG1.nodes.map((n) =>
        n.key === "impl"
          ? {
              ...n,
              status: "waiting",
              waitingFor: "user",
              gateQuestion: "请确认步骤「核心实现」的结果",
              gateOptions: ["通过", "打回"],
              gateRecommended: "通过",
              gateCheckpoint: true,
            }
          : n,
      ),
    };
    const withCheckpoint = applyChange(afterDecide, changeOf(++seq, "task_graph.updated", { graph: checkpointG1 }));
    const decisions2 = pendingDecisionsOf(withCheckpoint, PM_CONVERSATION);
    expect(decisions2).not.toBe(decisions1);
    expect(decisions2.find((d) => d.source.kind === "gate")?.source).toMatchObject({
      kind: "gate",
      checkpoint: true,
      recommended: "通过",
    });
    expect(pendingDecisionsOf(withCheckpoint, PM_CONVERSATION)).toBe(decisions2);
  });
});
