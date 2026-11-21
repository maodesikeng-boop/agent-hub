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
