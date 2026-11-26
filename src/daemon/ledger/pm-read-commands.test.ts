import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pendingDecisionsOf } from "../../shared/decisions.ts";
import { systemEventOf, systemMessageDedupeKey } from "../../shared/domain.ts";
import { HUB_HELP_ONLY_COMMANDS } from "../../shared/hub.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import { ASK_LIST_MAX, SCHEDULE_RUN_REPLY_PREVIEW_CHARS, SCHEDULE_SHOW_RUNS_MAX } from "../../shared/limits.ts";
import { formatAskDetail, formatPendingAskList, pendingAsksNote, pendingAsksSection, type PendingAsk } from "../../shared/pending-asks.ts";
import { askDetailOf, pendingAsksOfPm } from "./pending-asks.ts";
import { createPmFrictionFixture, reportBlock, type PmFrictionFixture } from "./pm-friction-fixture.ts";
import { recentScheduleRuns, withCleanedLastRun } from "./schedule-runs.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("S3: read a schedule (hub schedule list & show)", () => {
  let f: PmFrictionFixture;

  beforeEach(() => {
    f = createPmFrictionFixture();
  });

  afterEach(() => {
    f.close();
  });

  it("S3.1: schedule list prints last run time and ends with the schedule.show hint", () => {
    const added = f.ledger.hubCall(f.lin.sessionId, "schedule.add", {
      name: "每晚复盘",
      prompt: "第 1 步：归类审查问题\n第 2 步：更新规则文件",
      everyMinutes: 60,
    }).data.schedule;
    f.clock.now += HOUR;
    f.ledger.runDueSchedules(f.clock.now);

    const listed = f.ledger.hubCall(f.lin.sessionId, "schedule.list", {});
    expect(listed.data.schedules.map((s) => s.id)).toEqual([added.id]);
    expect(listed.text).toContain(HUB_HELP_ONLY_COMMANDS["schedule.show"]);
    expect(listed.text).toMatch(/上次.*\d{2}:\d{2}/);
  });

  it("S3.2 & S3.3: schedule show prints full prompt and last five runs newest first with PM reply preview, and reflects a new run", () => {
    const prompt = "多行任务说明：\n1. 检查今天全部审查记录\n2. 同一类问题出现两次以上则补充回归测试与清单";
    const schedule = f.ledger.hubCall(f.lin.sessionId, "schedule.add", {
      name: "每晚复盘",
      prompt,
      everyMinutes: 60,
    }).data.schedule;

    for (let i = 1; i <= 6; i++) {
      f.clock.now += HOUR;
      f.ledger.runDueSchedules(f.clock.now);
      const runMsg = f.pmSystemMessages().filter((m) => systemEventOf(m)?.event === "schedule.run").at(-1)!;
      const longReply = `第 ${i} 次复盘完成：` + "甲".repeat(SCHEDULE_RUN_REPLY_PREVIEW_CHARS + 50);
      f.pmReplyTo(runMsg.id, longReply);
    }

    const first = f.ledger.hubCall(f.lin.sessionId, "schedule.show", { scheduleId: schedule.id });
    const second = f.ledger.hubCall(f.lin.sessionId, "schedule.show", { scheduleId: schedule.id });
    expect(first.text).toBe(second.text);
    expect(first.text).toContain(prompt);
    expect(first.data.runs).toHaveLength(SCHEDULE_SHOW_RUNS_MAX);
    expect(first.data.runs[0]!.scheduledAt).toBeGreaterThan(first.data.runs[1]!.scheduledAt);
    expect(first.data.runs[0]!.state).toBe("read");
    expect(first.data.runs[0]!.replyPreview).not.toBeNull();
    expect([...first.data.runs[0]!.replyPreview!].length).toBeLessThanOrEqual(SCHEDULE_RUN_REPLY_PREVIEW_CHARS);
    expect(first.text).toContain("第 6 次复盘完成");
    expect(first.text).not.toContain("第 1 次复盘完成");

    // Another run updates the newest entry.
    f.clock.now += HOUR;
    f.ledger.runDueSchedules(f.clock.now);
    const seventhRun = f.pmSystemMessages().filter((m) => systemEventOf(m)?.event === "schedule.run").at(-1)!;
    f.pmReplyTo(seventhRun.id, "第 7 次复盘发现 2 条重复问题");
    const afterNext = f.ledger.hubCall(f.lin.sessionId, "schedule.show", { scheduleId: schedule.id });
    expect(afterNext.data.runs[0]!.messageId).toBe(seventhRun.id);
    expect(afterNext.text).toContain("第 7 次复盘发现 2 条重复问题");

    // Cross-PM isolation: another PM cannot inspect this schedule.
    const zhou = f.createPm("周经理");
    expect(() => f.ledger.hubCall(zhou.sessionId, "schedule.show", { scheduleId: schedule.id })).toThrow(LedgerRequestError);
    expect(() => f.ledger.hubCall(f.lin.sessionId, "schedule.show", { scheduleId: 99_999 })).toThrow(LedgerRequestError);
  });

  it("S3.4: 1,440 schedule runs among 30,000 messages return the newest five via the dedupe_key index", () => {
    const schedule = f.ledger.hubCall(f.lin.sessionId, "schedule.add", {
      name: "半小时巡检",
      prompt: "核对队列状态",
      everyMinutes: 30,
    }).data.schedule;

    const baseAt = f.clock.now - 31 * DAY;
    f.db.transaction(() => {
      for (let i = 0; i < 30_000; i++) {
        const at = baseAt + i * MINUTE;
        const isRun = i < 1_440;
        const scheduledAt = baseAt + i * 30 * MINUTE;
        const meta = isRun
          ? JSON.stringify({ event: "schedule.run", scheduleId: schedule.id, name: schedule.name, scheduledAt, catchUp: false })
          : null;
        const dedupeKey = isRun
          ? systemMessageDedupeKey(f.lin.conversationId, { event: "schedule.run", scheduleId: schedule.id, name: schedule.name, scheduledAt, catchUp: false })
          : `client:${f.lin.conversationId}:bulk-${i}`;
        f.db.run(
          `INSERT INTO messages (conversation_id, session_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
           VALUES (?, ?, ?, 'text', ?, ?, ?, 'replied', ?, ?)`,
          f.lin.conversationId,
          f.lin.sessionId,
          isRun ? "system" : "user",
          isRun ? `run ${i}` : `chat ${i}`,
          meta,
          dedupeKey,
          at,
          at,
        );
      }
    });

    const runs = recentScheduleRuns(f.db, f.lin.conversationId, schedule.id, SCHEDULE_SHOW_RUNS_MAX);
    expect(runs).toHaveLength(SCHEDULE_SHOW_RUNS_MAX);
    expect(runs[0]!.scheduledAt).toBe(baseAt + 1_439 * 30 * MINUTE);
    expect(runs[4]!.scheduledAt).toBe(baseAt + 1_435 * 30 * MINUTE);

    const plan = f.db.all<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT id FROM messages WHERE dedupe_key GLOB ? ORDER BY id DESC LIMIT ?",
      `system:${f.lin.conversationId}:schedule.run:${schedule.id}:*`,
      SCHEDULE_SHOW_RUNS_MAX,
    );
    expect(plan.map((p) => p.detail).join(" ")).toMatch(/USING INDEX|dedupe_key/i);
  });

  it("S3.5: cleaned last run message and malformed meta do not crash schedule show", () => {
    const schedule = f.ledger.hubCall(f.lin.sessionId, "schedule.add", {
      name: "清理测试",
      prompt: "检查清理容错",
      everyMinutes: 60,
    }).data.schedule;

    f.clock.now += HOUR;
    f.ledger.runDueSchedules(f.clock.now);
    const firstRun = f.pmSystemMessages().filter((m) => systemEventOf(m)?.event === "schedule.run").at(-1)!;
    // Corrupt JSON meta on the first run message to simulate bad persisted data.
    f.db.run("UPDATE messages SET meta = '{not-json' WHERE id = ?", firstRun.id);
    const runsWithBadMeta = recentScheduleRuns(f.db, f.lin.conversationId, schedule.id, SCHEDULE_SHOW_RUNS_MAX);
    expect(runsWithBadMeta).toHaveLength(1);
    expect(runsWithBadMeta[0]!.messageId).toBe(firstRun.id);

    // Delete the message referenced by last_message_id to simulate retention pruning.
    f.db.run("DELETE FROM messages WHERE id = ?", firstRun.id);
    const refreshed = f.ledger.hubCall(f.lin.sessionId, "schedule.list", {}).data.schedules[0]!;
    const cleaned = withCleanedLastRun(refreshed, []);
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]!.state).toBe("cleaned");

    const shown = f.ledger.hubCall(f.lin.sessionId, "schedule.show", { scheduleId: schedule.id });
    expect(shown.text).toContain("这次运行的记录已清理");
  });

  it("S3.6: daily 09:00 schedule renders local time in a non-UTC timezone", () => {
    const prevTz = process.env.TZ;
    try {
      process.env.TZ = "Asia/Shanghai";
      f.clock.now = new Date(2026, 10, 20, 8, 0).getTime();
      const schedule = f.ledger.hubCall(f.lin.sessionId, "schedule.add", {
        name: "早报",
        prompt: "整理今日计划",
        daily: "09:00",
      }).data.schedule;
      f.clock.now = new Date(2026, 10, 20, 9, 0).getTime();
      f.ledger.runDueSchedules(f.clock.now);

      const shown = f.ledger.hubCall(f.lin.sessionId, "schedule.show", { scheduleId: schedule.id });
      expect(shown.text).toContain("09:00");
    } finally {
      if (prevTz === undefined) delete process.env.TZ;
      else process.env.TZ = prevTz;
    }
  });
});

describe("S7: read a card (hub ask list, ask show, delivery note)", () => {
  let f: PmFrictionFixture;

  beforeEach(() => {
    f = createPmFrictionFixture();
  });

  afterEach(() => {
    f.close();
  });

  it("S7.1: ask show prints full untruncated text beyond 400 chars, options, recommended, files, relative age, and status", async () => {
    const filePath = join(f.root, "plan.md");
    writeFileSync(filePath, "# plan\n");
    const sharedFiles = await f.ledger.shareHubFiles(f.lin.sessionId, [{ label: "方案", path: filePath }]);
    const longContext = "背景细节：".repeat(120) + "尾部关键句-UNTRUNCATED-MARKER";
    const fullText = `测试台要不要用独立数据目录？\n\n${longContext}`;
    const asked = f.ledger.hubCall(
      f.lin.sessionId,
      "ask",
      {
        text: fullText,
        options: ["独立数据目录", "复用现有目录"],
        recommended: "独立数据目录",
        files: [{ label: "方案", path: filePath }],
      },
      { sharedFiles },
    ).data;
    const itemId = asked.item!.id;
    f.clock.now += 3 * DAY;

    const detail = askDetailOf(f.db, f.lin.pmId, { itemId });
    expect(detail.text).toContain("尾部关键句-UNTRUNCATED-MARKER");
    expect(formatAskDetail(detail, f.clock.now)).toContain("尾部关键句-UNTRUNCATED-MARKER");

    const shown = f.ledger.hubCall(f.lin.sessionId, "ask.show", { itemId });
    expect(shown.data.ask.text).toContain("尾部关键句-UNTRUNCATED-MARKER");
    expect(shown.data.ask.options).toEqual(["独立数据目录", "复用现有目录"]);
    expect(shown.data.ask.recommended).toBe("独立数据目录");
    expect(shown.data.ask.deliverables).toHaveLength(1);
    expect(shown.data.ask.status).toEqual({ state: "waiting" });
    expect(shown.text).toContain("尾部关键句-UNTRUNCATED-MARKER");
    expect(shown.text).toContain("独立数据目录");
    expect(shown.text).toContain("方案");
    expect(shown.text).toMatch(/3\s*天/);
  });

  it("S7.2: ask list includes both independent cards and step cards with age and matches pendingDecisionsOf for this PM", async () => {
    const ask1 = f.ledger.hubCall(f.lin.sessionId, "ask", {
      text: "独立卡片问题",
      options: ["方案 A", "方案 B"],
    }).data;

    // Create a Task Graph with a user checkpoint step that completes and opens a step card.
    const graph = f.createGraph({
      title: "方案评审图",
      steps: [{ key: "plan", title: "写方案", brief: "输出方案", confirm: true }],
    }).data.graph;
    const wid = f.showGraph(graph.id).nodes[0]!.activeWorkerId!;
    await f.startWorktree(wid);
    f.workerTurn(wid, reportBlock({ status: "做完了", summary: "方案初稿完成" }));

    // Another PM's card must never leak into Lin's ask list.
    const zhou = f.createPm("周经理");
    f.ledger.hubCall(zhou.sessionId, "ask", { text: "周经理的独立卡", options: ["甲", "乙"] });

    f.clock.now += 2 * DAY;

    const listed = f.ledger.hubCall(f.lin.sessionId, "ask.list", {});
    const ledgerAsks = pendingAsksOfPm(f.db, f.lin.pmId);
    const routerDecisions = pendingDecisionsOf(f.ledger.snapshot()).filter((d) => d.pmId === f.lin.pmId);

    expect(ledgerAsks).toHaveLength(2);
    expect(listed.data.asks).toHaveLength(2);
    expect(ledgerAsks.map((a) => a.messageId).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
      routerDecisions.map((d) => d.askMessageId).sort((a, b) => (a ?? 0) - (b ?? 0)),
    );
    expect(listed.text).toContain(`#${ask1.item!.id}`);
    expect(listed.text).toContain("plan");
    expect(listed.text).toMatch(/2\s*天/);
    expect(listed.text).not.toContain("周经理的独立卡");
  });

  it("S7.3: ask show reflects an answered card after the user responds between list and show", () => {
    const ask = f.ledger.hubCall(f.lin.sessionId, "ask", {
      text: "选哪套缓存策略？",
      options: ["方案 A", "方案 B"],
    }).data;
    const itemId = ask.item!.id;
    f.ledger.resolveRouterItem(itemId, { clientId: "ans-1", choice: "方案 B", note: "先做保守版本" });

    const shown = f.ledger.hubCall(f.lin.sessionId, "ask.show", { itemId });
    expect(shown.data.ask.status).toMatchObject({ state: "answered", choice: "方案 B", note: "先做保守版本" });
    expect(shown.text).toContain("已回答");
    expect(shown.text).toContain("方案 B");
    expect(shown.text).toContain("先做保守版本");
  });

  it("S7.4: the note placed in front of a user message lists step cards, card ages, and ask.show/ask.list hints", async () => {
    f.ledger.hubCall(f.lin.sessionId, "ask", { text: "独立卡一", options: ["A", "B"] });
    const graph = f.createGraph({
      title: "步骤卡测试",
      steps: [{ key: "plan", title: "写方案", brief: "输出方案", confirm: true }],
    }).data.graph;
    const wid = f.showGraph(graph.id).nodes[0]!.activeWorkerId!;
    await f.startWorktree(wid);
    f.workerTurn(wid, reportBlock({ status: "做完了", summary: "完成" }));
    f.clock.now += 3 * DAY;

    const { messageId } = f.ledger.postUserMessage({
      conversationId: f.lin.conversationId,
      clientId: "u-note-1",
      text: "顺便问下进展",
    });
    const delivered = f.ledger.deliveryOf(f.ledger.getMessage(messageId)!);
    const joined = delivered.prefixes.join("\n");
    expect(joined).toContain("独立卡一");
    expect(joined).toContain("plan");
    expect(joined).toMatch(/3\s*天/);
    expect(joined).toContain(HUB_HELP_ONLY_COMMANDS["ask.show"]);
    expect(joined).toContain(HUB_HELP_ONLY_COMMANDS["ask.list"]);
  });

  it("S7.5: formatPendingAskList caps output at ASK_LIST_MAX and appends remaining count", () => {
    const now = f.clock.now;
    const asks: PendingAsk[] = Array.from({ length: ASK_LIST_MAX + 7 }, (_, i) => ({
      source: { kind: "ask", itemId: i + 1 },
      messageId: 100 + i,
      question: `问题 ${i + 1}`,
      askedAt: now - (i + 1) * HOUR,
    }));
    const text = formatPendingAskList(asks, now);
    expect(text).toContain("另有 7 张");
    expect(text).not.toContain(`问题 ${ASK_LIST_MAX + 1}`);

    const note = pendingAsksNote(asks.slice(0, 2), now);
    expect(note).toContain(HUB_HELP_ONLY_COMMANDS["ask.show"]);
    expect(note).toContain(HUB_HELP_ONLY_COMMANDS["ask.list"]);
    expect(pendingAsksSection([], now)).not.toBe("");
  });

  it("S7.6 (regression): hub ask close and --replace continue to work unchanged", () => {
    const first = f.ledger.hubCall(f.lin.sessionId, "ask", {
      text: "旧卡",
      options: ["A", "B"],
    }).data;
    const replaced = f.ledger.hubCall(f.lin.sessionId, "ask", {
      text: "替换后的新卡",
      options: ["A", "B"],
      replaceItemId: first.item!.id,
    }).data;
    expect(f.ledger.getRouterItem(first.item!.id)?.status).toBe("superseded");
    expect(f.ledger.getRouterItem(replaced.item!.id)?.status).toBe("pending");

    const closed = f.ledger.hubCall(f.lin.sessionId, "ask.close", { itemId: replaced.item!.id });
    expect(closed.text).toContain(`#${replaced.item!.id}`);
    expect(f.ledger.getRouterItem(replaced.item!.id)?.status).toBe("superseded");
  });
});
