import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Change } from "../../shared/api.ts";
import { pendingDecisionsOf } from "../../shared/decisions.ts";
import { askOf, EMPTY_TOKEN_USAGE, type ConversationId, type PmId, type ProjectId, type SessionId } from "../../shared/domain.ts";
import { GRAPH_TEXT_NODE_NOTE_CHARS, HANDOVER_GRAPHS_MAX_CHARS, MAX_GRAPH_NODES, MAX_ACTIVE_GRAPHS_PER_PROJECT, PM_ARCHIVE_RETENTION_MS } from "../../shared/limits.ts";
import { TASK_GRAPH_CREATE_JSON_HINT, TASK_GRAPH_PATCH_JSON_HINT } from "../../shared/hub.ts";
import { REPORT_END, REPORT_START } from "../../shared/worker.ts";
import { openDatabase } from "../store/db.ts";
import type { Db } from "../store/index.ts";
import { migrate } from "../store/migrate.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger, type LedgerOptions, type SqliteLedger } from "./index.ts";

let root: string;
let dbFile: string;
let db: Db;
let ledger: SqliteLedger;
let changes: Change[];
let now: number;
let lin: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId; projectId: ProjectId; folder: string };

function options(extra: Partial<LedgerOptions> = {}): LedgerOptions {
  const dataHome = join(root, ".agent-hub");
  return {
    now: () => now,
    pmHomeRoot: join(dataHome, "pm-home"),
    dataHome,
    worktreesDir: join(dataHome, "worktrees"),
    resolveFolder: createResolveFolder({ dataHome, userHome: root }),
    ...extra,
  };
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-task-graphs-")));
  dbFile = join(root, "hub.sqlite");
  now = 20_000;
  db = openDatabase(dbFile);
  migrate(db);
  ledger = createLedger(db, options());
  changes = [];
  ledger.onChange((c) => changes.push(c));

  const folder = join(root, "work", "app");
  mkdirSync(folder, { recursive: true });
  const a = ledger.createPm({ name: "小林", mode: "manage_only", persona: "" });
  const realFolder = realpathSync.native(folder);
  const proj = ledger.hubCall(a.sessionId, "project.create", { folder: realFolder, name: "导出系统" }).data.project;
  lin = { pmId: a.pm.id, conversationId: a.conversation.id, sessionId: a.sessionId, projectId: proj.id, folder: realFolder };
  changes = [];
});

afterEach(() => {
  ledger.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function finishWorkerTurn(workerId: number, statusText: "做完了" | "有问题" | "放弃了", summary = "已完成") {
  const workerSession = db.get<{ id: number; conversation_id: number }>(
    "SELECT id, conversation_id FROM agent_sessions WHERE worker_id = ? ORDER BY generation DESC LIMIT 1",
    workerId,
  )!;
  const msg = db.get<{ id: number }>(
    "SELECT id FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1",
    workerSession.conversation_id,
  )!;
  ledger.applyDriverEvent(workerSession.id, { type: "message.delivered", messageIds: [msg.id], at: now });
  ledger.applyDriverEvent(workerSession.id, { type: "message.processing", messageIds: [msg.id], at: now });
  ledger.applyDriverEvent(workerSession.id, {
    type: "agent.text",
    uuid: `u-${workerId}-${++now}`,
    text: `本轮说明\n\n${REPORT_START}\n状态: ${statusText}\n摘要: ${summary}\n提交: abc1234\n测试: vitest 绿\n问题: 无\n${REPORT_END}`,
    at: now,
  });
  ledger.applyDriverEvent(workerSession.id, {
    type: "turn.ended",
    ok: true,
    interrupted: false,
    messageIds: [msg.id],
    durationMs: 50,
    at: now,
  });
}

/** 让项目经理换一次新会话，取新会话开场说明里“未完结的任务图”那一节的正文（账本实时拼的）。 */
function liveGraphsSection(): string | null {
  const { handoverId } = ledger.renewSession(lin.pmId);
  ledger.claimHandover();
  ledger.handoverForked(handoverId, { kind: "native", ref: { forker: "claude", handle: { forkId: "fork-live" } } });
  ledger.handoverWritten(handoverId, { text: "接着做。", usage: { ...EMPTY_TOKEN_USAGE } });
  const next = db.get<{ id: number }>("SELECT id FROM agent_sessions WHERE conversation_id = ? ORDER BY generation DESC LIMIT 1", lin.conversationId)!;
  const preamble = ledger.sessionPreamble(next.id)!;
  const heading = "## 未完结的任务图（账本实时状态）\n\n";
  const at = preamble.indexOf(heading);
  return at === -1 ? null : preamble.slice(at + heading.length);
}

describe("任务图（Task DAG）生命周期、同源门禁与 Worker 绑定", () => {
  it("hub graph create 校验 Kahn O(V+E) 无环并推导初始 ready / pending 状态；环路报出具体环路径", () => {
    expect(() =>
      ledger.hubCall(lin.sessionId, "graph.create", {
        specJson: JSON.stringify({
          title: "有环图",
          nodes: [
            { key: "a", title: "节点 A", deps: ["c"] },
            { key: "b", title: "节点 B", deps: ["a"] },
            { key: "c", title: "节点 C", deps: ["b"] },
          ],
        }),
      }),
    ).toThrow(/a.*b.*c|b.*c.*a|c.*a.*b/);

    const created = ledger.hubCall(lin.sessionId, "graph.create", {
      title: "实现 CSV 导出",
      specJson: JSON.stringify({
        nodes: [
          { key: "research", title: "调研数据规模" },
          { key: "gate-api", title: "拍板接口契约", kind: "gate", deps: ["research"] },
          { key: "impl-api", title: "实现后端接口", deps: ["gate-api"] },
          { key: "impl-ui", title: "实现前端按钮", deps: ["gate-api"] },
        ],
      }),
    }).data.graph;

    expect(created.title).toBe("实现 CSV 导出");
    expect(created.status).toBe("active");
    expect(created.nodes.map((n) => [n.key, n.status])).toEqual([
      ["research", "ready"],
      ["gate-api", "pending"],
      ["impl-api", "pending"],
      ["impl-ui", "pending"],
    ]);
    expect(ledger.snapshot().activeTaskGraphs).toHaveLength(1);
    expect(changes.some((c) => c.type === "task_graph.created")).toBe(true);
  });

  it("提示词与 hub --help 里的 graph create / patch 一行 JSON 示例照抄就能跑通（字段名与真实校验一致）", () => {
    const created = ledger.hubCall(lin.sessionId, "graph.create", { specJson: TASK_GRAPH_CREATE_JSON_HINT }).data.graph;
    expect(created.nodes.map((n) => [n.key, n.kind, n.status])).toEqual([
      ["plan", "piece", "ready"],
      ["ok", "gate", "pending"],
    ]);
    // 先补上示例里要删的节点和边，再原样套用 patch 示例
    ledger.hubCall(lin.sessionId, "graph.patch", {
      graphId: created.id,
      specJson: JSON.stringify({ addNodes: [{ key: "old", title: "旧步骤" }, { key: "polish", title: "打磨" }, { key: "a", title: "A" }, { key: "b", title: "B", deps: ["a"] }] }),
    });
    const patched = ledger.hubCall(lin.sessionId, "graph.patch", { graphId: created.id, specJson: TASK_GRAPH_PATCH_JSON_HINT }).data.graph;
    expect(patched.nodes.map((n) => n.key).toSorted()).toEqual(["a", "b", "ok", "plan", "polish", "qa"]);
    // 示例里的 skipNodes：跳过还没开工的节点
    expect(patched.nodes.find((n) => n.key === "polish")?.status).toBe("skipped");
    expect(patched.edges).toContainEqual({ fromKey: "plan", toKey: "qa" });
    expect(patched.edges).not.toContainEqual({ fromKey: "a", toKey: "b" });
  });

  it("单项目允许最多 20 张活跃图（不卡 5 张低阈值），第 21 张报 conflict", () => {
    for (let i = 1; i <= MAX_ACTIVE_GRAPHS_PER_PROJECT; i++) {
      ledger.hubCall(lin.sessionId, "graph.create", {
        specJson: JSON.stringify({
          title: `并行特性 #${i}`,
          nodes: [{ key: "n1", title: "任务 1" }],
        }),
      });
    }
    expect(ledger.snapshot().activeTaskGraphs).toHaveLength(20);
    expect(() =>
      ledger.hubCall(lin.sessionId, "graph.create", {
        specJson: JSON.stringify({
          title: "第 21 张图",
          nodes: [{ key: "n1", title: "任务 1" }],
        }),
      }),
    ).toThrow(/20/);
  });

  it("Worker --node 绑定、异常置 attention、--incomplete 接力重绑不断链、正常收工解锁下游", () => {
    const graph = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({
        title: "重构鉴权",
        nodes: [
          { key: "step-1", title: "底座改造" },
          { key: "step-2", title: "接入路由", deps: ["step-1"] },
        ],
      }),
    }).data.graph;

    // 未就绪节点不允许直接派 Worker
    expect(() =>
      ledger.hubCall(lin.sessionId, "worker.start", {
        title: "抢跑",
        task: "做 step-2",
        noWorktree: true,
        node: "step-2",
      }),
    ).toThrow();

    // 绑定 step-1 -> running
    const w1 = ledger.hubCall(lin.sessionId, "worker.start", {
      title: "底座第1棒",
      task: "做 step-1",
      noWorktree: true,
      node: "step-1",
    }).data.worker;

    let shown = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).data.graph;
    expect(shown.nodes.find((n) => n.key === "step-1")).toMatchObject({
      status: "running",
      activeWorkerId: w1.id,
      workerIds: [w1.id],
    });

    // 即使 w1 汇报了“做完了”，若因对话太长换人传了 --incomplete，节点必须进入 attention 而绝不能误解锁 step-2！
    finishWorkerTurn(w1.id, "做完了", "完成了一半，上下文已满");
    ledger.hubCall(lin.sessionId, "worker.end", { workerId: w1.id, incomplete: true });

    shown = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).data.graph;
    expect(shown.nodes.find((n) => n.key === "step-1")).toMatchObject({
      status: "attention",
      activeWorkerId: null,
      workerIds: [w1.id],
    });
    expect(shown.nodes.find((n) => n.key === "step-2")?.status).toBe("pending");

    // 派接力 Worker w2 重新绑定同一节点 step-1，历史 workerIds 完整保留 [w1.id, w2.id]
    const w2 = ledger.hubCall(lin.sessionId, "worker.start", {
      title: "底座第2棒",
      task: "接手完成 step-1",
      noWorktree: true,
      node: "step-1",
    }).data.worker;

    // 先汇报“有问题” -> 节点置为 attention
    finishWorkerTurn(w2.id, "有问题", "发现边界情况");
    shown = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).data.graph;
    expect(shown.nodes.find((n) => n.key === "step-1")?.status).toBe("attention");

    // PM 追问后 w2 汇报“做完了”并正常 end -> step-1 置 done，step-2 自动解锁为 ready！
    ledger.hubCall(lin.sessionId, "worker.send", { workerId: w2.id, text: "按方案 A 处理继续做完" });
    finishWorkerTurn(w2.id, "做完了", "全部搞定");
    ledger.hubCall(lin.sessionId, "worker.end", { workerId: w2.id });

    shown = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).data.graph;
    expect(shown.nodes.find((n) => n.key === "step-1")).toMatchObject({
      status: "done",
      activeWorkerId: null,
      workerIds: [w1.id, w2.id],
    });
    expect(shown.nodes.find((n) => n.key === "step-2")?.status).toBe("ready");
  });

  it("hub graph done 拒绝有 Worker 在干的节点：提示先收工；收工后（节点 done 或 attention）可以标完成、补记 PR", () => {
    const graph = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({ title: "导出", nodes: [{ key: "impl", title: "实现" }, { key: "qa", title: "验收", deps: ["impl"] }] }),
    }).data.graph;
    // 没人在干的 ready 节点可以直接标完成（比如项目经理自己做完的）
    const other = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({ title: "小事", nodes: [{ key: "solo", title: "自己做" }, { key: "after", title: "之后", deps: ["solo"] }] }),
    }).data.graph;
    expect(ledger.hubCall(lin.sessionId, "graph.done", { graphId: other.id, nodeKey: "solo" }).text).toContain("已自动解锁：after [ready]");

    const w = ledger.hubCall(lin.sessionId, "worker.start", { title: "实现", task: "做 impl", noWorktree: true, node: "impl" }).data.worker;
    let error: unknown;
    try {
      ledger.hubCall(lin.sessionId, "graph.done", { graphId: graph.id, nodeKey: "impl", prUrl: "https://example.test/pr/1" });
    } catch (err) {
      error = err;
    }
    expect(error).toMatchObject({ code: "conflict" });
    const message = (error as Error).message;
    expect(message).toContain(`节点「impl」正在由 Worker #${w.id} 执行，不能直接标完成`);
    expect(message).toContain(`hub worker end ${w.id}`);
    expect(message).toContain("它最近一轮汇报是“做完了”时节点会自动标完成");
    // 没被改：还在干，下游没解锁，PR 没记上
    let shown = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).data.graph;
    expect(shown.nodes.find((n) => n.key === "impl")).toMatchObject({ status: "running", activeWorkerId: w.id, artifact: null });
    expect(shown.nodes.find((n) => n.key === "qa")?.status).toBe("pending");

    // Worker 汇报“做完了”后节点还是 running（有人在干），照样拒绝；收工后节点自动 done，再调 graph done 补记 PR
    finishWorkerTurn(w.id, "做完了", "导出接口已实现");
    expect(() => ledger.hubCall(lin.sessionId, "graph.done", { graphId: graph.id, nodeKey: "impl" })).toThrow(/不能直接标完成/);
    ledger.hubCall(lin.sessionId, "worker.end", { workerId: w.id });
    ledger.hubCall(lin.sessionId, "graph.done", { graphId: graph.id, nodeKey: "impl", prUrl: "https://example.test/pr/1" });
    shown = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).data.graph;
    expect(shown.nodes.find((n) => n.key === "impl")).toMatchObject({
      status: "done",
      artifact: { summary: "导出接口已实现", prUrl: "https://example.test/pr/1" },
    });

    // attention（等人接手）的节点项目经理可以放行
    const w2 = ledger.hubCall(lin.sessionId, "worker.start", { title: "验收", task: "做 qa", noWorktree: true, node: "qa" }).data.worker;
    finishWorkerTurn(w2.id, "有问题", "缺测试数据");
    expect(ledger.hubCall(lin.sessionId, "graph.done", { graphId: graph.id, nodeKey: "qa" }).text).toContain("整张任务图已全部完结");
  });

  it("hub worker end 的回执写明绑定的节点变成了什么：做完了 → done 并列出解锁的下游；--incomplete 或没汇报做完 → attention 等人接手；没绑图的不提", () => {
    const graph = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({ title: "导出", nodes: [{ key: "impl", title: "实现" }, { key: "qa", title: "验收", deps: ["impl"] }] }),
    }).data.graph;
    const start = (title: string, node?: string) =>
      ledger.hubCall(lin.sessionId, "worker.start", { title, task: `做 ${title}`, noWorktree: true, ...(node === undefined ? {} : { node }) }).data.worker;

    // 换人：汇报了“做完了”也按 --incomplete 等人接手
    const w1 = start("实现第 1 棒", "impl");
    finishWorkerTurn(w1.id, "做完了", "做了一半");
    const swapped = ledger.hubCall(lin.sessionId, "worker.end", { workerId: w1.id, incomplete: true }).text;
    expect(swapped).toContain(`Worker #${w1.id}“实现第 1 棒”已收工。`);
    expect(swapped).toContain(`它绑定的任务图 #${graph.id} 的节点「impl」变成 attention，等人接手（带了 --incomplete）`);
    expect(swapped).toContain("hub worker start --node impl");
    expect(swapped).toContain("hub graph skip impl");

    // 没汇报“做完了”就收工：也是等人接手，原因不一样
    const w2 = start("实现第 2 棒", "impl");
    const unfinished = ledger.hubCall(lin.sessionId, "worker.end", { workerId: w2.id }).text;
    expect(unfinished).toContain("节点「impl」变成 attention，等人接手（它最近一轮没有汇报“做完了”）");

    // 做完了：节点 done，回执列出解锁的下游
    const w3 = start("实现第 3 棒", "impl");
    finishWorkerTurn(w3.id, "做完了", "实现完了");
    const done = ledger.hubCall(lin.sessionId, "worker.end", { workerId: w3.id }).text;
    expect(done).toContain(`它绑定的任务图 #${graph.id} 的节点「impl」已标记为 done（它最近一轮汇报是“做完了”）；已自动解锁：qa [ready]。`);

    // 最后一个节点做完：回执写明整张图完结
    const w4 = start("验收", "qa");
    finishWorkerTurn(w4.id, "做完了", "验收通过");
    expect(ledger.hubCall(lin.sessionId, "worker.end", { workerId: w4.id }).text).toContain("节点「qa」已标记为 done（它最近一轮汇报是“做完了”）；整张任务图已全部完结！");

    // 临时 Worker（不绑图）：回执不提任务图
    const temp = start("跑腿");
    expect(ledger.hubCall(lin.sessionId, "worker.end", { workerId: temp.id }).text).not.toContain("任务图");
  });

  it("hub graph show 和换新会话的交接摘要带上每个节点的结果：经手的 Worker、分支、提交、PR、摘要、定案；长摘要截断", () => {
    const graph = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({
        title: "导出",
        nodes: [
          { key: "impl", title: "实现" },
          { key: "ok", title: "确认方案", kind: "gate", deps: ["impl"] },
          { key: "ship", title: "发布", deps: ["ok"] },
        ],
      }),
    }).data.graph;
    const bare = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).text;
    // 还没有结果的节点只有一行，和以前一样
    expect(bare.split("\n")).toEqual([
      `任务图 #${graph.id}「导出」（状态：active）`,
      "  - [ready] impl：实现",
      "  - [pending] ok：确认方案 [门禁] ← [impl]",
      "  - [pending] ship：发布 ← [ok]",
    ]);

    const w = ledger.hubCall(lin.sessionId, "worker.start", { title: "实现", task: "做 impl", noWorktree: true, node: "impl" }).data.worker;
    expect(ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).text).toContain(`  - [running] impl：实现 · Worker #${w.id}`);
    finishWorkerTurn(w.id, "做完了", `导出接口已实现 ${"很长的说明".repeat(60)}`);
    ledger.hubCall(lin.sessionId, "worker.end", { workerId: w.id });
    ledger.hubCall(lin.sessionId, "graph.done", {
      graphId: graph.id,
      nodeKey: "impl",
      prUrl: "https://example.test/pr/7",
      commit: "abc1234",
      branch: "hub/7-导出",
    });
    ledger.hubCall(lin.sessionId, "graph.ask", { graphId: graph.id, nodeKey: "ok", question: "按方案 A 吗？", options: ["方案 A", "方案 B"] });
    ledger.hubCall(lin.sessionId, "graph.decide", { graphId: graph.id, nodeKey: "ok", choice: "方案 A", note: "先不做分页" });

    const text = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).text;
    const lines = text.split("\n");
    expect(lines[1]).toBe(`  - [done] impl：实现 · 经手 Worker #${w.id}`);
    expect(lines[2]).toBe("      分支 hub/7-导出 · 提交 abc1234 · PR https://example.test/pr/7");
    expect(lines[3]!.startsWith("      摘要：导出接口已实现 很长的说明")).toBe(true);
    expect([...lines[3]!.replace("      摘要：", "")]).toHaveLength(GRAPH_TEXT_NODE_NOTE_CHARS);
    expect(lines[3]!.endsWith("…")).toBe(true);
    expect(lines[4]).toBe("  - [done] ok：确认方案 [门禁] ← [impl]");
    expect(lines[5]).toBe("      定案：方案 A（先不做分页）");
    expect(lines[6]).toBe("  - [ready] ship：发布 ← [ok]");
    expect(lines).toHaveLength(7);

    // 交接摘要用的是同一份文本
    const preamble = liveGraphsSection();
    expect(preamble).toBe(text);
  });

  it("交接摘要里未完结的任务图有总字数上限：最近动过的给全文，放不下的只列节点状态，还放不下的只留一行进度和怎么查", () => {
    const longSummary = "摘".repeat(GRAPH_TEXT_NODE_NOTE_CHARS);
    const ids: number[] = [];
    for (let g = 0; g < MAX_ACTIVE_GRAPHS_PER_PROJECT; g++) {
      now += 10;
      const nodes = Array.from({ length: 12 }, (_, i) => ({ key: `n${i}`, title: `第 ${i} 步` }));
      const graph = ledger.hubCall(lin.sessionId, "graph.create", { specJson: JSON.stringify({ title: `图 ${g}`, nodes }) }).data.graph;
      ids.push(graph.id);
      for (let i = 0; i < 11; i++) {
        ledger.hubCall(lin.sessionId, "graph.done", { graphId: graph.id, nodeKey: `n${i}`, summary: longSummary, prUrl: `https://example.test/pr/${i}` });
      }
    }
    const section = liveGraphsSection()!;
    const blocks = section.split("\n\n");
    expect(blocks).toHaveLength(MAX_ACTIVE_GRAPHS_PER_PROJECT);
    // 按图编号排，每张图都在
    expect(blocks.map((b) => Number(/^任务图 #(\d+)/.exec(b)![1]))).toEqual(ids);
    const tier = (b: string) => (!b.includes("\n") ? "brief" : b.includes("摘要：") ? "full" : "status");
    const tiers = blocks.map(tier);
    const count = (t: string) => tiers.filter((x) => x === t).length;
    expect(count("full")).toBeGreaterThan(0);
    expect(count("status")).toBeGreaterThan(0);
    expect(count("brief")).toBeGreaterThan(0);
    // 越近动过的（编号大的）给得越全：一行进度 → 只列状态 → 全文
    expect(tiers).toEqual([...Array(count("brief")).fill("brief"), ...Array(count("status")).fill("status"), ...Array(count("full")).fill("full")]);
    const brief = blocks.filter((b) => tier(b) === "brief");
    for (const b of brief) expect(b).toMatch(/^任务图 #\d+「图 \d+」（状态：active，进度 11\/12；详情用 hub graph show \d+ 看）$/);
    // 只列状态的那几张：每个节点一行，没有结果行
    const status = blocks.find((b) => tier(b) === "status")!;
    expect(status.split("\n")).toHaveLength(13);
    expect(status).toContain("  - [done] n0：第 0 步");
    expect(status).not.toContain("PR https://");
    // 全文、状态、一行进度以及分隔符均计入硬上限
    const bodyChars = blocks.filter((b) => tier(b) !== "brief").reduce((sum, b) => sum + [...b].length, 0);
    expect(bodyChars).toBeLessThanOrEqual(HANDOVER_GRAPHS_MAX_CHARS);
    expect([...section].length).toBeLessThanOrEqual(HANDOVER_GRAPHS_MAX_CHARS);
  });

  it("20 张图各 32 个节点写满摘要时，交接全文含分隔符严格不超过 8000 字且稳定", () => {
    for (let g = 0; g < MAX_ACTIVE_GRAPHS_PER_PROJECT; g++) {
      const graph = ledger.hubCall(lin.sessionId, "graph.create", {
        specJson: JSON.stringify({ title: "图".repeat(120), nodes: Array.from({ length: MAX_GRAPH_NODES }, (_, i) => ({
          key: `n${i}`, title: "😀".repeat(80),
        })) }),
      }).data.graph;
      db.run("UPDATE task_graph_nodes SET artifact_json = ? WHERE graph_id = ?",
        JSON.stringify({ summary: "😀".repeat(500), branch: "b".repeat(160), commit: "c".repeat(160), prUrl: "p".repeat(160) }), graph.id);
    }
    const first = liveGraphsSection()!;
    expect([...first].length).toBeLessThanOrEqual(HANDOVER_GRAPHS_MAX_CHARS);
    expect(first.split("\n\n")).toHaveLength(MAX_ACTIVE_GRAPHS_PER_PROJECT);
    expect(liveGraphsSection()).toBe(first);
    expect(first).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });

  it("交接全文恰好 8000 字时保留全文，多一字就降为状态档", () => {
    const graph = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({ title: "边界", nodes: Array.from({ length: MAX_GRAPH_NODES }, (_, i) => ({ key: `n${i}`, title: "步骤" })) }),
    }).data.graph;
    const artifact = (size: number) => JSON.stringify({ summary: "摘".repeat(GRAPH_TEXT_NODE_NOTE_CHARS), branch: "b".repeat(size) });
    let size = 1;
    let full = "";
    for (; size < GRAPH_TEXT_NODE_NOTE_CHARS; size++) {
      db.run("UPDATE task_graph_nodes SET artifact_json = ? WHERE graph_id = ?", artifact(size), graph.id);
      full = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).text;
      if ([...full].length > HANDOVER_GRAPHS_MAX_CHARS) break;
    }
    size--;
    db.run("UPDATE task_graph_nodes SET artifact_json = ? WHERE graph_id = ?", artifact(size), graph.id);
    full = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).text;
    const extra = HANDOVER_GRAPHS_MAX_CHARS - [...full].length;
    db.run("UPDATE task_graph_nodes SET artifact_json = ? WHERE graph_id = ? AND node_key = 'n0'", artifact(size + extra), graph.id);
    const exact = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).text;
    expect([...exact]).toHaveLength(HANDOVER_GRAPHS_MAX_CHARS);
    expect(liveGraphsSection()).toBe(exact);
    db.run("UPDATE task_graph_nodes SET artifact_json = ? WHERE graph_id = ? AND node_key = 'n0'", artifact(size + extra + 1), graph.id);
    const downgraded = liveGraphsSection()!;
    expect(downgraded).toContain("[ready] n0");
    expect(downgraded).not.toContain("摘要：");
  });

  it("结果中的 Markdown 截断后仍是普通文本，不产生残缺链接或代码围栏", () => {
    const graph = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({ title: "显示", nodes: [{ key: "a", title: "结果" }, { key: "b", title: "继续" }] }),
    }).data.graph;
    ledger.hubCall(lin.sessionId, "graph.done", {
      graphId: graph.id, nodeKey: "a", summary: "[链接](https://example.test/" + "😀".repeat(200) + ")",
    });
    const text = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).text;
    expect(text).toContain("\\[链接\\]\\(");
    expect(text).not.toContain("[链接](");
    expect([...text].filter((c) => c === "😀")).toHaveLength(GRAPH_TEXT_NODE_NOTE_CHARS - "[链接](https://example.test/".length - 1);
  });

  it("取消图后 Worker 收工不改写节点，也不冒认已跳过的节点", () => {
    const graph = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({ title: "终态", nodes: [{ key: "a", title: "实现" }, { key: "b", title: "跳过" }] }),
    }).data.graph;
    ledger.hubCall(lin.sessionId, "graph.skip", { graphId: graph.id, nodeKey: "b" });
    const w = ledger.hubCall(lin.sessionId, "worker.start", { title: "实现", task: "实现", node: "a", noWorktree: true }).data.worker;
    ledger.hubCall(lin.sessionId, "graph.cancel", { graphId: graph.id });
    finishWorkerTurn(w.id, "做完了");
    expect(ledger.hubCall(lin.sessionId, "worker.end", { workerId: w.id }).text).not.toContain("已标记为 done");
    const after = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).data.graph;
    expect(after.status).toBe("cancelled");
    expect(after.nodes.find((n) => n.key === "b")?.status).toBe("skipped");
    expect(after.nodes.find((n) => n.key === "a")?.status).not.toBe("done");
  });

  it("最后一个 Worker 收工后仍可给已完成图补记产物，但取消图不能补记", () => {
    const graph = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({ title: "完成", nodes: [{ key: "only", title: "实现" }] }),
    }).data.graph;
    const w = ledger.hubCall(lin.sessionId, "worker.start", {
      title: "实现", task: "实现", node: "only", noWorktree: true,
    }).data.worker;
    finishWorkerTurn(w.id, "做完了");
    ledger.hubCall(lin.sessionId, "worker.end", { workerId: w.id });
    const updated = ledger.hubCall(lin.sessionId, "graph.done", {
      graphId: graph.id, nodeKey: "only", prUrl: "https://example.test/pr/1",
    }).data.graph;
    expect(updated.status).toBe("completed");
    expect(updated.nodes[0]!.artifact?.prUrl).toBe("https://example.test/pr/1");
    const cancelled = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({ title: "取消", nodes: [{ key: "other", title: "取消" }] }),
    }).data.graph;
    ledger.hubCall(lin.sessionId, "graph.cancel", { graphId: cancelled.id });
    expect(() => ledger.hubCall(lin.sessionId, "graph.done", { graphId: cancelled.id, nodeKey: "other" })).toThrow(/已经结束/);
  });

  it("归档满七天清理 PM、项目与对话时，Router 与图关联记录全部安全清除", () => {
    const graph = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({ title: "待清理", nodes: [
        { key: "a", title: "实现" }, { key: "g", title: "拍板", kind: "gate" },
      ] }),
    }).data.graph;
    const worker = ledger.hubCall(lin.sessionId, "worker.start", {
      title: "实现", task: "实现 a", noWorktree: true, node: "a",
    }).data.worker;
    ledger.hubCall(lin.sessionId, "graph.ask", { graphId: graph.id, nodeKey: "g", question: "是否继续？", options: ["是", "否"] });
    const ask = ledger.hubCall(lin.sessionId, "router.ask", { question: "继续吗？", options: ["是", "否"] }).data;
    ledger.hubCall(lin.sessionId, "router.note", { text: "等待" });
    db.run("INSERT INTO router_worker_origins (worker_id, source_kind, source_id, pm_message_id, created_at) VALUES (?, 'router_resolve', ?, ?, ?)", worker.id, ask.item.id, ask.messageId, now);
    ledger.archivePm(lin.pmId);
    expect(ledger.purgeExpiredArchivedPms(now + PM_ARCHIVE_RETENTION_MS)).toEqual([lin.pmId]);
    for (const table of ["router_items", "router_pm_notes", "router_worker_origins", "task_graphs", "task_graph_nodes", "task_graph_edges"]) {
      expect(db.all(`SELECT * FROM ${table}`)).toEqual([]);
    }
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("上一轮做完后被打回，新一轮未汇报就收工不能复用旧完成报告", () => {
    const graph = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({ title: "接续修复", nodes: [
        { key: "a", title: "实现" }, { key: "b", title: "验收", deps: ["a"] },
      ] }),
    }).data.graph;
    const worker = ledger.hubCall(lin.sessionId, "worker.start", {
      title: "实现", task: "实现 a", noWorktree: true, node: "a",
    }).data.worker;
    finishWorkerTurn(worker.id, "做完了");
    ledger.hubCall(lin.sessionId, "worker.send", { workerId: worker.id, text: "还有漏项，继续修复" });
    ledger.hubCall(lin.sessionId, "worker.end", { workerId: worker.id });
    const shown = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).data.graph;
    expect(shown.nodes.find((n) => n.key === "a")?.status).toBe("attention");
    expect(shown.nodes.find((n) => n.key === "b")?.status).toBe("pending");
  });

  it("已拍板门禁在图取消后重放旧 clientId 必须拒绝且不发消息", () => {
    const graph = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({ title: "旧卡", nodes: [
        { key: "g", title: "拍板", kind: "gate" }, { key: "a", title: "实现", deps: ["g"] },
      ] }),
    }).data.graph;
    ledger.decideTaskNode(graph.id, "g", { clientId: "old", note: "同意" });
    ledger.cancelTaskGraph(graph.id, {});
    changes = [];
    expect(() => ledger.decideTaskNode(graph.id, "g", { clientId: "old", note: "同意" })).toThrow(/cancelled/);
    expect(changes).toEqual([]);
  });

  it("门禁同源流转与防闲聊误冲：插队闲聊绝不冲掉 gate，POST decide 单事务解锁下游、标 AskMeta.answered、唤醒 PM 且幂等", () => {
    const graph = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({
        title: "权限升级",
        nodes: [
          { key: "survey", title: "盘点现有路由" },
          { key: "gate-auth", title: "确认会话策略", kind: "gate", deps: ["survey"] },
          { key: "impl-jwt", title: "改造中间件", deps: ["gate-auth"] },
          { key: "impl-test", title: "回归测试", deps: ["impl-jwt"] },
        ],
      }),
    }).data.graph;

    // PM 完成 survey -> 草稿门禁 gate-auth 因尚无 question 先解锁为 ready（不发半成品拍板卡）
    ledger.hubCall(lin.sessionId, "graph.done", {
      nodeKey: "survey",
      summary: "共 14 个路由需要鉴权",
    });
    let g = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).data.graph;
    expect(g.nodes.find((n) => n.key === "gate-auth")?.status).toBe("ready");

    // PM 调 hub graph ask 填入选项与调研摘要 -> gate-auth 正式激活为 waiting_user 并生成带 gateRef 的 AskMeta 消息
    const asked = ledger.hubCall(lin.sessionId, "graph.ask", {
      nodeKey: "gate-auth",
      question: "鉴权令牌存 HttpOnly Cookie 还是 Bearer Header？",
      options: ["HttpOnly Cookie", "Bearer Header"],
      recommended: "HttpOnly Cookie",
      summaryMd: "同域部署下 HttpOnly Cookie 天然防 XSS。",
    }).data;
    expect(asked.messageId).toBeTypeOf("number");
    const gateMsgId = asked.messageId!;
    expect(askOf(ledger.getMessage(gateMsgId)!)).toEqual({
      needsUser: true,
      options: ["HttpOnly Cookie", "Bearer Header"],
      gateRef: { graphId: graph.id, nodeKey: "gate-auth" },
    });

    // 同时 PM 又发了一条普通的独立 hub ask
    const casualAskId = ledger.hubCall(lin.sessionId, "ask", {
      text: "顺便确认：日志级别默认用 info 可以吗？",
      options: ["可以", "改成 warn"],
    }).data.messageId;

    // 用户在聊天窗插队聊别的话题！普通 ask 被回答，但带 gateRef 的任务图门禁绝不被冲掉！
    ledger.postUserMessage({
      conversationId: lin.conversationId,
      clientId: "side-chat-1",
      text: "日志用 info 就行，门禁那个我再看两分钟",
    });
    expect(askOf(ledger.getMessage(casualAskId)!)?.answered).toBe(true);
    expect(askOf(ledger.getMessage(gateMsgId)!)?.answered).toBeUndefined();

    const snapMid = { ...ledger.snapshot(), server: { os: "darwin" as const, folderPicker: true, fileActions: true } };
    const pendingMid = pendingDecisionsOf(snapMid, "local");
    expect(pendingMid).toHaveLength(1);
    expect(pendingMid[0]).toMatchObject({
      question: "鉴权令牌存 HttpOnly Cookie 还是 Bearer Header？",
      source: {
        kind: "gate",
        graphId: graph.id,
        nodeKey: "gate-auth",
        blockedNodeCount: 2,
        nextNodeTitles: ["改造中间件"],
        recommended: "HttpOnly Cookie",
      },
    });
    // Digest 的 pendingDecisionCount 也同步计入该活跃门禁
    expect(ledger.getRouterDigest().pms.find((p) => p.pmId === lin.pmId)?.pendingDecisionCount).toBe(1);

    // 用户点拍板按钮（decideTaskNode）：门禁 -> done，impl-jwt -> ready，AskMeta.answered = true，唤醒 PM，且幂等！
    const decided = ledger.decideTaskNode(graph.id, "gate-auth", {
      clientId: "decide-btn-1",
      choice: "HttpOnly Cookie",
      note: "记得加 SameSite=Lax",
    });
    expect(decided.graph.nodes.find((n) => n.key === "gate-auth")).toMatchObject({
      status: "done",
      decision: {
        choice: "HttpOnly Cookie",
        note: "记得加 SameSite=Lax",
        decidedBy: "user",
        clientId: "decide-btn-1",
      },
    });
    expect(decided.graph.nodes.find((n) => n.key === "impl-jwt")?.status).toBe("ready");
    expect(askOf(ledger.getMessage(gateMsgId)!)).toMatchObject({
      needsUser: true,
      answered: true,
      chosenOption: "HttpOnly Cookie",
    });
    expect(decided.messageId).toBeTypeOf("number");
    const wakeText = ledger.getMessage(decided.messageId!)!.text;
    expect(wakeText).toContain("HttpOnly Cookie");
    expect(wakeText).toContain("SameSite=Lax");
    expect(wakeText).toContain("impl-jwt");

    const snapAfter = { ...ledger.snapshot(), server: { os: "darwin" as const, folderPicker: true, fileActions: true } };
    expect(pendingDecisionsOf(snapAfter, "local")).toEqual([]);
    expect(ledger.getRouterDigest().pms.find((p) => p.pmId === lin.pmId)?.pendingDecisionCount).toBe(0);

    // 重复带同一 clientId 调用幂等，不重复插唤醒消息
    changes = [];
    const replay = ledger.decideTaskNode(graph.id, "gate-auth", {
      clientId: "decide-btn-1",
      choice: "HttpOnly Cookie",
      note: "记得加 SameSite=Lax",
    });
    expect(replay.messageId).toBe(decided.messageId);
    expect(changes).toEqual([]);
  });

  it("patch 保护运行态与已完成节点、skip 支持单分支级联与多分支汇聚解锁、全图完成后自动归入历史分页", () => {
    const graph = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({
        title: "多路构建",
        nodes: [
          { key: "base", title: "公共底座" },
          { key: "opt-branch", title: "可选实验分支", deps: ["base"] },
          { key: "opt-leaf", title: "实验子任务", deps: ["opt-branch"] },
          { key: "join-release", title: "汇总发版", deps: ["base", "opt-branch"] },
        ],
      }),
    }).data.graph;

    ledger.hubCall(lin.sessionId, "graph.done", { nodeKey: "base", commit: "111aaaa" });

    // 已 done 的节点禁止通过 patch 删除
    expect(() =>
      ledger.hubCall(lin.sessionId, "graph.patch", {
        graphId: graph.id,
        specJson: JSON.stringify({ removeNodes: ["base"] }),
      }),
    ).toThrow();

    // 跳过 opt-branch：只依赖 opt-branch 的 opt-leaf 级联标为 skipped；同时依赖 base(done) 与 opt-branch(skipped) 的 join-release 解锁为 ready！
    const afterSkip = ledger.skipTaskNode(graph.id, "opt-branch", { reason: "本期不做实验分支" }).graph;
    expect(afterSkip.nodes.find((n) => n.key === "opt-branch")?.status).toBe("skipped");
    expect(afterSkip.nodes.find((n) => n.key === "opt-leaf")?.status).toBe("skipped");
    expect(afterSkip.nodes.find((n) => n.key === "join-release")?.status).toBe("ready");

    // 完成最后一个节点 join-release -> 整张图自动变为 completed，撤出 activeTaskGraphs，进入历史分页
    const completed = ledger.hubCall(lin.sessionId, "graph.done", {
      graphId: graph.id,
      nodeKey: "join-release",
      prUrl: "https://github.com/org/repo/pull/200",
    }).data.graph;
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBe(now);
    expect(ledger.snapshot().activeTaskGraphs).toEqual([]);

    const history = ledger.listProjectTaskGraphs(lin.projectId);
    expect(history.graphs).toHaveLength(1);
    expect(history.graphs[0]?.id).toBe(graph.id);
    expect(history.hasMore).toBe(false);
  });

  it("PM 会话自动/手动换代（handover）时，sessionPreamble 实时注入未完结的任务图状态，且 hub status 包含活跃任务图摘要", () => {
    const graph = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({
        title: "跨代长任务",
        nodes: [
          { key: "db-mig", title: "迁移 0023" },
          { key: "api-impl", title: "实现接口", deps: ["db-mig"] },
        ],
      }),
    }).data.graph;
    ledger.hubCall(lin.sessionId, "graph.done", { nodeKey: "db-mig", commit: "deadbeef" });

    const statusRes = ledger.hubCall(lin.sessionId, "status", {});
    expect(statusRes.text).toContain("跨代长任务");
    expect(statusRes.text).toContain("api-impl");

    // 触发 PM 会话手动换代（写交接并切到第 2 代会话）
    const { handoverId } = ledger.renewSession(lin.pmId);
    const job = ledger.claimHandover()!;
    expect(job.handoverId).toBe(handoverId);
    ledger.handoverForked(handoverId, { kind: "native", ref: { forker: "claude", handle: { forkId: "fork-1" } } });
    ledger.handoverWritten(handoverId, { text: "已完成迁移 0023，下一步实现接口。", usage: { ...EMPTY_TOKEN_USAGE } });

    const gen2 = db.get<{ id: number }>(
      "SELECT id FROM agent_sessions WHERE conversation_id = ? AND generation = 2",
      lin.conversationId,
    )!;
    const preamble = ledger.sessionPreamble(gen2.id)!;
    expect(preamble).toContain("## 未完结的任务图（账本实时状态）");
    expect(preamble).toContain(`#${graph.id}`);
    expect(preamble).toContain("跨代长任务");
    expect(preamble).toContain("[done] db-mig");
    expect(preamble).toContain("[ready] api-impl");
  });
});
