import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LedgerRequestError } from "../../../shared/ledger.ts";
import { HUB_COMMAND } from "../../../shared/names.ts";
import { formatWorkerWaitResult, isWorkerStartSettled, WORKER_WAIT_SETTLED_PHASES } from "../../../shared/worker-wait.ts";
import { createPmFrictionFixture, type PmFrictionFixture } from "../pm-friction-fixture.ts";
import { workerStartStatusOf } from "./wait.ts";

describe("S6 (ledger): worker start phases and worker.wait snapshot", () => {
  let f: PmFrictionFixture;

  beforeEach(() => {
    f = createPmFrictionFixture();
  });

  afterEach(() => {
    f.close();
  });

  it("S6.1: worker.start receipt ends with the hub worker wait hint for that Worker", () => {
    const started = f.ledger.hubCall(f.lin.sessionId, "worker.start", {
      title: "写测试",
      task: "给登录页补单测",
      noWorktree: true,
    });
    expect(started.text).toContain(`要等它开工用 ${HUB_COMMAND} worker wait ${started.data.worker.id}`);
  });

  it("S6.2 & S6.5: worker.wait tracks setup/delivering -> started when brief reaches processing, and returns at once when re-waited", async () => {
    const workspace = { kind: "ok" as const, isRepoWithCommit: true, hasUncommittedChanges: false };
    const w1 = f.ledger.hubCall(f.lin.sessionId, "worker.start", { title: "任务一", task: "做第一步" }, { workspace }).data.worker;
    const w2 = f.ledger.hubCall(f.lin.sessionId, "worker.start", { title: "任务二", task: "做第二步" }, { workspace }).data.worker;

    // Before worktree finishes, neither Worker has started yet.
    const before = f.ledger.hubCall(f.lin.sessionId, "worker.wait", { workerIds: [w1.id, w2.id], waitMs: 0 });
    expect(before.data.settled).toBe(false);
    expect(before.data.workers.map((w) => w.phase)).toEqual(["creating_worktree", "creating_worktree"]);

    // Advance setup and deliver/process both briefs.
    await f.startWorktree(w1.id);
    await f.startWorktree(w2.id);
    f.clock.now += 40_000;
    for (const wid of [w1.id, w2.id]) {
      const s = f.workerSessionOf(wid);
      const brief = f.db.get<{ id: number }>(
        "SELECT id FROM messages WHERE conversation_id = ? AND sender = 'pm' ORDER BY id ASC LIMIT 1",
        s.conversation_id,
      )!;
      f.ledger.applyDriverEvent(s.id, { type: "message.delivered", messageIds: [brief.id], at: f.clock.now });
      f.ledger.applyDriverEvent(s.id, { type: "message.processing", messageIds: [brief.id], at: f.clock.now });
    }

    const after = f.ledger.hubCall(f.lin.sessionId, "worker.wait", { workerIds: [w1.id, w2.id], waitMs: 0 });
    expect(after.data.settled).toBe(true);
    expect(after.data.workers.map((w) => w.phase)).toEqual(["started", "started"]);
    expect(after.text).toContain(`#${w1.id} 已开工`);
    expect(after.text).toContain(`#${w2.id} 已开工`);

    // S6.5: waiting again on already-started Workers returns immediately with settled=true.
    const again = f.ledger.hubCall(f.lin.sessionId, "worker.wait", { workerIds: [w1.id], waitMs: 0 });
    expect(again.data.settled).toBe(true);
    expect(again.data.workers[0]!.phase).toBe("started");
  });

  it("S6.3: Worker awaiting sandbox approval settles immediately as awaiting_sandbox_approval", () => {
    const w = f.ledger.hubCall(f.lin.sessionId, "worker.start", {
      title: "桌面操作",
      task: "检查窗口",
      noWorktree: true,
    }).data.worker;
    // Insert a pending sandbox approval row matching migrations/0053_worker_sandbox_approvals.sql.
    f.db.run(
      `INSERT INTO worker_sandbox_approvals (
         worker_id, pm_id, conversation_id, step_id, vendor, capabilities_json, task_summary,
         max_time_ms, status, created_at, updated_at
       ) VALUES (?, ?, ?, NULL, 'claude', '["mcp:computer"]', '检查窗口', 1800000, 'pending', ?, ?)`,
      w.id,
      f.lin.pmId,
      f.lin.conversationId,
      f.clock.now,
      f.clock.now,
    );

    const res = f.ledger.hubCall(f.lin.sessionId, "worker.wait", { workerIds: [w.id], waitMs: 0 });
    expect(res.data.settled).toBe(true);
    expect(res.data.workers[0]!.phase).toBe("awaiting_sandbox_approval");
    expect(res.text).toContain(`#${w.id}`);
    expect(res.text).toContain("沙箱");
    expect(res.text).toContain("不会自己开工");
  });

  it("S6.4: formatWorkerWaitResult for a timed-out setup reports phase, elapsed time, and advises ending the turn", () => {
    expect(isWorkerStartSettled("running_setup")).toBe(false);
    for (const phase of WORKER_WAIT_SETTLED_PHASES) expect(isWorkerStartSettled(phase)).toBe(true);
    expect(typeof workerStartStatusOf).toBe("function");

    const text = formatWorkerWaitResult({
      settled: false,
      timedOut: true,
      workers: [{ workerId: 15, phase: "running_setup", elapsedMs: 130_000, detail: null }],
    });
    expect(text).toContain("#15");
    expect(text).toContain("准备命令");
    expect(text).toContain("可以结束这一轮");
  });

  it("S6.7: pre-first-turn failure settles as failed and missing brief settles as unknown instead of hanging", () => {
    const failed = f.ledger.hubCall(f.lin.sessionId, "worker.start", {
      title: "会失败",
      task: "测试启动失败",
      noWorktree: true,
    }).data.worker;
    const failedSession = f.workerSessionOf(failed.id);
    const failedBrief = f.db.get<{ id: number }>(
      "SELECT id FROM messages WHERE conversation_id = ? AND sender = 'pm' ORDER BY id ASC LIMIT 1",
      failedSession.conversation_id,
    )!;
    f.ledger.applyDriverEvent(failedSession.id, {
      type: "session.exited",
      reason: "startup_failed",
      exitCode: 1,
      signal: null,
      hadResult: false,
      messageIds: [failedBrief.id],
      at: ++f.clock.now,
    });

    const failedRes = f.ledger.hubCall(f.lin.sessionId, "worker.wait", { workerIds: [failed.id], waitMs: 0 });
    expect(failedRes.data.settled).toBe(true);
    expect(failedRes.data.workers[0]!.phase).toBe("failed");
    expect(failedRes.text).toContain("开工失败");

    // A legacy Worker with no brief message settles as unknown rather than hanging until timeout.
    const orphan = f.ledger.hubCall(f.lin.sessionId, "worker.start", {
      title: "老 Worker",
      task: "旧记录",
      noWorktree: true,
    }).data.worker;
    f.db.run("DELETE FROM messages WHERE conversation_id = ?", orphan.workerConversationId);

    const unknownRes = f.ledger.hubCall(f.lin.sessionId, "worker.wait", { workerIds: [orphan.id], waitMs: 0 });
    expect(unknownRes.data.settled).toBe(true);
    expect(unknownRes.data.workers[0]!.phase).toBe("unknown");
    expect(unknownRes.text).toContain("判断不了");

    // Cross-PM isolation.
    const zhou = f.createPm("周经理");
    expect(() => f.ledger.hubCall(zhou.sessionId, "worker.wait", { workerIds: [failed.id], waitMs: 0 })).toThrow(LedgerRequestError);
  });
});
