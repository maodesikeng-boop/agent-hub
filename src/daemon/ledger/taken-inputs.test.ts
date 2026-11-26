import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workerOpsFixture } from "./test-helpers.ts";
import { listActions } from "../actions/index.ts";
import { type Change } from "../../shared/api.ts";
import type { DriverEvent } from "../../shared/driver.ts";

let f: ReturnType<typeof workerOpsFixture>;
beforeEach(() => { f = workerOpsFixture(); });
afterEach(async () => { await f.close(); });

const emit = (event: DriverEvent) => f.ledger.applyDriverEvent(f.pm.sessionId, event);
const post = (text: string) => f.ledger.postUserMessage({ conversationId: f.project.conversationId, clientId: text, text }).messageId;
const history = () => f.ledger.messagesBefore(f.project.conversationId, Number.MAX_SAFE_INTEGER).messages;
const progress = (uuid: string) => emit({ type: "agent.checklist", uuid, update: {
  kind: "merge", items: [{ id: uuid, title: "Check work", status: "in_progress" }],
}, at: f.now() });

function graphWakeup() {
  const { id: graphId } = f.hub("graph.create", { specJson: JSON.stringify({
    title: "Example", nodes: [{ key: "a", title: "A" }, { key: "b", title: "B", deps: ["a"] }],
  }) }).data.graph;
  const workerId = f.hub("worker.start", { title: "Worker", task: "Inspect", noWorktree: true, node: "a", graphId }).data.worker.id;
  f.begin(workerId);
  f.emit(workerId, { type: "agent.text", uuid: "done", text: "=== 汇报 ===\n状态: 做完了\n摘要: Done\nPR: 无\n提交: 无\n测试: 无\n偏离: 无\n交棒: 无\n文件: 无\n问题: 无\n=== 汇报结束 ===", at: f.now() });
  f.end(workerId);
  return history().find((message) => message.dedupeKey.includes("graph-turned:"))!;
}

describe("system wakeup delivery", () => {
  it("S3: completing a Worker step queues a system notice instead of user text", () => {
    post("Start");
    f.advance(27_000);
    progress("progress");
    const wake = graphWakeup();
    expect(wake).toMatchObject({ sender: "system", meta: { event: "pm.wakeup", source: "task_graph" }, status: "queued" });
    expect(listActions(f.db)).toContainEqual(expect.objectContaining({
      type: "session.send", params: { sessionId: f.pm.sessionId, messageId: wake.id, source: "system" },
    }));
    expect(f.ledger.isSystemMessageCurrent?.(wake.id)).toBe(true);
  });

  it.each([false, true])("S3/S4: stamps when the agent takes in the wakeup (mid-turn: %s)", (midTurn) => {
    const userId = post("Start");
    const wake = graphWakeup();
    emit({ type: "message.delivered", messageIds: [wake.id], at: f.now(), ...(midTurn ? { midTurn: true } : {}) });
    expect(f.ledger.getMessage(wake.id)?.meta?.taken).toBeUndefined();
    f.advance(27_000);
    progress("progress");
    const at = f.now();
    const afterId = history().at(-1)?.id;
    const changes: Change[] = [];
    f.ledger.onChange((change) => changes.push(change));
    emit({ type: "message.processing", messageIds: [wake.id, userId], at, ...(midTurn ? { midTurn: true } : {}) });
    expect(f.ledger.getMessage(wake.id)?.meta?.taken).toEqual({ afterId, at, midTurn });
    expect(f.ledger.getMessage(userId)?.meta?.taken).toBeUndefined();
    expect(changes.filter((change) => change.type === "message.updated" && change.data.message.id === wake.id)).toHaveLength(1);
    f.advance(1_000);
    emit({ type: "message.processing", messageIds: [wake.id], at: f.now() });
    expect(f.ledger.getMessage(wake.id)?.meta?.taken).toEqual({ afterId, at, midTurn });
  });

  it("stamps both a queued Worker report and a scheduled run when the PM reads them", () => {
    const workerId = f.hub("worker.start", { title: "Worker", task: "Inspect", noWorktree: true }).data.worker.id;
    f.begin(workerId);
    f.emit(workerId, { type: "agent.text", uuid: "reply", text: "Checked.", at: f.now() });
    f.end(workerId);
    const worker = history().find((message) => message.meta?.event === "report");
    const schedule = f.hub("schedule.add", { name: "Daily check", prompt: "Check the report.", daily: "09:00" }).data.schedule;
    f.advance(schedule.nextRunAt - f.now());
    f.ledger.runDueSchedules(f.now());
    const run = history().find((message) => message.meta?.event === "schedule.run");
    expect(worker?.status).toBe("queued");
    expect(run?.status).toBe("queued");
    const messageIds = [worker!.id, run!.id];
    emit({ type: "message.delivered", messageIds, at: f.now() });
    emit({ type: "message.processing", messageIds, at: f.now() });
    const stamp = { afterId: run!.id, at: f.now(), midTurn: false };
    expect(messageIds.map((id) => f.ledger.getMessage(id)?.meta?.taken)).toEqual([stamp, stamp]);
  });
});
