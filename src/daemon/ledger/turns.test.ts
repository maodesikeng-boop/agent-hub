import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MessageId, WorkerId } from "../../shared/domain.ts";
import { TURN_SUMMARIES_PER_PAGE_MAX } from "../../shared/limits.ts";
import { replyIdOf } from "../../shared/turn-reply.ts";
import type { TurnSummary } from "../../shared/turn.ts";
import { REPORT_END, REPORT_START } from "../../shared/worker.ts";
import { workerOpsFixture } from "./test-helpers.ts";

let f: ReturnType<typeof workerOpsFixture>;
beforeEach(() => { f = workerOpsFixture(); });
afterEach(async () => { await f.close(); });

const report = (status: string, summary: string) =>
  `Done.\n\n${REPORT_START}\n状态: ${status}\n摘要: ${summary}\n提交: abc123\n测试: unit tests passed\n问题: 无\n${REPORT_END}`;

interface TurnRow {
  id: number;
  cause: string;
  status: string;
  outcome: string | null;
  stop_source: string | null;
  parent_turn_id: number | null;
  duration_ms: number | null;
}

const turnsOf = (sessionId: number) => f.db.all<TurnRow>(
  "SELECT id, cause, status, outcome, stop_source, parent_turn_id, duration_ms FROM turns WHERE session_id = ? ORDER BY id", sessionId,
);
const workerLinesOf = (workerId: WorkerId) => f.db.all<{ event: string; status: string | null; text: string }>(
  "SELECT json_extract(meta, '$.event') AS event, json_extract(meta, '$.status') AS status, text FROM messages WHERE worker_id = ? AND kind = 'worker' ORDER BY id",
  workerId,
);
const pmEmit = (type: string, data: object = {}) =>
  f.ledger.applyDriverEvent(f.pm.sessionId, { type, at: f.now(), ...data } as Parameters<typeof f.ledger.applyDriverEvent>[1]);
const pageTurns = (): readonly TurnSummary[] | undefined =>
  f.ledger.messagesBefore(f.project.conversationId, Number.MAX_SAFE_INTEGER).turns;
const activeTurnOf = (sessionId: number) => f.ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.activeTurnId;

function takeIn(workerId: WorkerId, id: MessageId) {
  f.emit(workerId, { type: "message.delivered", messageIds: [id], at: f.now() });
  f.emit(workerId, { type: "message.processing", messageIds: [id], at: f.now() });
}

describe("one turn per model execution", () => {
  it("measures a PM turn on the daemon clock and keeps a mid-turn system notice inside it", async () => {
    const graphId = f.hub("graph.create", { specJson: '{"title":"Example","nodes":[{"key":"step","title":"Step"}]}' }).data.graph.id;
    const { messageId } = f.ledger.postUserMessage({ conversationId: f.project.conversationId, clientId: "start", text: "Start" });
    pmEmit("message.delivered", { messageIds: [messageId] });
    pmEmit("message.processing", { messageIds: [messageId] });
    const running = pageTurns();
    expect(running).toHaveLength(1);
    expect(running![0]).toMatchObject({ status: "running", cause: "input", durationMs: null, endedAt: null });
    expect(activeTurnOf(f.pm.sessionId)).toBe(running![0]!.id);

    f.advance(27_000);
    pmEmit("agent.checklist", { uuid: "working", update: { kind: "merge", items: [{ id: "check", title: "Check work", status: "in_progress" }] } });
    const checklistId = f.ledger.messagesBefore(f.project.conversationId, Number.MAX_SAFE_INTEGER).messages.at(-1)!.id;
    f.advance(3_000);
    const { messageId: noticeId } = f.ledger.cancelTaskGraph(graphId, { reason: "Cancelled" });
    if (noticeId === null) throw new Error("Missing system notice");
    pmEmit("message.delivered", { messageIds: [noticeId], midTurn: true });
    pmEmit("message.processing", { messageIds: [noticeId], midTurn: true });
    f.advance(15_000);
    // The vendor's own figure disagrees with the daemon clock; the daemon clock wins.
    pmEmit("turn.ended", { messageIds: [messageId, noticeId], durationMs: 44_000, interrupted: false, ok: true });
    await f.ledger.settleDriverEvents();

    const [turn, extra] = pageTurns() ?? [];
    expect(extra).toBeUndefined();
    expect(turn).toMatchObject({ status: "ended", outcome: "ok", durationMs: 45_000 });
    expect(turn!.inputs).toEqual([
      { messageId, role: "opening", afterMessageId: expect.any(Number) },
      { messageId: noticeId, role: "mid_turn", afterMessageId: checklistId },
    ]);
    expect(turn!.firstOutputId).toBe(checklistId);
    expect(activeTurnOf(f.pm.sessionId)).toBeNull();

    f.advance(5_000);
    const { messageId: next } = f.ledger.postUserMessage({ conversationId: f.project.conversationId, clientId: "next", text: "Follow up" });
    pmEmit("message.delivered", { messageIds: [next] });
    pmEmit("message.processing", { messageIds: [next] });
    f.advance(12_000);
    pmEmit("agent.text", { uuid: "answer", text: "Answer" });
    pmEmit("turn.ended", { messageIds: [next], durationMs: null, interrupted: false, ok: true });
    await f.ledger.settleDriverEvents();
    const summaries = pageTurns()!;
    expect(summaries.map((s) => [s.status, s.durationMs])).toEqual([["ended", 45_000], ["ended", 12_000]]);
    expect(summaries[1]!.id).not.toBe(summaries[0]!.id);
  });

  it("settles a reply received after the wall clock moves backward", async () => {
    const { messageId } = f.ledger.postUserMessage({ conversationId: f.project.conversationId, clientId: "rollback", text: "Start" });
    pmEmit("message.delivered", { messageIds: [messageId] });
    pmEmit("message.processing", { messageIds: [messageId] });
    const startedAt = f.now();
    f.advance(-5);
    pmEmit("agent.text", { uuid: "rollback-reply", text: "Answer" });
    pmEmit("turn.ended", { messageIds: [messageId], durationMs: null, interrupted: false, ok: true });
    await f.ledger.settleDriverEvents();

    expect(pageTurns()).toEqual([expect.objectContaining({ status: "ended", outcome: "ok", startedAt, endedAt: startedAt, durationMs: 0 })]);
    expect(f.ledger.getMessage(messageId)?.status).toBe("replied");
    expect(activeTurnOf(f.pm.sessionId)).toBeNull();
  });

  it("settles an input as replied when the success receipt arrives after a provisional stop", async () => {
    const { messageId } = f.ledger.postUserMessage({ conversationId: f.project.conversationId, clientId: "race", text: "Question" });
    pmEmit("message.delivered", { messageIds: [messageId] });
    pmEmit("message.processing", { messageIds: [messageId] });
    f.ledger.stopMessage(messageId, f.pm.sessionId);
    pmEmit("agent.text", { uuid: "answer", text: "The answer" });
    const answerId = f.ledger.messagesBefore(f.project.conversationId, Number.MAX_SAFE_INTEGER).messages.at(-1)!.id;
    pmEmit("turn.ended", { messageIds: [messageId], durationMs: 5, interrupted: false, ok: true });
    await f.ledger.settleDriverEvents();

    const settled = f.ledger.getMessage(messageId)!;
    expect(settled.status).toBe("replied");
    expect(replyIdOf(settled)).toBe(answerId);
    expect(pageTurns()?.[0]).toMatchObject({ outcome: "ok", stopSource: "session_ended" });
  });

  it("names the user as the stop source when the user stops a turn", async () => {
    const { messageId } = f.ledger.postUserMessage({ conversationId: f.project.conversationId, clientId: "stop", text: "Long task" });
    pmEmit("message.delivered", { messageIds: [messageId] });
    pmEmit("message.processing", { messageIds: [messageId] });
    f.ledger.requestStop(f.project.conversationId);
    pmEmit("turn.ended", { messageIds: [messageId], durationMs: 5, interrupted: true, ok: false });
    await f.ledger.settleDriverEvents();

    expect(f.ledger.getMessage(messageId)?.status).toBe("stopped");
    expect(pageTurns()?.[0]).toMatchObject({ status: "ended", outcome: "interrupted", stopSource: "user" });
  });
});

it("caps the summaries on one message page and covers every turn behind it", async () => {
  for (let i = 0; i < 150; i++) {
    const { messageId } = f.ledger.postUserMessage({ conversationId: f.project.conversationId, clientId: `bulk-${i}`, text: `Question ${i}` });
    pmEmit("message.delivered", { messageIds: [messageId] });
    pmEmit("message.processing", { messageIds: [messageId] });
    f.advance(1_000);
    pmEmit("agent.text", { uuid: `bulk-${i}`, text: `Answer ${i}` });
    pmEmit("turn.ended", { messageIds: [messageId], durationMs: null, interrupted: false, ok: true });
  }
  await f.ledger.settleDriverEvents();
  const page = f.ledger.messagesBefore(f.project.conversationId, Number.MAX_SAFE_INTEGER);
  const ids = new Set(page.messages.map((m) => m.id));
  expect(page.turns!.length).toBeLessThanOrEqual(TURN_SUMMARIES_PER_PAGE_MAX);
  for (const m of page.messages.filter((m) => m.sender === "agent")) {
    expect(page.turns!.some((t) => t.firstOutputId !== null && t.firstOutputId <= m.id && m.id <= t.lastOutputId!)).toBe(true);
  }
  expect(page.turns!.every((t) => t.inputs.some((input) => ids.has(input.messageId)) || (t.firstOutputId !== null && ids.has(t.firstOutputId)))).toBe(true);
});

describe("restart recovery", () => {
  const graph = () => f.hub("graph.create", { specJson: '{"title":"Example","nodes":[{"key":"a","title":"A"}]}' }).data.graph.id;

  function interruptedBrief() {
    const graphId = graph();
    const { id: workerId } = f.hub("worker.start", { node: "a", graphId, task: "Inspect", noWorktree: true, maxTimeMs: 60 * 60_000 }).data.worker;
    const brief = f.begin(workerId);
    f.advance(25 * 60_000);
    f.end(workerId, { messageIds: [brief], ok: false, interrupted: true, shutdown: true });
    return { graphId, workerId, brief, sessionId: f.sessionOf(workerId) };
  }

  it("ends the interrupted turn by shutdown and opens one recovery turn linked to it", () => {
    const { workerId, brief, sessionId } = interruptedBrief();
    expect(f.ledger.recoverAfterRestart().resentMessageIds).toEqual([brief]);
    expect(f.ledger.recoverAfterRestart().resentMessageIds).toEqual([]);
    const [interrupted] = turnsOf(sessionId);
    expect(interrupted).toMatchObject({ cause: "input", status: "ended", outcome: "interrupted", stop_source: "shutdown", duration_ms: 25 * 60_000 });

    takeIn(workerId, brief);
    expect(turnsOf(sessionId)[1]).toMatchObject({ cause: "recovery", status: "running", parent_turn_id: interrupted!.id });
  });

  it("shows the recovery attempt's clock and the work budget as separate facts", () => {
    const { workerId, brief } = interruptedBrief();
    f.ledger.recoverAfterRestart();
    f.advance(60_000);
    takeIn(workerId, brief);
    f.advance(2 * 60_000);
    const show = f.hub("worker.show", { workerId }).text;
    expect(show).toMatch(/^这一轮跑了 2m，走了 0 步（守护进程重启后重发）$/m);
    expect(show).toMatch(/^时间预算：最大时间 1h，剩余 32m（从派活时起算，重启不重置）$/m);
  });

  it("does not report an empty recovery turn when newer PM work is already queued", () => {
    const { graphId, workerId, brief, sessionId } = interruptedBrief();
    f.ledger.recoverAfterRestart();
    const followup = f.hub("worker.send", { workerId, text: "Check the tests instead" }).data.messageId;
    takeIn(workerId, brief);
    f.end(workerId, { messageIds: [brief], ok: true, interrupted: false });
    expect(turnsOf(sessionId).at(-1)).toMatchObject({ cause: "recovery", outcome: "empty_recovery" });
    expect(workerLinesOf(workerId).filter((l) => l.event !== "started")).toEqual([]);
    expect(f.hub("graph.show", { graphId }).data.graph.nodes[0]).not.toMatchObject({ waitingFor: "pm" });

    takeIn(workerId, followup);
    f.emit(workerId, { type: "agent.text", uuid: "report", text: report("做完了", "Tests pass"), at: f.now() });
    f.end(workerId, { messageIds: [followup], ok: true, interrupted: false });
    expect(workerLinesOf(workerId).filter((l) => l.event !== "started" && l.event !== "ended").map((l) => [l.event, l.status])).toEqual([["report", "done"]]);
    const snapshot = f.ledger.snapshot();
    const conversationId = snapshot.sessions.find((s) => s.sessionId === sessionId)?.conversationId;
    const workerConversation = snapshot.conversations.find((c) => c.conversation.id === conversationId);
    expect(workerConversation?.workerLine).toMatchObject({ line: { event: "ended" }, endedAt: f.now() });
  });

  it("tells the PM once that an empty recovery turn produced nothing, without calling it unformatted", () => {
    const { graphId, workerId, brief, sessionId } = interruptedBrief();
    f.ledger.recoverAfterRestart();
    takeIn(workerId, brief);
    f.end(workerId, { messageIds: [brief], ok: true, interrupted: false });

    expect(turnsOf(sessionId).at(-1)).toMatchObject({ cause: "recovery", outcome: "empty_recovery" });
    const lines = workerLinesOf(workerId).filter((l) => l.event !== "started");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "turn_failed" });
    expect(lines[0]!.text).toContain("重启");
    expect(lines[0]!.text).not.toContain("没有文字回复");
    expect(lines[0]!.text).not.toContain("没按格式");
    expect(f.hub("graph.show", { graphId }).data.graph.nodes[0]).toMatchObject({ status: "waiting", waitingFor: "pm" });
  });

  it("keeps the ordinary empty-turn rule for a turn that is not a recovery", () => {
    const { id: workerId } = f.hub("worker.start", { title: "Worker", task: "Inspect", noWorktree: true }).data.worker;
    const brief = f.begin(workerId);
    f.end(workerId, { messageIds: [brief], ok: true, interrupted: false });
    const lines = workerLinesOf(workerId).filter((l) => l.event !== "started");
    expect(lines.map((l) => [l.event, l.status])).toEqual([["report", "unformatted"]]);
    expect(lines[0]!.text).toContain("没有文字回复");
  });
});
