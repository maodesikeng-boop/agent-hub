// hubCall 新加的访客拦截（daemon/ledger/hub-commands.ts 的 guestTurnBlockReason）在长会话里的开销：
// 一个项目经理会话里 N 条已回复的用户消息，量拦截那条查询单独的耗时和整次 hubCall("status") 的耗时。
// 用法：node experiments/feishu-bench/hubcall.ts [用户消息条数，默认 3000]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLedger } from "../../src/daemon/ledger/index.ts";
import { createSessionStore } from "../../src/daemon/store/index.ts";
import { openTestDb } from "../../src/daemon/store/test-helpers.ts";

const N = Number(process.argv[2] ?? 3000);
const home = mkdtempSync(join(tmpdir(), "hubcall-bench-"));
const db = openTestDb();
const ledger = createLedger(db, { pmHomeRoot: home });
const { conversation, sessionId } = ledger.createPm({ name: "小林", mode: "manage_only", persona: "" });
createSessionStore(db).update(sessionId, { status: "running" });
const origin = { kind: "feishu" as const, openId: "ou_owner" as never, name: "张三", role: "owner" as const, mode: "solo" as const, guestTier: "chat_only" as const, context: [] };
for (let i = 0; i < N; i++) {
  const { messageId } = ledger.postUserMessage({ conversationId: conversation.id, clientId: `c${i}`, text: `第${i}条`, ...(i % 2 === 0 ? { origin } : {}) });
  db.run("UPDATE messages SET status = 'replied' WHERE id = ?", messageId);
}
/** 和 hub-commands.ts 里那条一样；GUARD_SQL=old 时量改之前（扫 messages_session）的写法。 */
const guardSql =
  process.env.GUARD_SQL === "old"
    ? "SELECT meta FROM messages WHERE session_id = ? AND sender = 'user' AND status IN ('delivered', 'processing') AND meta IS NOT NULL"
    : "SELECT meta FROM messages INDEXED BY messages_in_flight WHERE session_id = ? AND status IN ('delivered', 'processing') AND sender = 'user' AND meta IS NOT NULL";
const time = (fn: () => void, runs: number) => {
  const xs: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    xs.push(performance.now() - t);
  }
  xs.sort((a, b) => a - b);
  return { p50: +xs[Math.floor(runs / 2)]!.toFixed(4), p95: +xs[Math.floor(runs * 0.95)]!.toFixed(4) };
};
for (let i = 0; i < 50; i++) db.all(guardSql, sessionId);
const plan = db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${guardSql}`, sessionId).map((r) => r.detail);
console.log(
  JSON.stringify(
    { userMessages: N, queryPlan: plan, guardQueryMs: time(() => db.all(guardSql, sessionId), 500), hubCallStatusMs: time(() => ledger.hubCall(sessionId, "status", {} as never), 200) },
    null,
    2,
  ),
);
ledger.close();
db.close();
rmSync(home, { recursive: true, force: true });
