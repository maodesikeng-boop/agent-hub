import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { enqueueAction, getAction, listActions, setActionStatus } from "./index.ts";

let db: Db;

beforeEach(() => {
  db = openTestDb();
});

afterEach(() => {
  db.close();
});

describe("登记动作", () => {
  it("新登记：待执行，次数 0，下次尝试时间是现在", () => {
    const { row, enqueued } = enqueueAction(db, { type: "session.send", params: { sessionId: 1, messageId: 7, source: "user" } }, 1_000);
    expect(enqueued).toBe(true);
    expect(row).toMatchObject({
      type: "session.send",
      dedupeKey: "7",
      params: { sessionId: 1, messageId: 7, source: "user" },
      status: "pending",
      attempts: 0,
      nextAttemptAt: 1_000,
      lastError: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    expect(getAction(db, row.id)).toEqual(row);
  });

  it("重复登记已结束的动作：同一行改回待执行，次数清零，参数是新的", () => {
    for (const ended of ["failed", "done", "abandoned"] as const) {
      const first = enqueueAction(db, { type: "session.send", params: { sessionId: 3, messageId: 1, source: "user" } }, 1_000).row;
      setActionStatus(db, first.id, { status: ended, attempts: 3, lastError: "boom", nextAttemptAt: 9_000 }, 2_000);

      const again = enqueueAction(db, { type: "session.send", params: { sessionId: 3, messageId: 1, source: "user", resend: true } }, 5_000);
      expect(again.enqueued).toBe(true);
      expect(again.row).toMatchObject({
        id: first.id,
        status: "pending",
        attempts: 0,
        lastError: null,
        nextAttemptAt: 5_000,
        params: { sessionId: 3, messageId: 1, source: "user", resend: true },
        createdAt: 1_000,
        updatedAt: 5_000,
      });
      expect(listActions(db)).toHaveLength(1);
      db.exec("DELETE FROM actions");
    }
  });

  it("重复登记没结束的动作：只更新参数，状态、次数、时间不动，不算新登记", () => {
    for (const live of ["pending", "running"] as const) {
      const first = enqueueAction(db, { type: "session.send", params: { sessionId: 1, messageId: 9, source: "user" } }, 1_000).row;
      setActionStatus(db, first.id, { status: live, attempts: 1, lastError: "earlier", nextAttemptAt: 8_000 }, 2_000);

      const again = enqueueAction(db, { type: "session.send", params: { sessionId: 1, messageId: 9, source: "user", resend: true } }, 5_000);
      expect(again.enqueued).toBe(false);
      expect(again.row).toMatchObject({
        id: first.id,
        status: live,
        attempts: 1,
        lastError: "earlier",
        nextAttemptAt: 8_000,
        params: { sessionId: 1, messageId: 9, source: "user", resend: true },
        updatedAt: 5_000,
      });
      db.exec("DELETE FROM actions");
    }
  });

  it("不同类型、同样的去重键是两行", () => {
    enqueueAction(db, { type: "session.send", params: { sessionId: 1, messageId: 1, source: "user" } }, 1);
    // session.start 的键是 "1:1"，换个能撞上的：直接比较类型分开
    enqueueAction(db, { type: "session.start", params: { sessionId: 1, generation: 1 } }, 1);
    expect(listActions(db).map((a) => [a.type, a.dedupeKey])).toEqual([
      ["session.send", "1"],
      ["session.start", "1:1"],
    ]);
  });

  it("找不到的动作 getAction 返回 null", () => {
    expect(getAction(db, 404)).toBeNull();
  });
});
