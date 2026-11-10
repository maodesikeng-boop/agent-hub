// 数据库空间维护（maintenance.ts）：老库重建成增量回收模式（先备份）、新库本来就是、空闲页分批还给文件系统。
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./db.ts";
import type { Db } from "./db.ts";
import { autoVacuumMode, ensureIncrementalVacuum, freePages, reclaimFreePages } from "./maintenance.ts";
import { migrate } from "./migrate.ts";
import { openStore } from "./open.ts";

let dir: string;
let file: string;
let db: Db | undefined;

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-maintenance-")));
  file = join(dir, "hub.sqlite");
});

afterEach(() => {
  db?.close();
  db = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** 造一个 auto_vacuum = NONE 的老库（不经过 openDatabase，它会把新库设成增量回收）。 */
function legacyDb(): void {
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("CREATE TABLE blob_rows (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  const insert = raw.prepare("INSERT INTO blob_rows (body) VALUES (?)");
  for (let i = 0; i < 400; i++) insert.run("x".repeat(4_000));
  raw.exec("PRAGMA user_version = 3");
  expect(raw.prepare("PRAGMA auto_vacuum").get()).toMatchObject({ auto_vacuum: 0 });
  raw.close();
}

/** 只有 0001…<n> 的迁移目录（内容是空表），让 legacyDb（版本 3）按需“有 / 没有”迁移要跑。 */
function migrationsUpTo(version: number): string {
  const migrationsDir = join(dir, "migrations");
  mkdirSync(migrationsDir, { recursive: true });
  for (let v = 1; v <= version; v++) writeFileSync(join(migrationsDir, `${String(v).padStart(4, "0")}_t${v}.sql`), v <= 3 ? "SELECT 1;" : `CREATE TABLE extra${v} (id INTEGER PRIMARY KEY);`);
  return migrationsDir;
}

const pagesOf = (d: Db) => Number(Object.values(d.get<Record<string, unknown>>("PRAGMA page_count")!)[0]);

describe("auto_vacuum 模式", () => {
  it("新库一开始就是 INCREMENTAL：不用重建、不备份", () => {
    db = openDatabase(file);
    migrate(db);
    expect(autoVacuumMode(db)).toBe(2);
    expect(ensureIncrementalVacuum(db)).toEqual({ converted: false });
    expect(readdirSync(dir).filter((n) => n.includes(".bak-"))).toEqual([]);
  });

  it("老库（NONE）：先备份、再重建成 INCREMENTAL，数据一行不少，再调一次什么都不做", () => {
    legacyDb();
    db = openDatabase(file);
    expect(autoVacuumMode(db)).toBe(0);
    const result = ensureIncrementalVacuum(db, { now: () => Date.UTC(2026, 10, 10, 8, 0, 0) });
    expect(result.converted).toBe(true);
    expect(result.backupFile).toBe(`${file}.bak-3-20261110T080000Z`);
    expect(existsSync(result.backupFile!)).toBe(true);
    expect(autoVacuumMode(db)).toBe(2);
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM blob_rows")?.n).toBe(400);
    // 备份是完整的库：原来的模式、数据都在
    const backup = new DatabaseSync(result.backupFile!, { readOnly: true });
    expect(backup.prepare("SELECT count(*) AS n FROM blob_rows").get()).toMatchObject({ n: 400 });
    backup.close();
    expect(ensureIncrementalVacuum(db)).toEqual({ converted: false });
  });

  it("backup: false（刚升级过，迁移已经备份）：不再备份", () => {
    legacyDb();
    db = openDatabase(file);
    expect(ensureIncrementalVacuum(db, { backup: false })).toEqual({ converted: true });
    expect(readdirSync(dir).filter((n) => n.includes(".bak-"))).toEqual([]);
  });

  it("内存库：什么都不做", () => {
    db = openDatabase(":memory:");
    expect(ensureIncrementalVacuum(db)).toEqual({ converted: false });
  });

  it("不能在事务里调", () => {
    db = openDatabase(file);
    expect(() => db!.transaction(() => ensureIncrementalVacuum(db!))).toThrow(/inside a transaction/);
  });

  it("openStore：老库这次有迁移要升级：只备份一份（迁移的），并改成 INCREMENTAL", () => {
    legacyDb(); // user_version 3
    const migrationsDir = migrationsUpTo(4);
    const opened = openStore({ stateDir: dir, dbFile: file }, { migrationsDir });
    db = opened.db;
    expect(opened.migration.backupFile).toMatch(/\.bak-3-/);
    expect(opened.autoVacuum).toEqual({ converted: true });
    expect(autoVacuumMode(db)).toBe(2);
    expect(readdirSync(dir).filter((n) => n.includes(".bak-"))).toHaveLength(1);
  });

  it("openStore：老库没有迁移要升级：重建自己先备份一份", () => {
    legacyDb(); // user_version 3
    const opened = openStore({ stateDir: dir, dbFile: file }, { migrationsDir: migrationsUpTo(3) });
    db = opened.db;
    expect(opened.migration.applied).toEqual([]);
    expect(opened.autoVacuum.converted).toBe(true);
    expect(opened.autoVacuum.backupFile).toMatch(/\.bak-3-/);
    expect(readdirSync(dir).filter((n) => n.includes(".bak-"))).toHaveLength(1);
  });

  it("openStore：全新的库：一开始就是 INCREMENTAL，不重建不备份", () => {
    const opened = openStore({ stateDir: dir, dbFile: file });
    db = opened.db;
    expect(opened.autoVacuum).toEqual({ converted: false });
    expect(autoVacuumMode(db)).toBe(2);
    expect(readdirSync(dir).filter((n) => n.includes(".bak-"))).toEqual([]);
  });

  it("重建失败（如别的进程正占着写锁）：不抛错挡住启动、不弄坏库，等锁释放后下次能成", () => {
    legacyDb(); // user_version 3, auto_vacuum = NONE
    const holder = new DatabaseSync(file);
    holder.exec("PRAGMA busy_timeout = 0");
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("INSERT INTO blob_rows (body) VALUES ('locked')");
    try {
      db = openDatabase(file);
      db.exec("PRAGMA busy_timeout = 10");
      const failed = ensureIncrementalVacuum(db, { backup: false });
      expect(failed.converted).toBe(false);
      expect(failed.error).toMatch(/locked|busy/i);
      expect(autoVacuumMode(db)).toBe(0);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(db!.get<{ n: number }>("SELECT count(*) AS n FROM blob_rows")?.n).toBe(400);
    const ok = ensureIncrementalVacuum(db!, { backup: false });
    expect(ok).toEqual({ converted: true });
    expect(autoVacuumMode(db!)).toBe(2);
    expect(db!.get<{ n: number }>("SELECT count(*) AS n FROM blob_rows")?.n).toBe(400);
  });
});

describe("reclaimFreePages：空闲页分批还给文件系统", () => {
  function bigThenDelete(): Db {
    const d = openDatabase(file);
    d.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    d.transaction(() => {
      for (let i = 0; i < 1_000; i++) d.run("INSERT INTO t (body) VALUES (?)", "y".repeat(4_000));
    });
    d.run("DELETE FROM t");
    d.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return d;
  }

  it("删光以后库文件不会自己变小；回收后变小，空闲页清零", async () => {
    db = bigThenDelete();
    const sizeBefore = statSync(file).size;
    expect(freePages(db)).toBeGreaterThan(900);
    const result = await reclaimFreePages(db);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(result.remaining).toBe(0);
    expect(result.pages).toBeGreaterThan(900);
    expect(freePages(db)).toBe(0);
    expect(statSync(file).size).toBeLessThan(sizeBefore / 10);
  });

  it("分批：每次最多 chunkPages 页，次与次之间让出一次；一轮最多 maxPages 页，剩下的留着", async () => {
    db = bigThenDelete();
    const free = freePages(db);
    let yields = 0;
    const result = await reclaimFreePages(db, { chunkPages: 100, maxPages: 350, yieldToLoop: async () => void yields++ });
    expect(result.pages).toBe(350);
    expect(result.chunkMs).toHaveLength(4); // 100 + 100 + 100 + 50
    expect(yields).toBe(3);
    expect(result.remaining).toBe(free - 350);
    expect(pagesOf(db)).toBeGreaterThan(0);
    // 下一轮接着回收
    const next = await reclaimFreePages(db, { chunkPages: 1_000, maxPages: 100_000 });
    expect(next.remaining).toBe(0);
  });

  it("没有空闲页：什么都不做；库不是 INCREMENTAL（老库还没重建）：不回收、不报错", async () => {
    db = openDatabase(file);
    migrate(db);
    expect(await reclaimFreePages(db)).toMatchObject({ pages: 0, chunkMs: [] });
    db.close();
    rmSync(file);
    legacyDb();
    const raw = new DatabaseSync(file);
    raw.exec("DELETE FROM blob_rows");
    raw.close();
    db = openDatabase(file);
    expect(autoVacuumMode(db)).toBe(0);
    const free = freePages(db);
    expect(free).toBeGreaterThan(0);
    expect(await reclaimFreePages(db)).toMatchObject({ pages: 0, remaining: free });
  });
});
