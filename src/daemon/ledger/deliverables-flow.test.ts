// 交付物从哪来、挂到哪（docs/deliverables-design.md）：Worker 汇报 → 步骤 → 检查点卡 → 总助；hub ask / router report 的 --file。
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { splitLead } from "../../shared/card-text.ts";
import { pendingDecisionsOf } from "../../shared/decisions.ts";
import { deliverablesOf, type Deliverable } from "../../shared/deliverables.ts";
import { CONFIRM_REJECT_OPTION, askOf, type ConversationId, type MessageId, type PmId, type SessionId, type TaskGraph, type WorkerId } from "../../shared/domain.ts";
import { DELIVERABLES_PER_REPORT_MAX, HUB_FILE_ARGS_MAX } from "../../shared/limits.ts";
import type { RouterItem } from "../../shared/router.ts";
import { sentFilesOf } from "../../shared/sent-files.ts";
import { bundledModelCatalog, type ModelCatalog } from "../../shared/vendors.ts";
import { REPORT_END, REPORT_START } from "../../shared/worker.ts";
import { createSessionStore, migrate, type Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger, type SqliteLedger } from "./index.ts";

function reportText(files: string, summary = "做好了"): string {
  return [
    REPORT_START,
    "状态: 做完了",
    `摘要: ${summary}`,
    "提交: abc1234",
    "PR: 无",
    "测试: pnpm test 通过",
    "偏离: 无",
    "交棒: 无",
    `文件: ${files}`,
    "问题: 无",
    REPORT_END,
  ].join("\n");
}

describe("交付物", () => {
  let db: Db;
  let root: string;
  let dataHome: string;
  let folder: string;
  let outside: string;
  let now: number;
  let ledger: SqliteLedger;
  let lin: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };

  beforeEach(() => {
    now = 1_720_000_000_000;
    root = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-deliverables-")));
    dataHome = join(root, "data");
    folder = join(root, "proj");
    outside = join(root, "outside");
    for (const d of [dataHome, folder, outside, join(folder, "docs")]) mkdirSync(d, { recursive: true });
    for (const name of ["docs/plan.md", "verdict.md", "desktop.png", "mobile.png", "rec.mp4", "a b (1).md"]) {
      writeFileSync(join(folder, name), `内容 ${name}`);
    }
    writeFileSync(join(outside, "secret.md"), "不能分享");
    db = openTestDb();
    migrate(db);
    ledger = createLedger(db, {
      now: () => now,
      pmHomeRoot: join(dataHome, "pm-home"),
      dataHome,
      userHome: root,
      shareTmpDirs: [],
      osSandboxed: () => true,
      modelCatalog: (vendor): ModelCatalog => ({ ...bundledModelCatalog(vendor), availability: "available" }),
      resolveFolder: createResolveFolder({ dataHome, userHome: root }),
    });
    const created = ledger.createPm({ name: "林经理", mode: "manage_only", persona: "", folder });
    lin = { pmId: created.pm.id, conversationId: created.conversation.id, sessionId: created.sessionId };
  });

  afterEach(() => {
    ledger.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const path = (name: string) => join(folder, name);
  const sentCopies = () => readdirSync(join(dataHome, "sent-files")).filter((n) => !n.startsWith(".")).length;

  const workerSessionOf = (workerId: WorkerId) =>
    db.get<{ id: number; conversation_id: number }>(
      "SELECT id, conversation_id FROM agent_sessions WHERE worker_id = ? ORDER BY generation DESC LIMIT 1",
      workerId,
    )!;

  /** Worker 跑完一轮，最后一段文字是 reply。 */
  const runWorkerTurn = (workerId: WorkerId, reply: string) => {
    const s = workerSessionOf(workerId);
    const input = db.get<{ id: number }>(
      "SELECT id FROM messages WHERE conversation_id = ? AND sender IN ('pm', 'user') ORDER BY id DESC LIMIT 1",
      s.conversation_id,
    )!;
    const store = createSessionStore(db);
    store.update(s.id, { status: "running", pid: 50_000 + workerId });
    ledger.applyDriverEvent(s.id, { type: "message.delivered", messageIds: [input.id], at: ++now });
    ledger.applyDriverEvent(s.id, { type: "message.processing", messageIds: [input.id], at: ++now });
    ledger.applyDriverEvent(s.id, { type: "agent.text", uuid: `u-${workerId}-${++now}`, text: reply, at: now });
    ledger.applyDriverEvent(s.id, { type: "turn.ended", ok: true, interrupted: false, messageIds: [input.id], durationMs: 20, at: ++now });
    store.update(s.id, { status: "ended", pid: null });
  };

  const createGraph = (steps: object[]): TaskGraph =>
    ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({ title: "交付物", goal: "方案和验收证据做成能点开的文件", steps: steps.map((s) => ({ brief: "照目标做", ...s })) }),
    }).data.graph;

  const graphShow = (graphId: number): TaskGraph => ledger.hubCall(lin.sessionId, "graph.show", { graphId }).data.graph;
  const snapshotGraph = (graphId: number): TaskGraph => ledger.snapshot().activeTaskGraphs.find((g) => g.id === graphId)!;
  const messageById = (id: MessageId) => ledger.getMessage(id);
  const labels = (list: readonly Deliverable[] | undefined) => (list ?? []).map((d) => d.label);
  const routerItems = (): RouterItem[] => ledger.snapshot().router.items;

  const planFiles = () =>
    `\n- [方案](${path("docs/plan.md")})\n- [桌面截图](${path("desktop.png")})\n- [录屏](${path("rec.mp4")})`;

  describe("Worker 汇报的“文件”栏", () => {
    it("汇报“文件”栏里的本机文件存成副本，记进该步 artifact.deliverables", () => {
      const graph = createGraph([{ key: "plan", title: "方案" }, { key: "impl", title: "实现", deps: ["plan"] }]);
      const w = graph.nodes.find((n) => n.key === "plan")!.activeWorkerId!;
      runWorkerTurn(w, reportText(planFiles()));
      const node = graphShow(graph.id).nodes.find((n) => n.key === "plan")!;
      const list = node.artifact?.deliverables ?? [];
      expect(labels(list)).toEqual(["方案", "桌面截图", "录屏"]);
      expect(list.map((d) => d.mime)).toEqual(["text/markdown", "image/png", "video/mp4"]);
      for (const d of list) {
        expect(d.id).toMatch(/^[0-9a-f]{16}$/);
        expect(d.origin).not.toBeNull();
      }
    });

    it("再交一次汇报时，该步交付物换成新汇报的（文件栏为空时保留上一次的）", () => {
      const graph = createGraph([{ key: "plan", title: "方案", confirm: true }]);
      const w = graph.nodes[0]!.activeWorkerId!;
      runWorkerTurn(w, reportText(planFiles()));
      // 打回让它改，再交一次只带方案和验收结论
      const askId = graphShow(graph.id).nodes[0]!.gateAskMessageId!;
      expect(askId).not.toBeNull();
      ledger.decideTaskNode(graph.id, "plan", { clientId: "reject-1", choice: CONFIRM_REJECT_OPTION, note: "再改改" });
      runWorkerTurn(w, reportText(`[方案](${path("docs/plan.md")}) [验收结论](${path("verdict.md")})`));
      expect(labels(graphShow(graph.id).nodes[0]!.artifact?.deliverables)).toEqual(["方案", "验收结论"]);
      ledger.decideTaskNode(graph.id, "plan", { clientId: "reject-2", choice: CONFIRM_REJECT_OPTION, note: "还要改" });
      runWorkerTurn(w, reportText("无"));
      expect(labels(graphShow(graph.id).nodes[0]!.artifact?.deliverables)).toEqual(["方案", "验收结论"]);
    });

    it("confirm 步骤的检查点卡带上该步交付物（AskMeta.deliverables），不再拷一次副本", () => {
      const graph = createGraph([{ key: "plan", title: "方案", confirm: true }]);
      const w = graph.nodes[0]!.activeWorkerId!;
      runWorkerTurn(w, reportText(planFiles()));
      const copies = sentCopies();
      const node = graphShow(graph.id).nodes[0]!;
      const ask = askOf(messageById(node.gateAskMessageId!)!);
      expect(labels(ask?.deliverables)).toEqual(["方案", "桌面截图", "录屏"]);
      expect(sentCopies()).toBe(copies);
      // 总助拍板卡：门禁步骤取该步交付物
      const decision = pendingDecisionsOf(ledger.snapshot())[0]!;
      expect(decision.source.kind).toBe("gate");
      expect(labels(decision.deliverables)).toEqual(["方案", "桌面截图", "录屏"]);
    });

    it("检查点卡正文的第一段是整段摘要，交棒、提交排在后面（卡片里摘要后面紧跟文件，其余收起）", () => {
      const graph = createGraph([{ key: "plan", title: "方案", confirm: true }]);
      const w = graph.nodes[0]!.activeWorkerId!;
      runWorkerTurn(w, reportText(planFiles(), "方案好了。\n\n截图在文件里").replace("交棒: 无", "交棒: 改了卡片顺序"));
      const { lead, details } = splitLead(graphShow(graph.id).nodes[0]!.gateSummaryMd!);
      expect(lead).toBe("**摘要**：方案好了。\n截图在文件里");
      expect(details).toContain("改了卡片顺序");
      expect(details).toContain("abc1234");
    });
  });

  describe("hub ask --file", () => {
    it("独立提问：副本写进 AskMeta.deliverables 和 meta.files，同一事务写进 router_items.deliverables_json", () => {
      const r = ledger.hubCall(lin.sessionId, "ask", {
        text: "方案好了，请验收",
        options: ["通过", "打回"],
        files: [
          { label: "方案", path: path("docs/plan.md") },
          { label: null, path: path("a b (1).md") },
        ],
      });
      const message = messageById(r.data.messageId)!;
      const ask = askOf(message)!;
      expect(labels(ask.deliverables)).toEqual(["方案", "a b (1).md"]);
      expect(ask.deliverables!.map((d) => d.origin)).toEqual([
        { messageId: message.id, index: 0 },
        { messageId: message.id, index: 1 },
      ]);
      expect(sentFilesOf(message).map((f) => [f.status, f.id])).toEqual(ask.deliverables!.map((d) => ["saved", d.id]));
      const item = routerItems().find((i) => i.kind === "decision")!;
      expect(item.kind === "decision" && labels(item.deliverables)).toEqual(["方案", "a b (1).md"]);
      const decision = pendingDecisionsOf(ledger.snapshot())[0]!;
      expect(labels(decision.deliverables)).toEqual(["方案", "a b (1).md"]);
    });

    it("带 --node：同时合进该步 artifact.deliverables", () => {
      const graph = createGraph([{ key: "plan", title: "方案" }, { key: "impl", title: "实现", deps: ["plan"] }]);
      const w = graph.nodes.find((n) => n.key === "plan")!.activeWorkerId!;
      runWorkerTurn(w, reportText(`[方案](${path("docs/plan.md")})`).replace("状态: 做完了", "状态: 有问题"));
      ledger.hubCall(lin.sessionId, "ask", {
        text: "截图对吗？",
        node: "plan",
        options: ["对", "不对"],
        files: [{ label: "桌面截图", path: path("desktop.png") }],
      });
      const node = graphShow(graph.id).nodes.find((n) => n.key === "plan")!;
      expect(labels(node.artifact?.deliverables)).toEqual(["桌面截图", "方案"]);
      expect(labels(askOf(messageById(node.gateAskMessageId!)!)?.deliverables)).toEqual(["桌面截图", "方案"]);
    });

    it("不在可分享的文件夹里的路径：拒绝并说明原因，卡片不挂出来", () => {
      const secret = join(outside, "secret.md");
      expect(() =>
        ledger.hubCall(lin.sessionId, "ask", { text: "看看", files: [{ label: "方案", path: path("docs/plan.md") }, { label: null, path: secret }] }),
      ).toThrow(`--file ${secret}：不在可分享的文件夹里`);
      expect(() => ledger.hubCall(lin.sessionId, "ask", { text: "看看", files: [{ label: null, path: path("nope.md") }] })).toThrow("没找到文件");
      expect(routerItems().filter((i) => i.kind === "decision")).toEqual([]);
      expect(db.get<{ n: number }>("SELECT count(*) AS n FROM messages WHERE json_extract(meta, '$.needsUser') = 1")!.n).toBe(0);
    });

    it("超过 HUB_FILE_ARGS_MAX 个时拒绝", () => {
      const files = Array.from({ length: HUB_FILE_ARGS_MAX + 1 }, () => ({ label: null, path: path("verdict.md") }));
      expect(() => ledger.hubCall(lin.sessionId, "ask", { text: "看看", files })).toThrow(`最多 ${HUB_FILE_ARGS_MAX} 个`);
    });
  });

  describe("hub router report", () => {
    it("--file 存成副本，进 deliverables，不再进 links", () => {
      const r = ledger.hubCall(lin.sessionId, "router.report", {
        summary: "做完了",
        links: [{ label: "PR #1", target: "https://github.com/o/r/pull/1" }],
        files: [{ label: "验收结论", path: path("verdict.md") }, { label: "录屏", path: path("rec.mp4") }],
      });
      const item = r.data.item;
      expect(item.kind).toBe("report");
      if (item.kind !== "report") return;
      expect(item.links).toEqual([{ label: "PR #1", target: "https://github.com/o/r/pull/1" }]);
      expect(labels(item.deliverables)).toEqual(["验收结论", "录屏"]);
      expect(item.deliverables!.every((d) => d.origin === null)).toBe(true);
      const fromSnapshot = routerItems().find((i) => i.id === item.id);
      expect(fromSnapshot?.kind === "report" && labels(fromSnapshot.deliverables)).toEqual(["验收结论", "录屏"]);
      const fromPage = ledger.listRouterItems(undefined, undefined, "report").items.find((i) => i.id === item.id);
      expect(fromPage?.kind === "report" && labels(fromPage.deliverables)).toEqual(["验收结论", "录屏"]);
    });

    it("--link 的地址是本机路径时拒绝，提示改用 --file", () => {
      expect(() =>
        ledger.hubCall(lin.sessionId, "router.report", { summary: "做完了", links: [{ label: "方案", target: "/tmp/plan-standard.md" }] }),
      ).toThrow("--file");
      expect(() =>
        ledger.hubCall(lin.sessionId, "router.report", { summary: "做完了", links: [{ label: "方案", target: "docs/plan.md" }] }),
      ).toThrow("--file");
      expect(routerItems().filter((i) => i.kind === "report")).toEqual([]);
    });
  });

  describe("hub graph finish", () => {
    it("投给总助的简报带整张图的交付物（graphDeliverables），最多 DELIVERABLES_PER_REPORT_MAX 个", () => {
      const graph = createGraph([{ key: "plan", title: "方案" }, { key: "impl", title: "实现", deps: ["plan"] }]);
      runWorkerTurn(graph.nodes.find((n) => n.key === "plan")!.activeWorkerId!, reportText(`[方案](${path("docs/plan.md")})`));
      const impl = graphShow(graph.id).nodes.find((n) => n.key === "impl")!;
      runWorkerTurn(impl.activeWorkerId!, reportText(`[验收结论](${path("verdict.md")}) [录屏](${path("rec.mp4")}) [方案](${path("docs/plan.md")})`));
      const r = ledger.hubCall(lin.sessionId, "graph.finish", { graphId: graph.id, summary: "交付物做完了", unmergedOk: true });
      expect(r.text).toBeTruthy();
      const report = routerItems().find((i) => i.kind === "report");
      expect(report?.kind === "report" && labels(report.deliverables)).toEqual(["方案", "验收结论", "录屏"]);
      expect(report?.kind === "report" && report.deliverables!.length).toBeLessThanOrEqual(DELIVERABLES_PER_REPORT_MAX);
    });
  });

  describe("快照体积", () => {
    it("全量快照里只有等用户拍板的步骤带 artifact.deliverables，单图详情都带", () => {
      const graph = createGraph([
        { key: "plan", title: "方案" },
        { key: "verify", title: "验收", confirm: true, deps: ["plan"] },
      ]);
      runWorkerTurn(graph.nodes.find((n) => n.key === "plan")!.activeWorkerId!, reportText(`[方案](${path("docs/plan.md")})`));
      const verify = graphShow(graph.id).nodes.find((n) => n.key === "verify")!;
      runWorkerTurn(verify.activeWorkerId!, reportText(`[验收结论](${path("verdict.md")})`));
      const slim = snapshotGraph(graph.id);
      expect(slim.nodes.find((n) => n.key === "plan")!.artifact?.deliverables).toBeUndefined();
      expect(slim.nodes.find((n) => n.key === "plan")!.artifact?.summary).toBe("做好了");
      expect(labels(slim.nodes.find((n) => n.key === "verify")!.artifact?.deliverables)).toEqual(["验收结论"]);
      const full = graphShow(graph.id);
      expect(labels(full.nodes.find((n) => n.key === "plan")!.artifact?.deliverables)).toEqual(["方案"]);
      expect(deliverablesOf(full.nodes.find((n) => n.key === "verify")!.artifact?.deliverables)).toHaveLength(1);
    });
  });
});
