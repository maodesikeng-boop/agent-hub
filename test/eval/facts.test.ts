// Verifies test/eval/facts.ts reads turn counts from the 0058 turns table with pre-0058 fallback.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { countPmTurns, readMetrics } from "./facts.ts";
import type { Facts } from "./types.ts";

const root = mkdtempSync(join(tmpdir(), "ah-eval-facts-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function makeFacts(pmSessionIds: number[]): Facts {
  return {
    pmConversationId: 1,
    pmSessionIds,
    startedAt: 1000,
    endedAt: 5000,
    hubCalls: [],
    workers: [],
    graphs: [],
    tools: [],
    messages: [],
    gh: [],
    recorded: [],
    personaChanges: [],
    personaSeen: [],
    injected: [],
  };
}

describe("facts turn counting (0058 turns table + pre-0058 fallback)", () => {
  it("prefers the 0058 turns table over legacy session_steps", () => {
    const dbFile = join(root, "v0058.sqlite");
    const db = new DatabaseSync(dbFile);
    try {
      db.exec(`
        CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, role TEXT, conversation_id INTEGER, token_usage TEXT);
        CREATE TABLE turns (id INTEGER PRIMARY KEY, session_id INTEGER, conversation_id INTEGER, outcome TEXT);
        CREATE TABLE session_steps (id INTEGER PRIMARY KEY, session_id INTEGER, kind TEXT);
        CREATE TABLE messages (id INTEGER PRIMARY KEY, conversation_id INTEGER, sender TEXT, status TEXT);
      `);
      db.exec("INSERT INTO agent_sessions VALUES (10, 'pm', 1, '{\"input\":100,\"output\":20,\"cacheRead\":80,\"cacheWrite\":10}')");
      db.exec("INSERT INTO turns VALUES (1, 10, 1, 'ok'), (2, 10, 1, 'ok'), (3, 10, 1, 'interrupted')");
      db.exec("INSERT INTO session_steps VALUES (1, 10, 'turn_started')");
    } finally {
      db.close();
    }

    expect(countPmTurns(dbFile, 1)).toBe(3);
    const metrics = readMetrics(dbFile, makeFacts([10]));
    expect(metrics.pmTurns).toBe(3);
    expect(metrics.tokens).toEqual({ input: 100, output: 20, cacheRead: 80, cacheWrite: 10 });
  });

  it("falls back to session_steps when pre-0058 ledger lacks the turns table", () => {
    const dbFile = join(root, "legacy.sqlite");
    const db = new DatabaseSync(dbFile);
    try {
      db.exec(`
        CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, role TEXT, conversation_id INTEGER, token_usage TEXT);
        CREATE TABLE session_steps (id INTEGER PRIMARY KEY, session_id INTEGER, kind TEXT);
        CREATE TABLE messages (id INTEGER PRIMARY KEY, conversation_id INTEGER, sender TEXT, status TEXT);
      `);
      db.exec("INSERT INTO agent_sessions VALUES (20, 'pm', 1, NULL)");
      db.exec("INSERT INTO session_steps VALUES (1, 20, 'turn_started'), (2, 20, 'turn_started')");
    } finally {
      db.close();
    }

    expect(countPmTurns(dbFile, 1)).toBe(2);
    expect(readMetrics(dbFile, makeFacts([20])).pmTurns).toBe(2);
  });
});
