import { afterEach, beforeEach, expect, it } from "vitest";
import type { WorkerId } from "../../shared/domain.ts";
import { workerOpsFixture } from "./test-helpers.ts";

let f: ReturnType<typeof workerOpsFixture>;
let workerId: WorkerId;
beforeEach(() => {
  f = workerOpsFixture();
  workerId = f.hub("worker.start", { title: "Worker", task: "Inspect", noWorktree: true }).data.worker.id;
  f.emit(workerId, { type: "session.started", resumed: false, model: null, tools: [], at: f.now() });
});
afterEach(async () => { await f.close(); });

const toolsOf = () => f.db.all<{ tool_use_id: string; status: string; ended_at: number | null }>(
  "SELECT tt.tool_use_id, tt.status, tt.ended_at FROM turn_tools tt JOIN turns t ON t.id = tt.turn_id WHERE t.session_id = ? ORDER BY t.id, tt.tool_use_id",
  f.sessionOf(workerId),
);
const tool = (toolUseId: string, command: string) =>
  f.emit(workerId, { type: "agent.tool", uuid: `u-${toolUseId}`, toolUseId, name: "Bash", input: { command }, at: f.now() });
const result = (toolUseId: string) => f.emit(workerId, { type: "agent.tool_result", toolUseIds: [toolUseId], at: f.now() });
const show = () => f.hub("worker.show", { workerId }).text;

it("records a tool completion that arrives after live session state was refreshed", () => {
  f.begin(workerId);
  tool("cmd-1", "printf old");
  expect(show()).toContain("printf old");
  f.ledger.refreshSessionState(f.sessionOf(workerId));
  f.advance(4_000);
  result("cmd-1");
  f.emit(workerId, { type: "agent.thinking", uuid: "after-result", at: f.now() });
  expect(show()).not.toMatch(/现在：.*printf old/);
  expect(toolsOf()).toEqual([{ tool_use_id: "cmd-1", status: "done", ended_at: f.now() }]);
});

it("stops showing a tool as running once its turn ends without a result", () => {
  const brief = f.begin(workerId);
  tool("cmd-2", "sleep 100");
  f.advance(1_000);
  f.end(workerId, { messageIds: [brief] });
  expect(show()).not.toMatch(/现在：.*sleep 100/);
  expect(toolsOf()).toEqual([{ tool_use_id: "cmd-2", status: "unconfirmed", ended_at: f.now() }]);
});

it("records a late result against the ended turn that ran the tool", () => {
  const brief = f.begin(workerId);
  tool("cmd-3", "printf late");
  f.end(workerId, { messageIds: [brief] });
  f.advance(2_000);
  result("cmd-3");
  expect(toolsOf()).toEqual([{ tool_use_id: "cmd-3", status: "done", ended_at: f.now() }]);
});

it("ignores a repeated result and a result for an unknown tool", () => {
  f.begin(workerId);
  tool("cmd-4", "printf once");
  result("cmd-4");
  const first = toolsOf();
  f.advance(1_000);
  result("cmd-4");
  result("never-started");
  expect(toolsOf()).toEqual(first);
  expect(first).toEqual([{ tool_use_id: "cmd-4", status: "done", ended_at: expect.any(Number) }]);
});
