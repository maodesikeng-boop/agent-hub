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

function fails(db: string, sql: string): string {
  try {
    execFileSync("sqlite3", ["-bail", db, sql], { stdio: "pipe", encoding: "utf8" });
  } catch (error) {
    return String((error as { stderr: string }).stderr);
  }
  throw new Error(`应该失败但成功了：${sql}`);
}

function seeded(): string {
  const db = freshDb();
  sqlite(db, `.read ${migration}`);
  sqlite(
    db,
    `INSERT INTO pms (id, name, created_at) VALUES (1, 'pm', 0);
     INSERT INTO conversations (id, kind, pm_id, title, created_at) VALUES (1, 'pm', 1, 'pm', 0);`,
  );
  return db;
}

describe("0001_init.sql：会扩展的枚举不在库里限制，状态列仍然限制", () => {
  it("messages.kind、messages.sender、actions.type 可以写新值（代码里校验）", () => {
    const db = seeded();
    sqlite(
      db,
      `INSERT INTO messages (conversation_id, sender, kind, text, dedupe_key, created_at, updated_at)
         VALUES (1, 'worker', 'card', 'x', 'k1', 0, 0);
       INSERT INTO actions (type, dedupe_key, params, next_attempt_at, created_at, updated_at)
         VALUES ('worktree.create', '1', '{}', 0, 0, 0);`,
    );
    expect(sqlite(db, "SELECT count(*) FROM messages").trim()).toBe("1");
    expect(sqlite(db, "SELECT count(*) FROM actions").trim()).toBe("1");
  });

  it("状态列写错值会被拒", () => {
    const db = seeded();
    expect(
      fails(
        db,
        `INSERT INTO messages (conversation_id, sender, kind, text, dedupe_key, status, created_at, updated_at)
           VALUES (1, 'user', 'text', 'x', 'k1', 'bogus', 0, 0)`,
      ),
    ).toMatch(/CHECK/);
    expect(
      fails(db, `INSERT INTO actions (type, dedupe_key, params, status, next_attempt_at, created_at, updated_at) VALUES ('session.send', '1', '{}', 'bogus', 0, 0, 0)`),
    ).toMatch(/CHECK/);
    expect(
      fails(db, `INSERT INTO agent_sessions (role, vendor_session_id, cwd, status, created_at, updated_at) VALUES ('pm', 'v', '/x', 'bogus', 0, 0)`),
    ).toMatch(/CHECK/);
  });

  it("消息有失败原因列", () => {
    const db = seeded();
    sqlite(
      db,
      `INSERT INTO messages (conversation_id, sender, kind, text, dedupe_key, status, failure_reason, created_at, updated_at)
         VALUES (1, 'user', 'text', 'x', 'k1', 'failed', 'claude_not_found: x', 0, 0)`,
    );
    expect(sqlite(db, "SELECT failure_reason FROM messages").trim()).toBe("claude_not_found: x");
  });
});

describe("0001_init.sql：唯一约束", () => {
  it("同一个对话的同一代会话只有一个", () => {
    const db = seeded();
    sqlite(db, `INSERT INTO agent_sessions (role, conversation_id, vendor_session_id, cwd, generation, created_at, updated_at) VALUES ('pm', 1, 'a', '/x', 1, 0, 0)`);
    sqlite(db, `INSERT INTO agent_sessions (role, conversation_id, vendor_session_id, cwd, generation, created_at, updated_at) VALUES ('pm', 1, 'b', '/x', 2, 0, 0)`);
    expect(
      fails(db, `INSERT INTO agent_sessions (role, conversation_id, vendor_session_id, cwd, generation, created_at, updated_at) VALUES ('pm', 1, 'c', '/x', 2, 0, 0)`),
    ).toMatch(/UNIQUE/);
  });

  it("一个项目经理只有一个私聊；项目群不受限", () => {
    const db = seeded();
    expect(fails(db, `INSERT INTO conversations (kind, pm_id, title, created_at) VALUES ('pm', 1, 'again', 0)`)).toMatch(/UNIQUE/);
    sqlite(
      db,
      `INSERT INTO conversations (kind, pm_id, project_id, title, created_at) VALUES ('project_group', 1, 1, 'g1', 0);
       INSERT INTO conversations (kind, pm_id, project_id, title, created_at) VALUES ('project_group', 1, 2, 'g2', 0);
       INSERT INTO conversations (kind, title, created_at) VALUES ('assistant', 'a', 0);`,
    );
    expect(sqlite(db, "SELECT count(*) FROM conversations").trim()).toBe("4");
  });

  it("重复登记已结束的动作：重置成待执行、次数清零、参数更新；没结束的只更新参数", () => {
    const db = seeded();
    const upsert = (params: string) =>
      sqlite(
        db,
        `INSERT INTO actions (type, dedupe_key, params, next_attempt_at, created_at, updated_at)
           VALUES ('session.send', '42', '${params}', 5, 5, 5)
         ON CONFLICT (type, dedupe_key) DO UPDATE SET
           params = excluded.params,
           status = CASE WHEN status IN ('done', 'failed', 'abandoned') THEN 'pending' ELSE status END,
           attempts = CASE WHEN status IN ('done', 'failed', 'abandoned') THEN 0 ELSE attempts END,
           last_error = CASE WHEN status IN ('done', 'failed', 'abandoned') THEN NULL ELSE last_error END,
           next_attempt_at = CASE WHEN status IN ('done', 'failed', 'abandoned') THEN excluded.next_attempt_at ELSE next_attempt_at END,
           updated_at = excluded.updated_at`,
      );
    upsert('{"v":1}');
    sqlite(db, "UPDATE actions SET status = 'failed', attempts = 3, last_error = 'boom'");
    upsert('{"v":2}');
    expect(sqlite(db, "SELECT status, attempts, last_error IS NULL, params FROM actions").trim()).toBe('pending|0|1|{"v":2}');
    sqlite(db, "UPDATE actions SET status = 'running', attempts = 1");
    upsert('{"v":3}');
    expect(sqlite(db, "SELECT status, attempts, params, count(*) FROM actions").trim()).toBe('running|1|{"v":3}|1');
  });
});
