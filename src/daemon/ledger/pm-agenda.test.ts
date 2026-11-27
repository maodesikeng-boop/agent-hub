import { isGraphReadyNotice } from "../../shared/pm-notice.ts";
import { mkdtempSync, readdirSync, rmSync, unlinkSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { systemEventOf, type Message, type MessageId } from "../../shared/domain.ts";
import {
  PM_AGENDA_BUSY_LINE,
  appendDeliverySuffix,
  diffAgendaLines,
  formatPmAgenda,
  nextAgendaFooter,
  readyAgendaRef,
  type AgendaCursor,
  type AgendaLine,
  type PmAgenda,
} from "../../shared/pm-agenda.ts";
import { createSessionStore } from "../store/index.ts";
import { openDatabase } from "../store/db.ts";
import { DEFAULT_MIGRATIONS_DIR, migrate } from "../store/migrate.ts";
import { writeMigrationManifest } from "../store/test-helpers.ts";
import { isPmAgendaItemOpen, pmAgendaOf } from "./pm-agenda.ts";
import { createPmFrictionFixture, reportBlock, type PmFrictionFixture } from "./pm-friction-fixture.ts";

const MINUTE = 60_000;

function delivered(f: PmFrictionFixture, messageId: MessageId): string {
  const message = f.ledger.getMessage(messageId)!;
  const { prefixes, text } = f.ledger.deliveryOf(message);
  const suffix = message.sessionId === null ? "" : f.ledger.deliverySuffix!(message.sessionId, [messageId]).text;
  return [...prefixes, appendDeliverySuffix(text, suffix)].join("\n");
}

function postUser(f: PmFrictionFixture, text: string): MessageId {
  return f.ledger.postUserMessage({ conversationId: f.lin.conversationId, clientId: `c-${text}`, text }).messageId;
}

async function readyGraph(f: PmFrictionFixture, title: string): Promise<number> {
  const graph = f.createGraph({ title, steps: [{ key: "impl", title: "实现", brief: "实现" }] }).data.graph;
  const wid = f.showGraph(graph.id).nodes[0]!.activeWorkerId!;
  await f.startWorktree(wid);
  f.workerTurn(wid, reportBlock({ status: "做完了", summary: "实现好了" }));
  return graph.id;
}

async function brakedGraph(f: PmFrictionFixture, title: string): Promise<number> {
  const graph = f.createGraph({ title, steps: [{ key: "fix", title: "修复", brief: "修复" }] }).data.graph;
  const wid = f.showGraph(graph.id).nodes[0]!.activeWorkerId!;
  await f.startWorktree(wid);
  f.workerTurn(wid, reportBlock({ status: "有问题", summary: "接口冲突", questions: "要不要改名？" }));
  return graph.id;
}

describe("S1 and S2: the per-graph list and the delivery row", () => {
  let f: PmFrictionFixture;

  beforeEach(() => {
    f = createPmFrictionFixture();
  });

  afterEach(() => {
    f.close();
  });

  it("S2.1: hub status lists each graph with title, step count, and its running, waiting, and queued steps, graphs that need the PM first, then work outside graphs", async () => {
    const running = f.createGraph({
      title: "并行审查",
      steps: [
        { key: "review", title: "逻辑审查", brief: "审查", deps: [] },
        { key: "review-real", title: "真实环境审查", brief: "真实环境", deps: [] },
      ],
    }).data.graph;
    f.clock.now += MINUTE;
    const ready = await readyGraph(f, "取消残留");
    f.clock.now += MINUTE;
    const braked = await brakedGraph(f, "补测试");
    const solo = f.ledger.hubCall(f.lin.sessionId, "worker.start", { title: "修复焦点圈", task: "修复焦点圈", noWorktree: true }).data.worker;
    f.workerTurn(solo.id, reportBlock({ status: "做完了", summary: "修好了" }));

    const text = f.ledger.hubCall(f.lin.sessionId, "status", {}).text;
    expect(text).toContain(`图 #${ready}「取消残留」1 个步骤 · 全部做完，等你验收交付`);
    expect(text).toContain(`图 #${braked}「补测试」1 个步骤 · 要你处理 1 个`);
    expect(text).toMatch(/fix：等你处理/u);
    expect(text).toContain(`图 #${running.id}「并行审查」2 个步骤 · 在跑 2 个`);
    expect(text).toContain("图外：");
    expect(text).toContain(`Worker #${solo.id}「修复焦点圈」汇报做完了，等你验收`);
    expect(text.indexOf(`图 #${ready}「`)).toBeLessThan(text.indexOf(`图 #${running.id}「`));
    expect(text.indexOf(`图 #${braked}「`)).toBeLessThan(text.indexOf(`图 #${running.id}「`));
    expect(text).not.toContain("活跃任务图");
  });

  it("S2.1: pmAgendaOf puts graphs that need the PM first, oldest wait first, and marks the finished graph ready to finish", async () => {
    const ready = await readyGraph(f, "先完成的图");
    f.clock.now += 5 * MINUTE;
    const braked = await brakedGraph(f, "后停下的图");
    const agenda = pmAgendaOf(f.db, f.lin.pmId, f.clock.now);
    expect(agenda.graphs.map((g) => g.graphId)).toEqual([ready, braked]);
    expect(agenda.graphs[0]).toMatchObject({ readyToFinish: true, needsPm: true, steps: [] });
    expect(agenda.graphs[1]!.steps).toEqual([expect.objectContaining({ key: "fix", state: expect.objectContaining({ kind: "waiting_pm" }) })]);
  });

  it("S2.1: a graph or Worker waiting on a watch is neither sorted with nor kept open as an item that needs the PM", async () => {
    const ready = await readyGraph(f, "检查后交付");
    f.clock.now += 5 * MINUTE;
    const braked = await brakedGraph(f, "后停下的图");
    const solo = f.ledger.hubCall(f.lin.sessionId, "worker.start", { title: "等发布", task: "等发布", noWorktree: true }).data.worker;
    f.workerTurn(solo.id, reportBlock({ status: "做完了", summary: "发好了" }));
    const before = pmAgendaOf(f.db, f.lin.pmId, f.clock.now);
    expect(before.graphs.map((g) => g.graphId)).toEqual([ready, braked]);
    const readyRef = readyAgendaRef(ready, before.graphs[0]!.oldestNeedsPmSince!);
    const workerSince = before.outside.find((item) => item.kind === "worker_report")!.since;
    const note = f.pmSystemMessages().find(isGraphReadyNotice)!;
    expect(isPmAgendaItemOpen(f.db, f.lin.pmId, readyRef)).toBe(true);
    expect(isPmAgendaItemOpen(f.db, f.lin.pmId, `worker:${solo.id}@${workerSince}`)).toBe(true);

    f.ledger.hubCall(f.lin.sessionId, "watch.add", { until: "check-ready", everyMs: 15_000, graphId: ready, body: "检查通过后交付" });
    f.ledger.hubCall(f.lin.sessionId, "watch.add", { until: "check-release", everyMs: 15_000, workerId: solo.id, body: "发布完再验收" });

    const after = pmAgendaOf(f.db, f.lin.pmId, f.clock.now);
    expect(after.graphs.map((g) => g.graphId)).toEqual([braked, ready]);
    expect(isPmAgendaItemOpen(f.db, f.lin.pmId, readyRef)).toBe(false);
    expect(isPmAgendaItemOpen(f.db, f.lin.pmId, `worker:${solo.id}@${workerSince}`)).toBe(false);
    expect(f.ledger.isSystemMessageCurrent!(note.id)).toBe(false);
  });

  it("S1.1: a finished graph ends with a delivery row and its note says the graph only knows its drawn steps", async () => {
    const ready = await readyGraph(f, "全勾了");
    const shown = f.ledger.hubCall(f.lin.sessionId, "graph.show", { graphId: ready }).text;
    expect(shown).toContain("[等你验收交付] 交付：图里画的步骤都做完了");
    const note = f.pmSystemMessages().find(isGraphReadyNotice)!;
    expect(note.text).toContain("图里画的步骤都做完了，等你验收交付");
    expect(note.text).toContain("hub graph patch");
    expect(note.text).toContain("hub watch add");
  });

  it("S1.3 (regression): a brief-less step after a finished step waits for the PM and wakes it once", async () => {
    const graph = f.createGraph({
      title: "画出合并步骤",
      steps: [
        { key: "impl", title: "实现", brief: "实现" },
        { key: "merge", title: "合并" },
      ],
    }).data.graph;
    const wid = f.showGraph(graph.id).nodes[0]!.activeWorkerId!;
    await f.startWorktree(wid);
    f.workerTurn(wid, reportBlock({ status: "做完了", summary: "实现好了" }));
    expect(f.showGraph(graph.id).nodes.find((n) => n.key === "merge")).toMatchObject({ status: "waiting", waitingFor: "pm" });
    expect(f.pmSystemMessages().filter((m) => systemEventOf(m)?.event === "pm.wakeup")).toHaveLength(1);
  });
});

describe("S3: every wake carries the latest state as a snapshot plus changes", () => {
  let f: PmFrictionFixture;

  beforeEach(() => {
    f = createPmFrictionFixture();
  });

  afterEach(() => {
    f.close();
  });

  it("S3.1 and S3.2: the first wake of a session carries a snapshot; a later wake with nothing changed carries one not-modified line", async () => {
    const ready = await readyGraph(f, "等交付");
    const first = postUser(f, "现在什么情况");
    const firstText = delivered(f, first);
    expect(firstText).toContain("【清单 v1");
    expect(firstText).toContain(`图 #${ready}「等交付」`);
    expect(firstText.indexOf("【清单 v1")).toBeGreaterThan(firstText.indexOf("现在什么情况"));
    f.pmReplyTo(first, "在看");

    const second = postUser(f, "还有别的吗");
    const secondText = delivered(f, second);
    expect(secondText).toMatch(/【清单 v1 没变/u);
    expect(secondText).not.toContain(`图 #${ready}「等交付」`);
  });

  it("S3.3: changes between two wakes arrive as change lines on the next message, system notices included", async () => {
    await readyGraph(f, "等交付");
    const first = postUser(f, "看一下");
    delivered(f, first);
    f.pmReplyTo(first, "好");

    const braked = await brakedGraph(f, "新停下的");
    const notice = f.pmMessages().filter((m) => m.sender === "system" && m.kind === "worker").at(-1)!;
    const noticeText = delivered(f, notice.id);
    expect(noticeText).toContain("【清单 v2");
    expect(noticeText).toMatch(new RegExp(`\\+ 图 #${braked}「新停下的」`, "u"));
    expect(noticeText).not.toContain("「等交付」");
  });

  it("S3.7: a user message sent while the PM is mid-turn carries the busy line; one sent between turns does not", () => {
    const idle = postUser(f, "空闲时问的");
    expect(delivered(f, idle)).not.toContain(PM_AGENDA_BUSY_LINE);
    f.pmReplyTo(idle, "好");
    createSessionStore(f.db).update(f.lin.sessionId, { status: "running", pid: 40_001 });
    const between = postUser(f, "进程还在、这一轮已结束时问的");
    expect(delivered(f, between)).not.toContain(PM_AGENDA_BUSY_LINE);
    f.ledger.applyDriverEvent(f.lin.sessionId, { type: "message.processing", messageIds: [between], at: ++f.clock.now });
    const busy = postUser(f, "忙时问的");
    expect(delivered(f, busy)).toContain(PM_AGENDA_BUSY_LINE);
  });

  it("S3.7 (regression): a user message sent while the PM is stopping its turn carries no busy line", () => {
    const first = postUser(f, "先做这个");
    f.ledger.applyDriverEvent(f.lin.sessionId, { type: "message.processing", messageIds: [first], at: ++f.clock.now });
    f.ledger.requestStop(f.lin.conversationId);
    const after = postUser(f, "停下后问的");
    expect(delivered(f, after)).not.toContain(PM_AGENDA_BUSY_LINE);
  });

  it("S3.8 (regression): messages to Worker sessions never carry a footer", async () => {
    await readyGraph(f, "等交付");
    const graph = f.createGraph({ title: "在跑", steps: [{ key: "impl", title: "实现", brief: "实现" }] }).data.graph;
    const wid = f.showGraph(graph.id).nodes[0]!.activeWorkerId!;
    const workerConv = f.workerSessionOf(wid).conversation_id;
    const brief = f.pmMessages(workerConv).find((m) => m.sender === "pm" || m.sender === "user") as Message;
    expect(delivered(f, brief.id)).not.toContain("【清单");
  });
});

const agendaWith = (lines: { ref: string; text: string; needsPm: boolean }[], at: number): PmAgenda => ({
  pmId: 1,
  at,
  graphs: lines.map((l, i) => ({
    graphId: i + 1,
    title: l.text,
    stepCount: 1,
    doneCount: 1,
    pendingCount: 0,
    readyToFinish: l.needsPm,
    steps: [],
    watchId: null,
    needsPm: l.needsPm,
    oldestNeedsPmSince: l.needsPm ? at - 10 * MINUTE : null,
  })),
  omittedGraphs: 0,
  outside: [],
  userCards: 0,
});

describe("S3 and S13: the footer protocol is cheap and never stale", () => {
  const a: AgendaLine = { ref: "graph:1:ready@1", needsPm: true, text: "图 #1「甲」1 个步骤 · 全部做完，等你验收交付（14:05 起）" };
  const b: AgendaLine = { ref: "graph:2:step:fix:waiting_pm@2", needsPm: true, text: "图 #2「乙」fix：等你处理（14:58 起）" };
  const b2: AgendaLine = { ...b, text: "图 #2「乙」fix：在跑（Worker #9）" };

  it("diffAgendaLines reports additions, state changes, and removals by ref, and nothing for identical lists", () => {
    expect(diffAgendaLines([a, b], [a, b])).toEqual([]);
    expect(diffAgendaLines([a], [a, b])).toEqual([{ op: "add", line: b }]);
    expect(diffAgendaLines([a, b], [a, b2])).toEqual([{ op: "change", before: b, after: b2 }]);
    expect(diffAgendaLines([a, b], [b])).toEqual([{ op: "remove", line: a }]);
  });

  it("S3.1, S3.2, S3.6: no cursor gives a snapshot, an unchanged list gives one short line, and a compaction gives a snapshot again", () => {
    const t = new Date(2026, 10, 26, 15, 40).getTime();
    const agenda = agendaWith([{ ref: "graph:1:ready@1", text: "甲", needsPm: true }], t);
    const first = nextAgendaFooter(null, agenda, { now: t, compactedSinceCursor: false });
    expect(first.kind).toBe("snapshot");
    if (first.kind !== "snapshot") return;
    expect(first.version).toBe(1);
    const cursor: AgendaCursor = { version: 1, lines: first.lines, deltasSinceSnapshot: 0, deliveredAt: t };

    const later = nextAgendaFooter(cursor, { ...agenda, at: t + 10 * MINUTE }, { now: t + 10 * MINUTE, compactedSinceCursor: false });
    expect(later.kind).toBe("unchanged");
    if (later.kind !== "unchanged") return;
    expect(later.version).toBe(1);
    expect([...later.text].length).toBeLessThanOrEqual(64);

    expect(nextAgendaFooter(cursor, agenda, { now: t, compactedSinceCursor: true }).kind).toBe("snapshot");
    expect(nextAgendaFooter({ ...cursor, deltasSinceSnapshot: 20 }, agendaWith([{ ref: "graph:9:ready@9", text: "新", needsPm: true }], t), { now: t, compactedSinceCursor: false }).kind).toBe("snapshot");
  });

  it("S13.1: a one-change footer stays under 160 characters and an empty unchanged list adds nothing", () => {
    const t = new Date(2026, 10, 26, 15, 46).getTime();
    const before = agendaWith([{ ref: "graph:1:ready@1", text: "甲", needsPm: true }], t);
    const first = nextAgendaFooter(null, before, { now: t, compactedSinceCursor: false });
    if (first.kind !== "snapshot") throw new Error("expected a snapshot");
    const cursor: AgendaCursor = { version: 1, lines: first.lines, deltasSinceSnapshot: 0, deliveredAt: t };
    const after = agendaWith(
      [
        { ref: "graph:1:ready@1", text: "甲", needsPm: true },
        { ref: "graph:2:ready@2", text: "乙", needsPm: true },
      ],
      t,
    );
    const delta = nextAgendaFooter(cursor, after, { now: t, compactedSinceCursor: false });
    expect(delta.kind).toBe("delta");
    expect([...(delta.kind === "delta" ? delta.text : "")].length).toBeLessThanOrEqual(160);

    const empty = agendaWith([], t);
    const emptyCursor: AgendaCursor = { version: 3, lines: [], deltasSinceSnapshot: 1, deliveredAt: t };
    expect(nextAgendaFooter(emptyCursor, empty, { now: t, compactedSinceCursor: false })).toEqual({ kind: "none" });
  });

  it("S13.3: twenty changed graphs produce a capped snapshot instead of twenty change lines", () => {
    const t = new Date(2026, 10, 26, 16, 0).getTime();
    const cursor: AgendaCursor = { version: 4, lines: [], deltasSinceSnapshot: 2, deliveredAt: t };
    const many = agendaWith(
      Array.from({ length: 20 }, (_, i) => ({ ref: `graph:${i + 1}:ready@${i + 1}`, text: `图${i + 1}`, needsPm: true })),
      t,
    );
    expect(nextAgendaFooter(cursor, many, { now: t, compactedSinceCursor: false }).kind).toBe("snapshot");
    expect(formatPmAgenda(many, t).split("\n").length).toBeLessThanOrEqual(22);
  });
});

describe("S8.4: migration 0057 backfills when each step entered its state and keeps it current", () => {
  it("steps written before the upgrade get their start from updated_at, a status change moves it, and a title change does not", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-hub-mig57-"));
    const db = openDatabase(join(dir, "mig57.sqlite"));
    try {
      const upTo56 = join(dir, "mig56");
      cpSync(DEFAULT_MIGRATIONS_DIR, upTo56, { recursive: true });
      for (const name of readdirSync(upTo56)) {
        const v = /^(\d+)_.*\.sql$/u.exec(name)?.[1];
        if (v !== undefined && Number(v) > 56) unlinkSync(join(upTo56, name));
      }
      writeMigrationManifest(upTo56);
      migrate(db, upTo56);
      const now = 1_720_000_000_000;
      const pmId = db.run("INSERT INTO pms (name, mode, created_at) VALUES ('PM', 'manage_only', ?)", now).lastInsertRowid;
      const convId = db.run("INSERT INTO conversations (kind, pm_id, title, created_at) VALUES ('pm', ?, 'PM', ?)", pmId, now).lastInsertRowid;
      const projId = db.run(
        "INSERT INTO projects (name, status, pm_id, conversation_id, created_at, updated_at) VALUES ('P', 'active', ?, ?, ?, ?)",
        pmId, convId, now, now,
      ).lastInsertRowid;
      const graphId = db.run(
        "INSERT INTO task_graphs (project_id, pm_id, conversation_id, title, status, created_at, updated_at) VALUES (?, ?, ?, 'G', 'active', ?, ?)",
        projId, pmId, convId, now, now,
      ).lastInsertRowid;
      db.run(
        "INSERT INTO task_graph_steps (graph_id, node_key, title, status, sort_order, created_at, updated_at) VALUES (?, 'a', 'A', 'pending', 0, ?, ?)",
        graphId, now, now + 5,
      );

      migrate(db, DEFAULT_MIGRATIONS_DIR);
      expect(db.get<{ s: number }>("SELECT s.state_since AS s FROM task_graph_step_states s JOIN task_graph_steps t ON t.id = s.step_id WHERE t.graph_id = ?", graphId)?.s).toBe(now + 5);
      db.run("UPDATE task_graph_steps SET status = 'running', updated_at = ? WHERE graph_id = ?", now + 100, graphId);
      expect(db.get<{ s: number }>("SELECT s.state_since AS s FROM task_graph_step_states s JOIN task_graph_steps t ON t.id = s.step_id WHERE t.graph_id = ?", graphId)?.s).toBe(now + 100);
      db.run("UPDATE task_graph_steps SET title = 'B', updated_at = ? WHERE graph_id = ?", now + 200, graphId);
      expect(db.get<{ s: number }>("SELECT s.state_since AS s FROM task_graph_step_states s JOIN task_graph_steps t ON t.id = s.step_id WHERE t.graph_id = ?", graphId)?.s).toBe(now + 100);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
