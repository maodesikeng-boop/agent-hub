// 编排简化第 6 步（收官步）全链路测试：
// 1) 统一 hub ask [--node <步骤>] [--graph <图编号>] [--option ...] [--recommended ...]：三处可见（对话、右栏快照、总助待拍板流）；
// 2) 用户点选拍板卡（或 PM 调 hub graph decide 记口头答复）：挂着未收工 Worker 时定案直送该 Worker 会话接着干，步骤切回 running，全程不叫醒 PM，闲聊不误冲卡片；
// 3) confirm: true 用户检查点：汇报“做完了”且无偏离时自动挂出「通过 / 打回」检查点卡（不标 done、不收工、不叫醒 PM）-> 点「打回」带意见直送原 Worker 接着改 -> 再做完再出卡 -> 点「通过」自动收工并带意见交棒下游（末步则发交付单唤醒 PM）；
// 4) 非 confirm 步骤“做完了但留了话”：自动收工推进下游照走，同时把汇报抄送叫醒 PM，PM 将卡挂在下游步骤上后答案直送下游 Worker。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyActionRow } from "../../shared/actions.ts";
import { pendingDecisionsOf } from "../../shared/decisions.ts";
import {
  CONFIRM_PASS_OPTION,
  CONFIRM_REJECT_OPTION,
  askOf,
  extractAskCard,
  isTaskGraphReadyToFinish,
  type ConversationId,
  type PmId,
  type SessionId,
  type TaskNode,
  type WorkerId,
} from "../../shared/domain.ts";
import { workerSetupLogPath } from "../../shared/paths.ts";
import { bundledModelCatalog, type ModelCatalog } from "../../shared/vendors.ts";
import { REPORT_END, REPORT_START } from "../../shared/worker.ts";
import { addWorktree } from "../git/index.ts";
import { createWorktreeCreateHandler } from "../handlers.ts";
import { createSessionStore, migrate, type Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger, type SqliteLedger } from "./index.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

const stateOf = (n: Pick<TaskNode, "status" | "waitingFor" | "skipped">): string => {
  if (n.status === "waiting") return `waiting:${n.waitingFor}`;
  return n.status === "done" && n.skipped ? "skipped" : n.status;
};

function buildReportBlock(fields: {
  status: "做完了" | "有问题" | "放弃了";
  summary: string;
  commit?: string;
  pr?: string;
  tests?: string;
  deviation?: string;
  handoff?: string;
  questions?: string;
}): string {
  return [
    REPORT_START,
    `状态: ${fields.status}`,
    `摘要: ${fields.summary}`,
    `提交: ${fields.commit ?? "无"}`,
    `PR: ${fields.pr ?? "无"}`,
    `测试: ${fields.tests ?? "pnpm test 通过"}`,
    `偏离: ${fields.deviation ?? "无"}`,
    ...(fields.handoff !== undefined ? [`交棒: ${fields.handoff}`] : []),
    `问题: ${fields.questions ?? "无"}`,
    REPORT_END,
  ].join("\n");
}

describe("编排简化第 6 步：hub ask --node、confirm 检查点与答案直送 Worker", () => {
  let db: Db;
  let root: string;
  let dataHome: string;
  let pmHomeRoot: string;
  let worktreesDir: string;
  let launchDir: string;
  let setupLogsDir: string;
  let repoDir: string;
  let now: number;
  let ledger: SqliteLedger;
  let enqueued: AnyActionRow[];
  let lin: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };

  beforeEach(() => {
    now = 1_720_000_000_000;
    enqueued = [];
    root = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-s6-")));
    dataHome = join(root, "data");
    pmHomeRoot = join(dataHome, "pm-home");
    worktreesDir = join(dataHome, "worktrees");
    launchDir = join(dataHome, "state", "launch");
    setupLogsDir = join(dataHome, "state", "logs", "setup");
    repoDir = join(root, "repo");
    for (const d of [pmHomeRoot, worktreesDir, launchDir, setupLogsDir, repoDir]) {
      mkdirSync(d, { recursive: true });
    }

    git(repoDir, "init", "-b", "main");
    writeFileSync(join(repoDir, "README.md"), "# s6\n");
    git(repoDir, "add", "README.md");
    git(repoDir, "commit", "-m", "initial commit");

    db = openTestDb();
    migrate(db);
    ledger = createLedger(db, {
      now: () => now,
      pmHomeRoot,
      dataHome,
      worktreesDir,
      launchDir,
      setupLogsDir,
      userHome: root,
      osSandboxed: () => true,
      modelCatalog: (vendor): ModelCatalog => ({
        ...bundledModelCatalog(vendor),
        availability: "available",
      }),
      resolveFolder: createResolveFolder({ dataHome, userHome: root }),
    });
    ledger.onActionEnqueued((a) => enqueued.push(a));

    const created = ledger.createPm({ name: "林经理", mode: "manage_only", persona: "", folder: repoDir });
    lin = {
      pmId: created.pm.id,
      conversationId: created.conversation.id,
      sessionId: created.sessionId,
    };
    enqueued.length = 0;
  });

  afterEach(() => {
    ledger.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const runWorktreeCreate = async (workerId: WorkerId) => {
    const handler = createWorktreeCreateHandler({
      ledger,
      addWorktree,
      setup: {
        start: (req) => {
          req.onDone({
            kind: "ok",
            command: req.command,
            exitCode: 0,
            signal: null,
            error: null,
            timeoutMs: 60_000,
            durationMs: 50,
            tail: "ok",
            logPath: req.logPath,
            logError: null,
          });
          return true;
        },
      },
      setupLogPath: (id) => workerSetupLogPath(setupLogsDir, id),
    });
    await handler({
      id: ++now,
      type: "worktree.create",
      dedupeKey: String(workerId),
      params: { workerId },
      status: "running",
      attempts: 1,
      nextAttemptAt: now,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
  };

  const workerSessionOf = (workerId: WorkerId) =>
    db.get<{ id: number; conversation_id: number; cwd: string }>(
      "SELECT id, conversation_id, cwd FROM agent_sessions WHERE worker_id = ? ORDER BY generation DESC LIMIT 1",
      workerId,
    )!;

  const latestWorkerInputOf = (workerId: WorkerId) => {
    const s = workerSessionOf(workerId);
    return db.get<{ id: number; sender: string; text: string }>(
      "SELECT id, sender, text FROM messages WHERE conversation_id = ? AND sender IN ('pm', 'user') ORDER BY id DESC LIMIT 1",
      s.conversation_id,
    )!;
  };

  const firstWorkerMessageOf = (workerId: WorkerId) => {
    const s = workerSessionOf(workerId);
    return db.get<{ id: number; text: string }>(
      "SELECT id, text FROM messages WHERE conversation_id = ? ORDER BY id ASC LIMIT 1",
      s.conversation_id,
    )!;
  };

  const runWorkerReportTurn = (workerId: WorkerId, replyText: string) => {
    const s = workerSessionOf(workerId);
    const inputMsg = latestWorkerInputOf(workerId);
    const store = createSessionStore(db);
    store.update(s.id, { status: "running", pid: 50_000 + workerId });
    ledger.applyDriverEvent(s.id, { type: "message.delivered", messageIds: [inputMsg.id], at: ++now });
    ledger.applyDriverEvent(s.id, { type: "message.processing", messageIds: [inputMsg.id], at: ++now });
    ledger.applyDriverEvent(s.id, { type: "agent.text", uuid: `u-${workerId}-${++now}`, text: replyText, at: now });
    ledger.applyDriverEvent(s.id, {
      type: "turn.ended",
      ok: true,
      interrupted: false,
      messageIds: [inputMsg.id],
      durationMs: 20,
      at: ++now,
    });
    store.update(s.id, { status: "ended", pid: null });
  };

  const pmSendActions = () =>
    enqueued.filter(
      (a): a is Extract<AnyActionRow, { type: "session.send" }> =>
        a.type === "session.send" && a.params.sessionId === lin.sessionId,
    );

  it("hub ask --node 三处可见、闲聊不误关卡片、用户点选定案直送活跃 Worker（全程不叫醒 PM），且定案记入 graph show 与交付单", async () => {
    const graph = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({
        title: "导出接口改造",
        goal: "实现高性能 CSV 导出接口并通过独立审查。",
        steps: [
          { key: "impl", title: "实现导出", brief: "完成 CSV 导出接口" },
          { key: "review", title: "独立审查", brief: "重点核查流背压", review: true, vendor: "codex" },
        ],
      }),
    }).data.graph;

    const wImpl = graph.nodes[0]!.activeWorkerId!;
    await runWorktreeCreate(wImpl);
    enqueued.length = 0;

    // 1. Worker 报“有问题”停在 waiting:pm，唤醒 PM 一次
    runWorkerReportTurn(
      wImpl,
      buildReportBlock({
        status: "有问题",
        summary: "导出方式待产品拍板",
        questions: "超过 5 万行时走同步流式下载还是后台异步任务？推荐同步流式下载。",
      }),
    );
    expect(pmSendActions()).toHaveLength(1);
    expect(stateOf(ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).data.graph.nodes[0]!)).toBe(
      "waiting:pm",
    );

    // 2. PM 调 hub ask --node impl 挂拍板卡，同时发一张普通独立 hub ask 测试边界
    enqueued.length = 0;
    const stepAsk = ledger.hubCall(lin.sessionId, "ask", {
      node: "impl",
      options: ["同步流式下载", "后台异步导出"],
      recommended: "同步流式下载",
      text: "超过 5 万行时导出怎么走？\n\n压测下同步流 2 秒内可回包，无需新增任务队列。",
    }).data;
    const casualAskId = ledger.hubCall(lin.sessionId, "ask", {
      options: ["UTF-8", "UTF-8 with BOM"],
      recommended: "2",
      text: "顺便确认默认编码？",
    }).data.messageId;

    // 三处可见核对：① 对话消息流 AskCard，② 右栏快照 activeTaskGraphs，③ 总助待拍板流 pendingDecisionsOf + Digest
    const stepAskMsg = ledger.getMessage(stepAsk.messageId)!;
    expect(extractAskCard(stepAskMsg)).toEqual({
      question: "超过 5 万行时导出怎么走？\n\n压测下同步流 2 秒内可回包，无需新增任务队列。",
      options: ["同步流式下载", "后台异步导出"],
      recommended: "同步流式下载",
      answered: false,
      gateRef: { graphId: graph.id, nodeKey: "impl" },
    });

    const snap = ledger.snapshot();
    const snapImpl = snap.activeTaskGraphs[0]!.nodes.find((n) => n.key === "impl")!;
    expect(stateOf(snapImpl)).toBe("waiting:user");
    expect(snapImpl.activeWorkerId).toBe(wImpl);
    expect(snapImpl.gateRecommended).toBe("同步流式下载");

    const pending = pendingDecisionsOf(snap, "local");
    expect(pending).toHaveLength(2);
    expect(pending.find((d) => d.source.kind === "gate")).toMatchObject({
      question: "超过 5 万行时导出怎么走？",
      context: "压测下同步流 2 秒内可回包，无需新增任务队列。",
      options: ["同步流式下载", "后台异步导出"],
      source: { kind: "gate", graphId: graph.id, nodeKey: "impl", recommended: "同步流式下载" },
    });
    expect(pending.find((d) => d.source.kind === "router_item")).toMatchObject({
      question: "顺便确认默认编码？",
      source: { kind: "router_item", recommended: "UTF-8 with BOM" },
    });
    expect(ledger.getRouterDigest().pms.find((p) => p.pmId === lin.pmId)?.pendingDecisionCount).toBe(2);

    // 3. 用户在对话输入框直接打字回复普通提问：普通提问收起，但绑定了 --node 的步骤卡绝不被误关、闲聊绝不灌给 Worker
    const workerMsgCountBeforeChat = db.get<{ n: number }>(
      "SELECT count(*) AS n FROM messages WHERE conversation_id = ?",
      workerSessionOf(wImpl).conversation_id,
    )!.n;
    ledger.postUserMessage({
      conversationId: lin.conversationId,
      clientId: "casual-chat-1",
      text: "编码用 UTF-8 with BOM，导出方式我点上面的卡片定",
    });
    expect(askOf(ledger.getMessage(casualAskId)!)?.answered).toBe(true);
    expect(askOf(ledger.getMessage(stepAsk.messageId)!)?.answered).toBeUndefined();
    expect(
      db.get<{ n: number }>("SELECT count(*) AS n FROM messages WHERE conversation_id = ?", workerSessionOf(wImpl).conversation_id)!.n,
    ).toBe(workerMsgCountBeforeChat);

    // 4. 用户点选步骤拍板卡并附补充意见：定案直送 Worker #wImpl，步骤切回 running，全程不叫醒 PM！
    enqueued.length = 0;
    const decided = ledger.decideTaskNode(graph.id, "impl", {
      clientId: "user-decide-impl-1",
      choice: "同步流式下载",
      note: "加上 30s 超时与断流清理",
    });
    expect(decided.messageId).toBeNull();
    expect(pmSendActions()).toEqual([]);
    expect(askOf(ledger.getMessage(stepAsk.messageId)!)).toMatchObject({
      answered: true,
      chosenOption: "同步流式下载",
    });
    expect(pendingDecisionsOf(ledger.snapshot(), "local")).toEqual([]);

    const implAfterDecide = decided.graph.nodes.find((n) => n.key === "impl")!;
    expect(stateOf(implAfterDecide)).toBe("running");
    expect(implAfterDecide.activeWorkerId).toBe(wImpl);
    expect(implAfterDecide.decision).toMatchObject({
      choice: "同步流式下载",
      note: "加上 30s 超时与断流清理",
      decidedBy: "user",
    });

    const deliveredToWorker = latestWorkerInputOf(wImpl);
    expect(deliveredToWorker.sender).toBe("pm");
    expect(deliveredToWorker.text).toBe(
      "【用户拍板】超过 5 万行时导出怎么走？\n定案：同步流式下载\n补充说明：加上 30s 超时与断流清理",
    );
    expect(
      enqueued.some(
        (a) =>
          a.type === "session.send" &&
          a.params.sessionId === workerSessionOf(wImpl).id &&
          a.params.messageId === deliveredToWorker.id,
      ),
    ).toBe(true);

    // 网络重试相同 clientId（此时步骤已是 running）严格幂等，不重复给 Worker 发消息
    enqueued.length = 0;
    const replay = ledger.decideTaskNode(graph.id, "impl", {
      clientId: "user-decide-impl-1",
      choice: "同步流式下载",
      note: "加上 30s 超时与断流清理",
    });
    expect(replay.messageId).toBeNull();
    expect(enqueued).toEqual([]);

    // hub graph show 可见该步定案
    const showText = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).text;
    expect(showText).toContain("定案：同步流式下载（加上 30s 超时与断流清理）");

    // 5. Worker #wImpl 收到定案后完成本步 -> 下游 review 自动开工并继承定案与交棒 -> review 完成发交付单（全程仅交付单叫醒 PM）
    enqueued.length = 0;
    runWorkerReportTurn(
      wImpl,
      buildReportBlock({
        status: "做完了",
        summary: "已完成同步流导出与 30s 超时清理",
        commit: "a1b2c3d",
        pr: "https://github.com/org/repo/pull/320",
        handoff: "实现位于 src/export.ts",
      }),
    );
    expect(pmSendActions()).toEqual([]);
    const wReview = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).data.graph.nodes[1]!.activeWorkerId!;
    expect(firstWorkerMessageOf(wReview).text).toContain("同步流式下载；补充说明：加上 30s 超时与断流清理");

    enqueued.length = 0;
    runWorkerReportTurn(
      wReview,
      buildReportBlock({
        status: "做完了",
        summary: "审查通过",
        commit: "a1b2c3d",
        pr: "https://github.com/org/repo/pull/320",
        handoff: "可直接合并",
      }),
    );
    expect(pmSendActions()).toHaveLength(1);
    const deliveryText = ledger.getMessage(pmSendActions()[0]!.params.messageId)!.text;
    expect(deliveryText).toContain("拍板：「超过 5 万行时导出怎么走？」定案 同步流式下载（加上 30s 超时与断流清理）");
  });

  it("confirm: true 用户检查点闭环：做完自动出卡（不收工、不叫醒 PM）-> 打回原 Worker 接着改 -> 再做完点通过自动收工并带意见交棒下游", async () => {
    const graph = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({
        title: "先看方案再实现",
        goal: "先产出架构方案给用户过目确认，通过后再实现。",
        steps: [
          { key: "design", title: "架构方案", brief: "编写 docs/plan.md 方案", confirm: true },
          { key: "impl", title: "代码实现", brief: "按确认后的方案编码并补测试" },
        ],
      }),
    }).data.graph;

    // patch 也支持 addSteps / updateSteps 修改 confirm
    const patched = ledger.hubCall(lin.sessionId, "graph.patch", {
      graphId: graph.id,
      specJson: JSON.stringify({
        addSteps: [{ key: "preview", title: "界面预览", brief: "出预览图", confirm: true, deps: ["impl"] }],
        updateSteps: [{ key: "impl", confirm: false }],
      }),
    }).data.graph;
    expect(patched.nodes.find((n) => n.key === "design")?.confirm).toBe(true);
    expect(patched.nodes.find((n) => n.key === "preview")?.confirm).toBe(true);

    const wDesign = graph.nodes[0]!.activeWorkerId!;
    await runWorktreeCreate(wDesign);
    const designWtPath = db.get<{ worktree_path: string }>("SELECT worktree_path FROM workers WHERE id = ?", wDesign)!.worktree_path;
    enqueued.length = 0;

    // 1. design 第一次汇报“做完了”且无偏离：不标 done、不收工 Worker，自动出「通过 / 打回」检查点卡，全程不叫醒 PM！
    runWorkerReportTurn(
      wDesign,
      buildReportBlock({
        status: "做完了",
        summary: "已完成方案初稿（缓存上限 1000）",
        commit: "1111111",
        handoff: "方案写在 docs/plan.md，采用内存 Map 缓存 1000 条。",
      }),
    );
    expect(pmSendActions()).toEqual([]);
    expect(db.get<{ status: string }>("SELECT status FROM workers WHERE id = ?", wDesign)?.status).toBe("open");
    expect(enqueued.filter((a) => a.type === "session.end")).toEqual([]);

    const snap1 = ledger.snapshot();
    const designWait1 = snap1.activeTaskGraphs[0]!.nodes.find((n) => n.key === "design")!;
    expect(stateOf(designWait1)).toBe("waiting:user");
    expect(designWait1.gateCheckpoint).toBe(true);
    expect(designWait1.gateOptions).toEqual([CONFIRM_PASS_OPTION, CONFIRM_REJECT_OPTION]);
    expect(designWait1.gateRecommended).toBe(CONFIRM_PASS_OPTION);
    expect(designWait1.gateSummaryMd).toContain("已完成方案初稿（缓存上限 1000）");
    expect(designWait1.gateSummaryMd).toContain("docs/plan.md");
    expect(designWait1.artifact).toEqual({
      branch: expect.any(String),
      commit: "1111111",
      summary: "已完成方案初稿（缓存上限 1000）",
    });

    const cardMsg1 = ledger.getMessage(designWait1.gateAskMessageId!)!;
    expect(extractAskCard(cardMsg1)).toMatchObject({
      options: [CONFIRM_PASS_OPTION, CONFIRM_REJECT_OPTION],
      recommended: CONFIRM_PASS_OPTION,
      answered: false,
      gateRef: { graphId: graph.id, nodeKey: "design", checkpoint: true },
    });
    const pending1 = pendingDecisionsOf(snap1, "local");
    expect(pending1).toHaveLength(1);
    expect(pending1[0]!.source).toMatchObject({
      kind: "gate",
      graphId: graph.id,
      nodeKey: "design",
      recommended: CONFIRM_PASS_OPTION,
      checkpoint: true,
    });

    // 2. 用户点「打回」并填写修改意见：步骤切回 running，修改意见直接发给原 Worker #wDesign 会话，不叫醒 PM！
    enqueued.length = 0;
    const rejected = ledger.decideTaskNode(graph.id, "design", {
      clientId: "chk-reject-1",
      choice: CONFIRM_REJECT_OPTION,
      note: "缓存上限改成 200 并改用 lru-cache，不要手写 Map 淘汰",
    });
    expect(rejected.messageId).toBeNull();
    expect(pmSendActions()).toEqual([]);
    expect(askOf(ledger.getMessage(cardMsg1.id)!)).toMatchObject({
      answered: true,
      chosenOption: CONFIRM_REJECT_OPTION,
    });
    expect(stateOf(rejected.graph.nodes.find((n) => n.key === "design")!)).toBe("running");
    expect(rejected.graph.nodes.find((n) => n.key === "design")?.gateCheckpoint).toBeUndefined();

    const rejectInput = latestWorkerInputOf(wDesign);
    expect(rejectInput.sender).toBe("pm");
    expect(rejectInput.text).toContain("【用户检查点打回】");
    expect(rejectInput.text).toContain("缓存上限改成 200 并改用 lru-cache，不要手写 Map 淘汰");

    // 重试同一 clientId 幂等
    enqueued.length = 0;
    expect(
      ledger.decideTaskNode(graph.id, "design", {
        clientId: "chk-reject-1",
        choice: CONFIRM_REJECT_OPTION,
        note: "缓存上限改成 200 并改用 lru-cache，不要手写 Map 淘汰",
      }).messageId,
    ).toBeNull();
    expect(enqueued).toEqual([]);

    // 3. 原 Worker #wDesign 在原会话改完再次汇报“做完了”：再次自动出检查点卡，仍不叫醒 PM！
    enqueued.length = 0;
    runWorkerReportTurn(
      wDesign,
      buildReportBlock({
        status: "做完了",
        summary: "已改用 lru-cache 且上限收紧为 200",
        commit: "2222222",
        handoff: "终版方案见 docs/plan.md 第 3 节（lru-cache max=200）。",
      }),
    );
    expect(pmSendActions()).toEqual([]);
    const snap2 = ledger.snapshot();
    const designWait2 = snap2.activeTaskGraphs[0]!.nodes.find((n) => n.key === "design")!;
    expect(stateOf(designWait2)).toBe("waiting:user");
    expect(designWait2.gateCheckpoint).toBe(true);
    expect(designWait2.gateAskMessageId).not.toBe(cardMsg1.id);
    expect(designWait2.gateSummaryMd).toContain("lru-cache max=200");

    // 4. 用户点「通过」并附带给下游的补充提醒：自动收工 wDesign（排在下游 session.send 之前），解锁 impl 自动开工并带上定案与意见，仍不叫醒 PM！
    enqueued.length = 0;
    const passed = ledger.decideTaskNode(graph.id, "design", {
      clientId: "chk-pass-2",
      choice: CONFIRM_PASS_OPTION,
      note: "方案通过，实现时把 200 写进 src/shared/limits.ts",
    });
    expect(passed.messageId).toBeNull();
    expect(pmSendActions()).toEqual([]);
    expect(db.get<{ status: string }>("SELECT status FROM workers WHERE id = ?", wDesign)?.status).toBe("ended");

    const designDone = passed.graph.nodes.find((n) => n.key === "design")!;
    const implRunning = passed.graph.nodes.find((n) => n.key === "impl")!;
    expect(stateOf(designDone)).toBe("done");
    expect(designDone.activeWorkerId).toBeNull();
    expect(designDone.gateCheckpoint).toBeUndefined();
    expect(designDone.decision).toMatchObject({
      choice: CONFIRM_PASS_OPTION,
      note: "方案通过，实现时把 200 写进 src/shared/limits.ts",
      decidedBy: "user",
    });
    expect(stateOf(implRunning)).toBe("running");
    const wImpl = implRunning.activeWorkerId!;

    // session.end(wDesign) 排在 session.send(wImpl) 之前，且同线复用同一个 worktree
    const endIdx = enqueued.findIndex((a) => a.type === "session.end" && a.params.sessionId === workerSessionOf(wDesign).id);
    const sendIdx = enqueued.findIndex((a) => a.type === "session.send" && a.params.sessionId === workerSessionOf(wImpl).id);
    expect(endIdx).toBeGreaterThanOrEqual(0);
    expect(sendIdx).toBeGreaterThan(endIdx);
    expect(db.get<{ worktree_path: string }>("SELECT worktree_path FROM workers WHERE id = ?", wImpl)?.worktree_path).toBe(
      designWtPath,
    );

    const implFirstText = firstWorkerMessageOf(wImpl).text;
    expect(implFirstText).toContain("终版方案见 docs/plan.md 第 3 节（lru-cache max=200）");
    expect(implFirstText).toContain("## 用户拍板");
    expect(implFirstText).toContain("定案：通过；补充说明：方案通过，实现时把 200 写进 src/shared/limits.ts");

    // 5. 若最后一步本身也是 confirm: true（preview）：点「通过」后全图完成，照常发出待交付交付单唤醒 PM 收尾！
    enqueued.length = 0;
    runWorkerReportTurn(wImpl, buildReportBlock({ status: "做完了", summary: "实现完成", commit: "3333333", handoff: "见 limits.ts" }));
    const wPreview = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).data.graph.nodes.find((n) => n.key === "preview")!
      .activeWorkerId!;
    enqueued.length = 0;
    runWorkerReportTurn(
      wPreview,
      buildReportBlock({ status: "做完了", summary: "预览图已出", commit: "4444444", handoff: "/tmp/preview.png" }),
    );
    expect(pmSendActions()).toEqual([]);

    enqueued.length = 0;
    const finalPass = ledger.decideTaskNode(graph.id, "preview", {
      clientId: "chk-pass-final",
      choice: CONFIRM_PASS_OPTION,
    });
    expect(isTaskGraphReadyToFinish(finalPass.graph)).toBe(true);
    expect(db.get<{ status: string }>("SELECT status FROM workers WHERE id = ?", wPreview)?.status).toBe("ended");
    expect(pmSendActions()).toHaveLength(1);
    expect(ledger.getMessage(pmSendActions()[0]!.params.messageId)!.text).toContain("全部步骤做完，等你交付");
  });

  it("confirm 步骤中途报“有问题”挂普通 hub ask --node 卡时，点选后恢复原 Worker 继续干，不误当检查点收工；PM 口头 hub graph decide 同样支持直送 Worker", async () => {
    const graph = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({
        title: "检查点中途提问",
        goal: "输出设计稿并由用户检查点验收。",
        steps: [{ key: "ui", title: "改按钮圆角", brief: "更新按钮样式", confirm: true }],
      }),
    }).data.graph;

    const wUi = graph.nodes[0]!.activeWorkerId!;
    await runWorktreeCreate(wUi);

    // Worker 中途遇到问题（还没做完！）
    runWorkerReportTurn(wUi, buildReportBlock({ status: "有问题", summary: "次级按钮是否一起改？", questions: "一起改还是只改主按钮？" }));
    ledger.hubCall(lin.sessionId, "ask", {
      node: "ui",
      options: ["一起改", "只改主按钮"],
      recommended: "一起改",
      text: "次级按钮圆角是否一起统一？",
    });
    expect(ledger.snapshot().activeTaskGraphs[0]!.nodes[0]!.gateCheckpoint).toBeUndefined();

    // 用户在聊天口头回复，PM 调 hub graph decide 记下：定案直送 wUi，步骤恢复 running（绝不提前标 done 或收工 wUi！）
    enqueued.length = 0;
    const decidedByPm = ledger.hubCall(lin.sessionId, "graph.decide", {
      graphId: graph.id,
      nodeKey: "ui",
      choice: "一起改",
      note: "全部按 rounded-full 统一",
    }).data.graph;
    expect(stateOf(decidedByPm.nodes[0]!)).toBe("running");
    expect(db.get<{ status: string }>("SELECT status FROM workers WHERE id = ?", wUi)?.status).toBe("open");
    expect(latestWorkerInputOf(wUi).text).toBe("【用户拍板】次级按钮圆角是否一起统一？\n定案：一起改\n补充说明：全部按 rounded-full 统一");

    // 随后 wUi 真正做完汇报“做完了”：这时才挂出「通过 / 打回」检查点卡！
    enqueued.length = 0;
    runWorkerReportTurn(wUi, buildReportBlock({ status: "做完了", summary: "主次按钮均已统一圆角", handoff: "见 button.tsx" }));
    expect(pmSendActions()).toEqual([]);
    const chkNode = ledger.snapshot().activeTaskGraphs[0]!.nodes[0]!;
    expect(chkNode.gateCheckpoint).toBe(true);
    expect(chkNode.gateOptions).toEqual([CONFIRM_PASS_OPTION, CONFIRM_REJECT_OPTION]);
  });

  it("非 confirm 步骤“做完了但留了话”（第 3.2 节第 4 行 & 第 5.1 节）：自动收工推进下游照走并抄送唤醒 PM，PM 把卡挂在在跑下游步骤上后答案直送下游 Worker", async () => {
    const graph = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({
        title: "实现留问题给下游审查拍板",
        goal: "修复提示词丢失并完成跨厂商审查。",
        steps: [
          { key: "impl", title: "修复实现", brief: "修好五家常驻通道" },
          { key: "review", title: "独立审查", brief: "全面审查并处理边界", review: true, vendor: "codex" },
        ],
      }),
    }).data.graph;

    const wImpl = graph.nodes[0]!.activeWorkerId!;
    await runWorktreeCreate(wImpl);
    enqueued.length = 0;

    // impl 汇报“做完了”、无偏离，但“问题”栏留了一个需用户拍板的边界问题：
    // impl 自动收工标 done、下游 review 立即自动开工，同时 impl 的汇报抄送叫醒 PM！
    runWorkerReportTurn(
      wImpl,
      buildReportBlock({
        status: "做完了",
        summary: "五家常驻通道已修好",
        commit: "777aaaa",
        handoff: "改动在 vendors/ 下",
        questions: "cursor 压缩后仍会丢首条提示词，这次顺手做兜底还是保持现状？",
      }),
    );
    expect(db.get<{ status: string }>("SELECT status FROM workers WHERE id = ?", wImpl)?.status).toBe("ended");
    expect(pmSendActions()).toHaveLength(1);

    const afterImpl = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).data.graph;
    expect(stateOf(afterImpl.nodes[0]!)).toBe("done");
    expect(stateOf(afterImpl.nodes[1]!)).toBe("running");
    const wReview = afterImpl.nodes[1]!.activeWorkerId!;

    // PM 被唤醒后把拍板卡挂在正在运行的下游 review 步骤上
    ledger.hubCall(lin.sessionId, "ask", {
      node: "review",
      options: ["cursor 先不动", "本轮顺手加兜底"],
      recommended: "cursor 先不动",
      text: "cursor 压缩丢提示词本轮是否处理？",
    });
    expect(stateOf(ledger.snapshot().activeTaskGraphs[0]!.nodes[1]!)).toBe("waiting:user");

    // 若 wReview 在用户点卡前先跑完当前轮汇报“做完了”，后台保留 waiting:user 卡片且不提前收工 wReview
    enqueued.length = 0;
    runWorkerReportTurn(
      wReview,
      buildReportBlock({ status: "做完了", summary: "初审完成，等用户对 cursor 范围拍板", commit: "777aaaa", handoff: "初审无阻塞" }),
    );
    expect(pmSendActions()).toEqual([]);
    expect(db.get<{ status: string }>("SELECT status FROM workers WHERE id = ?", wReview)?.status).toBe("open");
    expect(stateOf(ledger.snapshot().activeTaskGraphs[0]!.nodes[1]!)).toBe("waiting:user");

    // 用户点选“cursor 先不动”：定案直送 wReview，步骤切回 running，全程不叫醒 PM！
    enqueued.length = 0;
    ledger.decideTaskNode(graph.id, "review", {
      clientId: "decide-review-cursor",
      choice: "cursor 先不动",
    });
    expect(pmSendActions()).toEqual([]);
    expect(stateOf(ledger.snapshot().activeTaskGraphs[0]!.nodes[1]!)).toBe("running");
    expect(latestWorkerInputOf(wReview).text).toBe("【用户拍板】cursor 压缩丢提示词本轮是否处理？\n定案：cursor 先不动");
  });
});
