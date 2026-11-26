import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ASK_BODY_MAX_CHARS,
  MAX_GATE_QUESTION_CHARS,
  MAX_GATE_SUMMARY_CHARS,
  MAX_NODE_ARTIFACT_SUMMARY_CHARS,
  MAX_REASON_CHARS,
  MAX_SCHEDULE_NAME_CHARS,
  MAX_STEP_BRIEF_CHARS,
  MAX_WORKER_TITLE_CHARS,
  ROUTER_PENDING_DECISIONS_PER_PM_MAX,
  ROUTER_QUESTION_MAX_CHARS,
  ROUTER_REPORT_SUMMARY_MAX_CHARS,
} from "../../shared/limits.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger } from "./index.ts";
import { workerOpsFixture } from "./test-helpers.ts";

type Fixture = ReturnType<typeof workerOpsFixture>;
let f: Fixture;

afterEach(async () => {
  await f?.close();
});

const LINK = "https://example.feishu.cn/docx/AbCdEfGh";

function backgroundOf(chars: number): string {
  const head = "背".repeat(chars - LINK.length - 20);
  return `${head}${LINK}${"景".repeat(20)}`;
}

const askRows = (fx: Fixture) =>
  fx.db.all<{ question: string; context: string }>("SELECT question, context FROM router_items WHERE kind = 'decision' ORDER BY id");
const askMessages = (fx: Fixture) =>
  fx.db.all<{ id: number; text: string }>("SELECT id, text FROM messages WHERE sender = 'agent' AND json_extract(meta, '$.needsUser') = 1 ORDER BY id");

function stepGraph(fx: Fixture, keys: readonly string[]) {
  return fx.hub("graph.create", {
    title: "上限",
    specJson: JSON.stringify({ steps: keys.map((key) => ({ key, title: `步骤 ${key}` })) }),
  }).data.graph;
}

describe("hub ask never cuts what the PM wrote", () => {
  it("rejects an over-limit background, then keeps a background at the limit whole", () => {
    f = workerOpsFixture();
    const tooLong = backgroundOf(ASK_BODY_MAX_CHARS + 123);
    expect(() => f.hub("ask", { text: `要不要把导出换成流式？\n\n${tooLong}` })).toThrow(
      `提问背景有 ${ASK_BODY_MAX_CHARS + 123} 字，上限 ${ASK_BODY_MAX_CHARS} 字；长材料存成文件，用 --file 挂在卡上`,
    );
    expect(askRows(f)).toEqual([]);
    expect(askMessages(f)).toEqual([]);

    const fits = backgroundOf(ASK_BODY_MAX_CHARS);
    const res = f.hub("ask", { text: `要不要把导出换成流式？\n\n${fits}` });
    expect(askRows(f)).toEqual([{ question: "要不要把导出换成流式？", context: fits }]);
    const item = res.data.item!;
    expect(f.hub("ask.show", { itemId: item.id }).text).toContain(fits);
    const snap = f.ledger.snapshot().router.items.find((x) => x.id === item.id);
    expect(snap?.kind === "decision" ? snap.context : null).toBe(fits);
  });

  it("rejects a single line longer than the question limit instead of splitting it", () => {
    f = workerOpsFixture();
    expect(() => f.hub("ask", { text: "问".repeat(ROUTER_QUESTION_MAX_CHARS + 40) })).toThrow(
      `问题第一行有 ${ROUTER_QUESTION_MAX_CHARS + 40} 字，上限 ${ROUTER_QUESTION_MAX_CHARS} 字`,
    );
    expect(askRows(f)).toEqual([]);
  });

  it("rejects an over-limit step ask and keeps a step ask at the limit whole everywhere", () => {
    f = workerOpsFixture();
    const graph = stepGraph(f, ["ok"]);
    const over = "景".repeat(MAX_GATE_SUMMARY_CHARS + 1);
    expect(() => f.hub("ask", { graphId: graph.id, node: "ok", text: `按方案 A 吗？\n\n${over}` })).toThrow(
      `步骤拍板卡背景有 ${MAX_GATE_SUMMARY_CHARS + 1} 字，上限 ${MAX_GATE_SUMMARY_CHARS} 字`,
    );
    expect(() => f.hub("ask", { graphId: graph.id, node: "ok", text: `${"问".repeat(MAX_GATE_QUESTION_CHARS + 1)}\n\n短背景` })).toThrow(
      `步骤拍板卡问题有 ${MAX_GATE_QUESTION_CHARS + 1} 字，上限 ${MAX_GATE_QUESTION_CHARS} 字`,
    );
    const untouched = f.db.get<{ gate_question: string | null }>("SELECT gate_question FROM task_graph_steps WHERE graph_id = ? AND node_key = 'ok'", graph.id)!;
    expect(untouched.gate_question).toBeNull();

    const full = `${"景".repeat(MAX_GATE_SUMMARY_CHARS - LINK.length)}${LINK}`;
    const { messageId } = f.hub("ask", { graphId: graph.id, node: "ok", text: `按方案 A 吗？\n\n${full}` }).data;
    const step = f.db.get<{ gate_summary_md: string }>("SELECT gate_summary_md FROM task_graph_steps WHERE graph_id = ? AND node_key = 'ok'", graph.id)!;
    expect(step.gate_summary_md).toBe(full);
    expect(f.hub("ask.show", { messageId }).text).toContain(full);
  });

  it("keeps a rejected ask from leaving anything behind across a restart", () => {
    f = workerOpsFixture();
    expect(() => f.hub("ask", { text: `换吗？\n\n${"背".repeat(ASK_BODY_MAX_CHARS + 1)}` })).toThrow(/上限/);
    f.ledger.close();
    const dataHome = join(f.root, "state");
    const reopened = createLedger(f.db, {
      now: f.now, dataHome,
      pmHomeRoot: join(dataHome, "pm-home"), worktreesDir: join(dataHome, "worktrees"),
      resolveFolder: createResolveFolder({ dataHome, userHome: f.root }), osSandboxed: () => true,
    });
    try {
      expect(reopened.hubCall(f.pm.sessionId, "ask.list", {}).data.asks).toEqual([]);
    } finally {
      reopened.close();
    }
  });
});

describe("every hub limit rejects with the shared message", () => {
  it("names the delivery summary, not the report summary, in graph finish", () => {
    f = workerOpsFixture();
    const graph = stepGraph(f, ["a"]);
    f.hub("graph.done", { graphId: graph.id, nodeKey: "a" });
    expect(() => f.hub("graph.finish", { graphId: graph.id, summary: "交".repeat(ROUTER_REPORT_SUMMARY_MAX_CHARS + 1) })).toThrow(
      `交付摘要有 ${ROUTER_REPORT_SUMMARY_MAX_CHARS + 1} 字，上限 ${ROUTER_REPORT_SUMMARY_MAX_CHARS} 字；细节写进各步骤的汇报或文件`,
    );
  });

  it("rejects step fields in graph create and graph patch with the step key", () => {
    f = workerOpsFixture();
    const brief = "简".repeat(MAX_STEP_BRIEF_CHARS + 1);
    expect(() =>
      f.hub("graph.create", { specJson: JSON.stringify({ title: "上限", steps: [{ key: "impl", title: "实现", brief }] }) }),
    ).toThrow(`步骤「impl」的 brief有 ${MAX_STEP_BRIEF_CHARS + 1} 字，上限 ${MAX_STEP_BRIEF_CHARS} 字；长材料存成文件，brief 里写路径`);

    const graph = stepGraph(f, ["a", "b"]);
    expect(() => f.hub("graph.patch", { graphId: graph.id, specJson: JSON.stringify({ updateSteps: [{ key: "b", brief }] }) })).toThrow(
      `步骤「b」的 brief有 ${MAX_STEP_BRIEF_CHARS + 1} 字，上限 ${MAX_STEP_BRIEF_CHARS} 字`,
    );
    expect(f.db.get<{ brief: string | null }>("SELECT brief FROM task_graph_steps WHERE graph_id = ? AND node_key = 'b'", graph.id)!.brief ?? "").toBe("");
  });

  it("rejects an over-limit graph done summary and graph skip reason", () => {
    f = workerOpsFixture();
    const graph = stepGraph(f, ["a", "b"]);
    expect(() => f.hub("graph.done", { graphId: graph.id, nodeKey: "a", summary: "摘".repeat(MAX_NODE_ARTIFACT_SUMMARY_CHARS + 1) })).toThrow(
      `步骤产物摘要有 ${MAX_NODE_ARTIFACT_SUMMARY_CHARS + 1} 字，上限 ${MAX_NODE_ARTIFACT_SUMMARY_CHARS} 字`,
    );
    expect(() => f.hub("graph.skip", { graphId: graph.id, nodeKey: "b", reason: "因".repeat(MAX_REASON_CHARS + 1) })).toThrow(
      `原因有 ${MAX_REASON_CHARS + 1} 字，上限 ${MAX_REASON_CHARS} 字`,
    );
  });

  it("rejects an over-limit Worker title instead of cutting it", () => {
    f = workerOpsFixture();
    expect(() => f.hub("worker.start", { title: "题".repeat(MAX_WORKER_TITLE_CHARS + 1), task: "做事", noWorktree: true })).toThrow(
      `Worker 标题有 ${MAX_WORKER_TITLE_CHARS + 1} 字，上限 ${MAX_WORKER_TITLE_CHARS} 字`,
    );
    expect(f.db.get<{ n: number }>("SELECT count(*) AS n FROM workers")!.n).toBe(0);
  });

  it("rejects an over-limit report summary and schedule name with the shared message", () => {
    f = workerOpsFixture();
    expect(() => f.hub("router.report", { summary: "报".repeat(ROUTER_REPORT_SUMMARY_MAX_CHARS + 1) })).toThrow(
      `汇报摘要有 ${ROUTER_REPORT_SUMMARY_MAX_CHARS + 1} 字，上限 ${ROUTER_REPORT_SUMMARY_MAX_CHARS} 字；细节放进 --file 或 --link`,
    );
    expect(() => f.hub("schedule.add", { name: "名".repeat(MAX_SCHEDULE_NAME_CHARS + 1), prompt: "每天汇报", daily: "09:00" })).toThrow(
      `定时任务名称有 ${MAX_SCHEDULE_NAME_CHARS + 1} 字，上限 ${MAX_SCHEDULE_NAME_CHARS} 字`,
    );
  });
});

describe("unchanged rules", () => {
  it("stores a full PM's worth of pending cards at the background limit whole", () => {
    f = workerOpsFixture();
    for (let i = 0; i < ROUTER_PENDING_DECISIONS_PER_PM_MAX; i++) {
      f.hub("ask", { text: `第 ${i} 个问题？\n\n${`${i}`.padEnd(ASK_BODY_MAX_CHARS, "景")}` });
    }
    const rows = askRows(f);
    expect(rows).toHaveLength(ROUTER_PENDING_DECISIONS_PER_PM_MAX);
    for (const [i, row] of rows.entries()) expect(row.context).toBe(`${i}`.padEnd(ASK_BODY_MAX_CHARS, "景"));
  });

  it("still shows a card cut by an older version", () => {
    f = workerOpsFixture();
    const res = f.hub("ask", { text: "旧卡？\n\n短背景" });
    f.db.run("UPDATE router_items SET context = ? WHERE id = ?", `${"旧".repeat(ASK_BODY_MAX_CHARS - 1)}…`, res.data.item!.id);
    expect(f.hub("ask.list", {}).text).toContain("旧卡？");
    expect(f.hub("ask.show", { itemId: res.data.item!.id }).text).toContain("短背景");
  });
});
