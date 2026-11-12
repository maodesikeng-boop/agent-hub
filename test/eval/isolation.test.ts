import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { CLAUDE_CONFIG_STATE_DIRS, claudeEnvScript, claudeScratchRules, mainRepoRoot, pmSandboxInput, pmSandboxProfile, realOr, SANDBOX_EXEC, SHIM_NAMES } from "./isolation.ts";
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

// ---- claude 的 Bash 工具写 /private/tmp/claude-<uid>：默认禁写的沙箱要按 claude 的写法放行 ----
const claudeProfile = (extra: { uid?: number } = {}) =>
  pmSandboxProfile({ home: join(root, "user"), realRepo: join(root, "source"), realDataDirs: [join(root, "user/.agent-hub")], claudeConfigDir: join(root, "user/.claude"), denyExec: [], daemonPorts: [4317], ...extra });
it("放行 claude 的 Bash 临时目录 /tmp/claude-<uid>（/tmp 与 /private/tmp 两种写法）和 claude-<id>-cwd，不放行整个 /tmp", () => {
  const profile = claudeProfile({ uid: 502 });
  expect(profile).toContain('(subpath "/private/tmp/claude-502")');
  expect(profile).toContain('(regex #"^/private/tmp/claude-[A-Za-z0-9_-]+-cwd$")');
  expect(profile).not.toMatch(/\(subpath "\/(private\/)?tmp"\)/);
  expect(claudeScratchRules(502).join(" ")).toContain('(subpath "/tmp/claude-502")'.replace("/tmp/", realOr("/tmp") + "/"));
});
it("取不到 uid 时放行任意 claude-<数字>，仍不放行整个 /tmp", () => {
  const rules = claudeScratchRules(undefined).join(" ");
  expect(rules).toContain('(regex #"^/private/tmp/claude-[0-9]+(/|$)")');
  expect(rules).not.toContain("subpath");
});
it("claude 多轮工具调用要写的状态目录放行；CLAUDE.md、settings*.json、hooks、真数据目录始终禁写", () => {
  const profile = claudeProfile({ uid: 502 });
  const cfg = join(root, "user/.claude");
  for (const dir of ["shell-snapshots", "session-env", "telemetry", "todos", "statsig", "debug"]) {
    expect(CLAUDE_CONFIG_STATE_DIRS).toContain(dir);
    expect(profile).toContain(`(subpath "${join(cfg, dir)}")`);
  }
  expect(profile).toContain(`(subpath "${join(root, "user/.cache/claude")}")`);
  // 不放行的：配置本身、会话记录（projects 只放行被测项目自己的）、claude 程序本体
  for (const forbidden of [cfg, join(cfg, "CLAUDE.md"), join(cfg, "settings.json"), join(cfg, "projects"), join(cfg, "hooks"), join(root, "user/.local/share/claude"), join(root, "user/.agent-hub")]) {
    const allowLines = profile.split("\n").filter((l) => l.startsWith("(allow file-write*"));
    expect(allowLines.some((l) => l.includes(`(subpath "${forbidden}")`))).toBe(false);
  }
  const lines = profile.split("\n");
  const lastAllow = lines.map((l, i) => (l.startsWith("(allow file-write*") ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  const denySettings = lines.findIndex((l) => l.startsWith("(deny file-write*") && l.includes("settings"));
  expect(denySettings).toBeGreaterThan(lastAllow);
  expect(lines[denySettings]).toContain(`(subpath "${join(cfg, "CLAUDE.md")}")`);
  expect(lines[denySettings]).toContain(`#"^${join(cfg, "settings").replace(/\./g, "\\.")}[^/]*$"`);
});
it.skipIf(!available)("真 SBPL：真 claude 的 Bash 在 /private/tmp/claude-<uid> 下建任务目录、写 cwd 记录能成；写别的 /tmp、配置、真数据目录仍被拒", () => {
  const uid = 9_000_000 + (process.pid % 1000);
  const scratch = `/private/tmp/claude-${uid}`;
  const home = realOr(join(root, "user")); const cfg = join(home, ".claude");
  mkdirSync(join(home, ".agent-hub"), { recursive: true }); mkdirSync(cfg, { recursive: true }); writeFileSync(join(cfg, "settings.json"), "{}"); writeFileSync(join(cfg, "CLAUDE.md"), "x");
  const profile = pmSandboxProfile({ home, realRepo: join(root, "source"), realDataDirs: [join(home, ".agent-hub")], claudeConfigDir: cfg, denyExec: [], daemonPorts: [4317], uid });
  const run = (script: string) => spawnSync(SANDBOX_EXEC, ["-p", profile, "/bin/sh", "-c", script], { encoding: "utf8" });
  const probeCwd = `/private/tmp/claude-evalcwd${process.pid}-cwd`; const other = `/private/tmp/eval-other-${process.pid}`;
  try {
    // 跟 claude 一样：先建 claude-<uid>（0700）、再 mkdir -p 项目目录/会话/tasks、写 cwd 文件（用 /tmp 的写法）
    const ok = run(`mkdir -p -m 700 /tmp/claude-${uid} && mkdir -p ${scratch}/-proj-probe/sess/tasks && echo hi > ${scratch}/-proj-probe/sess/tasks/t.output && pwd -P >| /tmp/claude-evalcwd${process.pid}-cwd && chmod 700 ${scratch}`);
    expect(ok.stderr).toBe(""); expect(ok.status).toBe(0);
    for (const bad of [`mkdir ${other}`, `touch /private/tmp/claude-${uid + 1}-x`, `mkdir -p /private/tmp/claude-${uid + 1}/a`, `touch ${join(cfg, "settings.json")}`, `touch ${join(cfg, "settings.local.json")}`, `touch ${join(cfg, "CLAUDE.md")}`, `touch ${join(home, ".agent-hub/x")}`, `mkdir ${join(cfg, "hooks")}`, `mkdir ${join(cfg, "projects")}`]) {
      const r = run(bad); expect(r.stderr, bad).toMatch(/not permitted|denied/i); expect(r.status, bad).not.toBe(0);
    }
    for (const good of ["shell-snapshots", "session-env", "telemetry", "todos", "statsig", "debug"]) expect(run(`mkdir -p ${join(cfg, good)} && touch ${join(cfg, good, "x")}`).status, good).toBe(0);
  } finally { rmSync(scratch, { recursive: true, force: true }); rmSync(probeCwd, { force: true }); rmSync(other, { recursive: true, force: true }); }
});

// ---- CLAUDE_ENV_FILE：用户 shell 快照里怎么排 PATH、有没有同名别名函数，替身都在最前面 ----
for (const shell of ["/bin/bash", "/bin/zsh"].filter((p) => existsSync(p))) {
  it(`CLAUDE_ENV_FILE 在 ${shell} 里压过快照：真 gh 在 PATH 前面、同名别名和函数都不能抢在替身前面`, () => {
    const dir = mkdtempSync(join(root, "envfile-")); const bin = join(dir, "bin"); const real = join(dir, "homebrew");
    mkdirSync(bin); mkdirSync(real);
    for (const [d, tag] of [[bin, "shim"], [real, "real"]] as const) for (const name of SHIM_NAMES) { writeFileSync(join(d, name), `#!/bin/sh\necho ${tag}\n`); chmodSync(join(d, name), 0o755); }
    const envFile = join(dir, "claude-env.sh"); writeFileSync(envFile, claudeEnvScript(bin));
    // 模拟 claude 的拼法：source 快照（用户 .zprofile 把真目录提前、定义同名函数）→ source CLAUDE_ENV_FILE → 命令
    const snapshot = join(dir, "snapshot.sh");
    writeFileSync(snapshot, `export PATH='${real}':'${bin}':/usr/bin:/bin\n${SHIM_NAMES.map((n) => `${n}() { echo function-${n}; }`).join("\n")}\n${shell.endsWith("bash") ? "shopt -s expand_aliases\n" : ""}${SHIM_NAMES.map((n) => `alias ${n}='echo alias-${n}'`).join("\n")}\nhash -r\n`);
    const script = `. '${snapshot}'\n. '${envFile}'\n:\n${SHIM_NAMES.map((n) => `command -v ${n}`).join("\n")}\ngh --version\n`;
    const r = spawnSync(shell, ["-c", script], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: dir } });
    expect(r.stderr).toBe("");
    expect(r.stdout.trim().split("\n")).toEqual([...SHIM_NAMES.map((n) => join(bin, n)), "shim"]);
  });
}
