import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { systemEventOf, type Message } from "../../shared/domain.ts";
import { PM_AGENDA_REMINDER_HISTORY_MAX_ROWS, PM_AGENDA_REMINDER_TICK_MS, PM_AGENDA_REMINDERS_MAX } from "../../shared/limits.ts";
import { agendaCountsOf, agendaLinesOf } from "../../shared/pm-agenda.ts";
import { isGraphReadyNotice, isPmNoticeSubject, OVERDUE_AGENDA_REF_PREFIX, pmNoticeDedupeRef } from "../../shared/pm-notice.ts";
import { canDeliverSystemMessage } from "../handlers.ts";
import { createLedger } from "./index.ts";
import { isPmAgendaItemOpen, pmAgendaOf } from "./pm-agenda.ts";
import { createPmFrictionFixture, reportBlock, type PmFrictionFixture } from "./pm-friction-fixture.ts";
import { dueAgendaRemindersOf, startAgendaReminderLoop } from "./pm-agenda-reminders.ts";
import { systemWakeupKey } from "./system-wakeups.ts";

const MINUTE = 60_000;

describe("S6: an idle PM is reminded about work it left open (D-A1 option 1)", () => {
  let f: PmFrictionFixture;

  beforeEach(() => {
    f = createPmFrictionFixture();
  });

  afterEach(() => {
    f.close();
  });

  async function readyGraph(): Promise<number> {
    const graph = f.createGraph({ title: "等交付", steps: [{ key: "impl", title: "实现", brief: "实现" }] }).data.graph;
    const wid = f.showGraph(graph.id).nodes[0]!.activeWorkerId!;
    await f.startWorktree(wid);
    f.workerTurn(wid, reportBlock({ status: "做完了", summary: "实现好了" }));
    const note = f.pmSystemMessages().find(isGraphReadyNotice)!;
    f.pmReplyTo(note.id, "等检查通过后再交付");
    return graph.id;
  }

  it("S6.1: nothing is due before 15 minutes; at 15 minutes one reminder lists the ready graph", async () => {
    const graphId = await readyGraph();
    expect(dueAgendaRemindersOf(f.db, f.clock.now + 14 * MINUTE)).toEqual([]);
    const due = dueAgendaRemindersOf(f.db, f.clock.now + 15 * MINUTE);
    expect(due).toHaveLength(1);
    expect(due[0]!.pmId).toBe(f.lin.pmId);
    expect(due[0]!.refs.some((ref) => ref.startsWith(`graph:${graphId}:`))).toBe(true);
  });

  it("S6.2: no reminder while a message is queued for the PM", async () => {
    await readyGraph();
    f.ledger.postUserMessage({ conversationId: f.lin.conversationId, clientId: "queued", text: "排着的" });
    expect(dueAgendaRemindersOf(f.db, f.clock.now + 20 * MINUTE)).toEqual([]);
  });

  function overdueNotices(conversationId = f.lin.conversationId): Message[] {
    return f.pmSystemMessages(conversationId).filter((m) => {
      const event = systemEventOf(m);
      return event?.event === "pm.wakeup" && event.subject?.kind === "pm.agenda" && event.subject.trigger === "overdue";
    });
  }

  it("S6.2: waits while the PM is mid-turn or running background tasks, then fires once idle", async () => {
    await readyGraph();
    const msgId = f.ledger.postUserMessage({ conversationId: f.lin.conversationId, clientId: "mid-turn", text: "问个事" }).messageId;
    f.ledger.applyDriverEvent(f.lin.sessionId, { type: "message.delivered", messageIds: [msgId], at: ++f.clock.now });
    f.ledger.applyDriverEvent(f.lin.sessionId, { type: "message.processing", messageIds: [msgId], at: ++f.clock.now });
    expect(dueAgendaRemindersOf(f.db, f.clock.now + 20 * MINUTE)).toEqual([]);
    expect(f.ledger.runDueAgendaReminders(f.clock.now + 20 * MINUTE)).toBe(0);

    f.ledger.applyDriverEvent(f.lin.sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [msgId], durationMs: 10, at: ++f.clock.now });
    f.db.run("INSERT INTO session_background_tasks (session_id, count) VALUES (?, 1)", f.lin.sessionId);
    expect(dueAgendaRemindersOf(f.db, f.clock.now + 20 * MINUTE)).toEqual([]);

    f.db.run("DELETE FROM session_background_tasks WHERE session_id = ?", f.lin.sessionId);
    expect(dueAgendaRemindersOf(f.db, f.clock.now + 20 * MINUTE)).toHaveLength(1);
  });

  it("S6.3: drops a queued overdue reminder if its items resolve before delivery", async () => {
    const graphId = await readyGraph();
    const at = f.clock.now + 15 * MINUTE;
    expect(f.ledger.runDueAgendaReminders(at)).toBe(1);
    const [notice] = overdueNotices();
    expect(notice).toBeDefined();
    expect(notice!.text).toContain("【这些事等你处理超过 15 分钟了】");
    expect(notice!.text).toContain(`图 #${graphId}`);
    expect(systemEventOf(notice!)).toMatchObject({
      event: "pm.wakeup",
      subject: { kind: "pm.agenda", trigger: "overdue", refs: [expect.stringMatching(new RegExp(`^graph:${graphId}:ready@`, "u"))] },
    });
    expect(canDeliverSystemMessage(f.ledger, f.lin.sessionId, notice!.id)).toBe(true);

    f.ledger.hubCall(f.lin.sessionId, "graph.finish", { graphId, summary: "已交付" });
    expect(canDeliverSystemMessage(f.ledger, f.lin.sessionId, notice!.id)).toBe(false);
    expect(f.ledger.getMessage(notice!.id)?.status).toBe("stopped");
  });

  it("a reminder dropped when a watch is added does not burn a slot or collide once the watch closes", async () => {
    const graphId = await readyGraph();
    const t15 = f.clock.now + 15 * MINUTE;
    expect(f.ledger.runDueAgendaReminders(t15)).toBe(1);
    const [dropped] = overdueNotices();
    f.clock.now = t15 + MINUTE;
    const watch = f.ledger.hubCall(f.lin.sessionId, "watch.add", { afterMs: 30 * MINUTE, graphId, body: "等检查" }).data.watch;
    expect(canDeliverSystemMessage(f.ledger, f.lin.sessionId, dropped!.id)).toBe(false);
    expect(f.ledger.getMessage(dropped!.id)?.status).toBe("stopped");

    const closedAt = f.clock.now + 5 * MINUTE;
    f.clock.now = closedAt;
    f.ledger.hubCall(f.lin.sessionId, "watch.close", { watchId: watch.id });
    expect(f.ledger.runDueAgendaReminders(closedAt + 14 * MINUTE)).toBe(0);
    expect(f.ledger.runDueAgendaReminders(closedAt + 15 * MINUTE)).toBe(1);
    const active = overdueNotices().filter((m) => m.status !== "stopped");
    expect(active).toHaveLength(1);
    expect(active[0]!.id).not.toBe(dropped!.id);
  });

  it("S6.4: reminds at 15, 30, 60, and 120 minutes then stops; a state change starts a fresh schedule", async () => {
    const graphId = await readyGraph();
    const t0 = f.clock.now;
    const milestones = [15, 30, 60, 120];
    for (const [index, mins] of milestones.entries()) {
      expect(f.ledger.runDueAgendaReminders(t0 + (mins - 1) * MINUTE)).toBe(0);
      f.clock.now = t0 + mins * MINUTE;
      expect(f.ledger.runDueAgendaReminders(f.clock.now)).toBe(1);
      const sent = overdueNotices();
      expect(sent).toHaveLength(index + 1);
      f.pmReplyTo(sent.at(-1)!.id, "知道了，再等等");
    }
    expect(dueAgendaRemindersOf(f.db, t0 + 240 * MINUTE)).toEqual([]);
    expect(f.ledger.runDueAgendaReminders(t0 + 480 * MINUTE)).toBe(0);
    expect(overdueNotices()).toHaveLength(PM_AGENDA_REMINDERS_MAX);

    // Patching adds a new step and finishing it creates a new ref with a fresh 15m schedule.
    f.clock.now = t0 + 500 * MINUTE;
    f.patchGraph({ addSteps: [{ key: "verify", title: "补验证", brief: "补验证" }] }, graphId);
    const wid = f.showGraph(graphId).nodes.find((n) => n.key === "verify")!.activeWorkerId!;
    await f.startWorktree(wid);
    f.workerTurn(wid, reportBlock({ status: "做完了", summary: "补验证好了" }));
    const nextReady = f.pmSystemMessages().filter(isGraphReadyNotice).at(-1)!;
    f.pmReplyTo(nextReady.id, "好的");
    expect(dueAgendaRemindersOf(f.db, f.clock.now + 14 * MINUTE)).toEqual([]);
    expect(dueAgendaRemindersOf(f.db, f.clock.now + 15 * MINUTE)).toHaveLength(1);
  });

  it("combines multiple overdue items into one reminder and never reminds about user decision cards", async () => {
    const ready = await readyGraph();
    const braked = f.createGraph({ title: "停下的图", steps: [{ key: "fix", title: "修复", brief: "修复" }] }).data.graph;
    const fixWid = f.showGraph(braked.id).nodes[0]!.activeWorkerId!;
    await f.startWorktree(fixWid);
    f.workerTurn(fixWid, reportBlock({ status: "有问题", summary: "卡住了", questions: "怎么处理？" }));
    const solo = f.ledger.hubCall(f.lin.sessionId, "worker.start", { title: "独立任务", task: "查一下", noWorktree: true }).data.worker;
    f.workerTurn(solo.id, reportBlock({ status: "做完了", summary: "查完了" }));
    f.ledger.hubCall(f.lin.sessionId, "ask", { text: "要不要发版？", options: ["发", "不发"] });
    for (const msg of f.pmMessages().filter((m) => m.status === "queued")) f.pmReplyTo(msg.id, "收到");

    const at = f.clock.now + 15 * MINUTE;
    expect(f.ledger.runDueAgendaReminders(at)).toBe(1);
    const [notice] = overdueNotices();
    expect(notice!.text).toContain(`图 #${ready}`);
    expect(notice!.text).toContain(`图 #${braked.id}`);
    expect(notice!.text).toContain(`Worker #${solo.id}`);
    expect(notice!.text).not.toContain("要不要发版");
    expect(notice!.text).not.toContain("等用户");
    const event = systemEventOf(notice!);
    expect(event?.event === "pm.wakeup" && event.subject?.kind === "pm.agenda" && event.subject.trigger === "overdue" ? event.subject.refs : []).toHaveLength(3);
  });

  it("S6.5: no duplicate after a daemon restart right after a reminder", async () => {
    await readyGraph();
    const t15 = f.clock.now + 15 * MINUTE;
    f.clock.now = t15;
    expect(f.ledger.runDueAgendaReminders(t15)).toBe(1);
    const [first] = overdueNotices();
    f.pmReplyTo(first!.id, "稍后处理");

    const restarted = createLedger(f.db, {
      now: () => f.clock.now,
      pmHomeRoot: `${f.root}/data/pm-home`,
      dataHome: `${f.root}/data`,
      worktreesDir: `${f.root}/data/worktrees`,
      launchDir: `${f.root}/data/state/launch`,
      setupLogsDir: `${f.root}/data/state/logs/setup`,
      userHome: f.root,
      models: { current: () => null, availability: () => "available" },
    });
    try {
      restarted.recoverAfterRestart();
      expect(dueAgendaRemindersOf(f.db, t15 + MINUTE)).toEqual([]);
      expect(restarted.runDueAgendaReminders(t15 + MINUTE)).toBe(0);
      expect(overdueNotices()).toHaveLength(1);
      expect(dueAgendaRemindersOf(f.db, t15 + 15 * MINUTE)).toHaveLength(1);
    } finally {
      restarted.close();
    }
  });

  it("S6.6: waits during quiet hours (23:00–08:00 local) and fires once with backoff afterward", async () => {
    f.clock.now = new Date(2026, 10, 20, 22, 50).getTime();
    await readyGraph();
    expect(dueAgendaRemindersOf(f.db, new Date(2026, 10, 20, 23, 10).getTime())).toEqual([]);
    expect(dueAgendaRemindersOf(f.db, new Date(2026, 10, 21, 7, 59).getTime())).toEqual([]);

    const morning = new Date(2026, 10, 21, 8, 0).getTime();
    f.clock.now = morning;
    expect(f.ledger.runDueAgendaReminders(morning)).toBe(1);
    f.pmReplyTo(overdueNotices().at(-1)!.id, "早上处理");
    expect(dueAgendaRemindersOf(f.db, morning + 5 * MINUTE)).toEqual([]);
    expect(dueAgendaRemindersOf(f.db, morning + 15 * MINUTE)).toHaveLength(1);
  });

  it("S6.6: suppresses items covered by a watching watch and excludes archived PMs", async () => {
    const ready = await readyGraph();
    const solo = f.ledger.hubCall(f.lin.sessionId, "worker.start", { title: "等发布", task: "等发布", noWorktree: true }).data.worker;
    f.workerTurn(solo.id, reportBlock({ status: "做完了", summary: "好了" }));
    for (const msg of f.pmMessages().filter((m) => m.status === "queued")) f.pmReplyTo(msg.id, "好的");

    const wGraph = f.ledger.hubCall(f.lin.sessionId, "watch.add", { afterMs: 30 * MINUTE, graphId: ready, body: "到点交付" }).data.watch;
    f.ledger.hubCall(f.lin.sessionId, "watch.add", { afterMs: 30 * MINUTE, workerId: solo.id, body: "等发版" });
    expect(dueAgendaRemindersOf(f.db, f.clock.now + 20 * MINUTE)).toEqual([]);

    // Closing the watch starts a fresh 15-minute wait before reminding.
    const closedAt = f.clock.now + 20 * MINUTE;
    f.clock.now = closedAt;
    f.ledger.hubCall(f.lin.sessionId, "watch.close", { watchId: wGraph.id });
    expect(dueAgendaRemindersOf(f.db, closedAt + 14 * MINUTE)).toEqual([]);
    expect(dueAgendaRemindersOf(f.db, closedAt + 15 * MINUTE)).toHaveLength(1);

    // Archived PMs are never reminded, and queued reminders for them become stale.
    const archivedPm = f.createPm("归档经理");
    const otherGraph = f.ledger.hubCall(archivedPm.sessionId, "graph.create", {
      specJson: JSON.stringify({ title: "已归档", steps: [{ key: "a", title: "步" }] }),
    }).data.graph;
    for (const msg of f.pmMessages(archivedPm.conversationId).filter((m) => m.status === "queued")) {
      f.pmReplyTo(msg.id, "看一眼", archivedPm);
    }
    expect(dueAgendaRemindersOf(f.db, f.clock.now + 15 * MINUTE).some((r) => r.pmId === archivedPm.pmId)).toBe(true);
    expect(f.ledger.runDueAgendaReminders(f.clock.now + 15 * MINUTE)).toBe(2);
    const queuedForArchived = overdueNotices(archivedPm.conversationId)[0]!;
    expect(f.ledger.isSystemMessageCurrent!(queuedForArchived.id)).toBe(true);
    f.ledger.archivePm(archivedPm.pmId);
    expect(f.ledger.isSystemMessageCurrent!(queuedForArchived.id)).toBe(false);
    expect(dueAgendaRemindersOf(f.db, f.clock.now + 30 * MINUTE).some((r) => r.pmId === archivedPm.pmId)).toBe(false);
    expect(otherGraph.id).toBeGreaterThan(0);
  });

  it("timer loop stops immediately on shutdown, ledger.close blocks reminder writes, and overdue subjects validate", () => {
    const s1 = { kind: "pm.agenda" as const, trigger: "overdue" as const, refs: ["graph:1:ready@1000"] };
    const s2 = { kind: "pm.agenda" as const, trigger: "overdue" as const, refs: ["graph:1:ready@1000"], round: 2 };
    expect(isPmNoticeSubject(s1)).toBe(true);
    expect(isPmNoticeSubject(s2)).toBe(true);
    expect(pmNoticeDedupeRef(s1)).not.toBe(pmNoticeDedupeRef(s2));

    vi.useFakeTimers();
    try {
      const logs: string[] = [];
      let calls = 0;
      const loop = startAgendaReminderLoop({
        run: () => {
          calls += 1;
          if (calls === 2) throw new Error("boom");
          return 0;
        },
        now: () => 1_000,
        tickMs: PM_AGENDA_REMINDER_TICK_MS,
        log: (line) => logs.push(line),
      });
      expect(calls).toBe(1);
      vi.advanceTimersByTime(PM_AGENDA_REMINDER_TICK_MS);
      expect(calls).toBe(2);
      expect(logs.some((line) => line.includes("boom"))).toBe(true);
      loop.stop();
      vi.advanceTimersByTime(5 * PM_AGENDA_REMINDER_TICK_MS);
      loop.tick();
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }

    f.ledger.close();
    expect(f.ledger.runDueAgendaReminders(f.clock.now + 30 * MINUTE)).toBe(0);
  });

  it("regression (B4 contract): a watched graph's waiting_pm step stays open across agenda, handover notice, and overdue reminders", async () => {
    const ready = await readyGraph();
    const braked = f.createGraph({ title: "带盯条件的停下步骤", steps: [{ key: "merge", title: "合并" }] }).data.graph;
    for (const msg of f.pmMessages().filter((m) => m.status === "queued")) f.pmReplyTo(msg.id, "先盯着");
    const solo = f.ledger.hubCall(f.lin.sessionId, "worker.start", { title: "等发布", task: "等发布", noWorktree: true }).data.worker;
    f.workerTurn(solo.id, reportBlock({ status: "做完了", summary: "好了" }));
    for (const msg of f.pmMessages().filter((m) => m.status === "queued")) f.pmReplyTo(msg.id, "好的");

    f.ledger.hubCall(f.lin.sessionId, "watch.add", { afterMs: 30 * MINUTE, graphId: ready, body: "到点交付" });
    f.ledger.hubCall(f.lin.sessionId, "watch.add", { afterMs: 30 * MINUTE, graphId: braked.id, body: "等检查" });
    f.ledger.hubCall(f.lin.sessionId, "watch.add", { afterMs: 30 * MINUTE, workerId: solo.id, body: "等发版" });

    const agenda = pmAgendaOf(f.db, f.lin.pmId, f.clock.now);
    const lines = agendaLinesOf(agenda);
    const counts = agendaCountsOf(agenda);
    expect(counts.needsPm).toBe(1);
    expect(lines.filter((line) => line.needsPm).map((line) => line.ref)).toEqual([
      expect.stringMatching(new RegExp(`^graph:${braked.id}:step:merge:waiting_pm@`, "u")),
    ]);
    for (const line of lines) {
      expect(isPmAgendaItemOpen(f.db, f.lin.pmId, line.ref)).toBe(line.needsPm);
    }

    // Vendor switch enqueues a handover notice that remains deliverable instead of being retired immediately.
    f.ledger.editPersona(f.lin.pmId, { vendor: "codex", model: "gpt-6-luna" }, { kind: "user" });
    const nextSessionId = f.db
      .all<{ id: number }>("SELECT id FROM agent_sessions WHERE conversation_id = ? ORDER BY generation", f.lin.conversationId)
      .at(-1)!.id;
    const handover = f.pmMessages().find((m) => m.sessionId === nextSessionId && m.text.includes("【交接后还有事等你】"));
    expect(handover).toBeDefined();
    expect(canDeliverSystemMessage(f.ledger, nextSessionId, handover!.id)).toBe(true);
    expect(f.ledger.getMessage(handover!.id)?.status).toBe("queued");

    // Once the handover notice is handled, the waiting_pm step is due at 15 minutes while watched ready/worker stay suppressed.
    f.ledger.applyDriverEvent(nextSessionId, { type: "message.delivered", messageIds: [handover!.id], at: ++f.clock.now });
    f.ledger.applyDriverEvent(nextSessionId, { type: "message.processing", messageIds: [handover!.id], at: ++f.clock.now });
    f.ledger.applyDriverEvent(nextSessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [handover!.id], durationMs: 10, at: ++f.clock.now });
    const due = dueAgendaRemindersOf(f.db, f.clock.now + 15 * MINUTE);
    expect(due).toHaveLength(1);
    expect(due[0]!.refs).toEqual([expect.stringMatching(new RegExp(`^graph:${braked.id}:step:merge:waiting_pm@`, "u"))]);
  });

  it("regression (Stop interruption): a delivered reminder stopped by the user still counts toward backoff and the 4-round cap", async () => {
    await readyGraph();
    const t0 = f.clock.now;
    const milestones = [15, 30, 60, 120];
    for (const [index, mins] of milestones.entries()) {
      const at = t0 + mins * MINUTE;
      f.clock.now = at;
      expect(f.ledger.runDueAgendaReminders(at)).toBe(1);
      const sent = overdueNotices();
      expect(sent).toHaveLength(index + 1);
      const reminder = sent.at(-1)!;
      f.ledger.applyDriverEvent(f.lin.sessionId, { type: "message.delivered", messageIds: [reminder.id], at: at + 1 });
      f.ledger.applyDriverEvent(f.lin.sessionId, { type: "message.processing", messageIds: [reminder.id], at: at + 2 });
      f.ledger.requestStop(f.lin.conversationId);
      f.ledger.applyDriverEvent(f.lin.sessionId, {
        type: "turn.ended",
        ok: false,
        interrupted: true,
        messageIds: [reminder.id],
        durationMs: 100,
        at: at + 102,
      });
      expect(f.ledger.getMessage(reminder.id)).toMatchObject({ status: "stopped", meta: { deliveryConfirmed: true } });

      // Next 60-second tick must not re-fire immediately after user Stop.
      expect(dueAgendaRemindersOf(f.db, at + MINUTE)).toEqual([]);
      expect(f.ledger.runDueAgendaReminders(at + MINUTE)).toBe(0);
    }
    expect(dueAgendaRemindersOf(f.db, t0 + 240 * MINUTE)).toEqual([]);
    expect(f.ledger.runDueAgendaReminders(t0 + 240 * MINUTE)).toBe(0);
    expect(overdueNotices()).toHaveLength(PM_AGENDA_REMINDERS_MAX);
  });

  it("regression (month-scale history): a 4-times-capped item stays silent past 200 later reminders and retired stopped rows", async () => {
    await readyGraph();
    const t0 = f.clock.now;
    for (const mins of [15, 30, 60, 120]) {
      f.clock.now = t0 + mins * MINUTE;
      expect(f.ledger.runDueAgendaReminders(f.clock.now)).toBe(1);
      f.pmReplyTo(overdueNotices().at(-1)!.id, "知道了");
    }
    expect(dueAgendaRemindersOf(f.db, t0 + 240 * MINUTE)).toEqual([]);

    // Simulate >200 later delivered reminders on other refs plus >200 pre-delivery retired stopped rows.
    const insertSql = `INSERT INTO messages (conversation_id, session_id, sender, kind, text, meta, collapsed, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, 'system', 'text', '【这些事等你处理超过 15 分钟了】', ?, 1, ?, ?, ?, ?)`;
    const baseAt = t0 + 130 * MINUTE;
    f.db.transaction(() => {
      for (let i = 0; i < 250; i++) {
        const ref = `graph:${9_000 + i}:ready@${baseAt + i}`;
        const subject = { kind: "pm.agenda", trigger: "overdue", refs: [ref], round: 1 };
        const meta = JSON.stringify({ event: "pm.wakeup", source: "task_graph", ref: `${OVERDUE_AGENDA_REF_PREFIX}1:other-${i}`, subject, deliveryConfirmed: true });
        const key = systemWakeupKey(f.lin.conversationId, "task_graph", `${OVERDUE_AGENDA_REF_PREFIX}1:other-${i}`);
        f.db.run(insertSql, f.lin.conversationId, f.lin.sessionId, meta, key, "replied", baseAt + i, baseAt + i);
      }
      for (let i = 0; i < PM_AGENDA_REMINDER_HISTORY_MAX_ROWS + 10; i++) {
        const ref = `graph:${19_000 + i}:ready@${baseAt + 1_000 + i}`;
        const subject = { kind: "pm.agenda", trigger: "overdue", refs: [ref], round: 1 };
        const meta = JSON.stringify({ event: "pm.wakeup", source: "task_graph", ref: `${OVERDUE_AGENDA_REF_PREFIX}1:retired-${i}`, subject });
        const key = systemWakeupKey(f.lin.conversationId, "task_graph", `${OVERDUE_AGENDA_REF_PREFIX}1:retired-${i}`);
        f.db.run(insertSql, f.lin.conversationId, f.lin.sessionId, meta, key, "stopped", baseAt + 1_000 + i, baseAt + 1_000 + i);
      }
    });

    const checkAt = baseAt + 30 * MINUTE;
    expect(dueAgendaRemindersOf(f.db, checkAt)).toEqual([]);
    expect(f.ledger.runDueAgendaReminders(checkAt)).toBe(0);
  });
});
