import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyActionRow } from "../../shared/actions.ts";
import type { Change } from "../../shared/api.ts";
import { systemEventOf, systemMessageDedupeKey } from "../../shared/domain.ts";
import type { ConversationId, Message, MessageId, PmId, SessionId } from "../../shared/domain.ts";
import {
  FEISHU_GUEST_BLOCKED_HUB_COMMANDS,
  feishuGuestTurnBlockReason,
  type FeishuMessageOrigin,
  type FeishuOpenId,
} from "../../shared/feishu.ts";
import { HUB_HELP_ONLY_COMMANDS, type HubArgs, type HubCommand } from "../../shared/hub.ts";
import { LedgerRequestError, type LedgerErrorCode } from "../../shared/ledger.ts";
import {
  MAX_SCHEDULE_NAME_CHARS,
  MAX_SCHEDULES_PER_PM,
  MAX_TASK_BYTES,
  SCHEDULE_SHOW_RUNS_MAX,
} from "../../shared/limits.ts";
import { planScheduleEdit } from "../../shared/schedule.ts";
import { migrate, openDatabase, type Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createLedger, type SqliteLedger } from "./index.ts";
import { recentScheduleRuns } from "./schedule-runs.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const local = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime();

let db: Db;
let root: string;
let now: number;
let ledger: SqliteLedger;
let changes: Change[];
let enqueued: AnyActionRow[];
let lin: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };
let zhou: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };

function mountLedger(targetDb: Db) {
  return createLedger(targetDb, {
    now: () => now,
    initialSeq: 12_000,
    pmHomeRoot: join(root, "pm-home"),
    dataHome: join(root, ".agent-hub"),
  });
}

beforeEach(() => {
  db = openTestDb();
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-schedule-edit-")));
  mkdirSync(join(root, "pm-home"), { recursive: true });
  now = local(4, 8);
  ledger = mountLedger(db);
  const a = ledger.createPm({ name: "小林", mode: "manage_only", persona: "" });
  const b = ledger.createPm({ name: "阿周", mode: "hands_on", persona: "" });
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

function hub<C extends HubCommand>(sessionId: SessionId, command: C, args: HubArgs<C>) {
  return ledger.hubCall(sessionId, command, args);
}

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

const messagesIn = (conversationId: ConversationId = lin.conversationId): Message[] =>
  db.all<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? ORDER BY id", conversationId).map((r) => ledger.getMessage(r.id)!);

const runsIn = (conversationId: ConversationId = lin.conversationId) =>
  messagesIn(conversationId).filter((m) => systemEventOf(m)?.event === "schedule.run");

function addSchedule(args: Partial<HubArgs<"schedule.add">> = {}, caller = lin.sessionId) {
  return hub(caller, "schedule.add", { name: "日报", prompt: "第一版日报说明", daily: "09:00", ...args }).data.schedule;
}

function pmReplyTo(messageId: MessageId, replyText: string): void {
  ledger.applyDriverEvent(lin.sessionId, { type: "message.delivered", messageIds: [messageId], at: now });
  ledger.applyDriverEvent(lin.sessionId, { type: "message.processing", messageIds: [messageId], at: now });
  ledger.applyDriverEvent(lin.sessionId, { type: "agent.text", uuid: `u-pm-${messageId}-${now}`, text: replyText, at: now });
  ledger.applyDriverEvent(lin.sessionId, {
    type: "turn.ended",
    ok: true,
    interrupted: false,
    messageIds: [messageId],
    durationMs: 100,
    at: now,
  });
}

describe("S1: in-place edit keeps #id, preserves run history, supports consecutive turns, and handles no-op", () => {
  it("S1.1: two consecutive edits keep id and run history, emit schedule.updated, and expose edit hints", () => {
    const created = addSchedule();
    for (let i = 1; i <= 2; i++) {
      now = local(3 + i, 9);
      ledger.runDueSchedules(now);
      const run = runsIn().at(-1)!;
      pmReplyTo(run.id, `第 ${i} 次历史日报已完成`);
    }
    const beforeEdit = hub(lin.sessionId, "schedule.show", { scheduleId: created.id }).data.schedule;
    changes = [];

    now = local(5, 10);
    const turn1 = hub(lin.sessionId, "schedule.edit", {
      scheduleId: created.id,
      name: " 升级日报 ",
      everyMinutes: 30,
      prompt: "第二版日报说明\n包含风险项",
    });
    expect(turn1.data.schedule).toMatchObject({
      id: created.id,
      pmId: lin.pmId,
      name: "升级日报",
      kind: "interval",
      atTime: null,
      everyMinutes: 30,
      prompt: "第二版日报说明\n包含风险项",
      enabled: true,
      nextRunAt: now + 30 * MINUTE,
      createdAt: beforeEdit.createdAt,
      lastRunAt: beforeEdit.lastRunAt,
      lastStatus: beforeEdit.lastStatus,
      lastMessageId: beforeEdit.lastMessageId,
      updatedAt: now,
    });
    expect(turn1.text).toContain(`#${created.id}`);
    expect(turn1.text).toContain("升级日报");
    expect(changes.map((c) => c.type)).toEqual(["schedule.updated"]);
    expect(db.get("SELECT command, ok FROM hub_calls ORDER BY id DESC LIMIT 1")).toEqual({ command: "schedule.edit", ok: 1 });

    now = local(5, 10, 5);
    changes = [];
    const turn2 = hub(lin.sessionId, "schedule.edit", {
      scheduleId: created.id,
      daily: "18:00",
    });
    expect(turn2.data.schedule).toMatchObject({
      id: created.id,
      name: "升级日报",
      kind: "daily",
      atTime: "18:00",
      everyMinutes: null,
      prompt: "第二版日报说明\n包含风险项",
      nextRunAt: local(5, 18),
      lastRunAt: beforeEdit.lastRunAt,
      lastMessageId: beforeEdit.lastMessageId,
    });

    const shown = hub(lin.sessionId, "schedule.show", { scheduleId: created.id });
    expect(shown.text).toContain("升级日报");
    expect(shown.text).toContain("第二版日报说明\n包含风险项");
    expect(shown.text).toContain("第 2 次历史日报已完成");
    expect(shown.text).toContain("第 1 次历史日报已完成");
    expect(shown.text).toContain(HUB_HELP_ONLY_COMMANDS["schedule.edit"]);
    expect(shown.data.runs).toHaveLength(2);

    const listed = hub(lin.sessionId, "schedule.list", {});
    expect(listed.text).toContain(HUB_HELP_ONLY_COMMANDS["schedule.edit"]);
  });

  it("S1.2: an exact no-op edit keeps updatedAt and nextRunAt untouched and emits no change", () => {
    const created = addSchedule({ name: "日报", prompt: "第一版", daily: "09:00" });
    now = local(4, 8, 30);
    changes = [];
    const res = hub(lin.sessionId, "schedule.edit", {
      scheduleId: created.id,
      name: " 日报 ",
      daily: "09:00",
      prompt: "第一版",
    });
    expect(res.text).toContain("没有改动");
    expect(res.data.schedule).toEqual(created);
    expect(changes).toEqual([]);
  });
});

describe("S2: restart mid-operation persists edited schedules and fires new content", () => {
  it("S2.1: reopening SQLite after editing enabled and paused schedules keeps ids, values, and pause state", () => {
    const dbPath = join(root, "restart.db");
    let fileDb: Db = openDatabase(dbPath);
    migrate(fileDb);
    try {
      let fileLedger = mountLedger(fileDb);
      const pm = fileLedger.createPm({ name: "重启经理", mode: "manage_only", persona: "" });
      const active = fileLedger.hubCall(pm.sessionId, "schedule.add", { name: "旧巡检", prompt: "旧说明", daily: "09:00" }).data.schedule;
      const paused = fileLedger.hubCall(pm.sessionId, "schedule.add", { name: "旧周报", prompt: "旧周报说明", daily: "08:30" }).data.schedule;
      fileLedger.hubCall(pm.sessionId, "schedule.pause", { scheduleId: paused.id });

      now = local(4, 8, 10);
      fileLedger.hubCall(pm.sessionId, "schedule.edit", {
        scheduleId: active.id,
        name: "新巡检",
        everyMinutes: 30,
        prompt: "重启后应执行的巡检说明",
      });
      fileLedger.hubCall(pm.sessionId, "schedule.edit", {
        scheduleId: paused.id,
        name: "新周报",
        daily: "10:00",
        prompt: "重启后恢复才执行的周报说明",
      });

      fileDb.close();
      fileDb = openDatabase(dbPath);
      migrate(fileDb);
      fileLedger = mountLedger(fileDb);

      expect(fileLedger.snapshot().schedules.map((s) => ({ id: s.id, name: s.name, enabled: s.enabled }))).toEqual([
        { id: active.id, name: "新巡检", enabled: true },
        { id: paused.id, name: "新周报", enabled: false },
      ]);

      now = local(4, 10, 5);
      fileLedger.runDueSchedules(now);
      const fired = fileDb
        .all<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? ORDER BY id", pm.conversation.id)
        .map((r) => fileLedger.getMessage(r.id)!)
        .filter((m) => systemEventOf(m)?.event === "schedule.run");
      expect(fired).toHaveLength(1);
      expect(fired[0]!.meta).toMatchObject({ scheduleId: active.id, name: "新巡检" });
      expect(fired[0]!.text).toContain("重启后应执行的巡检说明");

      const resumed = fileLedger.hubCall(pm.sessionId, "schedule.resume", { scheduleId: paused.id }).data.schedule;
      expect(resumed).toMatchObject({ id: paused.id, enabled: true, nextRunAt: local(5, 10) });
    } finally {
      fileDb.close();
    }
  });
});

describe("S3: enabled/paused nextRunAt recalculation, in-flight runs, archive/unarchive, and timezone re-anchoring", () => {
  it("S3.1: planScheduleEdit and enabled edit preserve nextRunAt when frequency is unchanged and recompute when changed", () => {
    const created = addSchedule({ name: "巡检", daily: undefined, everyMinutes: 60, prompt: "v1" });
    expect(created.nextRunAt).toBe(local(4, 9));

    const nameOnlyPlan = planScheduleEdit(created, { name: "巡检 v2", prompt: "v2" }, local(4, 8, 50));
    expect(nameOnlyPlan).toEqual({
      ok: true,
      plan: {
        changed: true,
        frequencyChanged: false,
        name: "巡检 v2",
        kind: "interval",
        atTime: null,
        everyMinutes: 60,
        prompt: "v2",
        nextRunAt: local(4, 9),
      },
    });

    now = local(4, 8, 50);
    const afterNameOnly = hub(lin.sessionId, "schedule.edit", {
      scheduleId: created.id,
      name: "巡检 v2",
      everyMinutes: 60,
      prompt: "v2",
    }).data.schedule;
    expect(afterNameOnly.nextRunAt).toBe(local(4, 9));

    const afterFreqChange = hub(lin.sessionId, "schedule.edit", {
      scheduleId: created.id,
      everyMinutes: 30,
    }).data.schedule;
    expect(afterFreqChange.nextRunAt).toBe(local(4, 9, 20));
    ledger.runDueSchedules(now);
    expect(runsIn()).toEqual([]);
  });

  it("S3.2: paused schedule stays paused across frequency edit, never fires while paused, and recomputes from resume time", () => {
    const created = addSchedule({ name: "日报", daily: "09:00", prompt: "v1" });
    hub(lin.sessionId, "schedule.pause", { scheduleId: created.id });

    now = local(4, 10);
    const edited = hub(lin.sessionId, "schedule.edit", {
      scheduleId: created.id,
      everyMinutes: 45,
      prompt: "暂停中升级的新说明",
    }).data.schedule;
    expect(edited).toMatchObject({ enabled: false, kind: "interval", everyMinutes: 45, nextRunAt: now + 45 * MINUTE });

    now = local(4, 12);
    ledger.runDueSchedules(now);
    expect(runsIn()).toEqual([]);

    const resumed = hub(lin.sessionId, "schedule.resume", { scheduleId: created.id }).data.schedule;
    expect(resumed).toMatchObject({ enabled: true, nextRunAt: local(4, 12, 45) });

    now = local(4, 12, 45);
    ledger.runDueSchedules(now);
    expect(runsIn()).toHaveLength(1);
    expect(runsIn()[0]!.text).toContain("暂停中升级的新说明");
  });

  it("S3.3: editing while an earlier run is in-flight preserves single-flight skip and failure tracking", () => {
    const created = addSchedule({ name: "巡检", daily: undefined, everyMinutes: 60, prompt: "v1" });
    now = local(4, 9);
    ledger.runDueSchedules(now);
    const firstRun = runsIn()[0]!;
    ledger.applyDriverEvent(lin.sessionId, { type: "message.delivered", messageIds: [firstRun.id], at: now });
    ledger.applyDriverEvent(lin.sessionId, { type: "message.processing", messageIds: [firstRun.id], at: now });

    now = local(4, 9, 5);
    const edited = hub(lin.sessionId, "schedule.edit", {
      scheduleId: created.id,
      name: "新巡检",
      everyMinutes: 15,
      prompt: "v2 说明",
    }).data.schedule;
    expect(edited.lastMessageId).toBe(firstRun.id);

    now = local(4, 9, 20);
    ledger.runDueSchedules(now);
    expect(runsIn()).toHaveLength(1);
    expect(hub(lin.sessionId, "schedule.show", { scheduleId: created.id }).data.schedule.lastStatus).toBe("skipped");

    ledger.applyDriverEvent(lin.sessionId, {
      type: "turn.ended",
      ok: false,
      interrupted: false,
      messageIds: [firstRun.id],
      durationMs: 1,
      at: now,
      error: { subtype: "error_during_execution", message: "boom" },
    });
    expect(hub(lin.sessionId, "schedule.show", { scheduleId: created.id }).data.schedule).toMatchObject({
      lastStatus: "failed",
      lastError: expect.stringContaining("boom"),
    });

    now = local(4, 9, 35);
    ledger.runDueSchedules(now);
    expect(runsIn()).toHaveLength(2);
    expect(runsIn()[1]!.text).toContain("新巡检");
    expect(runsIn()[1]!.text).toContain("v2 说明");
  });

  it("S3.4: archived PM rejects schedule.edit with conflict; unarchived PM can edit while paused", () => {
    const created = addSchedule();
    ledger.archivePm(lin.pmId);
    expectLedgerError(
      () => hub(lin.sessionId, "schedule.edit", { scheduleId: created.id, name: "归档中改名" }),
      "conflict",
    );
    ledger.unarchivePm(lin.pmId);
    const edited = hub(lin.sessionId, "schedule.edit", { scheduleId: created.id, name: "解档后改名" }).data.schedule;
    expect(edited).toMatchObject({ id: created.id, name: "解档后改名", enabled: false });
  });

  it("S3.5: editing to daily HH:MM re-anchors cleanly after a timezone change", () => {
    const savedTz = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      now = new Date(2026, 10, 3, 7).getTime();
      const created = addSchedule({ daily: undefined, everyMinutes: 60 });
      hub(lin.sessionId, "schedule.edit", { scheduleId: created.id, daily: "09:00" });

      process.env.TZ = "America/Los_Angeles";
      const end = now + 2 * DAY;
      for (let t = now; t <= end; t += 30_000) {
        now = t;
        ledger.runDueSchedules(t);
        for (const run of runsIn()) {
          if (run.status === "queued") db.run("UPDATE messages SET status = 'replied' WHERE id = ?", run.id);
        }
      }
      const pad = (n: number) => String(n).padStart(2, "0");
      expect(
        runsIn().map((m) => {
          const d = new Date(m.createdAt);
          return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }),
      ).toEqual(["11-03 09:00", "11-04 09:00"]);
    } finally {
      if (savedTz === undefined) delete process.env.TZ;
      else process.env.TZ = savedTz;
    }
  });
});

describe("S4: permissions, project isolation, and Feishu guest gating", () => {
  it("S4.1: rejects editing another PM's schedule (forbidden), missing id (not_found), and Worker or Router sessions (forbidden)", () => {
    const theirs = addSchedule({ name: "阿周的任务" }, zhou.sessionId);
    expectLedgerError(() => hub(lin.sessionId, "schedule.edit", { scheduleId: theirs.id, name: "越权改" }), "forbidden", /不是你建的/);
    expectLedgerError(() => hub(lin.sessionId, "schedule.edit", { scheduleId: 99_999, name: "不存在" }), "not_found", /没有编号 99999/);
    expect(hub(zhou.sessionId, "schedule.show", { scheduleId: theirs.id }).data.schedule.name).toBe("阿周的任务");

    const projectDir = join(root, "proj");
    mkdirSync(projectDir, { recursive: true });
    hub(lin.sessionId, "project.create", { folder: projectDir, name: "demo" });
    const worker = hub(lin.sessionId, "worker.start", { title: "干活", task: "做一件事", noWorktree: true }).data.worker;
    const workerSession = db.get<{ id: SessionId }>("SELECT id FROM agent_sessions WHERE worker_id = ?", worker.id)!;
    expectLedgerError(() => hub(workerSession.id, "schedule.edit", { scheduleId: theirs.id, name: "worker 改" }), "forbidden");

    const routerSessionId = Number(
      db.run(
        "INSERT INTO agent_sessions (role, vendor_session_id, cwd, created_at, updated_at) VALUES ('assistant', 'vs-router', ?, ?, ?)",
        root,
        now,
        now,
      ).lastInsertRowid,
    );
    expectLedgerError(() => hub(routerSessionId, "schedule.edit", { scheduleId: theirs.id, name: "router 改" }), "forbidden");
  });

  it("S4.2: Feishu chat_only and observer guest turns block schedule.edit while collaborator and owner turns allow it", () => {
    expect(FEISHU_GUEST_BLOCKED_HUB_COMMANDS.chat_only).toContain("schedule.edit");
    expect(FEISHU_GUEST_BLOCKED_HUB_COMMANDS.observer).toContain("schedule.edit");
    expect(FEISHU_GUEST_BLOCKED_HUB_COMMANDS.collaborator).not.toContain("schedule.edit");

    const origin = (role: "owner" | "guest", guestTier: "chat_only" | "observer" | "collaborator"): FeishuMessageOrigin => ({
      kind: "feishu",
      openId: "ou_guest1" as FeishuOpenId,
      name: "访客甲",
      role,
      mode: "shared",
      guestTier,
      context: [],
    });
    expect(feishuGuestTurnBlockReason("schedule.edit", origin("guest", "chat_only"))).toMatch(/访客/);
    expect(feishuGuestTurnBlockReason("schedule.edit", origin("guest", "observer"))).toMatch(/访客/);
    expect(feishuGuestTurnBlockReason("schedule.edit", origin("guest", "collaborator"))).toBeNull();
    expect(feishuGuestTurnBlockReason("schedule.edit", origin("owner", "chat_only"))).toBeNull();

    const created = addSchedule();
    const msg = db.get<{ id: MessageId }>(
      `INSERT INTO messages (conversation_id, session_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, 'user', 'text', '帮我改定时任务', ?, 'feishu:guest:edit:1', 'processing', ?, ?) RETURNING id`,
      lin.conversationId,
      lin.sessionId,
      JSON.stringify({ origin: origin("guest", "chat_only") }),
      now,
      now,
    )!;
    expectLedgerError(
      () => hub(lin.sessionId, "schedule.edit", { scheduleId: created.id, name: "访客改" }),
      "forbidden",
      /访客/,
    );
    db.run("UPDATE messages SET status = 'replied' WHERE id = ?", msg.id);
    expect(hub(lin.sessionId, "schedule.edit", { scheduleId: created.id, name: "主人改" }).data.schedule.name).toBe("主人改");
  });
});

describe("S5: one-month data volume and editing at the 20-schedule cap", () => {
  it("S5.1: editing succeeds at MAX_SCHEDULES_PER_PM and schedule.show keeps using the dedupe_key index across 30,000 messages", () => {
    const first = addSchedule({ name: "满额任务1", daily: undefined, everyMinutes: 30 });
    for (let i = 2; i <= MAX_SCHEDULES_PER_PM; i++) {
      addSchedule({ name: `满额任务${i}`, daily: "09:00" });
    }
    const baseAt = now - 31 * DAY;
    db.transaction(() => {
      for (let i = 0; i < 30_000; i++) {
        const at = baseAt + i * MINUTE;
        const isRun = i < 1_440;
        const scheduledAt = baseAt + i * 30 * MINUTE;
        const meta = isRun
          ? JSON.stringify({ event: "schedule.run", scheduleId: first.id, name: first.name, scheduledAt, catchUp: false })
          : null;
        const dedupeKey = isRun
          ? systemMessageDedupeKey(lin.conversationId, { event: "schedule.run", scheduleId: first.id, name: first.name, scheduledAt, catchUp: false })
          : `client:${lin.conversationId}:vol-${i}`;
        db.run(
          `INSERT INTO messages (conversation_id, session_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
           VALUES (?, ?, ?, 'text', ?, ?, ?, 'replied', ?, ?)`,
          lin.conversationId,
          lin.sessionId,
          isRun ? "system" : "user",
          isRun ? `run ${i}` : `chat ${i}`,
          meta,
          dedupeKey,
          at,
          at,
        );
      }
    });

    const edited = hub(lin.sessionId, "schedule.edit", {
      scheduleId: first.id,
      name: "满额也能原地改",
      prompt: "满额更新后的说明",
    }).data.schedule;
    expect(edited).toMatchObject({ id: first.id, name: "满额也能原地改", prompt: "满额更新后的说明" });

    const allSpy = vi.spyOn(db, "all");
    const runs = recentScheduleRuns(db, lin.conversationId, first.id, SCHEDULE_SHOW_RUNS_MAX);
    const [sql, ...params] = allSpy.mock.calls[0]!;
    const plan = db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params);
    expect(plan.map((s) => s.detail).join("\n")).toMatch(/SEARCH messages USING INDEX .*dedupe_key>\? AND dedupe_key<\?/);
    expect(runs).toHaveLength(SCHEDULE_SHOW_RUNS_MAX);

    const shown = hub(lin.sessionId, "schedule.show", { scheduleId: first.id });
    expect(shown.text).toContain("满额也能原地改");
    expect(shown.text).toContain("满额更新后的说明");
    expect(shown.data.runs).toHaveLength(SCHEDULE_SHOW_RUNS_MAX);
  });
});

describe("S6: malformed inputs, limit enforcement, and dirty historical run data", () => {
  it("S6.1: rejects empty patch, conflicting cadence, invalid fields, and limit overflows without modifying the row", () => {
    const created = addSchedule({ name: "原名", prompt: "原说明", daily: "09:00" });
    const bad = (patch: Omit<HubArgs<"schedule.edit">, "scheduleId">, pattern: RegExp) =>
      expectLedgerError(() => hub(lin.sessionId, "schedule.edit", { scheduleId: created.id, ...patch }), "invalid", pattern);

    bad({}, /至少/);
    bad({ daily: "09:00", everyMinutes: 30 }, /二选一/);
    bad({ name: "   " }, /名字/);
    bad({ name: "a\nb" }, /名字/);
    bad({ name: "【日报】" }, /【/);
    bad({ name: "长".repeat(MAX_SCHEDULE_NAME_CHARS + 1) }, new RegExp(`定时任务名称有 .*上限 ${MAX_SCHEDULE_NAME_CHARS} 字`));
    bad({ prompt: " \n " }, /任务说明不能是空的/);
    bad({ prompt: "x".repeat(MAX_TASK_BYTES + 1) }, new RegExp(`任务说明有 .*上限 ${MAX_TASK_BYTES / 1024} KB`));
    bad({ daily: "9:00" }, /HH:MM/);
    bad({ daily: "24:00" }, /HH:MM/);
    bad({ everyMinutes: 14 }, /最短 15 分钟/);
    bad({ everyMinutes: 7 * 24 * 60 + 1 }, /最长/);
    bad({ everyMinutes: 30.5 }, /整数/);

    expect(hub(lin.sessionId, "schedule.show", { scheduleId: created.id }).data.schedule).toEqual(created);
  });

  it("S6.2: editing and showing a schedule with corrupt meta or deleted historical run messages still succeeds", () => {
    const created = addSchedule({ name: "容错任务", daily: undefined, everyMinutes: 60 });
    now += HOUR;
    ledger.runDueSchedules(now);
    const run1 = runsIn().at(-1)!;
    now += HOUR;
    ledger.runDueSchedules(now);
    const run2 = runsIn().at(-1)!;
    db.run("UPDATE messages SET meta = '{broken' WHERE id = ?", run1.id);
    db.run("DELETE FROM messages WHERE id = ?", run2.id);

    const edited = hub(lin.sessionId, "schedule.edit", { scheduleId: created.id, name: "容错任务v2", prompt: "更新后" }).data.schedule;
    expect(edited.id).toBe(created.id);
    const shown = hub(lin.sessionId, "schedule.show", { scheduleId: created.id });
    expect(shown.text).toContain("容错任务v2");
    expect(shown.text).toContain("这次运行的记录已清理");
  });
});

describe("S8: regression checks for existing schedule commands", () => {
  it("regression: add, list, show, pause, resume, and remove keep existing behavior and id allocation", () => {
    const first = addSchedule({ name: "晨报", daily: "09:00", prompt: "写晨报" });
    const second = addSchedule({ name: "巡检", daily: undefined, everyMinutes: 30, prompt: "做巡检" });
    expect(second.id).toBe(first.id + 1);
    expect(hub(lin.sessionId, "schedule.list", {}).data.schedules.map((s) => s.id)).toEqual([first.id, second.id]);
    expect(hub(lin.sessionId, "schedule.pause", { scheduleId: first.id }).data.schedule.enabled).toBe(false);
    expect(hub(lin.sessionId, "schedule.resume", { scheduleId: first.id }).data.schedule.enabled).toBe(true);
    expect(hub(lin.sessionId, "schedule.show", { scheduleId: first.id }).text).toContain("写晨报");
    hub(lin.sessionId, "schedule.remove", { scheduleId: first.id });
    expect(hub(lin.sessionId, "schedule.list", {}).data.schedules.map((s) => s.id)).toEqual([second.id]);
  });
});
