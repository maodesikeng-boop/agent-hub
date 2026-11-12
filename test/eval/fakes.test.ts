// 隔离零件的自测（不起守护进程、不派 Worker，Worker 沙箱里也能跑）：gh 替身回放和记录、git push 只记录、ssh 等只记录、
// claude 分流脚本按角色分、沙箱规则里该挡的都在、给守护进程的环境变量断开了真 GitHub。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { shortTmp } from "../e2e/harness.ts";
import { readJsonl } from "./facts.ts";
import { route, settingsWithoutOwnSandbox, type RouterConfig } from "./fakes/claude-router.ts";
import { RECORD_ONLY_TOOLS, claudeEnvScript, isolationEnv, pmSandboxProfile, realGitPath, scrubbedEnvNames, writeShims } from "./isolation.ts";
import { REPLAY_DIR, SCENARIOS, scenarioById } from "./scenarios.ts";
import { overrunTurn, workerSessions, writeGhReplay, writeStubs, type TrialPlan } from "./trial.ts";
import type { GhCall, RecordedCall, ScenarioId } from "./types.ts";

const root = mkdtempSync(join(shortTmp(), "ah-evalfake-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function setup(scenarioId: ScenarioId) {
  const dir = mkdtempSync(join(root, "t-"));
  const paths = { binDir: join(dir, "bin"), ghDir: join(dir, "gh"), recordFile: join(dir, "recorded.jsonl") };
  writeShims(paths, { node: process.execPath, realGit: realGitPath() });
  writeGhReplay(paths.ghDir, scenarioById(scenarioId));
  const env = { ...process.env, PATH: `${paths.binDir}:${process.env.PATH}`, EVAL_GH_DIR: paths.ghDir, EVAL_RECORD_FILE: paths.recordFile };
  const run = (cmd: string, args: string[], cwd = dir) => spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
  return { dir, paths, run, ghCalls: () => readJsonl<GhCall>(join(paths.ghDir, "calls.jsonl")), recorded: () => readJsonl<RecordedCall>(paths.recordFile) };
}

describe("gh 替身", () => {
  it("回放 PR 288：检查全绿、改动文件名单、合并只改替身的状态；每次调用都记下来", () => {
    const t = setup("s3a-tray");
    const checks = t.run("gh", ["pr", "checks", "288"]);
    expect(checks.status).toBe(0);
    expect(checks.stdout).toContain("check (ubuntu 1/4)\tpass");
    expect(t.run("gh", ["pr", "view", "288", "--json", "files", "-q", ".files[].path"]).stdout).toContain("src/web/components/RouterWorkbench.tsx");
    expect(t.run("gh", ["auth", "token", "--user", "someone"]).stdout.trim()).toMatch(/^gho_EvalReplay/);
    expect(t.run("gh", ["pr", "diff", "288"]).stdout).toContain("max-h-[33dvh]");
    expect(t.run("gh", ["pr", "merge", "288", "--merge"]).stdout).toContain("Merged pull request #288");
    expect(t.run("gh", ["pr", "view", "288", "--json", "state"]).stdout).toContain("MERGED");
    expect(t.ghCalls().map((c) => c.action)).toEqual(["pr checks", "pr view --json files", "auth token", "pr diff", "pr merge", "pr view --json state"]);
    expect(t.ghCalls().find((c) => c.action === "pr merge")).toMatchObject({ pr: 288, checks: "pass" });
  });

  it("S5a：检查全挂，失败日志是真实那段，重跑之后还是挂（第二次的日志）", () => {
    const t = setup("s5a-ci-mirror");
    const checks = t.run("gh", ["pr", "checks", "288"]);
    expect(checks.status).toBe(1);
    expect(checks.stdout).toContain("\tfail\t");
    const log = t.run("gh", ["run", "view", "43040062881", "--log-failed"]).stdout;
    expect(log).toContain("Temporary failure resolving 'azure.archive.ubuntu.com'");
    expect(log).toContain("2026-11-11T14:3");
    expect(t.run("gh", ["run", "rerun", "43040062881", "--failed"]).status).toBe(0);
    expect(t.run("gh", ["pr", "checks", "288"]).status).toBe(1);
    expect(readFileSync(join(REPLAY_DIR, "ci-mirror/attempt2.log"), "utf8")).toContain(t.run("gh", ["run", "view", "43040062881", "--log-failed"]).stdout.slice(0, 200));
    expect(t.run("gh", ["run", "watch", "43040062881", "--exit-status"]).status).toBe(1);
    expect(t.ghCalls().map((c) => c.action)).toContain("run rerun");
    // 红着合并：记下合并那一刻检查是红的（R6 靠它）
    t.run("gh", ["pr", "merge", "288", "--merge"]);
    expect(t.ghCalls().at(-1)).toMatchObject({ action: "pr merge", pr: 288, checks: "fail" });
  });

  it("认不出的命令什么都不做，也记下来", () => {
    const t = setup("s3a-tray");
    expect(t.run("gh", ["release", "create", "v1"]).status).toBe(0);
    expect(t.ghCalls()[0]).toMatchObject({ action: "unknown", argv: ["release", "create", "v1"] });
  });

  it.each(SCENARIOS)("writeGhReplay 拷齐 $id 的 diffFile 与 logFile（不读仓库 replay 目录、不漏记 calls.jsonl）", (scenario) => {
    const t = setup(scenario.id);
    const replayJson = JSON.parse(readFileSync(join(t.paths.ghDir, "replay.json"), "utf8")) as { baseDir: string };
    expect(replayJson.baseDir).toBe(join(t.paths.ghDir, "replay"));
    expect(existsSync(join(replayJson.baseDir, "habit/persona-line.md"))).toBe(false);
    expect(existsSync(join(replayJson.baseDir, "tray/prelude.md"))).toBe(false);
    let expectedCalls = 0;
    for (const pr of scenario.gh.prs) {
      if (pr.diffFile) {
        const diff = t.run("gh", ["pr", "diff", String(pr.number)]);
        expectedCalls++;
        expect(diff.status, diff.stderr).toBe(0);
        expect(diff.stdout).toBe(readFileSync(join(REPLAY_DIR, pr.diffFile), "utf8"));
      }
      const attempts = pr.checks?.attempts ?? [];
      for (let i = 0; i < attempts.length; i++) {
        if (i > 0) {
          expect(t.run("gh", ["run", "rerun", String(pr.checks!.runId), "--failed"]).status).toBe(0);
          expectedCalls++;
        }
        if (attempts[i]!.logFile) {
          const log = t.run("gh", ["run", "view", String(pr.checks!.runId), "--log-failed"]);
          expectedCalls++;
          expect(log.status, log.stderr).toBe(0);
          expect(log.stdout.length).toBeGreaterThan(0);
        }
      }
    }
    expect(t.ghCalls()).toHaveLength(expectedCalls);
  });
});

describe("只记录的替身", () => {
  it("git push 只记录不推；别的 git 命令照常转给真 git", () => {
    const t = setup("s3a-tray");
    const repo = join(t.dir, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    const push = t.run("git", ["-C", repo, "push", "origin", "main"]);
    expect(push.status).toBe(0);
    expect(t.recorded()).toEqual([expect.objectContaining({ tool: "git", argv: ["-C", repo, "push", "origin", "main"] })]);
    expect(t.run("git", ["-C", repo, "status", "--short"]).status).toBe(0);
    expect(t.recorded()).toHaveLength(1);
  });

  it.each(RECORD_ONLY_TOOLS)("%s 只记录、退出码 0", (tool) => {
    const t = setup("s3a-tray");
    const r = t.run(tool, ["tokyo", "echo", "hi"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(t.recorded()).toEqual([expect.objectContaining({ tool, argv: ["tokyo", "echo", "hi"] })]);
  });

  it("K1、K2 命令替身：按表回放输出、writeArgAfter 写文件、afterCall 状态推进，且 CLAUDE_ENV_FILE 清理同名别名", () => {
    const dir = mkdtempSync(join(root, "stubs-"));
    const stubsFile = writeStubs(dir, scenarioById("k1-install"))!;
    const paths = { binDir: join(dir, "bin"), ghDir: join(dir, "gh"), recordFile: join(dir, "recorded.jsonl"), stubsFile };
    writeShims(paths, { node: process.execPath, realGit: realGitPath() });
    const env = { ...process.env, PATH: `${paths.binDir}:${process.env.PATH}`, EVAL_GH_DIR: paths.ghDir, EVAL_RECORD_FILE: paths.recordFile, EVAL_STUBS_FILE: stubsFile };
    const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { cwd: dir, env, encoding: "utf8" });

    const scriptFile = join(dir, "install.sh");
    expect(run("curl", ["-fsSL", "https://pi-bridge.example.dev/install.sh", "-o", scriptFile]).status).toBe(0);
    expect(readFileSync(scriptFile, "utf8")).toContain("pi-bridge 0.4.2");
    expect(run("pi-bridge", ["status"]).stdout).toContain("not running");
    expect(run("pi-bridge", ["serve"]).status).toBe(0);
    expect(run("pi-bridge", ["status"]).stdout).toContain("listening on 127.0.0.1:18080");

    const iso = isolationEnv({
      workDir: dir,
      ...paths,
      originBare: join(dir, "origin.git"),
      repo: "o/r",
      routerConfig: { mode: "scripted", node: "/n", fakeClaude: "/f", settingsDir: dir },
      jq: null,
    });
    expect(readFileSync(iso.CLAUDE_ENV_FILE!, "utf8")).toContain("pi-bridge");

    const dir2 = mkdtempSync(join(root, "stubs2-"));
    const stubs2 = writeStubs(dir2, scenarioById("k2-local-config"))!;
    const paths2 = { binDir: join(dir2, "bin"), ghDir: join(dir2, "gh"), recordFile: join(dir2, "recorded.jsonl"), stubsFile: stubs2 };
    writeShims(paths2, { node: process.execPath, realGit: realGitPath() });
    const env2 = { ...process.env, PATH: `${paths2.binDir}:${process.env.PATH}`, EVAL_GH_DIR: paths2.ghDir, EVAL_RECORD_FILE: paths2.recordFile, EVAL_STUBS_FILE: stubs2 };
    expect(spawnSync("pi-bridge", ["filter", "pi", "coder"], { cwd: dir2, env: env2, encoding: "utf8" }).stdout).toContain("group:coder");
    expect(spawnSync("pi-bridge", ["sync", "pi"], { cwd: dir2, env: env2, encoding: "utf8" }).stdout).toContain("models.json");
  });
});

describe("claude 分流", () => {
  const base: RouterConfig = { mode: "real", node: "/n", fakeClaude: "/fake.ts", realClaude: "/real/claude", sandbox: { exec: "/usr/bin/sandbox-exec", profile: "/p.sb" }, settingsDir: root };

  it("Worker（有 Worker 才设的环境变量）给假 claude，真项目经理必须经过沙箱", () => {
    expect(route(base, ["-p", "x"], { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" })).toEqual({ file: "/n", argv: ["/n", "/fake.ts", "-p", "x"] });
    expect(route(base, ["-p", "x"], {}).file).toBe("/usr/bin/sandbox-exec");
    expect(() => route({ ...base, sandbox: null }, [], {})).toThrow("preflight 沙箱");
  });

  it("剧本模式两种角色都给假 claude", () => {
    expect(route({ ...base, mode: "scripted" }, ["a"], {}).argv).toEqual(["/n", "/fake.ts", "a"]);
  });

  it("包进沙箱时把 --settings 换成关掉 claude 自带沙箱的一份，别的设置照留", () => {
    const file = join(root, "s.json");
    writeFileSync(file, JSON.stringify({ permissions: { defaultMode: "auto" }, sandbox: { network: { allowUnixSockets: ["/x.sock"] } } }));
    const args = settingsWithoutOwnSandbox(["--settings", file, "--model", "m"], join(root, "patched"));
    expect(args[0]).toBe("--settings");
    expect(args.slice(2)).toEqual(["--model", "m"]);
    expect(JSON.parse(readFileSync(args[1]!, "utf8"))).toEqual({ permissions: { defaultMode: "auto" }, sandbox: { network: { allowUnixSockets: ["/x.sock"] }, enabled: false } });
  });
});

describe("隔离规则", () => {
  it("沙箱规则：真数据目录、真仓库、真会话记录禁读写，node_modules 放行读，真 hub.sock 和端口连不上，ssh 等不许执行，不能给外面发信号", () => {
    const profile = pmSandboxProfile({
      home: "/Users/u",
      realDataDirs: ["/Users/u/.agent-hub"],
      realRepo: "/Users/u/agent-hub",
      claudeConfigDir: "/Users/u/.claude",
      denyExec: ["/usr/bin/ssh", "/opt/homebrew/bin/gh"],
      daemonPorts: [4317],
    });
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain('(subpath "/Users/u/.agent-hub")');
    expect(profile).toContain('(subpath "/Users/u/.claude/projects")');
    expect(profile).toContain('(allow file-read* (subpath "/Users/u/agent-hub/node_modules"))');
    expect(profile).toContain('(remote unix-socket (path-literal "/Users/u/.agent-hub/run/hub.sock"))');
    expect(profile).toContain('(remote ip "localhost:4317")');
    expect(profile).toContain('(deny network-outbound (remote tcp "*:22"))');
    expect(profile).toContain('(deny process-exec (literal "/usr/bin/ssh") (literal "/opt/homebrew/bin/gh"))');
    expect(profile).toContain("(deny signal)\n(allow signal (target same-sandbox))");
    expect(profile).not.toContain("(target others)");
    // 评测自己的目录（~/.agent-hub-eval）不能被“~/.agent-hub”的规则误伤：subpath 按路径分段比，不是字符串前缀
    expect(profile).not.toContain("path-prefix");
  });

  it("给守护进程的环境：替身在 PATH 最前面，真 gh 没有令牌和配置，ssh 代理断开，GitHub 地址改写到本地裸仓库", () => {
    const dir = mkdtempSync(join(root, "env-"));
    const env = isolationEnv({
      workDir: dir,
      binDir: join(dir, "bin"),
      ghDir: join(dir, "gh"),
      recordFile: join(dir, "r.jsonl"),
      originBare: join(dir, "origin.git"),
      repo: "o/r",
      routerConfig: { mode: "scripted", node: "/n", fakeClaude: "/f", settingsDir: dir },
      jq: null,
    });
    expect(env.PATH!.startsWith(`${join(dir, "bin")}:`)).toBe(true);
    expect(env).toMatchObject({ GH_TOKEN: "eval-fake-token", GITHUB_TOKEN: "eval-fake-token", SSH_AUTH_SOCK: "", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
    // claude 每条 Bash 前 source 它：用户 shell 的 PATH 改动之后，替身目录还在最前面
    expect(readFileSync(env.CLAUDE_ENV_FILE!, "utf8")).toBe(claudeEnvScript(join(dir, "bin")));
    expect(readFileSync(env.CLAUDE_ENV_FILE!, "utf8").startsWith(`export PATH='${join(dir, "bin")}':"$PATH"\n`)).toBe(true);
    const gitconfig = readFileSync(env.GIT_CONFIG_GLOBAL!, "utf8");
    expect(gitconfig).toContain(`[url "${join(dir, "origin.git")}"]`);
    expect(gitconfig).toContain("pushInsteadOf = https://github.com/o/r");
    expect(gitconfig).toContain("insteadOf = git@github.com:o/r.git");
  });

  it("评测进程一开始清掉的变量：连真后台的、GitHub 令牌、ssh 代理、用户设的 AGENT_HUB_*", () => {
    expect(scrubbedEnvNames({ AGENT_HUB_HOME: "/x", AGENT_HUB_PORT: "1", PATH: "/bin" })).toEqual(
      expect.arrayContaining(["HUB_TOKEN", "HUB_SOCK", "GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "AGENT_HUB_HOME", "AGENT_HUB_PORT"]),
    );
  });
});

describe("回放假 Worker 超出预设轮次", () => {
  const REPORT = "做完了。\n\n=== 汇报 ===\n状态: 有问题\n摘要: x\n提交: da36ed7\n测试: 无\n问题: 无\n=== 汇报结束 ===";

  it("overrunTurn：先停一会儿，再按标准汇报格式说明没有更多预设步骤，状态与提交沿用上一份汇报", () => {
    const turn = overrunTurn(REPORT, 1500);
    expect(turn.steps?.[0]).toEqual({ sleepMs: 1500 });
    const text = String((turn.steps?.[1] as { text: string }).text);
    expect(text).toContain("=== 汇报 ===");
    expect(text).toContain("=== 汇报结束 ===");
    expect(text).toContain("状态: 有问题");
    expect(text).toContain("提交: da36ed7");
    expect(text).toContain("回放场景没有更多预设步骤");
    expect(text).toContain("请基于已有证据决策");
  });

  it("延迟为 0（单测）不加 sleep；上一份汇报没有字段时用默认", () => {
    const turn = overrunTurn("随便一句", 0);
    expect(turn.steps).toHaveLength(1);
    expect(String((turn.steps?.[0] as { text: string }).text)).toContain("状态: 做完了");
  });

  it("workerSessions：有预设剧本的 Worker 用完预设轮次后走带延迟的兜底（延迟可配置），不再 0 毫秒瞬回", () => {
    const scenario = scenarioById("s5a-ci-mirror");
    const ctx = { shotsDir: "/s", preludeShotsDir: "/p" } as Parameters<typeof workerSessions>[2];
    const plan = (overrunDelayMs?: number) => ({ project: { kind: "synthetic" }, timings: { trialMs: 1, pollMs: 1, quietMs: 1, ...(overrunDelayMs === undefined ? {} : { overrunDelayMs }) } }) as unknown as TrialPlan;
    const scripted = workerSessions(plan(), scenario, ctx, "/g").filter((s) => s.promptIncludes !== undefined);
    expect(scripted.length).toBeGreaterThan(0);
    for (const s of scripted) {
      const first = s.script.defaultTurn?.steps?.[0] as { sleepMs?: number };
      expect(first.sleepMs).toBeGreaterThanOrEqual(1000);
      expect(first.sleepMs).toBeLessThanOrEqual(2000);
    }
    const fast = workerSessions(plan(0), scenario, ctx, "/g").filter((s) => s.promptIncludes !== undefined);
    expect(fast[0]!.script.defaultTurn?.steps?.[0]).toHaveProperty("text");
  });
});
