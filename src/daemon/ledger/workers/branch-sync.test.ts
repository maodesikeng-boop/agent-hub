import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionRow } from "../../../shared/actions.ts";
import { CONFIRM_PASS_OPTION, type TaskGraph, type WorkerRecord } from "../../../shared/domain.ts";
import { WORKER_LIST_RECENT_ENDED, WORKTREE_BRANCH_CACHE_MAX } from "../../../shared/limits.ts";
import { REPORT_END, REPORT_START } from "../../../shared/worker.ts";
import { addWorktree } from "../../git/index.ts";
import { createWorktreeBranchProbe } from "../../git/worktree-branch.ts";
import { createWorktreeCreateHandler } from "../../handlers.ts";
import { workerOpsFixture } from "../test-helpers.ts";

describe("linked worktree branch reconciliation", () => {
  let f: ReturnType<typeof workerOpsFixture>;
  let probe: ReturnType<typeof createWorktreeBranchProbe>;
  beforeEach(() => {
    probe = createWorktreeBranchProbe();
    f = workerOpsFixture({ worktreeBranchProbe: probe });
  });
  afterEach(() => f.close());

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

  const prepareRepo = () => {
    git(f.folder, "init", "-q", "-b", "main");
    git(f.folder, "commit", "--allow-empty", "-qm", "Initial");
  };
  const start = (title: string, graphId?: number, node?: string, task = "Change app") => f.ledger.hubCall(f.pm.sessionId, "worker.start", {
    title, task, graphId, node,
  }, { workspace: { kind: "ok", isRepoWithCommit: true, hasUncommittedChanges: false } }).data.worker;

  const checkout = async (workerId: number) => {
    const action: ActionRow<"worktree.create"> = {
      id: 1, type: "worktree.create", params: { workerId }, dedupeKey: String(workerId), attempts: 0,
      status: "pending", createdAt: f.now(), updatedAt: f.now(), nextAttemptAt: f.now(), lastError: null,
    };
    const handle = createWorktreeCreateHandler({
      addWorktree, ledger: f.ledger,
      resolveTip: async (cwd, branch) => ({ commit: git(cwd, "rev-parse", branch), local: git(cwd, "rev-parse", branch), remote: null, findings: [] }),
      probePr: async () => null,
      setup: { start: vi.fn() },
      setupLogPath: () => join(f.root, "setup.log"),
    });
    expect(await handle(action)).toEqual({ kind: "done" });
  };

  const complete = async (worker: WorkerRecord) => {
    f.begin(worker.id);
    f.emit(worker.id, {
      type: "agent.text", uuid: "implementation-complete", at: f.now(),
      text: `${REPORT_START}\n状态: 做完了\n摘要: Work complete\n问题: 无\n${REPORT_END}`,
    });
    f.end(worker.id);
    await f.ledger.settleDriverEvents();
  };

  it("reconciles every Worker on the renamed worktree, updates artifacts, and checks out the review detached", async () => {
    prepareRepo();
    const probePr = vi.fn(async () => null);
    const api = f.api({ probePr });
    const { id: graphId } = f.hub("graph.create", { specJson: JSON.stringify({
      title: "Branch continuity", nodes: [
        { key: "impl", title: "Implement" },
        { key: "review", title: "Review", review: true, vendor: "codex", deps: ["impl"] },
      ],
    }) }).data.graph;
    const start = async (node: string): Promise<WorkerRecord> => {
      const result = await api("worker.start", { graphId, node, task: "Carry out the assigned step" });
      expect(result.statusCode, result.body).toBe(200);
      return result.json<{ data: { worker: WorkerRecord } }>().data.worker;
    };
    const first = await start("impl");
    await checkout(first.id);
    const cwd = first.worktreePath!;
    const original = first.branch!;
    git(cwd, "branch", "-m", "feature/renamed");
    const second = await start("impl");
    expect(second).toMatchObject({ branch: "feature/renamed", worktreePath: cwd });
    f.ledger.onWorktreeSynced(second.id, null);
    expect(f.ledger.listWorktreeBranchTargets?.({ pmId: f.pm.pm.id })).toEqual([{ worktreePath: cwd, branch: "feature/renamed" }]);
    expect(f.ledger.listWorktreeBranchTargets?.({ workerId: first.id })).toEqual([{ worktreePath: cwd, branch: "feature/renamed" }]);
    expect(f.ledger.listWorktreeBranchTargets?.({ graphId })).toEqual([{ worktreePath: cwd, branch: "feature/renamed" }]);
    expect((await api("worker.list", {})).json().data.workers).toEqual([
      expect.objectContaining({ id: first.id, branch: "feature/renamed" }),
      expect.objectContaining({ id: second.id, branch: "feature/renamed" }),
    ]);
    await complete(second);
    const onChange = vi.fn();
    f.ledger.onChange(onChange);
    git(cwd, "branch", "-m", "feature/reviewed");
    const graph = await api("graph.show", { graphId });
    const shown = graph.json<{ text: string; data: { graph: TaskGraph } }>();
    expect(shown.data.graph.nodes[0]?.artifact?.branch).toBe("feature/reviewed");
    expect(shown.text).toContain("分支 feature/reviewed");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ type: "task_graph.updated", data: expect.objectContaining({ graph: expect.objectContaining({ id: graphId }) }) }));
    expect((await api("worker.show", { workerId: second.id })).json().text).toContain("分支 feature/reviewed");
    expect(probePr).toHaveBeenCalledWith(cwd, "feature/reviewed");
    expect(git(f.folder, "branch", "--list", original)).toBe("");

    const reviewer = await start("review");
    await checkout(reviewer.id);
    expect(git(reviewer.worktreePath!, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(git(reviewer.worktreePath!, "rev-parse", "HEAD")).toBe(git(cwd, "rev-parse", "HEAD"));
    expect((await api("worker.show", { workerId: reviewer.id })).json().text).toContain("审查分支 feature/reviewed（detached）");

    git(cwd, "checkout", "-q", "--detach", "HEAD");
    expect((await api("worker.show", { workerId: first.id })).json().text).toContain("分支 feature/reviewed");
    expect(f.ledger.listWorktreeBranchTargets?.({ workerId: reviewer.id })).toEqual([]);
    onChange.mockClear();
    expect(f.ledger.syncWorktreeBranch?.(cwd, "feature/reviewed")).toEqual({ updatedWorkerIds: [], updatedGraphIds: [] });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reconciles at turn settlement before recording the artifact and leaves other worktrees and main-folder Workers alone", async () => {
    prepareRepo();
    const { id: graphId } = f.hub("graph.create", { specJson: '{"title":"Turn settlement","nodes":[{"key":"impl","title":"Implement"}]}' }).data.graph;
    const main = f.hub("worker.start", { title: "Main", task: "Look around", noWorktree: true }).data.worker;
    const workspace = { kind: "ok", isRepoWithCommit: true, hasUncommittedChanges: false } as const;
    const start = (title: string, node?: string) => f.ledger.hubCall(f.pm.sessionId, "worker.start", { title, task: "Change app", graphId, node }, { workspace }).data.worker;
    const worker = start("Implementation", "impl");
    const separate = start("Unrelated");
    await checkout(worker.id);
    await checkout(separate.id);
    git(worker.worktreePath!, "branch", "-m", "feature/settled");
    await complete(worker);
    expect(f.hub("graph.show", { graphId }).data.graph.nodes[0]?.artifact?.branch).toBe("feature/settled");
    expect(f.hub("worker.show", { workerId: separate.id }).data.worker.branch).toBe(separate.branch);
    expect(f.ledger.listWorktreeBranchTargets?.({ workerId: main.id })).toEqual([]);
  });

  it("keeps the graph's ready time when a branch rename refreshes a finished step", async () => {
    prepareRepo();
    const { id: graphId } = f.hub("graph.create", { specJson: '{"title":"Ready time","nodes":[{"key":"impl","title":"Implement"}]}' }).data.graph;
    const impl = start("Implementation", graphId, "impl");
    await checkout(impl.id);
    f.advance(60_000);
    await complete(impl);
    const readyAt = f.now();
    expect(f.hub("graph.show", { graphId }).data.graph.readySince).toBe(readyAt);

    f.advance(7 * 60_000);
    const onChange = vi.fn();
    f.ledger.onChange(onChange);
    git(impl.worktreePath!, "branch", "-m", "feature/after-ready");
    await f.ledger.reconcileHubBranches?.(f.pm.sessionId, "graph.list", {}, new AbortController().signal);
    const pushed = onChange.mock.calls.map(([change]) => change).find((change) => change.type === "task_graph.updated")?.data.graph as TaskGraph;
    expect(pushed.nodes[0]).toMatchObject({ status: "done", updatedAt: f.now(), artifact: expect.objectContaining({ branch: "feature/after-ready" }) });
    expect(pushed.readySince).toBe(readyAt);
    expect(f.ledger.snapshot().activeTaskGraphs.find((graph) => graph.id === graphId)?.readySince).toBe(readyAt);
  });

  it.each(["manual start", "takeover", "user decision", "user skip", "background exit"])(
    "checks out the renamed upstream branch after %s",
    async (trigger) => {
      prepareRepo();
      const { id: graphId } = f.hub("graph.create", { specJson: JSON.stringify({
        title: "Review after rename",
        nodes: [
          { key: "impl", title: "Implement", confirm: trigger === "user decision" },
          ...(trigger === "user skip" ? [{ key: "optional", title: "Optional", deps: ["impl"] }] : []),
          {
            key: "review", title: "Review", vendor: "codex", review: true,
            deps: [trigger === "user skip" ? "optional" : "impl"],
            ...(trigger === "manual start" || trigger === "takeover" ? {} : { brief: "Review the changes" }),
          },
        ],
      }) }).data.graph;
      const impl = start("Implementation", graphId, "impl");
      await checkout(impl.id);
      if (trigger === "background exit") f.emit(impl.id, { type: "background.changed", count: 1, at: f.now() });
      await complete(impl);
      if (trigger === "takeover") start("First review", graphId, "review");
      const originalBranchNote = `Keep this historical branch reference:\n- 分支：${impl.branch}`;
      const manual = trigger === "manual start" || trigger === "takeover"
        ? start("Review", graphId, "review", originalBranchNote)
        : null;
      git(impl.worktreePath!, "branch", "-m", "feature/renamed-before-review");
      if (trigger === "user decision") {
        f.hub("ask", { graphId, node: "impl", text: "Approve the implementation?" });
        f.ledger.decideTaskNode(graphId, "impl", { choice: CONFIRM_PASS_OPTION, clientId: "approve" });
      } else if (trigger === "user skip") {
        f.ledger.skipTaskNode(graphId, "optional", { reason: "Skip optional work" });
      } else if (trigger === "background exit") {
        f.emit(impl.id, { type: "background.changed", count: 0, at: f.now() });
        f.emit(impl.id, {
          type: "session.exited", reason: "idle", exitCode: 0, signal: null, hadResult: true, messageIds: [], at: f.now(),
        });
        await f.ledger.settleDriverEvents();
      }
      const reviewId = f.hub("graph.show", { graphId }).data.graph.nodes.find((n) => n.key === "review")?.activeWorkerId;
      if (reviewId == null) throw new Error("Review was not dispatched");
      if (manual !== null) expect(reviewId).toBe(manual.id);
      const reviewer = f.hub("worker.show", { workerId: reviewId }).data.worker;
      expect(reviewer.review?.snapshot).toBeNull();
      await checkout(reviewId);
      const sha = git(impl.worktreePath!, "rev-parse", "HEAD");
      expect(git(reviewer.worktreePath!, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
      expect(git(reviewer.worktreePath!, "rev-parse", "HEAD")).toBe(sha);
      expect(f.hub("worker.show", { workerId: reviewId }).data.worker.review).toMatchObject({
        branch: "feature/renamed-before-review", snapshot: { sha },
      });
      const firstMessage = f.ledger.getMessage(f.messageOf(reviewId))?.text;
      expect(firstMessage).toContain(trigger === "takeover"
        ? "detached 在被审分支 feature/renamed-before-review 上"
        : "detached 在被审分支 feature/renamed-before-review 的提交上");
      expect(firstMessage?.split("\n")).toContain("- 分支：feature/renamed-before-review");
      if (manual !== null) expect(firstMessage).toContain(originalBranchNote);
      else expect(firstMessage?.split("\n")).not.toContain(`- 分支：${impl.branch}`);
      git(impl.worktreePath!, "branch", "-m", "feature/renamed-after-review");
      await f.ledger.reconcileWorkerGraph?.(reviewId);
      expect(f.ledger.getWorktreeTask(reviewId)?.checkout).toEqual({ kind: "review", branch: "feature/renamed-before-review" });
    },
  );

  it("keeps an explicit review base when the upstream branch is renamed", async () => {
    prepareRepo();
    const { id: graphId } = f.hub("graph.create", { specJson: JSON.stringify({
      title: "Explicit base",
      nodes: [
        { key: "impl", title: "Implement" },
        { key: "review", title: "Review", vendor: "codex", review: true, base: "pinned", deps: ["impl"] },
      ],
    }) }).data.graph;
    git(f.folder, "branch", "pinned");
    const impl = start("Implementation", graphId, "impl");
    await checkout(impl.id);
    git(impl.worktreePath!, "commit", "--allow-empty", "-qm", "Implementation");
    await complete(impl);
    const review = start("Review", graphId, "review");
    git(impl.worktreePath!, "branch", "-m", "feature/renamed");
    await checkout(review.id);
    const sha = git(f.folder, "rev-parse", "pinned");
    expect(git(review.worktreePath!, "rev-parse", "HEAD")).toBe(sha);
    expect(f.hub("worker.show", { workerId: review.id }).data.worker.review).toMatchObject({ branch: "pinned", snapshot: { sha } });
  });

  it("refreshes only open, active graph, and recent worktrees, while finding an older Worker by ID", async () => {
    const { id: graphId } = f.hub("graph.create", { specJson: '{"title":"Active graph","nodes":[{"key":"impl","title":"Implement"}]}' }).data.graph;
    const seed = (title: string, graph?: number, node?: string) => {
      const worker = start(title, graph, node);
      f.ledger.onWorktreeCreated(worker.id, "base");
      return worker;
    };
    const upstream = seed("Upstream", graphId, "impl");
    await complete(upstream);
    const old = seed("Old");
    f.hub("worker.end", { workerId: old.id });
    const ended = Array.from({ length: 300 }, (_, i) => {
      f.advance(1);
      const worker = seed(`Worker ${i}`);
      f.hub("worker.end", { workerId: worker.id });
      return worker;
    });
    const open = seed("Open");
    const read = vi.spyOn(probe, "readBranch").mockResolvedValue("feature/current");
    const api = f.api();
    expect((await api("worker.list", {})).statusCode).toBe(200);
    expect(read.mock.calls.map(([path]) => path)).toHaveLength(WORKER_LIST_RECENT_ENDED + 2);
    expect(new Set(read.mock.calls.map(([path]) => path))).toEqual(new Set(
      [open, upstream, ...ended.slice(-WORKER_LIST_RECENT_ENDED)].map((worker) => worker.worktreePath),
    ));
    read.mockClear();
    expect((await api("worker.show", { workerId: old.id })).json().data.worker.branch).toBe("feature/current");
    expect(read.mock.calls).toEqual([[old.worktreePath]]);
  });

  it("caps a PM-wide probe and prioritizes open worktrees over ended ones", async () => {
    const open = Array.from({ length: WORKTREE_BRANCH_CACHE_MAX + 1 }, (_, i) => {
      const worker = start(`Open ${i}`);
      f.ledger.onWorktreeCreated(worker.id, "base");
      return worker;
    });
    const ended = start("Recently ended");
    f.ledger.onWorktreeCreated(ended.id, "base");
    f.hub("worker.end", { workerId: ended.id });
    const read = vi.spyOn(probe, "readBranch").mockResolvedValue(null);
    await f.ledger.reconcileHubBranches?.(f.pm.sessionId, "graph.list", {}, new AbortController().signal);
    expect(read).toHaveBeenCalledTimes(WORKTREE_BRANCH_CACHE_MAX);
    expect(new Set(read.mock.calls.map(([path]) => path))).toEqual(new Set(open.slice(1).map((worker) => worker.worktreePath)));
  });

  it("does not touch the database when a pending probe returns after ledger shutdown", async () => {
    const worker = start("Closing");
    f.ledger.onWorktreeCreated(worker.id, "base");
    let resolve!: (branch: string) => void;
    const pending = new Promise<string>((done) => { resolve = done; });
    vi.spyOn(probe, "readBranch").mockReturnValue(pending);
    const reconciliation = f.ledger.reconcileWorkerGraph?.(worker.id);
    expect(reconciliation).toBeInstanceOf(Promise);
    f.ledger.close();
    const get = vi.spyOn(f.db, "get");
    resolve("feature/after-shutdown");
    await reconciliation;
    expect(get).not.toHaveBeenCalled();
  });
});
