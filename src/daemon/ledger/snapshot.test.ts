// 初始快照只带界面现在要的对话和会话（ledger/snapshot.ts）；不在快照里的早收工 Worker 靠翻页、按编号单拉一个不丢地拿回来。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SNAPSHOT_ENDED_WORKERS_PER_PM } from "../../shared/limits.ts";
import type { ConversationId } from "../../shared/domain.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createLedger } from "./index.ts";
import type { SqliteLedger } from "./index.ts";

const ENDED = 50;
const LIVE = 2;

let root: string;
let db: Db;
let ledger: SqliteLedger;
let at = 1_000;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-hub-snapshot-"));
  db = openTestDb();
  ledger = createLedger(db, { pmHomeRoot: join(root, "pm-home"), dataHome: root });
});

afterEach(() => {
  ledger.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

interface Seeded {
  pmId: number;
  pmConversation: ConversationId;
  /** 按派出先后：前 ENDED 个收工了，后 LIVE 个还在跑。 */
  workers: { workerId: number; conversationId: ConversationId; ended: boolean }[];
  /** 绑在活跃任务图上的那个（最早收工的）。 */
  bound: { workerId: number; conversationId: ConversationId };
}

/** 一个项目经理：ENDED 个收工的 Worker（各 3 条消息、汇报两行、一个结束的会话），LIVE 个在跑的；最早那个挂在一张活跃任务图上。 */
function seed(): Seeded {
  const { pm, conversation } = ledger.createPm({ name: "小林", mode: "manage_only", persona: "" });
  const projectId = Number(
    db.run("INSERT INTO projects (name, pm_id, conversation_id, created_at, updated_at) VALUES ('foo', ?, ?, ?, ?)", pm.id, conversation.id, at, at).lastInsertRowid,
  );
  const message = (conversationId: number, workerId: number | null, sender: string, kind: string, text: string, meta: unknown, key: string) =>
    db.run(
      "INSERT INTO messages (conversation_id, worker_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
      conversationId, workerId, sender, kind, text, meta === null ? null : JSON.stringify(meta), key, at, at++,
    );
  const workers: Seeded["workers"] = [];
  for (let i = 0; i < ENDED + LIVE; i++) {
    const ended = i < ENDED;
    const conv = Number(db.run("INSERT INTO conversations (kind, pm_id, title, created_at) VALUES ('worker', ?, ?, ?)", pm.id, `Worker ${i}`, at).lastInsertRowid);
    const workerId = Number(
      db.run(
        `INSERT INTO workers (project_id, pm_id, pm_conversation_id, worker_conversation_id, title, task, workspace, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '任务', 'main', ?, ?, ?)`,
        projectId, pm.id, conversation.id, conv, `Worker ${i}`, ended ? "ended" : "open", at, at,
      ).lastInsertRowid,
    );
    db.run(
      `INSERT INTO agent_sessions (role, conversation_id, worker_id, vendor_session_id, cwd, status, created_at, updated_at, pm_id)
       VALUES ('worker', ?, ?, ?, '/w', ?, ?, ?, NULL)`,
      conv, workerId, `v-${i}`, ended ? "ended" : "running", at, at,
    );
    for (let k = 0; k < 3; k++) message(conv, workerId, "agent", "text", `第 ${k} 句`, null, `w:${i}:${k}`);
    for (const event of ended ? ["started", "ended"] : ["started"]) {
      const line = { workerId, workerConversationId: conv, title: `Worker ${i}`, readonly: false, event, status: null, summary: null };
      message(conversation.id, workerId, "system", "worker", `Worker ${i} ${event}`, line, `worker:${i}:${event}`);
    }
    workers.push({ workerId, conversationId: conv, ended });
  }
  const bound = workers[0]!;
  const graphId = Number(
    db.run(
      `INSERT INTO task_graphs (project_id, pm_id, conversation_id, title, status, created_at, updated_at) VALUES (?, ?, ?, '图', 'active', ?, ?)`,
      projectId, pm.id, conversation.id, at, at,
    ).lastInsertRowid,
  );
  db.run(
    `INSERT INTO task_graph_steps (graph_id, node_key, title, status, worker_ids_json, sort_order, created_at, updated_at)
     VALUES (?, 'a', '第一步', 'done', ?, 1, ?, ?)`,
    graphId, JSON.stringify([bound.workerId]), at, at,
  );
  return { pmId: pm.id, pmConversation: conversation.id, workers, bound };
}

describe("初始快照只带界面现在要的", () => {
  it("每个项目经理只带最近几个收工的 Worker，加上在跑的、绑在活跃任务图上的", () => {
    const s = seed();
    const snap = ledger.snapshot();
    const ids = new Set(snap.conversations.map((c) => c.conversation.id));
    const ended = s.workers.filter((w) => w.ended);
    const recent = ended.slice(-SNAPSHOT_ENDED_WORKERS_PER_PM);
    for (const w of [...recent, ...s.workers.filter((x) => !x.ended), s.bound]) expect(ids.has(w.conversationId)).toBe(true);
    expect(snap.conversations.filter((c) => c.conversation.kind === "worker")).toHaveLength(SNAPSHOT_ENDED_WORKERS_PER_PM + LIVE + 1);
    // 绑在图上的早收工 Worker 带着摘要（任务图详情按 Worker 编号找它）
    expect(snap.conversations.find((c) => c.conversation.id === s.bound.conversationId)!.workerLine?.line.workerId).toBe(s.bound.workerId);
    // 会话只带快照里这些对话的
    expect(new Set(snap.sessions.map((x) => x.conversationId)).size).toBe(snap.sessions.length);
    expect(snap.sessions.every((x) => x.conversationId === null || ids.has(x.conversationId))).toBe(true);
  });

  it("按对话编号、Worker 编号单拉：和快照里同一个形状，带最新一代的会话；不存在的不回", () => {
    const s = seed();
    const oldest = s.workers[1]!;
    const byId = ledger.lookupConversations({ ids: [oldest.conversationId, 999_999], workerIds: [] });
    expect(byId.conversations.map((c) => c.conversation.id)).toEqual([oldest.conversationId]);
    expect(byId.conversations[0]).toMatchObject({ messages: [], hasMore: true, workerLine: { line: { workerId: oldest.workerId, event: "ended" } } });
    expect(byId.sessions.map((x) => [x.conversationId, x.status])).toEqual([[oldest.conversationId, "ended"]]);
    const byWorker = ledger.lookupConversations({ ids: [], workerIds: [oldest.workerId] });
    expect(byWorker.conversations).toEqual(byId.conversations);
    expect(ledger.lookupConversations({ ids: [], workerIds: [] })).toEqual({ conversations: [], sessions: [] });
  });

  it("换过代的会话只带最新一代；每家厂商最新的会话照带（额度、按需查额度要看），哪怕它的对话不在快照里", () => {
    const s = seed();
    // 建项目经理时有了第 1 代：结束它，再换两代
    db.run("UPDATE agent_sessions SET status = 'ended' WHERE conversation_id = ?", s.pmConversation);
    db.run(
      `INSERT INTO agent_sessions (role, conversation_id, vendor_session_id, cwd, status, generation, created_at, updated_at, pm_id)
       VALUES ('pm', ?, 'pm-2', '/p', 'ended', 2, 1, 1, ?), ('pm', ?, 'pm-3', '/p', 'idle', 3, 2, 2, ?)`,
      s.pmConversation, s.pmId, s.pmConversation, s.pmId,
    );
    const rateLimit = JSON.stringify({ status: "allowed", resetsAt: 1, windows: { five_hour: { utilization: 0.5, resetsAt: 1, status: "allowed" } } });
    const oldWorker = s.workers[1]!;
    db.run("UPDATE agent_sessions SET vendor = 'codex', rate_limit = ? WHERE conversation_id = ?", rateLimit, oldWorker.conversationId);
    const snap = ledger.snapshot();
    const pmSessions = snap.sessions.filter((x) => x.conversationId === s.pmConversation);
    expect(pmSessions.map((x) => x.generation)).toEqual([3]);
    const codex = snap.sessions.filter((x) => x.vendor === "codex");
    expect(codex.map((x) => x.conversationId)).toEqual([oldWorker.conversationId]);
    expect(codex[0]!.rateLimit?.windows.five_hour?.utilization).toBe(0.5);
    expect(snap.conversations.some((c) => c.conversation.id === oldWorker.conversationId)).toBe(false);
  });

  it("工具消息的 meta.input 在库里就去掉：快照和往上翻页都不带", () => {
    const s = seed();
    const input = { file_path: "/x.ts", content: "x".repeat(50_000) };
    for (let i = 0; i < 3; i++) {
      db.run(
        `INSERT INTO messages (conversation_id, sender, kind, text, meta, dedupe_key, created_at, updated_at) VALUES (?, 'agent', 'tool', 'Write: /x.ts', ?, ?, ?, ?)`,
        s.pmConversation, JSON.stringify({ toolUseId: `t${i}`, name: "Write", input }), `tool:${i}`, at, at++,
      );
    }
    const pm = ledger.snapshot().conversations.find((c) => c.conversation.id === s.pmConversation)!;
    const tools = pm.messages.filter((m) => m.kind === "tool");
    expect(tools).toHaveLength(3);
    expect(tools.every((m) => m.meta !== null && !("input" in m.meta) && m.meta.name === "Write")).toBe(true);
    const older = ledger.messagesBefore(s.pmConversation, tools.at(-1)!.id);
    expect(older.messages.filter((m) => m.kind === "tool").every((m) => m.meta !== null && !("input" in m.meta))).toBe(true);
  });
});
