// 首屏瘦身（Worker #316）：初始快照不带 Worker 对话的消息、项目经理对话只带最近几条以后，右栏分组、状态色、已收工、
// “准备中”、左栏预览和排序、“等你”“等你确定”、额度算出来要和拿着全部消息时一模一样。
// slim() 按账本的口径（shared/snapshot.ts 的几条规则）把全量快照裁成初始快照；账本那边按同样的规则出快照见
// daemon/ledger/snapshot-slim.test.ts。
import { describe, expect, it } from "vitest";
import {
  isQueuedWorkerTask,
  MESSAGE_PAGE_SIZE,
  snapshotWindowStart,
  SNAPSHOT_RECENT_MESSAGES,
  workerLineSummaries,
  type ConversationSnapshot,
  type Message,
  type StateSnapshot,
  type WorkerMessageMeta,
} from "../shared/index.ts";
import {
  isRenewing,
  listConversations,
  pendingAsks,
  previewText,
  quotaUsage,
  visibleSessionOf,
  waitingConversations,
  workerLineOf,
  workerPhaseOf,
  workersOf,
} from "./selectors.ts";
import { applyChange, initialState, reducer, type HubState } from "./state.ts";
import {
  makeConversation,
  makeMessage,
  makePm,
  makeSession,
  makeSnapshot,
  makeSystemMessage,
  makeToolMessage,
  makeUserMessage,
  makeWorkerConversation,
  makeWorkerLine,
  messageChange,
} from "./test-utils.ts";

const PM_CONV = 1;
/** 30 收工、31 在跑（有问题）、32 出错（额度）、33 建 worktree 失败、34 准备中（任务说明在排队）、35 汇报了做完了还开着。 */
const WORKERS = [30, 31, 32, 33, 34, 35] as const;
const NOW = 1_000_000;

/** 账本的口径：项目经理对话裁到 snapshotWindowStart，Worker 对话不带消息（任务说明在排队的除外），挂上最近一行的摘要。 */
function slim(full: StateSnapshot): StateSnapshot {
  const lines = workerLineSummaries(
    full.conversations.filter((c) => c.conversation.kind !== "worker").flatMap((c) => c.messages).toSorted((a, b) => a.id - b.id),
  );
  const conversations = full.conversations.map((c): ConversationSnapshot => {
    if (c.conversation.kind === "worker") {
      const workerLine = lines.get(c.conversation.id);
      const keep = isQueuedWorkerTask(c.messages[0]) ? c.messages.slice(-MESSAGE_PAGE_SIZE) : [];
      return {
        conversation: c.conversation,
        messages: keep,
        hasMore: keep.length < c.messages.length,
        ...(workerLine !== undefined ? { workerLine } : {}),
      };
    }
    const page = c.messages.slice(-MESSAGE_PAGE_SIZE);
    const start = snapshotWindowStart(page);
    return { conversation: c.conversation, messages: page.slice(start), hasMore: c.messages.length > page.length - start };
  });
  return { ...full, conversations };
}

function line(id: number, workerConversationId: number, event: WorkerMessageMeta["event"], extra: Partial<WorkerMessageMeta> = {}): Message {
  return makeWorkerLine({ id, conversationId: PM_CONV, line: { workerId: workerConversationId - 20, workerConversationId, title: `W${workerConversationId}`, event, ...extra } });
}

/** 一个项目经理派了 6 个 Worker；汇报那几行之后项目经理又干了很多活（工具消息），还有一次换新会话。 */
function fullSnapshot(): StateSnapshot {
  let id = 1;
  const pm: Message[] = [makeUserMessage({ id: id++, conversationId: PM_CONV, text: "开始" })];
  for (const w of WORKERS) pm.push(line(id++, w, "started"));
  pm.push(line(id++, 30, "report", { status: "done", summary: "搞定" }));
  pm.push(line(id++, 30, "ended"));
  pm.push(line(id++, 31, "report", { status: "problem", summary: "卡住了" }));
  pm.push(line(id++, 32, "turn_failed", { summary: "rate_limit: usage limit reached" }));
  pm.push(line(id++, 33, "worktree_failed", { summary: "git 失败" }));
  pm.push(line(id++, 35, "report", { status: "done", summary: "好了" }));
  pm.push(makeMessage({ id: id++, conversationId: PM_CONV, text: "要合吗？", meta: { needsUser: true, options: ["合", "不合"] } }));
  for (let i = 0; i < 60; i++) pm.push(makeToolMessage({ id: id++, conversationId: PM_CONV }));
  pm.push(makeMessage({ id: id++, conversationId: PM_CONV, text: "**最后**一句给用户的话" }));
  pm.push(makeSystemMessage({ id: id++, conversationId: PM_CONV, status: "replied", event: { event: "handover.requested", sessionId: 1 } }));
  for (let i = 0; i < 25; i++) pm.push(makeToolMessage({ id: id++, conversationId: PM_CONV, meta: { toolUseId: `h${i}`, name: "Write", input: {}, handover: true } }));
  pm.push(makeSystemMessage({ id: id++, conversationId: PM_CONV, event: { event: "session.renewed", sessionId: 1, fromSessionId: 1 } }));

  const worker = (w: number, first: Message["status"]): ConversationSnapshot => {
    const msgs: Message[] = [makeMessage({ id: id++, conversationId: w, sender: "pm", status: first, text: "任务说明", sessionId: null })];
    if (first !== "queued") for (let i = 0; i < 30; i++) msgs.push(makeToolMessage({ id: id++, conversationId: w, sessionId: 100 + w }));
    return { conversation: makeWorkerConversation({ id: w, title: `W${w}` }), messages: msgs, hasMore: false };
  };
  const rateLimit = { status: "allowed" as const, resetsAt: 10_000, windows: { five_hour: { utilization: 0.5, resetsAt: 10_000, status: "allowed" } } };
  return makeSnapshot({
    pms: [makePm({ id: 1 })],
    conversations: [
      { conversation: makeConversation({ id: PM_CONV }), messages: pm, hasMore: false },
      worker(30, "replied"),
      worker(31, "replied"),
      worker(32, "failed"),
      worker(33, "replied"),
      worker(34, "queued"),
      worker(35, "replied"),
    ],
    sessions: [
      makeSession({ sessionId: 1, conversationId: PM_CONV, pmId: 1, generation: 2 }),
      makeSession({ sessionId: 130, conversationId: 30, status: "ended", usage: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, context: 5 } }),
      makeSession({ sessionId: 131, conversationId: 31, status: "running", activity: "working" }),
      makeSession({ sessionId: 132, conversationId: 32, vendor: "claude", rateLimit, lastEventAt: 50_000 }),
      makeSession({ sessionId: 135, conversationId: 35 }),
    ],
  });
}

const load = (snapshot: StateSnapshot): HubState => reducer(initialState, { type: "loaded", snapshot });

/** 界面从状态里算出来的东西（右栏、Worker 页、左栏、提醒、额度）。 */
function derived(state: HubState) {
  return {
    rail: workersOf(state, 1),
    phases: WORKERS.map((w) => workerPhaseOf(state, w)),
    lines: WORKERS.map((w) => workerLineOf(state, w)),
    list: listConversations(state).map((e) => ({ id: e.id, lastAt: e.lastAt, preview: previewText(e) })),
    waiting: waitingConversations(state, {}),
    asks: pendingAsks(state, PM_CONV).map((m) => m.id),
    renewing: isRenewing(state, PM_CONV),
    visible: visibleSessionOf(state, PM_CONV),
    quota: quotaUsage(state, NOW),
  };
}

describe("首屏瘦身：初始快照少带消息，界面算出来的一样", () => {
  it("拿着全部消息时（锁住现有行为）：分组、状态色、已收工、准备中、预览、提问、额度", () => {
    const d = derived(load(fullSnapshot()));
    expect(d.rail.map((w) => [w.conversationId, w.ended, w.tone])).toEqual([
      [31, false, "warn"],
      [32, false, "danger"],
      [34, false, "neutral"],
      [35, false, "success"],
      [33, true, "danger"],
      [30, true, "neutral"],
    ]);
    expect(d.phases).toEqual(["ended", "open", "open", "ended", "preparing", "open"]);
    expect(d.lines.map((l) => l?.event)).toEqual(["ended", "report", "turn_failed", "worktree_failed", "started", "report"]);
    expect(d.list).toEqual([{ id: PM_CONV, lastAt: expect.any(Number), preview: "最后一句给用户的话" }]);
    expect(d.asks).toHaveLength(1);
    expect(d.waiting).toEqual([]);
    expect(d.quota[0]?.exhausted).toBe(true);
  });

  it("初始快照：Worker 对话不带消息（排队的任务说明除外），项目经理对话少带，算出来的和全量一样", () => {
    const full = fullSnapshot();
    const small = slim(full);
    const pm = small.conversations.find((c) => c.conversation.id === PM_CONV)!;
    expect(pm.messages.length).toBeLessThan(full.conversations[0]!.messages.length);
    expect(pm.hasMore).toBe(true);
    for (const c of small.conversations.filter((x) => x.conversation.kind === "worker")) {
      expect(c.messages.length).toBe(c.conversation.id === 34 ? 1 : 0);
    }
    expect(derived(load(small))).toEqual(derived(load(full)));
  });

  it("只差最近 SNAPSHOT_RECENT_MESSAGES 条：提问回答了、没有在跑的，项目经理对话就只带最近几条", () => {
    const full = fullSnapshot();
    const answered = {
      ...full,
      conversations: full.conversations.map((c) => ({
        ...c,
        messages: c.messages.map((m) => (m.meta?.needsUser === true ? { ...m, meta: { ...m.meta, answered: true } } : m)),
      })),
    };
    const pm = slim(answered).conversations[0]!;
    // 最近一条非安静的（给用户的那句）在 26 条安静的消息之前，往前带到它
    expect(pm.messages[0]?.text).toBe("**最后**一句给用户的话");
    expect(pm.messages.length).toBe(1 + 1 + 25 + 1);
    expect(pm.messages.length).toBeGreaterThan(SNAPSHOT_RECENT_MESSAGES);
    expect(derived(load(slim(answered)))).toEqual(derived(load(answered)));
  });

  it("快照之后实时来的新行盖掉快照里的摘要：状态色、收工跟着变", () => {
    const full = fullSnapshot();
    const lastId = Math.max(...full.conversations.flatMap((c) => c.messages.map((m) => m.id)));
    let a = load(full);
    let b = load(slim(full));
    const changes = [
      messageChange(full.seq + 1, "message.created", line(lastId + 1, 31, "report", { status: "done", summary: "修好了" })),
      messageChange(full.seq + 2, "message.created", line(lastId + 2, 35, "ended")),
    ];
    for (const change of changes) {
      a = applyChange(a, change);
      b = applyChange(b, change);
    }
    expect(derived(b)).toEqual(derived(a));
    expect(workersOf(b, 1).find((w) => w.conversationId === 31)?.tone).toBe("success");
    expect(workersOf(b, 1).find((w) => w.conversationId === 35)?.ended).toBe(true);
  });

  it("比已带的最早一条还早的消息变了：不插进列表（会和往上翻页那一段接不上），翻到时再拉", () => {
    const small = load(slim(fullSnapshot()));
    const view = small.conversations[PM_CONV]!;
    const older = makeToolMessage({ id: view.messages[0]!.id - 1, conversationId: PM_CONV, text: "改过" });
    const next = applyChange(small, messageChange(small.seq + 1, "message.updated", older));
    expect(next.conversations[PM_CONV]!.messages).toBe(view.messages);
    expect(next.seq).toBe(small.seq + 1);
  });
});
