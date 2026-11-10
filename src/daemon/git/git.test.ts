// 真 git、临时目录：判断仓库、没提交的改动、建 worktree（M3 W1，计划的测试表）。
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addWorktree,
  GitError,
  hasUncommittedChanges,
  isBranchMergedToMain,
  isRepoWithCommit,
  probeWorkspace,
  pruneWorktrees,
  removeWorktree,
} from "./index.ts";

/** 测试里自己用的 git：身份写死，不读用户的全局配置（也不会因为本机开了签名而卡住）。 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
}

let root: string;
beforeEach(() => {
  // 目录名里有空格和中文：所有用例都走一遍这样的路径
  root = mkdtempSync(join(tmpdir(), "git 测试 "));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function makeRepo(name: string, { commit = true } = {}): string {
  const dir = join(root, name);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  if (commit) {
    writeFileSync(join(dir, "a.txt"), "a\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
  }
  return dir;
}

/** 换一个假 git：PATH 里只有它，内容是一段 sh。 */
function fakeGit(script: string): void {
  const bin = join(root, "fake-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "git"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, "git"), 0o755);
  vi.stubEnv("PATH", `${bin}:/bin:/usr/bin`);
}

/** 假 git 时用的普通文件夹（不用真 git 建仓库）。 */
function makeRepoLater(): string {
  const dir = join(root, "any");
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("isRepoWithCommit", () => {
  it("有提交的仓库 → 是", async () => {
    expect(await isRepoWithCommit(makeRepo("项目 一"))).toBe(true);
  });
  it("刚 git init、没有提交 → 否", async () => {
    expect(await isRepoWithCommit(makeRepo("空仓库", { commit: false }))).toBe(false);
  });
  it("普通文件夹 → 否", async () => {
    const dir = join(root, "plain");
    mkdirSync(dir);
    expect(await isRepoWithCommit(dir)).toBe(false);
  });
  it("文件夹不存在 → 报清楚的错（不当成“不是仓库”）", async () => {
    const error = await isRepoWithCommit(join(root, "没有这个目录")).catch((e) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error.message).toContain("没有这个目录");
  });
  it("git 别的非零退出（比如 Xcode 许可证没同意）→ 报错，不当成“不是仓库”", async () => {
    fakeGit("echo 'You have not agreed to the Xcode license agreements.' >&2; exit 69");
    try {
      const error = await isRepoWithCommit(makeRepoLater()).catch((e) => e);
      expect(error).toBeInstanceOf(GitError);
      expect(error.message).toContain("Xcode license");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("hasUncommittedChanges", () => {
  it("干净 → 否", async () => {
    expect(await hasUncommittedChanges(makeRepo("clean"))).toBe(false);
  });
  it("改了已跟踪的文件 → 是", async () => {
    const dir = makeRepo("modified");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    expect(await hasUncommittedChanges(dir)).toBe(true);
  });
  it("有没跟踪的文件 → 是", async () => {
    const dir = makeRepo("untracked");
    writeFileSync(join(dir, "新 文件.txt"), "x\n");
    expect(await hasUncommittedChanges(dir)).toBe(true);
  });
  it("已暂存、没提交 → 是", async () => {
    const dir = makeRepo("staged");
    writeFileSync(join(dir, "b.txt"), "b\n");
    git(dir, "add", "b.txt");
    expect(await hasUncommittedChanges(dir)).toBe(true);
  });
  it("不是仓库 → 报清楚的错", async () => {
    const dir = join(root, "plain");
    mkdirSync(dir);
    await expect(hasUncommittedChanges(dir)).rejects.toThrow(GitError);
    await expect(hasUncommittedChanges(dir)).rejects.toThrow(/git status/);
  });
});

describe("addWorktree", () => {
  it("分支和目录都对，基准默认是 HEAD", async () => {
    const repo = makeRepo("项目 一");
    const head = git(repo, "rev-parse", "HEAD");
    const path = join(root, "worktrees", "1", "7");
    const result = await addWorktree({ repoFolder: repo, worktreePath: path, branch: "hub/7-fix-x" });
    expect(result).toEqual({ created: true, baseCommit: head });
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("hub/7-fix-x");
    expect(git(path, "rev-parse", "HEAD")).toBe(head);
    expect(git(path, "rev-parse", "--show-toplevel")).toBe(realpathSync(path));
    // 主文件夹里登记了它
    expect(git(repo, "worktree", "list", "--porcelain")).toContain(realpathSync(path));
  });

  it("基准可以指定", async () => {
    const repo = makeRepo("base");
    const first = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "b.txt"), "b\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "second");
    const path = join(root, "wt");
    const result = await addWorktree({ repoFolder: repo, worktreePath: path, branch: "hub/1-a", base: first });
    expect(result.baseCommit).toBe(first);
    expect(git(path, "rev-parse", "HEAD")).toBe(first);
  });

  it("路径里有空格和中文、分支名里有中文也行", async () => {
    const repo = makeRepo("项目 空格");
    const path = join(root, "工作 树", "任务 三");
    const result = await addWorktree({ repoFolder: repo, worktreePath: path, branch: "hub/3-修复" });
    expect(result.created).toBe(true);
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("hub/3-修复");
  });

  it("再建一次算成功：不动 worktree 里的东西，baseCommit 还是原来的", async () => {
    const repo = makeRepo("again");
    const base = git(repo, "rev-parse", "HEAD");
    const path = join(root, "wt", "again");
    const args = { repoFolder: repo, worktreePath: path, branch: "hub/2-again" };
    await addWorktree(args);
    writeFileSync(join(path, "work.txt"), "w\n");
    git(path, "add", "-A");
    git(path, "commit", "-q", "-m", "worker commit");
    // 主分支也往前走了
    writeFileSync(join(repo, "c.txt"), "c\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "main moved");

    expect(await addWorktree(args)).toEqual({ created: false, baseCommit: base });
    expect(git(path, "log", "-1", "--format=%s")).toBe("worker commit");
  });

  it("上次 git worktree add 被强杀、留下半成品（locked initializing、文件不全）：清掉重建，不当成已经建好", async () => {
    const repo = makeRepo("half");
    for (let i = 0; i < 20; i++) writeFileSync(join(repo, `f${i}.txt`), `${i}\n`);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "more files");
    const base = git(repo, "rev-parse", "HEAD");
    const path = join(root, "wt", "half");
    const args = { repoFolder: repo, worktreePath: path, branch: "hub/8-half" };
    // 照 git 被 SIGKILL 时的样子摆出来：worktree 登记了、还锁着 initializing，检出了一部分文件
    await addWorktree(args);
    git(repo, "worktree", "lock", "--reason", "initializing", path);
    for (let i = 5; i < 20; i++) rmSync(join(path, `f${i}.txt`));
    expect(git(repo, "worktree", "list", "--porcelain")).toContain("locked initializing");

    expect(await addWorktree(args)).toEqual({ created: true, baseCommit: base });
    const list = git(repo, "worktree", "list", "--porcelain");
    expect(list).toContain(realpathSync(path));
    expect(list).not.toContain("locked");
    for (let i = 0; i < 20; i++) expect(existsSync(join(path, `f${i}.txt`))).toBe(true);
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("hub/8-half");
    expect(git(path, "status", "--porcelain")).toBe("");
  });

  it("别人自己锁的 worktree（理由不是 initializing）照旧算已经建好，不动它", async () => {
    const repo = makeRepo("userlock");
    const path = join(root, "wt", "userlock");
    const args = { repoFolder: repo, worktreePath: path, branch: "hub/9-lock" };
    await addWorktree(args);
    git(repo, "worktree", "lock", "--reason", "external disk", path);
    expect(await addWorktree(args)).toMatchObject({ created: false });
    expect(git(repo, "worktree", "list", "--porcelain")).toContain("locked external disk");
  });

  it("分支名已经被占了 → 报清楚的错，不建目录", async () => {
    const repo = makeRepo("taken");
    git(repo, "branch", "hub/5-x");
    const path = join(root, "wt", "taken");
    const error = await addWorktree({ repoFolder: repo, worktreePath: path, branch: "hub/5-x" }).catch((e) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error.kind).toBe("branch_taken");
    expect(error.message).toContain("hub/5-x");
    expect(existsSync(path)).toBe(false);
  });

  it("分支在别的 worktree 里 → 同样报分支被占", async () => {
    const repo = makeRepo("elsewhere");
    await addWorktree({ repoFolder: repo, worktreePath: join(root, "wt", "one"), branch: "hub/6-x" });
    const error = await addWorktree({ repoFolder: repo, worktreePath: join(root, "wt", "two"), branch: "hub/6-x" }).catch((e) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error.kind).toBe("branch_taken");
  });

  it("目录已经是别的分支的 worktree → 报清楚的错", async () => {
    const repo = makeRepo("pathtaken");
    const path = join(root, "wt", "shared");
    await addWorktree({ repoFolder: repo, worktreePath: path, branch: "hub/8-a" });
    const error = await addWorktree({ repoFolder: repo, worktreePath: path, branch: "hub/8-b" }).catch((e) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error.kind).toBe("path_taken");
    expect(error.message).toContain("hub/8-a");
  });

  it("目录是个有内容的普通文件夹 → git 的错转成中文信息", async () => {
    const repo = makeRepo("occupied");
    const path = join(root, "occupied-dir");
    mkdirSync(path);
    writeFileSync(join(path, "x.txt"), "x\n");
    const error = await addWorktree({ repoFolder: repo, worktreePath: path, branch: "hub/9-x" }).catch((e) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error.kind).toBe("git_failed");
    expect(error.message).toMatch(/^git worktree add 失败：/);
  });

  it("基准不存在 → 报清楚的错", async () => {
    const repo = makeRepo("nobase");
    const error = await addWorktree({ repoFolder: repo, worktreePath: join(root, "wt"), branch: "hub/1-a", base: "no-such-ref" }).catch((e) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error.message).toContain("no-such-ref");
  });
});

describe("拿不到的错误", () => {
  it("git 超时 → 中文信息写明超了多久", async () => {
    // 用一个睡着不动的假 git：真 git 在 Linux 上跑得比 1 毫秒的超时还快时，会正常结束、不超时（macOS 上碰巧总是慢）
    const repo = makeRepoLater();
    fakeGit("exec sleep 30");
    try {
      const error = await hasUncommittedChanges(repo, { timeoutMs: 50 }).catch((e) => e);
      expect(error).toBeInstanceOf(GitError);
      expect(error.kind).toBe("timeout");
      expect(error.message).toMatch(/超过.*没有结束/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("找不到 git 程序 → 中文信息", async () => {
    const repo = makeRepo("nogit");
    vi.stubEnv("PATH", join(root, "empty-bin"));
    try {
      const error = await hasUncommittedChanges(repo).catch((e) => e);
      expect(error).toBeInstanceOf(GitError);
      expect(error.kind).toBe("git_missing");
      expect(error.message).toContain("找不到 git");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("probeWorkspace（agent 接口在 hub worker start 之前探主文件夹）", () => {
  it("有提交的仓库：ok，带有没有没提交的改动", async () => {
    const repo = makeRepo("项目 一");
    expect(await probeWorkspace(repo)).toEqual({ kind: "ok", isRepoWithCommit: true, hasUncommittedChanges: false });
    writeFileSync(join(repo, "新 文件.txt"), "x\n");
    expect(await probeWorkspace(repo)).toEqual({ kind: "ok", isRepoWithCommit: true, hasUncommittedChanges: true });
  });

  it("普通文件夹、还没提交的仓库：ok，不是仓库", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(await probeWorkspace(plain)).toEqual({ kind: "ok", isRepoWithCommit: false, hasUncommittedChanges: false });
    expect(await probeWorkspace(makeRepo("空仓库", { commit: false }))).toEqual({ kind: "ok", isRepoWithCommit: false, hasUncommittedChanges: false });
  });

  it("git 卡住：到点就报 failed，写明超时，不当成“不是仓库”", async () => {
    fakeGit("exec sleep 30");
    try {
      const started = Date.now();
      const result = await probeWorkspace(makeRepoLater(), { timeoutMs: 300 });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result).toEqual({ kind: "failed", error: expect.stringMatching(/超过.*没有结束/) });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("找不到 git：failed，写明找不到 git", async () => {
    vi.stubEnv("PATH", join(root, "empty-bin"));
    try {
      expect(await probeWorkspace(makeRepoLater())).toEqual({ kind: "failed", error: expect.stringContaining("找不到 git") });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("isBranchMergedToMain、removeWorktree、pruneWorktrees", () => {
  it("刚建好还没有新提交（等于 baseCommit）的分支不算已合并；有新提交且未合进 main 返回 false", async () => {
    const repo = makeRepo("unmerged");
    const wt = join(root, "wt", "1");
    const { baseCommit } = await addWorktree({ repoFolder: repo, worktreePath: wt, branch: "hub/1-feat" });
    // 没任何新提交，等于 baseCommit → 不算已合并
    expect(await isBranchMergedToMain(repo, "hub/1-feat", baseCommit)).toBe(false);

    // 做了新提交，但还没合进 main → false
    writeFileSync(join(wt, "feat.txt"), "new\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "add feat");
    expect(await isBranchMergedToMain(repo, "hub/1-feat", baseCommit)).toBe(false);
  });

  it("分支通过 merge commit 或 fast-forward 合进本地 main 或 origin/main 后返回 true", async () => {
    const repo = makeRepo("merged");
    const wt1 = join(root, "wt", "1");
    const { baseCommit: base1 } = await addWorktree({ repoFolder: repo, worktreePath: wt1, branch: "hub/1-ff" });
    writeFileSync(join(wt1, "ff.txt"), "ff\n");
    git(wt1, "add", "-A");
    git(wt1, "commit", "-q", "-m", "ff commit");
    // fast-forward 合进 main
    git(repo, "merge", "--ff-only", "hub/1-ff");
    expect(await isBranchMergedToMain(repo, "hub/1-ff", base1)).toBe(true);

    // 第二个分支通过 --no-ff merge commit 合进 origin/main（本地 main 还没更新）
    const wt2 = join(root, "wt", "2");
    const { baseCommit: base2 } = await addWorktree({ repoFolder: repo, worktreePath: wt2, branch: "hub/2-noff" });
    writeFileSync(join(wt2, "noff.txt"), "noff\n");
    git(wt2, "add", "-A");
    git(wt2, "commit", "-q", "-m", "noff commit");
    const branchSha = git(wt2, "rev-parse", "HEAD");
    // 模拟 origin/main 包含了该分支的提交
    git(repo, "update-ref", "refs/remotes/origin/main", branchSha);
    expect(await isBranchMergedToMain(repo, "hub/2-noff", base2)).toBe(true);
  });

  it("removeWorktree 删掉干净的 worktree 但保留分支；有未提交改动（不带 --force）时报错；pruneWorktrees 清理残留登记", async () => {
    const repo = makeRepo("rm-wt");
    const wtClean = join(root, "wt", "clean");
    const wtDirty = join(root, "wt", "dirty");
    await addWorktree({ repoFolder: repo, worktreePath: wtClean, branch: "hub/1-clean" });
    await addWorktree({ repoFolder: repo, worktreePath: wtDirty, branch: "hub/2-dirty" });

    // 干净的 worktree 可以正常删，分支仍保留
    await removeWorktree(repo, wtClean);
    expect(existsSync(wtClean)).toBe(false);
    expect(git(repo, "show-ref", "--verify", "refs/heads/hub/1-clean")).toContain("refs/heads/hub/1-clean");

    // 有未提交改动（含未跟踪文件）时，不带 --force 的 git worktree remove 会失败且目录保留
    writeFileSync(join(wtDirty, "untracked.txt"), "dirty\n");
    await expect(removeWorktree(repo, wtDirty)).rejects.toThrow(GitError);
    expect(existsSync(wtDirty)).toBe(true);

    // 手动删掉目录后，pruneWorktrees 清理 git worktree list 里的残留项
    rmSync(wtDirty, { recursive: true, force: true });
    await pruneWorktrees(repo);
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain("dirty");
    expect(git(repo, "show-ref", "--verify", "refs/heads/hub/2-dirty")).toContain("refs/heads/hub/2-dirty");
  });
});
