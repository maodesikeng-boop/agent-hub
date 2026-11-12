import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { mainRepoRoot, pmSandboxInput, pmSandboxProfile, realOr, SANDBOX_EXEC } from "./isolation.ts";
import { boundedText, markActive } from "./lifecycle.ts";
import { pruneFailedWork, pruneRuns } from "./report.ts";
const root = mkdtempSync(join(tmpdir(), "eval-isolation-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
it("不存在的子路径仍解析软链祖先", () => {
  mkdirSync(join(root, "real")); symlinkSync(join(root, "real"), join(root, "alias"));
  expect(realOr(join(root, "alias", "missing", "child"))).toBe(join(realOr(root), "real/missing/child"));
});
it("git common-dir 定位真主仓库，依赖 realpath 在禁读后豁免", () => {
  const repo = join(root, "main"); const work = join(root, "worktree");
  mkdirSync(repo); const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q"); git("-c", "user.name=eval", "-c", "user.email=eval@example.invalid", "commit", "--allow-empty", "-qm", "init");
  git("worktree", "add", "--detach", work);
  mkdirSync(join(repo, "node_modules")); symlinkSync(join(repo, "node_modules"), join(work, "node_modules"));
  expect(mainRepoRoot(work)).toBe(realOr(repo));
  const input = pmSandboxInput(work, {}); const profile = pmSandboxProfile(input);
  const depRule = '(allow file-read* (subpath "' + join(work, "node_modules") + '")';
  expect(profile).toContain('(subpath "' + realOr(repo) + '")');
  expect(profile.indexOf(depRule)).toBeGreaterThan(profile.indexOf("(deny file-read*"));
  expect(profile).toContain('(subpath "' + realOr(join(repo, "node_modules")) + '")');
});
it("活跃旧运行和现场不被淘汰，释放后正常删除", () => {
  const runs = join(root, "runs"); const work = join(root, "w");
  const run = join(runs, "20000101-000000-000-abcdef"); const trial = join(work, "ah-eval-active");
  mkdirSync(run, { recursive: true }); mkdirSync(trial, { recursive: true });
  const release = markActive(run); const releaseTrial = markActive(trial);
  for (let i = 0; i < 15; i++) mkdirSync(join(work, "ah-eval-" + i));
  expect(pruneRuns(runs, Date.now() + 100 * 86400000)).toEqual([]);
  pruneFailedWork(work); expect(existsSync(trial)).toBe(true);
  release(); releaseTrial(); expect(pruneRuns(runs, Date.now() + 100 * 86400000)).toContain(run);
});
it("整份 UTF-8 文本有字节上限并标明截断", () => {
  const text = boundedText("中😀".repeat(1000), 101);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(101); expect(text).toContain("截断"); expect(text).not.toContain("�");
});
const available = process.platform === "darwin" && spawnSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"]).status === 0;
it.skipIf(!available)("真 SBPL 拒绝外写与凭据读取，专属目录可写", () => {
  const work = join(root, "allowed"); mkdirSync(work);
  writeFileSync(join(work, "router.json"), "{}");
  const home = join(root, "user"); mkdirSync(join(home, ".ssh"), { recursive: true }); writeFileSync(join(home, ".ssh/key"), "sentinel");
  const profile = pmSandboxProfile({ home, realRepo: join(root, "source"), realDataDirs: [join(home, ".agent-hub")], claudeConfigDir: join(home, ".claude"), denyExec: ["/usr/bin/ssh"], daemonPorts: [4317], writableDirs: [work] });
  const run = (script: string) => spawnSync(SANDBOX_EXEC, ["-p", profile, "/bin/sh", "-c", script], { encoding: "utf8" });
  expect(run('touch "' + join(work, "yes") + '"').status).toBe(0);
  expect(run('touch "' + join(root, "no") + '"').status).not.toBe(0);
  expect(run('echo broken > "' + join(work, "router.json") + '"').status).not.toBe(0);
  expect(run('cat "' + join(home, ".ssh/key") + '"').stderr).toMatch(/permitted|denied/i);
});

it("回收独立进程组也关闭后台子进程持有的管道", async () => {
  const { spawn } = await import("node:child_process");
  const { killGroup } = await import("./lifecycle.ts");
  const child = spawn("/bin/sh", ["-c", "sleep 30 & echo ready; wait"], { detached: true });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    if (!child.pid) throw new Error("子进程未启动");
    killGroup(child.pid);
    await closed;
  } finally { if (child.pid) killGroup(child.pid); }
}, 5_000);
