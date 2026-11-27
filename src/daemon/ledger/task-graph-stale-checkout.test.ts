// Review and fix steps must start from the commit the upstream step actually delivered, not from a stale local branch.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActionRow, AnyActionRow } from "../../shared/actions.ts";
import type { ConversationId, PmId, SessionId, TaskNode, WorkerId } from "../../shared/domain.ts";
import { workerSetupLogPath } from "../../shared/paths.ts";
import { parseReviewTarget } from "../../shared/review.ts";
import { REPORT_END, REPORT_START } from "../../shared/worker.ts";
import { addWorktree, remoteBranchHead, resolveBranchTip, resolveCommit, syncWorktreeBranch } from "../git/index.ts";
import { createReviewObserver, createReviewVerifyHandler, createWorktreeCreateHandler, createWorktreeSyncHandler } from "../handlers.ts";
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

function report(fields: { status?: string; summary: string; verdict?: string; sha?: string; commit?: string }): string {
  return [
    REPORT_START,
    `状态: ${fields.status ?? "做完了"}`,
    `摘要: ${fields.summary}`,
    ...(fields.verdict !== undefined ? [`结论: ${fields.verdict}`] : []),
    ...(fields.sha !== undefined ? [`验证提交: ${fields.sha}`] : []),
    "PR: 无",
    `提交: ${fields.commit ?? "无"}`,
    "测试: 通过",
    "偏离: 无",
    "交棒: 无",
    "文件: 无",
    "问题: 无",
    REPORT_END,
  ].join("\n");
}

const PR_BRANCH = "hub/7-pr";

describe("review and fix steps start from the delivered commit", () => {
  let db: Db;
  let root: string;
  let repoDir: string;
  let originDir: string;
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
    root = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-stale-")));
    const dataHome = join(root, "data");
    repoDir = join(root, "repo");
    originDir = join(root, "origin.git");
    for (const d of ["pm-home", "worktrees", "state/launch", "state/logs/setup"]) mkdirSync(join(dataHome, d), { recursive: true });
    mkdirSync(repoDir);
    git(root, "init", "--bare", "-b", "main", originDir);
    git(repoDir, "init", "-b", "main");
    writeFileSync(join(repoDir, "a.ts"), "export const a = 1;\n");
    git(repoDir, "add", "a.ts");
    git(repoDir, "commit", "-m", "init");
    git(repoDir, "remote", "add", "origin", originDir);
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

  /** Runs the workspace action the ledger queued for this Worker, as the executor would. */
  const prepareWorkspace = async (workerId: WorkerId) => {
    const create = enqueued.find((a) => a.type === "worktree.create" && a.params.workerId === workerId);
    if (create !== undefined) {
      await createWorktreeCreateHandler({
        ledger,
        resolveTip: resolveBranchTip,
        probePr: async () => null,
        addWorktree,
        setup: { start: () => true },
        setupLogPath: (id) => workerSetupLogPath(join(root, "logs"), id),
      })(actionOf("worktree.create", { workerId }));
    }
    if (enqueued.some((a) => a.type === "worktree.sync" && a.params.workerId === workerId)) {
      await createWorktreeSyncHandler({ ledger, syncWorktree: syncWorktreeBranch })(actionOf("worktree.sync", { workerId }));
    }
  };

  const sessionOf = (workerId: WorkerId) =>
    db.get<{ id: number; conversation_id: number }>("SELECT id, conversation_id FROM agent_sessions WHERE worker_id = ? ORDER BY generation DESC LIMIT 1", workerId)!;

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
  const createGraph = (steps: unknown[]) =>
    ledger.hubCall(lin.sessionId, "graph.create", { specJson: JSON.stringify({ title: "PR 7", goal: "修好 PR 7", steps }) }).data.graph;
  const workerRow = (id: WorkerId) =>
    db.get<{ branch: string | null; worktree_path: string; base_commit: string | null; review_json: string | null; status: string }>(
      "SELECT branch, worktree_path, base_commit, review_json, status FROM workers WHERE id = ?",
      id,
    )!;
  const taskText = (workerId: WorkerId) =>
    db.get<{ text: string }>("SELECT text FROM messages WHERE conversation_id = ? ORDER BY id LIMIT 1", sessionOf(workerId).conversation_id)!.text;

  /** Another clone pushes a commit onto the PR branch, as a code host's "update branch" or a fix step on another branch would. */
  const pushFromElsewhere = (branch: string, content: string): string => {
    const other = join(root, `other-${++now}`);
    git(root, "clone", "--quiet", "--branch", branch, originDir, other);
    writeFileSync(join(other, "a.ts"), content);
    git(other, "commit", "-am", `remote ${content.trim()}`);
    git(other, "push", "--quiet", "origin", branch);
    return git(other, "rev-parse", "HEAD");
  };

  /** The PR branch exists locally and on the remote at the same commit. */
  const seedPrBranch = (): string => {
    git(repoDir, "branch", PR_BRANCH, "main");
    git(repoDir, "push", "--quiet", "origin", PR_BRANCH);
    return git(repoDir, "rev-parse", PR_BRANCH);
  };

  it("fix pushes to the PR branch from its own branch; the next review with base = PR branch checks out the pushed commit", async () => {
    const stale = seedPrBranch();
    const graph = createGraph([
      { key: "fix", title: "修复", brief: "修好并推到 PR 分支" },
      { key: "review", title: "复审", brief: "复审", review: true, base: PR_BRANCH },
    ]);
    const wFix = graph.nodes[0]!.activeWorkerId!;
    await prepareWorkspace(wFix);
    const fixDir = workerRow(wFix).worktree_path;
    expect(workerRow(wFix).branch).not.toBe(PR_BRANCH);
    git(fixDir, "fetch", "--quiet", "origin", PR_BRANCH);
    git(fixDir, "reset", "--hard", "--quiet", "FETCH_HEAD");
    writeFileSync(join(fixDir, "a.ts"), "export const a = 2;\n");
    git(fixDir, "commit", "-am", "fix");
    git(fixDir, "push", "--quiet", "origin", `HEAD:refs/heads/${PR_BRANCH}`);
    const pushed = git(fixDir, "rev-parse", "HEAD");
    expect(git(repoDir, "rev-parse", PR_BRANCH)).toBe(stale);

    await reportTurn(wFix, report({ summary: "修好了", commit: pushed.slice(0, 8) }));
    const wReview = graphNow(graph.id).nodes[1]!.activeWorkerId!;
    await prepareWorkspace(wReview);
    const review = workerRow(wReview);
    expect(git(review.worktree_path, "rev-parse", "HEAD")).toBe(pushed);
    expect(review.base_commit).toBe(pushed);
    expect(parseReviewTarget(review.review_json)?.snapshot?.sha).toBe(pushed);

    enqueued.length = 0;
    await reportTurn(wReview, report({ summary: "可以合", verdict: "PASS", sha: pushed }));
    const verify = enqueued.find((a): a is ActionRow<"review.verify"> => a.type === "review.verify");
    expect(verify).toBeDefined();
    await createReviewVerifyHandler({ ledger, observeReview })(verify!);
    expect(graphNow(graph.id).nodes.map(stateOf)).toEqual(["done", "done"]);
  });

  it("fix after a review with base = PR branch forks from the remote head, not from main or the stale local branch", async () => {
    const stale = seedPrBranch();
    const remoteHead = pushFromElsewhere(PR_BRANCH, "export const a = 3;\n");
    const graph = createGraph([
      { key: "review", title: "审查", brief: "审查", review: true, base: PR_BRANCH },
      { key: "fix", title: "修复", brief: "按审查意见修" },
    ]);
    const wReview = graph.nodes[0]!.activeWorkerId!;
    await prepareWorkspace(wReview);
    expect(git(workerRow(wReview).worktree_path, "rev-parse", "HEAD")).toBe(remoteHead);
    expect(taskText(wReview)).toContain(remoteHead.slice(0, 12));

    await reportTurn(wReview, report({ status: "有问题", summary: "有缺陷", verdict: "FAIL", sha: remoteHead }));
    ledger.hubCall(lin.sessionId, "worker.end", { workerId: wReview });
    ledger.hubCall(lin.sessionId, "graph.done", { graphId: graph.id, nodeKey: "review" });
    const wFix = graphNow(graph.id).nodes[1]!.activeWorkerId!;
    await prepareWorkspace(wFix);
    const fixDir = workerRow(wFix).worktree_path;
    expect(git(fixDir, "rev-parse", "HEAD")).toBe(remoteHead);
    expect(git(fixDir, "rev-parse", "HEAD")).not.toBe(stale);
  });

  it("fix inheriting the implementation worktree fast-forwards the branch when the remote moved ahead after the review", async () => {
    const graph = createGraph([
      { key: "impl", title: "实现", brief: "实现" },
      { key: "review", title: "审查", brief: "审查", review: true },
      { key: "fix", title: "修复", brief: "按审查意见修" },
    ]);
    const wImpl = graph.nodes[0]!.activeWorkerId!;
    await prepareWorkspace(wImpl);
    const impl = workerRow(wImpl);
    writeFileSync(join(impl.worktree_path, "a.ts"), "export const a = 4;\n");
    git(impl.worktree_path, "commit", "-am", "impl");
    git(impl.worktree_path, "push", "--quiet", "origin", impl.branch!);
    const implSha = git(impl.worktree_path, "rev-parse", "HEAD");
    await reportTurn(wImpl, report({ summary: "实现了", commit: implSha }));
    const updated = pushFromElsewhere(impl.branch!, "export const a = 5;\n");

    const wReview = graphNow(graph.id).nodes[1]!.activeWorkerId!;
    await prepareWorkspace(wReview);
    expect(git(workerRow(wReview).worktree_path, "rev-parse", "HEAD")).toBe(updated);
    await reportTurn(wReview, report({ status: "有问题", summary: "有缺陷", verdict: "FAIL", sha: updated }));
    ledger.hubCall(lin.sessionId, "worker.end", { workerId: wReview });
    ledger.hubCall(lin.sessionId, "graph.done", { graphId: graph.id, nodeKey: "review" });

    const wFix = graphNow(graph.id).nodes[2]!.activeWorkerId!;
    expect(workerRow(wFix).worktree_path).toBe(impl.worktree_path);
    await prepareWorkspace(wFix);
    expect(git(impl.worktree_path, "rev-parse", "HEAD")).toBe(updated);
    expect(git(repoDir, "rev-parse", impl.branch!)).toBe(updated);
    expect(enqueued.some((a) => a.type === "session.send" && a.params.sessionId === sessionOf(wFix).id)).toBe(true);
    expect(taskText(wFix)).toContain(`已从 ${implSha.slice(0, 12)} 快进到 ${updated.slice(0, 12)}`);
  });
});
