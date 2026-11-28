import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_DB_BACKUPS } from "../../shared/limits.ts";
import { backupStagingPath, readMigrationAnchor, writeMigrationAnchor } from "./backup-rotation.ts";
import { openDatabase } from "./db.ts";
import { ensureIncrementalVacuum } from "./maintenance.ts";
import { migrate } from "./migrate.ts";
import { writeMigration } from "./test-helpers.ts";

const modules = Object.fromEntries(["db", "maintenance", "migrate"].map((name) => [name, new URL(`${name}.ts`, import.meta.url).href]));
const subprocess = `
  import fs from "node:fs";
  import { syncBuiltinESMExports } from "node:module";
  const [operation, phase, file, migrations, time] = process.argv.slice(1);
  const { openDatabase } = await import(${JSON.stringify(modules.db)});
  const { ensureIncrementalVacuum } = await import(${JSON.stringify(modules.maintenance)});
  const { migrate } = await import(${JSON.stringify(modules.migrate)});
  const db = openDatabase(file);
  const run = db.run.bind(db);
  db.run = (sql, ...args) => {
    const result = run(sql, ...args);
    if (phase === "staged" && sql === "VACUUM INTO ?") process.exit(77);
    return result;
  };
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (source === file + ".backup-tmp" && phase === "failed") {
      throw Object.assign(new Error("injected backup rename failure"), { code: "EIO" });
    }
    rename(source, target);
    if (source === file + ".backup-tmp" && phase === "published") process.exit(77);
  };
  syncBuiltinESMExports();
  const now = () => Number(time);
  try {
    const result = operation === "migration" ? migrate(db, migrations, { now }) : ensureIncrementalVacuum(db, { now });
    if (result.error) throw new Error(result.error);
  } finally {
    db.close();
  }
`;

let dir: string;
let file: string;
let migrations: string;
let time: number;

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-backup-publication-")));
  file = join(dir, "hub.sqlite");
  migrations = join(dir, "migrations");
  time = Date.UTC(2026, 10, 28);
  writeMigration(migrations, "0001_seed.sql", "CREATE TABLE payload (value TEXT NOT NULL);");
  for (const version of [2, 3, 4]) writeMigration(migrations, `000${version}_step.sql`, "SELECT 1;");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seed(path: string, version: number, row: string): void {
  using db = new DatabaseSync(path);
  db.exec(`CREATE TABLE payload (value TEXT NOT NULL); PRAGMA user_version = ${version};`);
  db.prepare("INSERT INTO payload VALUES (?)").run(row);
}

function readSnapshot(path: string): unknown[] {
  using db = new DatabaseSync(path, { readOnly: true });
  return [db.prepare("PRAGMA user_version").get()?.user_version, db.prepare("SELECT value FROM payload").get()?.value];
}

function runChild(operation: string, phase: string) {
  time += 60_000;
  return spawnSync(process.execPath, ["--input-type=module", "-e", subprocess, operation, phase, file, migrations, String(time)], { encoding: "utf8" });
}

function backupNames(): string[] {
  return readdirSync(dir).filter((name) => name.startsWith("hub.sqlite.bak-")).sort();
}

for (const operation of ["migration", "maintenance"] as const) {
  describe(`${operation} backup publication`, () => {
    it("keeps a readable same-version rollback and any migration anchor when publish fails", () => {
      const prior = `${file}.bak-1-20251128T000000Z`;
      seed(file, 1, "latest");
      seed(prior, 1, "prior restore point");
      const anchor = { fromVersion: 1, lastVersion: 1, backupFile: prior };
      if (operation === "migration") writeMigrationAnchor(file, anchor);

      const failed = runChild(operation, "failed");
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("injected backup rename failure");
      expect(backupNames()).toEqual(["hub.sqlite.bak-1-20251128T000000Z"]);
      expect(readSnapshot(prior)).toEqual([1, "prior restore point"]);
      expect(readSnapshot(file)).toEqual([1, "latest"]);
      expect(readMigrationAnchor(file)).toEqual(operation === "migration" ? anchor : null);
      expect(existsSync(backupStagingPath(file))).toBe(false);
    });

    it("fits two historical backups and a new snapshot across alternating crash windows", () => {
      seed(file, 3, "latest");
      for (const version of [1, 2]) seed(`${file}.bak-${version}-20251128T000000Z`, version, `rollback v${version}`);

      for (const phase of ["staged", "published", "staged", "published", "staged"]) {
        const crashed = runChild(operation, phase);
        expect(crashed.status, crashed.stderr).toBe(77);
        const published = backupNames();
        const staging = backupStagingPath(file);
        const staged = existsSync(staging);
        expect(staged).toBe(phase === "staged");
        expect(published.length + Number(staged), phase).toBeLessThanOrEqual(MAX_DB_BACKUPS + 1);
        for (const version of [1, 2]) {
          const name = `hub.sqlite.bak-${version}-20251128T000000Z`;
          expect(published).toContain(name);
          expect(readSnapshot(join(dir, name))).toEqual([version, `rollback v${version}`]);
        }
        const newest = phase === "staged" ? staging : join(dir, published.at(-1)!);
        expect(readSnapshot(newest)).toEqual([3, "latest"]);
      }

      const db = openDatabase(file);
      try {
        const result = operation === "migration" ? migrate(db, migrations, { now: () => time }) : ensureIncrementalVacuum(db, { now: () => time });
        expect(result).toMatchObject(operation === "migration" ? { to: 4 } : { converted: true });
        expect(readSnapshot(result.backupFile!)).toEqual([3, "latest"]);
      } finally {
        db.close();
      }
      expect(backupNames().map((name) => Number(/\.bak-(\d+)-/.exec(name)?.[1]))).toEqual([2, 3]);
      expect(existsSync(backupStagingPath(file))).toBe(false);
    });
  });
}
