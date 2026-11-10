import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { openTestDb } from "./test-helpers.ts";
import { createLedger } from "../ledger/index.ts";

it("旧消息迁移：执行错误补送达回执，未送达失败保留原样，附件不丢", () => {
  const db = openTestDb();
  try {
    const ledger = createLedger(db, { pmHomeRoot: "/unused" });
    // 用总助的既有会话，避免创建项目经理工作目录。
    const conversation = db.get<{ id: number }>("SELECT id FROM conversations LIMIT 1");
    const conversationId = conversation?.id ?? db.run("INSERT INTO conversations (kind, title, created_at) VALUES ('assistant', 'test', 0)").lastInsertRowid;
    const cases = ["error: http2: server sent GOAWAY", "error_during_execution: API error", "turn_failed", "spawn_failed: missing", "invalid_input: rejected"];
    const ids = cases.map((reason, i) => db.run("INSERT INTO messages (conversation_id, sender, kind, text, meta, dedupe_key, status, failure_reason, created_at, updated_at) VALUES (?, 'user', 'text', 'test', ?, ?, 'failed', ?, 0, 0)", conversationId, JSON.stringify({ attachments: [{ id: 'file' }] }), `legacy:${i}`, reason).lastInsertRowid);
    db.exec(readFileSync(new URL("../../../migrations/0021_message_delivery_receipt.sql", import.meta.url), "utf8"));
    expect(ids.map(id => ledger.getMessage(id)?.meta?.deliveryConfirmed)).toEqual([true, true, true, undefined, undefined]);
    expect(ledger.getMessage(ids[0]!)?.meta?.attachments).toEqual([{ id: "file" }]);
  } finally { db.close(); }
});
