import { FEISHU_POST_RETENTION_MS, LOG_PREFIX, WORKER_PURGE_BATCH_ROWS, WORKER_PURGE_ROUND_MAX_ROWS, WORKER_RETENTION_INTERVAL_MS } from "../shared/index.ts";
import type { FeishuOfflineInbox } from "./feishu/account-bot.ts";
import type { FeishuStore } from "./feishu/store.ts";
import type { SqliteLedger } from "./ledger/index.ts";
import { reclaimFreePages } from "./store/index.ts";
import type { Db } from "./store/index.ts";

export interface RetentionDeps {
  ledger: Pick<SqliteLedger, "purgeExpiredWorkerConversations"> &
    Partial<Pick<SqliteLedger, "purgeExpiredRouterAndGraphRecords">>;
  db: Db;
  feishuPosts?: Pick<FeishuStore, "prunePosts">;
  feishuOfflineInbox?: Pick<FeishuOfflineInbox, "expire">;
  log: (line: string) => void;
  now?: () => number;
  yieldToLoop?: () => Promise<void>;
  /** The database is about to close, so do not start another batch. */
  isStopped?: () => boolean;
}

export interface RetentionRound {
  workers: number;
  rows: number;
  batches: number;
  batchMs: number[];
  pages: number;
}

const defaultYield = () => new Promise<void>((resolve) => setImmediate(resolve));
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
    if (ledger.purgeExpiredRouterAndGraphRecords !== undefined) {
      while (round.rows < WORKER_PURGE_ROUND_MAX_ROWS && !stopped()) {
        const started = performance.now();
        const batch = ledger.purgeExpiredRouterAndGraphRecords(
          now(),
          Math.min(WORKER_PURGE_BATCH_ROWS, WORKER_PURGE_ROUND_MAX_ROWS - round.rows),
        );
        if (batch.rows > 0) {
          round.batchMs.push(performance.now() - started);
          round.batches++;
          round.rows += batch.rows;
        }
        if (!batch.more) break;
        await yieldToLoop();
      }
    }
    if (deps.feishuPosts !== undefined && !stopped()) {
      const posts = deps.feishuPosts.prunePosts(now() - FEISHU_POST_RETENTION_MS);
      if (posts > 0) log(`${LOG_PREFIX} 飞书：清了 ${posts} 条已定稿的投影记录`);
    }
    if (deps.feishuOfflineInbox !== undefined && !stopped()) {
      const expired = deps.feishuOfflineInbox.expire(now());
      const total = expired.reduce((sum, item) => sum + item.count, 0);
      if (total > 0) log(`${LOG_PREFIX} 飞书：清了 ${total} 条过期的离线暂存消息`);
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
