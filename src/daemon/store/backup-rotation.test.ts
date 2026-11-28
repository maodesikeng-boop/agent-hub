import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearMigrationAnchor,
  migrationAnchorPath,
  planMigrationBackup,
  pruneDatabaseBackups,
  readMigrationAnchor,
  writeMigrationAnchor,
} from "./backup-rotation.ts";

let dir: string;
let dbFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-hub-backup-rotation-"));
  dbFile = join(dir, "hub.sqlite");
  writeFileSync(dbFile, "");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("migration backup rotation contracts", () => {
  it("persists, reads, and clears a validated migration backup anchor", () => {
    const bak = join(dir, "hub.sqlite.bak-10-20261128T080000Z");
    writeFileSync(bak, "v10");

    expect(readMigrationAnchor(dbFile)).toBeNull();
    writeMigrationAnchor(dbFile, { fromVersion: 10, lastVersion: 11, backupFile: bak });
    expect(existsSync(migrationAnchorPath(dbFile))).toBe(true);
    expect(readMigrationAnchor(dbFile)).toEqual({ fromVersion: 10, lastVersion: 11, backupFile: bak });

    clearMigrationAnchor(dbFile);
    expect(existsSync(migrationAnchorPath(dbFile))).toBe(false);
    expect(readMigrationAnchor(dbFile)).toBeNull();
  });

  it("ignores corrupt JSON and path-escaping anchor files", () => {
    writeFileSync(migrationAnchorPath(dbFile), "{truncated");
    expect(readMigrationAnchor(dbFile)).toBeNull();

    writeFileSync(
      migrationAnchorPath(dbFile),
      JSON.stringify({ fromVersion: 10, lastVersion: 11, backupFile: join(dir, "..", "outside.sqlite") }),
    );
    expect(readMigrationAnchor(dbFile)).toBeNull();

    writeFileSync(
      migrationAnchorPath(dbFile),
      JSON.stringify({ fromVersion: 10, lastVersion: 11, backupFile: join(dir, "hub.sqlite.bak-notes") }),
    );
    expect(readMigrationAnchor(dbFile)).toBeNull();
  });

  it("reuses the anchor backup on mid-upgrade retries and replaces only the same-version backup on first-migration retries", () => {
    const bak10 = join(dir, "hub.sqlite.bak-10-20261128T080000Z");
    writeFileSync(bak10, "v10");

    expect(planMigrationBackup(dbFile, 10, null)).toEqual({ action: "create" });
    expect(planMigrationBackup(dbFile, 11, { fromVersion: 10, lastVersion: 11, backupFile: bak10 })).toEqual({
      action: "reuse",
      backupFile: bak10,
    });
    expect(planMigrationBackup(dbFile, 10, { fromVersion: 10, lastVersion: 10, backupFile: bak10 })).toEqual({
      action: "create",
      replaceSameVersionBackup: bak10,
    });
    // Manual restore to v10 after a v11 failure triggers a fresh backup without deleting the old one prematurely.
    expect(planMigrationBackup(dbFile, 10, { fromVersion: 10, lastVersion: 11, backupFile: bak10 })).toEqual({
      action: "create",
    });
    // Missing anchor backup file falls back to creating a fresh backup.
    rmSync(bak10);
    expect(planMigrationBackup(dbFile, 11, { fromVersion: 10, lastVersion: 11, backupFile: bak10 })).toEqual({
      action: "create",
    });
  });

  it("evicts duplicate backups of the same source version before evicting older distinct versions", () => {
    const b10 = join(dir, "hub.sqlite.bak-10-20261128T080000Z");
    const b11a = join(dir, "hub.sqlite.bak-11-20261128T080100Z");
    const b11b = join(dir, "hub.sqlite.bak-11-20261128T080200Z");
    const notes = join(dir, "hub.sqlite.bak-notes");
    for (const f of [b10, b11a, b11b, notes]) writeFileSync(f, "data");

    pruneDatabaseBackups(dbFile, b11b, 2);

    expect(readdirSync(dir).filter((f) => f.includes(".bak-")).sort()).toEqual([
      "hub.sqlite.bak-10-20261128T080000Z",
      "hub.sqlite.bak-11-20261128T080200Z",
      "hub.sqlite.bak-notes",
    ]);
  });
});
