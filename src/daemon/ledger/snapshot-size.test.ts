// 初始快照（/api/state）的上限守卫：按“跑了一个月”算（300 个已收工的 Worker、3 万条消息，AGENTS.md“缓存和状态快照”那一条），
// 快照里不带 Worker 对话的消息，项目经理对话只带最近几条，整份不超过 SNAPSHOT_MONTH_MAX_BYTES，算一次也要快。
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DELIVERABLE_LABEL_MAX_CHARS,
  DELIVERABLES_PER_CARD_MAX,
  DELIVERABLES_PER_STEP_MAX,
  MAX_PATH_BYTES,
  ROUTER_ACTIVE_ITEMS_SNAPSHOT_MAX,
  SNAPSHOT_DELIVERABLES_WORST_MAX_BYTES,
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
import type { Deliverable } from "../../shared/deliverables.ts";
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
const DELIVERABLE_CARDS = 10;
/** 文件名最长 255 字节（APFS、ext4 的 NAME_MAX）。 */
const FILE_NAME_MAX_BYTES = 255;

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

/** 压不动的定长字符（十六进制摘要接起来），让 gzip 后的大小也按最坏算；同样的参数每次一样。 */
function noise(seed: string, length: number): string {
  let out = "";
  for (let i = 0; out.length < length; i++) out += createHash("sha256").update(`${seed}:${i}`).digest("hex");
  return out.slice(0, length);
}

/**
 * 一张卡写满的交付物：标签 DELIVERABLE_LABEL_MAX_CHARS 字。
 * 默认文件名、原链接按常见长度；worst 时文件名 FILE_NAME_MAX_BYTES、原链接 MAX_PATH_BYTES 字节，都是压不动的字符。
 */
function fullDeliverables(r: number, n = DELIVERABLES_PER_CARD_MAX, worst = false): Deliverable[] {
  return Array.from({ length: n }, (_, k) => ({
    label: `${r}-${k}`.padEnd(DELIVERABLE_LABEL_MAX_CHARS, "标"),
    id: `${r}${k}`.padStart(16, "0"),
    name: worst ? `${noise(`n${r}-${k}`, FILE_NAME_MAX_BYTES - 4)}.png` : `deliverable-${r}-${k}-desktop-screenshot.png`,
    mime: "image/png",
    size: 1_234_567,
    href: worst
      ? `/${noise(`h${r}-${k}`, MAX_PATH_BYTES - 5)}.png`
      : `/Users/someone/.agent-hub/worktrees/7/595/docs/screenshots/deliverable-${r}-${k}-desktop-screenshot.png`,
    origin: { messageId: 100_000 + r, index: k },
  }));
}

/**
 * 一个项目经理派过 300 个 Worker（都收工了），每个 Worker 对话 95 条、汇报 3 行，项目经理对话 1000 条：约 3 万条。
 * full：总助按上限写满（docs/router-workbench-v2-design.md 第 5.5 节）——最近 10 条指令 4,000 字原话 + 6,000 字回复，
 * 另加 500 条带满 4 个链接的满长简报（最新 60 条未读）和 15 张待拍板项。
 */
function seedMonth(options: { full?: boolean; deliverables?: boolean | "worst" } = {}): { pmConversation: number } {
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
  if (options.deliverables) {
    // 10 张等用户拍板的卡、5 张活跃任务图的第一步（等用户确认），各带满 DELIVERABLES_PER_CARD_MAX 个交付物。
    // worst：快照里的 ROUTER_ACTIVE_ITEMS_SNAPSHOT_MAX 张待拍板卡全是带满交付物的（比 full 的卡新，排在前面），步骤带满 DELIVERABLES_PER_STEP_MAX 个，文件名、原链接都到上限
    const worst = options.deliverables === "worst";
    const cards = worst ? ROUTER_ACTIVE_ITEMS_SNAPSHOT_MAX : DELIVERABLE_CARDS;
    for (let r = 1; r <= cards; r++) {
      const id = Number(
        db.run(
          `INSERT INTO router_items (pm_id, project_id, conversation_id, kind, status, question, context, options_json, created_at, updated_at)
           VALUES (?, ?, ?, 'decision', 'pending', ?, ?, '["通过","打回"]', ?, ?)`,
          pm.id, projectId, conversation.id, `请验收 #${r}`, "背景".repeat(100), at, at++,
        ).lastInsertRowid,
      );
      db.run("INSERT INTO router_item_deliverables (item_id, deliverables_json) VALUES (?, ?)", id, JSON.stringify(fullDeliverables(r, DELIVERABLES_PER_CARD_MAX, worst)));
    }
    db.run(
      `UPDATE task_graph_steps SET status = 'waiting', waiting_for = 'user', artifact_json = ?
        WHERE node_key = 'node-1' AND graph_id IN (SELECT id FROM task_graphs WHERE status = 'active')`,
      JSON.stringify({ summary: "做完了", deliverables: worst ? fullDeliverables(0, DELIVERABLES_PER_STEP_MAX, true) : fullDeliverables(0) }),
    );
    db.run(
      "UPDATE task_graph_steps SET artifact_json = ? WHERE node_key = 'node-2' AND graph_id IN (SELECT id FROM task_graphs WHERE status = 'active')",
      JSON.stringify({ summary: "做完了", deliverables: fullDeliverables(-1, DELIVERABLES_PER_STEP_MAX, worst) }),
    );
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
  it("一个月的量再加 10 张各带 DELIVERABLES_PER_CARD_MAX 个交付物的待拍板卡（docs/deliverables-design.md）：等拍板的卡和步骤带上交付物，整份仍不超过上限", () => {
    seedMonth({ deliverables: true });
    const snap = ledger.snapshot();
    const bytes = Buffer.byteLength(JSON.stringify(snap));
    const cards = snap.router.items.filter((x) => x.kind === "decision" && x.question.startsWith("请验收"));
    expect(cards).toHaveLength(DELIVERABLE_CARDS);
    for (const card of cards) expect(card.kind === "decision" && card.deliverables).toHaveLength(DELIVERABLES_PER_CARD_MAX);
    const nodes = snap.activeTaskGraphs.flatMap((g) => g.nodes);
    expect(nodes.filter((n) => n.key === "node-1").every((n) => n.artifact?.deliverables?.length === DELIVERABLES_PER_CARD_MAX)).toBe(true);
    expect(nodes.filter((n) => n.key === "node-2").every((n) => n.artifact?.deliverables === undefined)).toBe(true);
    const deliverableBytes =
      cards.reduce((n, c) => n + Buffer.byteLength(JSON.stringify(c.kind === "decision" ? c.deliverables : [])), 0) +
      nodes.reduce((n, x) => n + Buffer.byteLength(JSON.stringify(x.artifact?.deliverables ?? [])), 0);
    console.log(`[snapshot-bench] deliverables bytes=${bytes} deliverables=${deliverableBytes}B`);
    expect(bytes).toBeLessThan(SNAPSHOT_MONTH_MAX_BYTES);
  });
  it("总助写满、交付物数量和长度都到上限（50 张待拍板卡各 6 个、等确认的步骤各 10 个，文件名 255 字节、原链接 4096 字节）：一个不裁，整份有上限", () => {
    seedMonth({ full: true, deliverables: "worst" });
    const snap = ledger.snapshot();
    const json = JSON.stringify(snap);
    const bytes = Buffer.byteLength(json);
    const gzipBytes = gzipSync(json).length;
    const decisions = snap.router.items.filter((x) => x.kind === "decision");
    console.log(`[snapshot-bench] deliverables-worst bytes=${bytes} gzip=${gzipBytes}`);
    // 运行时不按总字节裁：待拍板卡、每张卡的交付物都照原样带全，网页照常显示（超出 SNAPSHOT_MONTH_MAX_BYTES 的部分走 gzip）
    expect(decisions).toHaveLength(ROUTER_ACTIVE_ITEMS_SNAPSHOT_MAX);
    for (const card of decisions) expect(card.kind === "decision" && card.deliverables).toHaveLength(DELIVERABLES_PER_CARD_MAX);
    const waiting = snap.activeTaskGraphs.flatMap((g) => g.nodes).filter((n) => n.key === "node-1");
    expect(waiting).toHaveLength(ACTIVE_GRAPHS);
    for (const node of waiting) expect(node.artifact?.deliverables).toHaveLength(DELIVERABLES_PER_STEP_MAX);
    expect(bytes).toBeLessThan(SNAPSHOT_DELIVERABLES_WORST_MAX_BYTES);
  });
});
