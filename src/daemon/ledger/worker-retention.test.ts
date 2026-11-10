// 已收工 Worker 的对话保留期（worker-retention.ts）：满 30 天删、未满不删、在跑不删、项目经理不删、分批上限、基本记录仍可查。
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Change } from "../../shared/api.ts";
import type { ConversationId, PmId, SessionId, WorkerId } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import { PM_ARCHIVE_RETENTION_MS, WORKER_PURGE_BATCH_ROWS, WORKER_RETENTION_DAYS, WORKER_RETENTION_MS } from "../../shared/limits.ts";
import { workerSetupLogPath } from "../../shared/paths.ts";
import { enqueueAction, listActions } from "../actions/index.ts";
import { createSessionStore } from "../store/index.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger } from "./index.ts";
import type { SqliteLedger } from "./index.ts";

let db: Db;
let root: string;
let launchDir: string;
let setupLogsDir: string;
let now: number;
let ledger: SqliteLedger;
let changes: Change[];
let lin: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };

const T0 = new Date(2026, 9, 1, 8, 0).getTime();

beforeEach(() => {
  db = openTestDb();
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-worker-retention-")));
  const dataHome = join(root, ".agent-hub");
  launchDir = join(dataHome, "state", "launch");
  setupLogsDir = join(dataHome, "state", "logs", "setup");
  now = T0;
  ledger = createLedger(db, {
    now: () => now,
    initialSeq: 9_000,
    pmHomeRoot: join(dataHome, "pm-home"),
    dataHome,
    worktreesDir: join(dataHome, "worktrees"),
    launchDir,
    setupLogsDir,
    resolveFolder: createResolveFolder({ dataHome, userHome: root }),
  });
  const a = ledger.createPm({ name: "小林", mode: "manage_only", persona: "" });
  lin = { pmId: a.pm.id, conversationId: a.conversation.id, sessionId: a.sessionId };
  const main = join(root, "work", "foo");
  mkdirSync(main, { recursive: true });
  ledger.hubCall(lin.sessionId, "project.create", { folder: realpathSync.native(main) });
  changes = [];
  ledger.onChange((c) => changes.push(c));
});

afterEach(() => {
  ledger.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const count = (table: string, where = "1 = 1", ...params: (string | number)[]): number =>
  db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, ...params)!.n;
const sessionOf = (workerId: WorkerId): SessionId => db.get<{ id: number }>("SELECT id FROM agent_sessions WHERE worker_id = ?", workerId)!.id;
const convOf = (workerId: WorkerId): ConversationId => db.get<{ c: number }>("SELECT worker_conversation_id AS c FROM workers WHERE id = ?", workerId)!.c;
const emit = (workerId: WorkerId, event: DriverEvent) => ledger.applyDriverEvent(sessionOf(workerId), event);

/** 派一个 Worker，干一轮、汇报，并往它的对话里塞若干条消息、步骤日志、hub 调用记录、交接、动作、磁盘文件。 */
function startWorker(title: string, extraMessages = 0): WorkerId {
  const w = ledger.hubCall(lin.sessionId, "worker.start", { title, task: `${title}：把它修好`, noWorktree: true }, {}).data.worker.id;
  const first = db.get<{ id: number }>("SELECT id FROM messages WHERE dedupe_key = ?", `pm:worker:${w}:task`)!.id;
  emit(w, { type: "message.delivered", messageIds: [first], at: now });
  emit(w, { type: "message.processing", messageIds: [first], at: now });
  emit(w, { type: "agent.tool", uuid: `u-${w}`, toolUseId: `t-${w}`, name: "Bash", input: { command: "ls" }, at: now });
  emit(w, { type: "agent.tool_result", toolUseIds: [`t-${w}`], at: now });
  emit(w, { type: "agent.text", uuid: `r-${w}`, text: `=== 汇报 ===\n状态: 做完了\n摘要: ${title}修好了\n=== 汇报结束 ===`, at: now });
  emit(w, { type: "turn.ended", ok: true, interrupted: false, messageIds: [first], durationMs: null, at: now });
  for (let i = 0; i < extraMessages; i++) {
    db.run(
      `INSERT INTO messages (conversation_id, session_id, worker_id, sender, kind, text, dedupe_key, created_at, updated_at)
       VALUES (?, ?, ?, 'agent', 'text', ?, ?, ?, ?)`,
      convOf(w),
      sessionOf(w),
      w,
      `填充 ${i}`,
      `fill:${w}:${i}`,
      now,
      now,
    );
  }
  db.run("INSERT INTO hub_calls (session_id, command, args, ok, result, created_at) VALUES (?, 'status', '{}', 1, 'ok', ?)", sessionOf(w), now);
  db.run(
    "INSERT INTO handovers (conversation_id, from_session_id, to_session_id, auto, status, created_at, updated_at) VALUES (?, ?, NULL, 0, 'abandoned', ?, ?)",
    convOf(w),
    sessionOf(w),
    now,
    now,
  );
  db.run("INSERT INTO worker_background_waits (session_id, turn_start, background, created_at) VALUES (?, 1, 1, ?)", sessionOf(w), now);
  mkdirSync(join(launchDir, `session-${sessionOf(w)}`), { recursive: true });
  writeFileSync(join(launchDir, `session-${sessionOf(w)}`, "settings.json"), "{}");
  mkdirSync(setupLogsDir, { recursive: true });
  writeFileSync(workerSetupLogPath(setupLogsDir, w), "setup log");
  return w;
}

/** 项目经理收工它：收工时间就是现在（now）。 */
function endWorker(w: WorkerId): number {
  ledger.hubCall(lin.sessionId, "worker.end", { workerId: w }, {});
  // 正常收工后会话要等这一轮回完再关，进程退出会清 pid；这里直接当作已经退出
  createSessionStore(db).update(sessionOf(w), { status: "ended", pid: null });
  // 没有执行器在跑：登记的动作（发任务、结束会话……）当作都做完了
  db.run("UPDATE actions SET status = 'done' WHERE status IN ('pending', 'running')");
  return db.get<{ updated_at: number }>("SELECT updated_at FROM workers WHERE id = ?", w)!.updated_at;
}

const purgedAt = (w: WorkerId) => db.get<{ p: number }>("SELECT purged_at AS p FROM conversation_purges WHERE conversation_id = ?", convOf(w))?.p ?? null;
const reportCount = (w: WorkerId) => count("messages", "worker_id = ? AND kind = 'worker' AND json_extract(meta, '$.event') = 'report'", w);

describe("已收工 Worker 的对话保留期", () => {
  it("常量：30 天", () => {
    expect(WORKER_RETENTION_DAYS).toBe(30);
    expect(WORKER_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("满 30 天：对话消息、步骤日志、hub 记录、交接、等待、动作和磁盘文件都删，记 purged_at、推 conversation.purged", () => {
    const w = startWorker("修登录");
    const sid = sessionOf(w);
    const conv = convOf(w);
    enqueueAction(db, { type: "worktree.create", params: { workerId: w } }, now);
    expect(count("messages", "conversation_id = ?", conv)).toBeGreaterThan(0);
    expect(count("session_steps", "session_id = ?", sid)).toBeGreaterThan(0);
    const endedAt = endWorker(w);
    changes = [];

    const result = ledger.purgeExpiredWorkerConversations(endedAt + WORKER_RETENTION_MS);
    expect(result.purged).toEqual([w]);
    expect(result.more).toBe(false);
    expect(result.rows).toBeGreaterThan(0);

    expect(count("messages", "conversation_id = ?", conv)).toBe(0);
    expect(count("session_steps", "session_id = ?", sid)).toBe(0);
    expect(count("hub_calls", "session_id = ?", sid)).toBe(0);
    expect(count("handovers", "conversation_id = ?", conv)).toBe(0);
    expect(count("worker_background_waits", "session_id = ?", sid)).toBe(0);
    expect(listActions(db).filter((a) => JSON.stringify(a.params).includes(`"workerId":${w}`) || JSON.stringify(a.params).includes(`"sessionId":${sid}`))).toEqual([]);
    expect(existsSync(join(launchDir, `session-${sid}`))).toBe(false);
    expect(existsSync(workerSetupLogPath(setupLogsDir, w))).toBe(false);
    expect(purgedAt(w)).toBe(endedAt + WORKER_RETENTION_MS);
    expect(changes).toEqual([expect.objectContaining({ type: "conversation.purged", data: { conversationId: conv, purgedAt: endedAt + WORKER_RETENTION_MS } })]);
    // 快照里这个对话带 purgedAt、没有消息、也没有“还有更早的”
    const view = ledger.snapshot().conversations.find((c) => c.conversation.id === conv)!;
    expect(view.conversation.purgedAt).toBe(endedAt + WORKER_RETENTION_MS);
    expect(view).toMatchObject({ messages: [], hasMore: false });
    // 再来一次什么都不删
    expect(ledger.purgeExpiredWorkerConversations(endedAt + WORKER_RETENTION_MS + 1)).toEqual({ rows: 0, purged: [], more: false });
  });

  it("差 1 毫秒满 30 天：不删", () => {
    const w = startWorker("修登录");
    const endedAt = endWorker(w);
    const before = count("messages", "conversation_id = ?", convOf(w));
    expect(ledger.purgeExpiredWorkerConversations(endedAt + WORKER_RETENTION_MS - 1)).toEqual({ rows: 0, purged: [], more: false });
    expect(count("messages", "conversation_id = ?", convOf(w))).toBe(before);
    expect(purgedAt(w)).toBeNull();
    expect(existsSync(workerSetupLogPath(setupLogsDir, w))).toBe(true);
  });

  it("还在跑的不删：没收工的 Worker（再老也不删）；收工了但会话还在跑、进程还没退、还有没做完的动作的 Worker", () => {
    const open = startWorker("没收工的");
    const running = startWorker("会话还在跑");
    const pid = startWorker("进程没退");
    const queued = startWorker("有排队的动作");
    const endedAt = Math.max(endWorker(running), endWorker(pid), endWorker(queued));
    createSessionStore(db).update(sessionOf(running), { status: "running" });
    createSessionStore(db).update(sessionOf(pid), { pid: 4242 });
    enqueueAction(db, { type: "session.end", params: { sessionId: sessionOf(queued), generation: 1 } }, now);
    const far = endedAt + 10 * WORKER_RETENTION_MS;

    expect(ledger.purgeExpiredWorkerConversations(far)).toEqual({ rows: 0, purged: [], more: false });
    for (const w of [open, running, pid, queued]) {
      expect(count("messages", "conversation_id = ?", convOf(w))).toBeGreaterThan(0);
      expect(purgedAt(w)).toBeNull();
    }
    // 忙完了就删
    createSessionStore(db).update(sessionOf(running), { status: "ended" });
    createSessionStore(db).update(sessionOf(pid), { pid: null });
    db.run("UPDATE actions SET status = 'done'");
    expect(ledger.purgeExpiredWorkerConversations(far).purged.sort()).toEqual([running, pid, queued].sort());
    expect(purgedAt(open)).toBeNull();
  });

  it("项目经理与总助（assistant）的对话不删：私聊消息、Worker 的汇报和已收工那一行都在，只清 Worker 自己的对话", () => {
    ledger.postUserMessage({ conversationId: lin.conversationId, clientId: "m1", text: "小林你好" });
    // 总助对话（kind = 'assistant'，无 pm_id / project_id）
    const assistantConv = db.get<{ id: number }>(
      "INSERT INTO conversations (kind, title, created_at) VALUES ('assistant', '总助', 0) RETURNING id",
    )!.id;
    db.run(
      "INSERT INTO messages (conversation_id, sender, kind, text, dedupe_key, created_at, updated_at) VALUES (?, 'user', 'text', '总助你好', 'assistant:1', 0, 0)",
      assistantConv,
    );
    const w = startWorker("修登录");
    const pmBefore = count("messages", "conversation_id = ?", lin.conversationId);
    expect(reportCount(w)).toBe(1);
    const endedAt = endWorker(w);
    const pmWithEnded = count("messages", "conversation_id = ?", lin.conversationId);
    expect(pmWithEnded).toBeGreaterThan(pmBefore);

    ledger.purgeExpiredWorkerConversations(endedAt + 365 * 24 * 60 * 60 * 1000);
    expect(count("messages", "conversation_id = ?", lin.conversationId)).toBe(pmWithEnded);
    expect(count("messages", "conversation_id = ?", assistantConv)).toBe(1);
    expect(reportCount(w)).toBe(1);
    expect(count("messages", "conversation_id = ?", convOf(w))).toBe(0);
    // 项目经理与总助的会话、对话没有被打标记
    expect(count("conversation_purges", "conversation_id = ?", lin.conversationId)).toBe(0);
    expect(count("conversation_purges", "conversation_id = ?", assistantConv)).toBe(0);
    expect(count("agent_sessions", "id = ?", lin.sessionId)).toBe(1);
  });

  it("分批：每批一个事务、最多 maxRows 行，没删完的下一批接着删，删完那一批才打标记；批与批之间别的 Worker 的数据不受影响", () => {
    const big = startWorker("大的", 1_200);
    const small = startWorker("小的");
    const endedAt = Math.max(endWorker(big), endWorker(small));
    const total = count("messages", "conversation_id = ?", convOf(big));
    expect(total).toBeGreaterThan(1_200);
    const far = endedAt + WORKER_RETENTION_MS;

    const batches: number[] = [];
    let more = true;
    while (more) {
      const before = count("messages") + count("session_steps") + count("hub_calls") + count("handovers");
      const r = ledger.purgeExpiredWorkerConversations(far, 500);
      const after = count("messages") + count("session_steps") + count("hub_calls") + count("handovers");
      // 一批最多 500 行（含顺手清的动作、小表）
      expect(before - after).toBeLessThanOrEqual(500);
      expect(r.rows).toBeLessThanOrEqual(500);
      batches.push(r.rows);
      if (more && r.more) expect(purgedAt(big)).toBeNull();
      more = r.more;
      if (batches.length > 50) throw new Error("没完没了");
    }
    expect(batches.length).toBeGreaterThanOrEqual(3);
    expect(purgedAt(big)).not.toBeNull();
    expect(purgedAt(small)).not.toBeNull();
    expect(count("messages", "conversation_id IN (?, ?)", convOf(big), convOf(small))).toBe(0);
    // 默认一批的上限
    expect(WORKER_PURGE_BATCH_ROWS).toBeLessThanOrEqual(1_000);
  });

  it("中途失败整批回滚：什么都不留，下次重来", () => {
    const w = startWorker("修登录");
    const endedAt = endWorker(w);
    const messages = count("messages", "conversation_id = ?", convOf(w));
    db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON conversation_purges BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect(() => ledger.purgeExpiredWorkerConversations(endedAt + WORKER_RETENTION_MS)).toThrow(/boom/);
    expect(count("messages", "conversation_id = ?", convOf(w))).toBe(messages);
    expect(existsSync(workerSetupLogPath(setupLogsDir, w))).toBe(true);
    db.exec("DROP TRIGGER boom");
    expect(ledger.purgeExpiredWorkerConversations(endedAt + WORKER_RETENTION_MS).purged).toEqual([w]);
  });

  it("基本记录仍可查：workers 行、会话行、hub worker list / search / show（任务、汇报、状态）都在", () => {
    const w = startWorker("修登录");
    const endedAt = endWorker(w);
    ledger.purgeExpiredWorkerConversations(endedAt + WORKER_RETENTION_MS);

    expect(count("workers", "id = ?", w)).toBe(1);
    expect(count("agent_sessions", "id = ?", sessionOf(w))).toBe(1);
    const list = ledger.hubCall(lin.sessionId, "worker.list", {}, {});
    expect(list.text).toContain(`#${w} 修登录 · 已收工`);
    const hits = ledger.hubCall(lin.sessionId, "worker.search", { keywords: ["修好"] }, {}).data.hits;
    expect(hits.map((h) => h.where).sort()).toEqual(["report", "task"]);
    expect(ledger.hubCall(lin.sessionId, "worker.show", { workerId: w, task: true }, {}).text).toBe("修登录：把它修好");
    expect(ledger.hubCall(lin.sessionId, "worker.show", { workerId: w, report: "latest" }, {}).text).toContain("修登录修好了");
    // show 不带参数：不报错，写明对话已清理
    const show = ledger.hubCall(lin.sessionId, "worker.show", { workerId: w }, {});
    expect(show.text).toContain("已收工");
    expect(show.text).toContain("对话已按保留期清理");
    expect(show.text).toContain(`${WORKER_RETENTION_DAYS} 天`);
    // log / log --stats：不报错，同样写明
    const log = ledger.hubCall(lin.sessionId, "worker.log", { workerId: w }, {});
    expect(log.text).toContain("对话已按保留期清理");
    expect(log.data.steps).toEqual([]);
    expect(ledger.hubCall(lin.sessionId, "worker.log", { workerId: w, stats: true }, {}).text).toContain("对话已按保留期清理");
  });

  it("清过的 Worker 所在的项目经理后来归档到期被清掉：不被外键卡住，conversation_purges 跟着没", () => {
    const w = startWorker("修登录");
    const endedAt = endWorker(w);
    ledger.purgeExpiredWorkerConversations(endedAt + WORKER_RETENTION_MS);
    expect(count("conversation_purges")).toBe(1);
    ledger.archivePm(lin.pmId);
    expect(ledger.purgeExpiredArchivedPms(endedAt + WORKER_RETENTION_MS + PM_ARCHIVE_RETENTION_MS)).toEqual([lin.pmId]);
    expect(count("conversation_purges")).toBe(0);
    expect(count("workers")).toBe(0);
  });

  it("没清过的 Worker：show / log 照旧，不提保留期", () => {
    const w = startWorker("修登录");
    expect(ledger.hubCall(lin.sessionId, "worker.show", { workerId: w }, {}).text).not.toContain("保留期");
    expect(ledger.hubCall(lin.sessionId, "worker.log", { workerId: w }, {}).text).not.toContain("保留期");
  });
});
