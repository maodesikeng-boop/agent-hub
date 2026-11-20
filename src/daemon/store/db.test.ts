// db.ts 的嵌套事务：内层用 SAVEPOINT，内层抛错只撤掉内层自己写的，外层接住后照常提交（不把内层写了一半的带进去）。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "./db.ts";

let db: Db;

const xs = () => db.all<{ x: number }>("SELECT x FROM t ORDER BY x").map((r) => r.x);

beforeEach(() => {
  db = openDatabase(":memory:");
  db.exec("CREATE TABLE t (x INTEGER)");
});

afterEach(() => {
  db.close();
});

describe("嵌套事务（SAVEPOINT）", () => {
  it("内层抛错被外层接住：内层写了一半的回滚，外层自己的写照常提交", () => {
    db.transaction(() => {
      db.run("INSERT INTO t VALUES (1)");
      try {
        db.transaction(() => {
          db.run("INSERT INTO t VALUES (2)");
          throw new Error("inner boom");
        });
      } catch (error) {
        expect((error as Error).message).toBe("inner boom");
      }
      db.run("INSERT INTO t VALUES (3)");
    });
    expect(xs()).toEqual([1, 3]);
    expect(db.inTransaction).toBe(false);
  });

  it("内层正常返回：随外层一起提交，返回值透传", () => {
    const inner = db.transaction(() => {
      db.run("INSERT INTO t VALUES (1)");
      return db.transaction(() => db.run("INSERT INTO t VALUES (2)").changes);
    });
    expect(inner).toBe(1);
    expect(xs()).toEqual([1, 2]);
  });

  it("内层成功、外层之后抛错：内外一起回滚", () => {
    expect(() =>
      db.transaction(() => {
        db.transaction(() => db.run("INSERT INTO t VALUES (1)"));
        throw new Error("outer boom");
      }),
    ).toThrow("outer boom");
    expect(xs()).toEqual([]);
    expect(db.inTransaction).toBe(false);
  });

  it("三层：最里层失败只撤最里层，中间层接住后继续写，最外层提交", () => {
    db.transaction(() => {
      db.run("INSERT INTO t VALUES (1)");
      db.transaction(() => {
        db.run("INSERT INTO t VALUES (2)");
        try {
          db.transaction(() => {
            db.run("INSERT INTO t VALUES (3)");
            throw new Error("deep");
          });
        } catch {
          // 中间层接住
        }
        db.run("INSERT INTO t VALUES (4)");
      });
    });
    expect(xs()).toEqual([1, 2, 4]);
  });

  it("内层回滚后 savepoint 已释放：同一层再开内层事务照常提交，不残留在栈上", () => {
    db.transaction(() => {
      for (const x of [1, 2, 3]) {
        try {
          db.transaction(() => {
            db.run("INSERT INTO t VALUES (?)", x);
            if (x === 2) throw new Error("skip 2");
          });
        } catch {
          // 只跳过 2
        }
      }
    });
    expect(xs()).toEqual([1, 3]);
    // 栈上没残留：再开一个外层事务、内层失败、外层回滚，库里不多不少
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO t VALUES (9)");
        throw new Error("rollback all");
      }),
    ).toThrow("rollback all");
    expect(xs()).toEqual([1, 3]);
    expect(db.inTransaction).toBe(false);
  });

  it("回调返回 Promise（在事务里 await）：拒绝并回滚，不让异步写混进同步事务", () => {
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO t VALUES (1)");
        return Promise.resolve();
      }),
    ).toThrow(/同步/);
    expect(xs()).toEqual([]);
    expect(db.inTransaction).toBe(false);
    db.transaction(() => {
      db.run("INSERT INTO t VALUES (5)");
      expect(() => db.transaction(async () => undefined)).toThrow(/同步/);
      db.run("INSERT INTO t VALUES (6)");
    });
    expect(xs()).toEqual([5, 6]);
  });
});
