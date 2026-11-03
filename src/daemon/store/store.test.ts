import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveHubPaths } from "../../shared/paths.ts";
import type { HubPaths } from "../../shared/paths.ts";
import {
  DaemonAlreadyRunningError,
  acquireLock,
  createSessionStore,
  migrate,
  openDatabase,
  openStore,
} from "./index.ts";
import type { Db } from "./index.ts";
import { insertTestSession, openTestDb } from "./test-helpers.ts";

let home: string;
let paths: HubPaths;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-hub-store-"));
  paths = resolveHubPaths({ AGENT_HUB_HOME: home }, "/nonexistent");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function schemaDump(db: Db): unknown[] {
  return db.all("SELECT type, name, sql FROM sqlite_master ORDER BY name");
}

describe("打开存储和迁移", () => {
  it("首次建库：建出 state/hub.sqlite，WAL，user_version 是最新的迁移编号", () => {
    const store = openStore(paths);
    try {
      expect(existsSync(join(home, "state", "hub.sqlite"))).toBe(true);
      expect(store.migration).toEqual({ from: 0, to: 3, applied: [1, 2, 3] });
      expect(store.db.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal");
      expect(store.db.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(3);
      expect(store.db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
      const tables = store.db
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .map((t) => t.name);
      expect(tables).toEqual(
        expect.arrayContaining(["pms", "conversations", "agent_sessions", "messages", "actions", "health", "projects", "project_folders"]),
      );
    } finally {
      store.db.close();
    }
  });

  it("重复迁移：同一个库打开两次，第二次不改任何东西", () => {
    const first = openStore(paths);
    const before = schemaDump(first.db);
    first.db.close();

    const second = openStore(paths);
    try {
      expect(second.migration).toEqual({ from: 3, to: 3, applied: [] });
      expect(schemaDump(second.db)).toEqual(before);
      expect(second.db.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(3);
    } finally {
      second.db.close();
    }
  });

  it("迁移按编号执行，只跑新的；中途出错整个迁移回滚，user_version 不变", () => {
    const dir = join(home, "migrations");
    mkdirSync(dir);
    writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE a (x INTEGER) STRICT;");
    writeFileSync(join(dir, "0002_b.sql"), "CREATE TABLE b (x INTEGER) STRICT; CREATE TABLE a (dup INTEGER);");
    writeFileSync(join(dir, "README.md"), "不是迁移文件");
    const db = openDatabase(":memory:");
    try {
      expect(() => migrate(db, dir)).toThrow(/0002_b\.sql/);
      expect(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(1);
      expect(db.get("SELECT name FROM sqlite_master WHERE name = 'b'")).toBeUndefined();

      writeFileSync(join(dir, "0002_b.sql"), "CREATE TABLE b (x INTEGER) STRICT;");
      expect(migrate(db, dir)).toEqual({ from: 1, to: 2, applied: [2] });
    } finally {
      db.close();
    }
  });

  it("数据库比代码新（user_version 比最大的迁移编号大）时报错", () => {
    const db = openDatabase(":memory:");
    try {
      db.exec("PRAGMA user_version = 99");
      expect(() => migrate(db)).toThrow(/99/);
    } finally {
      db.close();
    }
  });

  it("编号重复的迁移文件报错", () => {
    const dir = join(home, "migrations");
    mkdirSync(dir);
    writeFileSync(join(dir, "0001_a.sql"), "SELECT 1;");
    writeFileSync(join(dir, "0001_b.sql"), "SELECT 1;");
    const db = openDatabase(":memory:");
    try {
      expect(() => migrate(db, dir)).toThrow(/duplicate/);
    } finally {
      db.close();
    }
  });
});

describe("数据库封装", () => {
  it("transaction：抛错回滚，返回值透传，嵌套时并入外层", () => {
    const db = openDatabase(":memory:");
    try {
      db.exec("CREATE TABLE t (x INTEGER)");
      expect(db.transaction(() => db.run("INSERT INTO t VALUES (1)").changes)).toBe(1);
      expect(() =>
        db.transaction(() => {
          db.run("INSERT INTO t VALUES (2)");
          db.transaction(() => db.run("INSERT INTO t VALUES (3)"));
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(db.all<{ x: number }>("SELECT x FROM t").map((r) => r.x)).toEqual([1]);
      expect(db.inTransaction).toBe(false);
    } finally {
      db.close();
    }
  });
});

const lockPid = (file: string) => readFileSync(file, "utf8").split("\n")[0];
const startTimeOf = (pid: number) => execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();

describe("目录锁", () => {
  it("开两个：已拿锁时再拿一次，报“已有守护进程在跑”", () => {
    const lock = acquireLock(paths.lockFile);
    try {
      expect(() => acquireLock(paths.lockFile)).toThrow(DaemonAlreadyRunningError);
      expect(() => acquireLock(paths.lockFile)).toThrow(/已有守护进程在跑/);
    } finally {
      lock.release();
    }
    // 放掉以后能再拿
    const again = acquireLock(paths.lockFile);
    expect(lockPid(paths.lockFile)).toBe(String(process.pid));
    again.release();
    expect(existsSync(paths.lockFile)).toBe(false);
  });

  it("自己建 state/ 目录，权限 0700；锁文件里有进程号和进程启动时间，不留临时文件", () => {
    expect(existsSync(paths.stateDir)).toBe(false);
    const lock = acquireLock(paths.lockFile);
    try {
      expect(statSync(paths.stateDir).mode & 0o777).toBe(0o700);
      expect(readFileSync(paths.lockFile, "utf8")).toBe(`${process.pid}\n${startTimeOf(process.pid)}\n`);
      expect(() => acquireLock(paths.lockFile)).toThrow(DaemonAlreadyRunningError);
      expect(readdirSync(paths.stateDir)).toEqual(["lock"]);
    } finally {
      lock.release();
    }
  });

  it("上次留下的锁对应的进程已经不在了：接管，不留改名后的旧锁", () => {
    mkdirSync(paths.stateDir, { recursive: true });
    // 2^22 以上的进程号在 macOS / Linux 上都不会存在
    writeFileSync(paths.lockFile, "99999999\n");
    const lock = acquireLock(paths.lockFile);
    expect(lockPid(paths.lockFile)).toBe(String(process.pid));
    expect(readdirSync(paths.stateDir)).toEqual(["lock"]);
    lock.release();
  });

  it("进程号被别的进程复用了（启动时间对不上）：当作过期，接管", () => {
    mkdirSync(paths.stateDir, { recursive: true });
    writeFileSync(paths.lockFile, `${process.pid}\nMon Jan  1 00:00:00 2001\n`);
    const lock = acquireLock(paths.lockFile);
    expect(readFileSync(paths.lockFile, "utf8")).toBe(`${process.pid}\n${startTimeOf(process.pid)}\n`);
    lock.release();
  });

  it("锁文件内容坏了：当作没人拿着，接管", () => {
    mkdirSync(paths.stateDir, { recursive: true });
    writeFileSync(paths.lockFile, "garbage");
    const lock = acquireLock(paths.lockFile);
    lock.release();
  });

  it("release 不删别人的锁", () => {
    const lock = acquireLock(paths.lockFile);
    writeFileSync(paths.lockFile, `${process.pid}\nsomeone else\n`);
    lock.release();
    expect(existsSync(paths.lockFile)).toBe(true);
  });
});

describe("SessionStore", () => {
  it("get、update、listWithProcess", () => {
    const db = openTestDb();
    try {
      let t = 1_000;
      const store = createSessionStore(db, { now: () => t });
      const id = insertTestSession(db, { createdAt: 500 });
      const row = store.get(id);
      expect(row).toMatchObject({
        id,
        role: "pm",
        vendor: "claude",
        generation: 1,
        pid: null,
        status: "idle",
        hasCompletedTurn: false,
        rateLimit: null,
        addDirs: [],
        createdAt: 500,
        updatedAt: 500,
      });
      expect(store.listWithProcess()).toEqual([]);

      t = 2_000;
      const rateLimit = { status: "allowed", resetsAt: 123, windows: { five_hour: { utilization: 0.5, resetsAt: 123, status: "allowed" } } };
      const updated = store.update(id, { pid: 4321, status: "running", hasCompletedTurn: true, lastEventAt: 1_999, rateLimit });
      expect(updated).toMatchObject({ pid: 4321, status: "running", hasCompletedTurn: true, lastEventAt: 1_999, rateLimit, updatedAt: 2_000, generation: 1 });
      expect(store.get(id)).toEqual(updated);
      expect(store.listWithProcess().map((r) => r.id)).toEqual([id]);

      t = 3_000;
      expect(store.update(id, { pid: null, rateLimit: null })).toMatchObject({ pid: null, rateLimit: null, status: "running", updatedAt: 3_000 });
      expect(store.listWithProcess()).toEqual([]);
      // 空补丁只更新 updatedAt
      t = 4_000;
      expect(store.update(id, {}).updatedAt).toBe(4_000);
    } finally {
      db.close();
    }
  });

  it("找不到：get 返回 null，update 抛错", () => {
    const db = openTestDb();
    try {
      const store = createSessionStore(db);
      expect(store.get(404)).toBeNull();
      expect(() => store.update(404, { status: "idle" })).toThrow(/404/);
    } finally {
      db.close();
    }
  });

  it("不合法的状态被数据库拒绝", () => {
    const db = openTestDb();
    try {
      const store = createSessionStore(db);
      const id = insertTestSession(db);
      expect(() => store.update(id, { status: "weird" as never })).toThrow();
      expect(store.get(id)?.status).toBe("idle");
    } finally {
      db.close();
    }
  });
});
