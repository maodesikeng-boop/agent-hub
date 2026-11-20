import { DB_INCREMENTAL_VACUUM_PAGES, DB_INCREMENTAL_VACUUM_ROUND_MAX_PAGES } from "../../shared/limits.ts";
import type { Db } from "./db.ts";
import { backupDatabase, mainDbFile, userVersion } from "./migrate.ts";

const AUTO_VACUUM_INCREMENTAL = 2;

const pragmaNumber = (db: Db, name: string): number => Number(Object.values(db.get<Record<string, unknown>>(`PRAGMA ${name}`) ?? {})[0] ?? 0);

export const autoVacuumMode = (db: Db): number => pragmaNumber(db, "auto_vacuum");
export const freePages = (db: Db): number => pragmaNumber(db, "freelist_count");
export const totalPages = (db: Db): number => pragmaNumber(db, "page_count");

export interface EnsureIncrementalOptions {
  backup?: boolean;
  now?: () => number;
}

export interface EnsureIncrementalResult {
  converted: boolean;
  backupFile?: string;
  /** Rebuild failures (disk full, locked by another process) skip this run instead of blocking startup. */
  error?: string;
}

/** VACUUM cannot run inside a transaction. */
export function ensureIncrementalVacuum(db: Db, options: EnsureIncrementalOptions = {}): EnsureIncrementalResult {
  if (db.inTransaction) throw new Error("ensureIncrementalVacuum() must not be called inside a transaction: VACUUM cannot run in one.");
  const before = autoVacuumMode(db);
  if (before === AUTO_VACUUM_INCREMENTAL) return { converted: false };
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
    }
    return {
      converted: false,
      ...(backupFile !== undefined ? { backupFile } : {}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface ReclaimOptions {
  chunkPages?: number;
  maxPages?: number;
  yieldToLoop?: () => Promise<void>;
  isStopped?: () => boolean;
}

export interface ReclaimResult {
  pages: number;
  remaining: number;
  chunkMs: number[];
}

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
    if (after >= free) break; // Stop when nothing was reclaimed to avoid an endless loop.
    free = after;
    if (free > 0 && pages < maxPages) await options.yieldToLoop?.();
  }
  return { pages, remaining: free, chunkMs };
}
