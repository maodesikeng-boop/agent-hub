// 真 git、临时目录：判断仓库、没提交的改动、建 worktree（M3 W1，计划的测试表）。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addWorktree, GitError, hasUncommittedChanges, isRepoWithCommit } from "./index.ts";

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
  it("文件夹不存在 → 否", async () => {
    expect(await isRepoWithCommit(join(root, "没有这个目录"))).toBe(false);
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

  it("分支名已经被占了 → 报清楚的错，不建目录", async () => {
    const repo = makeRepo("taken");
    git(repo, "branch", "hub/5-x");
    const path = join(root, "wt", "taken");
    const error = await addWorktree({ repoFolder: repo, worktreePath: path, branch: "hub/5-x" }).catch((e) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error.kind).toBe("branch_taken");
    expect(error.message).toContain("hub/5-x");
    expect(await isRepoWithCommit(path)).toBe(false);
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
    const repo = makeRepo("slow");
    const error = await hasUncommittedChanges(repo, { timeoutMs: 1 }).catch((e) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error.kind).toBe("timeout");
    expect(error.message).toMatch(/超过.*没有结束/);
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
