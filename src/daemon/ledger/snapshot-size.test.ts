// 初始快照（/api/state）的上限守卫：按“跑了一个月”算（300 个已收工的 Worker、3 万条消息，AGENTS.md“缓存和状态快照”那一条），
// 快照里不带 Worker 对话的消息，项目经理对话只带最近几条，整份不超过 SNAPSHOT_MONTH_MAX_BYTES，算一次也要快。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ROUTER_BRIEFINGS_SNAPSHOT_MAX_BYTES,
  ROUTER_COMMAND_MAX_CHARS,
  ROUTER_COMMANDS_SNAPSHOT_MAX_BYTES,
  ROUTER_CONTEXT_MAX_CHARS,
  ROUTER_RECENT_COMMANDS_SNAPSHOT_MAX,
  ROUTER_REPLY_MAX_CHARS,
  ROUTER_REPORT_LINK_LABEL_MAX_CHARS,
  ROUTER_REPORT_LINK_TARGET_MAX_CHARS,
  ROUTER_REPORT_LINKS_MAX,
  ROUTER_STREAM_BRIEFINGS_SNAPSHOT_MAX,
  SNAPSHOT_MONTH_MAX_BYTES,
  SNAPSHOT_RECENT_MESSAGES,
} from "../../shared/limits.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createLedger } from "./index.ts";
import type { SqliteLedger } from "./index.ts";

const WORKERS = 300;
const MESSAGES_PER_WORKER = 95;
const PM_MESSAGES = 1_000;
const COMPLETED_GRAPHS = 100;
const ACTIVE_GRAPHS = 5;
const ARCHIVED_ROUTER_ITEMS = 1_500;
const ACTIVE_ROUTER_ITEMS = 15;
const FULL_BRIEFINGS = 500;
const BENCH_ROUNDS = 7;

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

/**
 * 一个项目经理派过 300 个 Worker（都收工了），每个 Worker 对话 95 条、汇报 3 行，项目经理对话 1000 条：约 3 万条。
 * full：总助按上限写满（docs/router-workbench-v2-design.md 第 5.5 节）——最近 10 条指令 4,000 字原话 + 6,000 字回复，
 * 另加 500 条带满 4 个链接的满长简报（最新 60 条未读）和 15 张待拍板项。
 */
function seedMonth(options: { full?: boolean } = {}): { pmConversation: number } {
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
  // 注入 1 个月规模的 100 张已完结任务图 + 5 张活跃任务图
  for (let g = 1; g <= COMPLETED_GRAPHS + ACTIVE_GRAPHS; g++) {
    const isActive = g > COMPLETED_GRAPHS;
    const gid = Number(
      db.run(
        `INSERT INTO task_graphs (project_id, pm_id, conversation_id, title, status, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        projectId,
        pm.id,
        conversation.id,
        `任务图 #${g}：完整端到端特性实现`,
        isActive ? "active" : "completed",
        at,
        at,
        isActive ? null : at,
      ).lastInsertRowid,
    );
    for (let n = 1; n <= 8; n++) {
      db.run(
        `INSERT INTO task_graph_steps (graph_id, node_key, title, status, waiting_for, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        gid,
        `node-${n}`,
        `模块节点 ${n}`,
        isActive ? (n === 1 ? "waiting" : "pending") : "done",
        isActive && n === 1 ? "pm" : null,
        n,
        at,
        at,
      );
      if (n > 1) {
        db.run("INSERT INTO task_graph_edges (graph_id, from_key, to_key) VALUES (?, ?, ?)", gid, `node-${n - 1}`, `node-${n}`);
      }
    }
    at++;
  }
  // 注入 1,500 张已归档/已决 Router 卡 + 15 张活跃卡 + 500 条历史指令 + 500 条审计环记录
  for (let r = 1; r <= ARCHIVED_ROUTER_ITEMS; r++) {
    const isDecision = r % 2 === 0;
    db.run(
      `INSERT INTO router_items (pm_id, project_id, conversation_id, kind, status, question, context, options_json, summary, links_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      pm.id,
      projectId,
      conversation.id,
      isDecision ? "decision" : "report",
      isDecision ? "resolved" : "archived",
      isDecision ? `历史拍板问题 #${r}` : null,
      isDecision ? "历史背景说明" : null,
      isDecision ? '["方案 A","方案 B"]' : null,
      isDecision ? null : `历史汇报摘要 #${r}`,
      isDecision ? null : "[]",
      at,
      at++,
    );
  }
  for (let r = 1; r <= ACTIVE_ROUTER_ITEMS; r++) {
    db.run(
      `INSERT INTO router_items (pm_id, project_id, conversation_id, kind, status, summary, links_json, created_at, updated_at)
       VALUES (?, ?, ?, 'report', 'unread', ?, '[]', ?, ?)`,
      pm.id,
      projectId,
      conversation.id,
      `未读里程碑汇报 #${r}`,
      at,
      at++,
    );
  }
  if (options.full) {
    const fullLinks = (r: number) =>
      JSON.stringify(
        Array.from({ length: ROUTER_REPORT_LINKS_MAX }, (_, k) => ({
          label: `${r}-${k}`.padEnd(ROUTER_REPORT_LINK_LABEL_MAX_CHARS, "链"),
          target: `https://example.com/${r}/${k}/`.padEnd(ROUTER_REPORT_LINK_TARGET_MAX_CHARS, "a"),
        })),
      );
    for (let r = 1; r <= ACTIVE_ROUTER_ITEMS; r++) {
      db.run(
        `INSERT INTO router_items (pm_id, project_id, conversation_id, kind, status, question, context, options_json, created_at, updated_at)
         VALUES (?, ?, ?, 'decision', 'pending', ?, ?, '["方案 A","方案 B"]', ?, ?)`,
        pm.id, projectId, conversation.id, `待拍板问题 #${r}`, "背景".repeat(100), at, at++,
      );
    }
    for (let r = 1; r <= FULL_BRIEFINGS; r++) {
      db.run(
        `INSERT INTO router_items (pm_id, project_id, conversation_id, kind, status, summary, links_json, created_at, updated_at)
         VALUES (?, ?, ?, 'report', ?, ?, ?, ?, ?)`,
        pm.id, projectId, conversation.id, r > FULL_BRIEFINGS - 60 ? "unread" : "archived",
        `${r}`.padEnd(ROUTER_CONTEXT_MAX_CHARS, "报"), fullLinks(r), at, at++,
      );
    }
  }
  for (let c = 1; c <= 500; c++) {
    const full = options.full === true && c > 500 - ROUTER_RECENT_COMMANDS_SNAPSHOT_MAX;
    db.run(
      `INSERT INTO router_commands (client_id, input_text, vendor, status, plan_json, created_at, updated_at)
       VALUES (?, ?, 'claude', ?, ?, ?, ?)`,
      `cmd-${c}`,
      full ? "问".repeat(ROUTER_COMMAND_MAX_CHARS) : `历史跨项目指令 #${c}`,
      full ? "answered" : "dispatched",
      full ? JSON.stringify({ intent: "answer", reply: "答".repeat(ROUTER_REPLY_MAX_CHARS), actions: [], track: "B" }) : null,
      at,
      at++,
    );
    db.run(
      `INSERT INTO router_audit_log (actor, action, pm_id, ref_id, created_at)
       VALUES ('pm', 'router.report', ?, ?, ?)`,
      pm.id,
      c,
      at++,
    );
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
    const routerPlan = db
      .all<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT * FROM router_items WHERE status IN ('pending', 'unread') AND status = 'pending' ORDER BY created_at DESC, id DESC LIMIT 50",
      )
      .map((r) => r.detail)
      .join(" | ");
    expect(routerPlan).toContain("router_items_active");
    const briefingsPlan = db
      .all<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT * FROM router_items WHERE kind = 'report' ORDER BY created_at DESC, id DESC LIMIT 30",
      )
      .map((r) => r.detail)
      .join(" | ");
    expect(briefingsPlan).toContain("router_items_cursor");
    const graphPlan = db
      .all<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT * FROM task_graphs WHERE project_id = 1 AND status = 'active' ORDER BY updated_at DESC",
      )
      .map((r) => r.detail)
      .join(" | ");
    expect(graphPlan).toContain("idx_task_graphs_active");
    const t = performance.now();
    const snap = ledger.snapshot();
    const ms = performance.now() - t;
    const workers = snap.conversations.filter((c) => c.conversation.kind === "worker");
    expect(workers).toHaveLength(WORKERS);
    expect(workers.every((c) => c.messages.length === 0 && c.hasMore && c.workerLine?.line.event === "ended" && c.workerLine.endedAt !== null)).toBe(true);
    expect(snap.conversations.find((c) => c.conversation.id === pmConversation)!.messages).toHaveLength(SNAPSHOT_RECENT_MESSAGES);
    expect(snap.activeTaskGraphs).toHaveLength(ACTIVE_GRAPHS);
    // 没有待拍板项；简报不分已读未读取最近 30 条（15 条未读 + 15 条最近读过的）
    expect(snap.router.items).toHaveLength(ROUTER_STREAM_BRIEFINGS_SNAPSHOT_MAX);
    expect(snap.router.items.filter((x) => x.kind === "report" && x.status === "unread")).toHaveLength(ACTIVE_ROUTER_ITEMS);
    expect(snap.router.commands).toHaveLength(10);
    const bytes = Buffer.byteLength(JSON.stringify(snap));
    expect(bytes).toBeLessThan(SNAPSHOT_MONTH_MAX_BYTES);
    // CI 的机器慢，给足余量；本机约几十毫秒
    expect(ms).toBeLessThan(1_000);
  });

  it("总助写满上限（满长回复指令 + 满链接简报 + 15 张待拍板项）：整份仍不超过上限，指令和简报各守字节上限", () => {
    seedMonth({ full: true });
    // 7 轮 ledger.snapshot() 的中位数与范围（PR 正文的改前改后对比用），先量再断言
    const times: number[] = [];
    for (let i = 0; i < BENCH_ROUNDS; i++) {
      const t = performance.now();
      ledger.snapshot();
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const snap = ledger.snapshot();
    const bytes = Buffer.byteLength(JSON.stringify(snap));
    const routerBytes = Buffer.byteLength(JSON.stringify(snap.router));
    const commandBytes = snap.router.commands.reduce((n, c) => n + Buffer.byteLength(JSON.stringify(c)), 0);
    const briefings = snap.router.items.filter((x) => x.kind === "report");
    const briefingBytes = briefings.reduce((n, b) => n + Buffer.byteLength(JSON.stringify(b)), 0);
    console.log(
      `[snapshot-bench] bytes=${bytes} router=${routerBytes} commands=${snap.router.commands.length}/${commandBytes}B ` +
        `briefings=${briefings.length}/${briefingBytes}B median=${times[3]!.toFixed(2)}ms range=${times[0]!.toFixed(2)}-${times.at(-1)!.toFixed(2)}ms`,
    );
    // 待拍板项在简报前面插入，简报再多也挤不掉它们
    expect(snap.router.items.filter((x) => x.kind === "decision")).toHaveLength(ACTIVE_ROUTER_ITEMS);
    expect(commandBytes).toBeLessThanOrEqual(ROUTER_COMMANDS_SNAPSHOT_MAX_BYTES);
    expect(briefingBytes).toBeLessThanOrEqual(ROUTER_BRIEFINGS_SNAPSHOT_MAX_BYTES);
    expect(snap.router.commands.length).toBeGreaterThanOrEqual(1);
    expect(briefings.length).toBeGreaterThanOrEqual(1);
    expect(bytes).toBeLessThan(SNAPSHOT_MONTH_MAX_BYTES);
    expect(times[3]!).toBeLessThan(1_000);
  });
});
