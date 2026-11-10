// 账本的定期清理：已收工 Worker 满 WORKER_RETENTION_DAYS 天后清它的对话（ledger/worker-retention.ts），再把空出来的页还给文件系统
// （store/maintenance.ts 的 incremental_vacuum）。启动时先来一轮，之后每 WORKER_RETENTION_INTERVAL_MS 一轮。
// 一轮里分批：每批一个事务（最多 WORKER_PURGE_BATCH_ROWS 行）、批与批之间让出事件循环，一轮最多 WORKER_PURGE_ROUND_MAX_ROWS 行，
// 没清完的下一轮接着清；回收空闲页同样一次一小块（DB_INCREMENTAL_VACUUM_PAGES），一轮最多 DB_INCREMENTAL_VACUUM_ROUND_MAX_PAGES。
// 任何出错都只记日志（下一轮重来，每批是一个事务，回滚不留半截数据）。
import { LOG_PREFIX, WORKER_PURGE_BATCH_ROWS, WORKER_PURGE_ROUND_MAX_ROWS, WORKER_RETENTION_INTERVAL_MS } from "../shared/index.ts";
import type { SqliteLedger } from "./ledger/index.ts";
import { reclaimFreePages } from "./store/index.ts";
import type { Db } from "./store/index.ts";

export interface RetentionDeps {
  ledger: Pick<SqliteLedger, "purgeExpiredWorkerConversations">;
  db: Db;
  log: (line: string) => void;
  now?: () => number;
  /** 批与批之间做什么，默认让出一次事件循环（别的请求、WebSocket 照常处理）；测试可以换。 */
  yieldToLoop?: () => Promise<void>;
  /** 关机了：不再开始新的一批（库马上要关）。 */
  isStopped?: () => boolean;
}

export interface RetentionRound {
  workers: number;
  rows: number;
  batches: number;
  /** 每批各用了多少毫秒。 */
  batchMs: number[];
  /** 本轮还给文件系统的页数。 */
  pages: number;
}

const defaultYield = () => new Promise<void>((resolve) => setImmediate(resolve));
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 跑一轮：清到期的 Worker 对话，再回收空闲页。出错记日志、返回已经做完的部分。 */
export async function runRetentionRound(deps: RetentionDeps): Promise<RetentionRound> {
  const { ledger, db, log } = deps;
  const now = deps.now ?? Date.now;
  const yieldToLoop = deps.yieldToLoop ?? defaultYield;
  const stopped = deps.isStopped ?? (() => false);
  const round: RetentionRound = { workers: 0, rows: 0, batches: 0, batchMs: [], pages: 0 };
  try {
    while (round.rows < WORKER_PURGE_ROUND_MAX_ROWS && !stopped()) {
      const started = performance.now();
      const batch = ledger.purgeExpiredWorkerConversations(now(), Math.min(WORKER_PURGE_BATCH_ROWS, WORKER_PURGE_ROUND_MAX_ROWS - round.rows));
      round.batchMs.push(performance.now() - started);
      round.batches++;
      round.rows += batch.rows;
      round.workers += batch.purged.length;
      if (!batch.more) break;
      await yieldToLoop();
    }
    if (!stopped()) round.pages = (await reclaimFreePages(db, { yieldToLoop, isStopped: stopped })).pages;
  } catch (error) {
    log(`${LOG_PREFIX} 清理已收工 Worker 的对话出错：${errorText(error)}`);
  }
  if (round.workers > 0 || round.rows > 0 || round.pages > 0) {
    log(`${LOG_PREFIX} 已收工满保留期的 Worker：清了 ${round.workers} 个的对话（${round.rows} 行，${round.batches} 批），回收 ${round.pages} 页空间`);
  }
  return round;
}

/** 马上来一轮，之后每 WORKER_RETENTION_INTERVAL_MS 一轮（上一轮没完不叠）。返回停止函数（关机时调）。 */
export function startWorkerRetention(deps: Omit<RetentionDeps, "isStopped">): () => void {
  let stopped = false;
  let running = false;
  const tick = () => {
    if (running || stopped) return;
    running = true;
    void runRetentionRound({ ...deps, isStopped: () => stopped }).finally(() => {
      running = false;
    });
  };
  tick();
  const timer = setInterval(tick, WORKER_RETENTION_INTERVAL_MS);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
