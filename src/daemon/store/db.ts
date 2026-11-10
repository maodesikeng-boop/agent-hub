// 整个项目里只有这个文件碰 node:sqlite（m1-plan 第 6 节第 4 条）。它还是“候选发布”，
// 接口真变了，换成 better-sqlite3 只改这里。其他代码只用下面的 Db。
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
  /** 执行一段或几段不带参数的 SQL（迁移、PRAGMA）。 */
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): RunResult;
  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[];
  /**
   * BEGIN IMMEDIATE / COMMIT，fn 抛错就 ROLLBACK 再抛出去。fn 必须是同步的。
   * 已经在事务里时直接并入外层（外层回滚时一起回滚）。
   */
  transaction<T>(fn: () => T): T;
  readonly inTransaction: boolean;
  close(): void;
}

/** 打开数据库：WAL、增量回收（新库）、外键检查、忙等 DB_BUSY_TIMEOUT_MS。file 可以是 ":memory:"（测试用）。maxStatements 测试可以改小。 */
export function openDatabase(file: string, options: { maxStatements?: number } = {}): Db {
  const maxStatements = options.maxStatements ?? MAX_CACHED_STATEMENTS;
  const raw = new DatabaseSync(file, { enableForeignKeyConstraints: true, timeout: DB_BUSY_TIMEOUT_MS });
  // 新库一开始就是增量回收模式（删掉的页进空闲列表，由 maintenance.ts 的 reclaimFreePages 分批还给文件系统）。
  // 已经有表的老库这句不起作用，要靠 maintenance.ts 的 ensureIncrementalVacuum 重建一次；必须在建任何表（含改成 WAL）之前设。
  raw.exec("PRAGMA auto_vacuum = INCREMENTAL");
  raw.exec("PRAGMA journal_mode = WAL");
  // WAL 下 NORMAL 不会把库写坏，但断电（不是进程崩溃）可能丢掉最后几次提交
  raw.exec("PRAGMA synchronous = NORMAL");
  /** 预编译语句 LRU 缓存：命中自动刷新顺序，超过 MAX_CACHED_STATEMENTS 自动淘汰最久没用的。 */
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
      if (depth > 0) return fn();
      raw.exec("BEGIN IMMEDIATE");
      depth++;
      try {
        const result = fn();
        raw.exec("COMMIT");
        return result;
      } catch (error) {
        raw.exec("ROLLBACK");
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
