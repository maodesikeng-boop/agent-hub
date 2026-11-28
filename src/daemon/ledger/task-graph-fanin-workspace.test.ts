import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActionRow, AnyActionRow } from "../../shared/actions.ts";
import type { ConversationId, PmId, SessionId, TaskNode, WorkerId } from "../../shared/domain.ts";
import { WORKTREE_RETENTION_MS } from "../../shared/limits.ts";
import { workerSetupLogPath } from "../../shared/paths.ts";
import { parseReviewTarget } from "../../shared/review.ts";
import { REPORT_END, REPORT_START } from "../../shared/worker.ts";
import { addWorktree, remoteBranchHead, resolveBranchTip, resolveCommit, syncWorktreeBranch } from "../git/index.ts";
import { createReviewObserver, createReviewVerifyHandler, createWorktreeCreateHandler, createWorktreeSyncHandler } from "../handlers.ts";
import { createSessionStore, migrate, type Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createWorktreeCleanup } from "../worktree-cleanup.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger, type SqliteLedger } from "./index.ts";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] }).trim();

const stateOf = (n: Pick<TaskNode, "status" | "waitingFor" | "skipped">): string =>
  n.status === "waiting" ? `waiting:${n.waitingFor}` : n.status === "done" && n.skipped ? "skipped" : n.status;

function report(fields: {
  status?: string;
  summary: string;
  verdict?: string;
  sha?: string;
  commit?: string;
  handoff?: string;
  questions?: string;
}): string {
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
    `交棒: ${fields.handoff ?? "无"}`,
    "文件: 无",
    `问题: ${fields.questions ?? "无"}`,
    REPORT_END,
  ].join("\n");
}

const PR_BRANCH = "hub/7-pr";

describe("Task Graph multi-review fan-in workspace inheritance (end-to-end)", () => {
  let db: Db;
  let root: string;
  let dataHome: string;
  let worktreesDir: string;
  let repoDir: string;
  let originDir: string;
  let now: number;
  let ledger: SqliteLedger;
  let enqueued: AnyActionRow[];
  let lin: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };

  const observeReview = createReviewObserver({
    resolveCommit: (f, r) => resolveCommit(f, r),
    remoteBranchHead: (r, b, name) => remoteBranchHead(r, b, name),
    probePr: async () => null,
  });

  beforeEach(() => {
    now = 1_720_000_000_000;
    enqueued = [];
    root = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-fanin-")));
    dataHome = join(root, "data");
    worktreesDir = join(dataHome, "worktrees");
    repoDir = join(root, "repo");
    originDir = join(root, "origin.git");
    for (const d of ["pm-home", "worktrees", "state/launch", "state/logs/setup"]) {
      mkdirSync(join(dataHome, d), { recursive: true });
    }
    mkdirSync(repoDir);
    git(root, "init", "--bare", "-b", "main", originDir);
    git(repoDir, "init", "-b", "main");
    writeFileSync(join(repoDir, "a.ts"), "export const a = 1;\n");
    git(repoDir, "add", "a.ts");
    git(repoDir, "commit", "-m", "init");
    git(repoDir, "remote", "add", "origin", originDir);
    git(repoDir, "push", "--quiet", "origin", "main");

    db = openTestDb();
    migrate(db);
    ledger = createLedger(db, {
      now: () => now,
      pmHomeRoot: join(dataHome, "pm-home"),
      dataHome,
      worktreesDir,
      launchDir: join(dataHome, "state", "launch"),
      setupLogsDir: join(dataHome, "state", "logs", "setup"),
      userHome: root,
      osSandboxed: () => true,
      models: { current: () => null, availability: () => "available" },
      resolveFolder: createResolveFolder({ dataHome, userHome: root }),
    });
    ledger.onActionEnqueued((a) => enqueued.push(a));
    const created = ledger.createPm({ name: "PM", mode: "manage_only", persona: "", folder: repoDir });
    lin = { pmId: created.pm.id, conversationId: created.conversation.id, sessionId: created.sessionId };
    enqueued.length = 0;
  });

  afterEach(() => {
    ledger.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const actionOf = <T extends AnyActionRow["type"]>(type: T, params: ActionRow<T>["params"]): ActionRow<T> =>
    ({
      id: ++now,
      type,
      dedupeKey: "x",
      params,
      status: "running",
      attempts: 1,
      nextAttemptAt: now,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }) as ActionRow<T>;

  const runCreate = (workerId: WorkerId) =>
    createWorktreeCreateHandler({
      ledger,
      resolveTip: resolveBranchTip,
      probePr: async () => null,
      addWorktree,
      setup: { start: () => true },
      setupLogPath: (id) => workerSetupLogPath(join(dataHome, "state", "logs", "setup"), id),
    })(actionOf("worktree.create", { workerId }));

  const runSync = (workerId: WorkerId) =>
    createWorktreeSyncHandler({ ledger, syncWorktree: syncWorktreeBranch })(actionOf("worktree.sync", { workerId }));

  const prepareWorkspace = async (workerId: WorkerId) => {
    if (enqueued.some((a) => a.type === "worktree.create" && a.params.workerId === workerId)) {
      await runCreate(workerId);
    }
    if (enqueued.some((a) => a.type === "worktree.sync" && a.params.workerId === workerId)) {
      await runSync(workerId);
    }
  };

  const runVerifyFor = async (workerId: WorkerId) => {
    const verify = enqueued.find((a): a is ActionRow<"review.verify"> => a.type === "review.verify" && a.params.workerId === workerId);
    expect(verify).toBeDefined();
    await createReviewVerifyHandler({ ledger, observeReview })(verify!);
  };

  const sessionOf = (workerId: WorkerId) =>
    db.get<{ id: SessionId; conversation_id: number }>(
      "SELECT id, conversation_id FROM agent_sessions WHERE worker_id = ? ORDER BY generation DESC LIMIT 1",
      workerId,
    )!;

  const workerRow = (id: WorkerId) =>
    db.get<{ branch: string | null; worktree_path: string; base_commit: string | null; review_json: string | null; status: string }>(
      "SELECT branch, worktree_path, base_commit, review_json, status FROM workers WHERE id = ?",
      id,
    )!;

  const taskText = (workerId: WorkerId) =>
    db.get<{ text: string }>("SELECT text FROM messages WHERE conversation_id = ? ORDER BY id LIMIT 1", sessionOf(workerId).conversation_id)!.text;

  const reportTurn = async (workerId: WorkerId, text: string) => {
    const s = sessionOf(workerId);
    const input = db.get<{ id: number }>(
      "SELECT id FROM messages WHERE conversation_id = ? AND sender IN ('pm', 'user') ORDER BY id DESC LIMIT 1",
      s.conversation_id,
    )!;
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
    ledger.hubCall(lin.sessionId, "graph.create", { specJson: JSON.stringify({ title: "Fan-in", goal: "Keep workspace continuity", steps }) }).data.graph;

  const pushFromElsewhere = (branch: string, content: string): string => {
    const other = join(root, `other-${++now}`);
    git(root, "clone", "--quiet", "--branch", branch, originDir, other);
    writeFileSync(join(other, "a.ts"), content);
    git(other, "commit", "-am", `remote ${content.trim()}`);
    git(other, "push", "--quiet", "origin", branch);
    return git(other, "rev-parse", "HEAD");
  };

  const seedPrBranch = (): string => {
    git(repoDir, "branch", PR_BRANCH, "main");
    git(repoDir, "push", "--quiet", "origin", PR_BRANCH);
    return git(repoDir, "rev-parse", PR_BRANCH);
  };

  describe("new behavior (must fail before implementation)", () => {
    it("S1/S11: 2-way parallel reviews (cross-vendor) converging onto fix1 inherit impl worktree, PR branch, delivered commit, and both handoffs", async () => {
      const graph = createGraph([
        { key: "impl", title: "Implement", brief: "Implement change", vendor: "claude", deps: [] },
        { key: "review-logic", title: "Logic review", brief: "Check logic", review: true, vendor: "codex", deps: ["impl"] },
        { key: "review-real", title: "Real review", brief: "Run real checks", review: true, vendor: "agy", deps: ["impl"] },
        { key: "fix1", title: "Fix round 1", brief: "Address findings", vendor: "claude", deps: ["review-logic", "review-real"] },
      ]);

      const wImpl = graph.nodes.find((n) => n.key === "impl")!.activeWorkerId!;
      await prepareWorkspace(wImpl);
      const impl = workerRow(wImpl);
      writeFileSync(join(impl.worktree_path, "a.ts"), "export const a = 2;\n");
      git(impl.worktree_path, "commit", "-am", "impl commit");
      git(impl.worktree_path, "push", "--quiet", "origin", impl.branch!);
      const implSha = git(impl.worktree_path, "rev-parse", "HEAD");
      await reportTurn(wImpl, report({ summary: "Implemented", commit: implSha }));

      const gAfterImpl = graphNow(graph.id);
      const wRevLogic = gAfterImpl.nodes.find((n) => n.key === "review-logic")!.activeWorkerId!;
      const wRevReal = gAfterImpl.nodes.find((n) => n.key === "review-real")!.activeWorkerId!;
      await prepareWorkspace(wRevLogic);
      await prepareWorkspace(wRevReal);

      await reportTurn(wRevLogic, report({ status: "有问题", summary: "Logic defect", verdict: "FAIL", sha: implSha, handoff: "Fix boundary in a.ts:1" }));
      ledger.hubCall(lin.sessionId, "worker.end", { workerId: wRevLogic });
      ledger.hubCall(lin.sessionId, "graph.done", { graphId: graph.id, nodeKey: "review-logic" });

      // Remote moves ahead before fix1 syncs to verify worktree.sync fast-forwards with expected commit.
      const remoteAhead = pushFromElsewhere(impl.branch!, "export const a = 3;\n");

      await reportTurn(wRevReal, report({ status: "有问题", summary: "Real check defect", verdict: "FAIL", sha: implSha, handoff: "Real check failed on empty input" }));
      ledger.hubCall(lin.sessionId, "worker.end", { workerId: wRevReal });
      enqueued.length = 0;
      ledger.hubCall(lin.sessionId, "graph.done", { graphId: graph.id, nodeKey: "review-real" });

      const wFix1 = graphNow(graph.id).nodes.find((n) => n.key === "fix1")!.activeWorkerId!;
      const fix1 = workerRow(wFix1);
      expect(fix1.worktree_path).toBe(impl.worktree_path);
      expect(fix1.branch).toBe(impl.branch);
      expect(enqueued.some((a) => a.type === "worktree.sync" && a.params.workerId === wFix1)).toBe(true);
      expect(enqueued.some((a) => a.type === "worktree.create" && a.params.workerId === wFix1)).toBe(false);
      expect(ledger.getWorktreeSyncTask(wFix1)).toMatchObject({ kind: "sync", branch: impl.branch, expected: implSha });

      await prepareWorkspace(wFix1);
      expect(git(impl.worktree_path, "rev-parse", "HEAD")).toBe(remoteAhead);
      expect(taskText(wFix1)).toContain("Fix boundary in a.ts:1");
      expect(taskText(wFix1)).toContain("Real check failed on empty input");
      expect(taskText(wFix1)).toContain(`Worker #${wImpl}`);
    });

    it("S2: multi-round parallel review diamonds (impl -> [r1a, r1b] -> fix1 -> [r2a, r2b] -> fix2) preserve one worktree and PR branch across consecutive rounds and turns", async () => {
      const graph = createGraph([
        { key: "impl", title: "Implement", brief: "Impl", deps: [] },
        { key: "rev1a", title: "Review 1A", brief: "R1A", review: true, deps: ["impl"] },
        { key: "rev1b", title: "Review 1B", brief: "R1B", review: true, deps: ["impl"] },
        { key: "fix1", title: "Fix 1", brief: "Fix 1", deps: ["rev1a", "rev1b"] },
        { key: "rev2a", title: "Review 2A", brief: "R2A", review: true, deps: ["fix1"] },
        { key: "rev2b", title: "Review 2B", brief: "R2B", review: true, deps: ["fix1"] },
        { key: "fix2", title: "Fix 2", brief: "Fix 2", deps: ["rev2a", "rev2b"] },
      ]);

      const wImpl = graph.nodes.find((n) => n.key === "impl")!.activeWorkerId!;
      await prepareWorkspace(wImpl);
      const impl = workerRow(wImpl);
      writeFileSync(join(impl.worktree_path, "a.ts"), "export const a = 10;\n");
      git(impl.worktree_path, "commit", "-am", "r1 impl");
      git(impl.worktree_path, "push", "--quiet", "origin", impl.branch!);
      const sha1 = git(impl.worktree_path, "rev-parse", "HEAD");
      await reportTurn(wImpl, report({ summary: "impl done", commit: sha1 }));

      for (const k of ["rev1a", "rev1b"] as const) {
        const w = graphNow(graph.id).nodes.find((n) => n.key === k)!.activeWorkerId!;
        await prepareWorkspace(w);
        await reportTurn(w, report({ status: "有问题", summary: "fail", verdict: "FAIL", sha: sha1 }));
        ledger.hubCall(lin.sessionId, "worker.end", { workerId: w });
        ledger.hubCall(lin.sessionId, "graph.done", { graphId: graph.id, nodeKey: k });
      }

      const wFix1 = graphNow(graph.id).nodes.find((n) => n.key === "fix1")!.activeWorkerId!;
      expect(workerRow(wFix1).worktree_path).toBe(impl.worktree_path);
      await prepareWorkspace(wFix1);
      // Consecutive turn on fix1 before completing round 1.
      await reportTurn(wFix1, report({ status: "有问题", summary: "Need confirmation", questions: "Proceed?" }));
      ledger.hubCall(lin.sessionId, "worker.send", { workerId: wFix1, text: "Proceed and commit" });
      writeFileSync(join(impl.worktree_path, "a.ts"), "export const a = 20;\n");
      git(impl.worktree_path, "commit", "-am", "fix1 commit");
      git(impl.worktree_path, "push", "--quiet", "origin", impl.branch!);
      const sha2 = git(impl.worktree_path, "rev-parse", "HEAD");
      await reportTurn(wFix1, report({ summary: "fix1 done", commit: sha2 }));

      for (const k of ["rev2a", "rev2b"] as const) {
        const w = graphNow(graph.id).nodes.find((n) => n.key === k)!.activeWorkerId!;
        await prepareWorkspace(w);
        await reportTurn(w, report({ status: "有问题", summary: "fail r2", verdict: "FAIL", sha: sha2 }));
        ledger.hubCall(lin.sessionId, "worker.end", { workerId: w });
        ledger.hubCall(lin.sessionId, "graph.done", { graphId: graph.id, nodeKey: k });
      }

      const wFix2 = graphNow(graph.id).nodes.find((n) => n.key === "fix2")!.activeWorkerId!;
      expect(workerRow(wFix2).worktree_path).toBe(impl.worktree_path);
      expect(workerRow(wFix2).branch).toBe(impl.branch);
      expect(ledger.getWorktreeSyncTask(wFix2)).toMatchObject({ kind: "sync", branch: impl.branch, expected: sha2 });
    });

    it("S3: worktree-cleanup and worktree-hold protect impl worktree across parallel reviews until downstream fix finishes", async () => {
      const graph = createGraph([
        { key: "impl", title: "Implement", brief: "Impl", deps: [] },
        { key: "rev1", title: "Review 1", brief: "R1", review: true, deps: ["impl"] },
        { key: "rev2", title: "Review 2", brief: "R2", review: true, deps: ["impl"] },
        { key: "fix1", title: "Fix 1", brief: "Fix 1", deps: ["rev1", "rev2"] },
      ]);

      const wImpl = graph.nodes.find((n) => n.key === "impl")!.activeWorkerId!;
      await prepareWorkspace(wImpl);
      const impl = workerRow(wImpl);
      writeFileSync(join(impl.worktree_path, "a.ts"), "export const a = 30;\n");
      git(impl.worktree_path, "commit", "-am", "impl");
      git(impl.worktree_path, "push", "--quiet", "origin", impl.branch!);
      const sha = git(impl.worktree_path, "rev-parse", "HEAD");
      await reportTurn(wImpl, report({ summary: "done", commit: sha }));

      const cleanup = createWorktreeCleanup({ ledger, worktreesDir, log: () => {}, now: () => now });
      now += WORKTREE_RETENTION_MS + 60_000;

      // Protected while parallel reviews and fix1 are unfinished.
      expect(ledger.isWorkerCleanable(wImpl)).toBe(false);
      expect(await cleanup.runOnce()).toEqual([]);
      expect(existsSync(impl.worktree_path)).toBe(true);
      expect((await cleanup.inspectHeldWorktrees()).some((h) => h.workerId === wImpl)).toBe(false);
      await expect(cleanup.discardWorktree(wImpl)).rejects.toThrow(/not eligible/);

      for (const k of ["rev1", "rev2"] as const) {
        const w = graphNow(graph.id).nodes.find((n) => n.key === k)!.activeWorkerId!;
        await prepareWorkspace(w);
        await reportTurn(w, report({ summary: "ok", verdict: "PASS", sha }));
        await runVerifyFor(w);
      }

      const wFix1 = graphNow(graph.id).nodes.find((n) => n.key === "fix1")!.activeWorkerId!;
      await prepareWorkspace(wFix1);
      expect(ledger.isWorkerCleanable(wImpl)).toBe(false);
      await reportTurn(wFix1, report({ summary: "fixed", commit: sha }));

      expect(ledger.isWorkerCleanable(wImpl)).toBe(true);
    });

    it("S4: standalone parallel reviews with matching explicit base fork from the reviewed branch tip, and review-after-parallel-reviews checks out impl branch", async () => {
      const stale = seedPrBranch();
      const remoteHead = pushFromElsewhere(PR_BRANCH, "export const a = 40;\n");

      const baseGraph = createGraph([
        { key: "rev1", title: "Review 1", brief: "R1", review: true, base: PR_BRANCH, deps: [] },
        { key: "rev2", title: "Review 2", brief: "R2", review: true, base: PR_BRANCH, deps: [] },
        { key: "fix", title: "Fix", brief: "Fix", deps: ["rev1", "rev2"] },
      ]);
      for (const k of ["rev1", "rev2"] as const) {
        const w = graphNow(baseGraph.id).nodes.find((n) => n.key === k)!.activeWorkerId!;
        await prepareWorkspace(w);
        await reportTurn(w, report({ status: "有问题", summary: "defect", verdict: "FAIL", sha: remoteHead }));
        ledger.hubCall(lin.sessionId, "worker.end", { workerId: w });
        ledger.hubCall(lin.sessionId, "graph.done", { graphId: baseGraph.id, nodeKey: k });
      }
      const wFix = graphNow(baseGraph.id).nodes.find((n) => n.key === "fix")!.activeWorkerId!;
      await prepareWorkspace(wFix);
      expect(git(workerRow(wFix).worktree_path, "rev-parse", "HEAD")).toBe(remoteHead);
      expect(git(workerRow(wFix).worktree_path, "rev-parse", "HEAD")).not.toBe(stale);
      ledger.hubCall(lin.sessionId, "graph.cancel", { graphId: baseGraph.id });

      const revChain = createGraph([
        { key: "impl", title: "Impl", brief: "Impl", deps: [] },
        { key: "rev1", title: "R1", brief: "R1", review: true, deps: ["impl"] },
        { key: "rev2", title: "R2", brief: "R2", review: true, deps: ["impl"] },
        { key: "rev3", title: "R3", brief: "R3", review: true, deps: ["rev1", "rev2"] },
      ]);
      const wImpl = revChain.nodes.find((n) => n.key === "impl")!.activeWorkerId!;
      await prepareWorkspace(wImpl);
      const impl = workerRow(wImpl);
      writeFileSync(join(impl.worktree_path, "a.ts"), "export const a = 41;\n");
      git(impl.worktree_path, "commit", "-am", "rev3 target");
      git(impl.worktree_path, "push", "--quiet", "origin", impl.branch!);
      const implSha = git(impl.worktree_path, "rev-parse", "HEAD");
      await reportTurn(wImpl, report({ summary: "done", commit: implSha }));

      for (const k of ["rev1", "rev2"] as const) {
        const w = graphNow(revChain.id).nodes.find((n) => n.key === k)!.activeWorkerId!;
        await prepareWorkspace(w);
        await reportTurn(w, report({ summary: "ok", verdict: "PASS", sha: implSha }));
        await runVerifyFor(w);
      }
      const wRev3 = graphNow(revChain.id).nodes.find((n) => n.key === "rev3")!.activeWorkerId!;
      await prepareWorkspace(wRev3);
      expect(parseReviewTarget(workerRow(wRev3).review_json)?.branch).toBe(impl.branch);
      expect(git(workerRow(wRev3).worktree_path, "rev-parse", "HEAD")).toBe(implSha);
    });

    it("S6: restart recovery before worktree.sync on a fan-in fix step re-enqueues sync, blocks premature worker.send, and finishes cleanly", async () => {
      const graph = createGraph([
        { key: "impl", title: "Impl", brief: "Impl", deps: [] },
        { key: "rev1", title: "R1", brief: "R1", review: true, deps: ["impl"] },
        { key: "rev2", title: "R2", brief: "R2", review: true, deps: ["impl"] },
        { key: "fix1", title: "Fix 1", brief: "Fix 1", deps: ["rev1", "rev2"] },
      ]);
      const wImpl = graph.nodes.find((n) => n.key === "impl")!.activeWorkerId!;
      await prepareWorkspace(wImpl);
      const impl = workerRow(wImpl);
      writeFileSync(join(impl.worktree_path, "a.ts"), "export const a = 50;\n");
      git(impl.worktree_path, "commit", "-am", "impl");
      git(impl.worktree_path, "push", "--quiet", "origin", impl.branch!);
      const sha = git(impl.worktree_path, "rev-parse", "HEAD");
      await reportTurn(wImpl, report({ summary: "done", commit: sha }));

      for (const k of ["rev1", "rev2"] as const) {
        const w = graphNow(graph.id).nodes.find((n) => n.key === k)!.activeWorkerId!;
        await prepareWorkspace(w);
        await reportTurn(w, report({ summary: "ok", verdict: "PASS", sha }));
        await runVerifyFor(w);
      }

      const wFix1 = graphNow(graph.id).nodes.find((n) => n.key === "fix1")!.activeWorkerId!;
      expect(workerRow(wFix1).worktree_path).toBe(impl.worktree_path);
      enqueued.length = 0;
      db.run("UPDATE actions SET status = 'failed' WHERE type = 'worktree.sync'");

      ledger.recoverAfterRestart();
      expect(enqueued.some((a) => a.type === "worktree.sync" && a.params.workerId === wFix1)).toBe(true);
      expect(enqueued.some((a) => a.type === "worktree.create" && a.params.workerId === wFix1)).toBe(false);
      expect(() => ledger.hubCall(lin.sessionId, "worker.send", { workerId: wFix1, text: "early" })).toThrow(/还在准备/);

      await runSync(wFix1);
      expect(enqueued.some((a) => a.type === "session.send" && a.params.sessionId === sessionOf(wFix1).id)).toBe(true);
    });

    it("S7/S10/S13: handles graph.patch, graph.skip, branch-sync rename, missing disk worktree degradation, manual takeover, and archive/unarchive", async () => {
      // 1) Patch fix1 after parallel reviews, skip rev2, rename impl branch in git, and verify manual worker.start takeover inherits impl.
      const graph = createGraph([
        { key: "impl", title: "Impl", brief: "Impl", deps: [] },
        { key: "rev1", title: "R1", brief: "R1", review: true, deps: ["impl"] },
        { key: "rev2", title: "R2", review: true, deps: ["impl"] },
      ]);
      const wImpl = graph.nodes.find((n) => n.key === "impl")!.activeWorkerId!;
      await prepareWorkspace(wImpl);
      const impl = workerRow(wImpl);
      git(impl.worktree_path, "branch", "-m", "feature/renamed-fanin");
      writeFileSync(join(impl.worktree_path, "a.ts"), "export const a = 60;\n");
      git(impl.worktree_path, "commit", "-am", "renamed");
      git(impl.worktree_path, "push", "--quiet", "origin", "feature/renamed-fanin");
      const sha = git(impl.worktree_path, "rev-parse", "HEAD");
      await reportTurn(wImpl, report({ summary: "done", commit: sha }));

      // PM archive & unarchive preserves active graph hold.
      ledger.archivePm(lin.pmId);
      expect(ledger.isWorkerCleanable(wImpl)).toBe(false);
      ledger.unarchivePm(lin.pmId);
      expect(ledger.isWorkerCleanable(wImpl)).toBe(false);

      const wRev1 = ledger.hubCall(lin.sessionId, "worker.start", {
        graphId: graph.id,
        node: "rev1",
        task: "Review after unarchive",
      }).data.worker.id;
      await prepareWorkspace(wRev1);
      expect(parseReviewTarget(workerRow(wRev1).review_json)?.branch).toBe("feature/renamed-fanin");

      await reportTurn(wRev1, report({ status: "有问题", summary: "fail", verdict: "FAIL", sha }));
      ledger.hubCall(lin.sessionId, "worker.end", { workerId: wRev1 });

      // Patch adds fix1 (manual, no brief) and settles rev1 + skips rev2.
      ledger.hubCall(lin.sessionId, "graph.patch", {
        graphId: graph.id,
        specJson: JSON.stringify({
          addSteps: [{ key: "fix1", title: "Manual Fix", deps: ["rev1", "rev2"] }],
          doneSteps: ["rev1"],
          skipSteps: ["rev2"],
        }),
      });
      expect(stateOf(graphNow(graph.id).nodes.find((n) => n.key === "fix1")!)).toBe("waiting:pm");

      // Delete impl worktree on disk before fix1 starts: must degrade cleanly to fork from feature/renamed-fanin (not main).
      rmSync(impl.worktree_path, { recursive: true, force: true });
      const wFix1 = ledger.hubCall(lin.sessionId, "worker.start", {
        graphId: graph.id,
        node: "fix1",
        task: "Fix after deleted worktree",
      }).data.worker.id;
      await prepareWorkspace(wFix1);
      expect(git(workerRow(wFix1).worktree_path, "rev-parse", "HEAD")).toBe(sha);
    });
  });

  describe("unchanged boundaries (regression baseline, passes before and after implementation)", () => {
    it("S5: true parallel multi-impl fan-in and explicit base=main after parallel reviews both start fresh off main", async () => {
      const mainSha = git(repoDir, "rev-parse", "main");

      // 1) True multi-impl fan-in: a, b -> merge starts fresh off main.
      const parallel = createGraph([
        { key: "a", title: "Impl A", brief: "A", deps: [] },
        { key: "b", title: "Impl B", brief: "B", deps: [] },
        { key: "merge", title: "Merge", brief: "Merge", deps: ["a", "b"] },
      ]);
      for (const k of ["a", "b"] as const) {
        const w = parallel.nodes.find((n) => n.key === k)!.activeWorkerId!;
        await prepareWorkspace(w);
        const dir = workerRow(w).worktree_path;
        writeFileSync(join(dir, `${k}.txt`), `${k}\n`);
        git(dir, "add", `${k}.txt`);
        git(dir, "commit", "-m", k);
        await reportTurn(w, report({ summary: `${k} done`, commit: git(dir, "rev-parse", "HEAD") }));
      }
      const wMerge = graphNow(parallel.id).nodes.find((n) => n.key === "merge")!.activeWorkerId!;
      await prepareWorkspace(wMerge);
      expect(git(workerRow(wMerge).worktree_path, "rev-parse", "HEAD")).toBe(mainSha);
      ledger.hubCall(lin.sessionId, "graph.cancel", { graphId: parallel.id });

      // 2) Explicit base: "main" after parallel reviews starts fresh off main.
      const baseMain = createGraph([
        { key: "impl", title: "Impl", brief: "Impl", deps: [] },
        { key: "rev1", title: "R1", brief: "R1", review: true, deps: ["impl"] },
        { key: "rev2", title: "R2", brief: "R2", review: true, deps: ["impl"] },
        { key: "nextPr", title: "Next PR", brief: "Next PR", base: "main", deps: ["rev1", "rev2"] },
      ]);
      const wImpl = baseMain.nodes.find((n) => n.key === "impl")!.activeWorkerId!;
      await prepareWorkspace(wImpl);
      const impl = workerRow(wImpl);
      writeFileSync(join(impl.worktree_path, "a.ts"), "export const a = 77;\n");
      git(impl.worktree_path, "commit", "-am", "impl");
      git(impl.worktree_path, "push", "--quiet", "origin", impl.branch!);
      const implSha = git(impl.worktree_path, "rev-parse", "HEAD");
      await reportTurn(wImpl, report({ summary: "done", commit: implSha }));

      for (const k of ["rev1", "rev2"] as const) {
        const w = graphNow(baseMain.id).nodes.find((n) => n.key === k)!.activeWorkerId!;
        await prepareWorkspace(w);
        await reportTurn(w, report({ summary: "ok", verdict: "PASS", sha: implSha }));
        await runVerifyFor(w);
      }
      const wNextPr = graphNow(baseMain.id).nodes.find((n) => n.key === "nextPr")!.activeWorkerId!;
      await prepareWorkspace(wNextPr);
      expect(workerRow(wNextPr).worktree_path).not.toBe(impl.worktree_path);
      expect(git(workerRow(wNextPr).worktree_path, "rev-parse", "HEAD")).toBe(mainSha);
    });
  });
});
