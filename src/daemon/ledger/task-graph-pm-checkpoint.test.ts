import { cpSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pendingDecisionsOf } from "../../shared/decisions.ts";
import { systemEventOf } from "../../shared/domain.ts";
import { openDatabase } from "../store/db.ts";
import { DEFAULT_MIGRATIONS_DIR, migrate } from "../store/migrate.ts";
import { writeMigrationManifest } from "../store/test-helpers.ts";
import { createPmFrictionFixture, reportBlock, type PmFrictionFixture } from "./pm-friction-fixture.ts";

describe("S1: PM reviews a plan inside a Task Graph (confirm: 'pm')", () => {
  let f: PmFrictionFixture;

  beforeEach(() => {
    f = createPmFrictionFixture();
  });

  afterEach(() => {
    f.close();
  });

  const workerReports = (workerId: number) =>
    f.pmMessages().filter((m) => m.sender === "system" && m.workerId === workerId && m.kind === "worker" && m.status !== null);

  it("S1.1 & S1.2: confirm='pm' pauses at waiting:pm with no user card, sends PM checkpoint notice, and resumes the same Worker on worker.send", async () => {
    const graph = f.createGraph({
      title: "方案评审流程",
      steps: [{ key: "plan", title: "写方案", brief: "输出设计与骨架", confirm: "pm" }],
    }).data.graph;
    const wid = f.showGraph(graph.id).nodes[0]!.activeWorkerId!;
    const firstSessionId = f.workerSessionOf(wid).id;
    await f.startWorktree(wid);

    f.workerTurn(
      wid,
      reportBlock({
        status: "做完了",
        summary: "完成方案初稿与代码骨架",
        handoff: "关键决策：采用读口加统一通知入口",
        files: "[设计方案](/tmp/plan.md)",
      }),
    );

    const stepAfterFirst = f.showGraph(graph.id).nodes[0]!;
    expect(stepAfterFirst).toMatchObject({
      key: "plan",
      status: "waiting",
      waitingFor: "pm",
      checkpoint: "pm",
      activeWorkerId: wid,
      gateAskMessageId: null,
    });
    expect(pendingDecisionsOf(f.ledger.snapshot())).toEqual([]);

    const noticesAfterFirst = workerReports(wid);
    expect(noticesAfterFirst).toHaveLength(1);
    expect(noticesAfterFirst[0]!.text).toContain("步骤「plan」做完了，等你审（项目经理检查点）");
    expect(noticesAfterFirst[0]!.text).toContain("完成方案初稿与代码骨架");
    expect(noticesAfterFirst[0]!.text).toContain("关键决策：采用读口加统一通知入口");

    // S1.2: PM sends feedback; step returns to running on the same Worker session and second report produces a second notice.
    f.ledger.hubCall(f.lin.sessionId, "worker.send", { workerId: wid, text: "请补上缓存验证步骤" });
    const stepAfterSend = f.showGraph(graph.id).nodes[0]!;
    expect(stepAfterSend).toMatchObject({ status: "running", waitingFor: null, activeWorkerId: wid });
    expect(f.workerSessionOf(wid).id).toBe(firstSessionId);

    f.workerTurn(wid, reportBlock({ status: "做完了", summary: "已补齐缓存验证步骤", handoff: "二次提交就绪" }));
    expect(f.showGraph(graph.id).nodes[0]).toMatchObject({ status: "waiting", waitingFor: "pm", activeWorkerId: wid });
    expect(workerReports(wid)).toHaveLength(2);
  });

  it("S1.3: atomic graph.patch with addSteps + doneSteps finishes plan, ends its Worker, starts impl, and sends no delivery note", async () => {
    const graph = f.createGraph({
      title: "方案后接实现",
      steps: [{ key: "plan", title: "写方案", brief: "输出方案", confirm: "pm" }],
    }).data.graph;
    const planWid = f.showGraph(graph.id).nodes[0]!.activeWorkerId!;
    await f.startWorktree(planWid);
    f.workerTurn(planWid, reportBlock({ status: "做完了", summary: "方案完成" }));

    f.patchGraph(
      {
        addSteps: [{ key: "impl", title: "实现", brief: "按方案实现功能", deps: ["plan"] }],
        doneSteps: ["plan"],
      },
      graph.id,
    );

    const updated = f.showGraph(graph.id);
    const plan = updated.nodes.find((n) => n.key === "plan")!;
    const impl = updated.nodes.find((n) => n.key === "impl")!;
    expect(plan).toMatchObject({ status: "done", activeWorkerId: null });
    expect(impl.status).toBe("running");
    expect(impl.activeWorkerId).not.toBeNull();
    expect(f.db.get<{ status: string }>("SELECT status FROM workers WHERE id = ?", planWid)?.status).toBe("ended");
    expect(f.pmSystemMessages().filter((m) => systemEventOf(m)?.event === "task_graph.ready_to_finish")).toEqual([]);
  });

  it("S1.4: daemon restart while the PM checkpoint notice is queued keeps one notice and preserves waiting:pm", async () => {
    const graph = f.createGraph({
      title: "重启恢复",
      steps: [{ key: "plan", title: "写方案", brief: "输出方案", confirm: "pm" }],
    }).data.graph;
    const wid = f.showGraph(graph.id).nodes[0]!.activeWorkerId!;
    await f.startWorktree(wid);
    f.workerTurn(wid, reportBlock({ status: "做完了", summary: "待审方案" }));

    const before = workerReports(wid);
    expect(before).toHaveLength(1);
    expect(before[0]!.status).toBe("queued");

    f.ledger.recoverAfterRestart();
    const after = workerReports(wid);
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe("queued");
    expect(f.showGraph(graph.id).nodes[0]).toMatchObject({ status: "waiting", waitingFor: "pm" });
  });

  it("S1.5: running graph.done while the PM checkpoint report is still queued marks the queued notice stale", async () => {
    const graph = f.createGraph({
      title: "排队期间已放行",
      steps: [{ key: "plan", title: "写方案", brief: "输出方案", confirm: "pm" }],
    }).data.graph;
    const wid = f.showGraph(graph.id).nodes[0]!.activeWorkerId!;
    await f.startWorktree(wid);
    f.workerTurn(wid, reportBlock({ status: "做完了", summary: "待审方案" }));

    const report = workerReports(wid)[0]!;
    expect(f.ledger.isSystemMessageCurrent?.(report.id)).toBe(true);

    f.ledger.hubCall(f.lin.sessionId, "graph.done", { graphId: graph.id, nodeKey: "plan" });
    expect(f.ledger.isSystemMessageCurrent?.(report.id)).toBe(false);
  });

  it("S1.6 (regression): confirm=true still opens a user checkpoint card and does not wake the PM", async () => {
    const graph = f.createGraph({
      title: "用户检查点回归",
      steps: [{ key: "plan", title: "写方案", brief: "输出方案", confirm: true }],
    }).data.graph;
    const wid = f.showGraph(graph.id).nodes[0]!.activeWorkerId!;
    await f.startWorktree(wid);
    f.workerTurn(wid, reportBlock({ status: "做完了", summary: "给用户看" }));

    const step = f.showGraph(graph.id).nodes[0]!;
    expect(step).toMatchObject({ status: "waiting", waitingFor: "user", gateCheckpoint: true });
    expect(step.gateAskMessageId).not.toBeNull();
    expect(pendingDecisionsOf(f.ledger.snapshot())).toHaveLength(1);
    expect(workerReports(wid)).toEqual([]);
  });

  it("S1.7 (migration): 0055_step_checkpoint backfills confirm=1 rows to checkpoint='user'", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-hub-mig55-"));
    const db = openDatabase(join(dir, "mig55.sqlite"));
    try {
      const upTo54 = join(dir, "mig54");
      cpSync(DEFAULT_MIGRATIONS_DIR, upTo54, { recursive: true });
      for (const name of readdirSync(upTo54)) {
        const v = /^(\d+)_.*\.sql$/.exec(name)?.[1];
        if (v !== undefined && Number(v) > 54) unlinkSync(join(upTo54, name));
      }
      writeMigrationManifest(upTo54);
      migrate(db, upTo54);

      const now = 1_720_000_000_000;
      const pmId = db.run("INSERT INTO pms (name, mode, created_at) VALUES ('PM', 'manage_only', ?)", now).lastInsertRowid;
      const convId = db.run(
        "INSERT INTO conversations (kind, pm_id, title, created_at) VALUES ('pm', ?, 'PM', ?)",
        pmId,
        now,
      ).lastInsertRowid;
      const projId = db.run(
        "INSERT INTO projects (name, status, pm_id, conversation_id, created_at, updated_at) VALUES ('P', 'active', ?, ?, ?, ?)",
        pmId,
        convId,
        now,
        now,
      ).lastInsertRowid;
      const graphId = db.run(
        "INSERT INTO task_graphs (project_id, pm_id, conversation_id, title, status, created_at, updated_at) VALUES (?, ?, ?, 'G', 'active', ?, ?)",
        projId,
        pmId,
        convId,
        now,
        now,
      ).lastInsertRowid;
      db.run(
        `INSERT INTO task_graph_steps (graph_id, node_key, title, confirm, status, sort_order, created_at, updated_at)
         VALUES (?, 'a', 'A', 1, 'pending', 0, ?, ?), (?, 'b', 'B', 0, 'pending', 1, ?, ?)`,
        graphId,
        now,
        now,
        graphId,
        now,
        now,
      );

      migrate(db, DEFAULT_MIGRATIONS_DIR);
      const rows = db.all<{ node_key: string; checkpoint: string | null }>(
        "SELECT node_key, checkpoint FROM task_graph_steps WHERE graph_id = ? ORDER BY node_key",
        graphId,
      );
      expect(rows).toEqual([
        { node_key: "a", checkpoint: "user" },
        { node_key: "b", checkpoint: null },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
