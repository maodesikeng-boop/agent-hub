import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/daemon/store/db.ts";
import type { Db } from "../src/daemon/store/db.ts";
import { migrate, userVersion } from "../src/daemon/store/migrate.ts";
import { createLedger } from "../src/daemon/ledger/index.ts";
import { ConversationNotFoundError, LedgerRequestError } from "../src/shared/ledger.ts";

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

// ---- 0002_projects：用 node:sqlite 和真正的迁移器测 ----

const migrationsDir = new URL("../migrations/", import.meta.url).pathname;
/** migrations/ 下所有迁移的编号，从小到大。 */
const ALL_VERSIONS = readdirSync(migrationsDir)
  .flatMap((name) => /^(\d+)_.*\.sql$/.exec(name)?.[1] ?? [])
  .map(Number)
  .sort((a, b) => a - b);
const LATEST_VERSION = ALL_VERSIONS.at(-1)!;

/** 只有编号不超过 version 的迁移的目录：模拟老版本的守护进程建出来的库。 */
function migrationsUpTo(version: number): string {
  const old = mkdtempSync(join(tmpdir(), `agent-hub-m${version}-`));
  for (const name of readdirSync(migrationsDir)) {
    const match = /^(\d+)_.*\.sql$/.exec(name);
    if (match !== null && Number(match[1]) <= version) copyFileSync(join(migrationsDir, name), join(old, name));
  }
  extraDirs.push(old);
  return old;
}

/** 只有 0001 的迁移目录：模拟 M1 的守护进程建出来的库。 */
function m1MigrationsDir(): string {
  return migrationsUpTo(1);
}

const extraDirs: string[] = [];
const openDbs: Db[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const d of extraDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function open(): Db {
  const db = openDatabase(freshDb());
  openDbs.push(db);
  return db;
}

function tableNames(db: Db): string[] {
  return db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map((r) => r.name);
}

/**
 * M1 的库里会有的东西：默认项目经理（mode 是 'default'，带头像和默认模型）、私聊、会话、一条消息、一个动作；
 * 再加一个 mode 已经是 'hands_on' 的项目经理（M1 的列没有约束，什么都能写）和它的私聊会话。
 */
function seedM1(db: Db): void {
  db.exec(`
    INSERT INTO pms (id, name, avatar_file, default_model, persona_file, created_at)
      VALUES (1, '项目经理', 'avatars/pm-1.png', 'claude-opus-5-5', '/s/personas/pm-1.md', 10);
    INSERT INTO pms (id, name, mode, created_at) VALUES (2, '阿周', 'hands_on', 12);
    INSERT INTO conversations (id, kind, pm_id, title, created_at) VALUES (3, 'pm', 2, '阿周', 12);
    INSERT INTO agent_sessions (id, role, conversation_id, vendor_session_id, cwd, created_at, updated_at)
      VALUES (3, 'pm', 3, 'v-3', '/s/pm-home/2', 12, 12);
    INSERT INTO conversations (id, kind, pm_id, title, created_at) VALUES (1, 'pm', 1, '项目经理', 10);
    INSERT INTO agent_sessions (id, role, conversation_id, vendor_session_id, cwd, created_at, updated_at)
      VALUES (1, 'pm', 1, 'v-1', '/s/pm-home/1', 10, 10);
    INSERT INTO messages (conversation_id, session_id, sender, kind, text, dedupe_key, status, created_at, updated_at)
      VALUES (1, 1, 'user', 'text', '你好', 'client:1:a', 'replied', 11, 11);
    INSERT INTO actions (type, dedupe_key, params, status, next_attempt_at, created_at, updated_at)
      VALUES ('session.send', '1', '{"sessionId":1,"messageId":1,"source":"user"}', 'done', 11, 11, 11);
  `);
}

/** M2 的一个项目：项目经理 1 管着项目 1（群 2、群会话 2、主文件夹 /code/foo）。 */
function seedProject(db: Db): void {
  db.exec(`
    INSERT INTO conversations (id, kind, pm_id, title, created_at) VALUES (2, 'project_group', 1, 'foo', 20);
    INSERT INTO projects (id, name, pm_id, conversation_id, created_at, updated_at) VALUES (1, 'foo', 1, 2, 20, 20);
    UPDATE conversations SET project_id = 1 WHERE id = 2;
    INSERT INTO project_folders (project_id, path, is_main, added_at) VALUES (1, '/code/foo', 1, 20);
    INSERT INTO agent_sessions (id, role, conversation_id, pm_id, vendor_session_id, cwd, created_at, updated_at)
      VALUES (2, 'pm', 2, 1, 'v-2', '/code/foo', 20, 20);
  `);
}

function migratedWithPm(): Db {
  const db = open();
  migrate(db, migrationsDir);
  db.exec(`
    INSERT INTO pms (id, name, created_at) VALUES (1, '小林', 0);
    INSERT INTO conversations (id, kind, pm_id, title, created_at) VALUES (1, 'pm', 1, '小林', 0);
  `);
  return db;
}

describe("0002_projects：从 M1 的库升级", () => {
  it("新表都建出来，user_version 是 2，老数据都在", () => {
    const db = open();
    expect(migrate(db, m1MigrationsDir())).toMatchObject({ to: 1, applied: [1] });
    seedM1(db);

    expect(migrate(db, migrationsUpTo(2))).toMatchObject({ from: 1, to: 2, applied: [2] });
    expect(userVersion(db)).toBe(2);
    expect(tableNames(db)).toEqual([
      "actions",
      "agent_sessions",
      "conversations",
      "handoffs",
      "health",
      "hub_calls",
      "messages",
      "persona_changes",
      "pms",
      "project_folders",
      "projects",
    ]);
    expect(db.all("SELECT * FROM pms ORDER BY id")).toEqual([
      {
        id: 1,
        name: "项目经理",
        avatar_file: "avatars/pm-1.png",
        mode: "manage_only",
        default_model: "claude-opus-5-5",
        persona_file: "/s/personas/pm-1.md",
        persona: null,
        persona_file_hash: null,
        created_at: 10,
      },
      // 已经是两种模式之一的保留
      {
        id: 2,
        name: "阿周",
        avatar_file: null,
        mode: "hands_on",
        default_model: null,
        persona_file: null,
        persona: null,
        persona_file_hash: null,
        created_at: 12,
      },
    ]);
    expect(db.get("SELECT text, status FROM messages")).toEqual({ text: "你好", status: "replied" });
    expect(db.get("SELECT status FROM actions")).toEqual({ status: "done" });
    // 已有的项目经理会话补上 pm_id
    expect(db.all("SELECT id, pm_id FROM agent_sessions ORDER BY id")).toEqual([
      { id: 1, pm_id: 1 },
      { id: 3, pm_id: 2 },
    ]);
  });

  it("升级后项目经理的会话一定有 pm_id", () => {
    const db = open();
    migrate(db, m1MigrationsDir());
    seedM1(db);
    migrate(db, migrationsDir);
    expect(db.all("SELECT id FROM agent_sessions WHERE role = 'pm' AND pm_id IS NULL")).toEqual([]);
  });

  it("M1 里重名的项目经理：后建的改名成“名字-编号”，会话、对话的引用不变", () => {
    const db = open();
    migrate(db, m1MigrationsDir());
    seedM1(db);
    db.exec(`
      INSERT INTO pms (id, name, created_at) VALUES (5, '项目经理', 20);
      INSERT INTO conversations (id, kind, pm_id, title, created_at) VALUES (5, 'pm', 5, '项目经理', 20);
    `);
    migrate(db, migrationsDir);
    expect(db.all("SELECT id, name FROM pms ORDER BY id")).toEqual([
      { id: 1, name: "项目经理" },
      { id: 2, name: "阿周" },
      { id: 5, name: "项目经理-5" },
    ]);
    expect(db.get("SELECT pm_id FROM conversations WHERE id = 5")).toEqual({ pm_id: 5 });
  });

  it("升级前把库复制一份 hub.sqlite.bak-<旧版本>-<时间>，内容是升级前的", () => {
    const db = open();
    migrate(db, m1MigrationsDir());
    seedM1(db);
    migrate(db, migrationsUpTo(2), { now: () => Date.UTC(2026, 10, 3, 9, 8, 7) });
    const backups = readdirSync(dir!).filter((f) => f.includes(".bak-"));
    expect(backups).toEqual(["hub.sqlite.bak-1-20261103T090807Z"]);
    const backup = openDatabase(join(dir!, backups[0]!));
    try {
      expect(userVersion(backup)).toBe(1);
      expect(backup.get("SELECT mode FROM pms WHERE id = 1")).toEqual({ mode: "default" });
    } finally {
      backup.close();
    }
  });

  it("空库、没有要跑的迁移、内存库都不备份", () => {
    const db = open();
    migrate(db, migrationsDir);
    migrate(db, migrationsDir);
    expect(readdirSync(dir!).filter((f) => f.includes(".bak-"))).toEqual([]);
    const memory = openDatabase(":memory:");
    try {
      migrate(memory, m1MigrationsDir());
      expect(migrate(memory, migrationsDir)).toMatchObject({ applied: ALL_VERSIONS.slice(1) });
    } finally {
      memory.close();
    }
  });

  it("重建 pms 之后外键照常生效，也没有悬空的引用", () => {
    const db = open();
    migrate(db, m1MigrationsDir());
    seedM1(db);
    migrate(db, migrationsDir);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
    expect(() => db.run("INSERT INTO conversations (kind, pm_id, title, created_at) VALUES ('pm', 99, 'x', 0)")).toThrow(/FOREIGN KEY/);
    expect(() => db.run("DELETE FROM pms WHERE id = 1")).toThrow(/FOREIGN KEY/);
  });

  it("重复迁移什么也不做", () => {
    const db = open();
    migrate(db, m1MigrationsDir());
    seedM1(db);
    migrate(db, migrationsUpTo(2));
    expect(migrate(db, migrationsUpTo(2))).toEqual({ from: 2, to: 2, applied: [] });
    expect(db.get("SELECT count(*) AS n FROM pms")).toEqual({ n: 2 });
  });

  it("空库连跑全部迁移没有报错", () => {
    const db = open();
    expect(migrate(db, migrationsDir)).toEqual({ from: 0, to: LATEST_VERSION, applied: ALL_VERSIONS });
  });

  it("新建的项目经理默认只管理", () => {
    const db = migratedWithPm();
    expect(db.get("SELECT mode FROM pms WHERE id = 1")).toEqual({ mode: "manage_only" });
  });
});

describe("0002_projects：约束", () => {
  it("模式只能是两种之一（插入和修改都查）", () => {
    const db = migratedWithPm();
    expect(() => db.run("INSERT INTO pms (name, mode, created_at) VALUES ('阿周', 'foo', 0)")).toThrow(/CHECK/);
    expect(() => db.run("UPDATE pms SET mode = 'default' WHERE id = 1")).toThrow(/CHECK/);
    db.run("UPDATE pms SET mode = 'hands_on' WHERE id = 1");
  });

  it("项目经理名字唯一", () => {
    const db = migratedWithPm();
    expect(() => db.run("INSERT INTO pms (name, created_at) VALUES ('小林', 0)")).toThrow(/UNIQUE/);
  });

  it("一个项目只有一个群；一个群只属于一个项目", () => {
    const db = migratedWithPm();
    seedProject(db);
    expect(() =>
      db.run("INSERT INTO conversations (kind, pm_id, project_id, title, created_at) VALUES ('project_group', 1, 1, 'foo again', 0)"),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db.run("INSERT INTO projects (name, pm_id, conversation_id, created_at, updated_at) VALUES ('bar', 1, 2, 0, 0)"),
    ).toThrow(/UNIQUE/);
  });

  it("一个项目只有一个主文件夹；主文件夹不能标移除；同一个文件夹不能重复挂，移除后可以再挂", () => {
    const db = migratedWithPm();
    seedProject(db);
    expect(() => db.run("INSERT INTO project_folders (project_id, path, is_main, added_at) VALUES (1, '/code/foo2', 1, 0)")).toThrow(
      /UNIQUE/,
    );
    expect(() => db.run("UPDATE project_folders SET removed_at = 1 WHERE is_main = 1")).toThrow(/CHECK/);
    db.run("INSERT INTO project_folders (project_id, path, added_at) VALUES (1, '/code/docs', 0)");
    expect(() => db.run("INSERT INTO project_folders (project_id, path, added_at) VALUES (1, '/code/docs', 0)")).toThrow(/UNIQUE/);
    db.run("UPDATE project_folders SET removed_at = 5 WHERE path = '/code/docs'");
    db.run("INSERT INTO project_folders (project_id, path, added_at) VALUES (1, '/code/docs', 6)");
  });

  it("性格设定修改记录：模式只能是两种之一，能指向被撤销的那一条", () => {
    const db = migratedWithPm();
    db.run(
      `INSERT INTO persona_changes (id, pm_id, actor, text_before, text_after, mode_before, mode_after, created_at)
       VALUES (1, 1, 'pm', 'a', 'b', 'manage_only', 'hands_on', 0)`,
    );
    db.run(
      `INSERT INTO persona_changes (pm_id, actor, text_before, text_after, mode_before, mode_after, revert_of, created_at)
       VALUES (1, 'user', 'b', 'a', 'hands_on', 'manage_only', 1, 0)`,
    );
    expect(() =>
      db.run(
        `INSERT INTO persona_changes (pm_id, actor, text_before, text_after, mode_before, mode_after, created_at)
         VALUES (1, 'pm', 'a', 'b', 'default', 'hands_on', 0)`,
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      db.run(
        `INSERT INTO persona_changes (pm_id, actor, text_before, text_after, mode_before, mode_after, revert_of, created_at)
         VALUES (1, 'user', 'a', 'b', 'manage_only', 'manage_only', 99, 0)`,
      ),
    ).toThrow(/FOREIGN KEY/);
  });

  it("交接和 hub 调用记录指向真实的项目、会话", () => {
    const db = migratedWithPm();
    seedProject(db);
    db.exec(`
      INSERT INTO pms (id, name, created_at) VALUES (2, '阿周', 0);
      INSERT INTO agent_sessions (id, role, conversation_id, pm_id, vendor_session_id, cwd, generation, created_at, updated_at)
        VALUES (3, 'pm', 2, 2, 'v-3', '/code/foo', 2, 0, 0);
      INSERT INTO handoffs (project_id, from_session_id, to_session_id, from_pm_id, to_pm_id, file, reason, created_at)
        VALUES (1, 2, 3, 1, 2, '/s/handoffs/1/x.md', 'reassign', 0);
      INSERT INTO hub_calls (session_id, command, args, ok, result, created_at)
        VALUES (2, 'project.assign', '{"project":"foo","to":"阿周","handoff":"..."}', 1, '已交给阿周', 0);
      INSERT INTO hub_calls (session_id, command, args, ok, error_code, result, created_at)
        VALUES (2, 'project.attach', '{}', 0, 'not_found', '没有叫 bar 的项目', 0);
    `);
    expect(() =>
      db.run(
        `INSERT INTO handoffs (project_id, from_session_id, to_session_id, from_pm_id, to_pm_id, file, reason, created_at)
         VALUES (9, 2, 3, 1, 2, 'x', 'reassign', 0)`,
      ),
    ).toThrow(/FOREIGN KEY/);
    expect(() => db.run("INSERT INTO hub_calls (session_id, command, args, ok, result, created_at) VALUES (9, 'status', '{}', 1, '', 0)")).toThrow(
      /FOREIGN KEY/,
    );
    expect(() => db.run("INSERT INTO hub_calls (session_id, command, args, ok, result, created_at) VALUES (2, 'status', '{}', 2, '', 0)")).toThrow(
      /CHECK/,
    );
    expect(() => db.run("UPDATE agent_sessions SET pm_id = 99 WHERE id = 2")).toThrow(/FOREIGN KEY/);
  });
});

describe("0002_projects：审查补的约束", () => {
  it("is_main 只能是 0 或 1", () => {
    const db = migratedWithPm();
    seedProject(db);
    expect(() => db.run("INSERT INTO project_folders (project_id, path, is_main, added_at) VALUES (1, '/code/x', 2, 0)")).toThrow(/CHECK/);
  });

  it("修改记录的 mode_after 只能是两种之一", () => {
    const db = migratedWithPm();
    expect(() =>
      db.run(
        `INSERT INTO persona_changes (pm_id, actor, text_before, text_after, mode_before, mode_after, created_at)
         VALUES (1, 'pm', 'a', 'b', 'manage_only', 'default', 0)`,
      ),
    ).toThrow(/CHECK/);
  });

  it("各个外键：项目、文件夹、修改记录、交接都指向真实的行", () => {
    const db = migratedWithPm();
    seedProject(db);
    db.run("INSERT INTO conversations (id, kind, pm_id, title, created_at) VALUES (9, 'project_group', 1, 'bar', 0)");
    const cases: [string, string][] = [
      ["projects.pm_id", "INSERT INTO projects (name, pm_id, conversation_id, created_at, updated_at) VALUES ('bar', 99, 9, 0, 0)"],
      // 项目经理 1 已经有一个进行中的项目（0003 起只能有一个），这条用归档的
      [
        "projects.conversation_id",
        "INSERT INTO projects (name, status, pm_id, conversation_id, created_at, updated_at) VALUES ('bar', 'archived', 1, 99, 0, 0)",
      ],
      ["project_folders.project_id", "INSERT INTO project_folders (project_id, path, added_at) VALUES (99, '/x', 0)"],
      [
        "persona_changes.pm_id",
        "INSERT INTO persona_changes (pm_id, actor, text_before, text_after, mode_before, mode_after, created_at) VALUES (99, 'pm', 'a', 'b', 'manage_only', 'manage_only', 0)",
      ],
      [
        "persona_changes.session_id",
        "INSERT INTO persona_changes (pm_id, actor, session_id, text_before, text_after, mode_before, mode_after, created_at) VALUES (1, 'pm', 99, 'a', 'b', 'manage_only', 'manage_only', 0)",
      ],
      [
        "handoffs.from_session_id",
        "INSERT INTO handoffs (project_id, from_session_id, to_session_id, from_pm_id, to_pm_id, file, reason, created_at) VALUES (1, 99, 2, 1, 1, 'x', 'reassign', 0)",
      ],
      [
        "handoffs.to_session_id",
        "INSERT INTO handoffs (project_id, from_session_id, to_session_id, from_pm_id, to_pm_id, file, reason, created_at) VALUES (1, 2, 99, 1, 1, 'x', 'reassign', 0)",
      ],
      [
        "handoffs.from_pm_id",
        "INSERT INTO handoffs (project_id, from_session_id, to_session_id, from_pm_id, to_pm_id, file, reason, created_at) VALUES (1, 2, 2, 99, 1, 'x', 'reassign', 0)",
      ],
      [
        "handoffs.to_pm_id",
        "INSERT INTO handoffs (project_id, from_session_id, to_session_id, from_pm_id, to_pm_id, file, reason, created_at) VALUES (1, 2, 2, 1, 99, 'x', 'reassign', 0)",
      ],
    ];
    for (const [name, sql] of cases) expect(() => db.run(sql), name).toThrow(/FOREIGN KEY/);
  });

  it("pms 有 persona_file_hash 列：上次成功写入文件的内容哈希，新建的是 NULL", () => {
    const db = migratedWithPm();
    expect(db.get("SELECT persona_file_hash FROM pms WHERE id = 1")).toEqual({ persona_file_hash: null });
    db.run("UPDATE pms SET persona_file_hash = 'abc' WHERE id = 1");
  });
});

// ---- 0003_pm_conversation：一个项目经理就是一个会话（11-03）----

/**
 * M2 开发时的库（user_version 2）：seedM1 的两个项目经理和私聊，再加一个项目群 foo（项目 1，群 2），
 * 交接过一次（群会话 2 属于项目经理 1，第 2 代会话 4 属于阿周），群里一条已回复、一条还在排队的消息（动作还没执行），
 * 阿周私聊里一条“交给了你”的系统消息，一条交接文件记录、一条 hub 调用、一条性格设定修改。
 */
function m2DevDb(): Db {
  const db = open();
  migrate(db, m1MigrationsDir());
  seedM1(db);
  migrate(db, migrationsUpTo(2));
  db.exec(`
    INSERT INTO conversations (id, kind, pm_id, title, created_at) VALUES (2, 'project_group', 1, 'foo', 20);
    INSERT INTO projects (id, name, pm_id, conversation_id, created_at, updated_at) VALUES (1, 'foo', 2, 2, 20, 30);
    UPDATE conversations SET project_id = 1 WHERE id = 2;
    INSERT INTO project_folders (project_id, path, is_main, added_at) VALUES (1, '/code/foo', 1, 20);
    INSERT INTO project_folders (project_id, path, is_main, added_at) VALUES (1, '/code/docs', 0, 21);
    INSERT INTO agent_sessions (id, role, conversation_id, pm_id, vendor_session_id, cwd, add_dirs, generation, status, created_at, updated_at)
      VALUES (2, 'pm', 2, 1, 'v-2', '/code/foo', '["/code/docs"]', 1, 'ended', 20, 30);
    INSERT INTO agent_sessions (id, role, conversation_id, pm_id, vendor_session_id, cwd, add_dirs, generation, status, created_at, updated_at)
      VALUES (4, 'pm', 2, 2, 'v-4', '/code/foo', '["/code/docs"]', 2, 'idle', 30, 30);
    INSERT INTO handoffs (project_id, from_session_id, to_session_id, from_pm_id, to_pm_id, file, reason, created_at)
      VALUES (1, 2, 4, 1, 2, '/s/handoffs/1/1-x.md', 'reassign', 30);
    INSERT INTO messages (conversation_id, session_id, sender, kind, text, dedupe_key, status, created_at, updated_at)
      VALUES (2, 2, 'user', 'text', '这个文件夹里有什么', 'client:2:a', 'replied', 22, 23);
    INSERT INTO messages (conversation_id, session_id, sender, kind, text, dedupe_key, status, created_at, updated_at)
      VALUES (2, 4, 'user', 'text', '发布日期是哪天', 'client:2:b', 'queued', 31, 31);
    INSERT INTO messages (conversation_id, session_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
      VALUES (3, 3, 'system', 'text', '【系统】项目经理把 foo 交给了你',
              '{"event":"project.reassigned","projectId":1,"handoffId":1,"fromPmId":1,"toPmId":2}', 'system:3:project.reassigned:1', 'replied', 30, 32);
    INSERT INTO actions (type, dedupe_key, params, status, next_attempt_at, created_at, updated_at)
      VALUES ('session.send', '3', '{"sessionId":4,"messageId":3,"source":"user"}', 'pending', 31, 31, 31);
    INSERT INTO hub_calls (session_id, command, args, ok, result, created_at)
      VALUES (2, 'project.assign', '{"project":"foo","to":"阿周"}', 1, '已交给阿周', 30);
    INSERT INTO persona_changes (pm_id, actor, session_id, text_before, text_after, mode_before, mode_after, created_at)
      VALUES (1, 'pm', 2, 'a', 'b', 'manage_only', 'manage_only', 25);
  `);
  return db;
}

function rowCounts(db: Db): Record<string, number> {
  return Object.fromEntries(tableNames(db).map((t) => [t, db.get<{ n: number }>(`SELECT count(*) AS n FROM ${t}`)!.n]));
}

describe("0003_pm_conversation：从 M2 开发时的库升级", () => {
  it("一行不删：老群、群里的消息、交接、hub 调用都还在；老群的项目标归档，群里的会话标已结束，私聊不动", () => {
    const db = m2DevDb();
    const before = rowCounts(db);
    const messagesBefore = db.all("SELECT * FROM messages ORDER BY id");

    expect(migrate(db, migrationsUpTo(3), { now: () => Date.UTC(2026, 10, 3, 12, 0, 0) })).toMatchObject({ from: 2, to: 3, applied: [3] });

    expect(rowCounts(db)).toEqual(before);
    expect(db.all("SELECT * FROM messages ORDER BY id")).toEqual(messagesBefore);
    expect(db.get("SELECT status FROM projects WHERE id = 1")).toEqual({ status: "archived" });
    expect(db.all("SELECT id, status FROM agent_sessions ORDER BY id")).toEqual([
      { id: 1, status: "idle" },
      { id: 2, status: "ended" },
      { id: 3, status: "idle" },
      { id: 4, status: "ended" },
    ]);
    expect(db.all("SELECT path, is_main, removed_at FROM project_folders ORDER BY id")).toEqual([
      { path: "/code/foo", is_main: 1, removed_at: null },
      { path: "/code/docs", is_main: 0, removed_at: null },
    ]);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("升级前把库备份成 hub.sqlite.bak-2-<时间>，里面还是升级前的样子", () => {
    const db = m2DevDb();
    migrate(db, migrationsDir, { now: () => Date.UTC(2026, 10, 3, 12, 0, 0) });
    const backups = readdirSync(dir!).filter((f) => f.startsWith("hub.sqlite.bak-2-"));
    expect(backups).toEqual(["hub.sqlite.bak-2-20261103T120000Z"]);
    const backup = openDatabase(join(dir!, backups[0]!));
    try {
      expect(userVersion(backup)).toBe(2);
      expect(backup.get("SELECT status FROM projects WHERE id = 1")).toEqual({ status: "active" });
    } finally {
      backup.close();
    }
  });

  it("升级后账本：网页上看不到老群和归档的项目；项目经理的会话照常能聊；老群的主文件夹能在私聊里拿来建项目", () => {
    const db = m2DevDb();
    migrate(db, migrationsDir);
    const root = mkdtempSync(join(tmpdir(), "agent-hub-m3-ledger-"));
    extraDirs.push(root);
    const ledger = createLedger(db, { pmHomeRoot: join(root, "pm-home"), resolveFolder: (p) => p });

    const snapshot = ledger.snapshot();
    expect(snapshot.conversations.map((c) => c.conversation.id)).toEqual([1, 3]);
    expect(snapshot.projects).toEqual([]);
    expect(snapshot.folders).toEqual([]);
    expect(snapshot.sessions.map((s) => s.sessionId)).toEqual([1, 3]);
    // 阿周私聊里那条老的“交给了你”系统消息照常显示
    expect(snapshot.conversations.find((c) => c.conversation.id === 3)!.messages.map((m) => m.sender)).toEqual(["system"]);
    expect(() => ledger.postUserMessage({ conversationId: 2, clientId: "c", text: "还在吗" })).toThrow(ConversationNotFoundError);
    expect(() => ledger.requestStop(2)).toThrow(ConversationNotFoundError);
    // 翻老群的更早消息、重试老群里失败的消息：也当老群不存在，什么也不登记
    expect(() => ledger.messagesBefore(2, 99)).toThrow(ConversationNotFoundError);
    db.run("UPDATE messages SET status = 'failed' WHERE id = 3");
    const actionsBefore = db.all("SELECT * FROM actions ORDER BY id");
    expect(() => ledger.retryMessage(3)).toThrow(LedgerRequestError);
    expect(() => ledger.retryMessage(3)).toThrow(/没有编号 3 的消息/);
    expect(db.all("SELECT * FROM actions ORDER BY id")).toEqual(actionsBefore);
    expect(db.get("SELECT status FROM messages WHERE id = 3")).toEqual({ status: "failed" });

    const { messageId } = ledger.postUserMessage({ conversationId: 1, clientId: "c1", text: "在吗" });
    expect(db.get("SELECT session_id, status FROM messages WHERE id = ?", messageId)).toEqual({ session_id: 1, status: "queued" });
    expect(db.get("SELECT params FROM actions WHERE type = 'session.send' AND dedupe_key = ?", String(messageId))).toEqual({
      params: JSON.stringify({ sessionId: 1, messageId, source: "user" }),
    });

    const created = ledger.hubCall(1, "project.create", { folder: "/code/foo" });
    expect(created.data.project).toMatchObject({ name: "foo", pmId: 1, conversationId: 1, status: "active" });
    expect(db.get("SELECT cwd, add_dirs FROM agent_sessions WHERE id = 1")).toEqual({ cwd: "/code/foo", add_dirs: "[]" });
  });
});

describe("0003_pm_conversation：约束", () => {
  it("一个项目经理同时只有一个进行中的项目；归档的不算", () => {
    const db = migratedWithPm();
    db.exec(`
      INSERT INTO conversations (id, kind, pm_id, title, created_at) VALUES (2, 'project_group', 1, 'old', 0);
      INSERT INTO projects (id, name, status, pm_id, conversation_id, created_at, updated_at) VALUES (1, 'old', 'archived', 1, 2, 0, 0);
    `);
    db.run("INSERT INTO projects (id, name, pm_id, conversation_id, created_at, updated_at) VALUES (2, 'foo', 1, 1, 0, 0)");
    db.run("INSERT INTO conversations (id, kind, pm_id, title, created_at) VALUES (3, 'project_group', 1, 'bar', 0)");
    expect(() => db.run("INSERT INTO projects (name, pm_id, conversation_id, created_at, updated_at) VALUES ('bar', 1, 3, 0, 0)")).toThrow(
      /UNIQUE/,
    );
    // 一个对话也只挂一个项目
    db.run("INSERT INTO pms (id, name, created_at) VALUES (2, '阿周', 0)");
    expect(() => db.run("INSERT INTO projects (name, pm_id, conversation_id, created_at, updated_at) VALUES ('baz', 2, 1, 0, 0)")).toThrow(
      /UNIQUE/,
    );
  });

  it("项目名可以重复；主文件夹路径的唯一不在库里限制（账本只拦进行中的项目）", () => {
    const db = migratedWithPm();
    db.exec(`
      INSERT INTO pms (id, name, created_at) VALUES (2, '阿周', 0);
      INSERT INTO conversations (id, kind, pm_id, title, created_at) VALUES (2, 'pm', 2, '阿周', 0);
      INSERT INTO projects (id, name, pm_id, conversation_id, created_at, updated_at) VALUES (1, 'app', 1, 1, 0, 0);
      INSERT INTO projects (id, name, pm_id, conversation_id, created_at, updated_at) VALUES (2, 'app', 2, 2, 0, 0);
      INSERT INTO project_folders (project_id, path, is_main, added_at) VALUES (1, '/code/app', 1, 0);
      INSERT INTO project_folders (project_id, path, is_main, added_at) VALUES (2, '/code/app', 1, 0);
    `);
    expect(db.get("SELECT count(*) AS n FROM project_folders WHERE path = '/code/app'")).toEqual({ n: 2 });
  });
});

// ---- 0004_workers ----

/**
 * M2 发布时的库（user_version 3）：m2DevDb 升到 3，再给项目经理 1 建一个进行中的项目 2（挂在它的私聊 1 上，主文件夹 /code/bar），
 * 私聊里一条项目已建好的系统消息、一个 hub 调用。
 */
function m2Db(): Db {
  const db = m2DevDb();
  migrate(db, migrationsUpTo(3));
  db.exec(`
    INSERT INTO projects (id, name, pm_id, conversation_id, created_at, updated_at) VALUES (2, 'bar', 1, 1, 40, 40);
    INSERT INTO project_folders (project_id, path, is_main, added_at) VALUES (2, '/code/bar', 1, 40);
    UPDATE agent_sessions SET cwd = '/code/bar' WHERE id = 1;
    INSERT INTO messages (conversation_id, sender, kind, text, meta, dedupe_key, created_at, updated_at)
      VALUES (1, 'system', 'text', '项目已建好', '{"event":"project.created","projectId":2}', 'system:1:project.created:2', 40, 40);
    INSERT INTO hub_calls (session_id, command, args, ok, result, created_at) VALUES (1, 'project.create', '{"folder":"/code/bar"}', 1, '已建好', 40);
  `);
  return db;
}

/** 0004 之后：项目经理 1 在项目 2 上派一个 Worker（对话 10、会话 10、Worker 1）。 */
function insertWorker(db: Db, over: Record<string, unknown> = {}): void {
  db.exec(`
    INSERT INTO conversations (id, kind, pm_id, project_id, title, created_at) VALUES (10, 'worker', 1, 2, '修 X', 50);
    INSERT INTO agent_sessions (id, role, conversation_id, worker_id, vendor_session_id, cwd, created_at, updated_at)
      VALUES (10, 'worker', 10, 1, 'v-10', '/h/worktrees/2/1', 50, 50);
  `);
  const row: Record<string, unknown> = {
    id: 1,
    project_id: 2,
    pm_id: 1,
    pm_conversation_id: 1,
    worker_conversation_id: 10,
    title: "修 X",
    task: "把 X 修好",
    model: null,
    readonly: 0,
    workspace: "worktree",
    branch: "hub/1-修-x",
    worktree_path: "/h/worktrees/2/1",
    base_commit: null,
    status: "open",
    created_at: 50,
    updated_at: 50,
    ...over,
  };
  const cols = Object.keys(row);
  db.run(`INSERT INTO workers (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...(Object.values(row) as never[]));
}

describe("0004_workers：从 M2 的库升级", () => {
  it("user_version 升到 4，老数据一行不少、一个字不变；多了空的 workers 表", () => {
    const db = m2Db();
    const before = rowCounts(db);
    const dump = Object.fromEntries(tableNames(db).map((t) => [t, db.all(`SELECT * FROM ${t} ORDER BY rowid`)]));

    expect(migrate(db, migrationsUpTo(4))).toMatchObject({ from: 3, to: 4, applied: [4] });

    expect(userVersion(db)).toBe(4);
    expect(rowCounts(db)).toEqual({ ...before, workers: 0 });
    // 值一个不变；只有 agent_sessions、messages 的 ticket_id 改名 worker_id（位置不变）
    const renamed = (rows: unknown[]) =>
      rows.map((r) => Object.fromEntries(Object.entries(r as Record<string, unknown>).map(([k, v]) => [k === "ticket_id" ? "worker_id" : k, v])));
    for (const [table, rows] of Object.entries(dump)) expect(db.all(`SELECT * FROM ${table} ORDER BY rowid`)).toEqual(renamed(rows));
    const columns = (table: string) => db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).map((c) => c.name);
    for (const table of ["agent_sessions", "messages"]) {
      expect(columns(table)).toContain("worker_id");
      expect(columns(table)).not.toContain("ticket_id");
    }
    expect(Object.keys(dump.agent_sessions![0] as object)).toContain("ticket_id");
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
  });

  it("升级前把库备份成 hub.sqlite.bak-3-<时间>，里面还是升级前的样子", () => {
    const db = m2Db();
    migrate(db, migrationsDir, { now: () => Date.UTC(2026, 10, 4, 8, 0, 0) });
    expect(readdirSync(dir!).filter((f) => f.startsWith("hub.sqlite.bak-3-"))).toEqual(["hub.sqlite.bak-3-20261104T080000Z"]);
    const backup = openDatabase(join(dir!, "hub.sqlite.bak-3-20261104T080000Z"));
    try {
      expect(userVersion(backup)).toBe(3);
      expect(tableNames(backup)).not.toContain("workers");
      expect(backup.get("SELECT count(*) AS n FROM messages")).toEqual({ n: 5 });
    } finally {
      backup.close();
    }
  });

  it("重复执行什么也不做，不再备份", () => {
    const db = m2Db();
    const upTo4 = migrationsUpTo(4);
    migrate(db, upTo4);
    insertWorker(db);
    const backups = readdirSync(dir!).filter((f) => f.includes(".bak-"));
    expect(migrate(db, upTo4)).toEqual({ from: 4, to: 4, applied: [] });
    expect(readdirSync(dir!).filter((f) => f.includes(".bak-"))).toEqual(backups);
    expect(db.get("SELECT count(*) AS n FROM workers")).toEqual({ n: 1 });
  });

  it("重建 conversations 后索引还在：一个项目经理只有一个私聊，一个项目只有一个群；别的表指向它的外键照常生效", () => {
    const db = m2Db();
    migrate(db, migrationsDir);
    const indexes = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'conversations' AND sql IS NOT NULL ORDER BY name")
      .map((r) => r.name);
    expect(indexes).toEqual(["conversations_pm_private", "conversations_project_group"]);
    expect(() => db.run("INSERT INTO conversations (kind, pm_id, title, created_at) VALUES ('pm', 1, 'x', 0)")).toThrow(/UNIQUE/);
    expect(() => db.run("INSERT INTO conversations (kind, pm_id, project_id, title, created_at) VALUES ('project_group', 1, 1, 'x', 0)")).toThrow(
      /UNIQUE/,
    );
    expect(() => db.run("INSERT INTO conversations (kind, pm_id, title, created_at) VALUES ('pm', 99, 'x', 0)")).toThrow(/FOREIGN KEY/);
    expect(() => db.run("DELETE FROM conversations WHERE id = 1")).toThrow(/FOREIGN KEY/);
    expect(() =>
      db.run("INSERT INTO messages (conversation_id, sender, kind, text, dedupe_key, created_at, updated_at) VALUES (99, 'user', 'text', 'x', 'k', 0, 0)"),
    ).toThrow(/FOREIGN KEY/);
  });

  it("升级后账本照常：快照、发消息、项目经理的会话都在", () => {
    const db = m2Db();
    migrate(db, migrationsDir);
    const root = mkdtempSync(join(tmpdir(), "agent-hub-m4-ledger-"));
    extraDirs.push(root);
    const ledger = createLedger(db, { pmHomeRoot: join(root, "pm-home"), resolveFolder: (p) => p });
    expect(ledger.snapshot().conversations.map((c) => c.conversation.id)).toEqual([1, 3]);
    expect(ledger.snapshot().projects.map((p) => p.id)).toEqual([2]);
    const { messageId } = ledger.postUserMessage({ conversationId: 1, clientId: "c1", text: "在吗" });
    expect(db.get("SELECT session_id, status FROM messages WHERE id = ?", messageId)).toEqual({ session_id: 1, status: "queued" });
  });
});

describe("0004_workers：约束", () => {
  function migratedM2(): Db {
    const db = m2Db();
    migrate(db, migrationsUpTo(4));
    return db;
  }

  it("对话可以是 worker；别的新取值仍然被拒", () => {
    const db = migratedM2();
    db.run("INSERT INTO conversations (kind, pm_id, project_id, title, created_at) VALUES ('worker', 1, 2, '修 X', 0)");
    // Worker 的对话一个项目经理可以有好几个
    db.run("INSERT INTO conversations (kind, pm_id, project_id, title, created_at) VALUES ('worker', 1, 2, '修 Y', 0)");
    expect(() => db.run("INSERT INTO conversations (kind, title, created_at) VALUES ('ticket', 'x', 0)")).toThrow(/CHECK/);
  });

  it("workers 表：所有列都在，默认 open、不只读；读回来和写进去一样", () => {
    const db = migratedM2();
    insertWorker(db);
    expect(db.get("SELECT * FROM workers WHERE id = 1")).toEqual({
      id: 1,
      project_id: 2,
      pm_id: 1,
      pm_conversation_id: 1,
      worker_conversation_id: 10,
      title: "修 X",
      task: "把 X 修好",
      model: null,
      readonly: 0,
      workspace: "worktree",
      branch: "hub/1-修-x",
      worktree_path: "/h/worktrees/2/1",
      base_commit: null,
      status: "open",
      created_at: 50,
      updated_at: 50,
    });
    db.run("UPDATE workers SET base_commit = 'abc123', status = 'ended' WHERE id = 1");
    db.run("INSERT INTO conversations (id, kind, pm_id, project_id, title, created_at) VALUES (11, 'worker', 1, 2, '查 Y', 0)");
    db.run(
      "INSERT INTO workers (project_id, pm_id, pm_conversation_id, worker_conversation_id, title, task, workspace, created_at, updated_at) VALUES (2, 1, 1, 11, '查 Y', '看看 Y', 'main', 0, 0)",
    );
    expect(db.get("SELECT status, readonly, branch, worktree_path, base_commit FROM workers WHERE id = 2")).toEqual({
      status: "open",
      readonly: 0,
      branch: null,
      worktree_path: null,
      base_commit: null,
    });
  });

  it("Worker 的状态、在哪干活、只读只能是规定的值", () => {
    const db = migratedM2();
    expect(() => insertWorker(db, { status: "done" })).toThrow(/CHECK/);
    db.exec("DELETE FROM agent_sessions WHERE id = 10; DELETE FROM conversations WHERE id = 10;");
    expect(() => insertWorker(db, { workspace: "elsewhere" })).toThrow(/CHECK/);
    db.exec("DELETE FROM agent_sessions WHERE id = 10; DELETE FROM conversations WHERE id = 10;");
    expect(() => insertWorker(db, { readonly: 2 })).toThrow(/CHECK/);
  });

  it("在主文件夹里干活的 Worker 没有分支、worktree、起点提交", () => {
    const db = migratedM2();
    expect(() => insertWorker(db, { workspace: "main" })).toThrow(/CHECK/);
    db.exec("DELETE FROM agent_sessions WHERE id = 10; DELETE FROM conversations WHERE id = 10;");
    insertWorker(db, { workspace: "main", branch: null, worktree_path: null });
    expect(db.get("SELECT workspace FROM workers WHERE id = 1")).toEqual({ workspace: "main" });
  });

  it("一个 Worker 对话只属于一个 Worker；项目、项目经理、对话都得是真的", () => {
    const db = migratedM2();
    insertWorker(db);
    expect(() =>
      db.run(
        "INSERT INTO workers (project_id, pm_id, pm_conversation_id, worker_conversation_id, title, task, workspace, created_at, updated_at) VALUES (2, 1, 1, 10, 'x', 'y', 'main', 0, 0)",
      ),
    ).toThrow(/UNIQUE/);
    const bad = (cols: string) =>
      db.run(
        `INSERT INTO workers (project_id, pm_id, pm_conversation_id, worker_conversation_id, title, task, workspace, created_at, updated_at) VALUES (${cols}, 'x', 'y', 'main', 0, 0)`,
      );
    db.run("INSERT INTO conversations (id, kind, pm_id, project_id, title, created_at) VALUES (12, 'worker', 1, 2, 'z', 0)");
    expect(() => bad("99, 1, 1, 12")).toThrow(/FOREIGN KEY/);
    expect(() => bad("2, 99, 1, 12")).toThrow(/FOREIGN KEY/);
    expect(() => bad("2, 1, 99, 12")).toThrow(/FOREIGN KEY/);
    expect(() => bad("2, 1, 1, 99")).toThrow(/FOREIGN KEY/);
  });
});

// ---- 0006_agent_settings ----

/** M3 发布时的库（user_version 4）：m2Db 升到 4，项目经理 1 的模型是 opus，派过一个 Worker，有一条性格设定修改。 */
function m3Db(): Db {
  const db = m2Db();
  migrate(db, migrationsUpTo(4));
  db.exec("UPDATE pms SET default_model = 'opus' WHERE id = 1; UPDATE agent_sessions SET model = 'opus' WHERE id = 1;");
  insertWorker(db, { model: "haiku" });
  return db;
}

describe("0006_agent_settings：从 M3 的库升级", () => {
  it("只加列：老数据一个字不变；厂商是 claude，思考程度是默认（NULL）", () => {
    const db = m3Db();
    const tables = ["pms", "agent_sessions", "workers", "persona_changes"];
    const dump = Object.fromEntries(tables.map((t) => [t, db.all<Record<string, unknown>>(`SELECT * FROM ${t} ORDER BY rowid`)]));
    expect(migrate(db, migrationsDir)).toMatchObject({ from: 4, to: LATEST_VERSION });
    expect(db.all("SELECT * FROM pms ORDER BY id")).toEqual(dump.pms!.map((r) => ({ ...r, vendor: "claude", effort: null })));
    expect(db.all("SELECT * FROM agent_sessions ORDER BY id")).toEqual(dump.agent_sessions!.map((r) => ({ ...r, effort: null })));
    expect(db.all("SELECT * FROM workers ORDER BY id")).toEqual(dump.workers!.map((r) => ({ ...r, effort: null })));
    // 老的修改记录：前后都是项目经理现在的值
    expect(db.all("SELECT * FROM persona_changes ORDER BY id")).toEqual(
      dump.persona_changes!.map((r) => ({
        ...r,
        vendor_before: "claude",
        vendor_after: "claude",
        model_before: r.pm_id === 1 ? "opus" : null,
        model_after: r.pm_id === 1 ? "opus" : null,
        effort_before: null,
        effort_after: null,
      })),
    );
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("升级后账本：资料页是 Claude Code、原来的模型、默认思考程度；Worker 记录的思考程度是默认", () => {
    const db = m3Db();
    migrate(db, migrationsDir);
    const root = mkdtempSync(join(tmpdir(), "agent-hub-m6-ledger-"));
    extraDirs.push(root);
    const ledger = createLedger(db, { pmHomeRoot: join(root, "pm-home"), resolveFolder: (p) => p });
    expect(ledger.getPersona(1)).toMatchObject({ vendor: "claude", model: "opus", effort: null });
    expect(ledger.snapshot().pms.find((p) => p.id === 1)).toMatchObject({ vendor: "claude", defaultModel: "opus", effort: null });
    expect(ledger.getPersona(1).changes[0]).toMatchObject({ modelBefore: "opus", modelAfter: "opus", effortBefore: null, effortAfter: null });
    expect(ledger.hubCall(1, "worker.list", {}).data.workers[0]).toMatchObject({ model: "haiku", effort: null });
  });
});

describe("迁移器：迁移期间关外键，提交前检查", () => {
  it("迁移留下悬空引用就整个回滚，user_version 不变，外键检查恢复", () => {
    const dir = m1MigrationsDir();
    writeFileSync(join(dir, "0002_bad.sql"), "INSERT INTO conversations (kind, pm_id, title, created_at) VALUES ('pm', 42, 'x', 0);");
    const db = open();
    // 报错里带出是哪些行
    expect(() => migrate(db, dir)).toThrow(/0002_bad\.sql.*foreign key.*conversations rowid 1 → pms/i);
    expect(userVersion(db)).toBe(1);
    expect(db.get("SELECT count(*) AS n FROM conversations")).toEqual({ n: 0 });
    expect(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
  });
});

describe("迁移器：不能在外层事务里调", () => {
  it("在事务里调直接报一句看得懂的错，什么也不改", () => {
    const db = open();
    migrate(db, m1MigrationsDir());
    expect(() => db.transaction(() => migrate(db, migrationsDir))).toThrow(/inside a transaction/);
    expect(userVersion(db)).toBe(1);
  });
});

// ---- 0005_project_setup ----

describe("0005_project_setup：从 M3 的库升级（老项目没有准备命令这一列）", () => {
  /** M3 发布时的库（user_version 4）：m2Db 升到 4，再派一个 Worker。 */
  function m3Db(): Db {
    const db = m2Db();
    migrate(db, migrationsUpTo(4));
    insertWorker(db);
    return db;
  }

  it("28 user_version 升到 5，老数据一行不少、一个字不变；projects 多一列 setup_command，老项目是 NULL", () => {
    const db = m3Db();
    const before = rowCounts(db);
    const dump = Object.fromEntries(tableNames(db).map((t) => [t, db.all(`SELECT * FROM ${t} ORDER BY rowid`)]));

    const upTo5 = migrationsUpTo(5);
    expect(migrate(db, upTo5, { now: () => Date.UTC(2026, 10, 4, 9, 0, 0) })).toMatchObject({ from: 4, to: 5, applied: [5] });

    expect(userVersion(db)).toBe(5);
    expect(rowCounts(db)).toEqual(before);
    for (const [table, rows] of Object.entries(dump)) {
      const now = db.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY rowid`);
      if (table !== "projects") {
        expect(now).toEqual(rows);
        continue;
      }
      expect(now).toEqual((rows as Record<string, unknown>[]).map((r) => ({ ...r, setup_command: null })));
    }
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(db.get("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
    expect(readdirSync(dir!).filter((f) => f.startsWith("hub.sqlite.bak-4-"))).toEqual(["hub.sqlite.bak-4-20261104T090000Z"]);
    expect(migrate(db, upTo5)).toEqual({ from: 5, to: 5, applied: [] });
  });

  it("28b 升级后账本照常读老项目：准备命令当作没配", () => {
    const db = m3Db();
    migrate(db, migrationsDir);
    const ledger = createLedger(db, { pmHomeRoot: join(dir!, "pm-home"), resolveFolder: (p) => p });
    expect(ledger.getWorktreeTask(1)).toMatchObject({ workerId: 1, setupCommand: null });
  });
});
