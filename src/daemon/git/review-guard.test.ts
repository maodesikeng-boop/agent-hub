// 审查只查不修的 git 层（docs/review-verify-only-design.md 第 3.1、3.2、3.4 节）：用真 git 和一个本地 bare 远端，三平台 CI 都跑。
// - 审查目录 detached 检出被审分支：里面提交不动被审分支，切到被审分支被 git 拒绝；
// - 启动准备（launch.ts）给审查 Worker 的环境变量让 git 推送被 pre-push 拒绝，远端不变；
// - 绕过钩子（--no-verify）推上去、update-ref 改本地分支：收尾核对都报“变了”。
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffReviewSnapshot, type AgentSessionRow, type ReviewSnapshot } from "../../shared/index.ts";
import { createReviewObserver } from "../handlers.ts";
import { createLaunchPreparer } from "../launch.ts";
import { workerContext } from "../test-helpers.ts";
import { addWorktree, remoteBranchHead, resolveCommit } from "./index.ts";

const IMPL = "hub/1-impl";
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] }).trim();

describe("审查目录与禁推（真 git）", () => {
  let root: string;
  let origin: string;
  let repo: string;
  let reviewDir: string;
  let snapshot: ReviewSnapshot;
  const observe = createReviewObserver({
    resolveCommit: (folder, ref) => resolveCommit(folder, ref),
    remoteBranchHead: (r, b, name) => remoteBranchHead(r, b, name),
    probePr: async () => null,
  });

  /** 审查 Worker 启动时拿到的环境变量：走真正的 createLaunchPreparer。 */
  const reviewLaunchEnv = async (): Promise<Record<string, string>> => {
    const dataDir = join(root, "data");
    const launchDir = join(dataDir, "state", "launch");
    mkdirSync(launchDir, { recursive: true });
    const sessionTmpDir = join(dataDir, "session-tmp");
    mkdirSync(sessionTmpDir, { recursive: true });
    const prepare = createLaunchPreparer({
      sessionTmp: { allocate: () => sessionTmpDir },
      launchDir,
      dataDir,
      stateDir: join(dataDir, "state"),
      osSandboxed: true,
      worktreesDir: join(dataDir, "worktrees"),
      getLaunchContext: () => workerContext({ worktreePath: reviewDir, branch: null, review: { branch: IMPL, snapshot } }),
      tokens: { issue: () => "t" },
      hubSock: join(dataDir, "run", "hub.sock"),
      hubBinDir: join(dataDir, "run", "bin"),
    });
    const files = await prepare({ id: 9, role: "worker", vendor: "claude", cwd: reviewDir, addDirs: [] } as unknown as AgentSessionRow);
    return files.env;
  };

  const pushAs = (env: Record<string, string>, ...args: string[]) =>
    spawnSync("git", ["push", ...args], { cwd: reviewDir, encoding: "utf8", env: { ...gitEnv, ...env } });

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-review-guard-")));
    origin = join(root, "origin.git");
    repo = join(root, "repo");
    reviewDir = join(root, "data", "worktrees", "1", "2");
    git(root, "init", "--bare", "-b", "main", origin);
    mkdirSync(repo);
    git(repo, "init", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-m", "init");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "origin", "main");
    // 实现 Worker 的 worktree 和分支，推到 origin
    const implDir = join(root, "data", "worktrees", "1", "1");
    await addWorktree({ repoFolder: repo, worktreePath: implDir, branch: IMPL });
    writeFileSync(join(implDir, "fix.txt"), "fix\n");
    git(implDir, "add", "fix.txt");
    git(implDir, "commit", "-m", "fix");
    git(implDir, "push", "origin", IMPL);

    const { baseCommit } = await addWorktree({ repoFolder: repo, worktreePath: reviewDir, branch: null, base: `refs/heads/${IMPL}` });
    snapshot = { sha: baseCommit, remote: (await remoteBranchHead(repo, IMPL)) ?? null, pr: null };
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("审查目录 detached 在被审分支的提交上；重复建算成功", async () => {
    expect(snapshot.sha).toBe(git(repo, "rev-parse", IMPL));
    expect(snapshot.remote).toEqual({ name: "origin", sha: snapshot.sha });
    expect(git(reviewDir, "rev-parse", "HEAD")).toBe(snapshot.sha);
    expect(spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: reviewDir }).status).not.toBe(0);
    const again = await addWorktree({ repoFolder: repo, worktreePath: reviewDir, branch: null, base: `refs/heads/${IMPL}` });
    expect(again).toEqual({ created: false, baseCommit: snapshot.sha });
  });

  it("在审查目录里提交：被审分支不动；切到被审分支被 git 拒绝", async () => {
    writeFileSync(join(reviewDir, "fix.txt"), "revert to prove the test fails\n");
    git(reviewDir, "commit", "-am", "local repro");
    expect(git(repo, "rev-parse", IMPL)).toBe(snapshot.sha);
    const checkout = spawnSync("git", ["checkout", IMPL], { cwd: reviewDir, encoding: "utf8", env: { ...gitEnv, LC_ALL: "C" } });
    expect(checkout.status).not.toBe(0);
    expect(checkout.stderr).toMatch(/already (checked out|used by worktree)/);
    expect(diffReviewSnapshot(IMPL, snapshot, await observe(repo, IMPL, snapshot))).toEqual([]);
  });

  it("带审查 Worker 的启动环境推送：pre-push 拒绝，远端不变", async () => {
    const env = await reviewLaunchEnv();
    const hook = join(env.GIT_CONFIG_VALUE_0!, "pre-push");
    expect(env).toMatchObject({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath" });
    if (process.platform !== "win32") expect(statSync(hook).mode & 0o111).not.toBe(0);
    writeFileSync(join(reviewDir, "fix.txt"), "reviewer fix\n");
    git(reviewDir, "commit", "-am", "reviewer fix");
    for (const target of [`HEAD:refs/heads/${IMPL}`, "HEAD:refs/heads/review-fix"]) {
      const pushed = pushAs(env, "origin", target);
      expect(pushed.status).not.toBe(0);
      expect(pushed.stderr).toContain("审查步骤只查不修");
    }
    expect(await remoteBranchHead(repo, IMPL)).toEqual({ name: "origin", sha: snapshot.sha });
    expect(await remoteBranchHead(repo, "review-fix")).toEqual({ name: "origin", sha: null });
    expect(diffReviewSnapshot(IMPL, snapshot, await observe(repo, IMPL, snapshot))).toEqual([]);
  });

  it("绕过钩子推上去、update-ref 改本地分支：收尾核对都报变了", async () => {
    const env = await reviewLaunchEnv();
    writeFileSync(join(reviewDir, "fix.txt"), "reviewer fix\n");
    git(reviewDir, "commit", "-am", "reviewer fix");
    const sneaky = git(reviewDir, "rev-parse", "HEAD");
    expect(pushAs(env, "--no-verify", "origin", `HEAD:refs/heads/${IMPL}`).status).toBe(0);
    expect(diffReviewSnapshot(IMPL, snapshot, await observe(repo, IMPL, snapshot))).toEqual([
      `origin 上的分支 ${IMPL} 从 ${snapshot.sha.slice(0, 12)} 变成了 ${sneaky.slice(0, 12)}`,
    ]);
    git(repo, "update-ref", `refs/heads/${IMPL}`, sneaky);
    expect(diffReviewSnapshot(IMPL, snapshot, await observe(repo, IMPL, snapshot))).toEqual([
      `本地分支 ${IMPL} 从 ${snapshot.sha.slice(0, 12)} 变成了 ${sneaky.slice(0, 12)}`,
      `origin 上的分支 ${IMPL} 从 ${snapshot.sha.slice(0, 12)} 变成了 ${sneaky.slice(0, 12)}`,
    ]);
  });
});
