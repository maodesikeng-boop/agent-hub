// Foreign keys can only be toggled outside a transaction, so each migration runs with them off and foreign_key_check runs before commit. That lets migrations rebuild referenced tables, and it is why this cannot run inside an outer transaction.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DB_INCREMENTAL_VACUUM_PAGES, MAX_DB_BACKUPS } from "../../shared/limits.ts";
import {
  clearMigrationAnchor,
  planMigrationBackup,
  pruneDatabaseBackups,
  readMigrationAnchor,
  writeMigrationAnchor,
} from "./backup-rotation.ts";
import type { Db } from "./db.ts";

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/", import.meta.url));
/** One `<sha256>  <file>` line per migration in version order, the format `shasum -a 256` prints and `shasum -c` checks. */
export const MIGRATION_MANIFEST = "manifest.sha256";

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
  sql: string;
}

interface ManifestEntry {
  version: number;
  file: string;
  sha256: string;
}

/** Triggers named with this prefix are built from code each time the ledger opens, so migrations drop them before running. */
export const CODE_TRIGGER_PREFIX = "code_";

const MAX_REPORTED_FK_ROWS = 10;
const AUTO_VACUUM_INCREMENTAL = 2;
const MANIFEST_LINE = /^([0-9a-f]{64}) {2}((\d+)_[^/\\\s]+\.sql)$/;

export function migrationChecksum(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function readManifest(dir: string, problems: string[]): ManifestEntry[] {
  let text: string;
  try {
    text = readFileSync(join(dir, MIGRATION_MANIFEST), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    problems.push(`${MIGRATION_MANIFEST} is missing`);
    return [];
  }
  const entries: ManifestEntry[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line === "") continue;
    const match = MANIFEST_LINE.exec(line);
    if (match === null) {
      problems.push(`${MIGRATION_MANIFEST} line ${index + 1} is not "<sha256>  <version>_<name>.sql"`);
      continue;
    }
    const version = Number(match[3]);
    const expected = entries.length + 1;
    if (version !== expected) problems.push(`${MIGRATION_MANIFEST} lists ${match[2]} where version ${expected} belongs`);
    entries.push({ version, file: match[2]!, sha256: match[1]! });
  }
  return entries;
}

/** Checks the whole migration set against its manifest before anything touches the database, so a missing, extra, renumbered, or altered file stops startup instead of being skipped for good. */
export function loadMigrations(dir: string): MigrationFile[] {
  const problems: string[] = [];
  const entries = readManifest(dir, problems);
  const listed = new Set(entries.map((e) => e.file));
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".sql") || listed.has(name)) continue;
    const line = `${migrationChecksum(readFileSync(join(dir, name)))}  ${name}`;
    problems.push(`${name} is not listed in ${MIGRATION_MANIFEST} (append "${line}")`);
  }
  const migrations: MigrationFile[] = [];
  for (const { version, file, sha256 } of entries) {
    let content: Buffer;
    try {
      content = readFileSync(join(dir, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      problems.push(`${file} is missing`);
      continue;
    }
    const actual = migrationChecksum(content);
    if (actual !== sha256) problems.push(`${file} has sha256 ${actual}, but ${MIGRATION_MANIFEST} expects ${sha256}`);
    migrations.push({ version, file, sql: content.toString("utf8") });
  }
  if (problems.length > 0) {
    throw new Error(`migrations in ${dir} do not match ${MIGRATION_MANIFEST}, so none were applied: ${problems.join("; ")}`);
  }
  return migrations;
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

function dropCodeTriggers(db: Db): void {
  const triggers = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND substr(name, 1, ?) = ?", CODE_TRIGGER_PREFIX.length, CODE_TRIGGER_PREFIX);
  for (const { name } of triggers) db.exec(`DROP TRIGGER "${name}"`);
}

export function migrate(db: Db, dir: string = DEFAULT_MIGRATIONS_DIR, options: MigrateOptions = {}): MigrationResult {
  if (db.inTransaction) {
    throw new Error(
      "migrate() must not be called inside a transaction: it has to switch PRAGMA foreign_keys off between transactions. " +
        "Call it right after opening the database.",
    );
  }
  const migrations = loadMigrations(dir);
  const from = userVersion(db);
  const latest = migrations.at(-1)?.version ?? 0;
  if (from > latest) {
    throw new Error(`database user_version ${from} is newer than the latest migration ${latest}`);
  }
  const pending = migrations.filter((m) => m.version > from);
  const dbFile = mainDbFile(db);
  if (pending.length === 0) {
    if (dbFile !== null) clearMigrationAnchor(dbFile);
    return { from, to: from, applied: [] };
  }
  let backupFile: string | undefined;
  let anchorFromVersion: number | undefined;
  if (from > 0 && dbFile !== null) {
    const existingAnchor = readMigrationAnchor(dbFile);
    const plan = planMigrationBackup(dbFile, from, existingAnchor);
    if (plan.action === "reuse") {
      backupFile = plan.backupFile;
      anchorFromVersion = existingAnchor!.fromVersion;
    } else {
      backupFile = backupDatabase(db, from, options.now ?? Date.now);
      if (backupFile !== undefined) {
        anchorFromVersion = from;
        writeMigrationAnchor(dbFile, { fromVersion: from, lastVersion: from, backupFile });
        if (plan.replaceSameVersionBackup !== undefined && plan.replaceSameVersionBackup !== backupFile) {
          try {
            rmSync(plan.replaceSameVersionBackup, { force: true });
          } catch {
          }
        }
      }
    }
  }
  const freeBefore =
    db.get<{ auto_vacuum: number }>("PRAGMA auto_vacuum")?.auto_vacuum === AUTO_VACUUM_INCREMENTAL
      ? freelistCount(db)
      : undefined;
  const applied: number[] = [];
  // A code-built trigger may read tables an older migration rebuilds, and SQLite refuses that rename while the trigger exists.
  dropCodeTriggers(db);
  for (const { version, file, sql } of pending) {
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
    if (dbFile !== null && backupFile !== undefined && anchorFromVersion !== undefined) {
      writeMigrationAnchor(dbFile, { fromVersion: anchorFromVersion, lastVersion: version, backupFile });
    }
  }
  if (dbFile !== null) {
    clearMigrationAnchor(dbFile);
    if (backupFile !== undefined) pruneDatabaseBackups(dbFile, backupFile, MAX_DB_BACKUPS);
  }
  if (freeBefore !== undefined) {
    const addedFree = Math.min(freelistCount(db) - freeBefore, DB_INCREMENTAL_VACUUM_PAGES);
    if (addedFree > 0) db.exec(`PRAGMA incremental_vacuum(${addedFree})`);
  }
  return { from, to: userVersion(db), applied, ...(backupFile !== undefined ? { backupFile } : {}) };
}
