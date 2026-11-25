import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPORT_END, REPORT_START } from "../../../shared/worker.ts";
import { MIN_WORKER_MAX_TIME_MS } from "../../../shared/limits.ts";
import { listActions } from "../../actions/index.ts";
import { makeHarness } from "../../driver/test-helpers.ts";
import { canDeliverSystemMessage, createSessionSendHandler } from "../../handlers.ts";
import { createSessionStore } from "../../store/index.ts";
import { workerOpsFixture } from "../test-helpers.ts";

function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

describe("PM notices from superseded Workers", () => {
  let f: ReturnType<typeof workerOpsFixture>;
  beforeEach(() => { f = workerOpsFixture(); });
  afterEach(async () => {
    vi.useRealTimers();
    await f.close();
  });

  const notices = (workerId: number) => f.db.all<{ id: number; event: string; status: string | null }>(
    `SELECT id, json_extract(meta, '$.event') AS event, status FROM messages
     WHERE worker_id = ? AND sender = 'system' AND conversation_id = ? ORDER BY id`,
    workerId, f.project.conversationId,
  );

  function startGraph() {
    const { id: graphId } = f.hub("graph.create", { specJson: '{"title":"Retry","nodes":[{"key":"fix","title":"Fix"}]}' }).data.graph;
    const start = () => f.hub("worker.start", { node: "fix", graphId, task: "Fix the problem", noWorktree: true, maxTimeMs: MIN_WORKER_MAX_TIME_MS }).data.worker;
    const node = () => f.hub("graph.show", { graphId }).data.graph.nodes[0];
    return { start, node };
  }

  const error = { subtype: "failed", message: "You've hit your 5-hour limit · resets 7:10pm (Asia/Shanghai)" };
  const failWithTimeout = (id: number) => {
    f.begin(id);
    f.advance(MIN_WORKER_MAX_TIME_MS);
    vi.advanceTimersByTime(MIN_WORKER_MAX_TIME_MS);
    f.end(id, { ok: false, error });
    const timeout = notices(id).find((notice) => notice.event === "worker.max_time_exceeded")!;
    const failure = notices(id).find((notice) => notice.event === "turn_failed")!;
    expect([timeout.status, failure.status]).toEqual(["queued", "queued"]);
    return { timeout, failure };
  };

  const deliverThrough = () => {
    const send = vi.fn(async (_sessionId: number, input: { messageIds: number[] }) => {
      f.ledger.applyDriverEvent(f.pm.sessionId, { type: "message.delivered", messageIds: input.messageIds, at: f.now() });
      return { kind: "written" as const };
    });
    const handle = createSessionSendHandler({
      driver: { send, start: vi.fn(), end: vi.fn() }, ledger: f.ledger,
      sessions: createSessionStore(f.db), tokens: { revoke: vi.fn() }, now: f.now,
    });
    return {
      send,
      deliver(messageId: number) {
        const action = listActions(f.db).find((candidate) => candidate.type === "session.send" && candidate.params.messageId === messageId);
        if (action?.type !== "session.send") throw new Error("Missing send action");
        return handle(action);
      },
    };
  };

  it("cancels notices held behind PM quota and never wakes PM after a replacement", async () => {
    vi.useFakeTimers();
    const { start, node } = startGraph();
    const old = start();
    const { failure, timeout } = failWithTimeout(old.id);
    const sessions = createSessionStore(f.db);
    sessions.update(f.pm.sessionId, { rateLimit: { status: "rejected", resetsAt: f.now() / 1000 + 300, windows: {} } });
    const { deliver, send } = deliverThrough();
    expect(await deliver(failure.id)).toMatchObject({ kind: "later", reason: "rate_limited" });
    expect(await deliver(timeout.id)).toMatchObject({ kind: "later", reason: "rate_limited" });

    const replacement = start();
    expect(replacement.id).not.toBe(old.id);
    expect(node()).toMatchObject({ status: "running", activeWorkerId: replacement.id });
    for (const { id } of [failure, timeout]) {
      expect(f.ledger.getMessage(id)?.status).toBe("stopped");
      expect(f.ledger.isWorkerPmNoticeActionable?.(id)).toBe(false);
    }
    f.advance(301_000);
    expect(await deliver(failure.id)).toEqual({ kind: "done" });
    expect(await deliver(timeout.id)).toEqual({ kind: "done" });
    expect(send).not.toHaveBeenCalled();
    const before = notices(old.id);
    f.emit(old.id, { type: "turn.started", at: f.now() });
    f.emit(old.id, { type: "agent.text", uuid: "late-failure", text: "Late error", at: f.now() });
    f.end(old.id, { messageIds: [], ok: false, error });
    await f.ledger.settleDriverEvents();
    expect(notices(old.id)).toEqual(before);
    expect(node()).toMatchObject({ status: "running", activeWorkerId: replacement.id });
  });

  it("drops a notice already in the Claude driver while launch preparation waits", async () => {
    const { start, node } = startGraph();
    const old = start();
    f.begin(old.id);
    f.end(old.id, { ok: false, error });
    const notice = notices(old.id).find(({ event }) => event === "turn_failed")!;
    const entered = latch();
    const ready = latch();
    const promptFile = join(f.root, "pm-prompt.txt");
    writeFileSync(promptFile, "Review Worker results");
    const t = makeHarness({
      driver: {
        canDeliverSystemMessage: canDeliverSystemMessage.bind(null, f.ledger),
        prepareLaunch: async () => {
          entered.release();
          await ready.wait;
          return { promptFile, fingerprint: "", env: {} };
        },
      },
    });
    try {
      t.addSession({ id: f.pm.sessionId });
      const action = listActions(f.db).find((candidate) => candidate.type === "session.send" && candidate.params.messageId === notice.id);
      if (action?.type !== "session.send") throw new Error("Missing send action");
      const handle = createSessionSendHandler({
        driver: t.driver, ledger: f.ledger,
        sessions: createSessionStore(f.db), tokens: { revoke: vi.fn() }, now: f.now,
      });
      const delivery = handle(action);
      await entered.wait;
      const replacement = start();
      expect(node()).toMatchObject({ status: "running", activeWorkerId: replacement.id });
      expect(f.ledger.getMessage(notice.id)?.status).toBe("stopped");
      ready.release();
      await delivery;
      await t.driver.send(f.pm.sessionId, { messageIds: [999], source: "user", text: "Review the replacement" });
      await t.waitFor("turn.ended");
      expect(t.stdinTexts()).toEqual(["Review the replacement"]);
      expect(t.of("message.delivered").flatMap((event) => event.messageIds)).toEqual([999]);
    } finally {
      ready.release();
      await t.cleanup();
    }
  });

  it("cancels both queued failure and timeout when resuming a Worker", () => {
    vi.useFakeTimers();
    const { start, node } = startGraph();
    const worker = start();
    const { timeout, failure } = failWithTimeout(worker.id);
    expect(f.ledger.isWorkerPmNoticeActionable?.(failure.id)).toBe(true);
    f.hub("worker.send", { workerId: worker.id, text: "Quota recovered; continue." });
    expect(node()).toMatchObject({ status: "running", activeWorkerId: worker.id });
    expect(f.ledger.getMessage(timeout.id)?.status).toBe("stopped");
    expect(f.ledger.getMessage(failure.id)?.status).toBe("stopped");
  });

  it("keeps a completed step's queued report with a question deliverable after automatic closure", async () => {
    const { start, node } = startGraph();
    const worker = start();
    f.begin(worker.id);
    f.emit(worker.id, {
      type: "agent.text", uuid: "complete-with-question", at: f.now(),
      text: `${REPORT_START}\n状态: 做完了\n摘要: Fixed\n问题: Confirm rollout date?\n${REPORT_END}`,
    });
    f.end(worker.id);
    expect(node()?.status).toBe("done");
    const report = notices(worker.id).find((notice) => notice.event === "report")!;
    expect(report.status).toBe("queued");
    expect(f.hub("worker.show", { workerId: worker.id }).data.worker.status).toBe("ended");
    expect(f.ledger.isWorkerPmNoticeActionable?.(report.id)).toBe(true);
    const { deliver, send } = deliverThrough();
    expect(await deliver(report.id)).toEqual({ kind: "done" });
    expect(send).toHaveBeenCalledWith(f.pm.sessionId, expect.objectContaining({ text: expect.stringContaining("Confirm rollout date?") }));
    start();
    expect(f.ledger.isWorkerPmNoticeActionable?.(report.id)).toBe(false);
    send.mockClear();
    await deliver(report.id);
    expect(send).not.toHaveBeenCalled();
  });

  it("allows a current worktree launch failure and cancels it when PM replaces that Worker", async () => {
    const { id: graphId } = f.hub("graph.create", { specJson: '{"title":"Worktree failure","nodes":[{"key":"fix","title":"Fix"}]}' }).data.graph;
    const worker = f.ledger.hubCall(f.pm.sessionId, "worker.start", {
      graphId, node: "fix", task: "Fix app",
    }, { workspace: { kind: "ok", isRepoWithCommit: true, hasUncommittedChanges: false } }).data.worker;
    const action = listActions(f.db).find((candidate) => candidate.type === "worktree.create" && candidate.params.workerId === worker.id)!;
    f.ledger.onActionFailed(action, "Branch already exists");
    const failure = notices(worker.id).find((notice) => notice.event === "worktree_failed")!;
    expect(f.hub("worker.show", { workerId: worker.id }).data.worker.status).toBe("ended");
    expect(f.ledger.isWorkerPmNoticeActionable?.(failure.id)).toBe(true);
    const replacement = f.hub("worker.start", { graphId, node: "fix", noWorktree: true }).data.worker;
    expect(f.ledger.getMessage(failure.id)?.status).toBe("stopped");
    expect(f.ledger.isWorkerPmNoticeActionable?.(failure.id)).toBe(false);
    f.ledger.onActionFailed(action, "Late failure callback");
    expect(notices(worker.id).filter(({ event }) => event === "worktree_failed")).toHaveLength(1);
    expect(f.hub("graph.show", { graphId }).data.graph.nodes[0]).toMatchObject({ status: "running", activeWorkerId: replacement.id });
    const { deliver, send } = deliverThrough();
    await deliver(failure.id);
    expect(send).not.toHaveBeenCalled();
  });

  it("preserves delivered notices and unrelated Workers' queued notices when ending a Worker", () => {
    const start = (title: string) => f.hub("worker.start", { title, task: "Investigate", noWorktree: true }).data.worker;
    const first = start("First"), other = start("Other");
    for (const worker of [first, other]) {
      f.begin(worker.id);
      f.end(worker.id, { ok: false, error });
    }
    const delivered = notices(first.id).find((notice) => notice.event === "turn_failed")!;
    const unrelated = notices(other.id).find((notice) => notice.event === "turn_failed")!;
    f.ledger.applyDriverEvent(f.pm.sessionId, { type: "message.delivered", messageIds: [delivered.id], at: f.now() });
    f.hub("worker.end", { workerId: first.id });
    expect(f.ledger.getMessage(delivered.id)?.status).toBe("delivered");
    expect(f.ledger.getMessage(unrelated.id)?.status).toBe("queued");
    expect(f.ledger.isWorkerPmNoticeActionable?.(unrelated.id)).toBe(true);
  });
});
