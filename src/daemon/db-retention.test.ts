// 账本定期清理的调度（db-retention.ts）：分批、批间让出、一轮上限、出错只记日志、关机后不再开始新的一批。
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKER_PURGE_BATCH_ROWS, WORKER_PURGE_ROUND_MAX_ROWS, WORKER_RETENTION_INTERVAL_MS } from "../shared/limits.ts";
import { runRetentionRound, startWorkerRetention } from "./db-retention.ts";
import type { WorkerPurgeBatch } from "./ledger/worker-retention.ts";
import { openDatabase } from "./store/index.ts";

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
