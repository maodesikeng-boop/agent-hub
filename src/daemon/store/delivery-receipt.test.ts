import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { openTestDb } from "./test-helpers.ts";
import type { Db } from "./db.ts";

const MIGRATION = readFileSync(new URL("../../../migrations/0021_message_delivery_receipt.sql", import.meta.url), "utf8");

function setup(db: Db) {
  const conversationId = Number(db.run("INSERT INTO conversations (kind, title, created_at) VALUES ('assistant', 'test', 0)").lastInsertRowid);
  const sessionId = Number(
    db.get<{ id: number }>("SELECT id FROM agent_sessions LIMIT 1")?.id ??
      db.run("INSERT INTO agent_sessions (conversation_id, role, vendor_session_id, cwd, created_at, updated_at) VALUES (?, 'assistant', 'vs', '/tmp', 0, 0)", conversationId).lastInsertRowid,
  );
  let n = 0;
  const add = (sender: string, kind: string, status: string | null, reason: string | null = null, meta: unknown = null) =>
    Number(
      db.run(
        "INSERT INTO messages (conversation_id, session_id, sender, kind, text, meta, dedupe_key, status, failure_reason, created_at, updated_at) VALUES (?, ?, ?, ?, 't', ?, ?, ?, ?, 0, 0)",
        conversationId, sessionId, sender, kind, meta === null ? null : JSON.stringify(meta), `k${n++}`, status, reason,
      ).lastInsertRowid,
    );
  return { add };
}

const row = (db: Db, id: number) => db.get<{ status: string; failure_reason: string | null; meta: string | null }>("SELECT status, failure_reason, meta FROM messages WHERE id = ?", id)!;
const receipt = (r: { meta: string | null }) => (r.meta === null ? undefined : (JSON.parse(r.meta) as { deliveryConfirmed?: boolean }).deliveryConfirmed);

it("旧消息迁移：回复完才出错的标已回复；没回复的执行错误补回执；没送达的保持原样；附件不丢；可重复跑", () => {
  const db = openTestDb();
  try {
    const { add } = setup(db);
    const attachments = { attachments: [{ id: "file" }] };
    // 用户那两条：出错后项目经理最后说的是一段话
    const replied = add("user", "text", "failed", "error: http2: server sent GOAWAY", attachments);
    add("agent", "tool", null);
    add("agent", "text", null);
    // 出错时只有工具调用、没有最终回复：保持失败，补回执
    const midWork = add("user", "text", "failed", "API Error: connection reset");
    add("agent", "tool", null);
    // turn.ended 才会写的原因，但没有任何 agent 输出：补回执
    const turnReason = add("user", "text", "failed", "error_during_execution: boom");
    const turnFailed = add("user", "text", "failed", "turn_failed");
    // 没送达的原因：保持原样（包括原文碰巧以 “error: ” 开头、也没有 agent 输出的）
    const spawn = add("user", "text", "failed", "spawn_failed: missing");
    const action = add("user", "text", "failed", "这个会话已经结束，发不出去了");
    const lookalike = add("user", "text", "failed", "error: connect ECONNREFUSED");
    // 下一条输入之后的回复不算这条的
    const beforeNext = add("user", "text", "failed", "spawn_failed: x");
    add("user", "text", "replied");
    add("agent", "text", null);
    const inflight = add("user", "text", "processing");
    const done = add("user", "text", "replied");

    db.exec(MIGRATION);
    expect(row(db, replied)).toMatchObject({ status: "replied", failure_reason: null });
    expect(receipt(row(db, replied))).toBe(true);
    expect(JSON.parse(row(db, replied).meta!).attachments).toEqual([{ id: "file" }]);
    expect(row(db, midWork).status).toBe("failed");
    expect([midWork, turnReason, turnFailed, inflight].map((id) => receipt(row(db, id)))).toEqual([true, true, true, true]);
    expect([spawn, action, lookalike, beforeNext].map((id) => [row(db, id).status, receipt(row(db, id))])).toEqual(Array(4).fill(["failed", undefined]));
    expect(receipt(row(db, done))).toBeUndefined();

    const snapshot = db.all("SELECT id, status, failure_reason, meta FROM messages ORDER BY id");
    db.exec(MIGRATION);
    expect(db.all("SELECT id, status, failure_reason, meta FROM messages ORDER BY id")).toEqual(snapshot);
  } finally {
    db.close();
  }
});

it("3 万条消息上迁移很快", () => {
  const db = openTestDb();
  try {
    const { add } = setup(db);
    for (let i = 0; i < 10000; i++) {
      add("user", "text", "replied");
      add("agent", "text", null);
      add("agent", "tool", null);
    }
    for (let i = 0; i < 20; i++) add("user", "text", "failed", "error_during_execution: x");
    const started = performance.now();
    db.exec(MIGRATION);
    const ms = performance.now() - started;
    expect(ms).toBeLessThan(1000);
  } finally {
    db.close();
  }
});
