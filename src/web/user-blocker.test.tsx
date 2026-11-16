// 要用户本人动手的事（docs/user-blockers-design.md）：被卡住的步骤显示 Waiting on you 和提醒卡（不是拍板卡、不是 Waiting on PM），
// 对话里同一张卡；点 Done 调本机的重查接口；它不算总助的待决拍板。
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pendingDecisionsOf } from "../shared/decisions.ts";
import type { StateSnapshot, TaskGraph, TaskNode } from "../shared/index.ts";
import { App } from "./App.tsx";
import { FakeApi, FakeWebSocket, installFakeWebSocket, makeConvSnapshot, makeMessage, makePm, makeProject, makeSession, makeSnapshot } from "./test-utils.ts";

const CARD_TEXT = "这台设备（东京）的 Antigravity 没登录：先在这台设备的终端里跑 `agy` 登录";
const RECHECK_PATH = /^\/api\/user-blockers\/5\/recheck$/;

function blockedNode(): TaskNode {
  return {
    key: "verify",
    title: "验收",
    status: "waiting",
    waitingFor: "user",
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
    userBlocker: { id: 5, kind: "vendor_signed_out", vendor: "agy", device: "东京", recheckedAs: null },
    decision: null,
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

function graph(): TaskGraph {
  return {
    id: 21,
    projectId: 1,
    pmId: 1,
    conversationId: 1,
    title: "卡片修复",
    status: "active",
    originMsgId: null,
    nodes: [blockedNode()],
    edges: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    completedAt: null,
  };
}

function snapshot(): StateSnapshot {
  return makeSnapshot({
    pms: [makePm({ id: 1, name: "小林" })],
    projects: [makeProject({ id: 1, pmId: 1, conversationId: 1 })],
    conversations: [
      makeConvSnapshot(
        [makeMessage({ id: 120, text: CARD_TEXT, meta: { needsUser: true, blockerRef: { blockerId: 5 } }, dedupeKey: "ask:1:120" })],
        { conversation: { id: 1, pmId: 1, title: "小林" } },
      ),
    ],
    sessions: [makeSession({ sessionId: 10, conversationId: 1, pmId: 1 })],
    activeTaskGraphs: [graph()],
  });
}

async function boot(snap: StateSnapshot) {
  window.history.replaceState(null, "", "/#/c/1");
  const api = new FakeApi(snap);
  api.install();
  installFakeWebSocket();
  render(<App />);
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  act(() => FakeWebSocket.last.open());
  return api;
}

const sidePanel = () => screen.getByRole("complementary", { name: "Side panel" });

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("要用户动手的提醒卡", () => {
  it("步骤显示 Waiting on you 和提醒卡，不出拍板卡；点 Done 调本机的重查接口", async () => {
    const user = userEvent.setup();
    const api = await boot(snapshot());
    const graphs = await waitFor(() => within(sidePanel()).getByRole("region", { name: /^Task Graph$/ }));
    expect(within(graphs).queryByTestId("peel-gate-card")).toBeNull();
    expect(within(graphs).queryByText("Waiting on PM")).toBeNull();
    const card = within(graphs).getByTestId("user-blocker-card");
    expect(within(card).getByText("Waiting on you")).toBeInTheDocument();
    expect(card).toHaveTextContent("这台设备（东京）的 Antigravity 没登录");

    await user.click(within(card).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(api.callsTo("POST", RECHECK_PATH)).toHaveLength(1));
  });

  it("对话里那条消息是同一张卡，带 Done 按钮", async () => {
    const user = userEvent.setup();
    const api = await boot(snapshot());
    const log = await screen.findByRole("log");
    const card = within(log).getByTestId("user-blocker-card");
    expect(card).toHaveTextContent("这台设备（东京）的 Antigravity 没登录");
    await user.click(within(card).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(api.callsTo("POST", RECHECK_PATH)).toHaveLength(1));
  });

  it("不算总助的待决拍板", () => {
    const decisions = pendingDecisionsOf(snapshot());
    expect(decisions.filter((d) => d.source.kind === "gate")).toHaveLength(0);
  });
});
