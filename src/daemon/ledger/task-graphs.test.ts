import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Change } from "../../shared/api.ts";
import { pendingDecisionsOf } from "../../shared/decisions.ts";
import { askOf, EMPTY_TOKEN_USAGE, type ConversationId, type PmId, type ProjectId, type SessionId } from "../../shared/domain.ts";
import { MAX_ACTIVE_GRAPHS_PER_PROJECT, PM_ARCHIVE_RETENTION_MS } from "../../shared/limits.ts";
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
      specJson: JSON.stringify({ addNodes: [{ key: "old", title: "旧步骤" }, { key: "a", title: "A" }, { key: "b", title: "B", deps: ["a"] }] }),
    });
    const patched = ledger.hubCall(lin.sessionId, "graph.patch", { graphId: created.id, specJson: TASK_GRAPH_PATCH_JSON_HINT }).data.graph;
    expect(patched.nodes.map((n) => n.key).toSorted()).toEqual(["a", "b", "ok", "plan", "qa"]);
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

  it("Worker --node 绑定、异常置 attention、100K --incomplete 接力重绑不断链、正常收工解锁下游", () => {
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

    // 即使 w1 汇报了“做完了”，若因 100K 上下文换人传了 --incomplete，节点必须进入 attention 而绝不能误解锁 step-2！
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
