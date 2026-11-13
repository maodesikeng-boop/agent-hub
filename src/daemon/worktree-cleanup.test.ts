// Worker worktree 自动清理测试（全部使用临时目录和临时 git 仓库，绝不碰真实 ~/.agent-hub/worktrees）：
// 覆盖：已合并删（分支保留） / 收工满 3 天且干净删（分支保留） / 有改动不删（含已跟踪修改、暂存、未跟踪文件；PR 已合并也不删） /
// 在跑不删 / 不用 worktree 跳过 / 不在 worktrees 目录下不删（含符号链接越界） / 手动删过的跳过 /
// git worktree remove 失败记日志下轮重试并 prune / 每轮上限与轮转 / 没候选时零 git 调用 /
// 孤儿目录（外部解绑残留）/ detached HEAD 与 review-* 分支 / 0 提交探索目录 / rebase 中途 / status.showUntrackedFiles=no 时未跟踪文件照样拦 / 被忽略的文件随目录删 / 相对路径不删。
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PmId, SessionId, WorkerId, WorkerRecord } from "../shared/domain.ts";
import { PM_ARCHIVE_RETENTION_MS, WORKTREE_CLEANUP_BATCH_LIMIT, WORKTREE_RETENTION_MS } from "../shared/limits.ts";
import { projectWorktreesDir, workerWorktreePath } from "../shared/paths.ts";
import { writeExecutableNodeScript } from "../../test/fake-cli-shim.ts";
import { addWorktree } from "./git/index.ts";
import { createResolveFolder } from "./ledger/files.ts";
import { createLedger, type SqliteLedger } from "./ledger/index.ts";
import { ensureProjectWorktreeBridge, loadManagedWorktreeRoots, registerManagedWorktreeRoot } from "./platform/index.ts";
import { openTestDb } from "./store/test-helpers.ts";
import type { Db } from "./store/index.ts";
import { createWorktreeCleanup } from "./worktree-cleanup.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull },
  }).trim();
}

const T0 = 1_700_000_000_000;

let db: Db;
let root: string;
let dataHome: string;
let worktreesDir: string;
let repo: string;
let now: number;
let logs: string[];
let ledger: SqliteLedger;
let pm: { pmId: PmId; sessionId: SessionId };

beforeEach(() => {
  db = openTestDb();
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-wt-cleanup-")));
  dataHome = join(root, ".agent-hub");
  worktreesDir = join(dataHome, "worktrees");
  mkdirSync(worktreesDir, { recursive: true });
  repo = join(root, "work", "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "init\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");

  now = T0;
  logs = [];
  ledger = createLedger(db, {
    now: () => now,
    initialSeq: 1_000,
    pmHomeRoot: join(dataHome, "pm-home"),
    dataHome,
    worktreesDir,
    resolveFolder: createResolveFolder({ dataHome, userHome: root }),
  });
  const created = ledger.createPm({ name: "小林", mode: "manage_only", persona: "", folder: repo });
  pm = { pmId: created.pm.id, sessionId: created.sessionId };
});

afterEach(() => {
  vi.unstubAllEnvs();
  ledger.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function spawnWorktreeWorker(title = "修功能"): Promise<WorkerRecord> {
  const started = ledger.hubCall(
    pm.sessionId,
    "worker.start",
    { title, task: "把功能修好", vendor: "claude" },
    { workspace: { kind: "ok", isRepoWithCommit: true, hasUncommittedChanges: false } },
  ).data.worker;
  const wt = await addWorktree({ repoFolder: repo, worktreePath: started.worktreePath!, branch: started.branch! });
  ledger.onWorktreeCreated(started.id, wt.baseCommit);
  return ledger.hubCall(pm.sessionId, "worker.show", { workerId: started.id }).data.worker;
}

function endWorker(workerId: WorkerId): string {
  return ledger.hubCall(pm.sessionId, "worker.end", { workerId }).text;
}

function showWorker(workerId: WorkerId): string {
  return ledger.hubCall(pm.sessionId, "worker.show", { workerId }).text;
}

function branchExists(branch: string): boolean {
  return git(repo, "branch", "--list", branch) !== "";
}

describe("worktree 自动清理", () => {
  it("PR 已合并（分支已合入 main 或 origin/main）且干净：未满 3 天也自动删 worktree，保留分支，show 显示（已自动清理）", async () => {
    const w = await spawnWorktreeWorker("合并删");
    writeFileSync(join(w.worktreePath!, "feature.txt"), "done\n");
    git(w.worktreePath!, "add", "-A");
    git(w.worktreePath!, "commit", "-q", "-m", "feat");
    // 合入 main（模拟 PR 合并）
    git(repo, "merge", "--no-ff", "-q", "-m", "Merge PR", w.branch!);

    const endText = endWorker(w.id);
    expect(endText).toContain("PR 合并后或收工满 3 天且没有未提交改动时会自动清理 worktree（分支保留；");

    // 刚收工 1 分钟（远未满 3 天）
    now += 60_000;
    const cleanup = createWorktreeCleanup({ ledger, worktreesDir, log: (l) => logs.push(l), now: () => now });
    const cleaned = await cleanup.runOnce();

    expect(cleaned).toEqual([w.id]);
    expect(existsSync(w.worktreePath!)).toBe(false);
    expect(branchExists(w.branch!)).toBe(true);
    expect(showWorker(w.id)).toContain(`分支 ${w.branch}，worktree ${w.worktreePath}（已自动清理）`);
    expect(ledger.workerPrTarget(pm.sessionId, w.id)).toEqual({ cwd: repo, branch: w.branch });
  });

  it("收工的 0 提交干净目录（HEAD === baseCommit、HEAD 在 main 历史里）：下一轮就删，保留分支；有未提交/未跟踪文件的照旧不删", async () => {
    const w = await spawnWorktreeWorker("零提交");
    const dirty = await spawnWorktreeWorker("零提交但有未跟踪文件");
    writeFileSync(join(dirty.worktreePath!, "half-done.md"), "写了一半\n");
    const dirtyModified = await spawnWorktreeWorker("零提交但改了已跟踪文件");
    writeFileSync(join(dirtyModified.worktreePath!, "README.md"), "改了一半\n");
    const dirtyStaged = await spawnWorktreeWorker("零提交但有暂存文件");
    writeFileSync(join(dirtyStaged.worktreePath!, "staged-zero.txt"), "暂存\n");
    git(dirtyStaged.worktreePath!, "add", "staged-zero.txt");
    endWorker(w.id);
    endWorker(dirty.id);
    endWorker(dirtyModified.id);
    endWorker(dirtyStaged.id);

    now += 60_000;
    const cleanup = createWorktreeCleanup({ ledger, worktreesDir, log: (l) => logs.push(l), now: () => now });
    expect(await cleanup.runOnce()).toEqual([w.id]);
    expect(existsSync(w.worktreePath!)).toBe(false);
    expect(branchExists(w.branch!)).toBe(true);
    expect(existsSync(dirty.worktreePath!)).toBe(true);
    expect(existsSync(dirtyModified.worktreePath!)).toBe(true);
    expect(existsSync(dirtyStaged.worktreePath!)).toBe(true);

    now += WORKTREE_RETENTION_MS;
    expect(await cleanup.runOnce()).toEqual([]);
    expect(existsSync(dirty.worktreePath!)).toBe(true);
    expect(existsSync(dirtyModified.worktreePath!)).toBe(true);
    expect(existsSync(dirtyStaged.worktreePath!)).toBe(true);
  });

  it("有未合并提交的分支：3 天内保留，满 3 天后清目录、保留分支", async () => {
    const w = await spawnWorktreeWorker("有未合并提交");
    writeFileSync(join(w.worktreePath!, "c.txt"), "1\n");
    git(w.worktreePath!, "add", "-A");
    git(w.worktreePath!, "commit", "-q", "-m", "c");
    endWorker(w.id);
    const cleanup = createWorktreeCleanup({ ledger, worktreesDir, log: (l) => logs.push(l), now: () => now });
    now += 60_000;
    expect(await cleanup.runOnce()).toEqual([]);
    expect(existsSync(w.worktreePath!)).toBe(true);
    now = T0 + WORKTREE_RETENTION_MS;
    expect(await cleanup.runOnce()).toEqual([w.id]);
    expect(existsSync(w.worktreePath!)).toBe(false);
    expect(branchExists(w.branch!)).toBe(true);
  });

  it("已收工满 3 天且没有未提交改动：即使分支未合并也自动删 worktree，保留分支；未满 3 天且未合并的不删", async () => {
    const w = await spawnWorktreeWorker("满三天删");
    writeFileSync(join(w.worktreePath!, "unmerged.txt"), "wip\n");
    git(w.worktreePath!, "add", "-A");
    git(w.worktreePath!, "commit", "-q", "-m", "unmerged commit");
    endWorker(w.id);

    const cleanup = createWorktreeCleanup({ ledger, worktreesDir, log: (l) => logs.push(l), now: () => now });

    // 差 1 毫秒到 3 天：不删
    now = T0 + WORKTREE_RETENTION_MS - 1;
    expect(await cleanup.runOnce()).toEqual([]);
    expect(existsSync(w.worktreePath!)).toBe(true);
    expect(showWorker(w.id)).not.toContain("（已自动清理）");

    // 满 3 天：自动删，分支仍在
    now = T0 + WORKTREE_RETENTION_MS;
    expect(await cleanup.runOnce()).toEqual([w.id]);
    expect(existsSync(w.worktreePath!)).toBe(false);
    expect(branchExists(w.branch!)).toBe(true);
    expect(showWorker(w.id)).toContain(`分支 ${w.branch}，worktree ${w.worktreePath}（已自动清理）`);
  });

  it("有未提交改动（修改已跟踪文件、暂存文件、未跟踪文件）：即使满 3 天或 PR 已合并也绝不删", async () => {
    // 1. 已跟踪文件修改 + 满 3 天
    const wModified = await spawnWorktreeWorker("改了已跟踪文件");
    writeFileSync(join(wModified.worktreePath!, "README.md"), "dirty\n");
    endWorker(wModified.id);

    // 2. 未跟踪文件 + PR 已合并 + 满 3 天
    const wUntracked = await spawnWorktreeWorker("有未跟踪文件且已合并");
    writeFileSync(join(wUntracked.worktreePath!, "merged.txt"), "ok\n");
    git(wUntracked.worktreePath!, "add", "-A");
    git(wUntracked.worktreePath!, "commit", "-q", "-m", "merged");
    git(repo, "merge", "--no-ff", "-q", "-m", "Merge", wUntracked.branch!);
    writeFileSync(join(wUntracked.worktreePath!, "leftover-note.txt"), "keep me\n");
    endWorker(wUntracked.id);

    // 3. 已暂存未提交 + 满 3 天
    const wStaged = await spawnWorktreeWorker("有暂存改动");
    writeFileSync(join(wStaged.worktreePath!, "staged.txt"), "staged\n");
    git(wStaged.worktreePath!, "add", "staged.txt");
    endWorker(wStaged.id);

    now += WORKTREE_RETENTION_MS + 10_000;
    const cleanup = createWorktreeCleanup({ ledger, worktreesDir, log: (l) => logs.push(l), now: () => now });
    expect(await cleanup.runOnce()).toEqual([]);

    expect(existsSync(wModified.worktreePath!)).toBe(true);
    expect(existsSync(wUntracked.worktreePath!)).toBe(true);
    expect(existsSync(wStaged.worktreePath!)).toBe(true);
  });

  it("rebase 停在一半、或有脏改动：满 3 天也绝不删（含 detached HEAD 已合并的情况）", async () => {
    const wRebase = await spawnWorktreeWorker("rebase 停在一半");
    for (const name of ["r1", "r2"]) {
      writeFileSync(join(wRebase.worktreePath!, name), `${name}\n`);
      git(wRebase.worktreePath!, "add", "-A");
      git(wRebase.worktreePath!, "commit", "-q", "-m", name);
    }
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "rebase", "-q", "-i", "HEAD~2"], {
      cwd: wRebase.worktreePath!,
      env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_SEQUENCE_EDITOR: "sed -i.bak s/^pick/edit/" },
    });
    expect(git(wRebase.worktreePath!, "status", "--porcelain")).toBe("");
    // 合入 main，让“已合并”也成立：rebase 中途仍然不删
    git(repo, "merge", "--no-ff", "-q", "-m", "Merge", wRebase.branch!);
    endWorker(wRebase.id);

    const wDirtyDetached = await spawnWorktreeWorker("detached 且有脏改动");
    git(wDirtyDetached.worktreePath!, "checkout", "-q", "--detach");
    writeFileSync(join(wDirtyDetached.worktreePath!, "README.md"), "dirty\n");
    endWorker(wDirtyDetached.id);

    now += WORKTREE_RETENTION_MS + 10_000;
    const cleanup = createWorktreeCleanup({ ledger, worktreesDir, log: (l) => logs.push(l), now: () => now });
    expect(await cleanup.runOnce()).toEqual([]);
    expect(existsSync(wRebase.worktreePath!)).toBe(true);
    expect(existsSync(wDirtyDetached.worktreePath!)).toBe(true);
  });

  it("审查 Worker detached HEAD / review-* 分支且提交已合入 main：未满 3 天立即清理", async () => {
    const w = await spawnWorktreeWorker("被审的 PR");
    writeFileSync(join(w.worktreePath!, "pr.txt"), "pr\n");
    git(w.worktreePath!, "add", "-A");
    git(w.worktreePath!, "commit", "-q", "-m", "pr");
    const prSha = git(w.worktreePath!, "rev-parse", "HEAD");
    // 登记分支回退到起点，模拟“登记的分支没合入，真正合入的是 HEAD 所在提交”（审查 Worker 自己 checkout 了 PR 提交）
    git(w.worktreePath!, "checkout", "-q", "--detach", prSha);
    git(repo, "merge", "--ff-only", "-q", prSha);
    git(repo, "branch", "-f", w.branch!, w.baseCommit!);
    endWorker(w.id);

    const wReview = await spawnWorktreeWorker("review-304");
    git(wReview.worktreePath!, "checkout", "-q", "-b", "review-304", prSha);
    endWorker(wReview.id);

    now += 60_000;
    const cleanup = createWorktreeCleanup({ ledger, worktreesDir, log: (l) => logs.push(l), now: () => now });
    expect(await cleanup.runOnce()).toEqual([w.id, wReview.id]);
    expect(existsSync(w.worktreePath!)).toBe(false);
    expect(existsSync(wReview.worktreePath!)).toBe(false);
    expect(branchExists("review-304")).toBe(true);
    expect(git(repo, "branch", "--list", "hub/detached-*")).toBe("");
  });

  it("detached HEAD 有未合入提交：未满 3 天不删；满 3 天先建保底分支再删目录，提交仍可找回", async () => {
    const w = await spawnWorktreeWorker("detached 有提交");
    git(w.worktreePath!, "checkout", "-q", "--detach");
    writeFileSync(join(w.worktreePath!, "only-on-head.txt"), "1\n");
    git(w.worktreePath!, "add", "-A");
    git(w.worktreePath!, "commit", "-q", "-m", "detached commit");
    const sha = git(w.worktreePath!, "rev-parse", "HEAD");
    endWorker(w.id);

    // 另一个 detached HEAD 已在 main 历史里且满 3 天：直接删目录，不建多余 hub/detached-* 分支垃圾
    const wMergedDetached = await spawnWorktreeWorker("detached 已合入满 3 天");
    git(wMergedDetached.worktreePath!, "checkout", "-q", "--detach");
    endWorker(wMergedDetached.id);

    // 另一个 detached HEAD 有未合入提交，但建保底引用失败（同名命名空间冲突）：绝不继续删目录丢提交
    const wPinFail = await spawnWorktreeWorker("detached 保底引用失败");
    git(wPinFail.worktreePath!, "checkout", "-q", "--detach");
    writeFileSync(join(wPinFail.worktreePath!, "must-not-lose.txt"), "precious\n");
    git(wPinFail.worktreePath!, "add", "-A");
    git(wPinFail.worktreePath!, "commit", "-q", "-m", "precious detached");
    const failSha = git(wPinFail.worktreePath!, "rev-parse", "HEAD");
    git(repo, "branch", `hub/detached-${wPinFail.id}-${failSha.slice(0, 8)}/conflict`, "main");
    endWorker(wPinFail.id);

    const cleanup = createWorktreeCleanup({ ledger, worktreesDir, log: (l) => logs.push(l), now: () => now });
    now = T0 + WORKTREE_RETENTION_MS - 1;
    expect(await cleanup.runOnce()).toEqual([wMergedDetached.id]);
    expect(existsSync(w.worktreePath!)).toBe(true);
    expect(existsSync(wPinFail.worktreePath!)).toBe(true);
    expect(git(repo, "branch", "--list", `hub/detached-${wMergedDetached.id}-*`)).toBe("");

    // 再测一个满 3 天才跑首轮且 detached HEAD 已在 main 历史里的：同样不建多余分支
    const wMergedExpired = await spawnWorktreeWorker("detached 已合入满 3 天首轮");
    git(wMergedExpired.worktreePath!, "checkout", "-q", "--detach");
    endWorker(wMergedExpired.id);

    now = T0 + WORKTREE_RETENTION_MS * 2;
    expect(await cleanup.runOnce()).toEqual([w.id, wMergedExpired.id]);
    expect(existsSync(w.worktreePath!)).toBe(false);
    expect(existsSync(wMergedExpired.worktreePath!)).toBe(false);
    expect(git(repo, "branch", "--list", `hub/detached-${wMergedExpired.id}-*`)).toBe("");
    const pin = `hub/detached-${w.id}-${sha.slice(0, 8)}`;
    expect(git(repo, "rev-parse", pin)).toBe(sha);
    expect(git(repo, "show", `${pin}:only-on-head.txt`)).toBe("1");

    // 建保底分支失败的目录与提交文件完好保留，并记失败日志
    expect(existsSync(wPinFail.worktreePath!)).toBe(true);
    expect(readFileSync(join(wPinFail.worktreePath!, "must-not-lose.txt"), "utf8")).toBe("precious\n");
    expect(logs.some((l) => l.includes(`worker #${wPinFail.id}`) && l.includes("保全 detached HEAD 失败"))).toBe(true);
  });

  it("孤儿目录（外部解除 .git/worktrees/<id> 关联后残留，只剩忽略目录）：被安全清理，分支保留；有未忽略的用户文件则保留", async () => {
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n.codegraph/\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "ignore");
    const make = async (title: string) => {
      const w = await spawnWorktreeWorker(title);
      mkdirSync(join(w.worktreePath!, "node_modules", "x"), { recursive: true });
      writeFileSync(join(w.worktreePath!, "node_modules", "x", "i.js"), "1\n");
      mkdirSync(join(w.worktreePath!, ".codegraph"), { recursive: true });
      writeFileSync(join(w.worktreePath!, ".codegraph", "codegraph.db"), "db\n");
      endWorker(w.id);
      return w;
    };
    const wLinkGone = await make("登记目录被删");
    const wNoDotGit = await make(".git 文件没了");
    const wUser = await make("有用户文件");
    for (const w of [wLinkGone, wUser]) {
      const name = readFileSync(join(w.worktreePath!, ".git"), "utf8").trim().split("/").pop()!;
      rmSync(join(repo, ".git", "worktrees", name), { recursive: true, force: true });
    }
    rmSync(join(wNoDotGit.worktreePath!, ".git"));
    git(repo, "worktree", "prune");
    writeFileSync(join(wUser.worktreePath!, "my-notes.md"), "别删\n");

    // 分支未合并、未满 3 天：先不动；满 3 天才清
    const cleanup = createWorktreeCleanup({ ledger, worktreesDir, log: (l) => logs.push(l), now: () => now });
    now += 60_000;
    expect(await cleanup.runOnce()).toEqual([wLinkGone.id, wNoDotGit.id]);
    // 零提交的分支就在 main 历史里，不用等；有用户文件的保留
    expect(existsSync(wLinkGone.worktreePath!)).toBe(false);
    expect(existsSync(wNoDotGit.worktreePath!)).toBe(false);
    expect(existsSync(join(wUser.worktreePath!, "my-notes.md"))).toBe(true);
    expect(branchExists(wLinkGone.branch!)).toBe(true);

    now += WORKTREE_RETENTION_MS;
    expect(await cleanup.runOnce()).toEqual([]);
    expect(readFileSync(join(wUser.worktreePath!, "my-notes.md"), "utf8")).toBe("别删\n");
  });

  it("孤儿目录且分支有未合并提交：3 天内保留，满 3 天回收", async () => {
    const w = await spawnWorktreeWorker("孤儿有提交");
    writeFileSync(join(w.worktreePath!, "u.txt"), "1\n");
    git(w.worktreePath!, "add", "-A");
    git(w.worktreePath!, "commit", "-q", "-m", "u");
    mkdirSync(join(w.worktreePath!, "node_modules"), { recursive: true });
    endWorker(w.id);
    rmSync(join(w.worktreePath!, ".git"));

    const cleanup = createWorktreeCleanup({ ledger, worktreesDir, log: (l) => logs.push(l), now: () => now });
    now += 60_000;
    expect(await cleanup.runOnce()).toEqual([]);
    expect(existsSync(w.worktreePath!)).toBe(true);
    now = T0 + WORKTREE_RETENTION_MS;
    expect(await cleanup.runOnce()).toEqual([w.id]);
    expect(existsSync(w.worktreePath!)).toBe(false);
    expect(branchExists(w.branch!)).toBe(true);
  });

  it("孤儿目录且分支也被 git branch -D 删掉（真实合并脚本场景）：PR 已合入文件与半删空壳立即回收，未合入文件严格保留", async () => {
    mkdirSync(join(repo, "apps", "windows"), { recursive: true });
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n.codegraph/\n");
    writeFileSync(join(repo, "apps", "windows", ".gitignore"), "/target\n");
    writeFileSync(join(repo, "untouched.txt"), "v0\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "setup");

    // 1. PR 已合入 main（含修改旧文件与新增文件），合并脚本解绑 worktree（留孤儿文件）并 git branch -D 删掉分支，随后 main 继续演进
    const wMerged = await spawnWorktreeWorker("合入后删分支留孤儿");
    writeFileSync(join(wMerged.worktreePath!, "README.md"), "merged-readme\n");
    writeFileSync(join(wMerged.worktreePath!, "feature-merged.ts"), "export const v = 1;\n");
    git(wMerged.worktreePath!, "add", "-A");
    git(wMerged.worktreePath!, "commit", "-q", "-m", "feat");
    mkdirSync(join(wMerged.worktreePath!, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(wMerged.worktreePath!, "node_modules", "pkg", "a.js"), "1\n");
    endWorker(wMerged.id);
    git(repo, "merge", "--no-ff", "-q", "-m", "Merge PR", wMerged.branch!);
    rmSync(join(wMerged.worktreePath!, ".git"));
    git(repo, "worktree", "prune");
    git(repo, "branch", "-D", wMerged.branch!);
    // 主仓继续合入别的提交，使 untouched.txt 与当前 main 不同（仍等于 wMerged.baseCommit）
    writeFileSync(join(repo, "untouched.txt"), "v1-on-main\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "later commit on main");

    // 2. git worktree remove 删了一半中断：源码和 .gitignore 已被删光，只剩忽略产物（含子目录 target）或纯空壳，且分支已删
    const wHalf = await spawnWorktreeWorker("半删只剩忽略目录");
    endWorker(wHalf.id);
    for (const entry of ["README.md", "untouched.txt", ".gitignore", "apps", ".git"]) {
      rmSync(join(wHalf.worktreePath!, entry), { recursive: true, force: true });
    }
    mkdirSync(join(wHalf.worktreePath!, "node_modules", "x"), { recursive: true });
    writeFileSync(join(wHalf.worktreePath!, "node_modules", "x", "i.js"), "1\n");
    mkdirSync(join(wHalf.worktreePath!, ".codegraph"), { recursive: true });
    writeFileSync(join(wHalf.worktreePath!, ".codegraph", "codegraph.db"), "db\n");
    mkdirSync(join(wHalf.worktreePath!, "apps", "windows", "target"), { recursive: true });
    writeFileSync(join(wHalf.worktreePath!, "apps", "windows", "target", "bin"), "bin\n");
    git(repo, "worktree", "prune");
    git(repo, "branch", "-D", wHalf.branch!);

    const wEmpty = await spawnWorktreeWorker("全空壳孤儿");
    endWorker(wEmpty.id);
    rmSync(wEmpty.worktreePath!, { recursive: true, force: true });
    mkdirSync(wEmpty.worktreePath!, { recursive: true });
    git(repo, "worktree", "prune");
    git(repo, "branch", "-D", wEmpty.branch!);

    // 3. 分支与 .git 都被误删、但孤儿目录里还有从未合入主仓的代码：绝不误删
    const wUnmerged = await spawnWorktreeWorker("未合入误删分支");
    writeFileSync(join(wUnmerged.worktreePath!, "unmerged-work.ts"), "precious\n");
    endWorker(wUnmerged.id);
    rmSync(join(wUnmerged.worktreePath!, ".git"));
    git(repo, "worktree", "prune");
    git(repo, "branch", "-D", wUnmerged.branch!);

    now += 60_000;
    const cleanup = createWorktreeCleanup({ ledger, worktreesDir, log: (l) => logs.push(l), now: () => now });
    expect(await cleanup.runOnce()).toEqual([wMerged.id, wHalf.id, wEmpty.id]);
    expect(existsSync(wMerged.worktreePath!)).toBe(false);
    expect(existsSync(wHalf.worktreePath!)).toBe(false);
    expect(existsSync(wEmpty.worktreePath!)).toBe(false);
    expect(readFileSync(join(wUnmerged.worktreePath!, "unmerged-work.ts"), "utf8")).toBe("precious\n");

    // 满 3 天后，未合入文件依然保留
    now += WORKTREE_RETENTION_MS * 2;
    expect(await cleanup.runOnce()).toEqual([]);
    expect(readFileSync(join(wUnmerged.worktreePath!, "unmerged-work.ts"), "utf8")).toBe("precious\n");
  });

  it("符号链接或 worktreesDir 之外的路径：孤儿流程、兜底 fs.rm 下也严格拒删", async () => {
    const outside = join(root, "outside-orphan");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "important.txt"), "keep\n");

    // 外部目录（没有 .git，看起来像孤儿）
    const wOutside = await spawnWorktreeWorker("外部孤儿");
    endWorker(wOutside.id);
    db.run("UPDATE workers SET worktree_path = ? WHERE id = ?", outside, wOutside.id);

    // worktreesDir 下的符号链接指向外部
    const wLink = await spawnWorktreeWorker("符号链接孤儿");
    endWorker(wLink.id);
    rmSync(wLink.worktreePath!, { recursive: true, force: true });
    symlinkSync(outside, wLink.worktreePath!);

    // worktreesDir 本身（不是严格在其下）
    const wRoot = await spawnWorktreeWorker("目录本身");
    endWorker(wRoot.id);
    db.run("UPDATE workers SET worktree_path = ? WHERE id = ?", worktreesDir, wRoot.id);

    now += WORKTREE_RETENTION_MS + 10_000;
    const cleanup = createWorktreeCleanup({ ledger, worktreesDir, log: (l) => logs.push(l), now: () => now });
    expect(await cleanup.runOnce()).toEqual([]);
    expect(readFileSync(join(outside, "important.txt"), "utf8")).toBe("keep\n");
    expect(existsSync(worktreesDir)).toBe(true);
  });

  it("仓库配了 status.showUntrackedFiles=no：未跟踪文件照样算改动，不删", async () => {
    const w = await spawnWorktreeWorker("隐藏未跟踪");
    git(repo, "config", "status.showUntrackedFiles", "no");
    writeFileSync(join(w.worktreePath!, "report.md"), "keep me\n");
    expect(git(w.worktreePath!, "status", "--porcelain")).toBe("");
    endWorker(w.id);

    now += WORKTREE_RETENTION_MS + 10_000;
    const cleanup = createWorktreeCleanup({ ledger, worktreesDir, log: (l) => logs.push(l), now: () => now });
    expect(await cleanup.runOnce()).toEqual([]);
    expect(readFileSync(join(w.worktreePath!, "report.md"), "utf8")).toBe("keep me\n");
  });

  it("被 .gitignore 忽略的文件不算改动：满 3 天连同 worktree 一起删掉", async () => {
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n.env\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "ignore");
    const w = await spawnWorktreeWorker("只有忽略文件");
    mkdirSync(join(w.worktreePath!, "node_modules", "x"), { recursive: true });
    writeFileSync(join(w.worktreePath!, "node_modules", "x", "i.js"), "1\n");
    writeFileSync(join(w.worktreePath!, ".env"), "SECRET=1\n");
    endWorker(w.id);

    now += WORKTREE_RETENTION_MS + 10_000;
    const cleanup = createWorktreeCleanup({ ledger, worktreesDir, log: (l) => logs.push(l), now: () => now });
    expect(await cleanup.runOnce()).toEqual([w.id]);
    expect(existsSync(w.worktreePath!)).toBe(false);
  });

  it("worktree_path 是相对路径或空串（解析到后台的当前目录）：绝不删", async () => {
    const w = await spawnWorktreeWorker("相对路径");
    endWorker(w.id);
    const cwd = process.cwd();
    try {
      process.chdir(w.worktreePath!);
      for (const bad of ["", "."]) {
        db.run("UPDATE workers SET worktree_path = ? WHERE id = ?", bad, w.id);
        now += WORKTREE_RETENTION_MS + 10_000;
        const cleanup = createWorktreeCleanup({ ledger, worktreesDir, log: (l) => logs.push(l), now: () => now });
        expect(await cleanup.runOnce()).toEqual([]);
        expect(existsSync(w.worktreePath!)).toBe(true);
      }
    } finally {
      process.chdir(cwd);
    }
  });

  it("还在跑（未收工）的 Worker：即使分支已合并且过了 3 天也绝不删；不用 worktree 的跳过", async () => {
    const wRunning = await spawnWorktreeWorker("还在跑");
    writeFileSync(join(wRunning.worktreePath!, "a.txt"), "1\n");
    git(wRunning.worktreePath!, "add", "-A");
    git(wRunning.worktreePath!, "commit", "-q", "-m", "c");
    git(repo, "merge", "--no-ff", "-q", "-m", "Merge", wRunning.branch!);

    const wNoWt = ledger.hubCall(
      pm.sessionId,
      "worker.start",
      { title: "主目录干活", task: "不建 worktree", vendor: "claude", noWorktree: true },
      { workspace: { kind: "ok", isRepoWithCommit: true, hasUncommittedChanges: false } },
    ).data.worker;
    endWorker(wNoWt.id);

    now += WORKTREE_RETENTION_MS + 10_000;
    const cleanup = createWorktreeCleanup({ ledger, worktreesDir, log: (l) => logs.push(l), now: () => now });
    expect(await cleanup.runOnce()).toEqual([]);
    expect(existsSync(wRunning.worktreePath!)).toBe(true);
    expect(existsSync(repo)).toBe(true);
  });

  it("路径不在 worktreesDir 下（字面越界或符号链接指向外部目录）绝不删", async () => {
    const outsideDir = join(root, "outside-precious");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "important.txt"), "do not delete\n");

    // 1. 数据库里 worktree_path 直接写成外部路径
    const wOutside = await spawnWorktreeWorker("字面外部路径");
    endWorker(wOutside.id);
    db.run("UPDATE workers SET worktree_path = ? WHERE id = ?", outsideDir, wOutside.id);

    // 2. worktree_path 在 worktreesDir 下，但被替换成了指向外部目录的符号链接
    const wSymlink = await spawnWorktreeWorker("符号链接越界");
    endWorker(wSymlink.id);
    rmSync(wSymlink.worktreePath!, { recursive: true, force: true });
    symlinkSync(outsideDir, wSymlink.worktreePath!);

    now += WORKTREE_RETENTION_MS + 10_000;
    const cleanup = createWorktreeCleanup({ ledger, worktreesDir, log: (l) => logs.push(l), now: () => now });
    expect(await cleanup.runOnce()).toEqual([]);
    expect(existsSync(outsideDir)).toBe(true);
    expect(readFileSync(join(outsideDir, "important.txt"), "utf8")).toBe("do not delete\n");
  });

  it("项目经理已手动删掉 worktree 的自动跳过；git worktree remove 失败只记日志，下轮重试成功并跑 git worktree prune", async () => {
    const wManual = await spawnWorktreeWorker("已手动删");
    endWorker(wManual.id);
    git(repo, "worktree", "remove", wManual.worktreePath!);

    const wLocked = await spawnWorktreeWorker("先锁后解");
    endWorker(wLocked.id);
    // 用 git worktree lock 让不带 --force 的 git worktree remove 失败
    git(repo, "worktree", "lock", wLocked.worktreePath!);

    now += WORKTREE_RETENTION_MS + 1_000;
    const cleanup = createWorktreeCleanup({ ledger, worktreesDir, log: (l) => logs.push(l), now: () => now });

    // 第一轮：已手动删的静默跳过；被锁住的 remove 失败记日志，不抛错
    expect(await cleanup.runOnce()).toEqual([]);
    expect(existsSync(wLocked.worktreePath!)).toBe(true);
    expect(logs.some((l) => l.includes(`worker #${wLocked.id}`) && l.includes("清理 worktree 失败"))).toBe(true);

    // 解锁后再跑一轮：成功清理并 prune
    git(repo, "worktree", "unlock", wLocked.worktreePath!);
    expect(await cleanup.runOnce()).toEqual([wLocked.id]);
    expect(existsSync(wLocked.worktreePath!)).toBe(false);
    expect(git(repo, "worktree", "list")).not.toContain(wLocked.worktreePath!);
  });

  it("每轮上限与轮转：单轮最多处理 batchLimit 个；排在前面的脏 worktree 不会饿死后面的干净候选；无候选时零 git 调用", async () => {
    // 没有任何已收工 worktree 候选时：即使把 PATH 里的 git 换成报错脚本也不会调 git
    const binDir = join(root, "spy-bin");
    const countFile = join(root, "git-count.txt");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(countFile, "");
    const realGit =
      process.platform === "win32"
        ? execFileSync("where.exe", ["git.exe"], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/)[0]!.trim()
        : execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    if (process.platform === "win32") {
      writeExecutableNodeScript(
        join(binDir, "git"),
        `
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(countFile)}, "1\\n");
const res = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: "inherit", windowsHide: true });
process.exit(res.status ?? 1);
`,
      );
      vi.stubEnv("PATH", `${binDir}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`);
    } else {
      writeFileSync(
        join(binDir, "git"),
        `#!/bin/sh\necho 1 >> "${countFile}"\nexec "${realGit}" "$@"\n`,
      );
      chmodSync(join(binDir, "git"), 0o755);
      vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
    }
    const countCalls = () => readFileSync(countFile, "utf8").split("\n").filter(Boolean).length;

    const emptyCleanup = createWorktreeCleanup({
      ledger,
      worktreesDir,
      log: (l) => logs.push(l),
      now: () => now,
    });
    expect(await emptyCleanup.runOnce()).toEqual([]);
    expect(countCalls()).toBe(0);

    // 刚收工、没合并的：只读引用（for-each-ref + 一次 merge-base --is-ancestor），不跑 git status
    const wFresh = await spawnWorktreeWorker("刚收工");
    writeFileSync(join(wFresh.worktreePath!, "f.txt"), "1\n");
    git(wFresh.worktreePath!, "add", "-A");
    git(wFresh.worktreePath!, "commit", "-q", "-m", "f");
    endWorker(wFresh.id);
    writeFileSync(countFile, "");
    expect(await emptyCleanup.runOnce()).toEqual([]);
    // for-each-ref + merge-base（登记分支）、rev-parse HEAD + for-each-ref + merge-base（实际 HEAD）：都只读引用，不跑 git status
    expect(countCalls()).toBe(5);
    git(repo, "worktree", "remove", wFresh.worktreePath!);

    // 建 4 个已收工满 3 天的 worktree：前 2 个有未提交改动（删不掉），后 2 个干净（可删），设 batchLimit = 2
    const w1 = await spawnWorktreeWorker("脏1");
    const w2 = await spawnWorktreeWorker("脏2");
    const w3 = await spawnWorktreeWorker("净3");
    const w4 = await spawnWorktreeWorker("净4");
    writeFileSync(join(w1.worktreePath!, "dirty.txt"), "1\n");
    writeFileSync(join(w2.worktreePath!, "dirty.txt"), "2\n");
    endWorker(w1.id);
    endWorker(w2.id);
    endWorker(w3.id);
    endWorker(w4.id);

    now += WORKTREE_RETENTION_MS + 1_000;
    writeFileSync(countFile, "");

    const cleanup = createWorktreeCleanup({
      ledger,
      worktreesDir,
      log: (l) => logs.push(l),
      now: () => now,
      batchLimit: 2,
    });
    expect(WORKTREE_CLEANUP_BATCH_LIMIT).toBeGreaterThanOrEqual(5);

    // 第 1 轮只检查前 2 个（w1, w2），因有未提交改动都不删
    expect(await cleanup.runOnce()).toEqual([]);
    expect(existsSync(w3.worktreePath!)).toBe(true);
    expect(existsSync(w4.worktreePath!)).toBe(true);

    // 第 2 轮游标轮转到 w3, w4，把它们删掉
    expect(await cleanup.runOnce()).toEqual([w3.id, w4.id]);
    expect(existsSync(w1.worktreePath!)).toBe(true);
    expect(existsSync(w2.worktreePath!)).toBe(true);
    expect(existsSync(w3.worktreePath!)).toBe(false);
    expect(existsSync(w4.worktreePath!)).toBe(false);
  });

  it("换人共享同一个 worktree：0 提交已收工的前任（注册 worktree / 孤儿目录）不能靠“0 提交秒清”或“前任满 3 天”删掉后任还在用或未到期的目录", async () => {
    const graph = ledger.hubCall(pm.sessionId, "graph.create", {
      title: "共享目录边界",
      specJson: JSON.stringify({ nodes: [{ key: "s1", title: "实现" }] }),
    }).data.graph;
    const w1 = ledger.hubCall(
      pm.sessionId,
      "worker.start",
      { title: "实现", task: "做功能", vendor: "claude", node: "s1" },
      { workspace: { kind: "ok", isRepoWithCommit: true, hasUncommittedChanges: false } },
    ).data.worker;
    const wt = await addWorktree({ repoFolder: repo, worktreePath: w1.worktreePath!, branch: w1.branch! });
    ledger.onWorktreeCreated(w1.id, wt.baseCommit);
    // 前任 0 提交、目录干净就收工（HEAD === baseCommit，单独看会被“0 提交秒清”）
    ledger.hubCall(pm.sessionId, "worker.end", { workerId: w1.id });

    // 前任收工满 3 天后，后任接手同一目录，仍开着
    now += WORKTREE_RETENTION_MS + 1_000;
    const w2 = ledger.hubCall(
      pm.sessionId,
      "worker.start",
      { node: "s1", vendor: "codex" },
      { workspace: { kind: "ok", isRepoWithCommit: true, hasUncommittedChanges: false } },
    ).data.worker;
    expect(w2.worktreePath).toBe(w1.worktreePath);
    const dir = w1.worktreePath!;

    const cleanup = createWorktreeCleanup({ ledger, worktreesDir, log: (l) => logs.push(l), now: () => now });
    // 1. 注册 worktree：后任还开着，前任的 0 提交 / 已满 3 天都不能删
    expect(await cleanup.runOnce()).toEqual([]);
    expect(existsSync(dir)).toBe(true);

    // 2. 后任提交了未合并的活后，目录被外部解绑成孤儿：后任还开着，同样不能删
    writeFileSync(join(dir, "successor.txt"), "后任的活\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "successor");
    const linkName = readFileSync(join(dir, ".git"), "utf8").trim().split("/").pop()!;
    rmSync(join(repo, ".git", "worktrees", linkName), { recursive: true, force: true });
    git(repo, "worktree", "prune");
    expect(await cleanup.runOnce()).toEqual([]);
    expect(existsSync(dir)).toBe(true);

    // 3. 后任收工、取消任务图：分支有未合并提交，且按末任收工时间算还没满 3 天（前任早已满 3 天也不行）
    now += 60_000;
    ledger.hubCall(pm.sessionId, "worker.end", { workerId: w2.id });
    ledger.hubCall(pm.sessionId, "graph.cancel", { graphId: graph.id });
    expect(await cleanup.runOnce()).toEqual([]);
    expect(existsSync(dir)).toBe(true);

    // 4. 末任收工也满 3 天后才回收
    now += WORKTREE_RETENTION_MS;
    expect(await cleanup.runOnce()).toEqual([w1.id]);
    expect(existsSync(dir)).toBe(false);
  });

  it("换人共享同一个 worktree：前任已满 3 天但后任刚收工且分支未合并时不删，等后任收工也满 3 天才删", async () => {
    const graph = ledger.hubCall(pm.sessionId, "graph.create", {
      title: "接力清理",
      specJson: JSON.stringify({ nodes: [{ key: "s1", title: "实现" }] }),
    }).data.graph;
    const w1 = ledger.hubCall(
      pm.sessionId,
      "worker.start",
      { title: "实现", task: "做功能", vendor: "claude", node: "s1" },
      { workspace: { kind: "ok", isRepoWithCommit: true, hasUncommittedChanges: false } },
    ).data.worker;
    const wt = await addWorktree({ repoFolder: repo, worktreePath: w1.worktreePath!, branch: w1.branch! });
    ledger.onWorktreeCreated(w1.id, wt.baseCommit);
    writeFileSync(join(w1.worktreePath!, "step1.txt"), "progress\n");
    git(w1.worktreePath!, "add", "-A");
    git(w1.worktreePath!, "commit", "-q", "-m", "wip");
    ledger.hubCall(pm.sessionId, "worker.end", { workerId: w1.id });

    // 4 天后 w2 接手同一个 worktree，随即收工并取消任务图（分支未合并）
    now += WORKTREE_RETENTION_MS + 86_400_000;
    const w2 = ledger.hubCall(
      pm.sessionId,
      "worker.start",
      { node: "s1", vendor: "codex" },
      { workspace: { kind: "ok", isRepoWithCommit: true, hasUncommittedChanges: false } },
    ).data.worker;
    expect(w2.worktreePath).toBe(w1.worktreePath);
    now += 60_000;
    ledger.hubCall(pm.sessionId, "worker.end", { workerId: w2.id });
    ledger.hubCall(pm.sessionId, "graph.cancel", { graphId: graph.id });

    const cleanup = createWorktreeCleanup({ ledger, worktreesDir, log: (l) => logs.push(l), now: () => now });
    // 后任刚收工 0 秒：不能按前任 4 天前的收工时刻提前删掉共享目录
    expect(await cleanup.runOnce()).toEqual([]);
    expect(existsSync(w1.worktreePath!)).toBe(true);

    // 等后任收工也满 3 天后，正常清理一次
    now += WORKTREE_RETENTION_MS + 1_000;
    expect(await cleanup.runOnce()).toEqual([w1.id]);
    expect(existsSync(w1.worktreePath!)).toBe(false);
  });

  it("跨盘同卷 .fusa-wt 根目录自动回收闭环：已合并秒清、满 3 天清理、孤儿清理，以及 PM 归档到期连根删净 .fusa-wt/<projectId>", async () => {
    const stateDir = join(dataHome, "state");
    const crossRoot = join(root, "fake-d-drive", ".fusa-wt", "a1b2c3d4");
    mkdirSync(crossRoot, { recursive: true });
    registerManagedWorktreeRoot(stateDir, worktreesDir, crossRoot);

    const crossDb = openTestDb();
    const crossLedger = createLedger(crossDb, {
      now: () => now,
      initialSeq: 2_000,
      pmHomeRoot: join(dataHome, "pm-home-cross"),
      dataHome,
      worktreesDir,
      extraWorktreeRoots: () => loadManagedWorktreeRoots(stateDir, worktreesDir),
      resolveFolder: createResolveFolder({ dataHome, userHome: root }),
    });
    try {
      const crossCreated = crossLedger.createPm({ name: "跨盘PM", mode: "manage_only", persona: "", folder: repo });
      const crossProjId = crossCreated.project!.id;

      const spawnOnCrossRoot = async (title: string): Promise<WorkerRecord> => {
        const started = crossLedger.hubCall(
          crossCreated.sessionId,
          "worker.start",
          { title, task: "跨盘开发", vendor: "claude" },
          { workspace: { kind: "ok", isRepoWithCommit: true, hasUncommittedChanges: false } },
        ).data.worker;
        const actualProjDir = projectWorktreesDir(crossRoot, crossProjId);
        const defaultProjDir = projectWorktreesDir(worktreesDir, crossProjId);
        ensureProjectWorktreeBridge(defaultProjDir, actualProjDir);
        const crossWtPath = workerWorktreePath(crossRoot, crossProjId, started.id);
        crossDb.run("UPDATE workers SET worktree_path = ? WHERE id = ?", crossWtPath, started.id);
        const wt = await addWorktree({ repoFolder: repo, worktreePath: crossWtPath, branch: started.branch! });
        crossLedger.onWorktreeCreated(started.id, wt.baseCommit);
        return crossLedger.hubCall(crossCreated.sessionId, "worker.show", { workerId: started.id }).data.worker;
      };

      // 1) 已合入 main 的跨卷 .fusa-wt worktree 秒清
      const wMerged = await spawnOnCrossRoot("跨盘已合入");
      writeFileSync(join(wMerged.worktreePath!, "merged.txt"), "ok\n");
      git(wMerged.worktreePath!, "add", "-A");
      git(wMerged.worktreePath!, "commit", "-q", "-m", "cross-merged");
      git(repo, "merge", "--no-ff", "-q", "-m", "merge cross", wMerged.branch!);
      crossLedger.hubCall(crossCreated.sessionId, "worker.end", { workerId: wMerged.id });

      // 2) 未合入但满 3 天的跨卷 .fusa-wt worktree 自动清理
      const wExpired = await spawnOnCrossRoot("跨盘满三天");
      writeFileSync(join(wExpired.worktreePath!, "unmerged.txt"), "wip\n");
      git(wExpired.worktreePath!, "add", "-A");
      git(wExpired.worktreePath!, "commit", "-q", "-m", "cross-wip");
      crossLedger.hubCall(crossCreated.sessionId, "worker.end", { workerId: wExpired.id });

      // 3) 跨卷孤儿目录回收
      const wOrphan = await spawnOnCrossRoot("跨盘孤儿");
      crossLedger.hubCall(crossCreated.sessionId, "worker.end", { workerId: wOrphan.id });
      const gitPtr = readFileSync(join(wOrphan.worktreePath!, ".git"), "utf8").trim().replace(/\\/g, "/");
      const linkName = gitPtr.split("/").pop()!;
      rmSync(join(repo, ".git", "worktrees", linkName), { recursive: true, force: true });
      git(repo, "worktree", "prune");

      const cleanup = createWorktreeCleanup({
        ledger: crossLedger,
        worktreesDir,
        extraWorktreeRoots: () => loadManagedWorktreeRoots(stateDir, worktreesDir),
        log: (l) => logs.push(l),
        now: () => now,
      });

      // 首轮：wMerged 与 0 提交孤儿 wOrphan 立即清理，未满 3 天的 wExpired 保留
      const firstCleaned = await cleanup.runOnce();
      expect(firstCleaned).toEqual([wMerged.id, wOrphan.id]);
      expect(existsSync(wMerged.worktreePath!)).toBe(false);
      expect(existsSync(wOrphan.worktreePath!)).toBe(false);
      expect(existsSync(wExpired.worktreePath!)).toBe(true);

      // 满 3 天后：wExpired 在跨卷 .fusa-wt 下被自动清理
      now += WORKTREE_RETENTION_MS + 1_000;
      expect(await cleanup.runOnce()).toEqual([wExpired.id]);
      expect(existsSync(wExpired.worktreePath!)).toBe(false);

      // 4) PM 归档到期彻底删除时，桥接软链/junction 与跨盘 .fusa-wt/<projectId> 物理目录一并清净，绝不遗留孤儿
      const wArchiveLeft = await spawnOnCrossRoot("归档残留目录");
      expect(existsSync(wArchiveLeft.worktreePath!)).toBe(true);
      crossLedger.archivePm(crossCreated.pm.id);
      now += PM_ARCHIVE_RETENTION_MS + 1_000;
      expect(crossLedger.purgeExpiredArchivedPms(now)).toContain(crossCreated.pm.id);
      expect(existsSync(projectWorktreesDir(worktreesDir, crossProjId))).toBe(false);
      expect(existsSync(projectWorktreesDir(crossRoot, crossProjId))).toBe(false);
    } finally {
      crossLedger.close();
      crossDb.close();
    }
  });
});
