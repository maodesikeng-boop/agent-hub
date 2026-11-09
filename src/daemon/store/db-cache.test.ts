// 预编译语句缓存的上限（store/db.ts）：把编号拼进 SQL 的语句每次都是新原文，缓存不能跟着一直涨。
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "./db.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openDatabase：预编译语句缓存", () => {
  it("同一句 SQL 只编译一次", () => {
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const db = openDatabase(":memory:");
    try {
      for (let i = 0; i < 5; i++) db.get("SELECT 1 AS x");
      expect(prepare).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it("超过上限淘汰最久没用的：用过的挪到最新，不会被先淘汰", () => {
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const db = openDatabase(":memory:", { maxStatements: 2 });
    try {
      db.get("SELECT 1 AS a");
      db.get("SELECT 2 AS b");
      db.get("SELECT 1 AS a"); // 命中，a 变成最新
      db.get("SELECT 3 AS c"); // 满了：淘汰 b
      db.get("SELECT 1 AS a"); // 还在
      expect(prepare).toHaveBeenCalledTimes(3);
      db.get("SELECT 2 AS b"); // 被淘汰过：重新编译
      expect(prepare).toHaveBeenCalledTimes(4);
    } finally {
      db.close();
    }
  });

  it("拼了编号的一次性 SQL 跑几千次：缓存一直被淘汰，结果照对", () => {
    const db = openDatabase(":memory:", { maxStatements: 8 });
    try {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
      for (let i = 0; i < 2_000; i++) db.run(`INSERT INTO t (id) VALUES (${i})`);
      expect(db.get<{ n: number }>("SELECT count(*) AS n FROM t")?.n).toBe(2_000);
    } finally {
      db.close();
    }
  });
});
