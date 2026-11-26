import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerId } from "../../shared/domain.ts";
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

function workerWithBackground(vendor: AgentVendor, text = report("做完了", "Waiting for CI")): WorkerId {
  const { id: workerId } = f.hub("worker.start", { title: "Worker", task: "Push and wait for CI", noWorktree: true, vendor }).data.worker;
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
