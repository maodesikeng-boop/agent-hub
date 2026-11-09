// 网页 selector 的缓存守卫：按“跑了一个月”的规模（300 个 Worker、3 万条消息）算，重算要快，输入没变要返回同一个引用，
// 相关数据变了要跟着变。规矩见 AGENTS.md“缓存和状态快照”那一条。
import { describe, expect, it } from "vitest";
import type { Message, PersonaChangeId, SessionState } from "../shared/index.ts";
import { revertedChangeIds } from "./components/Messages.tsx";
import { groupMessages, listConversations, workersOf } from "./selectors.ts";
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
  });

  it("同一份 state 重复调用返回同一个数组（子组件按引用比较不会被击穿）", () => {
    const state = monthState();
    expect(workersOf(state, 1)).toBe(workersOf(state, 1));
    expect(listConversations(state)).toBe(listConversations(state));
  });

  it("无关的变化（连接状态、待发消息）不换引用", () => {
    const state = monthState();
    const workers = workersOf(state, 1);
    const entries = listConversations(state);
    const after = reducer(reducer(state, { type: "connection", status: "reconnecting" }), {
      type: "pendingAdd",
      pending: { clientId: "c1", conversationId: PM_CONVERSATION, text: "hi", attachments: [], phase: "sending", createdAt: 1 },
    });
    expect(workersOf(after, 1)).toBe(workers);
    expect(listConversations(after)).toBe(entries);
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
});
