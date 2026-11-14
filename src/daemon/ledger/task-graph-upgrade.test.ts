// 编排简化第 4 步的验收（docs/orchestration-simplify-design.md 第 13 节第 4 步）：迁移 0025 之前还在跑的旧图，升级后能接着走完。
// 用现在的引擎把图推进到一半（有完了的、跳过的、在干的、轮到了没人派的、挂着拍板卡没轮到的），再把节点表改回 0023 的旧结构和旧状态、
// user_version 退回 24，模拟老版本守护进程留下的库；重跑迁移、重开账本，从在干的那一步一直推进到 hub graph finish。
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pendingDecisionsOf } from "../../shared/decisions.ts";
import { isTaskGraphReadyToFinish, type ConversationId, type PmId, type SessionId, type TaskGraph } from "../../shared/domain.ts";
import { REPORT_END, REPORT_START } from "../../shared/worker.ts";
import { openDatabase } from "../store/db.ts";
import type { Db } from "../store/index.ts";
import { DEFAULT_MIGRATIONS_DIR, migrate, userVersion } from "../store/migrate.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger, type LedgerOptions, type SqliteLedger } from "./index.ts";

let root: string;
let db: Db;
let ledger: SqliteLedger;
let now: number;
let lin: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };

function options(): LedgerOptions {
  const dataHome = join(root, ".agent-hub");
  return {
    now: () => now,
    pmHomeRoot: join(dataHome, "pm-home"),
    dataHome,
    worktreesDir: join(dataHome, "worktrees"),
    resolveFolder: createResolveFolder({ dataHome, userHome: root }),
  };
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-graph-upgrade-")));
  now = 50_000;
  db = openDatabase(join(root, "hub.sqlite"));
  migrate(db);
  ledger = createLedger(db, options());
  const folder = join(root, "work", "app");
  mkdirSync(folder, { recursive: true });
  const pm = ledger.createPm({ name: "项目经理", mode: "manage_only", persona: "" });
  ledger.hubCall(pm.sessionId, "project.create", { folder: realpathSync.native(folder), name: "agent-hub" });
  lin = { pmId: pm.pm.id, conversationId: pm.conversation.id, sessionId: pm.sessionId };
});

afterEach(() => {
  ledger.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function finishWorkerTurn(workerId: number, summary: string) {
  const session = db.get<{ id: number; conversation_id: number }>(
    "SELECT id, conversation_id FROM agent_sessions WHERE worker_id = ? ORDER BY generation DESC LIMIT 1",
    workerId,
  )!;
  const msg = db.get<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1", session.conversation_id)!;
  ledger.applyDriverEvent(session.id, { type: "message.delivered", messageIds: [msg.id], at: now });
  ledger.applyDriverEvent(session.id, { type: "message.processing", messageIds: [msg.id], at: now });
  ledger.applyDriverEvent(session.id, {
    type: "agent.text",
    uuid: `u-${workerId}-${++now}`,
    text: `${REPORT_START}\n状态: 做完了\n摘要: ${summary}\n提交: abc${workerId}\n测试: vitest 绿\n问题: 无\n${REPORT_END}`,
    at: now,
  });
  ledger.applyDriverEvent(session.id, { type: "turn.ended", ok: true, interrupted: false, messageIds: [msg.id], durationMs: 10, at: now });
}

const startOn = (node: string, graphId: number) =>
  ledger.hubCall(lin.sessionId, "worker.start", { title: node, task: `做 ${node}`, noWorktree: true, node, graphId }).data.worker;

const stateOf = (graph: TaskGraph, key: string): string => {
  const n = graph.nodes.find((x) => x.key === key)!;
  if (n.status === "waiting") return `waiting:${n.waitingFor}`;
  return n.status === "done" && n.skipped ? "skipped" : n.status;
};

/**
 * 把节点表改回 0023 的结构和旧状态（老版本守护进程留下的样子）：0023 重建旧表，按给的旧状态拷回去，删新表，user_version 退回 24。
 * 写了问题的节点当旧的 gate，其余是 piece。
 */
function downgradeToOldSchema(oldStatusByKey: Record<string, string>) {
  db.exec(readFileSync(join(DEFAULT_MIGRATIONS_DIR, "0023_router_and_task_graphs.sql"), "utf8"));
  db.run(
    `INSERT INTO task_graph_nodes (id, graph_id, node_key, title, kind, status, sort_order, active_worker_id, worker_ids_json, artifact_json,
       gate_question, gate_options_json, gate_summary_md, gate_recommended, gate_ask_message_id, decision_json, created_at, updated_at)
     SELECT id, graph_id, node_key, title, CASE WHEN gate_question IS NULL THEN 'piece' ELSE 'gate' END,
            json_extract(?, '$.' || node_key), sort_order, active_worker_id, worker_ids_json, artifact_json,
            gate_question, gate_options_json, gate_summary_md, gate_recommended, gate_ask_message_id, decision_json, created_at, updated_at
       FROM task_graph_steps`,
    JSON.stringify(oldStatusByKey),
  );
  db.exec("DROP TABLE task_graph_steps");
  db.exec("PRAGMA user_version = 24");
}

describe("迁移 0025 前在跑的旧图：升级后接着走完", () => {
  it("完了、跳过、在干、ready、带问题的 gate 都按第 3.4 节换好；在干的收工后下游轮到，拍板卡照常出、用户点了往下走，手动步骤派人，一直到 hub graph finish", () => {
    const graph = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({
        title: "编排简化实现",
        nodes: [
          { key: "s1", title: "提示词按五步重排" },
          { key: "s2", title: "唯一结束出口", deps: ["s1"] },
          { key: "s3", title: "出错接手", deps: ["s2"] },
          { key: "s4", title: "确认迁移方案", deps: ["s3"], question: "旧图迁移后要不要补发叫醒？", options: ["不补发", "补发"], recommended: "不补发" },
          { key: "s5", title: "自动开工和交棒", deps: ["s4"] },
          { key: "docs", title: "补文档", deps: ["s1"] },
        ],
      }),
    }).data.graph;
    const w1 = startOn("s1", graph.id);
    finishWorkerTurn(w1.id, "提示词重排完了");
    ledger.hubCall(lin.sessionId, "worker.end", { workerId: w1.id });
    ledger.hubCall(lin.sessionId, "graph.skip", { graphId: graph.id, nodeKey: "s2", reason: "并进第 3 步" });
    const w3 = startOn("s3", graph.id);

    // 老版本守护进程留下的库：s1 done、s2 skipped、s3 running（w3 在干）、s4 是带问题还没轮到的 gate、s5 pending、docs ready（轮到了没人派）
    ledger.close();
    downgradeToOldSchema({ s1: "done", s2: "skipped", s3: "running", s4: "pending", s5: "pending", docs: "ready" });
    expect(db.get("SELECT kind FROM task_graph_nodes WHERE node_key = 's4'")).toEqual({ kind: "gate" });
    const mig = migrate(db);
    expect(mig.from).toBe(24);
    expect(mig.applied.slice(0, 2)).toEqual([25, 26]);
    expect(userVersion(db)).toBeGreaterThanOrEqual(25);
    ledger = createLedger(db, options());

    let g = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).data.graph;
    expect(Object.fromEntries(g.nodes.map((n) => [n.key, stateOf(g, n.key)]))).toEqual({
      s1: "done",
      s2: "skipped",
      s3: "running",
      s4: "pending",
      s5: "pending",
      docs: "waiting:pm",
    });
    expect(g.nodes.find((n) => n.key === "s1")).toMatchObject({ workerIds: [w1.id], artifact: { summary: "提示词重排完了" } });
    expect(g.nodes.find((n) => n.key === "s3")).toMatchObject({ activeWorkerId: w3.id, workerIds: [w3.id] });
    // hub status 按四个状态汇总：迁移时正 ready 的步骤不补发叫醒，项目经理在这里看得到
    const status = ledger.hubCall(lin.sessionId, "status", {}).text;
    expect(status).toContain(`- #${graph.id}「编排简化实现」（进度 2/6；在干：s3；等你处理：docs）`);

    // 在干的 s3 汇报做完了：后台自动把 s3 标完了并收工 Worker，s4 轮到了，挂着问题，出拍板卡等用户
    finishWorkerTurn(w3.id, "接手带前任记录");
    g = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).data.graph;
    expect(stateOf(g, "s3")).toBe("done");
    expect(stateOf(g, "s4")).toBe("waiting:user");
    const card = g.nodes.find((n) => n.key === "s4")!;
    expect(card.gateAskMessageId).toBeTypeOf("number");
    const snap = { ...ledger.snapshot(), server: { os: "darwin" as const, folderPicker: true, fileActions: true } };
    expect(pendingDecisionsOf(snap, "local")).toMatchObject([
      { question: "旧图迁移后要不要补发叫醒？", options: ["不补发", "补发"], source: { kind: "gate", graphId: graph.id, nodeKey: "s4", recommended: "不补发" } },
    ]);

    // 用户点了：s4 完了，s5 轮到了等项目经理，同一条叫醒消息里写明
    const decided = ledger.decideTaskNode(graph.id, "s4", { clientId: "c-1", choice: "不补发" });
    expect(stateOf(decided.graph, "s4")).toBe("done");
    expect(stateOf(decided.graph, "s5")).toBe("waiting:pm");
    expect(ledger.getMessage(decided.messageId!)!.text).toContain("轮到了：s5 [等你处理]");

    // 迁移前就 ready 的 docs 和刚轮到的 s5：项目经理派人，做完收工，最后一步完了图待交付、发交付单
    for (const key of ["docs", "s5"]) {
      const w = startOn(key, graph.id);
      expect(stateOf(ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).data.graph, key)).toBe("running");
      finishWorkerTurn(w.id, `${key} 做完了`);
      ledger.hubCall(lin.sessionId, "worker.end", { workerId: w.id });
    }
    g = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).data.graph;
    expect(g.nodes.every((n) => n.status === "done")).toBe(true);
    expect(isTaskGraphReadyToFinish(g)).toBe(true);
    const note = db.get<{ text: string }>(
      "SELECT text FROM messages WHERE dedupe_key GLOB ? ORDER BY id DESC LIMIT 1",
      `system:${lin.conversationId}:task_graph.ready_to_finish:${graph.id}:*`,
    )!.text;
    expect(note).toContain("[已跳过] s2 唯一结束出口 · 已跳过：并进第 3 步");
    expect(note).toContain("拍板：「旧图迁移后要不要补发叫醒？」定案 不补发");

    const finished = ledger.hubCall(lin.sessionId, "graph.finish", { graphId: graph.id, summary: "编排简化第 1～5 步都合并了" }).data.graph;
    expect(finished.status).toBe("completed");
  });

  it("过渡期真实拓扑重放（任务图 #6：多路历史 done 合流 + s4-review 在干 -> s5 -> s6）：升级 0025 后全链路无断裂走完", () => {
    const graph = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({
        title: "编排简化实现（方案 PR 290，按 6 步）",
        nodes: [
          { key: "s1", title: "提示词重排" },
          { key: "eval-approve", title: "拍板验证方案", question: "基准集规模？", options: ["12 个", "6 个"], recommended: "12 个" },
          { key: "s2", title: "唯一结束出口", deps: ["s1", "eval-approve"] },
          { key: "s3", title: "出错接手", deps: ["s2"] },
          { key: "s4", title: "四个状态与迁移", deps: ["s3"] },
          { key: "s4-review", title: "审查 PR 310", deps: ["s4"] },
          { key: "s5", title: "自动开工和交棒", deps: ["s4-review"] },
          { key: "s6", title: "等用户与检查点", deps: ["s5"] },
        ],
      }),
    }).data.graph;
    ledger.hubCall(lin.sessionId, "graph.done", { graphId: graph.id, nodeKey: "s1", summary: "s1 已合入" });
    ledger.decideTaskNode(graph.id, "eval-approve", { clientId: "u-eval", choice: "12 个" });
    for (const k of ["s2", "s3", "s4"]) {
      ledger.hubCall(lin.sessionId, "graph.done", { graphId: graph.id, nodeKey: k, summary: `${k} 已合入` });
    }
    const wReview = startOn("s4-review", graph.id);

    ledger.close();
    downgradeToOldSchema({
      s1: "done",
      "eval-approve": "done",
      s2: "done",
      s3: "done",
      s4: "done",
      "s4-review": "running",
      s5: "pending",
      s6: "pending",
    });
    const mig = migrate(db);
    expect(mig.from).toBe(24);
    expect(mig.applied.slice(0, 2)).toEqual([25, 26]);
    ledger = createLedger(db, options());

    expect(ledger.hubCall(lin.sessionId, "status", {}).text).toContain("进度 5/8；在干：s4-review");

    finishWorkerTurn(wReview.id, "审查通过并补齐回归用例");
    expect(ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).text).toContain("[等你处理] s5");

    for (const k of ["s5", "s6"]) {
      const w = startOn(k, graph.id);
      finishWorkerTurn(w.id, `${k} 完成`);
      ledger.hubCall(lin.sessionId, "worker.end", { workerId: w.id });
    }
    const doneGraph = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).data.graph;
    expect(isTaskGraphReadyToFinish(doneGraph)).toBe(true);
    const finished = ledger.hubCall(lin.sessionId, "graph.finish", { graphId: graph.id, summary: "编排简化 6 步全部完成" }).data.graph;
    expect(finished.status).toBe("completed");
  });
});
