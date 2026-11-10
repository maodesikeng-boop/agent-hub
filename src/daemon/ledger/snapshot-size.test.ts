// 初始快照（/api/state）的上限守卫：按“跑了一个月”算（300 个已收工的 Worker、3 万条消息，AGENTS.md“缓存和状态快照”那一条），
// 快照里不带 Worker 对话的消息，项目经理对话只带最近几条，整份不超过 SNAPSHOT_MONTH_MAX_BYTES，算一次也要快。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SNAPSHOT_MONTH_MAX_BYTES, SNAPSHOT_RECENT_MESSAGES } from "../../shared/limits.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createLedger } from "./index.ts";
import type { SqliteLedger } from "./index.ts";

const WORKERS = 300;
const MESSAGES_PER_WORKER = 95;
const PM_MESSAGES = 1_000;

let root: string;
let db: Db;
let ledger: SqliteLedger;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-hub-snapshot-size-"));
  db = openTestDb();
  ledger = createLedger(db, { pmHomeRoot: join(root, "pm-home"), dataHome: root });
});

afterEach(() => {
  ledger.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** 一个项目经理派过 300 个 Worker（都收工了），每个 Worker 对话 95 条、汇报 3 行，项目经理对话 1000 条：约 3 万条。 */
function seedMonth(): { pmConversation: number } {
  const { pm, conversation } = ledger.createPm({ name: "小林", mode: "manage_only", persona: "" });
  const longText = "汇报全文，".repeat(200);
  db.exec("BEGIN");
  let at = 1_000;
  const projectId = Number(
    db.run("INSERT INTO projects (name, pm_id, conversation_id, created_at, updated_at) VALUES ('foo', ?, ?, ?, ?)", pm.id, conversation.id, at, at).lastInsertRowid,
  );
  const message = (conversationId: number, workerId: number | null, sender: string, kind: string, text: string, meta: unknown, key: string) =>
    db.run(
      "INSERT INTO messages (conversation_id, worker_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
      conversationId, workerId, sender, kind, text, meta === null ? null : JSON.stringify(meta), key, at, at++,
    );
  for (let i = 0; i < PM_MESSAGES; i++) message(conversation.id, null, "agent", "text", `第 ${i} 段 ${longText}`, null, `pm:${i}`);
  for (let w = 1; w <= WORKERS; w++) {
    const conv = Number(db.run("INSERT INTO conversations (kind, pm_id, title, created_at) VALUES ('worker', ?, ?, ?)", pm.id, `Worker ${w}`, at).lastInsertRowid);
    db.run(
      `INSERT INTO workers (project_id, pm_id, pm_conversation_id, worker_conversation_id, title, task, workspace, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '任务', 'main', 'ended', ?, ?)`,
      projectId, pm.id, conversation.id, conv, `Worker ${w}`, at, at,
    );
    db.run(
      `INSERT INTO agent_sessions (role, conversation_id, worker_id, vendor_session_id, cwd, status, rate_limit, token_usage, created_at, updated_at, pm_id)
       VALUES ('worker', ?, ?, ?, '/w', 'ended', ?, ?, ?, ?, NULL)`,
      conv, w, `v-${w}`,
      JSON.stringify({ status: "allowed", resetsAt: 1, windows: { five_hour: { utilization: 0.5, resetsAt: 1, status: "allowed" } } }),
      JSON.stringify({ input: 1, cacheRead: 2, cacheWrite: 3, output: 4, context: 5 }),
      at, at,
    );
    for (let k = 0; k < MESSAGES_PER_WORKER; k++) message(conv, w, "agent", "text", longText, null, `w:${w}:${k}`);
    for (const event of ["started", "report", "ended"]) {
      const line = { workerId: w, workerConversationId: conv, title: `Worker ${w}`, readonly: false, event, status: event === "report" ? "done" : null, summary: event === "report" ? "做完了" : null };
      message(conversation.id, w, "system", "worker", longText, line, `worker:${w}:${event}`);
    }
  }
  db.exec("COMMIT");
  return { pmConversation: conversation.id };
}

describe("初始快照的上限（一个月的量）", () => {
  it("300 个已收工的 Worker、3 万条消息：不带 Worker 的消息，项目经理对话只带最近几条，整份有上限，算得快", () => {
    const { pmConversation } = seedMonth();
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM messages")!.n).toBeGreaterThanOrEqual(30_000);
    const plan = db
      .all<{ detail: string }>("EXPLAIN QUERY PLAN SELECT id, kind, meta, created_at FROM messages WHERE kind = 'worker' ORDER BY id")
      .map((r) => r.detail)
      .join(" | ");
    expect(plan).toContain("USING INDEX messages_worker_lines");
    const t = performance.now();
    const snap = ledger.snapshot();
    const ms = performance.now() - t;
    const workers = snap.conversations.filter((c) => c.conversation.kind === "worker");
    expect(workers).toHaveLength(WORKERS);
    expect(workers.every((c) => c.messages.length === 0 && c.hasMore && c.workerLine?.line.event === "ended" && c.workerLine.endedAt !== null)).toBe(true);
    expect(snap.conversations.find((c) => c.conversation.id === pmConversation)!.messages).toHaveLength(SNAPSHOT_RECENT_MESSAGES);
    const bytes = Buffer.byteLength(JSON.stringify(snap));
    expect(bytes).toBeLessThan(SNAPSHOT_MONTH_MAX_BYTES);
    // CI 的机器慢，给足余量；本机约几十毫秒
    expect(ms).toBeLessThan(1_000);
  });
});
