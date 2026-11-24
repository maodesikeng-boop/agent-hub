// 审查步骤只查不修的账本测试（docs/review-verify-only-design.md 第 3、7 节），用真 git 和一个本地 bare 远端：
// - 审查步骤拿到独立的 detached 审查目录，不挂分支，开审时记下被审分支；
// - 判 FAIL、没写结论、提交号对不上：停在 waiting:pm；
// - 判 PASS：先核对被审分支，没变才完成、下游照常开工；变了或核对没跑成：停在 waiting:pm；
// - 审查后面的修复步骤接手实现的 worktree 和分支；审查目录收工就能清理。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActionRow, AnyActionRow } from "../../shared/actions.ts";
import type { ConversationId, PmId, SessionId, TaskNode, WorkerId } from "../../shared/domain.ts";
import { workerSetupLogPath } from "../../shared/paths.ts";
import { pendingDecisionsOf } from "../../shared/decisions.ts";
import { askOf } from "../../shared/domain.ts";
import { REVIEW_CHECKLIST, parseReviewTarget } from "../../shared/review.ts";
import { REPORT_END, REPORT_START } from "../../shared/worker.ts";
import { addWorktree, remoteBranchHead, resolveCommit } from "../git/index.ts";
import { createReviewObserver, createReviewVerifyHandler, createWorktreeCreateHandler } from "../handlers.ts";
import { createSessionStore, migrate, type Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger, type SqliteLedger } from "./index.ts";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] }).trim();

const stateOf = (n: Pick<TaskNode, "status" | "waitingFor" | "skipped">): string =>
  n.status === "waiting" ? `waiting:${n.waitingFor}` : n.status === "done" && n.skipped ? "skipped" : n.status;

function report(fields: { status?: string; summary: string; verdict?: string; sha?: string; questions?: string; files?: string }): string {
  return [
    REPORT_START,
    `状态: ${fields.status ?? "做完了"}`,
    `摘要: ${fields.summary}`,
    ...(fields.verdict !== undefined ? [`结论: ${fields.verdict}`] : []),
    ...(fields.sha !== undefined ? [`验证提交: ${fields.sha}`] : []),
    "PR: 无",
    "提交: 无",
    "测试: pnpm test 通过",
    "偏离: 无",
    "交棒: 查了 a.ts:1",
    `文件: ${fields.files ?? "无"}`,
    `问题: ${fields.questions ?? "无"}`,
    REPORT_END,
  ].join("\n");
}

describe("审查步骤只查不修", () => {
  let db: Db;
  let root: string;
  let repoDir: string;
  let now: number;
  let ledger: SqliteLedger;
  let enqueued: AnyActionRow[];
  let lin: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };
  const observeReview = createReviewObserver({
    resolveCommit: (f, r) => resolveCommit(f, r),
    remoteBranchHead: (r, b) => remoteBranchHead(r, b),
    probePr: async () => null,
  });

  beforeEach(() => {
    now = 1_720_000_000_000;
    enqueued = [];
    root = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-review-")));
    const dataHome = join(root, "data");
    repoDir = join(root, "repo");
    for (const d of ["pm-home", "worktrees", "state/launch", "state/logs/setup"]) mkdirSync(join(dataHome, d), { recursive: true });
    mkdirSync(repoDir);
    git(root, "init", "--bare", "-b", "main", join(root, "origin.git"));
    git(repoDir, "init", "-b", "main");
    writeFileSync(join(repoDir, "a.ts"), "export const a = 1;\n");
    git(repoDir, "add", "a.ts");
    git(repoDir, "commit", "-m", "init");
    git(repoDir, "remote", "add", "origin", join(root, "origin.git"));
    git(repoDir, "push", "origin", "main");

    db = openTestDb();
    migrate(db);
    ledger = createLedger(db, {
      now: () => now,
      pmHomeRoot: join(dataHome, "pm-home"),
      dataHome,
      worktreesDir: join(dataHome, "worktrees"),
      launchDir: join(dataHome, "state", "launch"),
      setupLogsDir: join(dataHome, "state", "logs", "setup"),
      userHome: root,
      osSandboxed: () => true,
      models: { current: () => null, availability: () => "available" },
      resolveFolder: createResolveFolder({ dataHome, userHome: root }),
    });
    ledger.onActionEnqueued((a) => enqueued.push(a));
    const created = ledger.createPm({ name: "林经理", mode: "manage_only", persona: "严谨", folder: repoDir });
    lin = { pmId: created.pm.id, conversationId: created.conversation.id, sessionId: created.sessionId };
  });

  afterEach(() => {
    ledger.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const actionOf = <T extends AnyActionRow["type"]>(type: T, params: ActionRow<T>["params"]): ActionRow<T> =>
    ({ id: ++now, type, dedupeKey: "x", params, status: "running", attempts: 1, nextAttemptAt: now, lastError: null, createdAt: now, updatedAt: now }) as ActionRow<T>;

  const runWorktreeCreate = (workerId: WorkerId) =>
    createWorktreeCreateHandler({
      ledger,
      observeReview,
      addWorktree,
      setup: { start: () => true },
      setupLogPath: (id) => workerSetupLogPath(join(root, "logs"), id),
    })(actionOf("worktree.create", { workerId }));

  const runVerify = async () => {
    const verify = enqueued.filter((a): a is ActionRow<"review.verify"> => a.type === "review.verify");
    expect(verify).toHaveLength(1);
    enqueued.length = 0;
    await createReviewVerifyHandler({ ledger, observeReview })(verify[0]!);
  };

  const sessionOf = (workerId: WorkerId) =>
    db.get<{ id: number; conversation_id: number }>("SELECT id, conversation_id FROM agent_sessions WHERE worker_id = ? ORDER BY generation DESC LIMIT 1", workerId)!;

  /** Worker 交一轮汇报；等账本把这几条事件落完（汇报里的文件要先存副本）。 */
  const reportTurn = async (workerId: WorkerId, text: string) => {
    const s = sessionOf(workerId);
    const input = db.get<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? AND sender IN ('pm', 'user') ORDER BY id DESC LIMIT 1", s.conversation_id)!;
    createSessionStore(db).update(s.id, { status: "running", pid: 40_000 + workerId });
    ledger.applyDriverEvent(s.id, { type: "message.delivered", messageIds: [input.id], at: ++now });
    ledger.applyDriverEvent(s.id, { type: "message.processing", messageIds: [input.id], at: ++now });
    ledger.applyDriverEvent(s.id, { type: "agent.text", uuid: `u-${workerId}-${++now}`, text, at: now });
    ledger.applyDriverEvent(s.id, { type: "turn.ended", ok: true, interrupted: false, messageIds: [input.id], durationMs: 5, at: ++now });
    await ledger.settleDriverEvents();
    createSessionStore(db).update(s.id, { status: "ended", pid: null });
  };

  const graphNow = (graphId: number) => ledger.hubCall(lin.sessionId, "graph.show", { graphId }).data.graph;
  const pmTexts = () =>
    enqueued
      .filter((a): a is ActionRow<"session.send"> => a.type === "session.send" && a.params.sessionId === lin.sessionId)
      .map((a) => ledger.getMessage(a.params.messageId)!.text);
  const workerRow = (id: WorkerId) =>
    db.get<{ branch: string | null; worktree_path: string; base_commit: string | null; review_json: string | null; status: string }>(
      "SELECT branch, worktree_path, base_commit, review_json, status FROM workers WHERE id = ?",
      id,
    )!;

  /** impl -> review -> docs：impl 提交并推到 origin、汇报做完了，审查目录建好。返回各步的 Worker 和被审提交。 */
  const startReview = async (reviewStep: { confirm?: boolean } = {}) => {
    const graph = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({
        title: "修翻页",
        goal: "修好翻页并通过独立审查。",
        steps: [
          { key: "impl", title: "实现", brief: "修好翻页" },
          { key: "review", title: "独立审查", brief: "重点看游标边界", review: true, vendor: "codex", ...reviewStep },
          { key: "docs", title: "补文档", brief: "写进 README" },
        ],
      }),
    }).data.graph;
    const wImpl = graph.nodes[0]!.activeWorkerId!;
    await runWorktreeCreate(wImpl);
    const impl = workerRow(wImpl);
    writeFileSync(join(impl.worktree_path, "a.ts"), "export const a = 2;\n");
    git(impl.worktree_path, "commit", "-am", "fix");
    git(impl.worktree_path, "push", "origin", impl.branch!);
    const sha = git(impl.worktree_path, "rev-parse", "HEAD");
    await reportTurn(wImpl, report({ summary: "修好了" }));
    const wReview = graphNow(graph.id).nodes[1]!.activeWorkerId!;
    await runWorktreeCreate(wReview);
    enqueued.length = 0;
    return { graph, wImpl, wReview, impl, sha };
  };

  it("审查步骤拿到 detached 在实现分支上的独立目录，不挂分支，开审时记下本地和 origin 上的被审提交", async () => {
    const { graph, wImpl, wReview, impl, sha } = await startReview();
    expect(workerRow(wImpl).status).toBe("ended");
    const row = workerRow(wReview);
    expect(row.branch).toBeNull();
    expect(row.worktree_path).not.toBe(impl.worktree_path);
    expect(row.base_commit).toBe(sha);
    expect(parseReviewTarget(row.review_json)).toEqual({ branch: impl.branch, snapshot: { sha, remote: { sha }, pr: null } });
    expect(git(row.worktree_path, "rev-parse", "HEAD")).toBe(sha);
    expect(stateOf(graphNow(graph.id).nodes[1]!)).toBe("running");
    const first = db.get<{ text: string }>("SELECT text FROM messages WHERE conversation_id = ? ORDER BY id LIMIT 1", sessionOf(wReview).conversation_id)!.text;
    expect(first).toContain(REVIEW_CHECKLIST);
    expect(first).toContain(`detached 在被审分支 ${impl.branch} 的提交上`);
    expect(first).not.toContain("你已经在这个工作目录和分支上");
  });

  it("判 FAIL：停在 waiting:pm，复现原样交给项目经理，审查 Worker 不收工、下游不开工", async () => {
    const { graph, wReview, sha } = await startReview();
    await reportTurn(wReview, report({ status: "有问题", summary: "游标越界", verdict: "FAIL", sha, questions: "复现：pnpm vitest run a.test.ts，第 2 页重复" }));
    const g = graphNow(graph.id);
    expect(g.nodes.map(stateOf)).toEqual(["done", "waiting:pm", "pending"]);
    expect(enqueued.some((a) => a.type === "review.verify")).toBe(false);
    expect(workerRow(wReview).status).toBe("open");
    const [msg] = pmTexts();
    expect(msg).toContain(`Worker #${wReview}：审查判 FAIL`);
    expect(msg).toContain("复现：pnpm vitest run a.test.ts，第 2 页重复");
  });

  it("判 PASS：先登记收尾核对，步骤保持在干；被审分支没变才完成，下游接手实现的目录和分支", async () => {
    const { graph, wReview, impl, sha } = await startReview();
    await reportTurn(wReview, report({ summary: "可以合", verdict: "PASS", sha }));
    expect(graphNow(graph.id).nodes.map(stateOf)).toEqual(["done", "running", "pending"]);
    expect(workerRow(wReview).status).toBe("open");
    await runVerify();
    const g = graphNow(graph.id);
    expect(g.nodes.map(stateOf)).toEqual(["done", "done", "running"]);
    expect(workerRow(wReview).status).toBe("ended");
    expect(pmTexts()).toEqual([]);
    const docs = workerRow(g.nodes[2]!.activeWorkerId!);
    expect(docs.worktree_path).toBe(impl.worktree_path);
    expect(docs.branch).toBe(impl.branch);
    // 审查目录一次性用：收工就能清理，不等任务图结束
    expect(ledger.isWorkerCleanable(wReview)).toBe(true);
    expect(ledger.listEndedWorktreeWorkers().find((c) => c.workerId === wReview)).toMatchObject({ review: true, branch: null });
  });

  it.each(["chat", "report"] as const)("settles a pending review after a newer direct %s", async (kind) => {
    const { graph, wReview, sha } = await startReview();
    await reportTurn(wReview, report({ summary: "Pass", verdict: "PASS", sha }));
    ledger.postUserMessage({ conversationId: sessionOf(wReview).conversation_id, clientId: "direct", text: "What did you find?" });
    const reply = kind === "chat"
      ? "The cursor is consistent."
      : report({ status: "有问题", summary: "Found a regression", verdict: "FAIL", sha, questions: "Please reopen the implementation step" });
    await reportTurn(wReview, reply);
    await runVerify();
    expect(graphNow(graph.id).nodes.map(stateOf))
      .toEqual(kind === "chat" ? ["done", "done", "running"] : ["done", "waiting:pm", "pending"]);
  });

  it("判 PASS 带非阻塞意见：核对通过后完成，意见抄送项目经理；新汇报写 PASS+NOTES 按无效结论停下", async () => {
    const { graph, wReview, sha } = await startReview();
    await reportTurn(wReview, report({ summary: "可以合", verdict: "PASS+NOTES", sha: sha.slice(0, 8), questions: "a.ts 的命名可以再统一" }));
    expect(graphNow(graph.id).nodes.map(stateOf)).toEqual(["done", "waiting:pm", "pending"]);
    expect(pmTexts()[0]).toContain("只能是 PASS、FAIL");
    enqueued.length = 0;
    ledger.hubCall(lin.sessionId, "worker.send", { workerId: wReview, text: "改成 PASS" });
    await reportTurn(wReview, report({ summary: "可以合", verdict: "pass", sha: sha.slice(0, 8), questions: "a.ts 的命名可以再统一" }));
    await runVerify();
    expect(graphNow(graph.id).nodes.map(stateOf)).toEqual(["done", "done", "running"]);
    expect(pmTexts().some((t) => t.includes("a.ts 的命名可以再统一"))).toBe(true);
  });

  it("旧库 artifact_json 里留存的 PASS+NOTES 和 reviewStamp 字段可只读兼容展示，不崩溃且不输出旧盖章文案", async () => {
    const { graph, wReview, sha } = await startReview();
    await reportTurn(wReview, report({ summary: "可以合", verdict: "PASS", sha }));
    await runVerify();
    db.run(
      "UPDATE task_graph_steps SET artifact_json = ? WHERE graph_id = ? AND node_key = 'review'",
      JSON.stringify({
        summary: "可以合",
        reviewVerdict: "PASS+NOTES",
        verifiedCommit: sha.slice(0, 8),
        reviewStamp: { kind: "posted", sha, state: "success", account: "octo", at: now },
      }),
      graph.id,
    );
    const shown = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id });
    expect(shown.data.graph.nodes[1]!.artifact).toEqual({
      summary: "可以合",
      reviewVerdict: "PASS+NOTES",
      verifiedCommit: sha.slice(0, 8),
    });
    expect(shown.text).toContain(`审查 PASS+NOTES · 验证提交 ${sha.slice(0, 8)}`);
    expect(shown.text).not.toContain("提交状态");
  });

  it("没写结论、验证提交对不上：停在 waiting:pm，不核对", async () => {
    const { graph, wReview, sha } = await startReview();
    await reportTurn(wReview, report({ summary: "看完了" }));
    expect(graphNow(graph.id).nodes.map(stateOf)).toEqual(["done", "waiting:pm", "pending"]);
    expect(pmTexts()[0]).toContain("审查没写“结论”或写错了");
    enqueued.length = 0;
    ledger.hubCall(lin.sessionId, "worker.send", { workerId: wReview, text: "补上结论" });
    await reportTurn(wReview, report({ summary: "可以合", verdict: "PASS", sha: "deadbeef" }));
    expect(stateOf(graphNow(graph.id).nodes[1]!)).toBe("waiting:pm");
    expect(enqueued.some((a) => a.type === "review.verify")).toBe(false);
    expect(pmTexts().at(-1)).toContain(`“验证提交”写的是 deadbeef，被审的是分支`);
    expect(pmTexts().at(-1)).toContain(sha);
  });

  it("审查期间被审分支被推了新提交：核对作废结论，停在 waiting:pm，写明哪里变了", async () => {
    const { graph, wReview, impl, sha } = await startReview();
    const reviewDir = workerRow(wReview).worktree_path;
    writeFileSync(join(reviewDir, "a.ts"), "export const a = 3;\n");
    git(reviewDir, "commit", "-am", "reviewer fix");
    git(reviewDir, "push", "--no-verify", "origin", `HEAD:refs/heads/${impl.branch}`);
    const pushed = git(reviewDir, "rev-parse", "HEAD");
    await reportTurn(wReview, report({ summary: "可以合", verdict: "PASS", sha }));
    await runVerify();
    expect(graphNow(graph.id).nodes.map(stateOf)).toEqual(["done", "waiting:pm", "pending"]);
    expect(workerRow(wReview).status).toBe("open");
    const [msg] = pmTexts();
    expect(msg).toContain("被审分支在审查期间被动过");
    expect(msg).toContain(`origin 上的分支 ${impl.branch} 从 ${sha.slice(0, 12)} 变成了 ${pushed.slice(0, 12)}`);
  });

  it("收尾核对重试用完还没跑成：当成核对失败，停在 waiting:pm", async () => {
    const { graph, wReview, sha } = await startReview();
    await reportTurn(wReview, report({ summary: "可以合", verdict: "PASS", sha }));
    const verify = enqueued.find((a) => a.type === "review.verify")!;
    enqueued.length = 0;
    ledger.onActionFailed(verify, "git ls-remote 失败：Could not resolve host");
    expect(stateOf(graphNow(graph.id).nodes[1]!)).toBe("waiting:pm");
    expect(pmTexts()[0]).toContain("收尾核对没跑成：git ls-remote 失败：Could not resolve host");
  });

  const createGraph = (steps: unknown[]) =>
    ledger.hubCall(lin.sessionId, "graph.create", { specJson: JSON.stringify({ title: "审查", goal: "只查不修", steps }) }).data.graph;

  it("审查步骤找不到被审分支（没有上一步、多路合流、base 写 main）：建图、改图直接拒绝，不降级成普通 Worker", () => {
    const solo = { key: "review", title: "独立审查", brief: "审查 hub/target-pr", review: true };
    expect(() => createGraph([solo])).toThrow(/被审分支/);
    expect(() =>
      createGraph([
        { key: "a", title: "A", brief: "做 A", deps: [] },
        { key: "b", title: "B", brief: "做 B", deps: [] },
        { ...solo, deps: ["a", "b"] },
      ]),
    ).toThrow(/被审分支/);
    expect(() => createGraph([{ key: "impl", title: "实现", brief: "做" }, { ...solo, base: "main" }])).toThrow(/被审分支/);
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM workers")).toEqual({ n: 0 });

    const graph = createGraph([{ key: "impl", title: "实现" }]);
    expect(() =>
      ledger.hubCall(lin.sessionId, "graph.patch", { graphId: graph.id, specJson: JSON.stringify({ addSteps: [{ ...solo, deps: [] }] }) }),
    ).toThrow(/被审分支/);
  });

  it("补建的单步审查图：base 写被审分支，审查目录 detached 在它上面、不挂分支；汇报不写验证提交就停下", async () => {
    git(repoDir, "checkout", "-b", "hub/target-pr");
    writeFileSync(join(repoDir, "a.ts"), "export const a = 9;\n");
    git(repoDir, "commit", "-am", "target");
    git(repoDir, "push", "origin", "hub/target-pr");
    const sha = git(repoDir, "rev-parse", "HEAD");
    git(repoDir, "checkout", "main");

    const graph = createGraph([{ key: "review", title: "独立审查", brief: "审查 hub/target-pr", review: true, base: "hub/target-pr" }]);
    const w = graph.nodes[0]!.activeWorkerId!;
    await runWorktreeCreate(w);
    const row = workerRow(w);
    expect(row.branch).toBeNull();
    expect(parseReviewTarget(row.review_json)).toEqual({ branch: "hub/target-pr", snapshot: { sha, remote: { sha }, pr: null } });
    expect(git(row.worktree_path, "rev-parse", "HEAD")).toBe(sha);
    enqueued.length = 0;

    await reportTurn(w, report({ summary: "可以合", verdict: "PASS" }));
    expect(stateOf(graphNow(graph.id).nodes[0]!)).toBe("waiting:pm");
    expect(enqueued.some((a) => a.type === "review.verify")).toBe(false);
    expect(pmTexts()[0]).toContain("“验证提交”写的是 （没写）");
  });

  it("上一步在主文件夹里干活：审查步骤不开工，停在 waiting:pm 并写明找不到被审分支", async () => {
    const graph = createGraph([
      { key: "impl", title: "实现" },
      { key: "review", title: "独立审查", brief: "重点看边界", review: true },
    ]);
    const wImpl = ledger.hubCall(lin.sessionId, "worker.start", { node: "impl", graphId: graph.id, task: "修好翻页", noWorktree: true }).data.worker.id;
    enqueued.length = 0;
    await reportTurn(wImpl, report({ summary: "修好了" }));
    const g = graphNow(graph.id);
    expect(g.nodes.map(stateOf)).toEqual(["done", "waiting:pm"]);
    expect(g.nodes[1]!.workerIds).toEqual([]);
    expect(pmTexts().some((t) => t.includes("找不到被审分支"))).toBe(true);
  });

  it("审查步骤用 --no-worktree 派活直接拒绝", async () => {
    const { graph, wReview, sha } = await startReview();
    await reportTurn(wReview, report({ status: "有问题", summary: "游标越界", verdict: "FAIL", sha }));
    expect(() => ledger.hubCall(lin.sessionId, "worker.start", { node: "review", graphId: graph.id, noWorktree: true })).toThrow(/审查/);
    expect(workerRow(wReview).status).toBe("open");
  });

  it("验证提交写成行内代码、带句号也认；步骤产物记下结论和验证的提交号", async () => {
    const { graph, wReview, sha } = await startReview();
    await reportTurn(wReview, report({ summary: "可以合", verdict: "PASS", sha: `\`${sha.slice(0, 8)}\`。` }));
    await runVerify();
    const node = graphNow(graph.id).nodes[1]!;
    expect(stateOf(node)).toBe("done");
    expect(node.artifact).toMatchObject({ reviewVerdict: "PASS", verifiedCommit: sha.slice(0, 8) });
    expect(ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).text).toContain(`审查 PASS · 验证提交 ${sha.slice(0, 8)}`);
  });

  it("审查结论文件写进“文件”栏：核对通过后挂到步骤上，标了 confirm 的审查步骤的检查点卡和总助拍板卡都带它", async () => {
    const { graph, wReview, sha } = await startReview({ confirm: true });
    const verdictPath = join(workerRow(wReview).worktree_path, "verdict.md");
    writeFileSync(verdictPath, "# 审查结论\nPASS\n");
    await reportTurn(wReview, report({ summary: "可以合", verdict: "PASS", sha, files: `\n- [审查结论](${verdictPath})` }));
    expect(stateOf(graphNow(graph.id).nodes[1]!)).toBe("running");
    await runVerify();
    const node = graphNow(graph.id).nodes[1]!;
    expect(stateOf(node)).toBe("waiting:user");
    expect(node.artifact).toMatchObject({ reviewVerdict: "PASS", verifiedCommit: sha });
    expect(node.artifact?.deliverables?.map((d) => [d.label, d.mime])).toEqual([["审查结论", "text/markdown"]]);
    expect(askOf(ledger.getMessage(node.gateAskMessageId!)!)?.deliverables?.map((d) => d.label)).toEqual(["审查结论"]);
    expect(pendingDecisionsOf(ledger.snapshot())[0]!.deliverables?.map((d) => d.label)).toEqual(["审查结论"]);
  });

  it("判 FAIL 后项目经理在审查后面加修复步骤：修复步骤接手实现的 worktree 和分支，不接审查目录", async () => {
    const { graph, wReview, impl, sha } = await startReview();
    await reportTurn(wReview, report({ status: "有问题", summary: "游标越界", verdict: "FAIL", sha, questions: "复现见上" }));
    ledger.hubCall(lin.sessionId, "worker.end", { workerId: wReview });
    ledger.hubCall(lin.sessionId, "graph.done", { graphId: graph.id, nodeKey: "review" });
    const g = graphNow(graph.id);
    const docs = workerRow(g.nodes[2]!.activeWorkerId!);
    expect(docs.worktree_path).toBe(impl.worktree_path);
    expect(docs.branch).toBe(impl.branch);
    expect(docs.review_json).toBeNull();
  });
});
