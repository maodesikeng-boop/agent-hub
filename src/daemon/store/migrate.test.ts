import { appendFileSync, copyFileSync, cpSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
