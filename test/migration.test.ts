import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const migration = new URL("../migrations/0001_init.sql", import.meta.url).pathname;

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function sqlite(db: string, sql: string): string {
  return execFileSync("sqlite3", [db, sql], { encoding: "utf8" });
}

function freshDb(): string {
  dir = mkdtempSync(join(tmpdir(), "agent-hub-sql-"));
  return join(dir, "hub.sqlite");
}

describe("0001_init.sql", () => {
  it("在空库上能执行，建出六张表", () => {
    const db = freshDb();
    sqlite(db, `.read ${migration}`);
    const tables = sqlite(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .trim()
      .split("\n");
    expect(tables).toEqual(["actions", "agent_sessions", "conversations", "health", "messages", "pms"]);
  });

  it("消息的去重编号唯一", () => {
    const db = freshDb();
    sqlite(db, `.read ${migration}`);
    sqlite(
      db,
      `INSERT INTO pms (id, name, created_at) VALUES (1, 'pm', 0);
       INSERT INTO conversations (id, kind, pm_id, title, created_at) VALUES (1, 'pm', 1, 'pm', 0);
       INSERT INTO messages (conversation_id, sender, kind, text, dedupe_key, created_at, updated_at)
         VALUES (1, 'user', 'text', 'hi', 'client:a', 0, 0);`,
    );
    expect(() =>
      execFileSync(
        "sqlite3",
        [
          db,
          `INSERT INTO messages (conversation_id, sender, kind, text, dedupe_key, created_at, updated_at)
             VALUES (1, 'user', 'text', 'hi again', 'client:a', 0, 0)`,
        ],
        { stdio: "pipe" },
      ),
    ).toThrow(/UNIQUE/);
  });

  it("动作按（类型，去重键）只有一行", () => {
    const db = freshDb();
    sqlite(db, `.read ${migration}`);
    sqlite(db, `INSERT INTO actions (type, dedupe_key, params, next_attempt_at, created_at, updated_at) VALUES ('session.send', '1', '{}', 0, 0, 0)`);
    expect(() =>
      execFileSync(
        "sqlite3",
        [db, `INSERT INTO actions (type, dedupe_key, params, next_attempt_at, created_at, updated_at) VALUES ('session.send', '1', '{}', 0, 0, 0)`],
        { stdio: "pipe" },
      ),
    ).toThrow(/UNIQUE/);
  });
});
