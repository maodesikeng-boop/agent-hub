import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_DB_BACKUPS } from "../../shared/limits.ts";
import { readMigrationAnchor } from "./backup-rotation.ts";
import { openDatabase } from "./db.ts";
import type { Db } from "./db.ts";
import { DEFAULT_MIGRATIONS_DIR, MIGRATION_MANIFEST, loadMigrations, migrate, migrationChecksum, userVersion } from "./migrate.ts";
import { writeMigration, writeMigrationManifest } from "./test-helpers.ts";

let dir: string;
let db: Db | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-hub-migrate-"));
});

afterEach(() => {
  db?.close();
  db = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const tableExists = (d: Db, name: string) => d.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", name) !== undefined;

function releasedMigrations(upTo: number): string {
  const target = join(dir, `release-${upTo}`);
  cpSync(DEFAULT_MIGRATIONS_DIR, target, { recursive: true });
  for (const name of readdirSync(target)) {
    const version = /^(\d+)_.*\.sql$/.exec(name)?.[1];
    if (version !== undefined && Number(version) > upTo) unlinkSync(join(target, name));
  }
  writeMigrationManifest(target);
  return target;
}

describe("migration set integrity", () => {
  it("the repository's migrations match the manifest and are numbered 1 to N without gaps", () => {
    const versions = loadMigrations(DEFAULT_MIGRATIONS_DIR).map((m) => m.version);
    expect(versions).toEqual(versions.map((_, i) => i + 1));
  });

  it("an upgrade missing a middle migration stops before touching the database and applies it once the file is back", () => {
    db = openDatabase(join(dir, "hub.sqlite"));
    expect(migrate(db, releasedMigrations(43)).to).toBe(43);

    const shipped = join(dir, "shipped");
    cpSync(DEFAULT_MIGRATIONS_DIR, shipped, { recursive: true });
    unlinkSync(join(shipped, "0044_capability_scopes.sql"));
    expect(() => migrate(db!, shipped)).toThrow(/0044_capability_scopes\.sql is missing/);
    expect(userVersion(db)).toBe(43);
    expect(tableExists(db, "turn_completions")).toBe(false);
    expect(readdirSync(dir).filter((name) => name.includes(".bak-"))).toEqual([]);

    copyFileSync(join(DEFAULT_MIGRATIONS_DIR, "0044_capability_scopes.sql"), join(shipped, "0044_capability_scopes.sql"));
    const latest = loadMigrations(DEFAULT_MIGRATIONS_DIR).length;
    const result = migrate(db, shipped);
    expect(result).toMatchObject({ from: 43, to: latest, applied: Array.from({ length: latest - 43 }, (_, i) => 44 + i) });
    expect(tableExists(db, "router_capability_policies")).toBe(true);
  });

  const tamperings: { name: string; tamper: (migrations: string) => void; error: RegExp }[] = [
    {
      name: "a file the manifest does not list",
      tamper: (m) => writeFileSync(join(m, "0003_c.sql"), "CREATE TABLE c (x INTEGER);"),
      error: new RegExp(`0003_c\\.sql is not listed in manifest\\.sha256 \\(append "${migrationChecksum(Buffer.from("CREATE TABLE c (x INTEGER);"))}  0003_c\\.sql"\\)`),
    },
    {
      name: "a migration edited after it was listed",
      tamper: (m) => appendFileSync(join(m, "0002_b.sql"), "\nCREATE TABLE extra (x INTEGER);"),
      error: /0002_b\.sql has sha256 [0-9a-f]{64}, but manifest\.sha256 expects [0-9a-f]{64}/,
    },
    {
      name: "two migrations claiming one version",
      tamper: (m) => writeMigration(m, "0002_other.sql", "SELECT 1;"),
      error: /lists 0002_other\.sql where version 3 belongs/,
    },
    {
      name: "a gap in the numbering",
      tamper: (m) => {
        rmSync(join(m, "0002_b.sql"));
        writeMigration(m, "0003_c.sql", "SELECT 1;");
      },
      error: /lists 0003_c\.sql where version 2 belongs/,
    },
    {
      name: "a missing manifest",
      tamper: (m) => unlinkSync(join(m, MIGRATION_MANIFEST)),
      error: /manifest\.sha256 is missing/,
    },
    {
      name: "a malformed manifest line",
      tamper: (m) => appendFileSync(join(m, MIGRATION_MANIFEST), "not a checksum line\n"),
      error: /manifest\.sha256 line 3 is not/,
    },
  ];

  it.each(tamperings)("refuses $name and applies nothing", ({ tamper, error }) => {
    const migrations = join(dir, "migrations");
    writeMigration(migrations, "0001_a.sql", "CREATE TABLE a (x INTEGER);");
    writeMigration(migrations, "0002_b.sql", "CREATE TABLE b (x INTEGER);");
    tamper(migrations);
    db = openDatabase(":memory:");
    expect(() => migrate(db!, migrations)).toThrow(error);
    expect(userVersion(db)).toBe(0);
    expect(tableExists(db, "a")).toBe(false);
  });
});

describe("pre-upgrade backup preservation across repeated migration failures", () => {
  it("preserves the pre-upgrade rollback backup across three consecutive restarts after a partial migration commit and prunes only after recovery", () => {
    const dbFile = join(dir, "hub.sqlite");
    const migV1 = join(dir, "mig-v1");
    writeMigration(migV1, "0001_init.sql", "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);");
    db = openDatabase(dbFile);
    migrate(db, migV1);
    db.run("INSERT INTO items (name) VALUES ('before-upgrade')");

    const migBroken = join(dir, "mig-broken");
    writeMigration(migBroken, "0001_init.sql", "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);");
    writeMigration(migBroken, "0002_step1.sql", "CREATE TABLE step1 (id INTEGER PRIMARY KEY);");
    writeMigration(migBroken, "0003_step2.sql", "CREATE TABLE items (dup INTEGER);");

    let clock = Date.UTC(2026, 10, 28, 8, 0, 0);
    const tick = () => (clock += 60_000);

    // Attempt 1 backs up v1, commits 0002 (user_version = 2), and fails on 0003.
    expect(() => migrate(db!, migBroken, { now: tick })).toThrow(/0003_step2\.sql/);
    expect(userVersion(db)).toBe(2);

    // Three consecutive restarts while 0003 keeps failing must keep the v1 rollback backup and create zero intermediate v2 backups.
    for (let attempt = 0; attempt < 3; attempt++) {
      db.close();
      const reopened = openDatabase(dbFile);
      db = reopened;
      expect(() => migrate(reopened, migBroken, { now: tick })).toThrow(/0003_step2\.sql/);
      expect(userVersion(reopened)).toBe(2);
      const backups = readdirSync(dir).filter((name) => name.startsWith("hub.sqlite.bak-"));
      expect(backups).toHaveLength(1);
      expect(backups[0]).toMatch(/^hub\.sqlite\.bak-1-/);
    }

    const rollbackBackup = readdirSync(dir).find((name) => name.startsWith("hub.sqlite.bak-1-"))!;
    const openedBackup = openDatabase(join(dir, rollbackBackup));
    try {
      expect(userVersion(openedBackup)).toBe(1);
      expect(openedBackup.all<{ name: string }>("SELECT name FROM items")).toEqual([{ name: "before-upgrade" }]);
    } finally {
      openedBackup.close();
    }

    // Once 0003 is fixed, migration finishes and preserves the v1 rollback backup.
    writeMigration(migBroken, "0003_step2.sql", "CREATE TABLE step2 (id INTEGER PRIMARY KEY);");
    db.close();
    db = openDatabase(dbFile);
    const recovered = migrate(db, migBroken, { now: tick });
    expect(recovered.to).toBe(3);
    expect(recovered.backupFile).toBe(join(dir, rollbackBackup));
    expect(readdirSync(dir).filter((name) => name.startsWith("hub.sqlite.bak-"))).toEqual([rollbackBackup]);
  });

  it("keeps the original rollback backup across multi-step partial progress and keeps disk bounded on first-migration crash loops", () => {
    const dbFile = join(dir, "hub.sqlite");
    const migV1 = join(dir, "mig-v1");
    writeMigration(migV1, "0001_init.sql", "CREATE TABLE t1 (id INTEGER PRIMARY KEY);");
    db = openDatabase(dbFile);
    migrate(db, migV1);

    // First upgrade v1 -> v2 succeeds to seed an older bak-1 backup.
    const migV2 = join(dir, "mig-v2");
    writeMigration(migV2, "0001_init.sql", "CREATE TABLE t1 (id INTEGER PRIMARY KEY);");
    writeMigration(migV2, "0002_v2.sql", "CREATE TABLE t2 (id INTEGER PRIMARY KEY);");
    let clock = Date.UTC(2026, 10, 28, 9, 0, 0);
    const tick = () => (clock += 60_000);
    migrate(db, migV2, { now: tick });

    // Crash loop failing on the very first pending migration (0003) keeps bak-1 intact and caps bak-2 to one file.
    const migFailFirst = join(dir, "mig-fail-first");
    writeMigration(migFailFirst, "0001_init.sql", "CREATE TABLE t1 (id INTEGER PRIMARY KEY);");
    writeMigration(migFailFirst, "0002_v2.sql", "CREATE TABLE t2 (id INTEGER PRIMARY KEY);");
    writeMigration(migFailFirst, "0003_v3.sql", "CREATE TABLE t1 (dup INTEGER);");
    for (let i = 0; i < 3; i++) {
      expect(() => migrate(db!, migFailFirst, { now: tick })).toThrow(/0003_v3\.sql/);
    }
    const afterLoop = readdirSync(dir).filter((name) => name.startsWith("hub.sqlite.bak-")).sort();
    expect(afterLoop.filter((n) => n.startsWith("hub.sqlite.bak-1-"))).toHaveLength(1);
    expect(afterLoop.filter((n) => n.startsWith("hub.sqlite.bak-2-"))).toHaveLength(1);

    // Multi-step partial progress: 0003 commits while 0004 fails, then 0004 commits while 0005 fails, then 0005 succeeds.
    writeMigration(migFailFirst, "0003_v3.sql", "CREATE TABLE t3 (id INTEGER PRIMARY KEY);");
    writeMigration(migFailFirst, "0004_v4.sql", "CREATE TABLE t1 (dup INTEGER);");
    writeMigration(migFailFirst, "0005_v5.sql", "CREATE TABLE t1 (dup INTEGER);");
    expect(() => migrate(db!, migFailFirst, { now: tick })).toThrow(/0004_v4\.sql/);
    expect(userVersion(db)).toBe(3);

    writeMigration(migFailFirst, "0004_v4.sql", "CREATE TABLE t4 (id INTEGER PRIMARY KEY);");
    expect(() => migrate(db!, migFailFirst, { now: tick })).toThrow(/0005_v5\.sql/);
    expect(userVersion(db)).toBe(4);

    writeMigration(migFailFirst, "0005_v5.sql", "CREATE TABLE t5 (id INTEGER PRIMARY KEY);");
    expect(migrate(db!, migFailFirst, { now: tick }).to).toBe(5);
    const finalBackups = readdirSync(dir).filter((name) => name.startsWith("hub.sqlite.bak-")).sort();
    expect(finalBackups.some((n) => n.startsWith("hub.sqlite.bak-2-"))).toBe(true);
    expect(finalBackups.some((n) => n.startsWith("hub.sqlite.bak-3-") || n.startsWith("hub.sqlite.bak-4-"))).toBe(false);
  });

  it("preserves the pre-upgrade rollback backup across subprocess crashes immediately after SQLite COMMIT before anchor advance", () => {
    const dbFile = join(dir, "hub.sqlite");
    const migV1 = join(dir, "mig-v1");
    writeMigration(migV1, "0001_init.sql", "CREATE TABLE seed (name TEXT NOT NULL);");
    db = openDatabase(dbFile);
    migrate(db, migV1);
    db.run("INSERT INTO seed (name) VALUES ('pre-upgrade-data')");
    db.close();
    db = undefined;

    const migV4 = join(dir, "mig-v4");
    writeMigration(migV4, "0001_init.sql", "CREATE TABLE seed (name TEXT NOT NULL);");
    writeMigration(migV4, "0002_step2.sql", "CREATE TABLE step2 (id INTEGER PRIMARY KEY);");
    writeMigration(migV4, "0003_step3.sql", "CREATE TABLE step3 (id INTEGER PRIMARY KEY);");
    writeMigration(migV4, "0004_step4.sql", "CREATE TABLE step4 (id INTEGER PRIMARY KEY);");

    const dbModuleUrl = new URL("./db.ts", import.meta.url).href;
    const migrateModuleUrl = new URL("./migrate.ts", import.meta.url).href;
    const crashScript = [
      `const { openDatabase } = await import(${JSON.stringify(dbModuleUrl)});`,
      `const { migrate } = await import(${JSON.stringify(migrateModuleUrl)});`,
      `const [dbPath, migrationsDir, tick] = process.argv.slice(1);`,
      `const d = openDatabase(dbPath);`,
      `const origTx = d.transaction.bind(d);`,
      `d.transaction = (fn) => { const out = origTx(fn); process.exit(77); return out; };`,
      `migrate(d, migrationsDir, { now: () => Number(tick) });`,
      `process.exit(78);`,
    ].join("\n");

    let clock = Date.UTC(2026, 10, 28, 10, 0, 0);
    const tick = () => (clock += 60_000);

    // Two consecutive crashes right after COMMIT (v1->v2, then v2->v3) before post-commit anchor write.
    for (const expectedVersion of [2, 3]) {
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", crashScript, dbFile, migV4, String(tick())], {
        encoding: "utf8",
      });
      expect(child.status, child.stderr).toBe(77);
      const checkDb = openDatabase(dbFile);
      try {
        expect(userVersion(checkDb)).toBe(expectedVersion);
      } finally {
        checkDb.close();
      }
      const backups = readdirSync(dir).filter((name) => name.startsWith("hub.sqlite.bak-"));
      expect(backups).toHaveLength(1);
      expect(backups[0]).toMatch(/^hub\.sqlite\.bak-1-/);
    }

    // Final recovery completes v3->v4 while preserving the v1 rollback backup with original pre-upgrade data.
    db = openDatabase(dbFile);
    const result = migrate(db, migV4, { now: tick });
    expect(result.to).toBe(4);
    const finalBackups = readdirSync(dir).filter((name) => name.startsWith("hub.sqlite.bak-"));
    expect(finalBackups).toHaveLength(1);
    expect(finalBackups[0]).toMatch(/^hub\.sqlite\.bak-1-/);

    const rollback = openDatabase(join(dir, finalBackups[0]!));
    try {
      expect(userVersion(rollback)).toBe(1);
      expect(rollback.all<{ name: string }>("SELECT name FROM seed")).toEqual([{ name: "pre-upgrade-data" }]);
    } finally {
      rollback.close();
    }
  });

  it("creates a fresh backup capturing post-restore writes after a manual rollback from a failed migration", () => {
    const dbFile = join(dir, "hub.sqlite");
    const migV1 = join(dir, "mig-v1-restore");
    writeMigration(migV1, "0001_init.sql", "CREATE TABLE items (name TEXT NOT NULL);");
    db = openDatabase(dbFile);
    migrate(db, migV1);
    db.run("INSERT INTO items (name) VALUES ('original')");

    const migBroken = join(dir, "mig-broken-restore");
    writeMigration(migBroken, "0001_init.sql", "CREATE TABLE items (name TEXT NOT NULL);");
    writeMigration(migBroken, "0002_step2.sql", "CREATE TABLE step2 (id INTEGER PRIMARY KEY);");
    writeMigration(migBroken, "0003_fail.sql", "CREATE TABLE items (dup INTEGER);");

    let clock = Date.UTC(2026, 10, 28, 11, 0, 0);
    const tick = () => (clock += 60_000);
    expect(() => migrate(db!, migBroken, { now: tick })).toThrow(/0003_fail\.sql/);
    expect(userVersion(db)).toBe(2);
    const originalBackup = readdirSync(dir).find((name) => name.startsWith("hub.sqlite.bak-1-"))!;
    db.close();
    db = undefined;

    // Manually restore v1 backup over hub.sqlite (and clear WAL sidecars), then write new v1 data.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbFile}${suffix}`, { force: true });
    copyFileSync(join(dir, originalBackup), dbFile);
    db = openDatabase(dbFile);
    expect(userVersion(db)).toBe(1);
    db.run("INSERT INTO items (name) VALUES ('post-restore-write')");

    // Retry upgrade against fixed migrations: must take a fresh backup that includes post-restore writes.
    writeMigration(migBroken, "0003_fail.sql", "CREATE TABLE step3 (id INTEGER PRIMARY KEY);");
    const recovered = migrate(db, migBroken, { now: tick });
    expect(recovered.to).toBe(3);
    expect(recovered.backupFile).toBeDefined();
    expect(recovered.backupFile).not.toBe(join(dir, originalBackup));

    const freshBackup = openDatabase(recovered.backupFile!);
    try {
      expect(userVersion(freshBackup)).toBe(1);
      expect(freshBackup.all<{ name: string }>("SELECT name FROM items ORDER BY rowid")).toEqual([
        { name: "original" },
        { name: "post-restore-write" },
      ]);
    } finally {
      freshBackup.close();
    }
  });

  it("bounds same-version backups and preserves older rollback backups across 5 subprocess crashes right after VACUUM INTO before anchor write", () => {
    const dbFile = join(dir, "hub.sqlite");
    const migV1 = join(dir, "mig-v1-pre-anchor");
    writeMigration(migV1, "0001_init.sql", "CREATE TABLE seed (name TEXT NOT NULL);");
    db = openDatabase(dbFile);
    migrate(db, migV1);
    db.run("INSERT INTO seed (name) VALUES ('pre-upgrade-data')");
    db.close();
    db = undefined;

    // Seed an older rollback backup that must never be evicted across crash-looping restarts.
    writeFileSync(join(dir, "hub.sqlite.bak-0-20251128T000000Z"), "v0-rollback");

    const migV4 = join(dir, "mig-v4-pre-anchor");
    writeMigration(migV4, "0001_init.sql", "CREATE TABLE seed (name TEXT NOT NULL);");
    writeMigration(migV4, "0002_step2.sql", "CREATE TABLE step2 (id INTEGER PRIMARY KEY);");
    writeMigration(migV4, "0003_step3.sql", "CREATE TABLE step3 (id INTEGER PRIMARY KEY);");
    writeMigration(migV4, "0004_step4.sql", "CREATE TABLE step4 (id INTEGER PRIMARY KEY);");

    const dbModuleUrl = new URL("./db.ts", import.meta.url).href;
    const migrateModuleUrl = new URL("./migrate.ts", import.meta.url).href;
    const crashScript = [
      `const { openDatabase } = await import(${JSON.stringify(dbModuleUrl)});`,
      `const { migrate } = await import(${JSON.stringify(migrateModuleUrl)});`,
      `const [dbPath, migrationsDir, tick] = process.argv.slice(1);`,
      `const d = openDatabase(dbPath);`,
      `const origRun = d.run.bind(d);`,
      `d.run = (sql, ...params) => { const out = origRun(sql, ...params); if (sql === "VACUUM INTO ?") process.exit(77); return out; };`,
      `migrate(d, migrationsDir, { now: () => Number(tick) });`,
      `process.exit(78);`,
    ].join("\n");

    let clock = Date.UTC(2026, 10, 28, 12, 0, 0);
    const tick = () => (clock += 60_000);

    for (let attempt = 0; attempt < 5; attempt++) {
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", crashScript, dbFile, migV4, String(tick())], {
        encoding: "utf8",
      });
      expect(child.status, child.stderr).toBe(77);
      const checkDb = openDatabase(dbFile);
      try {
        expect(userVersion(checkDb)).toBe(1);
      } finally {
        checkDb.close();
      }
      expect(readMigrationAnchor(dbFile)).toBeNull();
      const entries = readdirSync(dir);
      const backups = entries.filter((name) => name.startsWith("hub.sqlite.bak-")).sort();
      const staging = entries.filter((name) => name.startsWith("hub.sqlite.backup"));
      expect(backups.filter((n) => n.startsWith("hub.sqlite.bak-0-"))).toHaveLength(1);
      expect(backups.filter((n) => n.startsWith("hub.sqlite.bak-1-")).length).toBeLessThanOrEqual(1);
      expect(backups.length).toBeLessThanOrEqual(MAX_DB_BACKUPS + 1);
      expect(staging.length).toBeLessThanOrEqual(1);
    }

    // Recovery finishes cleanly, removes any staging file, and preserves the v1 rollback backup.
    db = openDatabase(dbFile);
    const result = migrate(db, migV4, { now: tick });
    expect(result.to).toBe(4);
    const finalEntries = readdirSync(dir);
    expect(finalEntries.filter((name) => name.startsWith("hub.sqlite.backup"))).toEqual([]);
    const finalBackups = finalEntries.filter((name) => name.startsWith("hub.sqlite.bak-")).sort();
    expect(finalBackups.length).toBeLessThanOrEqual(MAX_DB_BACKUPS);
    const v1Bak = finalBackups.find((n) => n.startsWith("hub.sqlite.bak-1-"));
    expect(v1Bak).toBeDefined();
    const rollback = openDatabase(join(dir, v1Bak!));
    try {
      expect(userVersion(rollback)).toBe(1);
      expect(rollback.all<{ name: string }>("SELECT name FROM seed")).toEqual([{ name: "pre-upgrade-data" }]);
    } finally {
      rollback.close();
    }
  });
});
