// Only this file imports node:sqlite, which is still a release candidate; swapping drivers touches only this file.
import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import { LRUCache } from "lru-cache";
import { DB_BUSY_TIMEOUT_MS, MAX_CACHED_STATEMENTS } from "../../shared/limits.ts";

export type SqlValue = null | number | bigint | string | Uint8Array;

interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface Db {
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): RunResult;
  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[];
  /** Nested calls use a SAVEPOINT so an inner failure rolls back only itself. fn must be synchronous; awaiting inside a transaction is treated as an error. */
  transaction<T>(fn: () => T): T;
  readonly inTransaction: boolean;
  close(): void;
}

export interface OpenDatabaseOptions {
  maxStatements?: number;
  /** Hold SQLite's file lock from open to close so no other process can read or write the file. */
  exclusive?: boolean;
}

export function openDatabase(file: string, options: OpenDatabaseOptions = {}): Db {
  const maxStatements = options.maxStatements ?? MAX_CACHED_STATEMENTS;
  const raw = new DatabaseSync(file, { enableForeignKeyConstraints: true, timeout: DB_BUSY_TIMEOUT_MS });
  try {
    // node:sqlite waits for a lock synchronously on the event loop, so a foreign write lock would freeze every request; with WAL this has to precede the first access to keep the wal-index out of shared memory.
    if (options.exclusive === true) raw.exec("PRAGMA locking_mode = EXCLUSIVE");
    // auto_vacuum only takes effect before the first table (and before WAL); older databases are rebuilt by ensureIncrementalVacuum.
    raw.exec("PRAGMA auto_vacuum = INCREMENTAL");
    raw.exec("PRAGMA journal_mode = WAL");
    // With WAL, synchronous=NORMAL cannot corrupt the database but power loss may drop the last commits.
    raw.exec("PRAGMA synchronous = NORMAL");
  } catch (error) {
    raw.close();
    throw error;
  }
  const stmtCache = new LRUCache<string, StatementSync>({ max: Math.max(1, maxStatements) });
  let depth = 0;

  const prepare = (sql: string): StatementSync => {
    let stmt = stmtCache.get(sql);
    if (stmt === undefined) {
      stmt = raw.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  };

  const runSync = <T>(fn: () => T): T => {
    const result = fn();
    if (typeof (result as { then?: unknown } | null)?.then === "function") {
      // This call already rolled back, so a later rejection must not surface as unhandled.
      Promise.resolve(result).catch(() => undefined);
      throw new Error("db.transaction 的回调必须是同步的：异步 I/O 放在开事务之前做完，事务里不能 await");
    }
    return result;
  };

  const nested = <T>(fn: () => T): T => {
    const savepoint = `sp_${depth}`;
    raw.exec(`SAVEPOINT ${savepoint}`);
    depth++;
    try {
      const result = runSync(fn);
      raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      // After SQLite rolls back the whole transaction itself (disk full, I/O error) the savepoint is gone, so leave it to the outer ROLLBACK.
      if (raw.isTransaction) {
        raw.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      throw error;
    } finally {
      depth--;
    }
  };

  return {
    exec(sql) {
      raw.exec(sql);
    },
    run(sql, ...params) {
      const result = prepare(sql).run(...params);
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
    },
    get<T>(sql: string, ...params: SqlValue[]) {
      return prepare(sql).get(...params) as T | undefined;
    },
    all<T>(sql: string, ...params: SqlValue[]) {
      return prepare(sql).all(...params) as T[];
    },
    transaction(fn) {
      if (depth > 0) return nested(fn);
      raw.exec("BEGIN IMMEDIATE");
      depth++;
      try {
        const result = runSync(fn);
        raw.exec("COMMIT");
        return result;
      } catch (error) {
        if (raw.isTransaction) raw.exec("ROLLBACK");
        throw error;
      } finally {
        depth--;
      }
    },
    get inTransaction() {
      return depth > 0;
    },
    close() {
      stmtCache.clear();
      raw.close();
    },
  };
}
