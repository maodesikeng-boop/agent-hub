import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_TMP_DIR_PREFIX, SESSION_TMP_ORPHAN_RETENTION_MS } from "../shared/limits.ts";
import { createSessionTmpStore, shortOsTmpRoot } from "./session-tmp.ts";

let root: string;
let ledgerFile: string;
let tmpRoot: string;

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "session-tmp-test-")));
  ledgerFile = join(root, "state", "session-tmp.json");
  tmpRoot = join(root, "tmp");
  mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("SessionTmpStore", () => {
  it("returns a realpath-resolved short temp root fitting macOS Unix socket path limits", () => {
    const posixLong = shortOsTmpRoot({
      platform: "darwin",
      osTmpDir: "/var/folders/xx/very_long_macos_per_user_temp_directory_name/T",
    });
    if (existsSync("/tmp")) {
      expect(Buffer.byteLength(posixLong)).toBeLessThanOrEqual(40);
    }
    const winRoot = shortOsTmpRoot({ platform: "win32", osTmpDir: tmpRoot });
    expect(winRoot).toBe(realpathSync.native(tmpRoot));
  });

  it("creates a 0700 SESSION_TMP_DIR_PREFIX directory on allocate and persists it in state/session-tmp.json", () => {
    const store = createSessionTmpStore({ ledgerFile, tmpRoot, now: () => 1_000 });
    const allocated = store.allocate(42);
    expect(existsSync(allocated)).toBe(true);
    expect(basename(allocated).startsWith(SESSION_TMP_DIR_PREFIX)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(allocated).mode & 0o777).toBe(0o700);
    }
    expect(store.get(42)).toBe(allocated);
    const persisted = JSON.parse(readFileSync(ledgerFile, "utf8")) as { entries: Array<{ sessionId: number; path: string }> };
    expect(persisted.entries).toEqual([{ sessionId: 42, path: allocated, createdAt: 1_000 }]);
  });

  it("reuses an existing tracked directory when allocate is called twice for the same session", () => {
    const store = createSessionTmpStore({ ledgerFile, tmpRoot, now: () => 2_000 });
    const first = store.allocate(7);
    writeFileSync(join(first, "marker.txt"), "ok");
    const second = store.allocate(7);
    expect(second).toBe(first);
    expect(existsSync(join(second, "marker.txt"))).toBe(true);
    expect(store.listTracked()).toHaveLength(1);
  });

  it("removes the tracked directory and ledger entry on remove and succeeds when already absent", async () => {
    const store = createSessionTmpStore({ ledgerFile, tmpRoot, now: () => 3_000 });
    const dir = store.allocate(9);
    writeFileSync(join(dir, "temp.bin"), "payload");
    expect(await store.remove(9)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(store.get(9)).toBeNull();
    expect(store.listTracked()).toEqual([]);

    // Removing a tracked entry whose directory was already deleted still cleans the ledger.
    const dir2 = store.allocate(10);
    rmSync(dir2, { recursive: true, force: true });
    expect(await store.remove(10)).toBe(true);
    expect(store.get(10)).toBeNull();
    expect(await store.remove(999)).toBe(false);
  });

  it("sweeps tracked directories for non-active sessions and stale orphaned prefix directories while keeping active sessions untouched", async () => {
    const nowMs = 10_000_000;
    const store = createSessionTmpStore({ ledgerFile, tmpRoot, now: () => nowMs });
    const activeDir = store.allocate(1);
    const deadDir = store.allocate(2);

    // Unmanaged stale orphan (older than SESSION_TMP_ORPHAN_RETENTION_MS) and fresh unmanaged dir.
    const staleOrphan = join(tmpRoot, `${SESSION_TMP_DIR_PREFIX}stale-orphan`);
    const freshOrphan = join(tmpRoot, `${SESSION_TMP_DIR_PREFIX}fresh-orphan`);
    const unrelatedDir = join(tmpRoot, "other-tool-dir");
    for (const d of [staleOrphan, freshOrphan, unrelatedDir]) mkdirSync(d, { recursive: true });
    const oldTime = new Date(nowMs - SESSION_TMP_ORPHAN_RETENTION_MS - 10_000);
    const freshTime = new Date(nowMs - 5_000);
    utimesSync(staleOrphan, oldTime, oldTime);
    utimesSync(freshOrphan, freshTime, freshTime);
    utimesSync(unrelatedDir, oldTime, oldTime);

    const res = await store.sweepOrphans(new Set([1]));
    expect(res.failedPaths).toEqual([]);
    expect(res.removedPaths).toContain(deadDir);
    expect(res.removedPaths).toContain(staleOrphan);
    expect(existsSync(activeDir)).toBe(true);
    expect(existsSync(deadDir)).toBe(false);
    expect(existsSync(staleOrphan)).toBe(false);
    expect(existsSync(freshOrphan)).toBe(true);
    expect(existsSync(unrelatedDir)).toBe(true);
    expect(store.listTracked().map((e) => e.sessionId)).toEqual([1]);
  });
});
