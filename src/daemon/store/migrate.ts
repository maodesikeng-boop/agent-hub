// 迁移：migrations/ 下 `<编号>_<名字>.sql`，按编号执行比 PRAGMA user_version 大的，
// 每个文件一个事务，成功后把 user_version 设成它的编号。
// 跑每个文件时关着外键检查（事务里改不了这个开关，只能在事务外关），提交前用 PRAGMA foreign_key_check 查一遍，
// 有悬空引用就回滚，报错里列出是哪些行。这样迁移可以按 SQLite 的标准做法重建被别的表引用的表（0002 重建 pms）。
// 所以不能在外层事务里调（那样关不了外键检查），调了直接报错。
// 已有数据的库升级前先备份一份：<库文件>.bak-<升级前的版本>-<UTC 时间>（VACUUM INTO，是个完整的库文件）。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.ts";

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/", import.meta.url));

export interface MigrationResult {
  from: number;
  to: number;
  /** 这次执行了哪些编号。 */
  applied: number[];
  /** 升级前备份到了哪个文件；没备份（空库、没有要跑的、内存库）是 undefined。 */
  backupFile?: string;
}

export interface MigrateOptions {
  /** 备份文件名里的时间，测试用。 */
  now?: () => number;
}

interface MigrationFile {
  version: number;
  file: string;
}

/** 外键检查报错里最多列几行。 */
const MAX_REPORTED_FK_ROWS = 10;

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

/** 2026-11-03T09:08:07.123Z → 20261103T090807Z */
function backupStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** 库文件的路径；内存库、临时库是 null。 */
function mainDbFile(db: Db): string | null {
  const file = db.all<{ name: string; file: string }>("PRAGMA database_list").find((d) => d.name === "main")?.file;
  return file ? file : null;
}

function backup(db: Db, from: number, now: () => number): string | undefined {
  const file = mainDbFile(db);
  if (file === null) return undefined;
  let target = `${file}.bak-${from}-${backupStamp(now())}`;
  for (let n = 2; existsSync(target); n++) target = `${file}.bak-${from}-${backupStamp(now())}-${n}`;
  db.run("VACUUM INTO ?", target);
  return target;
}

function checkForeignKeys(db: Db): void {
  const dangling = db.all<{ table: string; rowid: number | null; parent: string }>("PRAGMA foreign_key_check");
  if (dangling.length === 0) return;
  const rows = dangling
    .slice(0, MAX_REPORTED_FK_ROWS)
    .map((d) => `${d.table} rowid ${d.rowid ?? "?"} → ${d.parent}`)
    .join("; ");
  const more = dangling.length > MAX_REPORTED_FK_ROWS ? `; and ${dangling.length - MAX_REPORTED_FK_ROWS} more` : "";
  throw new Error(`foreign key check failed: ${dangling.length} row(s): ${rows}${more}`);
}

export function migrate(db: Db, dir: string = DEFAULT_MIGRATIONS_DIR, options: MigrateOptions = {}): MigrationResult {
  if (db.inTransaction) {
    throw new Error(
      "migrate() must not be called inside a transaction: it has to switch PRAGMA foreign_keys off between transactions. " +
        "Call it right after opening the database.",
    );
  }
  const migrations = listMigrations(dir);
  const from = userVersion(db);
  const latest = migrations.at(-1)?.version ?? 0;
  if (from > latest) {
    throw new Error(`database user_version ${from} is newer than the latest migration ${latest}`);
  }
  const pending = migrations.filter((m) => m.version > from);
  const backupFile = from > 0 && pending.length > 0 ? backup(db, from, options.now ?? Date.now) : undefined;
  const applied: number[] = [];
  for (const { version, file } of pending) {
    const sql = readFileSync(join(dir, file), "utf8");
    const foreignKeys = db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys === 1;
    if (foreignKeys) db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(sql);
        checkForeignKeys(db);
        db.exec(`PRAGMA user_version = ${version}`);
      });
    } catch (error) {
      throw new Error(`migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      if (foreignKeys) db.exec("PRAGMA foreign_keys = ON");
    }
    applied.push(version);
  }
  return { from, to: userVersion(db), applied, ...(backupFile !== undefined ? { backupFile } : {}) };
}
