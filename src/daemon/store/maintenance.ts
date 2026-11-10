// 数据库空间维护（对标 t3code 的 DatabaseMaintenance）：删了的行只是把页放进空闲列表，库文件不会变小。
// - ensureIncrementalVacuum：老库（auto_vacuum = NONE）改成 INCREMENTAL，要整库 VACUUM 重建一次（SQLite 只有这个办法；
//   PRAGMA 不能在事务里改，VACUUM 也不能在事务里跑，所以不能放进 migrations/ 的 .sql——迁移文件都在事务里执行）。
//   重建前先备份（同迁移的备份：<库文件>.bak-<版本>-<UTC 时间>，只留最近 MAX_DB_BACKUPS 份）；新库一开始就是 INCREMENTAL（db.ts），不用重建。
// - reclaimFreePages：把空闲列表里的页分批还给文件系统（PRAGMA incremental_vacuum(N)）。每次只回收 chunkPages 页，
//   每次都是一次短写事务，次与次之间让出事件循环，不长时间占着写锁。
import { DB_INCREMENTAL_VACUUM_PAGES, DB_INCREMENTAL_VACUUM_ROUND_MAX_PAGES } from "../../shared/limits.ts";
import type { Db } from "./db.ts";
import { backupDatabase, mainDbFile, userVersion } from "./migrate.ts";

/** auto_vacuum 的取值：0 NONE、1 FULL、2 INCREMENTAL。 */
const AUTO_VACUUM_INCREMENTAL = 2;

const pragmaNumber = (db: Db, name: string): number => Number(Object.values(db.get<Record<string, unknown>>(`PRAGMA ${name}`) ?? {})[0] ?? 0);

export const autoVacuumMode = (db: Db): number => pragmaNumber(db, "auto_vacuum");
/** 空闲列表里现在有多少页（删了没还给文件系统的）。 */
export const freePages = (db: Db): number => pragmaNumber(db, "freelist_count");
/** 库文件现在有多少页。 */
export const totalPages = (db: Db): number => pragmaNumber(db, "page_count");

export interface EnsureIncrementalOptions {
  /** 重建前要不要备份：老库有数据时要；刚升级过（迁移已经备份了一份）的调用方传 false。默认 true。 */
  backup?: boolean;
  /** 备份文件名里的时间，测试用。 */
  now?: () => number;
}

export interface EnsureIncrementalResult {
  /** 这次把库重建成了 INCREMENTAL；本来就是（或没有文件的内存库、或重建失败跳过）是 false。 */
  converted: boolean;
  backupFile?: string;
  /** 重建失败（磁盘空间不足、别的进程占着锁等）时的原因：跳过本次重建，不挡住后台启动，下次启动再试。 */
  error?: string;
}

/**
 * 老库改成增量回收模式：先备份、再 PRAGMA auto_vacuum = INCREMENTAL + VACUUM。不能在事务里调。已经是 INCREMENTAL 什么都不做。
 * 磁盘空间不足或被别的进程锁住时返回 `{ converted: false, error }`，不把库弄坏、也不挡住后台启动（下次启动再试）。
 */
export function ensureIncrementalVacuum(db: Db, options: EnsureIncrementalOptions = {}): EnsureIncrementalResult {
  if (db.inTransaction) throw new Error("ensureIncrementalVacuum() must not be called inside a transaction: VACUUM cannot run in one.");
  const before = autoVacuumMode(db);
  if (before === AUTO_VACUUM_INCREMENTAL) return { converted: false };
  // 内存库、临时库：没有文件可整理，也不用备份
  if (mainDbFile(db) === null) return { converted: false };
  let backupFile: string | undefined;
  try {
    backupFile = options.backup === false ? undefined : backupDatabase(db, userVersion(db), options.now ?? Date.now);
    db.exec(`PRAGMA auto_vacuum = ${AUTO_VACUUM_INCREMENTAL}`);
    db.exec("VACUUM");
    if (autoVacuumMode(db) !== AUTO_VACUUM_INCREMENTAL) {
      return {
        converted: false,
        ...(backupFile !== undefined ? { backupFile } : {}),
        error: "VACUUM did not switch the database to auto_vacuum = INCREMENTAL",
      };
    }
    return { converted: true, ...(backupFile !== undefined ? { backupFile } : {}) };
  } catch (error) {
    try {
      db.exec(`PRAGMA auto_vacuum = ${before}`);
    } catch {
      // 还原 PRAGMA 失败不影响跳过
    }
    return {
      converted: false,
      ...(backupFile !== undefined ? { backupFile } : {}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface ReclaimOptions {
  /** 每次回收多少页（默认 DB_INCREMENTAL_VACUUM_PAGES）。 */
  chunkPages?: number;
  /** 这一轮最多回收多少页（默认 DB_INCREMENTAL_VACUUM_ROUND_MAX_PAGES），多的留给下一轮。 */
  maxPages?: number;
  /** 两次回收之间做什么（守护进程让出事件循环）；默认什么都不做。 */
  yieldToLoop?: () => Promise<void>;
  /** 每次回收前问一下：true 就不再回收（关机了，库马上要关）。 */
  isStopped?: () => boolean;
}

export interface ReclaimResult {
  /** 这一轮还给文件系统的页数。 */
  pages: number;
  /** 还剩多少空闲页没还。 */
  remaining: number;
  /** 每次回收各用了多少毫秒（量单批耗时用）。 */
  chunkMs: number[];
}

/** 把空闲页分批还给文件系统。库不是 INCREMENTAL 模式（还没重建）、没有空闲页什么都不做。 */
export async function reclaimFreePages(db: Db, options: ReclaimOptions = {}): Promise<ReclaimResult> {
  const chunkPages = Math.max(1, Math.floor(options.chunkPages ?? DB_INCREMENTAL_VACUUM_PAGES));
  const maxPages = Math.max(0, Math.floor(options.maxPages ?? DB_INCREMENTAL_VACUUM_ROUND_MAX_PAGES));
  const chunkMs: number[] = [];
  let pages = 0;
  if (autoVacuumMode(db) !== AUTO_VACUUM_INCREMENTAL) return { pages, remaining: freePages(db), chunkMs };
  let free = freePages(db);
  while (free > 0 && pages < maxPages && options.isStopped?.() !== true) {
    const started = performance.now();
    db.exec(`PRAGMA incremental_vacuum(${Math.min(chunkPages, maxPages - pages)})`);
    chunkMs.push(performance.now() - started);
    const after = freePages(db);
    pages += free - after;
    if (after >= free) break; // 一页都没回收到（防死循环）
    free = after;
    if (free > 0 && pages < maxPages) await options.yieldToLoop?.();
  }
  return { pages, remaining: free, chunkMs };
}
