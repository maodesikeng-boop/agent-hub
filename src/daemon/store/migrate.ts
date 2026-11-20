// Foreign keys can only be toggled outside a transaction, so each migration runs with them off and foreign_key_check runs before commit. That lets migrations rebuild referenced tables, and it is why this cannot run inside an outer transaction.
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DB_INCREMENTAL_VACUUM_PAGES, MAX_DB_BACKUPS } from "../../shared/limits.ts";
import type { Db } from "./db.ts";

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/", import.meta.url));

export interface MigrationResult {
  from: number;
  to: number;
  applied: number[];
  backupFile?: string;
}

export interface MigrateOptions {
  now?: () => number;
}

interface MigrationFile {
  version: number;
  file: string;
}

const MAX_REPORTED_FK_ROWS = 10;
const AUTO_VACUUM_INCREMENTAL = 2;

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

function freelistCount(db: Db): number {
  return db.get<{ freelist_count: number }>("PRAGMA freelist_count")?.freelist_count ?? 0;
}

function backupStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function mainDbFile(db: Db): string | null {
  const file = db.all<{ name: string; file: string }>("PRAGMA database_list").find((d) => d.name === "main")?.file;
  return file ? file : null;
}

export function backupDatabase(db: Db, from: number, now: () => number): string | undefined {
  const file = mainDbFile(db);
  if (file === null) return undefined;
  let target = `${file}.bak-${from}-${backupStamp(now())}`;
  for (let n = 2; existsSync(target); n++) target = `${file}.bak-${from}-${backupStamp(now())}-${n}`;
  try {
    db.run("VACUUM INTO ?", target);
  } catch (error) {
    try {
      rmSync(target, { force: true });
    } catch {
    }
    throw error;
  }
  pruneBackups(file, target);
  return target;
}

function backupSortKey(dbName: string, name: string): [string, number] | null {
  if (!name.startsWith(`${dbName}.bak-`)) return null;
  const match = /^\d+-(\d{8}T\d{6}Z)(?:-(\d+))?$/.exec(name.slice(dbName.length + 5));
  return match === null ? null : [match[1]!, match[2] === undefined ? 1 : Number(match[2])];
}

function pruneBackups(dbFile: string, keep: string): void {
  const dbName = basename(dbFile);
  const dir = dirname(dbFile);
  const backups: { name: string; key: [string, number] }[] = [];
  for (const name of readdirSync(dir)) {
    const key = backupSortKey(dbName, name);
    if (key !== null && join(dir, name) !== keep) backups.push({ name, key });
  }
  backups.sort((a, b) => (a.key[0] < b.key[0] ? -1 : a.key[0] > b.key[0] ? 1 : a.key[1] - b.key[1]));
  for (const { name } of backups.slice(0, Math.max(0, backups.length - (MAX_DB_BACKUPS - 1)))) {
    try {
      rmSync(join(dir, name), { force: true });
    } catch {
    }
  }
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
  const backupFile = from > 0 && pending.length > 0 ? backupDatabase(db, from, options.now ?? Date.now) : undefined;
  const freeBefore =
    pending.length > 0 && db.get<{ auto_vacuum: number }>("PRAGMA auto_vacuum")?.auto_vacuum === AUTO_VACUUM_INCREMENTAL
      ? freelistCount(db)
      : undefined;
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
  if (freeBefore !== undefined) {
    const addedFree = Math.min(freelistCount(db) - freeBefore, DB_INCREMENTAL_VACUUM_PAGES);
    if (addedFree > 0) db.exec(`PRAGMA incremental_vacuum(${addedFree})`);
  }
  return { from, to: userVersion(db), applied, ...(backupFile !== undefined ? { backupFile } : {}) };
}
