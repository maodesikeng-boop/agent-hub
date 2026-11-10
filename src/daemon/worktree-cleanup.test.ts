// Worker worktree 自动清理测试（全部使用临时目录和临时 git 仓库，绝不碰真实 ~/.agent-hub/worktrees）：
// 覆盖：已合并删（分支保留） / 收工满 3 天且干净删（分支保留） / 有改动不删（含已跟踪修改、暂存、未跟踪文件；PR 已合并也不删） /
// 在跑不删 / 不用 worktree 跳过 / 不在 worktrees 目录下不删（含符号链接越界） / 手动删过的跳过 /
// git worktree remove 失败记日志下轮重试并 prune / 每轮上限与轮转 / 没候选时零 git 调用 /
// HEAD 不在分支上不删 / status.showUntrackedFiles=no 时未跟踪文件照样拦 / 被忽略的文件随目录删 / 相对路径不删。
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PmId, SessionId, WorkerId, WorkerRecord } from "../shared/domain.ts";
import { WORKTREE_CLEANUP_BATCH_LIMIT, WORKTREE_RETENTION_MS } from "../shared/limits.ts";
import { addWorktree } from "./git/index.ts";
import { createResolveFolder } from "./ledger/files.ts";
import { createLedger, type SqliteLedger } from "./ledger/index.ts";
import { openTestDb } from "./store/test-helpers.ts";
import type { Db } from "./store/index.ts";
import { createWorktreeCleanup } from "./worktree-cleanup.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
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
    expect(endText).toContain("PR 合并后或收工满 3 天且没有未提交改动时会自动清理 worktree（分支保留）");

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

  it("刚建出 worktree 一条新提交都没有（branch === baseCommit）就收工、未满 3 天：不当成“PR 已合并”，等满 3 天才删", async () => {
    const w = await spawnWorktreeWorker("零提交");
    endWorker(w.id);

    now += 60_000;
    const cleanup = createWorktreeCleanup({ ledger, worktreesDir, log: (l) => logs.push(l), now: () => now });
    expect(await cleanup.runOnce()).toEqual([]);
    expect(existsSync(w.worktreePath!)).toBe(true);

    now += WORKTREE_RETENTION_MS;
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

  it("HEAD 不在分支上（detached 上有新提交、rebase 停在一半）：满 3 天也不删，免得只在 HEAD 上的提交跟着 worktree 一起丢", async () => {
    const wDetached = await spawnWorktreeWorker("detached 有提交");
    git(wDetached.worktreePath!, "checkout", "-q", "--detach");
    writeFileSync(join(wDetached.worktreePath!, "only-on-head.txt"), "1\n");
    git(wDetached.worktreePath!, "add", "-A");
    git(wDetached.worktreePath!, "commit", "-q", "-m", "detached commit");
    endWorker(wDetached.id);

    const wRebase = await spawnWorktreeWorker("rebase 停在一半");
    for (const name of ["r1", "r2"]) {
      writeFileSync(join(wRebase.worktreePath!, name), `${name}\n`);
      git(wRebase.worktreePath!, "add", "-A");
      git(wRebase.worktreePath!, "commit", "-q", "-m", name);
    }
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "rebase", "-q", "-i", "HEAD~2"], {
      cwd: wRebase.worktreePath!,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_SEQUENCE_EDITOR: "sed -i.bak s/^pick/edit/" },
    });
    expect(git(wRebase.worktreePath!, "status", "--porcelain")).toBe("");
    endWorker(wRebase.id);

    now += WORKTREE_RETENTION_MS + 10_000;
    const cleanup = createWorktreeCleanup({ ledger, worktreesDir, log: (l) => logs.push(l), now: () => now });
    expect(await cleanup.runOnce()).toEqual([]);
    expect(existsSync(join(wDetached.worktreePath!, "only-on-head.txt"))).toBe(true);
    expect(existsSync(wRebase.worktreePath!)).toBe(true);
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
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(binDir, "git"),
      `#!/bin/sh\necho 1 >> "${countFile}"\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(join(binDir, "git"), 0o755);

    vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
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
    expect(countCalls()).toBe(2);
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
});
