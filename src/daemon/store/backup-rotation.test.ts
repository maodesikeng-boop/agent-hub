import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearMigrationAnchor,
  migrationAnchorPath,
  planMigrationBackup,
  pruneDatabaseBackups,
  pruneSameVersionBackups,
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

  it.skipIf(process.platform === "win32")("normalizes symlinked parent directories for anchor validation and pruning while rejecting symlinked backup files", () => {
    const realDir = join(dir, "real-state");
    const linkDir = join(dir, "link-state");
    mkdirSync(realDir);
    symlinkSync(realDir, linkDir);

    const realDb = join(realpathSync.native(realDir), "hub.sqlite");
    const linkDb = join(linkDir, "hub.sqlite");
    writeFileSync(realDb, "");

    const realBak10 = join(realpathSync.native(realDir), "hub.sqlite.bak-10-20261128T080000Z");
    const realBak11 = join(realpathSync.native(realDir), "hub.sqlite.bak-11-20261128T080100Z");
    const realBak12 = join(realpathSync.native(realDir), "hub.sqlite.bak-12-20261128T080200Z");
    for (const f of [realBak10, realBak11, realBak12]) writeFileSync(f, "data");

    // Anchor written with realpath is valid when read via the symlinked directory path.
    writeMigrationAnchor(realDb, { fromVersion: 10, lastVersion: 11, backupFile: realBak10 });
    const readViaLink = readMigrationAnchor(linkDb);
    expect(readViaLink).toEqual({
      fromVersion: 10,
      lastVersion: 11,
      backupFile: join(linkDir, "hub.sqlite.bak-10-20261128T080000Z"),
    });

    // Pruning via symlinked db path protects keep passed as realpath.
    pruneDatabaseBackups(linkDb, realBak10, 2);
    expect(readdirSync(realDir).filter((f) => f.includes(".bak-")).sort()).toEqual([
      "hub.sqlite.bak-10-20261128T080000Z",
      "hub.sqlite.bak-12-20261128T080200Z",
    ]);

    // A symlinked backup file inside the db directory pointing outside is rejected.
    const outside = join(dir, "outside.sqlite");
    writeFileSync(outside, "outside");
    const escapedLink = join(realDir, "hub.sqlite.bak-13-20261128T080300Z");
    symlinkSync(outside, escapedLink);
    writeMigrationAnchor(realDb, { fromVersion: 13, lastVersion: 14, backupFile: escapedLink });
    expect(readMigrationAnchor(realDb)).toBeNull();
  });

  it("reuses the anchor backup when db version matches pendingVersion and prunes only duplicate same-version backups", () => {
    const bak10 = join(dir, "hub.sqlite.bak-10-20261128T080000Z");
    const bak11Old = join(dir, "hub.sqlite.bak-11-20261128T080100Z");
    const bak11New = join(dir, "hub.sqlite.bak-11-20261128T080200Z");
    for (const f of [bak10, bak11Old, bak11New]) writeFileSync(f, "data");

    writeMigrationAnchor(dbFile, { fromVersion: 10, lastVersion: 10, pendingVersion: 11, backupFile: bak10 });
    expect(readMigrationAnchor(dbFile)).toEqual({ fromVersion: 10, lastVersion: 10, pendingVersion: 11, backupFile: bak10 });
    expect(planMigrationBackup(dbFile, 11, readMigrationAnchor(dbFile))).toEqual({ action: "reuse", backupFile: bak10 });
    expect(planMigrationBackup(dbFile, 12, readMigrationAnchor(dbFile))).toEqual({ action: "create" });

    // Invalid pendingVersion <= lastVersion is rejected as corrupt.
    writeFileSync(
      migrationAnchorPath(dbFile),
      JSON.stringify({ fromVersion: 10, lastVersion: 11, pendingVersion: 11, backupFile: bak10 }),
    );
    expect(readMigrationAnchor(dbFile)).toBeNull();

    // pruneSameVersionBackups removes older duplicates of version 11 while leaving version 10 untouched.
    pruneSameVersionBackups(dbFile, 11, bak11New);
    expect(readdirSync(dir).filter((f) => f.includes(".bak-")).sort()).toEqual([
      "hub.sqlite.bak-10-20261128T080000Z",
      "hub.sqlite.bak-11-20261128T080200Z",
    ]);
  });
});
