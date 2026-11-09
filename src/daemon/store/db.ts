// 整个项目里只有这个文件碰 node:sqlite（m1-plan 第 6 节第 4 条）。它还是“候选发布”，
// 接口真变了，换成 better-sqlite3 只改这里。其他代码只用下面的 Db。
import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
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

/** 打开数据库：WAL、外键检查、忙等 DB_BUSY_TIMEOUT_MS。file 可以是 ":memory:"（测试用）。maxStatements 测试可以改小。 */
export function openDatabase(file: string, options: { maxStatements?: number } = {}): Db {
  const maxStatements = options.maxStatements ?? MAX_CACHED_STATEMENTS;
  const raw = new DatabaseSync(file, { enableForeignKeyConstraints: true, timeout: DB_BUSY_TIMEOUT_MS });
  raw.exec("PRAGMA journal_mode = WAL");
  // WAL 下 NORMAL 不会把库写坏，但断电（不是进程崩溃）可能丢掉最后几次提交
  raw.exec("PRAGMA synchronous = NORMAL");
  /** Map 的顺序就是新旧：用到就挪到最后，超过 MAX_CACHED_STATEMENTS 删最前面（最久没用）的。 */
  const statements = new Map<string, StatementSync>();
  let depth = 0;

  const prepare = (sql: string): StatementSync => {
    let stmt = statements.get(sql);
    if (stmt === undefined) {
      stmt = raw.prepare(sql);
      if (statements.size >= maxStatements) statements.delete(statements.keys().next().value!);
    } else {
      statements.delete(sql);
    }
    statements.set(sql, stmt);
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
      statements.clear();
      raw.close();
    },
  };
}
