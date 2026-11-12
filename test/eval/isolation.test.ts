import { execFileSync, spawn, spawnSync } from "node:child_process";
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

const signalProfile = pmSandboxProfile({ home: root, realRepo: join(root, "source"), realDataDirs: [join(root, ".agent-hub")], claudeConfigDir: join(root, ".claude"), denyExec: [], daemonPorts: [4317] });
it("信号规则整条先拒、只放同沙箱（others 不含同进程组，不能靠它）", () => {
  expect(signalProfile).toContain("(deny signal)\n(allow signal (target same-sandbox))");
  expect(signalProfile).not.toContain("(target others)");
});
it("禁止执行的列表为空时不输出无过滤条件的 deny process-exec（那会禁掉所有 exec）", () => {
  expect(signalProfile).not.toMatch(/\(deny process-exec\s*\)/);
  expect(pmSandboxProfile({ home: root, realRepo: join(root, "source"), realDataDirs: [], claudeConfigDir: join(root, ".claude"), denyExec: ["/usr/bin/ssh"], daemonPorts: [] })).toContain('(deny process-exec (literal "/usr/bin/ssh"))');
});
it.skipIf(!available)("真 SBPL 拦住发给沙箱外进程的信号（含同进程组的父进程），沙箱内部照常", () => {
  const outsider = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
  const run = (script: string) => spawnSync(SANDBOX_EXEC, ["-p", signalProfile, "/bin/sh", "-c", script], { encoding: "utf8" });
  // sandbox-exec 自己出错（规则写错 65、起不来 71）时 status 也非 0，会让“被拦”断言空转：先确认里面的 sh 真跑了
  const ran = run("echo alive");
  expect(ran.stderr).not.toMatch(/sandbox-exec|sandbox_apply/);
  expect(ran.status).toBe(0);
  expect(ran.stdout.trim()).toBe("alive");
  try {
    for (const pid of [process.pid, outsider.pid!]) {
      for (const sig of ["-0", "-URG"]) {
        // 必须是 sh 里的 kill 被沙箱拒绝：退出码 1 + Operation not permitted，不是 sandbox-exec 的 65/71
        const r = run("kill " + sig + " " + pid);
        expect(r.stderr).toMatch(/not permitted/i);
        expect(r.stderr).not.toMatch(/sandbox-exec|sandbox_apply/);
        expect(r.status).toBe(1);
      }
    }
    expect(() => process.kill(outsider.pid!, 0)).not.toThrow();
    const inner = run('sleep 30 & p=$!; /bin/sh -c "kill -TERM $p"; wait $p; [ $? -eq 143 ]');
    expect(inner.stderr).not.toMatch(/not permitted|sandbox-exec|sandbox_apply/i);
    expect(inner.status).toBe(0);
  } finally { try { process.kill(-outsider.pid!, "SIGKILL"); } catch { /* 已退出 */ } }
});
