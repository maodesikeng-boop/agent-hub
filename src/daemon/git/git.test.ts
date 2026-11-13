// 真 git、临时目录：判断仓库、没提交的改动、建 worktree（M3 W1，计划的测试表）。
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeExecutableNodeScript } from "../../../test/fake-cli-shim.ts";
import {
  addWorktree,
  GitError,
  hasUncommittedChanges,
  inspectWorktreeLink,
  isBranchMergedToMain,
  isCommitMergedToMain,
  isRepoWithCommit,
  parseDiffNumstatZ,
  pinDetachedHead,
  probeDiffNumstat,
  probeOrphanContent,
  probeWorkspace,
  probeWorktreeForRemoval,
  pruneWorktrees,
  removeWorktree,
} from "./index.ts";

/** 测试里自己用的 git：身份写死，不读用户的全局配置（也不会因为本机开了签名而卡住）。 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull },
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
  if (process.platform === "win32") {
    const gitBash = [
      join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
      join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "bash.exe"),
    ].find((p) => existsSync(p)) ?? "bash.exe";
    writeExecutableNodeScript(
      join(bin, "git"),
      `
import { spawnSync } from "node:child_process";
const res = spawnSync(${JSON.stringify(gitBash)}, ["-c", ${JSON.stringify(script)}, "git", ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true });
process.exit(res.status ?? 1);
`,
    );
    vi.stubEnv("PATH", `${bin}${delimiter}${dirname(process.execPath)}`);
    return;
  }
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

    // 没登记起点（baseCommit 为 null）：分支一条新提交都没有、main 往前走了也是 main 的祖先，不能判成已合并
    const wt0 = join(root, "wt", "0");
    await addWorktree({ repoFolder: repo, worktreePath: wt0, branch: "hub/0-nobase" });
    writeFileSync(join(repo, "main-moved.txt"), "1\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "main moved");
    expect(await isBranchMergedToMain(repo, "hub/0-nobase", null)).toBe(false);
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

  it("probeDiffNumstat 与 parseDiffNumstatZ：正确解析带空格/中文路径与二进制文件，分支不存在返回 null", async () => {
    expect(parseDiffNumstatZ("12\t3\tsrc/中文 文件.ts\0-\t-\tassets/logo.png\0")).toEqual([
      { file: "src/中文 文件.ts", added: 12, deleted: 3 },
      { file: "assets/logo.png", added: null, deleted: null },
    ]);

    const repo = makeRepo("numstat");
    const wt = join(root, "wt", "numstat");
    const { baseCommit } = await addWorktree({ repoFolder: repo, worktreePath: wt, branch: "hub/9-diff" });
    writeFileSync(join(wt, "中文 文件.txt"), "line1\nline2\n");
    writeFileSync(join(wt, "a.txt"), "updated\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "change files");

    const stats = await probeDiffNumstat(repo, "hub/9-diff", { baseCommit });
    expect(stats).toEqual([
      { file: "a.txt", added: 1, deleted: 1 },
      { file: "中文 文件.txt", added: 2, deleted: 0 },
    ]);
    expect(await probeDiffNumstat(repo, "hub/not-exist", { baseCommit })).toBeNull();
  });
});

describe("自动清理用的探测：中间状态、detached HEAD 保底、孤儿目录", () => {
  it("probeWorktreeForRemoval 带出 head / onBranch / inProgress；merge 冲突停在一半算 inProgress", async () => {
    const repo = makeRepo("probe");
    const wt = join(root, "wt", "p");
    const { baseCommit } = await addWorktree({ repoFolder: repo, worktreePath: wt, branch: "hub/p" });
    const probe = await probeWorktreeForRemoval(wt);
    expect(probe).toMatchObject({ kind: "ok", clean: true, onBranch: true, head: baseCommit, inProgress: false });

    git(wt, "checkout", "-q", "--detach");
    expect(await probeWorktreeForRemoval(wt)).toMatchObject({ onBranch: false, head: baseCommit });

    // 制造 merge 冲突并停在一半
    writeFileSync(join(repo, "a.txt"), "main\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "main a");
    git(wt, "checkout", "-q", "hub/p");
    writeFileSync(join(wt, "a.txt"), "wt\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "wt a");
    expect(() => git(wt, "merge", "main")).toThrow();
    expect(await probeWorktreeForRemoval(wt)).toMatchObject({ kind: "ok", inProgress: true, clean: false });
  });

  it("isCommitMergedToMain：main 历史里的提交（含 main 本身）是 true，没合入的是 false", async () => {
    const repo = makeRepo("merged-commit");
    const wt = join(root, "wt", "m");
    const { baseCommit } = await addWorktree({ repoFolder: repo, worktreePath: wt, branch: "hub/m" });
    expect(await isCommitMergedToMain(repo, baseCommit)).toBe(true);
    writeFileSync(join(wt, "n.txt"), "1\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "n");
    const sha = git(wt, "rev-parse", "HEAD");
    expect(await isCommitMergedToMain(repo, sha)).toBe(false);
    git(repo, "merge", "--ff-only", "-q", sha);
    expect(await isCommitMergedToMain(repo, sha)).toBe(true);
  });

  it("pinDetachedHead：已被本地分支包含不建；孤悬提交建 hub/detached-… 分支，重复调用幂等", async () => {
    const repo = makeRepo("pin");
    const wt = join(root, "wt", "pin");
    await addWorktree({ repoFolder: repo, worktreePath: wt, branch: "hub/pin" });
    const onBranch = git(wt, "rev-parse", "HEAD");
    expect(await pinDetachedHead(repo, onBranch, "7")).toBeNull();

    git(wt, "checkout", "-q", "--detach");
    writeFileSync(join(wt, "d.txt"), "1\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "d");
    const sha = git(wt, "rev-parse", "HEAD");
    const name = await pinDetachedHead(repo, sha, "7");
    expect(name).toBe(`hub/detached-7-${sha.slice(0, 8)}`);
    expect(git(repo, "rev-parse", name!)).toBe(sha);
    // 分支已经包含它了，第二次不再建
    expect(await pinDetachedHead(repo, sha, "7")).toBeNull();

    // 仅在 origin/main 历史里（不在任何本地 refs/heads 分支里）也不建多余分支
    git(wt, "checkout", "-q", "--detach");
    writeFileSync(join(wt, "remote-only.txt"), "r\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "remote");
    const remoteSha = git(wt, "rev-parse", "HEAD");
    git(repo, "update-ref", "refs/remotes/origin/main", remoteSha);
    expect(await pinDetachedHead(repo, remoteSha, "8")).toBeNull();
    expect(git(repo, "branch", "--list", "hub/detached-8-*")).toBe("");
  });

  it("inspectWorktreeLink：有效 worktree 是 linked；.git 没了或登记目录被删是 orphan", async () => {
    const repo = makeRepo("link");
    const wt = join(root, "wt", "l");
    await addWorktree({ repoFolder: repo, worktreePath: wt, branch: "hub/l" });
    expect(inspectWorktreeLink(wt)).toBe("linked");
    const registry = readFileSync(join(wt, ".git"), "utf8").replace("gitdir:", "").trim();
    // 登记目录被删了一半（HEAD 没了，目录壳还在）也算 orphan
    rmSync(join(registry, "HEAD"));
    expect(inspectWorktreeLink(wt)).toBe("orphan");
    rmSync(registry, { recursive: true, force: true });
    expect(inspectWorktreeLink(wt)).toBe("orphan");
    rmSync(join(wt, ".git"));
    expect(inspectWorktreeLink(wt)).toBe("orphan");
  });

  it("probeOrphanContent：只有被忽略的目录和与分支一致的已跟踪文件 → 没内容；多出未忽略的文件或改了已跟踪文件 → 有内容", async () => {
    const repo = makeRepo("orphan-content");
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "ignore");
    const wt = join(root, "wt", "o");
    await addWorktree({ repoFolder: repo, worktreePath: wt, branch: "hub/o" });
    mkdirSync(join(wt, "node_modules", "x"), { recursive: true });
    writeFileSync(join(wt, "node_modules", "x", "a.js"), "1\n");
    rmSync(join(wt, ".git"));
    expect(await probeOrphanContent(repo, wt, "hub/o")).toEqual({ kind: "ok", hasContent: false });
    writeFileSync(join(wt, "notes.md"), "mine\n");
    expect(await probeOrphanContent(repo, wt, "hub/o")).toEqual({ kind: "ok", hasContent: true });
    rmSync(join(wt, "notes.md"));
    writeFileSync(join(wt, "README.md"), "edited\n");
    expect(await probeOrphanContent(repo, wt, "hub/o")).toEqual({ kind: "ok", hasContent: true });
  });

  it("probeOrphanContent：分支已被 git branch -D 删掉、PR 改动已合入 main（且 main 后续继续演进）→ 不误判为脏改动；半删空壳与嵌套 .gitignore 正常忽略，异常不泄漏临时文件", async () => {
    const isolatedTmp = join(root, "isolated-tmp");
    mkdirSync(isolatedTmp, { recursive: true });
    vi.stubEnv("TMPDIR", isolatedTmp);

    const repo = makeRepo("orphan-merged-branch-deleted");
    mkdirSync(join(repo, "apps", "windows"), { recursive: true });
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n.codegraph/\n");
    writeFileSync(join(repo, "apps", "windows", ".gitignore"), "/target\n");
    writeFileSync(join(repo, "other.txt"), "base-other\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");

    const wt = join(root, "wt", "merged-del");
    const { baseCommit } = await addWorktree({ repoFolder: repo, worktreePath: wt, branch: "hub/merged-del" });
    // Worker 改了 README、新增了 pr-added.ts 并在 .gitignore 新增了 .local-cache/
    writeFileSync(join(wt, ".gitignore"), "node_modules/\n.codegraph/\n.local-cache/\n");
    writeFileSync(join(wt, "README.md"), "from-pr\n");
    writeFileSync(join(wt, "pr-added.ts"), "export const ok = 1;\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "pr work");
    mkdirSync(join(wt, ".local-cache"), { recursive: true });
    writeFileSync(join(wt, ".local-cache", "c.bin"), "cache\n");

    // 模拟真实合并脚本：squash/merge 合入 main，再解绑 worktree + git branch -D 删掉分支，随后 main 又继续演进改了 README.md 和 other.txt
    git(repo, "merge", "--squash", "-q", "hub/merged-del");
    git(repo, "commit", "-q", "-m", "squash merge pr");
    const registry = readFileSync(join(wt, ".git"), "utf8").replace("gitdir:", "").trim();
    rmSync(registry, { recursive: true, force: true });
    git(repo, "worktree", "prune");
    git(repo, "branch", "-D", "hub/merged-del");

    writeFileSync(join(repo, "other.txt"), "later-on-main\n");
    writeFileSync(join(repo, "README.md"), "later-readme-on-main\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "next pr on main");

    // 孤儿目录里：README.md 与 pr-added.ts 是该 PR 合入时的版本，other.txt 仍停在 baseCommit，分支已删（ref = null）
    expect(await probeOrphanContent(repo, wt, null, { baseCommit })).toEqual({ kind: "ok", hasContent: false });

    // 若真的留有未提交修改，仍准确拦住
    writeFileSync(join(wt, "pr-added.ts"), "uncommitted-edit\n");
    expect(await probeOrphanContent(repo, wt, null, { baseCommit })).toEqual({ kind: "ok", hasContent: true });

    // 模拟 git worktree remove 删了一半中断：所有源码和根/子目录 .gitignore 全被删光，只剩 node_modules、.codegraph、apps/windows/target
    const halfDeleted = join(root, "wt", "half-deleted");
    mkdirSync(join(halfDeleted, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(halfDeleted, "node_modules", "pkg", "index.js"), "1\n");
    mkdirSync(join(halfDeleted, ".codegraph"), { recursive: true });
    writeFileSync(join(halfDeleted, ".codegraph", "db"), "1\n");
    mkdirSync(join(halfDeleted, "apps", "windows", "target", "debug"), { recursive: true });
    writeFileSync(join(halfDeleted, "apps", "windows", "target", "debug", "app"), "bin\n");
    expect(await probeOrphanContent(repo, halfDeleted, null, { baseCommit })).toEqual({ kind: "ok", hasContent: false });

    // 完全空的目录壳也不会被满屏 tracked delete (.D) 卡住
    const emptyShell = join(root, "wt", "empty-shell");
    mkdirSync(emptyShell, { recursive: true });
    expect(await probeOrphanContent(repo, emptyShell, null, { baseCommit })).toEqual({ kind: "ok", hasContent: false });

    // 异常分支（不存在的 ref、非仓库）均可靠清理临时索引目录，TMPDIR 零残留
    expect((await probeOrphanContent(repo, emptyShell, "refs/heads/no-such-ref")).kind).toBe("failed");
    expect((await probeOrphanContent(join(root, "not-a-repo"), emptyShell, null)).kind).toBe("failed");
    expect(readdirSync(isolatedTmp)).toEqual([]);
  });
});
