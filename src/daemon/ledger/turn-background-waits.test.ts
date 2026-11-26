import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workerMessageDedupeKey, type WorkerId } from "../../shared/domain.ts";
import type { AgentVendor } from "../../shared/vendors.ts";
import { REPORT_END, REPORT_START } from "../../shared/worker.ts";
import { canDeliverSystemMessage } from "../handlers.ts";
import { workerOpsFixture } from "./test-helpers.ts";

let f: ReturnType<typeof workerOpsFixture>;
beforeEach(() => { f = workerOpsFixture(); });
afterEach(async () => { await f.close(); });

const MINUTE = 60_000;
const report = (status: string, summary: string) =>
  `Pushed.\n\n${REPORT_START}\n状态: ${status}\n摘要: ${summary}\n提交: abc123\n测试: unit tests passed\n问题: 无\n${REPORT_END}`;

const reportsOf = (workerId: WorkerId) => f.db.all<{ status: string; summary: string; text: string }>(
  "SELECT json_extract(meta, '$.status') AS status, json_extract(meta, '$.summary') AS summary, text FROM messages WHERE worker_id = ? AND kind = 'worker' AND json_extract(meta, '$.event') = 'report' ORDER BY id",
  workerId,
);
const remindersOf = (workerId: WorkerId) => f.db.all<{ id: number; text: string; reminder: number }>(
  "SELECT id, text, json_extract(meta, '$.reminder') AS reminder FROM messages WHERE conversation_id = ? AND json_extract(meta, '$.event') = 'worker.background_wait' AND json_extract(meta, '$.workerId') = ? ORDER BY id",
  f.project.conversationId, workerId,
);

function workerWithBackground(vendor: AgentVendor, text = report("做完了", "Waiting for CI"), graphId?: number): WorkerId {
  const { id: workerId } = f.hub("worker.start", { title: "Worker", task: "Push and wait for CI", noWorktree: true, vendor, ...(graphId === undefined ? {} : { graphId, node: "a" }) }).data.worker;
  const brief = f.begin(workerId);
  f.emit(workerId, { type: "background.changed", count: 1, tasks: [{ id: "bg-1", label: "watch the CI run", startedAt: f.now() }], at: f.now() });
  f.emit(workerId, { type: "agent.text", uuid: "draft", text, at: f.now() });
  f.end(workerId, { messageIds: [brief] });
  return workerId;
}

function wakeTurn(workerId: WorkerId, text: string | null) {
  f.emit(workerId, { type: "turn.started", at: f.now() });
  if (text !== null) f.emit(workerId, { type: "agent.text", uuid: `wake-${f.now()}`, text, at: f.now() });
  f.emit(workerId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [], durationMs: 5, at: f.now() });
}

describe("a self-waking vendor whose model replied while background commands run", () => {
  it("holds the report, reminds the PM at 10m, 30m, and 70m, then reports once when the work finishes", () => {
    const workerId = workerWithBackground("claude");
    expect(reportsOf(workerId)).toEqual([]);
    expect(f.ledger.runDueBackgroundWaits(f.now())).toBe(0);

    f.advance(10 * MINUTE);
    expect(f.ledger.runDueBackgroundWaits(f.now())).toBe(1);
    const [first] = remindersOf(workerId);
    expect(first).toMatchObject({ reminder: 1 });
    expect(first!.text).toContain("watch the CI run");
    expect(first!.text).toContain(`worker show ${workerId}`);

    f.advance(20 * MINUTE);
    expect(f.ledger.runDueBackgroundWaits(f.now())).toBe(1);
    f.advance(40 * MINUTE);
    expect(f.ledger.runDueBackgroundWaits(f.now())).toBe(1);
    f.advance(50 * MINUTE);
    expect(f.ledger.runDueBackgroundWaits(f.now())).toBe(0);
    expect(remindersOf(workerId).map((r) => r.reminder)).toEqual([1, 2, 3]);

    f.emit(workerId, { type: "background.changed", count: 0, tasks: [], at: f.now() });
    wakeTurn(workerId, report("做完了", "CI passed"));
    expect(reportsOf(workerId).map((r) => [r.status, r.summary])).toEqual([["done", "CI passed"]]);
  });

  it("drops a queued reminder once the wait it describes has released", () => {
    const workerId = workerWithBackground("claude");
    f.advance(10 * MINUTE);
    f.ledger.runDueBackgroundWaits(f.now());
    const [reminder] = remindersOf(workerId);
    f.emit(workerId, { type: "background.changed", count: 0, tasks: [], at: f.now() });
    wakeTurn(workerId, report("做完了", "CI passed"));
    expect(canDeliverSystemMessage(f.ledger, f.pm.sessionId, reminder!.id)).toBe(false);
  });

  it("delivers the draft once when the commands finish and the vendor never continues", () => {
    const workerId = workerWithBackground("claude");
    f.emit(workerId, { type: "background.changed", count: 0, tasks: [], at: f.now() });
    f.advance(MINUTE + 1);
    f.ledger.runDueBackgroundWaits(f.now());
    expect(reportsOf(workerId).map((r) => [r.status, r.summary])).toEqual([["done", "Waiting for CI"]]);
    f.advance(10 * MINUTE);
    expect(f.ledger.runDueBackgroundWaits(f.now())).toBe(0);
    expect(reportsOf(workerId)).toHaveLength(1);
  });

  it("sends one failure to the PM when a follow-up crashes while a draft is held", () => {
    const workerId = workerWithBackground("claude");
    const { messageId } = f.hub("worker.send", { workerId, text: "Check the failure" }).data;
    f.begin(workerId);
    f.emit(workerId, { type: "session.exited", reason: "crash", exitCode: 1, signal: null, hadResult: false, messageIds: [messageId], at: f.now() });

    const failures = f.ledger.messagesBefore(f.project.conversationId, Number.MAX_SAFE_INTEGER).messages
      .filter((message) => message.workerId === workerId && message.meta?.event === "turn_failed");
    expect(failures).toEqual([expect.objectContaining({ dedupeKey: workerMessageDedupeKey(workerId, "turn_failed", messageId) })]);
    expect(reportsOf(workerId)).toEqual([]);
  });

  it.each(["PM follow-up", "user direct chat"])("keeps the draft held while a %s turn runs past the wake grace", (source) => {
    const graphId = f.hub("graph.create", { specJson: '{"title":"Example","nodes":[{"key":"a","title":"A"}]}' }).data.graph.id;
    const workerId = workerWithBackground("claude", report("做完了", "CI passed"), graphId);
    const sessionId = f.sessionOf(workerId);
    const conversationId = f.ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.conversationId;
    if (conversationId == null) throw new Error("Missing worker conversation");
    f.emit(workerId, { type: "background.changed", count: 0, tasks: [], at: f.now() });
    const directChat = source === "user direct chat";
    const { messageId } = directChat
      ? f.ledger.postUserMessage({ conversationId, clientId: "direct", text: "What did CI check?" })
      : f.hub("worker.send", { workerId, text: "Also check the logs" }).data;
    f.emit(workerId, { type: "message.delivered", messageIds: [messageId], at: f.now() });
    f.emit(workerId, { type: "message.processing", messageIds: [messageId], at: f.now() });
    f.advance(MINUTE + 1);
    f.ledger.runDueBackgroundWaits(f.now());
    expect(reportsOf(workerId)).toEqual([]);
    expect(f.ledger.getMessage(messageId)?.status).toBe("processing");

    f.emit(workerId, { type: "agent.text", uuid: "followup", text: directChat ? "It checked the build." : report("做完了", "Logs checked"), at: f.now() });
    f.end(workerId, { messageIds: [messageId] });
    f.ledger.runDueBackgroundWaits(f.now());
    expect(reportsOf(workerId).map((r) => r.summary)).toEqual([directChat ? "CI passed" : "Logs checked"]);
  });

  it("coalesces all reminders missed while asleep and keeps the next future deadline", () => {
    const workerId = workerWithBackground("claude");
    f.advance(31 * MINUTE);
    expect(f.ledger.runDueBackgroundWaits(f.now())).toBe(1);
    expect(f.ledger.runDueBackgroundWaits(f.now())).toBe(0);
    expect(remindersOf(workerId).map((r) => r.reminder)).toEqual([2]);
    f.advance(39 * MINUTE);
    expect(f.ledger.runDueBackgroundWaits(f.now())).toBe(1);
    expect(remindersOf(workerId).map((r) => r.reminder)).toEqual([2, 3]);
  });

  it("starts the wake grace at the recorded drain event time", () => {
    const workerId = workerWithBackground("claude");
    const at = f.now();
    f.advance(MINUTE + 1);
    f.emit(workerId, { type: "background.changed", count: 0, tasks: [], at });
    f.ledger.runDueBackgroundWaits(f.now());
    expect(reportsOf(workerId).map((r) => r.summary)).toEqual(["Waiting for CI"]);
  });

  it("delivers the held draft with a restart note and sends no reminder after a daemon restart", () => {
    const workerId = workerWithBackground("claude");
    f.ledger.recoverAfterRestart();
    const reports = reportsOf(workerId);
    expect(reports.map((r) => r.summary)).toEqual(["Waiting for CI"]);
    expect(reports[0]!.text).toContain("重启");
    f.advance(10 * MINUTE);
    expect(f.ledger.runDueBackgroundWaits(f.now())).toBe(0);
    expect(remindersOf(workerId)).toEqual([]);
  });
});

it("reports at once for a vendor that cannot wake itself, naming the commands left running", () => {
  const workerId = workerWithBackground("agy");
  const reports = reportsOf(workerId);
  expect(reports.map((r) => [r.status, r.summary])).toEqual([["done", "Waiting for CI"]]);
  expect(reports[0]!.text).toContain("watch the CI run");
  f.advance(10 * MINUTE);
  expect(f.ledger.runDueBackgroundWaits(f.now())).toBe(0);
});
