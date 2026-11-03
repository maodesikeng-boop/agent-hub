// 迁移：migrations/ 下 `<编号>_<名字>.sql`，按编号执行比 PRAGMA user_version 大的，
// 每个文件一个事务，成功后把 user_version 设成它的编号。
// 跑每个文件时关着外键检查（事务里改不了这个开关，只能在事务外关），提交前用 PRAGMA foreign_key_check 查一遍，
// 有悬空引用就回滚。这样迁移可以按 SQLite 的标准做法重建被别的表引用的表（0002 重建 pms）。
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.ts";

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/", import.meta.url));

export interface MigrationResult {
  from: number;
  to: number;
  /** 这次执行了哪些编号。 */
  applied: number[];
}

interface MigrationFile {
  version: number;
  file: string;
}

function listMigrations(dir: string): MigrationFile[] {
  const files: MigrationFile[] = [];
  for (const name of readdirSync(dir)) {
    const match = /^(\d+)_.*\.sql$/.exec(name);
    if (match === null) continue;
    files.push({ version: Number(match[1]), file: name });
  }
  files.sort((a, b) => a.version - b.version);
  for (let i = 1; i < files.length; i++) {
    if (files[i]!.version === files[i - 1]!.version) {
      throw new Error(`duplicate migration version ${files[i]!.version}: ${files[i - 1]!.file}, ${files[i]!.file}`);
    }
  }
  return files;
}

export function userVersion(db: Db): number {
  return db.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0;
}

export function migrate(db: Db, dir: string = DEFAULT_MIGRATIONS_DIR): MigrationResult {
  const migrations = listMigrations(dir);
  const from = userVersion(db);
  const latest = migrations.at(-1)?.version ?? 0;
  if (from > latest) {
    throw new Error(`database user_version ${from} is newer than the latest migration ${latest}`);
  }
  const applied: number[] = [];
  for (const { version, file } of migrations) {
    if (version <= from) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    const foreignKeys = db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys === 1;
    if (foreignKeys) db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(sql);
        const dangling = db.all<{ table: string; parent: string }>("PRAGMA foreign_key_check");
        if (dangling.length > 0) {
          const first = dangling[0]!;
          throw new Error(`foreign key check failed: ${dangling.length} row(s), e.g. ${first.table} → ${first.parent}`);
        }
        db.exec(`PRAGMA user_version = ${version}`);
      });
    } catch (error) {
      throw new Error(`migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      if (foreignKeys) db.exec("PRAGMA foreign_keys = ON");
    }
    applied.push(version);
  }
  return { from, to: userVersion(db), applied };
}
