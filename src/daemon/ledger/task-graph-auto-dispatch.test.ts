// 编排简化第 5a 步端到端账本测试（docs/orchestration-simplify-design.md 第 4.1～4.6、6、9.3、9.4、13 节）：
// - 两步单线图（impl -> review）自动开工、汇报“做完了”自动收工、同线续同一个 worktree 与分支、PM 中途 0 次被叫醒、末步发交付单；
// - 三路/四路并行探索再汇总（a, b, c -> sum）多路交棒拼装与 12,000 字上限截断落盘 launch/<sessionId>/upstream/<stepKey>.md；
// - 汇报填写“偏离”自动踩刹车停在 waiting:pm 叫醒 PM；“做完了”但“问题”非无时交棒照走并抄送 PM；
// - 分叉步骤 addWorktree 指定 base 为上游分支、base: "main" 从主干开、跳过中间步骤向上追溯最近未跳过上游交棒与目录；
// - 自动拉起时厂商不可用置为 waiting:pm 叫醒 PM，PM 调 worker start --node 换人自动复用任务与交棒并写回新 vendor/model/effort；
// - hub graph cancel / 网页取消自动停掉所有在跑 Worker；hub worker end 仅作停机不再标步骤 done。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyActionRow } from "../../shared/actions.ts";
import { isTaskGraphReadyToFinish, type ConversationId, type PmId, type SessionId, type TaskNode, type WorkerId } from "../../shared/domain.ts";
import { HANDOFF_NOTE_MAX_CHARS, HANDOFF_TOTAL_MAX_CHARS } from "../../shared/limits.ts";
import { removeSessionLaunchDir, sessionLaunchDir, workerSetupLogPath } from "../../shared/paths.ts";
import { buildReadonlyPolicy } from "../../shared/readonly-policy.ts";
import { bundledModelCatalog, type AgentVendor, type ModelCatalog, type VendorAvailability } from "../../shared/vendors.ts";
import { REPORT_END, REPORT_START } from "../../shared/worker.ts";
import { scopeAllowsWrite, workerWriteScope } from "../../shared/write-scope.ts";
import { addWorktree } from "../git/index.ts";
import { createWorktreeCreateHandler } from "../handlers.ts";
import { createSessionStore, migrate, type Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger, type SqliteLedger } from "./index.ts";
import { STEP_REVIEW_CHECKLIST } from "./task-graph-handoff.ts";

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
  const lines = [
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
  ];
  return lines.join("\n");
}

describe("编排简化第 5a 步：自动开工、同线续目录、多路交棒落盘、偏离刹车与取消停机", () => {
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
  let availabilityByVendor: Partial<Record<AgentVendor, VendorAvailability>>;
  let lin: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };
  let setupRuns: WorkerId[];

  beforeEach(() => {
    now = 1_710_000_000_000;
    enqueued = [];
    availabilityByVendor = {};
    setupRuns = [];
    root = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-s5a-")));
    dataHome = join(root, "data");
    pmHomeRoot = join(dataHome, "pm-home");
    worktreesDir = join(dataHome, "worktrees");
    launchDir = join(dataHome, "state", "launch");
    setupLogsDir = join(dataHome, "state", "logs", "setup");
    repoDir = join(root, "repo");
    mkdirSync(pmHomeRoot, { recursive: true });
    mkdirSync(worktreesDir, { recursive: true });
    mkdirSync(launchDir, { recursive: true });
    mkdirSync(setupLogsDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });

    git(repoDir, "init", "-b", "main");
    writeFileSync(join(repoDir, "README.md"), "# repo\n");
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
        availability: availabilityByVendor[vendor] ?? "available",
      }),
      resolveFolder: createResolveFolder({ dataHome, userHome: root }),
    });
    ledger.onActionEnqueued((a) => enqueued.push(a));

    const created = ledger.createPm({ name: "林经理", mode: "manage_only", persona: "严谨", folder: repoDir });
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
          setupRuns.push(req.workerId);
          req.onDone({
            kind: "ok",
            command: req.command,
            exitCode: 0,
            signal: null,
            error: null,
            timeoutMs: 60_000,
            durationMs: 120,
            tail: "done",
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
    db.get<{ id: number; conversation_id: number; vendor: string; model: string | null; effort: string | null; cwd: string }>(
      "SELECT id, conversation_id, vendor, model, effort, cwd FROM agent_sessions WHERE worker_id = ? ORDER BY generation DESC LIMIT 1",
      workerId,
    )!;

  const firstWorkerMessageOf = (workerId: WorkerId) => {
    const s = workerSessionOf(workerId);
    return db.get<{ id: number; text: string }>(
      "SELECT id, text FROM messages WHERE conversation_id = ? ORDER BY id ASC LIMIT 1",
      s.conversation_id,
    )!;
  };

  const runWorkerReportTurn = (workerId: WorkerId, replyText: string, opts?: { keepProcessAlive?: boolean }) => {
    const s = workerSessionOf(workerId);
    const inputMsg = db.get<{ id: number }>(
      "SELECT id FROM messages WHERE conversation_id = ? AND sender IN ('pm', 'user') ORDER BY id DESC LIMIT 1",
      s.conversation_id,
    )!;
    const store = createSessionStore(db);
    store.update(s.id, { status: "running", pid: 40_000 + workerId });
    ledger.applyDriverEvent(s.id, { type: "message.delivered", messageIds: [inputMsg.id], at: ++now });
    ledger.applyDriverEvent(s.id, { type: "message.processing", messageIds: [inputMsg.id], at: ++now });
    ledger.applyDriverEvent(s.id, { type: "agent.text", uuid: `u-${workerId}-${++now}`, text: replyText, at: now });
    ledger.applyDriverEvent(s.id, {
      type: "turn.ended",
      ok: true,
      interrupted: false,
      messageIds: [inputMsg.id],
      durationMs: 25,
      at: ++now,
    });
    if (!opts?.keepProcessAlive) {
      store.update(s.id, { status: "ended", pid: null });
    }
  };

  const pmSendActions = () =>
    enqueued.filter(
      (a): a is Extract<AnyActionRow, { type: "session.send" }> =>
        a.type === "session.send" && a.params.sessionId === lin.sessionId,
    );

  it("单线两步图（impl -> review）：建图即开工、同线接手同一个 worktree 与分支（不重跑 setup、等上游退出才启动）、内置审查清单、Worker hub status，且 PM 中途 0 次被叫醒直到交付单", async () => {
    ledger.hubCall(lin.sessionId, "project.setup", { command: "echo setup-ok" });
    enqueued.length = 0;

    const createRes = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({
        title: "修复时间流翻页乱序",
        goal: "修复总助时间流翻页游标乱序，补回归测试并通过独立审查。",
        steps: [
          {
            key: "impl",
            title: "实现并提 PR",
            brief: "修好翻页游标比较逻辑并提 PR。",
            maxTime: "45m",
          },
          {
            // 未写 deps：steps 默认串接在 impl 后面
            key: "review",
            title: "独立审查并直接修",
            brief: "重点核查游标边界与空页退化。",
            review: true,
            vendor: "codex",
            model: "gpt-5",
            effort: "high",
          },
        ],
      }),
    });

    const g0 = createRes.data.graph;
    expect(g0.goal).toBe("修复总助时间流翻页游标乱序，补回归测试并通过独立审查。");
    expect(g0.edges).toEqual([{ fromKey: "impl", toKey: "review" }]);
    expect(g0.nodes.map((n) => [n.key, stateOf(n)])).toEqual([
      ["impl", "running"],
      ["review", "pending"],
    ]);
    // 全量快照瘦身：不带 goal 和 brief 正文
    const snapGraph = ledger.snapshot().activeTaskGraphs[0]!;
    expect(snapGraph.goal).toBeUndefined();
    expect(snapGraph.nodes[0]!.brief).toBeUndefined();

    const w1Id = g0.nodes[0]!.activeWorkerId!;
    expect(w1Id).toBeTypeOf("number");
    expect(pmSendActions()).toHaveLength(0);

    // 建出真实 git worktree 并跑一次 setup
    await runWorktreeCreate(w1Id);
    expect(setupRuns).toEqual([w1Id]);
    const w1Row = db.get<{ worktree_path: string; branch: string; task: string }>(
      "SELECT worktree_path, branch, task FROM workers WHERE id = ?",
      w1Id,
    )!;
    expect(w1Row.task).toContain("## 目标（整张图共用，每一步看到的都一样）");
    expect(w1Row.task).toContain("## 你这一步：实现并提 PR（第 1/2 步）");
    expect(firstWorkerMessageOf(w1Id).text).toContain("【系统 · 开工】");

    // 在 w1 的 worktree 提交代码，并留一个未提交的现场文件
    writeFileSync(join(w1Row.worktree_path, "cursor.ts"), "export const fix = 1;\n");
    git(w1Row.worktree_path, "add", "cursor.ts");
    git(w1Row.worktree_path, "commit", "-m", "fix cursor");
    const commit1 = git(w1Row.worktree_path, "rev-parse", "--short", "HEAD");
    writeFileSync(join(w1Row.worktree_path, "scratch.log"), "local repro notes\n");

    // 第 1 步汇报“做完了”（先保持 w1 进程还未退 pid != null，验证 w2 等待锁）
    enqueued.length = 0;
    runWorkerReportTurn(
      w1Id,
      `已完成实现。\n\n${buildReportBlock({
        status: "做完了",
        summary: "修好翻页游标并补了单测",
        commit: commit1,
        pr: "https://github.com/maodesikeng-boop/agent-hub/pull/315",
        tests: "pnpm vitest run router.test.ts 全绿",
        deviation: "无",
        handoff: "改动在 cursor.ts，临时复现日志在 scratch.log，最担心相同时刻同 id 边界。",
        questions: "无",
      })}`,
      { keepProcessAlive: true },
    );

    // PM 中途 0 次被叫醒！
    expect(pmSendActions()).toHaveLength(0);

    const g1 = ledger.hubCall(lin.sessionId, "graph.show", { graphId: g0.id }).data.graph;
    expect(g1.nodes.map((n) => [n.key, stateOf(n)])).toEqual([
      ["impl", "done"],
      ["review", "running"],
    ]);
    expect(g1.nodes[0]!.artifact).toMatchObject({
      branch: w1Row.branch,
      commit: commit1,
      prUrl: "https://github.com/maodesikeng-boop/agent-hub/pull/315",
      summary: "修好翻页游标并补了单测",
    });
    expect(db.get<{ status: string }>("SELECT status FROM workers WHERE id = ?", w1Id)?.status).toBe("ended");

    const w2Id = g1.nodes[1]!.activeWorkerId!;
    const w2Row = db.get<{ worktree_path: string; branch: string; task: string }>(
      "SELECT worktree_path, branch, task FROM workers WHERE id = ?",
      w2Id,
    )!;
    // 接手同一个 worktreePath 与同一条分支，且绝不重新登记 worktree.create / 不重跑 setup
    expect(w2Row.worktree_path).toBe(w1Row.worktree_path);
    expect(w2Row.branch).toBe(w1Row.branch);
    expect(enqueued.filter((a) => a.type === "worktree.create")).toHaveLength(0);
    expect(setupRuns).toEqual([w1Id]);

    const w2Sess = workerSessionOf(w2Id);
    expect(w2Sess).toMatchObject({ vendor: "codex", model: "gpt-5", effort: "high", cwd: w1Row.worktree_path });

    // 沙箱可写目录自动包含接手的 worktree
    const scope = workerWriteScope({ role: "worker", dataDir: dataHome, cwd: w2Sess.cwd })!;
    expect(scope.writableDirs).toEqual([w1Row.worktree_path]);
    expect(scopeAllowsWrite(scope, join(w1Row.worktree_path, "cursor.ts"))).toBe(true);

    // 在上游会话彻底退出前，waitsForFirstTurn 挡住下游首轮避免双写；上游退出后立即放行
    const w2FirstMsg = firstWorkerMessageOf(w2Id);
    expect(ledger.waitsForFirstTurn(w2Sess.id, w2FirstMsg.id)).toBe(true);
    createSessionStore(db).update(workerSessionOf(w1Id).id, { status: "ended", pid: null });
    expect(ledger.waitsForFirstTurn(w2Sess.id, w2FirstMsg.id)).toBe(false);

    // 上游提交与未提交文件都在同一个目录里
    expect(readFileSync(join(w2Row.worktree_path, "scratch.log"), "utf8")).toBe("local repro notes\n");

    // 审查步骤自动前置第 9.3 节内置审查清单，第一条消息是原样转交的交棒包（不把 task 重复发第二遍）
    expect(w2Row.task).toContain(STEP_REVIEW_CHECKLIST);
    expect(w2Row.task).toContain("重点核查游标边界与空页退化。");
    expect(w2FirstMsg.text).toContain("【系统 · 交棒】");
    expect(w2FirstMsg.text).toContain("改动在 cursor.ts，临时复现日志在 scratch.log");
    expect(w2FirstMsg.text).toContain("PR：https://github.com/maodesikeng-boop/agent-hub/pull/315");
    expect(w2FirstMsg.text).toContain(`分支：${w1Row.branch}（你已经在这个工作目录和分支上）`);
    expect(w2FirstMsg.text).not.toContain(STEP_REVIEW_CHECKLIST);

    // Worker 角色调 hub status：返回 Worker 编号、图目标、本步职责、上游交棒摘要与工作目录
    const workerStatus = ledger.hubCall(w2Sess.id, "status", {});
    expect(workerStatus.text).toContain(`Worker #${w2Id}`);
    expect(workerStatus.text).toContain("修复总助时间流翻页游标乱序");
    expect(workerStatus.text).toContain("重点核查游标边界与空页退化");
    expect(workerStatus.text).toContain("修好翻页游标并补了单测");
    expect(workerStatus.text).toContain(w1Row.worktree_path);
    expect(workerStatus.data).toMatchObject({
      role: "worker",
      taskGraph: {
        id: g0.id,
        stepKey: "review",
        stepIndex: 2,
        totalSteps: 2,
        goal: "修复总助时间流翻页游标乱序，补回归测试并通过独立审查。",
        upstream: [
          expect.objectContaining({
            key: "impl",
            prUrl: "https://github.com/maodesikeng-boop/agent-hub/pull/315",
          }),
        ],
      },
    });

    // 图仍 active 且下游在用目录时，worktree 清理严格禁止回收
    expect(ledger.isWorkerCleanable(w1Id)).toBe(false);
    expect(ledger.isWorkerCleanable(w2Id)).toBe(false);

    // 第 2 步在同一分支补提交并汇报“做完了” -> 发交付单叫醒 PM（全程唯一次叫醒 PM）
    writeFileSync(join(w2Row.worktree_path, "cursor.ts"), "export const fix = 2;\n");
    git(w2Row.worktree_path, "add", "cursor.ts");
    git(w2Row.worktree_path, "commit", "-m", "review fix");
    const commit2 = git(w2Row.worktree_path, "rev-parse", "--short", "HEAD");

    enqueued.length = 0;
    runWorkerReportTurn(
      w2Id,
      buildReportBlock({
        status: "做完了",
        summary: "可以合，顺手修了同 id 排序稳定性",
        commit: commit2,
        tests: "pnpm vitest run 全绿",
        deviation: "无",
        handoff: "核查并通过 cursor.ts:1，补了同 id 断言。",
        questions: "无",
      }),
    );

    const g2 = ledger.hubCall(lin.sessionId, "graph.show", { graphId: g0.id }).data.graph;
    expect(isTaskGraphReadyToFinish(g2)).toBe(true);
    expect(db.get<{ status: string }>("SELECT status FROM workers WHERE id = ?", w2Id)?.status).toBe("ended");

    // PM 此时才收到唯一 1 条交付单消息
    const pmSends = pmSendActions();
    expect(pmSends).toHaveLength(1);
    const deliveryMsg = ledger.getMessage(pmSends[0]!.params.messageId)!;
    expect(deliveryMsg.text).toContain("全部步骤做完，等你交付");
    expect(deliveryMsg.text).toContain("https://github.com/maodesikeng-boop/agent-hub/pull/315");
    expect(deliveryMsg.text).toContain("核查并通过 cursor.ts:1，补了同 id 断言。");

    // 图尚未 finish 前仍受保护不可清理；finish 后允许清理
    expect(ledger.isWorkerCleanable(w1Id)).toBe(false);
    ledger.hubCall(lin.sessionId, "graph.finish", { graphId: g0.id, summary: "PR #315 已合并" });
    expect(ledger.isWorkerCleanable(w1Id)).toBe(true);
  });

  it("三路与四路并行探索再汇总（a, b, c -> sum）：多路交棒拼装、12,000 字总上限均分截断并落盘 launch/<sessionId>/upstream/<stepKey>.md，沙箱可读且随启动目录清理", async () => {
    // 1) 三路并行 a, b, c -> sum：每路写 5,000 字（超单路 4,000 上限，三路共 15,000 超 12,000 总上限）
    const g3 = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({
        title: "三路探索汇总",
        goal: "对比三种索引结构并给出汇总方案。",
        steps: [
          { key: "a", title: "探索 BTree", brief: "测 BTree", readonly: true, deps: [] },
          { key: "b", title: "探索 LSM", brief: "测 LSM", readonly: true, deps: [] },
          { key: "c", title: "探索 Hash", brief: "测 Hash", readonly: true, deps: [] },
          { key: "sum", title: "汇总结论", brief: "整合三路报告", readonly: true, deps: ["a", "b", "c"] },
        ],
      }),
    }).data.graph;

    expect(g3.nodes.map((n) => [n.key, stateOf(n)])).toEqual([
      ["a", "running"],
      ["b", "running"],
      ["c", "running"],
      ["sum", "pending"],
    ]);
    for (const k of ["a", "b", "c"]) {
      const wid = g3.nodes.find((n) => n.key === k)!.activeWorkerId!;
      await runWorktreeCreate(wid);
    }
    enqueued.length = 0;

    for (const [idx, k] of (["a", "b", "c"] as const).entries()) {
      const wid = g3.nodes.find((n) => n.key === k)!.activeWorkerId!;
      const longHandoff = `${k.toUpperCase()}-结论-` + "详".repeat(5_000);
      runWorkerReportTurn(
        wid,
        buildReportBlock({
          status: "做完了",
          summary: `${k} 探索完成`,
          handoff: longHandoff,
        }),
      );
      const snap = ledger.hubCall(lin.sessionId, "graph.show", { graphId: g3.id }).data.graph;
      if (idx < 2) {
        expect(stateOf(snap.nodes.find((n) => n.key === "sum")!)).toBe("pending");
      } else {
        expect(stateOf(snap.nodes.find((n) => n.key === "sum")!)).toBe("running");
      }
    }
    expect(pmSendActions()).toHaveLength(0);

    const g3After = ledger.hubCall(lin.sessionId, "graph.show", { graphId: g3.id }).data.graph;
    const sumWid = g3After.nodes.find((n) => n.key === "sum")!.activeWorkerId!;
    const sumSess = workerSessionOf(sumWid);
    const sumMsg = firstWorkerMessageOf(sumWid).text;

    expect(sumMsg).toContain("【系统 · 交棒】");
    expect(sumMsg).toContain("「探索 BTree」（a");
    expect(sumMsg).toContain("「探索 LSM」（b");
    expect(sumMsg).toContain("「探索 Hash」（c");
    // 三路合计“详”字被严格限制在 12,000 字以内（每路 <= 4,000 字）
    const xiangCount = [...sumMsg.matchAll(/详/g)].length;
    expect(xiangCount).toBeLessThanOrEqual(HANDOFF_TOTAL_MAX_CHARS);
    expect(xiangCount).toBeGreaterThan(HANDOFF_TOTAL_MAX_CHARS - 100);

    // 完整未截断汇报已落盘到 launch/<sessionId>/upstream/<stepKey>.md
    const readonlyPolicy = buildReadonlyPolicy({ homeDir: root, stateDir: join(dataHome, "state") });
    const sumScope = workerWriteScope({ role: "worker", dataDir: dataHome, cwd: sumSess.cwd })!;
    for (const k of ["a", "b", "c"]) {
      const expectedFile = join(sessionLaunchDir(launchDir, sumSess.id), "upstream", `${k}.md`);
      expect(sumMsg).toContain(`完整汇报：${expectedFile}`);
      expect(existsSync(expectedFile)).toBe(true);
      const diskContent = readFileSync(expectedFile, "utf8");
      expect([...diskContent.matchAll(/详/g)].length).toBe(5_000);
      // 确认只读沙箱不禁读该路径，且写沙箱禁止篡改 state/launch/
      expect(readonlyPolicy.secretPaths.some((sec) => expectedFile.startsWith(sec))).toBe(false);
      expect(scopeAllowsWrite(sumScope, expectedFile)).toBe(false);
    }

    // Worker 调 hub status 也能拿到全部三路 reportFile
    const sumStatus = ledger.hubCall(sumSess.id, "status", {});
    expect(sumStatus.data).toMatchObject({
      role: "worker",
      taskGraph: {
        stepKey: "sum",
        upstream: [
          expect.objectContaining({ key: "a", reportFile: join(sessionLaunchDir(launchDir, sumSess.id), "upstream", "a.md") }),
          expect.objectContaining({ key: "b", reportFile: join(sessionLaunchDir(launchDir, sumSess.id), "upstream", "b.md") }),
          expect.objectContaining({ key: "c", reportFile: join(sessionLaunchDir(launchDir, sumSess.id), "upstream", "c.md") }),
        ],
      },
    });

    // 启动目录清理时 upstream/ 随会话启动目录一并删除
    removeSessionLaunchDir(launchDir, sumSess.id);
    expect(existsSync(join(sessionLaunchDir(launchDir, sumSess.id), "upstream"))).toBe(false);

    // 2) 四路并行 d1..d4 -> merge：每路 3,600 字（单路未超 HANDOFF_NOTE_MAX_CHARS=4000，但 4 路合计 14,400 超 12,000 -> 每路均分 3,000 字截断落盘）
    const g4 = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({
        title: "四路均分截断",
        steps: [
          { key: "d1", title: "方向 1", brief: "探 1", deps: [] },
          { key: "d2", title: "方向 2", brief: "探 2", deps: [] },
          { key: "d3", title: "方向 3", brief: "探 3", deps: [] },
          { key: "d4", title: "方向 4", brief: "探 4", deps: [] },
          { key: "merge", title: "四路汇总", brief: "汇总", deps: ["d1", "d2", "d3", "d4"] },
        ],
      }),
    }).data.graph;
    for (const k of ["d1", "d2", "d3", "d4"]) {
      const wid = g4.nodes.find((n) => n.key === k)!.activeWorkerId!;
      await runWorktreeCreate(wid);
      runWorkerReportTurn(
        wid,
        buildReportBlock({
          status: "做完了",
          summary: `${k} 完成`,
          handoff: "均".repeat(3_600),
        }),
      );
    }
    expect(HANDOFF_NOTE_MAX_CHARS).toBe(4_000);
    const mergeWid = ledger
      .hubCall(lin.sessionId, "graph.show", { graphId: g4.id })
      .data.graph.nodes.find((n) => n.key === "merge")!.activeWorkerId!;
    const mergeMsg = firstWorkerMessageOf(mergeWid).text;
    const junCount = [...mergeMsg.matchAll(/均/g)].length;
    expect(junCount).toBeLessThanOrEqual(HANDOFF_TOTAL_MAX_CHARS);
    expect(junCount).toBeGreaterThan(HANDOFF_TOTAL_MAX_CHARS - 20);
    for (const k of ["d1", "d2", "d3", "d4"]) {
      expect(existsSync(join(sessionLaunchDir(launchDir, workerSessionOf(mergeWid).id), "upstream", `${k}.md`))).toBe(true);
    }
  });

  it("偏离踩刹车与放行补充、做完了留问题抄送 PM、自动拉起厂商不可用回退 waiting:pm 与换人写回模型", async () => {
    availabilityByVendor.cursor = "signed_out";
    const graph = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({
        title: "迁移与审查",
        goal: "平滑迁移配置表。",
        steps: [
          { key: "impl", title: "实现迁移", brief: "迁移旧表" },
          { key: "mid", title: "核对数据", brief: "校验行数" },
          { key: "rev", title: "异构审查", brief: "独立审查", vendor: "cursor", review: true },
        ],
      }),
    }).data.graph;

    const wImpl = graph.nodes[0]!.activeWorkerId!;
    await runWorktreeCreate(wImpl);
    enqueued.length = 0;

    // 1) 汇报“做完了”但填写了“偏离” -> 踩刹车停在 waiting:pm，Worker 不收工，按第 9.4 节格式叫醒 PM
    runWorkerReportTurn(
      wImpl,
      buildReportBlock({
        status: "做完了",
        summary: "改用新建映射表实现",
        pr: "https://github.com/org/repo/pull/401",
        deviation: "旧表被外键锁死无法原地删除，改为保留旧表视图兼容",
        handoff: "映射逻辑在 compat.ts",
      }),
      { keepProcessAlive: true },
    );

    let cur = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).data.graph;
    expect(stateOf(cur.nodes[0]!)).toBe("waiting:pm");
    expect(cur.nodes[0]!.activeWorkerId).toBe(wImpl);
    expect(cur.nodes[0]!.artifact?.prUrl).toBe("https://github.com/org/repo/pull/401");
    expect(db.get<{ status: string }>("SELECT status FROM workers WHERE id = ?", wImpl)?.status).toBe("open");
    expect(stateOf(cur.nodes[1]!)).toBe("pending");

    expect(pmSendActions()).toHaveLength(1);
    const brakeMsg = ledger.getMessage(pmSendActions()[0]!.params.messageId)!.text;
    expect(brakeMsg).toContain(`【任务图 #${graph.id}「迁移与审查」第 1/3 步「实现迁移」等你处理】Worker #${wImpl}：报告偏离`);
    expect(brakeMsg).toContain("旧表被外键锁死无法原地删除");
    expect(brakeMsg).toContain(`hub worker send ${wImpl} --stdin`);
    expect(brakeMsg).toContain("hub graph done impl");

    // PM 认可偏离，用 hub graph done impl --stdin 放行并附补充说明 -> mid 自动开工并收到放行补充！
    enqueued.length = 0;
    createSessionStore(db).update(workerSessionOf(wImpl).id, { status: "ended", pid: null });
    ledger.hubCall(lin.sessionId, "graph.done", {
      graphId: graph.id,
      nodeKey: "impl",
      note: "认可保留兼容视图，核对步骤请额外查一下视图查询计划。",
    });
    cur = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).data.graph;
    expect(stateOf(cur.nodes[0]!)).toBe("done");
    expect(stateOf(cur.nodes[1]!)).toBe("running");
    const wMid = cur.nodes[1]!.activeWorkerId!;
    expect(firstWorkerMessageOf(wMid).text).toContain("映射逻辑在 compat.ts");
    expect(firstWorkerMessageOf(wMid).text).toContain("认可保留兼容视图，核对步骤请额外查一下视图查询计划。");

    // 2) mid 汇报“做完了”、无偏离，但“问题”栏有话；且下游 rev 指定的 cursor 未登录不可用：
    //    - mid 照常标 done 并收工，且其汇报抄送唤醒 PM；
    //    - 下游 rev 自动拉起失败置为 waiting:pm 并唤醒 PM 说明原因！
    enqueued.length = 0;
    runWorkerReportTurn(
      wMid,
      buildReportBlock({
        status: "做完了",
        summary: "行数与视图查询计划核对无误",
        deviation: "无",
        handoff: "校验脚本在 verify.sql",
        questions: "建议在后续版本移除历史兼容视图，需用户拍板窗口期",
      }),
    );
    cur = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).data.graph;
    expect(stateOf(cur.nodes[1]!)).toBe("done");
    expect(stateOf(cur.nodes[2]!)).toBe("waiting:pm");
    // 两条唤醒 PM 的消息：1 条是 mid 留问题的汇报抄送，1 条是 rev 自动开工失败通知
    expect(pmSendActions()).toHaveLength(2);
    const pmTexts = pmSendActions().map((a) => ledger.getMessage(a.params.messageId)!.text);
    expect(pmTexts.some((t) => t.includes("建议在后续版本移除历史兼容视图"))).toBe(true);
    expect(pmTexts.some((t) => t.includes("第 3/3 步「异构审查」等你处理】自动开工未成功"))).toBe(true);

    // 3) PM 用 hub worker start --node rev --vendor codex --model gpt-5 --effort medium 换一家：
    //    无需重传 title 和 task，自动继承职责、审查清单、上游交棒与同一个 worktree，且新的 vendor/model/effort 写回步骤！
    const replaced = ledger.hubCall(lin.sessionId, "worker.start", {
      node: "rev",
      graphId: graph.id,
      vendor: "codex",
      model: "gpt-5",
      effort: "medium",
    }).data.worker;
    cur = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).data.graph;
    expect(cur.nodes[2]).toMatchObject({
      status: "running",
      activeWorkerId: replaced.id,
      vendor: "codex",
      model: "gpt-5",
      effort: "medium",
    });
    expect(replaced.worktreePath).toBe(
      db.get<{ worktree_path: string }>("SELECT worktree_path FROM workers WHERE id = ?", wImpl)!.worktree_path,
    );
    expect(firstWorkerMessageOf(replaced.id).text).toContain("校验脚本在 verify.sql");
  });

  it("分叉指定 base 为上游分支、base: main 从主干新开、跳过中间步骤追溯上游交棒与目录、取消整张图自动停在跑 Worker、校验与 patch 守卫", async () => {
    // 1) 建图与改图参数立即校验：非法厂商 / 模型 / maxTime 当场报错
    expect(() =>
      ledger.hubCall(lin.sessionId, "graph.create", {
        specJson: JSON.stringify({ title: "坏厂商", steps: [{ key: "s1", title: "步", brief: "做", vendor: "bogus" }] }),
      }),
    ).toThrow();
    expect(() =>
      ledger.hubCall(lin.sessionId, "graph.create", {
        specJson: JSON.stringify({ title: "坏时长", steps: [{ key: "s1", title: "步", brief: "做", maxTime: "abc" }] }),
      }),
    ).toThrow(/maxTime/);

    // 2) 分叉与 base: "main"：root -> [fork1, fork2, fresh(base: "main")]
    const forkGraph = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({
        title: "分叉实验",
        steps: [
          { key: "root", title: "公共底座", brief: "写 base.txt", deps: [] },
          { key: "fork1", title: "分支一", brief: "方案 1", deps: ["root"] },
          { key: "fork2", title: "分支二", brief: "方案 2", deps: ["root"] },
          { key: "fresh", title: "主干对照", brief: "从主干开", deps: ["root"], base: "main" },
        ],
      }),
    }).data.graph;

    const wRoot = forkGraph.nodes[0]!.activeWorkerId!;
    await runWorktreeCreate(wRoot);
    const rootWt = db.get<{ worktree_path: string; branch: string }>(
      "SELECT worktree_path, branch FROM workers WHERE id = ?",
      wRoot,
    )!;
    writeFileSync(join(rootWt.worktree_path, "from-root.txt"), "root base content\n");
    git(rootWt.worktree_path, "add", "from-root.txt");
    git(rootWt.worktree_path, "commit", "-m", "add from-root");
    runWorkerReportTurn(wRoot, buildReportBlock({ status: "做完了", summary: "底座就绪", handoff: "见 from-root.txt" }));

    const afterRoot = ledger.hubCall(lin.sessionId, "graph.show", { graphId: forkGraph.id }).data.graph;
    const wFork1 = afterRoot.nodes.find((n) => n.key === "fork1")!.activeWorkerId!;
    const wFork2 = afterRoot.nodes.find((n) => n.key === "fork2")!.activeWorkerId!;
    const wFresh = afterRoot.nodes.find((n) => n.key === "fresh")!.activeWorkerId!;
    expect(ledger.getWorktreeTask(wFork1)?.base).toBe(rootWt.branch);
    expect(ledger.getWorktreeTask(wFork2)?.base).toBe(rootWt.branch);
    expect(ledger.getWorktreeTask(wFresh)?.base).toBeUndefined();

    await runWorktreeCreate(wFork1);
    await runWorktreeCreate(wFork2);
    await runWorktreeCreate(wFresh);
    const fork1Path = db.get<{ worktree_path: string }>("SELECT worktree_path FROM workers WHERE id = ?", wFork1)!.worktree_path;
    const fork2Path = db.get<{ worktree_path: string }>("SELECT worktree_path FROM workers WHERE id = ?", wFork2)!.worktree_path;
    const freshPath = db.get<{ worktree_path: string }>("SELECT worktree_path FROM workers WHERE id = ?", wFresh)!.worktree_path;
    expect(fork1Path).not.toBe(rootWt.worktree_path);
    expect(fork1Path).not.toBe(fork2Path);
    // 分叉出来的两个 worktree 都继承了上游分支的提交，而 base: "main" 从主干开没有该文件
    expect(existsSync(join(fork1Path, "from-root.txt"))).toBe(true);
    expect(existsSync(join(fork2Path, "from-root.txt"))).toBe(true);
    expect(existsSync(join(freshPath, "from-root.txt"))).toBe(false);

    // updateSteps 禁止修改 running 或 done 的步骤
    expect(() =>
      ledger.hubCall(lin.sessionId, "graph.patch", {
        graphId: forkGraph.id,
        specJson: JSON.stringify({ updateSteps: [{ key: "root", title: "改已完成" }] }),
      }),
    ).toThrow(/不允许通过 patch 修改/);
    expect(() =>
      ledger.hubCall(lin.sessionId, "graph.patch", {
        graphId: forkGraph.id,
        specJson: JSON.stringify({ updateSteps: [{ key: "fork1", brief: "改正在跑的" }] }),
      }),
    ).toThrow(/不允许通过 patch 修改/);

    // 3) 网页取消整张图自动停掉所有在跑的 Worker（fork1, fork2, fresh）
    for (const wid of [wFork1, wFork2, wFresh]) {
      createSessionStore(db).update(workerSessionOf(wid).id, { status: "running", pid: 50_000 + wid });
    }
    ledger.cancelTaskGraph(forkGraph.id, { reason: "方向调整" });
    for (const wid of [wFork1, wFork2, wFresh]) {
      expect(db.get<{ status: string }>("SELECT status FROM workers WHERE id = ?", wid)?.status).toBe("ended");
      expect(
        enqueued.some((a) => a.type === "session.end" && a.params.sessionId === workerSessionOf(wid).id),
      ).toBe(true);
    }

    // 4) 跳过中间步骤追溯最近未跳过上游交棒并延续单线目录：s1 -> s2 (手动跳过) -> s3
    const skipChain = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({
        title: "跳过穿透链",
        steps: [
          { key: "s1", title: "写实现", brief: "实现 s1" },
          { key: "s2", title: "可选人工卡点" },
          { key: "s3", title: "收尾验证", brief: "验证 s1 产物" },
        ],
      }),
    }).data.graph;
    const ws1 = skipChain.nodes[0]!.activeWorkerId!;
    await runWorktreeCreate(ws1);
    const ws1Path = db.get<{ worktree_path: string }>("SELECT worktree_path FROM workers WHERE id = ?", ws1)!.worktree_path;
    runWorkerReportTurn(ws1, buildReportBlock({ status: "做完了", summary: "s1 已就绪", handoff: "s1 关键交棒线索在 mod.ts" }));

    // s2 无 brief 停在 waiting:pm，PM 执行 hub graph skip s2 --reason "小改动免卡点" -> s3 自动开工并接手 ws1 目录和交棒！
    ledger.hubCall(lin.sessionId, "graph.skip", { graphId: skipChain.id, nodeKey: "s2", reason: "小改动免卡点" });
    const afterSkip = ledger.hubCall(lin.sessionId, "graph.show", { graphId: skipChain.id }).data.graph;
    expect(stateOf(afterSkip.nodes[2]!)).toBe("running");
    const ws3 = afterSkip.nodes[2]!.activeWorkerId!;
    expect(db.get<{ worktree_path: string }>("SELECT worktree_path FROM workers WHERE id = ?", ws3)!.worktree_path).toBe(ws1Path);
    const s3First = firstWorkerMessageOf(ws3).text;
    expect(s3First).toContain("小改动免卡点");
    expect(s3First).toContain("s1 关键交棒线索在 mod.ts");
  });
});
