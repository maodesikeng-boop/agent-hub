// 回放包的守卫（设计第 7 节、任务说明的隐私要求）：总共不超过 5MB、单个文件不超过 500KB；不含本机用户名路径、邮箱（GitHub 公开的
// noreply 地址除外：补丁里的提交人就是它，去掉提交号就对不上了）、令牌。
import { execFileSync as run } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { EVAL_REPLAY_MAX_FILE_BYTES, EVAL_REPLAY_MAX_TOTAL_BYTES } from "./limits.ts";
import { REPLAY_DIR, scenarioById } from "./scenarios.ts";

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

const all = files(REPLAY_DIR);
const texts = all.filter((f) => !f.endsWith(".png"));

describe("回放包", () => {
  it("大小在上限内", () => {
    const sizes = all.map((f) => ({ f: relative(REPLAY_DIR, f), n: statSync(f).size }));
    expect(sizes.filter((s) => s.n > EVAL_REPLAY_MAX_FILE_BYTES)).toEqual([]);
    expect(sizes.reduce((n, s) => n + s.n, 0)).toBeLessThanOrEqual(EVAL_REPLAY_MAX_TOTAL_BYTES);
  });

  it.each(texts.map((f) => relative(REPLAY_DIR, f)))("%s 没有隐私：本机路径、邮箱、令牌", (rel) => {
    const text = readFileSync(join(REPLAY_DIR, rel), "utf8");
    expect(text).not.toMatch(/\/Users\/[^/\s]+|\/home\/(?!runner\b)[^/\s]+/);
    const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
    expect(emails.filter((e) => !e.endsWith("@users.noreply.github.com"))).toEqual([]);
    expect(text).not.toMatch(/\b(gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9-]{20,}|github_pat_[A-Za-z0-9_]{20,})/);
  });

  it("截图里没有本机路径", () => {
    for (const f of all.filter((x) => x.endsWith(".png"))) expect(readFileSync(f).toString("latin1")).not.toMatch(/\/Users\/[a-z]/);
  });
});

// 托盘 Worker 回放时在基准提交上打补丁，提交号要和汇报里写的一样（da36ed7），项目经理去查才对得上。
// 要仓库历史里有基准提交（CI 的浅克隆没有，跳过；本机全量克隆里跑）。

const repoRoot = new URL("../../", import.meta.url).pathname;
const tray = scenarioById("s3a-tray");
const hasBase = (() => {
  try {
    run("git", ["-C", repoRoot, "cat-file", "-e", `${tray.baseCommit}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("回放提交", () => {
  it.skipIf(!hasBase)("在基准提交上打托盘补丁，提交号就是汇报里的 da36ed7", () => {
    const dir = mkdtempSync(join(tmpdir(), "ah-evalam-"));
    try {
      const patch = tray.workers[0]!.patch!;
      const git = (...args: string[]) => run("git", ["-c", "user.name=eval", "-c", "user.email=eval@example.invalid", ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_COMMITTER_NAME: patch.committer.name, GIT_COMMITTER_EMAIL: patch.committer.email } }).trim();
      git("init", "-q");
      git("fetch", "-q", "--depth=1", repoRoot, tray.baseCommit);
      git("checkout", "-q", "FETCH_HEAD");
      git("am", "-q", "--committer-date-is-author-date", join(REPLAY_DIR, patch.file));
      expect(git("rev-parse", "HEAD")).toBe("da36ed775e9c3b4e63e8606cdf14c7e903e63f41");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
