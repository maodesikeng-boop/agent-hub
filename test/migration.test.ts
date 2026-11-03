import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/daemon/store/db.ts";
import type { Db } from "../src/daemon/store/db.ts";
import { migrate, userVersion } from "../src/daemon/store/migrate.ts";

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

/** 只有 0001 的迁移目录：模拟 M1 的守护进程建出来的库。 */
function m1MigrationsDir(): string {
  const m1 = mkdtempSync(join(tmpdir(), "agent-hub-m1-"));
  copyFileSync(join(migrationsDir, "0001_init.sql"), join(m1, "0001_init.sql"));
  extraDirs.push(m1);
  return m1;
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

    expect(migrate(db, migrationsDir)).toMatchObject({ from: 1, to: 2, applied: [2] });
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
    migrate(db, migrationsDir, { now: () => Date.UTC(2026, 10, 3, 9, 8, 7) });
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
      expect(migrate(memory, migrationsDir)).toMatchObject({ applied: [2] });
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
    migrate(db, migrationsDir);
    expect(migrate(db, migrationsDir)).toEqual({ from: 2, to: 2, applied: [] });
    expect(db.get("SELECT count(*) AS n FROM pms")).toEqual({ n: 2 });
  });

  it("空库连跑 0001、0002 没有报错", () => {
    const db = open();
    expect(migrate(db, migrationsDir)).toEqual({ from: 0, to: 2, applied: [1, 2] });
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

  it("进行中的项目名字唯一；归档了的不占名字", () => {
    const db = migratedWithPm();
    seedProject(db);
    db.run("INSERT INTO conversations (id, kind, pm_id, title, created_at) VALUES (3, 'project_group', 1, 'foo', 0)");
    expect(() =>
      db.run("INSERT INTO projects (name, pm_id, conversation_id, created_at, updated_at) VALUES ('foo', 1, 3, 0, 0)"),
    ).toThrow(/UNIQUE/);
    db.run("UPDATE projects SET status = 'archived' WHERE id = 1");
    db.run("INSERT INTO projects (name, pm_id, conversation_id, created_at, updated_at) VALUES ('foo', 1, 3, 0, 0)");
    expect(() => db.run("UPDATE projects SET status = 'paused' WHERE id = 1")).toThrow(/CHECK/);
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

  it("同一个真实路径只能当一个项目的主文件夹；当别的项目的附加文件夹可以", () => {
    const db = migratedWithPm();
    seedProject(db);
    db.exec(`
      INSERT INTO conversations (id, kind, pm_id, title, created_at) VALUES (3, 'project_group', 1, 'bar', 0);
      INSERT INTO projects (id, name, pm_id, conversation_id, created_at, updated_at) VALUES (2, 'bar', 1, 3, 0, 0);
    `);
    expect(() => db.run("INSERT INTO project_folders (project_id, path, is_main, added_at) VALUES (2, '/code/foo', 1, 0)")).toThrow(
      /UNIQUE/,
    );
    db.run("INSERT INTO project_folders (project_id, path, is_main, added_at) VALUES (2, '/code/foo', 0, 0)");
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
      ["projects.conversation_id", "INSERT INTO projects (name, pm_id, conversation_id, created_at, updated_at) VALUES ('bar', 1, 99, 0, 0)"],
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

  it("主文件夹路径唯一只算没移除的：换下来、标了移除的旧主文件夹不占路径", () => {
    const db = migratedWithPm();
    seedProject(db);
    db.exec(`
      INSERT INTO conversations (id, kind, pm_id, title, created_at) VALUES (3, 'project_group', 1, 'bar', 0);
      INSERT INTO projects (id, name, pm_id, conversation_id, created_at, updated_at) VALUES (2, 'bar', 1, 3, 0, 0);
    `);
    // 以后换主文件夹的做法：先把 is_main 改成 0 再标移除（主文件夹本身不能标移除）
    db.run("UPDATE project_folders SET is_main = 0, removed_at = 5 WHERE project_id = 1 AND path = '/code/foo'");
    db.run("INSERT INTO project_folders (project_id, path, is_main, added_at) VALUES (1, '/code/foo-new', 1, 5)");
    db.run("INSERT INTO project_folders (project_id, path, is_main, added_at) VALUES (2, '/code/foo', 1, 6)");
    expect(db.get("SELECT count(*) AS n FROM project_folders WHERE path = '/code/foo'")).toEqual({ n: 2 });
  });

  it("pms 有 persona_file_hash 列：上次成功写入文件的内容哈希，新建的是 NULL", () => {
    const db = migratedWithPm();
    expect(db.get("SELECT persona_file_hash FROM pms WHERE id = 1")).toEqual({ persona_file_hash: null });
    db.run("UPDATE pms SET persona_file_hash = 'abc' WHERE id = 1");
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
