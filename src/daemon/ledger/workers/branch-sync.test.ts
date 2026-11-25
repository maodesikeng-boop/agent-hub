import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionRow } from "../../../shared/actions.ts";
import type { TaskGraph, WorkerRecord } from "../../../shared/domain.ts";
import { REPORT_END, REPORT_START } from "../../../shared/worker.ts";
import { addWorktree } from "../../git/index.ts";
import { createWorktreeBranchProbe } from "../../git/worktree-branch.ts";
import { createWorktreeCreateHandler } from "../../handlers.ts";
import { workerOpsFixture } from "../test-helpers.ts";

describe("linked worktree branch reconciliation", () => {
  let f: ReturnType<typeof workerOpsFixture>;
  beforeEach(() => { f = workerOpsFixture({ worktreeBranchProbe: createWorktreeBranchProbe() }); });
  afterEach(() => f.close());

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

  const prepareRepo = () => {
    git(f.folder, "init", "-q", "-b", "main");
    git(f.folder, "commit", "--allow-empty", "-qm", "Initial");
  };

  const checkout = async (workerId: number) => {
    const action: ActionRow<"worktree.create"> = {
      id: 1, type: "worktree.create", params: { workerId }, dedupeKey: String(workerId), attempts: 0,
      status: "pending", createdAt: f.now(), updatedAt: f.now(), nextAttemptAt: f.now(), lastError: null,
    };
    const handle = createWorktreeCreateHandler({
      addWorktree, ledger: f.ledger,
      observeReview: async (cwd, branch) => ({ sha: git(cwd, "rev-parse", branch), remote: null, pr: null }),
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
});
