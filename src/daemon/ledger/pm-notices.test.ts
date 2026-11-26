import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIRM_PASS_OPTION, systemEventOf } from "../../shared/domain.ts";
import { isPmNoticeSubject, pmNoticeDedupeRef, type PmNoticeSubject } from "../../shared/pm-notice.ts";
import { enqueuePmNoticeIn, isPmNoticeCurrent } from "./pm-notices.ts";
import { createPmFrictionFixture, reportBlock, type PmFrictionFixture } from "./pm-friction-fixture.ts";

describe("S2 & N1: typed PM notices and leaf user-decision handoff", () => {
  let f: PmFrictionFixture;

  beforeEach(() => {
    f = createPmFrictionFixture();
  });

  afterEach(() => {
    f.close();
  });

  const pmWakeups = () => f.pmSystemMessages().filter((m) => systemEventOf(m)?.event === "pm.wakeup");

  it("S2.1, S2.3 & S2.4: passing a leaf checkpoint wakes the PM with user's note, survives restart, and retires if a successor is added", async () => {
    const graph = f.createGraph({
      title: "双分支方案图",
      steps: [
        { key: "plan", title: "写方案", brief: "输出方案", confirm: true, deps: [] },
        { key: "other", title: "并行分支", brief: "同时推进另一路", deps: [] },
      ],
    }).data.graph;
    const planWid = f.showGraph(graph.id).nodes.find((n) => n.key === "plan")!.activeWorkerId!;
    await f.startWorktree(planWid);
    f.workerTurn(planWid, reportBlock({ status: "做完了", summary: "方案初稿就绪" }));

    expect(pmWakeups()).toEqual([]);

    const decided = f.ledger.decideTaskNode(graph.id, "plan", {
      choice: CONFIRM_PASS_OPTION,
      note: "按选项一开干",
      clientId: "pass-leaf-1",
    });
    expect(decided.messageId).not.toBeNull();

    const wakes = pmWakeups();
    expect(wakes).toHaveLength(1);
    const wake = wakes[0]!;
    expect(wake.text).toContain(`任务图 #${graph.id}`);
    expect(wake.text).toContain("plan");
    expect(wake.text).toContain("后面没有步骤");
    expect(wake.text).toContain("还有 1 条线在跑");
    expect(wake.text).toContain("hub graph patch");
    expect(wake.text).toContain("按选项一开干");
    expect(f.pmSystemMessages().filter((m) => systemEventOf(m)?.event === "task_graph.ready_to_finish")).toEqual([]);

    const meta = systemEventOf(wake);
    expect(meta?.event).toBe("pm.wakeup");
    if (meta?.event === "pm.wakeup") {
      expect(meta.subject).toMatchObject({ kind: "graph.leaf_settled", graphId: graph.id, nodeKey: "plan", by: "checkpoint_pass" });
    }

    // S2.4: restart while queued keeps exactly one queued notice.
    f.ledger.recoverAfterRestart();
    expect(pmWakeups()).toHaveLength(1);
    expect(f.ledger.getMessage(wake.id)?.status).toBe("queued");
    expect(f.ledger.isSystemMessageCurrent?.(wake.id)).toBe(true);

    // S2.3: adding a successor while the notice is still queued retires it.
    f.patchGraph({ addSteps: [{ key: "impl", title: "实现", brief: "按方案开干", deps: ["plan"] }] }, graph.id);
    expect(f.ledger.isSystemMessageCurrent?.(wake.id)).toBe(false);
  });

  it("S2.5 (path 2): settling a manual leaf step with no Worker and no successor notifies the PM each time", () => {
    const graph = f.createGraph({
      title: "手动拍板落空",
      steps: [
        { key: "decide1", title: "拍板一", question: "选哪套 A/B？", options: ["方案 A", "方案 B"], deps: [] },
        { key: "decide2", title: "拍板二", question: "选哪套 C/D？", options: ["方案 C", "方案 D"], deps: [] },
        { key: "other", title: "在跑分支", brief: "持续推进", deps: [] },
      ],
    }).data.graph;

    const first = f.ledger.decideTaskNode(graph.id, "decide1", { choice: "方案 A", note: "先做 A", clientId: "m-1" });
    const second = f.ledger.decideTaskNode(graph.id, "decide2", { choice: "方案 C", note: "再做 C", clientId: "m-2" });
    expect(first.messageId).not.toBeNull();
    expect(second.messageId).not.toBeNull();
    expect(pmWakeups()).toHaveLength(2);
    expect(pmWakeups()[0]!.text).toContain("decide1");
    expect(pmWakeups()[1]!.text).toContain("decide2");
  });

  it("S2.5 (path 3): skipping a leaf step from the web notifies the PM each time", () => {
    const graph = f.createGraph({
      title: "网页跳过落空",
      steps: [
        { key: "leaf1", title: "叶子一", deps: [] },
        { key: "leaf2", title: "叶子二", deps: [] },
        { key: "other", title: "在跑分支", brief: "持续推进", deps: [] },
      ],
    }).data.graph;

    const first = f.ledger.skipTaskNode(graph.id, "leaf1", { reason: "暂不做" });
    const second = f.ledger.skipTaskNode(graph.id, "leaf2", { reason: "也跳过" });
    expect(first.messageId).not.toBeNull();
    expect(second.messageId).not.toBeNull();
    expect(pmWakeups()).toHaveLength(2);
    expect(pmWakeups()[0]!.text).toContain("leaf1");
    expect(pmWakeups()[1]!.text).toContain("leaf2");
  });

  it("S2.6 (N1): pm.wakeup for a waiting:pm step becomes stale when that step is skipped before delivery", async () => {
    const graph = f.createGraph({
      title: "N1 过时叫醒",
      steps: [
        { key: "a", title: "第一步", brief: "跑完自动交棒" },
        { key: "b", title: "第二步" },
      ],
    }).data.graph;
    const wid = f.showGraph(graph.id).nodes.find((n) => n.key === "a")!.activeWorkerId!;
    await f.startWorktree(wid);
    f.workerTurn(wid, reportBlock({ status: "做完了", summary: "第一步完成" }));

    const wakes = pmWakeups();
    expect(wakes).toHaveLength(1);
    const wake = wakes[0]!;
    expect(f.ledger.isSystemMessageCurrent?.(wake.id)).toBe(true);

    // Skip b before wake is delivered -> wake must become stale (false).
    f.ledger.hubCall(f.lin.sessionId, "graph.skip", { graphId: graph.id, nodeKey: "b", reason: "不再需要" });
    expect(f.ledger.isSystemMessageCurrent?.(wake.id)).toBe(false);
  });

  it("typed PmNoticeSubject dedupe refs, runtime guard, enqueuePmNoticeIn, and currency helper satisfy their contracts", () => {
    const s1: PmNoticeSubject = { kind: "graph.leaf_settled", graphId: 1, nodeKey: "plan", by: "checkpoint_pass", decidedAt: 100 };
    const s2: PmNoticeSubject = { kind: "graph.leaf_settled", graphId: 1, nodeKey: "plan", by: "checkpoint_pass", decidedAt: 200 };
    expect(isPmNoticeSubject(s1)).toBe(true);
    expect(isPmNoticeSubject({ kind: "unknown" })).toBe(false);
    expect(pmNoticeDedupeRef(s1)).not.toBe(pmNoticeDedupeRef(s2));
    expect(isPmNoticeCurrent(f.db, { kind: "graph.cancelled", graphId: 99_999, cancelledAt: 1 }, f.lin.conversationId)).toBe(false);
    const pending = { changes: [], actions: [], stops: [], pushed: new Map(), after: [] };
    const enqueued = enqueuePmNoticeIn(
      { db: f.db, now: () => f.clock.now, enqueue: (p, a) => p.actions.push(a as never) },
      pending,
      { id: f.lin.sessionId },
      { conversationId: f.lin.conversationId, subject: s1, text: "test notice" },
    );
    expect(enqueued.sender).toBe("system");
    expect(pending.actions).toHaveLength(1);
  });

  it("regression: pre-upgrade pm.wakeup rows without a subject still pass isSystemMessageCurrent without throwing", () => {
    const now = f.clock.now;
    const id = f.db.run(
      `INSERT INTO messages (conversation_id, session_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, 'system', 'text', 'legacy wakeup', ?, ?, 'queued', ?, ?)`,
      f.lin.conversationId,
      f.lin.sessionId,
      JSON.stringify({ event: "pm.wakeup", source: "task_graph", ref: "legacy:1" }),
      `system:${f.lin.conversationId}:pm.wakeup:legacy:1`,
      now,
      now,
    ).lastInsertRowid;
    expect(f.ledger.isSystemMessageCurrent?.(id)).toBe(true);
  });
});
