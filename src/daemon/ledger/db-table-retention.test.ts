import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACTIONS_TERMINAL_MAX_ROWS,
  ACTIONS_TERMINAL_RETENTION_MS,
  ENDED_WORKER_STEPS_KEEP,
  HANDOVERS_MAX_PER_CONV,
  HANDOVERS_RETENTION_MS,
  HUB_CALLS_MAX_ROWS,
  HUB_CALLS_RETENTION_MS,
  PERSONA_CHANGES_LIMIT,
  PM_TOOL_MESSAGES_MAX_PER_CONV,
  PM_TOOL_MESSAGE_RETENTION_MS,
} from "../../shared/limits.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createLedgerContext } from "./context.ts";
import { createDbTableRetention, type DbTableRetention } from "./db-table-retention.ts";

const T0 = 1_700_000_000_000;

let db: Db;
let root: string;
let retention: DbTableRetention;
let pmId: number;
let pmConvId: number;
let pmSessionId: number;
let workerConvId: number;
let workerSessionId: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "db-table-retention-"));
  db = openTestDb();
  const ctx = createLedgerContext(db, { now: () => T0 });
  retention = createDbTableRetention(ctx);
  pmId = Number(db.run("INSERT INTO pms (name, mode, persona, vendor, created_at) VALUES ('PM', 'manage_only', '', 'claude', ?)", T0).lastInsertRowid);
  pmConvId = Number(db.run("INSERT INTO conversations (kind, pm_id, title, created_at) VALUES ('pm', ?, 'PM', ?)", pmId, T0).lastInsertRowid);
  pmSessionId = Number(
    db.run(
      `INSERT INTO agent_sessions (role, conversation_id, pm_id, vendor, vendor_session_id, cwd, add_dirs, generation, status, created_at, updated_at)
       VALUES ('pm', ?, ?, 'claude', 'pm-v1', '/tmp', '[]', 1, 'idle', ?, ?)`,
      pmConvId,
      pmId,
      T0,
      T0,
    ).lastInsertRowid,
  );
  workerConvId = Number(db.run("INSERT INTO conversations (kind, pm_id, title, created_at) VALUES ('worker', ?, 'W', ?)", pmId, T0).lastInsertRowid);
  workerSessionId = Number(
    db.run(
      `INSERT INTO agent_sessions (role, conversation_id, pm_id, vendor, vendor_session_id, cwd, add_dirs, generation, status, created_at, updated_at)
       VALUES ('worker', ?, NULL, 'claude', 'w-v1', '/tmp', '[]', 1, 'ended', ?, ?)`,
      workerConvId,
      T0,
      T0,
    ).lastInsertRowid,
  );
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const count = (table: string, where = "1 = 1", ...params: (string | number)[]): number =>
  db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, ...params)!.n;

describe("createDbTableRetention", () => {
  it("purges PM conversation kind='tool' messages past PM_TOOL_MESSAGE_RETENTION_MS or above PM_TOOL_MESSAGES_MAX_PER_CONV without deleting text, ask, worker, or system messages", () => {
    const oldAt = T0 - PM_TOOL_MESSAGE_RETENTION_MS - 1_000;
    const freshAt = T0 - 1_000;
    db.exec("BEGIN");
    // Non-tool rows in PM conversation (even very old) must never be deleted.
    db.run(
      `INSERT INTO messages (conversation_id, session_id, sender, kind, text, meta, dedupe_key, created_at, updated_at)
       VALUES (?, ?, 'user', 'text', 'user msg', NULL, 'u1', ?, ?),
              (?, ?, 'agent', 'text', 'ask msg', '{"needsUser":true}', 'a1', ?, ?),
              (?, ?, 'system', 'worker', 'worker line', '{}', 'w1', ?, ?),
              (?, ?, 'system', 'text', 'system note', '{}', 's1', ?, ?)`,
      pmConvId, pmSessionId, oldAt, oldAt,
      pmConvId, pmSessionId, oldAt, oldAt,
      pmConvId, pmSessionId, oldAt, oldAt,
      pmConvId, pmSessionId, oldAt, oldAt,
    );
    // Worker conversation tool row must not be touched by PM tool purge.
    db.run(
      `INSERT INTO messages (conversation_id, session_id, sender, kind, text, dedupe_key, created_at, updated_at)
       VALUES (?, ?, 'agent', 'tool', 'Read: x.ts', 'wt:1', ?, ?)`,
      workerConvId,
      workerSessionId,
      oldAt,
      oldAt,
    );
    // 5 old PM tool rows + (PM_TOOL_MESSAGES_MAX_PER_CONV + 25) fresh PM tool rows.
    for (let i = 0; i < 5; i++) {
      db.run(
        "INSERT INTO messages (conversation_id, session_id, sender, kind, text, dedupe_key, created_at, updated_at) VALUES (?, ?, 'agent', 'tool', 'Read', ?, ?, ?)",
        pmConvId, pmSessionId, `old-tool:${i}`, oldAt + i, oldAt + i,
      );
    }
    for (let i = 0; i < PM_TOOL_MESSAGES_MAX_PER_CONV + 25; i++) {
      db.run(
        "INSERT INTO messages (conversation_id, session_id, sender, kind, text, dedupe_key, created_at, updated_at) VALUES (?, ?, 'agent', 'tool', 'Read', ?, ?, ?)",
        pmConvId, pmSessionId, `fresh-tool:${i}`, freshAt + i, freshAt + i,
      );
    }
    db.exec("COMMIT");

    const res = retention.purgePmToolMessagesBatch(T0, 1_000);
    expect(res).toEqual({ rows: 30, more: false });
    expect(count("messages", "conversation_id = ? AND kind = 'tool'", pmConvId)).toBe(PM_TOOL_MESSAGES_MAX_PER_CONV);
    expect(count("messages", "conversation_id = ? AND kind != 'tool'", pmConvId)).toBe(4);
    expect(count("messages", "conversation_id = ? AND kind = 'tool'", workerConvId)).toBe(1);
  });

  it("purges terminal actions past ACTIONS_TERMINAL_RETENTION_MS or above ACTIONS_TERMINAL_MAX_ROWS while keeping pending and running actions", () => {
    const oldAt = T0 - ACTIONS_TERMINAL_RETENTION_MS - 1_000;
    const freshAt = T0 - 1_000;
    db.exec("BEGIN");
    db.run(
      `INSERT INTO actions (type, params, status, attempts, next_attempt_at, dedupe_key, created_at, updated_at)
       VALUES ('session.send', '{}', 'pending', 0, ?, 'act:p1', ?, ?),
              ('session.send', '{}', 'running', 1, ?, 'act:r1', ?, ?)`,
      oldAt, oldAt, oldAt,
      oldAt, oldAt, oldAt,
    );
    for (let i = 0; i < 10; i++) {
      db.run(
        "INSERT INTO actions (type, params, status, attempts, next_attempt_at, dedupe_key, created_at, updated_at) VALUES ('session.send', '{}', 'done', 1, ?, ?, ?, ?)",
        oldAt, `act:old:${i}`, oldAt, oldAt,
      );
    }
    for (let i = 0; i < ACTIONS_TERMINAL_MAX_ROWS + 15; i++) {
      db.run(
        "INSERT INTO actions (type, params, status, attempts, next_attempt_at, dedupe_key, created_at, updated_at) VALUES ('session.send', '{}', 'failed', 1, ?, ?, ?, ?)",
        freshAt, `act:fresh:${i}`, freshAt, freshAt,
      );
    }
    db.exec("COMMIT");

    const res = retention.purgeTerminalActionsBatch(T0, 1_000);
    expect(res).toEqual({ rows: 25, more: false });
    expect(count("actions", "status IN ('pending', 'running')")).toBe(2);
    expect(count("actions", "status IN ('done', 'failed', 'abandoned')")).toBe(ACTIONS_TERMINAL_MAX_ROWS);
  });

  it("purges hub_calls past HUB_CALLS_RETENTION_MS or above HUB_CALLS_MAX_ROWS", () => {
    const oldAt = T0 - HUB_CALLS_RETENTION_MS - 1_000;
    const freshAt = T0 - 1_000;
    db.exec("BEGIN");
    for (let i = 0; i < 5; i++) {
      db.run(
        "INSERT INTO hub_calls (session_id, command, args, ok, result, created_at) VALUES (?, 'status', '{}', 1, 'ok', ?)",
        pmSessionId, oldAt,
      );
    }
    for (let i = 0; i < HUB_CALLS_MAX_ROWS + 12; i++) {
      db.run(
        "INSERT INTO hub_calls (session_id, command, args, ok, result, created_at) VALUES (?, 'status', '{}', 1, 'ok', ?)",
        pmSessionId, freshAt,
      );
    }
    db.exec("COMMIT");

    const res = retention.purgeHubCallsBatch(T0, 1_000);
    expect(res).toEqual({ rows: 17, more: false });
    expect(count("hub_calls")).toBe(HUB_CALLS_MAX_ROWS);
  });

  it("clears consumed preamble and skills_section blobs on switched handovers and prunes old terminal handovers beyond HANDOVERS_MAX_PER_CONV while keeping the latest switched anchor", () => {
    const oldAt = T0 - HANDOVERS_RETENTION_MS - 1_000;
    const freshAt = T0 - 1_000;
    const seenSessionId = Number(
      db.run(
        `INSERT INTO agent_sessions (role, conversation_id, pm_id, vendor, vendor_session_id, cwd, add_dirs, generation, status, created_at, updated_at)
         VALUES ('pm', ?, ?, 'claude', 'pm-v2', '/tmp', '[]', 2, 'idle', ?, ?)`,
        pmConvId, pmId, freshAt, freshAt,
      ).lastInsertRowid,
    );
    const unseenSessionId = Number(
      db.run(
        `INSERT INTO agent_sessions (role, conversation_id, pm_id, vendor, vendor_session_id, cwd, add_dirs, generation, status, created_at, updated_at)
         VALUES ('pm', ?, ?, 'claude', 'pm-v3', '/tmp', '[]', 3, 'idle', ?, ?)`,
        pmConvId, pmId, freshAt, freshAt,
      ).lastInsertRowid,
    );
    db.run("INSERT INTO session_preamble_seen (session_id, seen_at) VALUES (?, ?)", seenSessionId, freshAt);

    db.exec("BEGIN");
    // Active handover must never be deleted.
    db.run(
      "INSERT INTO handovers (conversation_id, from_session_id, to_session_id, auto, status, created_at, updated_at) VALUES (?, ?, NULL, 0, 'writing', ?, ?)",
      pmConvId, pmSessionId, oldAt, oldAt,
    );
    // Many old failed handovers + excess fresh switched handovers.
    for (let i = 0; i < HANDOVERS_MAX_PER_CONV + 5; i++) {
      db.run(
        "INSERT INTO handovers (conversation_id, from_session_id, to_session_id, auto, status, created_at, updated_at) VALUES (?, ?, NULL, 0, 'failed', ?, ?)",
        pmConvId, pmSessionId, i < 3 ? oldAt : freshAt, i < 3 ? oldAt : freshAt,
      );
    }
    const seenHandoverId = Number(
      db.run(
        "INSERT INTO handovers (conversation_id, from_session_id, to_session_id, auto, status, preamble, skills_section, created_at, updated_at) VALUES (?, ?, ?, 0, 'switched', 'big-p', 'big-s', ?, ?)",
        pmConvId, pmSessionId, seenSessionId, freshAt, freshAt,
      ).lastInsertRowid,
    );
    const latestAnchorId = Number(
      db.run(
        "INSERT INTO handovers (conversation_id, from_session_id, to_session_id, auto, status, preamble, skills_section, created_at, updated_at) VALUES (?, ?, ?, 0, 'switched', 'keep-p', 'keep-s', ?, ?)",
        pmConvId, seenSessionId, unseenSessionId, oldAt, oldAt,
      ).lastInsertRowid,
    );
    db.exec("COMMIT");

    const res = retention.purgeHandoversBatch(T0, 500);
    expect(res.rows).toBeGreaterThan(0);
    expect(res.more).toBe(false);
    // Seen handover had its blobs cleared.
    expect(db.get("SELECT preamble, skills_section FROM handovers WHERE id = ?", seenHandoverId)).toEqual({
      preamble: null,
      skills_section: null,
    });
    // Latest switched anchor survives even though its timestamp is old, and its unseen preamble stays intact.
    expect(db.get("SELECT id, preamble, skills_section FROM handovers WHERE id = ?", latestAnchorId)).toEqual({
      id: latestAnchorId,
      preamble: "keep-p",
      skills_section: "keep-s",
    });
    // Active handover survives.
    expect(count("handovers", "status = 'writing'")).toBe(1);
    // Total terminal handovers bounded to HANDOVERS_MAX_PER_CONV (including the preserved anchor).
    expect(count("handovers", "status IN ('switched', 'failed', 'abandoned')")).toBeLessThanOrEqual(HANDOVERS_MAX_PER_CONV);

    // Direct helper clearConsumedHandoverBlobs clears target session blobs.
    expect(retention.clearConsumedHandoverBlobs(unseenSessionId)).toBe(1);
    expect(db.get("SELECT preamble, skills_section FROM handovers WHERE id = ?", latestAnchorId)).toEqual({
      preamble: null,
      skills_section: null,
    });
  });

  it("prunes persona_changes beyond PERSONA_CHANGES_LIMIT per PM after clearing revert_of references", () => {
    db.exec("BEGIN");
    let firstId = 0;
    for (let i = 0; i < PERSONA_CHANGES_LIMIT + 10; i++) {
      const id = Number(
        db.run(
          `INSERT INTO persona_changes (pm_id, actor, session_id, text_before, text_after, mode_before, mode_after, revert_of, created_at)
           VALUES (?, 'user', ?, 'a', 'b', 'manage_only', 'manage_only', ?, ?)`,
          pmId,
          pmSessionId,
          i === PERSONA_CHANGES_LIMIT + 5 ? firstId : null,
          T0 + i,
        ).lastInsertRowid,
      );
      if (i === 0) firstId = id;
    }
    db.exec("COMMIT");

    const res = retention.prunePersonaChangesBatch(100);
    expect(res).toEqual({ rows: 10, more: false });
    expect(count("persona_changes", "pm_id = ?", pmId)).toBe(PERSONA_CHANGES_LIMIT);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("trims session_steps for an ended Worker down to ENDED_WORKER_STEPS_KEEP newest rows", () => {
    db.exec("BEGIN");
    for (let i = 0; i < ENDED_WORKER_STEPS_KEEP + 75; i++) {
      db.run(
        "INSERT INTO session_steps (session_id, kind, at, summary) VALUES (?, 'tool', ?, ?)",
        workerSessionId,
        T0 + i,
        `step-${i}`,
      );
    }
    db.exec("COMMIT");

    const deleted = retention.trimEndedWorkerSteps(workerSessionId);
    expect(deleted).toBe(75);
    expect(count("session_steps", "session_id = ?", workerSessionId)).toBe(ENDED_WORKER_STEPS_KEEP);
    const oldestRemaining = db.get<{ summary: string }>(
      "SELECT summary FROM session_steps WHERE session_id = ? ORDER BY id ASC LIMIT 1",
      workerSessionId,
    );
    expect(oldestRemaining?.summary).toBe("step-75");
  });

  it("respects maxRows per batch and reports more=true when additional rows remain", () => {
    const oldAt = T0 - HUB_CALLS_RETENTION_MS - 1_000;
    db.exec("BEGIN");
    for (let i = 0; i < 15; i++) {
      db.run(
        "INSERT INTO hub_calls (session_id, command, args, ok, result, created_at) VALUES (?, 'status', '{}', 1, 'ok', ?)",
        pmSessionId,
        oldAt + i,
      );
    }
    db.exec("COMMIT");

    const b1 = retention.purgeHubCallsBatch(T0, 6);
    expect(b1).toEqual({ rows: 6, more: true });
    const b2 = retention.purgeHubCallsBatch(T0, 6);
    expect(b2).toEqual({ rows: 6, more: true });
    const b3 = retention.purgeHubCallsBatch(T0, 6);
    expect(b3).toEqual({ rows: 3, more: false });
    expect(count("hub_calls")).toBe(0);
  });
});
