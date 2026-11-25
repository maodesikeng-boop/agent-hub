import { describe, expect, it } from "vitest";
import { groupMessages, listConversations, previewText, visibleMessages, workerOutcomesOf } from "./selectors.ts";
import { initialState, type HubState } from "./state.ts";
import {
  makeAttachment,
  makeConversation,
  makeMessage,
  makePm,
  makeSession,
  makeSystemMessage,
  makeToolMessage,
  makeUserMessage,
  makeWorkerLine,
} from "./test-utils.ts";
import type { Message } from "../shared/index.ts";

describe("visibleMessages: routine Worker start and end lines", () => {
  it("hides started and ended lines and keeps reports, failures, and direct messages in order", () => {
    const events = ["started", "report", "turn_failed", "worktree_failed", "user_message", "ended"] as const;
    const lines = events.map((event, i) => makeWorkerLine({ id: i + 1, conversationId: 1, line: { event } }));
    const reply = makeMessage({ id: 10, conversationId: 1, text: "收到" });
    expect(visibleMessages([...lines, reply]).map((m) => m.id)).toEqual([2, 3, 4, 5, 10]);
  });

  it("returns the same array when nothing is hidden", () => {
    const plain = [makeUserMessage({ id: 1, conversationId: 1 }), makeWorkerLine({ id: 2, conversationId: 1, line: { event: "report", status: "done" } })];
    expect(visibleMessages(plain)).toBe(plain);
  });
});

describe("selectors：Worker 超时静默触发消息过滤", () => {
  const maxTimeTrigger = makeSystemMessage({
    id: 10,
    conversationId: 1,
    text: "【系统】【Worker #268 · 修 X 已超过最大时间（20m）】该 Worker 当前一轮已运行 20m 仍未结束……",
    meta: { event: "worker.max_time_exceeded", workerId: 268, workerConversationId: 30, maxTimeMs: 1_200_000 },
    createdAt: 2_000,
  });

  it("visibleMessages 与 groupMessages 只隐藏 worker.max_time_exceeded 触发消息本身，保留项目经理随后回复给用户的话", () => {
    const userMsg = makeUserMessage({ id: 1, conversationId: 1, text: "帮我盯一下 #268", createdAt: 1_000 });
    const firstPmReply = makeMessage({ id: 2, conversationId: 1, text: "好的，已经派出去跑了", createdAt: 1_200 });
    const pmTool = makeToolMessage({ id: 11, conversationId: 1, text: "hub worker show 268", createdAt: 2_100 });
    const pmAfterWake = makeMessage({ id: 12, conversationId: 1, text: "我刚看了一眼 #268，它在收尾", createdAt: 2_500 });

    const all = [userMsg, firstPmReply, maxTimeTrigger, pmTool, pmAfterWake];
    const visible = visibleMessages(all);
    expect(visible.map((m) => m.id)).toEqual([1, 2, 11, 12]);
    expect(visible.some((m) => m.id === 10)).toBe(false);

    const { items: grouped } = groupMessages(all);
    // 渲染流中不包含超时触发消息本身，但包含用户消息、第一轮 PM 回复、以及超时唤醒后 PM 的新一轮回复（含折叠的步骤与正文）
    expect(grouped.some((item) => item.kind === "message" && item.message.id === 10)).toBe(false);
    const turnReplies = grouped.filter((item): item is Extract<typeof item, { kind: "turn" }> => item.kind === "turn");
    expect(turnReplies).toHaveLength(2);
    expect(turnReplies[0]?.parts.map((p) => p.text)).toEqual(["好的，已经派出去跑了"]);
    expect(turnReplies[1]?.work.map((s) => s.id)).toEqual([11]);
    expect(turnReplies[1]?.parts.map((p) => p.text)).toEqual(["我刚看了一眼 #268，它在收尾"]);
    // 唤醒后的那一轮耗时按唤醒触发消息的时间起算
    expect(turnReplies[1]?.startedAt).toBe(2_000);
    expect(turnReplies[1]?.endedAt).toBe(2_500);
  });

  it("listConversations 左侧预览不会显示超时静默触发消息，而显示上一条可见消息或 PM 随后的回复", () => {
    const userMsg = makeUserMessage({ id: 1, conversationId: 1, text: "帮我盯一下 #268", createdAt: 1_000 });
    const firstPmReply = makeMessage({ id: 2, conversationId: 1, text: "好的，已经派出去跑了", createdAt: 1_200 });
    const stateBeforeReply: HubState = {
      ...initialState,
      phase: "ready",
      pms: [makePm({ id: 1, name: "小林" })],
      conversations: {
        1: {
          conversation: makeConversation({ id: 1, pmId: 1, title: "小林" }),
          messages: [userMsg, firstPmReply, maxTimeTrigger],
          hasMore: false,
        },
      },
      sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1, activity: "working" })],
    };
    expect(previewText(listConversations(stateBeforeReply)[0]!)).toBe("好的，已经派出去跑了");

    const pmAfterWake = makeMessage({ id: 12, conversationId: 1, text: "我刚看了一眼 #268，它在收尾", createdAt: 2_500 });
    const stateAfterReply: HubState = {
      ...stateBeforeReply,
      conversations: {
        1: {
          conversation: makeConversation({ id: 1, pmId: 1, title: "小林" }),
          messages: [userMsg, firstPmReply, maxTimeTrigger, pmAfterWake],
          hasMore: false,
        },
      },
    };
    expect(previewText(listConversations(stateAfterReply)[0]!)).toBe("我刚看了一眼 #268，它在收尾");
  });
});

describe("previewText：通知正文用的对话预览", () => {
  function entryOf(messages: Message[]) {
    const state: HubState = {
      ...initialState,
      phase: "ready",
      pms: [makePm({ id: 1, name: "小林" })],
      conversations: { 1: { conversation: makeConversation({ id: 1, pmId: 1, title: "小林", createdAt: 0 }), messages, hasMore: false } },
    };
    return listConversations(state)[0]!;
  }

  it("跳过工具调用和 Worker 开工、收工行，显示最后一条文字", () => {
    const entry = entryOf([
      makeMessage({ id: 1, conversationId: 1, text: "最后的话", createdAt: 1_000 }),
      makeToolMessage({ id: 2, conversationId: 1, text: "Bash: ls", createdAt: 2_000 }),
      makeWorkerLine({ id: 3, conversationId: 1, line: { event: "ended" }, createdAt: 3_000 }),
    ]);
    expect(previewText(entry)).toBe("最后的话");
  });

  it("只发文件的消息写“[File] 名字”，多个用逗号隔开；有文字的还是文字", () => {
    const files = [makeAttachment({ name: "报告.pdf" }), makeAttachment({ id: "1111111111111111", name: "图.png" })];
    expect(previewText(entryOf([makeUserMessage({ id: 1, conversationId: 1, text: "", meta: { attachments: files } })]))).toBe("[File] 报告.pdf, 图.png");
    expect(previewText(entryOf([makeUserMessage({ id: 1, conversationId: 1, text: "看这两个", meta: { attachments: files } })]))).toBe("看这两个");
  });

  it("撤回到输入框的消息不进预览，回到上一句", () => {
    const entry = entryOf([
      makeMessage({ id: 1, conversationId: 1, text: "早，要做什么？", createdAt: 1_000 }),
      makeUserMessage({ id: 2, conversationId: 1, text: "把鉴权逻辑抽成中间件", status: "stopped", meta: { rewound: true }, createdAt: 2_000 }),
    ]);
    expect(previewText(entry)).toBe("早，要做什么？");
  });

  it("写交接的请求、交接全文和换代那一行都不进预览，也不算最后活动时间", () => {
    const entry = entryOf([
      makeMessage({ id: 1, conversationId: 1, text: "小林在", createdAt: 1_000 }),
      makeSystemMessage({ id: 2, conversationId: 1, text: "写交接", status: "replied", createdAt: 2_000, event: { event: "handover.requested", sessionId: 1, auto: true } }),
      makeMessage({ id: 3, conversationId: 1, text: "交接全文：暗号是蓝鲸", meta: { handover: true }, createdAt: 3_000 }),
      makeSystemMessage({ id: 4, conversationId: 1, text: "交接全文：暗号是蓝鲸", createdAt: 4_000, event: { event: "session.renewed", sessionId: 2, fromSessionId: 1, turnStartId: 30, auto: true } }),
    ]);
    expect(previewText(entry)).toBe("小林在");
    expect(entry.lastAt).toBe(1_000);
  });
});

describe("workerOutcomesOf: PM-retained reports and failures", () => {
  function stateWith(pmMessages: Message[], workerLine?: HubState["conversations"][number]["workerLine"]): HubState {
    return {
      ...initialState,
      phase: "ready",
      pms: [makePm({ id: 1, name: "小林" })],
      conversations: {
        1: { conversation: makeConversation({ id: 1, pmId: 1, title: "小林" }), messages: pmMessages, hasMore: false },
        30: {
          conversation: makeConversation({ id: 30, kind: "worker", pmId: 1, projectId: 1, title: "修 X" }),
          messages: [],
          hasMore: false,
          ...(workerLine === undefined ? {} : { workerLine }),
        },
      },
    };
  }

  it("collects reports and failures in order, unwraps PM report bodies, and ignores routine start and end lines", () => {
    const reportBody = "=== 汇报 ===\n状态: 做完了\n摘要: 阈值挪进 VENDOR_SPECS\n=== 汇报结束 ===";
    const graphWrapped = [
      "【Worker #3 · 修 X 的汇报】",
      "",
      "【任务图 #2「换会话阈值」第 2/5 步「修 X」等你处理】Worker #3：汇报有问题",
      "",
      "卡在超时阈值",
      "",
      "回答或打回：hub worker send 3 --stdin；换人：hub worker start --node x。",
    ].join("\n");
    const state = stateWith([
      makeWorkerLine({ id: 1, conversationId: 1, line: { event: "started" } }),
      makeWorkerLine({
        id: 2,
        conversationId: 1,
        line: { event: "report", status: "done", summary: "阈值挪进 VENDOR_SPECS" },
        text: `【Worker #3 · 修 X 的汇报】\n\n${reportBody}`,
      }),
      makeWorkerLine({
        id: 3,
        conversationId: 1,
        line: { event: "report", status: "problem", summary: "卡在超时阈值" },
        text: graphWrapped,
      }),
      makeWorkerLine({
        id: 4,
        conversationId: 1,
        line: { event: "report", status: "done", summary: "仅有摘要" },
      }),
      makeWorkerLine({
        id: 5,
        conversationId: 1,
        line: { event: "worktree_failed", summary: "git worktree add failed: disk full" },
        text: "【Worker #3 · 修 X 的汇报】\n\n建 worktree 失败，这个 Worker 没能开工",
      }),
      makeWorkerLine({ id: 6, conversationId: 1, line: { event: "ended" } }),
    ]);

    const outcomes = workerOutcomesOf(state, 30);
    expect(outcomes.map((o) => [o.id, o.line.event, o.reportBody])).toEqual([
      [2, "report", reportBody],
      [3, "report", "卡在超时阈值"],
      [4, "report", null],
      [5, "worktree_failed", null],
    ]);
  });

  it("falls back to the slimmed snapshot workerLine when PM messages no longer include that failure", () => {
    const line = {
      workerId: 3,
      workerConversationId: 30,
      title: "修 X",
      readonly: false,
      event: "worktree_failed" as const,
      status: null,
      summary: "git worktree add failed: disk full",
    };
    const state = stateWith([], { messageId: 9, at: 50_000, line, endedAt: 50_000 });
    expect(workerOutcomesOf(state, 30)).toEqual([{ id: 9, at: 50_000, line, reportBody: null }]);
  });
});
