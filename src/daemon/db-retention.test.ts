// 账本定期清理的调度（db-retention.ts）：分批、批间让出、一轮上限、出错只记日志、关机后不再开始新的一批。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPLETED_GRAPH_RETENTION_MS,
  ROUTER_AUDIT_LOG_MAX_ROWS,
  ROUTER_COMMANDS_RETENTION_MAX,
  ROUTER_ITEM_RETENTION_MS,
  WORKER_PURGE_BATCH_ROWS,
  WORKER_PURGE_ROUND_MAX_ROWS,
  WORKER_RETENTION_INTERVAL_MS,
} from "../shared/limits.ts";
import { runRetentionRound, startWorkerRetention } from "./db-retention.ts";
import { createLedger } from "./ledger/index.ts";
import type { WorkerPurgeBatch } from "./ledger/worker-retention.ts";
import { openDatabase } from "./store/index.ts";
import { openTestDb } from "./store/test-helpers.ts";

afterEach(() => {
  vi.useRealTimers();
});

const db = openDatabase(":memory:");

function fakeLedger(batches: WorkerPurgeBatch[]) {
  const calls: Array<{ now: number | undefined; maxRows: number | undefined }> = [];
  let i = 0;
  return {
    calls,
    ledger: {
      purgeExpiredWorkerConversations: (now?: number, maxRows?: number): WorkerPurgeBatch => {
        calls.push({ now, maxRows });
        return batches[Math.min(i++, batches.length - 1)]!;
      },
    },
  };
}

describe("runRetentionRound", () => {
  it("一批一批清到没有为止：批与批之间让出一次事件循环，每批最多 WORKER_PURGE_BATCH_ROWS 行，汇总写一行日志", async () => {
    const { ledger, calls } = fakeLedger([
      { rows: 500, purged: [1], more: true },
      { rows: 500, purged: [], more: true },
      { rows: 120, purged: [2, 3], more: false },
    ]);
    const log: string[] = [];
    let yields = 0;
    const round = await runRetentionRound({ ledger, db, log: (l) => log.push(l), now: () => 42, yieldToLoop: async () => void yields++ });
    expect(round).toMatchObject({ workers: 3, rows: 1_120, batches: 3, pages: 0 });
    expect(round.batchMs).toHaveLength(3);
    expect(yields).toBe(2);
    expect(calls.map((c) => c.now)).toEqual([42, 42, 42]);
    expect(calls.every((c) => c.maxRows! <= WORKER_PURGE_BATCH_ROWS)).toBe(true);
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("清了 3 个的对话（1120 行，3 批）");
  });

  it("一轮最多 WORKER_PURGE_ROUND_MAX_ROWS 行：没清完的留给下一轮，最后一批只要剩下的额度", async () => {
    const { ledger, calls } = fakeLedger([{ rows: WORKER_PURGE_BATCH_ROWS, purged: [], more: true }]);
    const round = await runRetentionRound({ ledger, db, log: () => {}, yieldToLoop: async () => {} });
    expect(round.rows).toBe(WORKER_PURGE_ROUND_MAX_ROWS);
    expect(round.batches).toBe(WORKER_PURGE_ROUND_MAX_ROWS / WORKER_PURGE_BATCH_ROWS);
    expect(calls.at(-1)!.maxRows).toBe(WORKER_PURGE_BATCH_ROWS);
  });

  it("没有要清的：不写日志", async () => {
    const { ledger } = fakeLedger([{ rows: 0, purged: [], more: false }]);
    const log: string[] = [];
    expect(await runRetentionRound({ ledger, db, log: (l) => log.push(l) })).toMatchObject({ rows: 0, batches: 1 });
    expect(log).toEqual([]);
  });

  it("出错只记日志不抛；已经做完的部分算数", async () => {
    let n = 0;
    const ledger = {
      purgeExpiredWorkerConversations: (): WorkerPurgeBatch => {
        if (++n === 2) throw new Error("database is locked");
        return { rows: 10, purged: [], more: true };
      },
    };
    const log: string[] = [];
    const round = await runRetentionRound({ ledger, db, log: (l) => log.push(l), yieldToLoop: async () => {} });
    expect(round.rows).toBe(10);
    expect(log.some((l) => l.includes("清理已收工 Worker 的对话出错：database is locked"))).toBe(true);
  });

  it("关机了：不再开始新的一批", async () => {
    const { ledger, calls } = fakeLedger([{ rows: 1, purged: [], more: true }]);
    let stopped = false;
    const round = await runRetentionRound({ ledger, db, log: () => {}, yieldToLoop: async () => void (stopped = true), isStopped: () => stopped });
    expect(calls).toHaveLength(1);
    expect(round.batches).toBe(1);
  });
});

describe("startWorkerRetention", () => {
  it("启动时先来一轮，之后每 WORKER_RETENTION_INTERVAL_MS 一轮；上一轮没完不叠；停止后不再来", async () => {
    vi.useFakeTimers();
    const { ledger, calls } = fakeLedger([{ rows: 0, purged: [], more: false }]);
    const stop = startWorkerRetention({ ledger, db, log: () => {} });
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(WORKER_RETENTION_INTERVAL_MS);
    expect(calls).toHaveLength(2);
    stop();
    await vi.advanceTimersByTimeAsync(WORKER_RETENTION_INTERVAL_MS * 3);
    expect(calls).toHaveLength(2);
  });
});

describe("Router 与已完成任务图的到期清理", () => {
  it("按保留期分批清理已决 router_items、超限 router_commands / router_audit_log 与满 90 天已完成 task_graphs，保留活跃项", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-hub-retention-rg-"));
    const realDb = openTestDb();
    const realLedger = createLedger(realDb, { pmHomeRoot: join(root, "pm-home"), dataHome: root });
    try {
      const { pm, conversation } = realLedger.createPm({ name: "小林", mode: "manage_only", persona: "" });
      const nowMs = 200 * 24 * 60 * 60 * 1000;
      const oldRouterAt = nowMs - ROUTER_ITEM_RETENTION_MS - 1_000;
      const freshRouterAt = nowMs - 1_000;
      const oldGraphAt = nowMs - COMPLETED_GRAPH_RETENTION_MS - 1_000;

      const projectId = Number(
        realDb.run(
          "INSERT INTO projects (name, pm_id, conversation_id, created_at, updated_at) VALUES ('foo', ?, ?, 100, 100)",
          pm.id,
          conversation.id,
        ).lastInsertRowid,
      );

      // 过期已归档汇报（应被清） vs 过期但仍 pending 的拍板（绝不能清！） vs 未到期已归档（保留）
      realDb.run(
        `INSERT INTO router_items (pm_id, project_id, conversation_id, kind, status, summary, created_at, updated_at)
         VALUES (?, ?, ?, 'report', 'archived', '旧汇报', ?, ?)`,
        pm.id,
        projectId,
        conversation.id,
        oldRouterAt,
        oldRouterAt,
      );
      realDb.run(
        `INSERT INTO router_items (pm_id, project_id, conversation_id, kind, status, question, options_json, created_at, updated_at)
         VALUES (?, ?, ?, 'decision', 'pending', '一直未答的拍板', '["A","B"]', ?, ?)`,
        pm.id,
        projectId,
        conversation.id,
        oldRouterAt,
        oldRouterAt,
      );
      realDb.run(
        `INSERT INTO router_items (pm_id, project_id, conversation_id, kind, status, summary, created_at, updated_at)
         VALUES (?, ?, ?, 'report', 'archived', '近期汇报', ?, ?)`,
        pm.id,
        projectId,
        conversation.id,
        freshRouterAt,
        freshRouterAt,
      );

      // 520 条指令与 530 条审计日志 -> 收缩至 <= 500
      realDb.exec("BEGIN");
      for (let i = 1; i <= 520; i++) {
        realDb.run(
          `INSERT INTO router_commands (client_id, input_text, vendor, status, created_at, updated_at)
           VALUES (?, 'cmd', 'claude', 'dispatched', ?, ?)`,
          `c-${i}`,
          freshRouterAt + i,
          freshRouterAt + i,
        );
      }
      for (let i = 1; i <= 530; i++) {
        realDb.run("INSERT INTO router_audit_log (actor, action, created_at) VALUES ('pm', 'router.note', ?)", freshRouterAt + i);
      }
      realDb.exec("COMMIT");

      // 满 90 天已完结任务图（应级联删除节点与边） vs 活跃图（保留）
      const oldGid = Number(
        realDb.run(
          `INSERT INTO task_graphs (project_id, pm_id, conversation_id, title, status, created_at, updated_at, completed_at)
           VALUES (?, ?, ?, '老图', 'completed', ?, ?, ?)`,
          projectId,
          pm.id,
          conversation.id,
          oldGraphAt,
          oldGraphAt,
          oldGraphAt,
        ).lastInsertRowid,
      );
      realDb.run(
        "INSERT INTO task_graph_steps (graph_id, node_key, title, status, created_at, updated_at) VALUES (?, 'a', 'A', 'done', ?, ?)",
        oldGid,
        oldGraphAt,
        oldGraphAt,
      );
      const activeGid = Number(
        realDb.run(
          `INSERT INTO task_graphs (project_id, pm_id, conversation_id, title, status, created_at, updated_at)
           VALUES (?, ?, ?, '活跃老图', 'active', ?, ?)`,
          projectId,
          pm.id,
          conversation.id,
          oldGraphAt,
          oldGraphAt,
        ).lastInsertRowid,
      );

      await runRetentionRound({ ledger: realLedger, db: realDb, log: () => {}, now: () => nowMs, yieldToLoop: async () => {} });

      const remainingItems = realDb.all<{ status: string }>("SELECT status FROM router_items ORDER BY id");
      expect(remainingItems.map((r) => r.status)).toEqual(["pending", "archived"]);
      expect(realDb.get<{ n: number }>("SELECT count(*) AS n FROM router_commands")!.n).toBe(ROUTER_COMMANDS_RETENTION_MAX);
      expect(realDb.get<{ n: number }>("SELECT count(*) AS n FROM router_audit_log")!.n).toBe(ROUTER_AUDIT_LOG_MAX_ROWS);
      expect(realDb.all<{ id: number }>("SELECT id FROM task_graphs")).toEqual([{ id: activeGid }]);
      expect(realDb.get<{ n: number }>("SELECT count(*) AS n FROM task_graph_steps WHERE graph_id = ?", oldGid)!.n).toBe(0);
    } finally {
      realLedger.close();
      realDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
