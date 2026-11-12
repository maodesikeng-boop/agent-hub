import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { installHubShim } from "../../src/daemon/agent-api/shim.ts";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { CLAUDE_CONFIG_STATE_DIRS, claudeEnvScript, claudeScratchRules, mainRepoRoot, pmSandboxInput, pmSandboxProfile, realOr, SANDBOX_EXEC, SHIM_NAMES, writeShims } from "./isolation.ts";
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
it.skipIf(!available)("真 SBPL 拦住发给沙箱外进程的信号（含同进程组的父进程），沙箱内部照常", async () => {
  const outsider = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
  const exited = new Promise<void>((resolve) => { outsider.once("exit", () => resolve()); outsider.once("error", () => resolve()); });
  const run = (script: string) => spawnSync(SANDBOX_EXEC, ["-p", signalProfile, "/bin/sh", "-c", script], { encoding: "utf8" });
  try {
    // sandbox-exec 自己出错（规则写错 65、起不来 71）时 status 也非 0，会让“被拦”断言空转：先确认里面的 sh 真跑了
    const ran = run("echo alive");
    expect(ran.stderr).not.toMatch(/sandbox-exec|sandbox_apply/);
    expect(ran.status).toBe(0);
    expect(ran.stdout.trim()).toBe("alive");
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
  } finally {
    // 任何断言提前抛错都要杀掉 outsider 并等它退出，免得被 test/spawn-guard.ts 报残留
    if (outsider.pid) { try { process.kill(-outsider.pid, "SIGKILL"); } catch { /* 已退出 */ } }
    if (outsider.exitCode === null && outsider.signalCode === null) await exited;
  }
}, 10_000);

// sandbox_compile_string 只编译不 apply，嵌套沙箱里也能跑；能当场抓出 SBPL 语法错（如字符类末尾的 -]）
const COMPILE_PY = [
  "import ctypes, sys",
  "lib = ctypes.CDLL('/usr/lib/libsandbox.1.dylib')",
  "lib.sandbox_compile_string.restype = ctypes.c_void_p",
  "lib.sandbox_compile_string.argtypes = [ctypes.c_char_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_char_p)]",
  "err = ctypes.c_char_p()",
  "r = lib.sandbox_compile_string(sys.stdin.buffer.read(), None, ctypes.byref(err))",
  "sys.stderr.write((err.value or b'').decode())",
  "sys.exit(0 if r else 1)",
].join("\n");
const compileSbpl = (profile: string) => spawnSync("python3", ["-I", "-c", COMPILE_PY], { input: profile, encoding: "utf8" });
const canCompile = process.platform === "darwin" && spawnSync("python3", ["-I", "-c", "import ctypes; ctypes.CDLL('/usr/lib/libsandbox.1.dylib')"]).status === 0;
it.skipIf(!canCompile)("整份 pmSandboxProfile 能被 sandbox_compile_string 编译（各种参数组合，不是只看字符串）", () => {
  const home = join(root, "user");
  const base = { home, realRepo: join(root, "source"), realDataDirs: [join(home, ".agent-hub")], claudeConfigDir: join(home, ".claude"), denyExec: ["/usr/bin/ssh"], daemonPorts: [4317] };
  for (const extra of [{}, { uid: 502 }, { uid: undefined, projectDirs: [join(root, "proj")], writableDirs: [join(root, "w")], mainRepo: join(root, "main") }]) {
    const r = compileSbpl(pmSandboxProfile({ ...base, ...extra }));
    expect(r.stderr).toBe(""); expect(r.status).toBe(0);
  }
  // 守卫自己有效：字符类末尾的 -] 在 SBPL 里是语法错
  expect(compileSbpl('(version 1)(allow default)(allow file-write* (regex #"^/x-[a-z_-]+$"))').status).not.toBe(0);
});

// ---- claude 的 Bash 工具写 /private/tmp/claude-<uid>：默认禁写的沙箱要按 claude 的写法放行 ----
const claudeProfile = (extra: { uid?: number } = {}) =>
  pmSandboxProfile({ home: join(root, "user"), realRepo: join(root, "source"), realDataDirs: [join(root, "user/.agent-hub")], claudeConfigDir: join(root, "user/.claude"), denyExec: [], daemonPorts: [4317], ...extra });
it("放行 claude 的 Bash 临时目录 /tmp/claude-<uid>（/tmp 与 /private/tmp 两种写法）和 claude-<id>-cwd，不放行整个 /tmp", () => {
  const profile = claudeProfile({ uid: 502 });
  expect(profile).toContain('(subpath "/private/tmp/claude-502")');
  expect(profile).toContain('(regex #"^/private/tmp/claude-[-A-Za-z0-9_]+-cwd$")');
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

it("祖先 metadata 规则覆盖逻辑路径与真实路径，不放开 data；空 socket 列表不拒全部出站", () => {
  const runs = join(root, "metadata-runs");
  const repo = join(root, "metadata-repo");
  const profile = pmSandboxProfile({ home: root, realRepo: repo, realDataDirs: [], daemonPorts: [], denyExec: [],
    claudeConfigDir: join(root, ".claude"), readDenied: [runs], writableDirs: [join(runs, "current/trial")] });
  for (const path of [runs, join(runs, "current"), repo]) {
    for (const alias of new Set([path, realOr(path)])) expect(profile).toContain(`(literal "${alias}")`);
  }
  expect(profile).not.toMatch(/\(deny network-outbound\s*\)/);
  if (canCompile) expect(compileSbpl(profile).status).toBe(0);
});

it("依赖是软链且父目录路径经软链别名（/tmp → /private/tmp）时，被禁目录的真实侧祖先也放行 metadata，且在 deny file-read* 之后", () => {
  const real = join(root, "alias-real"); const link = join(root, "alias-link");
  mkdirSync(join(real, "source"), { recursive: true }); mkdirSync(join(root, "alias-deps/node_modules"), { recursive: true });
  symlinkSync(real, link); symlinkSync(join(root, "alias-deps/node_modules"), join(real, "source/node_modules"));
  const repo = join(link, "source");
  const profile = pmSandboxProfile({ home: root, realRepo: repo, realDataDirs: [], daemonPorts: [], denyExec: [],
    claudeConfigDir: join(root, ".claude"), dependencies: [join(repo, "node_modules")] });
  // Node realpath 走“真实父目录 + 软链末级”：source 的 metadata 与 source/node_modules 本身都要对得上
  const realSource = join(realOr(real), "source");
  expect(profile).toContain(`(literal "${realSource}")`);
  expect(profile).toContain(`(literal "${join(link, "source")}")`);
  expect(profile).toContain(`(subpath "${join(realSource, "node_modules")}")`);
  expect(profile.lastIndexOf("(allow file-read-metadata")).toBeGreaterThan(profile.lastIndexOf("(deny file-read* (subpath"));
  if (canCompile) expect(compileSbpl(profile).status).toBe(0);
  if (!available) return;
  const r = spawnSync(SANDBOX_EXEC, ["-p", profile, process.execPath, "-e", "const fs=require('fs');fs.realpathSync(process.argv[1]);try{fs.readdirSync(process.argv[2]);process.exit(2)}catch(e){process.exit(e.code==='EPERM'?0:3)}", join(repo, "node_modules"), repo], { encoding: "utf8" });
  expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
});

// 同一夹具也在 Worker 无嵌套沙箱时裸跑，保证宿主机专用测试的命令、回放和假服务不会腐烂。
for (const sandboxed of [false, true]) {
  it.skipIf(sandboxed && !available)(`${sandboxed ? "真沙箱" : "夹具自检"}：runs 父目录封锁下的 Bash、Node gh/git/hub 与评测 socket 全链路`, async () => {
    const dir = mkdtempSync("/tmp/ev-chain-");
    const runs = join(dir, "runs");
    const trial = join(runs, "current/trial");
    const workspace = join(trial, "workspace");
    const source = new URL("../../", import.meta.url).pathname;
    const version = join(dir, "v/current");
    const repo = join(dir, "source");
    const binDir = join(trial, "bin");
    const ghDir = join(trial, "gh");
    const recordFile = join(trial, "recorded.jsonl");
    const sock = join(trial, "hub.sock");
    const realSock = join(dir, "real/run/hub.sock");
    const calls: string[] = [];
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => { calls.push(req.url ?? ""); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true, text: "eval-hub-ok" })); });
    });
    const realServer = createServer((_req, res) => res.end("should never connect"));
    try {
      for (const d of [workspace, join(runs, "other-run"), version, repo, join(trial, "tmp"), join(dir, "real/run")]) mkdirSync(d, { recursive: true });
      writeFileSync(join(runs, "other-run/secret"), "secret");
      // 与 prepareVersion 同构：导出版本源码，node_modules 指回禁读的源仓库。
      cpSync(join(source, "src"), join(version, "src"), { recursive: true });
      cpSync(join(source, "package.json"), join(version, "package.json"));
      symlinkSync(join(source, "node_modules"), join(repo, "node_modules"));
      symlinkSync(join(repo, "node_modules"), join(version, "node_modules"));
      writeShims({ binDir, ghDir, recordFile }, { node: process.execPath, realGit: "/usr/bin/git" });
      installHubShim({ binDir, mainScript: join(version, "src/hub/main.ts") });
      writeFileSync(join(ghDir, "diff.patch"), "eval-diff\n");
      writeFileSync(join(ghDir, "replay.json"), JSON.stringify({ repo: "eval/demo", nextPr: 2, baseDir: ghDir, logMaxBytes: 1024,
        prs: [{ number: 1, title: "test", body: "", state: "OPEN", headRefName: "topic", headRefOid: "a".repeat(40), files: [], diffFile: "diff.patch",
          checks: { runId: 1, workflow: "ci", jobs: [{ name: "test", databaseId: 1, elapsed: "1s" }], attempts: [{ status: "pass" }] } }] }));
      execFileSync("/usr/bin/git", ["init", "-q", workspace]);
      execFileSync("/usr/bin/git", ["-C", workspace, "-c", "user.name=eval", "-c", "user.email=eval@example.invalid", "commit", "--allow-empty", "-qm", "init"]);
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(sock, resolve); });
      await new Promise<void>((resolve, reject) => { realServer.once("error", reject); realServer.listen(realSock, resolve); });
      const profile = pmSandboxProfile({ home: dir, realRepo: repo, mainRepo: source, dependencies: [join(repo, "node_modules"), join(source, "node_modules")],
        realDataDirs: [join(dir, "real")], daemonPorts: [], denyExec: [], claudeConfigDir: join(dir, ".claude"),
        writableDirs: [trial], projectDirs: [workspace], readDenied: [runs] });
      if (canCompile) expect(compileSbpl(profile).status).toBe(0);
      const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
      const run = async (script: string) => {
        const argv = ["/bin/bash", "-lc", `. ${quote(join(trial, "env.sh"))}\nset -e\n${script}`];
        const child = spawn(sandboxed ? SANDBOX_EXEC : argv[0]!, sandboxed ? ["-p", profile, ...argv] : argv.slice(1), {
          cwd: workspace, env: { ...process.env, TMPDIR: join(trial, "tmp"), HUB_SOCK: sock, HUB_TOKEN: "eval-token", EVAL_GH_DIR: ghDir, EVAL_RECORD_FILE: recordFile },
        });
        let stdout = ""; let stderr = "";
        child.stdout.on("data", (b) => { stdout += b; }); child.stderr.on("data", (b) => { stderr += b; });
        const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
        expect({ code, stderr }, script).toEqual({ code: 0, stderr: expect.not.stringMatching(/EPERM|EACCES|sandbox_apply/) });
        return stdout;
      };
      writeFileSync(join(trial, "env.sh"), claudeEnvScript(binDir));
      expect(await run("which gh\ngh --version\ngh pr view 1\ngh pr checks 1\ngh pr diff 1\ngh pr merge 1")).toContain("eval-gh-shim");
      expect(readFileSync(join(ghDir, "calls.jsonl"), "utf8").trim().split("\n")).toHaveLength(4);
      await run("git status\ngit log -1\ngit branch\ngit push");
      expect(readFileSync(recordFile, "utf8")).toContain('"tool":"git"');
      await run(`${quote(process.execPath)} -e ${quote("const fs=require('fs');fs.realpathSync(process.cwd());fs.realpathSync(process.argv[1])")} ${quote(join(repo, "node_modules/vitest"))}`);
      for (const command of ["status", "ask --stdin", "worker start --title probe --stdin", "worker show 1", "worker end 1", "graph create --stdin", "graph show 1", "persona show", "persona edit --text probe --reason probe"]) {
        expect(await run(`echo '{"nodes":[]}' | hub ${command}`)).toContain("eval-hub-ok");
      }
      expect(calls).toHaveLength(9);
      if (sandboxed) {
        const probe = `const fs=require('fs');for(const p of ${JSON.stringify([runs, repo, source])}){try{fs.readdirSync(p);throw Error('read allowed')}catch(e){if(e.code!=='EPERM')throw e}}try{fs.readFileSync(${JSON.stringify(join(runs, "other-run/secret"))});throw Error('secret allowed')}catch(e){if(e.code!=='EPERM')throw e}`;
        await run(`${quote(process.execPath)} -e ${quote(probe)}`);
        // 真 socket 的连接必须被权限拒绝；评测 socket 上面的九条 hub 命令必须成功。
        await run(`${quote(process.execPath)} -e ${quote("const s=require('net').connect(process.argv[1]);s.on('connect',()=>process.exit(2));s.on('error',e=>process.exit(e.code==='EPERM'?0:3))")} ${quote(realSock)}`);
      }
    } finally {
      await Promise.all([server, realServer].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
}
