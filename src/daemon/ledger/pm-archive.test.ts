import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyActionRow } from "../../shared/actions.ts";
import type { Change } from "../../shared/api.ts";
import type { ConversationId, PmId, SessionId, WorkerId } from "../../shared/domain.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import type { LedgerErrorCode, WorkspaceProbe } from "../../shared/ledger.ts";
import {
  AUTO_RENEW_CONTEXT_TOKENS,
  PM_ARCHIVE_CLEANUP_INTERVAL_MS,
  PM_ARCHIVE_RETENTION_DAYS,
  PM_ARCHIVE_RETENTION_MS,
} from "../../shared/limits.ts";
import { personaFilePath, projectWorktreesDir, sessionLaunchDir, workerSetupLogPath, workerWorktreePath } from "../../shared/paths.ts";
import { enqueueAction, listActions } from "../actions/index.ts";
import { createSessionStore, migrate } from "../store/index.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import type { StopEvent } from "./context.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger } from "./index.ts";
import type { LedgerOptions, SqliteLedger } from "./index.ts";

let db: Db;
let root: string;
let dataHome: string;
let pmHomeRoot: string;
let personasDir: string;
let worktreesDir: string;
let launchDir: string;
let setupLogsDir: string;
let work: string;
let now: number;
let ledger: SqliteLedger;
let changes: Change[];
let enqueued: AnyActionRow[];
let stops: StopEvent[];
let lin: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };
let zhou: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };

function probeOf(_folder: string): WorkspaceProbe {
  return { kind: "ok", isRepoWithCommit: false, hasUncommittedChanges: false };
}

function options(extra: Partial<LedgerOptions> = {}): LedgerOptions {
  return {
    now: () => now,
    initialSeq: 9_000,
    pmHomeRoot,
    personasDir,
    worktreesDir,
    launchDir,
    setupLogsDir,
    dataHome,
    findTranscript: () => "/records/old-session.jsonl",
    resolveFolder: createResolveFolder({ dataHome, userHome: root }),
    osSandboxed: () => true,
    ...extra,
  };
}

function folder(name: string): string {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  return realpathSync.native(dir);
}

function workerSessionOf(workerId: WorkerId): SessionId {
  return db.get<{ id: number }>("SELECT id FROM agent_sessions WHERE worker_id = ?", workerId)!.id;
}

beforeEach(() => {
  db = openTestDb();
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-pm-archive-")));
  dataHome = join(root, ".agent-hub");
  pmHomeRoot = join(dataHome, "pm-home");
  personasDir = join(dataHome, "state", "personas");
  worktreesDir = join(dataHome, "worktrees");
  launchDir = join(dataHome, "state", "launch");
  setupLogsDir = join(dataHome, "state", "logs", "setup");
  work = join(root, "work");
  mkdirSync(work, { recursive: true });
  now = new Date(2026, 10, 4, 8, 0).getTime();
  ledger = createLedger(db, options());
  stops = [];
  ledger.onStopRequested((e) => stops.push(e));
  const a = ledger.createPm({ name: "小林", mode: "manage_only", persona: "小林的习惯" });
  const b = ledger.createPm({ name: "阿周", mode: "hands_on", persona: "阿周的习惯" });
  lin = { pmId: a.pm.id, conversationId: a.conversation.id, sessionId: a.sessionId };
  zhou = { pmId: b.pm.id, conversationId: b.conversation.id, sessionId: b.sessionId };
  changes = [];
  enqueued = [];
  ledger.onChange((c) => changes.push(c));
  ledger.onActionEnqueued((x) => enqueued.push(x));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function expectLedgerError(fn: () => unknown, code: LedgerErrorCode, message?: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LedgerRequestError);
  expect((caught as LedgerRequestError).code).toBe(code);
  if (message) expect((caught as LedgerRequestError).message).toMatch(message);
}

function count(table: string, where = "1 = 1", ...params: (string | number)[]): number {
  return db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, ...params)!.n;
}

describe("0016 迁移与常量", () => {
  it("常量导出正确，且 PRAGMA user_version 回退到 8 重跑 migrate() 幂等", () => {
    expect(PM_ARCHIVE_RETENTION_DAYS).toBe(7);
    expect(PM_ARCHIVE_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(PM_ARCHIVE_CLEANUP_INTERVAL_MS).toBe(60 * 60 * 1000);

    db.exec("PRAGMA user_version = 8");
    expect(() => migrate(db)).not.toThrow();
    expect(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBeGreaterThanOrEqual(16);
  });
});

describe("archivePm 与 unarchivePm", () => {
  it("归档后 archivedAt 变为当前时间、重复归档幂等、snapshot().pms 含 archivedAt，找不到报 not_found", () => {
    expectLedgerError(() => ledger.archivePm(999_999), "not_found");
    expect(ledger.snapshot().pms.find((p) => p.id === lin.pmId)?.archivedAt).toBeNull();

    now += 5_000;
    const archived = ledger.archivePm(lin.pmId);
    expect(archived.archivedAt).toBe(now);
    expect(ledger.snapshot().pms.find((p) => p.id === lin.pmId)?.archivedAt).toBe(now);
    expect(ledger.snapshot().pms.find((p) => p.id === zhou.pmId)?.archivedAt).toBeNull();

    const pmUpdatedChanges = changes.filter((c) => c.type === "pm.updated");
    expect(pmUpdatedChanges).toHaveLength(1);
    expect(pmUpdatedChanges[0]?.data.pm.archivedAt).toBe(now);

    // 重复归档幂等：不改时间戳、不重复推事件
    changes = [];
    now += 10_000;
    const archivedAgain = ledger.archivePm(lin.pmId);
    expect(archivedAgain.archivedAt).toBe(archived.archivedAt);
    expect(changes).toEqual([]);
  });

  it("归档时自动停止正在跑的 PM 会话、结束 open 的 Worker、暂停 enabled 定时任务、放弃进行中的切换", () => {
    const main = folder("foo");
    ledger.hubCall(lin.sessionId, "project.create", { folder: main });

    // 1. 派一个 open 的 Worker，并在 Worker 对话中制造一条 queued 消息
    const started = ledger.hubCall(
      lin.sessionId,
      "worker.start",
      { title: "修登录", task: "排查问题" },
      { workspace: probeOf(main) },
    ).data;
    const workerId = started.worker.id;
    const workerConvId = started.worker.workerConversationId;
    const workerSessionId = workerSessionOf(workerId);
    const workerQueuedMsg = ledger.postUserMessage({ conversationId: workerConvId, clientId: "w-c1", text: "给 Worker 的话" });

    // 2. 创建一个 enabled 定时任务和一个已暂停定时任务
    const schedEnabled = ledger.addSchedule(lin.pmId, { name: "早报", everyMinutes: 30, prompt: "汇报" });
    const schedPaused = ledger.addSchedule(lin.pmId, { name: "周报", everyMinutes: 60, prompt: "周报" });
    ledger.setScheduleEnabled(schedPaused.id, false);

    // 3. 触发 PM 会话的后台切换（handover 处于 queued）
    const firstTurnMsg = ledger.postUserMessage({ conversationId: lin.conversationId, clientId: "pm-c0", text: "第一轮" }).messageId;
    createSessionStore(db).update(lin.sessionId, {
      usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 10, context: AUTO_RENEW_CONTEXT_TOKENS + 1_000 },
    });
    ledger.applyDriverEvent(lin.sessionId, { type: "message.delivered", messageIds: [firstTurnMsg], at: now });
    ledger.applyDriverEvent(lin.sessionId, { type: "message.processing", messageIds: [firstTurnMsg], at: now });
    ledger.applyDriverEvent(lin.sessionId, { type: "agent.text", uuid: "u-0", text: "好的", at: now });
    ledger.applyDriverEvent(lin.sessionId, {
      type: "turn.ended",
      ok: true,
      interrupted: false,
      messageIds: [firstTurnMsg],
      durationMs: 10,
      at: now,
    });
    expect(count("handovers", "conversation_id = ? AND status = 'queued'", lin.conversationId)).toBe(1);

    // 4. 让 PM 会话处于运行中（processing），再排队一条用户消息
    const runningMsg = ledger.postUserMessage({ conversationId: lin.conversationId, clientId: "pm-run", text: "正在跑" }).messageId;
    ledger.applyDriverEvent(lin.sessionId, { type: "message.delivered", messageIds: [runningMsg], at: now });
    ledger.applyDriverEvent(lin.sessionId, { type: "message.processing", messageIds: [runningMsg], at: now });
    const pmQueuedMsg = ledger.postUserMessage({ conversationId: lin.conversationId, clientId: "pm-c1", text: "排队中的消息" });

    changes = [];
    enqueued = [];
    stops = [];
    now += 1_000;

    // 5. 归档 PM
    const archived = ledger.archivePm(lin.pmId);
    expect(archived.archivedAt).toBe(now);

    // PM 正在跑的轮次收到 stop 请求，排队消息变为 stopped，但 PM 自己的 agent_sessions 保持非 ended（恢复后可继续用）
    expect(stops.some((s) => s.sessionId === lin.sessionId)).toBe(true);
    expect(ledger.getMessage(pmQueuedMsg.messageId)?.status).toBe("stopped");
    expect(createSessionStore(db).get(lin.sessionId)?.status).not.toBe("ended");

    // handover 变为 abandoned，且不再被 claimHandover 领出
    expect(count("handovers", "conversation_id = ? AND status = 'abandoned'", lin.conversationId)).toBe(1);
    expect(ledger.claimHandover()).toBeNull();

    // open 的 Worker 变为 ended，Worker 的会话变为 ended 并入队 session.end，Worker 排队消息变为 stopped
    const workerRow = db.get<{ status: string }>("SELECT status FROM workers WHERE id = ?", workerId);
    expect(workerRow?.status).toBe("ended");
    expect(createSessionStore(db).get(workerSessionId)?.status).toBe("ended");
    expect(enqueued.some((a) => a.type === "session.end" && a.params.sessionId === workerSessionId)).toBe(true);
    expect(ledger.getMessage(workerQueuedMsg.messageId)?.status).toBe("stopped");

    // enabled 定时任务变为暂停，并推 schedule.updated
    const schedulesAfter = ledger.snapshot().schedules.filter((s) => s.pmId === lin.pmId);
    expect(schedulesAfter.every((s) => !s.enabled)).toBe(true);
    const schedUpdates = changes.filter((c) => c.type === "schedule.updated");
    expect(schedUpdates).toHaveLength(1);
    expect(schedUpdates[0]?.data.schedule.id).toBe(schedEnabled.id);
    expect(schedUpdates[0]?.data.schedule.enabled).toBe(false);
  });

  it("归档期间拦截所有写操作，且到期巡检跳过已归档 PM，新建同名 PM 提示已归档", () => {
    const main = folder("foo");
    const sub = folder("bar");
    ledger.hubCall(lin.sessionId, "project.create", { folder: main });
    const started = ledger.hubCall(
      lin.sessionId,
      "worker.start",
      { title: "任务1", task: "干活" },
      { workspace: probeOf(main) },
    ).data;
    const sched = ledger.addSchedule(lin.pmId, { name: "巡检", everyMinutes: 15, prompt: "看状态" });
    const changeId = ledger.editPersona(lin.pmId, { text: "新性格" }, { kind: "user" }).change!.id;

    // 制造一条 failed 消息供测试 retryMessage
    const msgId = ledger.postUserMessage({ conversationId: lin.conversationId, clientId: "c-fail", text: "失败消息" }).messageId;
    db.run("UPDATE messages SET status = 'failed', failure_reason = '出错' WHERE id = ?", msgId);

    // 归档小林
    ledger.archivePm(lin.pmId);

    const archivedErr = /这个项目经理已归档，请先恢复/;

    // 1. 发消息（PM 对话和 Worker 对话）与重试消息
    expectLedgerError(
      () => ledger.postUserMessage({ conversationId: lin.conversationId, clientId: "c2", text: "你好" }),
      "conflict",
      archivedErr,
    );
    expectLedgerError(
      () => ledger.postUserMessage({ conversationId: started.worker.workerConversationId, clientId: "c3", text: "你好" }),
      "conflict",
      archivedErr,
    );
    expectLedgerError(() => ledger.retryMessage(msgId), "conflict", archivedErr);

    // 2. 改性格设定、撤回性格设定
    expectLedgerError(() => ledger.editPersona(lin.pmId, { text: "再改" }, { kind: "user" }), "conflict", archivedErr);
    expectLedgerError(() => ledger.revertPersonaChange(changeId), "conflict", archivedErr);
    expectLedgerError(() => ledger.hubCall(lin.sessionId, "persona.edit", { text: "再改" }), "conflict", archivedErr);

    // 3. 重开会话
    expectLedgerError(() => ledger.renewSession(lin.pmId), "conflict", archivedErr);

    // 4. 文件夹绑定/解绑/setup 与派 Worker
    expectLedgerError(() => ledger.hubCall(lin.sessionId, "project.attach", { folder: sub }), "conflict", archivedErr);
    expectLedgerError(() => ledger.hubCall(lin.sessionId, "project.detach", { folder: sub }), "conflict", archivedErr);
    expectLedgerError(() => ledger.hubCall(lin.sessionId, "project.setup", { command: "echo hi" }), "conflict", archivedErr);
    expectLedgerError(
      () => ledger.hubCall(lin.sessionId, "worker.start", { title: "任务2", task: "干活" }, { workspace: probeOf(main) }),
      "conflict",
      archivedErr,
    );

    // 5. 添加或开启定时任务
    expectLedgerError(
      () => ledger.addSchedule(lin.pmId, { name: "新任务", everyMinutes: 15, prompt: "跑" }),
      "conflict",
      archivedErr,
    );
    expectLedgerError(() => ledger.setScheduleEnabled(sched.id, true), "conflict", archivedErr);
    expectLedgerError(
      () => ledger.hubCall(lin.sessionId, "schedule.add", { name: "新任务", everyMinutes: 15, prompt: "跑" }),
      "conflict",
      archivedErr,
    );
    expectLedgerError(() => ledger.hubCall(lin.sessionId, "schedule.resume", { scheduleId: sched.id }), "conflict", archivedErr);

    // 6. 即使数据库里某条定时任务 enabled = 1，runDueSchedules 也跳过已归档 PM
    db.run("UPDATE schedules SET enabled = 1, next_run_at = ? WHERE id = ?", now - 1_000, sched.id);
    const countBefore = count("messages", "conversation_id = ?", lin.conversationId);
    ledger.runDueSchedules(now);
    expect(count("messages", "conversation_id = ?", lin.conversationId)).toBe(countBefore);

    // 7. 新建同名 PM 提示已归档
    expectLedgerError(
      () => ledger.createPm({ name: "小林", mode: "manage_only", persona: "" }),
      "conflict",
      /已经有一个叫“小林”的项目经理（已归档），请换个名字或先恢复它/,
    );
  });

  it("7 天内调用 unarchivePm 恢复归档：archivedAt 变回 null、重复恢复幂等，恢复后一切写操作正常", () => {
    expectLedgerError(() => ledger.unarchivePm(999_999), "not_found");
    const main = folder("foo");
    ledger.hubCall(lin.sessionId, "project.create", { folder: main });
    const sched = ledger.addSchedule(lin.pmId, { name: "巡检", everyMinutes: 15, prompt: "看状态" });

    ledger.archivePm(lin.pmId);
    expect(ledger.snapshot().pms.find((p) => p.id === lin.pmId)?.archivedAt).toBe(now);

    // 过 3 天后恢复
    now += 3 * 24 * 60 * 60 * 1000;
    changes = [];
    const restored = ledger.unarchivePm(lin.pmId);
    expect(restored.archivedAt).toBeNull();
    expect(ledger.snapshot().pms.find((p) => p.id === lin.pmId)?.archivedAt).toBeNull();
    expect(changes).toEqual([{ seq: expect.any(Number), type: "pm.updated", data: { pm: restored } }]);

    // 重复恢复幂等
    changes = [];
    expect(ledger.unarchivePm(lin.pmId).archivedAt).toBeNull();
    expect(changes).toEqual([]);

    // 恢复后可以正常发消息、改性格设定、派 Worker、开启定时任务
    const msg = ledger.postUserMessage({ conversationId: lin.conversationId, clientId: "after-restore", text: "我回来了" });
    expect(ledger.getMessage(msg.messageId)?.text).toBe("我回来了");

    const edited = ledger.editPersona(lin.pmId, { text: "恢复后的新习惯" }, { kind: "user" });
    expect(edited.change?.textAfter).toBe("恢复后的新习惯");

    const workerStarted = ledger.hubCall(
      lin.sessionId,
      "worker.start",
      { title: "恢复后派活", task: "继续做" },
      { workspace: probeOf(main) },
    );
    expect(workerStarted.data.worker.status).toBe("open");

    const enabledSched = ledger.setScheduleEnabled(sched.id, true);
    expect(enabledSched.enabled).toBe(true);
  });
});

describe("purgeExpiredArchivedPms（7 天到期彻底清理）", () => {
  it("未满 7 天不清理并返回 []；满 7 天后彻底清理全部关联表与内部磁盘目录，保留用户项目目录与其他 PM", () => {
    const mainLin = folder("lin-main");
    const extraLin = folder("lin-extra");
    const mainZhou = folder("zhou-main");
    writeFileSync(join(mainLin, "README.md"), "用户主仓库代码");
    writeFileSync(join(extraLin, "notes.txt"), "用户附加文件夹内容");

    // 为小林创建项目、附加文件夹、Worker、消息、定时任务、性格变更、切换、交接、步骤、等待、动作及内部磁盘文件
    const projLin = ledger.hubCall(lin.sessionId, "project.create", { folder: mainLin }).data.project;
    ledger.hubCall(lin.sessionId, "project.attach", { folder: extraLin });
    ledger.editPersona(lin.pmId, { text: "改过一次性格" }, { kind: "user" });
    const schedLin = ledger.addSchedule(lin.pmId, { name: "小林定时", everyMinutes: 30, prompt: "检查" });
    const workerStarted = ledger.hubCall(
      lin.sessionId,
      "worker.start",
      { title: "小林的Worker", task: "干活" },
      { workspace: probeOf(mainLin) },
    ).data;
    const workerId = workerStarted.worker.id;
    const workerSessionId = workerSessionOf(workerId);
    ledger.postUserMessage({ conversationId: lin.conversationId, clientId: "m1", text: "小林的消息" });
    ledger.postUserMessage({ conversationId: workerStarted.worker.workerConversationId, clientId: "m2", text: "Worker的消息" });

    // 往 session_steps、session_persona_seen、worker_background_waits、handovers、handoffs、actions 插入关联记录以验证外键清理顺序
    db.run(
      "INSERT INTO session_steps (session_id, kind, summary, at) VALUES (?, 'tool', 'Read a.ts', ?)",
      lin.sessionId,
      now,
    );
    db.run(
      "INSERT INTO session_persona_seen (session_id, revision) VALUES (?, 1) ON CONFLICT(session_id) DO UPDATE SET revision = 1",
      lin.sessionId,
    );
    db.run(
      "INSERT INTO worker_background_waits (session_id, turn_start, background, created_at) VALUES (?, 1, 1, ?)",
      workerSessionId,
      now,
    );
    db.run(
      `INSERT INTO handovers (conversation_id, from_session_id, to_session_id, auto, status, created_at, updated_at)
       VALUES (?, ?, NULL, 0, 'abandoned', ?, ?)`,
      lin.conversationId,
      lin.sessionId,
      now,
      now,
    );
    db.run(
      `INSERT INTO handoffs (project_id, from_session_id, to_session_id, from_pm_id, to_pm_id, file, reason, created_at)
       VALUES (?, ?, ?, ?, ?, '/tmp/handoff.md', '交接摘要', ?)`,
      projLin.id,
      lin.sessionId,
      lin.sessionId,
      lin.pmId,
      lin.pmId,
      now,
    );
    enqueueAction(db, { type: "worktree.create", params: { workerId } }, now);

    // 准备内部磁盘目录和文件
    const pmHomePath = join(pmHomeRoot, String(lin.pmId));
    const personaPath = personaFilePath(personasDir, lin.pmId);
    const worktreePath = workerWorktreePath(worktreesDir, projLin.id, workerId);
    const pmLaunchPath = sessionLaunchDir(launchDir, lin.sessionId);
    const workerLaunchPath = sessionLaunchDir(launchDir, workerSessionId);
    const setupLogPath = workerSetupLogPath(setupLogsDir, workerId);
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, "temp.txt"), "worktree file");
    mkdirSync(pmLaunchPath, { recursive: true });
    writeFileSync(join(pmLaunchPath, "settings.json"), "{}");
    mkdirSync(workerLaunchPath, { recursive: true });
    writeFileSync(join(workerLaunchPath, "settings.json"), "{}");
    mkdirSync(setupLogsDir, { recursive: true });
    writeFileSync(setupLogPath, "setup log output");

    expect(existsSync(pmHomePath)).toBe(true);
    expect(existsSync(personaPath)).toBe(true);
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(pmLaunchPath)).toBe(true);
    expect(existsSync(workerLaunchPath)).toBe(true);
    expect(existsSync(setupLogPath)).toBe(true);

    // 阿周也有自己的项目和消息，确保清理小林不会误伤阿周
    ledger.hubCall(zhou.sessionId, "project.create", { folder: mainZhou });
    ledger.postUserMessage({ conversationId: zhou.conversationId, clientId: "z1", text: "阿周的消息" });

    // 归档小林
    const archivedAt = now;
    ledger.archivePm(lin.pmId);

    // 还没有到期时（差 1 毫秒满 7 天）：不清理任何东西
    expect(ledger.purgeExpiredArchivedPms(archivedAt + PM_ARCHIVE_RETENTION_MS - 1)).toEqual([]);
    expect(count("pms", "id = ?", lin.pmId)).toBe(1);
    expect(existsSync(pmHomePath)).toBe(true);

    // 满 7 天时：触发清理
    changes = [];
    const purged = ledger.purgeExpiredArchivedPms(archivedAt + PM_ARCHIVE_RETENTION_MS);
    expect(purged).toEqual([lin.pmId]);

    // 再次调用返回 []
    expect(ledger.purgeExpiredArchivedPms(archivedAt + PM_ARCHIVE_RETENTION_MS + 1_000)).toEqual([]);

    // 验证外键开启且小林所有数据库记录均已删除
    expect(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
    expect(count("pms", "id = ?", lin.pmId)).toBe(0);
    expect(count("pm_archives", "pm_id = ?", lin.pmId)).toBe(0);
    expect(count("projects", "pm_id = ?", lin.pmId)).toBe(0);
    expect(count("project_folders", "project_id = ?", projLin.id)).toBe(0);
    expect(count("workers", "pm_id = ?", lin.pmId)).toBe(0);
    expect(count("conversations", "pm_id = ?", lin.pmId)).toBe(0);
    expect(count("conversations", "id IN (?, ?)", lin.conversationId, workerStarted.worker.workerConversationId)).toBe(0);
    expect(count("agent_sessions", "id IN (?, ?)", lin.sessionId, workerSessionId)).toBe(0);
    expect(count("messages", "conversation_id IN (?, ?)", lin.conversationId, workerStarted.worker.workerConversationId)).toBe(0);
    expect(count("schedules", "pm_id = ?", lin.pmId)).toBe(0);
    expect(count("persona_changes", "pm_id = ?", lin.pmId)).toBe(0);
    expect(count("handovers", "conversation_id = ?", lin.conversationId)).toBe(0);
    expect(count("handoffs", "project_id = ?", projLin.id)).toBe(0);
    expect(count("hub_calls", "session_id IN (?, ?)", lin.sessionId, workerSessionId)).toBe(0);
    expect(count("session_steps", "session_id IN (?, ?)", lin.sessionId, workerSessionId)).toBe(0);
    expect(count("session_persona_seen", "session_id IN (?, ?)", lin.sessionId, workerSessionId)).toBe(0);
    expect(count("worker_background_waits", "session_id = ?", workerSessionId)).toBe(0);
    const remainingActions = listActions(db);
    expect(
      remainingActions.some(
        (a) =>
          ("sessionId" in a.params && (a.params.sessionId === lin.sessionId || a.params.sessionId === workerSessionId)) ||
          ("workerId" in a.params && a.params.workerId === workerId),
      ),
    ).toBe(false);

    // 推送了 schedule.removed 与 pm.removed
    expect(changes).toContainEqual({
      seq: expect.any(Number),
      type: "schedule.removed",
      data: { scheduleId: schedLin.id },
    });
    expect(changes).toContainEqual({
      seq: expect.any(Number),
      type: "pm.removed",
      data: { pmId: lin.pmId },
    });

    // 验证内部目录和文件已删除
    expect(existsSync(pmHomePath)).toBe(false);
    expect(existsSync(personaPath)).toBe(false);
    expect(existsSync(projectWorktreesDir(worktreesDir, projLin.id))).toBe(false);
    expect(existsSync(pmLaunchPath)).toBe(false);
    expect(existsSync(workerLaunchPath)).toBe(false);
    expect(existsSync(setupLogPath)).toBe(false);

    // 验证用户项目文件夹完好无损！
    expect(existsSync(mainLin)).toBe(true);
    expect(readFileSync(join(mainLin, "README.md"), "utf8")).toBe("用户主仓库代码");
    expect(existsSync(extraLin)).toBe(true);
    expect(readFileSync(join(extraLin, "notes.txt"), "utf8")).toBe("用户附加文件夹内容");

    // 验证阿周的数据完好无损，且现在可以重新创建名为“小林”的 PM
    expect(count("pms", "id = ?", zhou.pmId)).toBe(1);
    expect(count("projects", "pm_id = ?", zhou.pmId)).toBe(1);
    expect(count("messages", "conversation_id = ?", zhou.conversationId)).toBe(2);
    const recreated = ledger.createPm({ name: "小林", mode: "manage_only", persona: "全新的小林" });
    expect(recreated.pm.name).toBe("小林");
    expect(recreated.pm.archivedAt).toBeNull();
  });
});
