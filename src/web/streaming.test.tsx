// 网页流式文字实时渲染与爆炸半径守卫测试：
// 1. 首轮空轮次与多步轮次实时渲染 Markdown 流式文本；
// 2. message.created 先于 session.status 到达时原子清掉 streamingText，绝不重影、不重播 .message-enter；
// 3. 流式更新期间左栏、右栏、输入框、历史消息渲染次数严格为 0。
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StateSnapshot, WsServerMessage } from "../shared/index.ts";
import { App } from "./App.tsx";
import * as ComposerMod from "./components/Composer.tsx";
import * as MessagesMod from "./components/Messages.tsx";
import * as RightRailMod from "./components/RightRail.tsx";
import * as SidebarMod from "./components/Sidebar.tsx";
import { applyChange, initialState, reducer, type HubState } from "./state.ts";
import {
  FakeApi,
  FakeWebSocket,
  installFakeWebSocket,
  makeConvSnapshot,
  makeMessage,
  makePm,
  makeSession,
  makeSnapshot,
  makeToolMessage,
  makeUserMessage,
  makeWorkerConversation,
  makeWorkerLine,
  messageChange,
  openFirstConversation,
  sessionChange,
} from "./test-utils.ts";

async function bootApp(snapshot: StateSnapshot) {
  openFirstConversation(snapshot);
  const api = new FakeApi(snapshot);
  api.install();
  installFakeWebSocket();
  const view = render(<App />);
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  act(() => FakeWebSocket.last.open());
  return { ws: FakeWebSocket.last, ...view };
}

function push(ws: FakeWebSocket, msg: WsServerMessage) {
  act(() => ws.push(msg));
}

describe("网页流式文字渲染与无重影衔接", () => {
  it("applyChange：收到 agent 的 message.created 时即使下一拍 session.status 还没到，也立即清掉该会话的 streamingText", () => {
    const s1 = makeSession({
      sessionId: 10,
      conversationId: 1,
      status: "running",
      activity: "working",
      step: { type: "text" },
      streamingText: "正在生成的完整段落",
    });
    let state: HubState = {
      ...initialState,
      phase: "ready",
      seq: 1,
      conversations: { 1: makeConvSnapshot([makeUserMessage({ id: 1, conversationId: 1 })], { conversation: { id: 1 } }) },
      sessions: [s1],
    };

    state = applyChange(
      state,
      messageChange(2, "message.created", makeMessage({ id: 2, conversationId: 1, sessionId: 10, text: "正在生成的完整段落" })),
    );
    expect(state.sessions[0]?.streamingText).toBeUndefined();
    expect(state.conversations[1]?.messages.at(-1)?.text).toBe("正在生成的完整段落");
  });

  it("乐观 rewind 在停止状态帧到达前立即清掉本对话流式预览", () => {
    const state: HubState = {
      ...initialState,
      phase: "ready",
      conversations: { 1: makeConvSnapshot([makeUserMessage({ id: 1, conversationId: 1, status: "processing" })], { conversation: { id: 1 } }) },
      sessions: [makeSession({ sessionId: 10, conversationId: 1, activity: "working", streamingText: "旧回复草稿" })],
      pending: [{ clientId: "pending-1", conversationId: 1, text: "待发问题", attachments: [], phase: "sending", createdAt: 1 }],
    };
    expect(reducer(state, { type: "messageRewind", conversationId: 1, messageId: 1 }).sessions[0]?.streamingText).toBeUndefined();
    expect(reducer(state, { type: "pendingRewind", clientId: "pending-1" }).sessions[0]?.streamingText).toBeUndefined();
  });

  it("实时显示流式 Markdown，落库切换时零双份重影、零 .message-enter 重播，且多步工具后继续流式共用同一轮头像", async () => {
    const snapshot = makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      conversations: [
        makeConvSnapshot(
          [
            makeUserMessage({ id: 1, conversationId: 1, text: "以前的问题" }),
            makeMessage({ id: 2, conversationId: 1, sessionId: 10, text: "以前的回答" }),
            makeUserMessage({ id: 3, conversationId: 1, text: "帮我查一下流式输出" }),
          ],
          { conversation: { id: 1, pmId: 1, title: "小林" } },
        ),
        makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 30, pmId: 1, title: "并行任务" }) }),
      ],
      sessions: [
        makeSession({ sessionId: 10, conversationId: 1, pmId: 1, status: "running", activity: "working", step: { type: "thinking" } }),
        makeSession({ sessionId: 300, conversationId: 30, status: "running", activity: "working" }),
      ],
    });
    // 加一条未收工 Worker 行使右栏展开在屏上
    snapshot.conversations[0]!.messages.splice(
      2,
      0,
      makeWorkerLine({ id: 25, conversationId: 1, line: { workerId: 3, workerConversationId: 30, title: "并行任务", event: "started" } }),
    );

    const { ws, container } = await bootApp(snapshot);

    // 1. 第一段开场状态反馈流式进入（尚无本轮入库消息）
    push(ws, sessionChange(20, makeSession({
      sessionId: 10,
      conversationId: 1,
      pmId: 1,
      status: "running",
      activity: "working",
      step: { type: "text" },
      streamingText: "我先看看",
    })));
    expect(screen.getByText("我先看看")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-streaming='true']")).toHaveLength(1);

    push(ws, sessionChange(21, makeSession({
      sessionId: 10,
      conversationId: 1,
      pmId: 1,
      status: "running",
      activity: "working",
      step: { type: "text" },
      streamingText: "我先看看**驱动层**代码。",
    })));
    expect(screen.getByText("驱动层").tagName).toBe("STRONG");

    // 2. 第一段入库：message.created 先到（session.status 后到），界面全程只有一份文字，无重影，且不加 .message-enter
    push(ws, messageChange(22, "message.created", makeMessage({
      id: 4,
      conversationId: 1,
      sessionId: 10,
      text: "我先看看**驱动层**代码。",
    })));
    expect(container.querySelectorAll("[data-streaming='true']")).toHaveLength(0);
    expect(screen.getAllByText("驱动层")).toHaveLength(1);
    const turns = container.querySelectorAll("[data-turn]");
    expect(turns[turns.length - 1]!.classList.contains("message-enter")).toBe(false);

    // 3. 紧接着调工具 + 第二段长回复流式进入：挂在同一轮（头像总数仍然是历史 1 个 + 当前轮 1 个 = 2 个）
    push(ws, messageChange(23, "message.created", makeToolMessage({
      id: 5,
      conversationId: 1,
      sessionId: 10,
      text: "Read: src/vendors/agy/driver.ts",
    })));
    push(ws, sessionChange(24, makeSession({
      sessionId: 10,
      conversationId: 1,
      pmId: 1,
      status: "running",
      activity: "working",
      step: { type: "text" },
      streamingText: "查清楚了，根因在流式增量没有透出。",
    })));
    expect(screen.getByText("查清楚了，根因在流式增量没有透出。")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-slot='agent-head']")).toHaveLength(2);
  });

  it("爆炸半径隔离：连续流式更新期间 DraftComposer 与历史 TurnView 零重画，左栏与右栏 DOM 零变更", async () => {
    const snapshot = makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      conversations: [
        makeConvSnapshot(
          [
            makeUserMessage({ id: 1, conversationId: 1, text: "第一问" }),
            makeMessage({ id: 2, conversationId: 1, sessionId: 10, text: "第一答" }),
            makeWorkerLine({ id: 3, conversationId: 1, line: { workerId: 3, workerConversationId: 30, title: "并行活", event: "started" } }),
            makeUserMessage({ id: 4, conversationId: 1, text: "第二问" }),
          ],
          { conversation: { id: 1, pmId: 1, title: "小林" } },
        ),
        makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 30, pmId: 1, title: "并行活" }) }),
      ],
      sessions: [
        makeSession({ sessionId: 10, conversationId: 1, pmId: 1, status: "running", activity: "working", step: { type: "text" } }),
        makeSession({ sessionId: 300, conversationId: 30, status: "running", activity: "working" }),
      ],
    });

    type MemoTarget = { type: (...args: unknown[]) => unknown };
    const composerSpy = vi.spyOn(ComposerMod.DraftComposer as unknown as MemoTarget, "type");
    const turnSpy = vi.spyOn(MessagesMod.TurnView as unknown as MemoTarget, "type");
    const sidebarSpy = vi.spyOn(SidebarMod.Sidebar as unknown as MemoTarget, "type");
    const rightRailSpy = vi.spyOn(RightRailMod.RightRail as unknown as MemoTarget, "type");

    const { ws, container } = await bootApp(snapshot);
    composerSpy.mockClear();
    turnSpy.mockClear();
    sidebarSpy.mockClear();
    rightRailSpy.mockClear();

    const sidebarEl = container.querySelector("aside")!;
    const sidebarMutations = vi.fn();
    const obs = new MutationObserver(sidebarMutations);
    obs.observe(sidebarEl, { subtree: true, childList: true, attributes: true, characterData: true });

    for (let i = 1; i <= 8; i++) {
      push(ws, sessionChange(20 + i, makeSession({
        sessionId: 10,
        conversationId: 1,
        pmId: 1,
        status: "running",
        activity: "working",
        step: { type: "text" },
        streamingText: "流式片段".repeat(i),
      })));
    }
    obs.disconnect();

    expect(screen.getByText("流式片段".repeat(8))).toBeInTheDocument();
    // 输入框、左栏、右栏全部 0 次重渲染
    expect(composerSpy).toHaveBeenCalledTimes(0);
    expect(sidebarSpy).toHaveBeenCalledTimes(0);
    expect(rightRailSpy).toHaveBeenCalledTimes(0);
    // 8 次流式帧里只重画底部活跃那一轮（每次 1 个 TurnView，历史第一答那轮 0 次）
    expect(turnSpy).toHaveBeenCalledTimes(8);
    expect(sidebarMutations).toHaveBeenCalledTimes(0);

    composerSpy.mockRestore();
    turnSpy.mockRestore();
    sidebarSpy.mockRestore();
    rightRailSpy.mockRestore();
  });
});
