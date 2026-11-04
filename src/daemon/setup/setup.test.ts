// worktree 准备命令（方案测试表 1～15）：真 shell、临时目录。
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SetupOutcome } from "../../shared/index.ts";
import { ENV_SETUP_ROOT_PATH, ENV_SETUP_WORKTREE_PATH, SETUP_OUTPUT_TAIL_BYTES, SETUP_OUTPUT_TAIL_LINES, SETUP_TIMEOUT_MS } from "../../shared/index.ts";
import { isAlive, waitForExit } from "../driver/process.ts";
import { buildSetupEnv, cleanTerminalText, createSetupRunner, outputTail, runSetupCommand, type SetupJob } from "./index.ts";

let root: string;
let cwd: string;
let logPath: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "setup 测试 ")));
  cwd = join(root, "wt");
  mkdirSync(cwd);
  logPath = join(root, "logs", "setup", "worker-1.log");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (command: string, extra: Partial<Parameters<typeof runSetupCommand>[0]> = {}) =>
  runSetupCommand({ command, cwd, rootPath: join(root, "main"), logPath, shell: "/bin/sh", ...extra });

const readPid = (name: string) => Number(readFileSync(join(cwd, name), "utf8").trim());

/** 等文件出现（命令在后台写它）。 */
async function waitForFile(path: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if (readFileSync(path, "utf8").trim() !== "") return;
    } catch {
      // 还没有
    }
    if (Date.now() > deadline) throw new Error(`${path} 没出现`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("runSetupCommand", () => {
  it("1 正常：在 worktree 里跑，输出进 tail 和日志，日志有段头和结尾", async () => {
    const outcome = await run("pwd; echo hi");
    expect(outcome).toMatchObject({ kind: "ok", exitCode: 0, signal: null, error: null, logError: null, command: "pwd; echo hi", logPath });
    expect(outcome.tail).toBe(`${cwd}\nhi`);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain(`在 ${cwd} 跑准备命令`);
    expect(log).toContain("pwd; echo hi\n---\n");
    expect(log).toContain("hi\n");
    expect(log).toMatch(/--- 结束（ok，退出码 0），用时 \d+ 秒 ---/);
  });

  it("1b 跑两次追加在同一个日志里", async () => {
    await run("echo first");
    await run("echo second");
    const log = readFileSync(logPath, "utf8");
    expect(log.indexOf("first")).toBeLessThan(log.indexOf("second"));
    expect(log.match(/跑准备命令 ===/g)).toHaveLength(2);
  });

  it("2 退出码非 0：failed，标准错误也在 tail 里", async () => {
    const outcome = await run("echo out; echo err >&2; exit 3");
    expect(outcome).toMatchObject({ kind: "failed", exitCode: 3, signal: null, error: null });
    expect(outcome.tail).toContain("err");
    expect(outcome.tail).toContain("out");
  });

  it("3 找不到命令：failed，退出码 127", async () => {
    const outcome = await run("nosuchcmd-agent-hub-test");
    expect(outcome).toMatchObject({ kind: "failed", exitCode: 127 });
  });

  it("4 shell 起不来：failed，带原因，不抛错", async () => {
    const outcome = await run("echo hi", { shell: join(root, "no-such-shell") });
    expect(outcome.kind).toBe("failed");
    expect(outcome.exitCode).toBeNull();
    expect(outcome.error).toMatch(/准备命令起不来/);
  });

  it("5 超时：timeout，shell 没了", async () => {
    const outcome = await run("echo $$ > shell.pid; sleep 30", { timeoutMs: 300 });
    expect(outcome.kind).toBe("timeout");
    expect(await waitForExit(readPid("shell.pid"), 2_000)).toBe(true);
  });

  it("6 超时：后台的子进程、换了进程组的孙进程也一起没了", async () => {
    const script = "sleep 300 & echo $! > child.pid; (set -m; sleep 300 & echo $! > grandchild.pid; wait) & wait";
    const promise = run(script, { timeoutMs: 1_000 });
    await waitForFile(join(cwd, "grandchild.pid"));
    const child = readPid("child.pid");
    const grandchild = readPid("grandchild.pid");
    expect(isAlive(child)).toBe(true);
    expect((await promise).kind).toBe("timeout");
    expect(await waitForExit(child, 2_000)).toBe(true);
    expect(await waitForExit(grandchild, 2_000)).toBe(true);
  });

  it("7 输出巨大：正常跑完，日志封顶并写“后面省略”，tail 不超过上限", async () => {
    const outcome = await run("i=0; while [ $i -lt 2000 ]; do echo \"line $i aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"; i=$((i+1)); done; yes x | head -c 3000000", {
      logMaxBytes: 64 * 1024,
    });
    expect(outcome.kind).toBe("ok");
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("后面省略");
    expect(Buffer.byteLength(log)).toBeLessThan(64 * 1024 + 2_000);
    expect(Buffer.byteLength(outcome.tail)).toBeLessThanOrEqual(SETUP_OUTPUT_TAIL_BYTES);
    expect(outcome.tail.split("\n").length).toBeLessThanOrEqual(SETUP_OUTPUT_TAIL_LINES);
    expect(outcome.tail.endsWith("x")).toBe(true);
  });

  it("8 环境变量：去掉令牌、agent 接口、凭据、父会话的，给主文件夹和 worktree 两个路径", async () => {
    const baseEnv = {
      PATH: process.env.PATH,
      HUB_TOKEN: "secret",
      HUB_SOCK: "/tmp/x.sock",
      ANTHROPIC_API_KEY: "k",
      CLAUDE_CODE_OAUTH_TOKEN: "o",
      CLAUDECODE: "1",
      AGENT_HUB_HOME: "/tmp/home",
      KEEP_ME: "yes",
    };
    const outcome = await run("env", { baseEnv });
    const lines = outcome.tail.split("\n");
    for (const name of ["HUB_TOKEN", "HUB_SOCK", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDECODE", "AGENT_HUB_HOME"]) {
      expect(lines.some((l) => l.startsWith(`${name}=`))).toBe(false);
    }
    expect(lines).toContain("KEEP_ME=yes");
    expect(lines).toContain(`${ENV_SETUP_ROOT_PATH}=${join(root, "main")}`);
    expect(lines).toContain(`${ENV_SETUP_WORKTREE_PATH}=${cwd}`);
  });

  it("8b buildSetupEnv 单测：AGENT_HUB_ 开头的守护进程配置不传，路径两个后加上", () => {
    const env = buildSetupEnv({ AGENT_HUB_ROOT_PATH: "/evil", AGENT_HUB_CLAUDE: "c", A: "1" }, { rootPath: "/r", worktreePath: "/w" });
    expect(env).toEqual({ A: "1", AGENT_HUB_ROOT_PATH: "/r", AGENT_HUB_WORKTREE_PATH: "/w" });
  });

  it("9 读标准输入：读到结尾马上结束，不卡住", async () => {
    const outcome = await run("read x; echo got:$x", { timeoutMs: 5_000 });
    expect(outcome.kind).toBe("ok");
    expect(outcome.tail).toBe("got:");
  });

  it("10 日志写不了：命令照样跑，logError 写原因", async () => {
    writeFileSync(join(root, "logs"), "不是目录");
    const outcome = await run("echo hi");
    expect(outcome.kind).toBe("ok");
    expect(outcome.tail).toBe("hi");
    expect(outcome.logError).not.toBeNull();
  });

  it("11 abort：stopped，进程没了", async () => {
    const controller = new AbortController();
    const promise = run("echo $$ > shell.pid; sleep 30", { signal: controller.signal });
    await waitForFile(join(cwd, "shell.pid"));
    controller.abort();
    expect((await promise).kind).toBe("stopped");
    expect(await waitForExit(readPid("shell.pid"), 2_000)).toBe(true);
  });

  it("15 正常退出但留了后台进程：很快返回 ok，后台进程被清掉", async () => {
    const started = Date.now();
    const outcome = await run("sleep 300 & echo $! > bg.pid; echo done", { timeoutMs: 10_000 });
    expect(outcome.kind).toBe("ok");
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await waitForExit(readPid("bg.pid"), 2_000)).toBe(true);
  });
});

describe("outputTail", () => {
  it("取最后几行，去掉末尾空行", () => {
    expect(outputTail(Buffer.from("a\nb\nc\n\n"), 2, 100)).toBe("b\nc");
  });
  it("按字节截在多字节字符中间：丢掉半个字", () => {
    const text = "中文输出";
    expect(outputTail(Buffer.from(text), 10, 7)).toBe("输出");
  });
});

describe("createSetupRunner", () => {
  const job = (workerId: number, command: string, onDone: (o: SetupOutcome) => void): SetupJob => ({
    workerId,
    sessionId: workerId * 10,
    command,
    cwd,
    rootPath: root,
    logPath: join(root, "logs", `worker-${workerId}.log`),
    onDone,
  });

  it("11 cancel：按会话停，结果 stopped，照常调 onDone", async () => {
    const runner = createSetupRunner({ shell: "/bin/sh" });
    const done = new Promise<SetupOutcome>((resolve) => runner.start(job(1, "echo $$ > shell.pid; sleep 30", resolve)));
    await waitForFile(join(cwd, "shell.pid"));
    runner.cancel(99); // 别的会话：不动
    runner.cancel(10);
    expect((await done).kind).toBe("stopped");
    expect(await waitForExit(readPid("shell.pid"), 2_000)).toBe(true);
  });

  it("12 shutdown：很快返回，进程没了，不调 onDone；之后 start 不跑", async () => {
    const runner = createSetupRunner({ shell: "/bin/sh" });
    let called = false;
    expect(runner.start(job(1, "echo $$ > shell.pid; sleep 30", () => (called = true)))).toBe(true);
    await waitForFile(join(cwd, "shell.pid"));
    const started = Date.now();
    await runner.shutdown();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await waitForExit(readPid("shell.pid"), 2_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(called).toBe(false);
    expect(runner.start(job(2, "touch after", () => {}))).toBe(false);
  });

  it("13 同一个 Worker 连着 start 两次：只跑一份", async () => {
    const runner = createSetupRunner({ shell: "/bin/sh" });
    const outcomes: SetupOutcome[] = [];
    const done = new Promise<void>((resolve) =>
      runner.start(
        job(1, "echo run >> runs.txt; sleep 0.3", (o) => {
          outcomes.push(o);
          resolve();
        }),
      ),
    );
    expect(runner.start(job(1, "echo run >> runs.txt", (o) => outcomes.push(o)))).toBe(false);
    await done;
    expect(readFileSync(join(cwd, "runs.txt"), "utf8")).toBe("run\n");
    expect(outcomes).toHaveLength(1);
    // 跑完了可以再跑
    const again = new Promise<SetupOutcome>((resolve) => runner.start(job(1, "echo run >> runs.txt", resolve)));
    expect((await again).kind).toBe("ok");
  });

  it("14 两个 Worker 并发：同时跑，各写各的日志，结果不串", async () => {
    const runner = createSetupRunner({ shell: "/bin/sh" });
    const started = Date.now();
    const [a, b] = await Promise.all([
      new Promise<SetupOutcome>((resolve) => runner.start(job(1, "sleep 0.5; echo one", resolve))),
      new Promise<SetupOutcome>((resolve) => runner.start(job(2, "sleep 0.5; echo two; exit 4", resolve))),
    ]);
    expect(Date.now() - started).toBeLessThan(950);
    expect(a).toMatchObject({ kind: "ok", tail: "one" });
    expect(b).toMatchObject({ kind: "failed", exitCode: 4, tail: "two" });
    expect(readFileSync(join(root, "logs", "worker-1.log"), "utf8")).toContain("one");
    expect(readFileSync(join(root, "logs", "worker-2.log"), "utf8")).not.toContain("one");
  });

  it("onDone 抛错：记日志，不影响别的", async () => {
    const lines: string[] = [];
    const runner = createSetupRunner({ shell: "/bin/sh", log: (l) => lines.push(l) });
    await new Promise<void>((resolve) =>
      runner.start(
        job(1, "true", () => {
          resolve();
          throw new Error("boom");
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(lines.join("\n")).toContain("boom");
  });
});

describe("审查后补的（PR #47）", () => {
  it("R4 环境变量：按忽略大小写去掉模型和 hub 的凭据，GH、AWS、NPM 的令牌保留", () => {
    const base = {
      ANTHROPIC_API_KEY: "x",
      anthropic_auth_token: "x",
      ANTHROPIC_FOUNDRY_API_KEY: "x",
      ANTHROPIC_AWS_API_KEY: "x",
      AWS_BEARER_TOKEN_BEDROCK: "x",
      CLAUDE_CODE_OAUTH_TOKEN: "x",
      Claude_Code_OAuth_Refresh_Token: "x",
      CLAUDE_CODE_SESSION_ACCESS_TOKEN: "x",
      CLAUDE_CODE_CLIENT_KEY: "x",
      CLAUDE_CODE_CLIENT_KEY_PASSPHRASE: "x",
      CLAUDE_CODE_CLIENT_CERT: "x",
      MCP_CLIENT_SECRET: "x",
      HUB_TOKEN: "x",
      hub_sock: "x",
      HUB_ANYTHING: "x",
      agent_hub_home: "x",
      GH_TOKEN: "keep",
      GITHUB_TOKEN: "keep",
      NPM_TOKEN: "keep",
      AWS_ACCESS_KEY_ID: "keep",
      AWS_SECRET_ACCESS_KEY: "keep",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "keep",
      PATH: "/bin",
    };
    expect(buildSetupEnv(base, { rootPath: "/r", worktreePath: "/w" })).toEqual({
      GH_TOKEN: "keep",
      GITHUB_TOKEN: "keep",
      NPM_TOKEN: "keep",
      AWS_ACCESS_KEY_ID: "keep",
      AWS_SECRET_ACCESS_KEY: "keep",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "keep",
      PATH: "/bin",
      [ENV_SETUP_ROOT_PATH]: "/r",
      [ENV_SETUP_WORKTREE_PATH]: "/w",
    });
  });

  it("R3 输出尾部：去掉 ANSI 序列和控制字符，\\r 只留最后一段（进度条），CRLF 照常是换行", async () => {
    const outcome = await run(
      "printf '\\033[31mred\\033[0m line\\r\\n'; printf 'progress 10%%\\rprogress 100%%\\n'; printf 'bell\\007 \\033]0;title\\007ok\\n'; printf 'tab\\there\\n'",
    );
    expect(outcome.tail).toBe("red line\nprogress 100%\nbell ok\ntab\there");
  });

  it("R3 cleanTerminalText：单独去掉 ESC、C1 控制字符，保留换行和制表符", () => {
    expect(cleanTerminalText("a\u001b[2Kb\u009bc\u0000d\ne\tf")).toBe("abcd\ne\tf");
  });

  it("R6 worktree 目录不在：起命令前就报清楚原因，不是 spawn ENOENT", async () => {
    const outcome = await run("echo hi", { cwd: join(root, "gone") });
    expect(outcome.kind).toBe("failed");
    expect(outcome.error).toBe(`worktree 目录不在：${join(root, "gone")}`);
  });

  it("R7 日志目录权限 0700", async () => {
    await run("true");
    expect(statSync(join(root, "logs", "setup")).mode & 0o777).toBe(0o700);
  });

  it("R5 spawn 同步抛错（命令里有 NUL）：不抛，给 failed 和原因，日志的 fd 不漏", async () => {
    const before = readdirSync("/dev/fd").length;
    const outcome = await run("echo a\0b");
    expect(outcome.kind).toBe("failed");
    expect(outcome.error).toMatch(/准备命令出错/);
    expect(readdirSync("/dev/fd").length).toBe(before);
    expect(readFileSync(logPath, "utf8")).toContain("结束（failed");
  });

  it("R10 结果带着实际的超时（附注里的分钟数跟它走）", async () => {
    expect((await run("true", { timeoutMs: 120_000 })).timeoutMs).toBe(120_000);
    expect((await run("true")).timeoutMs).toBe(SETUP_TIMEOUT_MS);
  });

  it("R5 runner：onDone 抛错时再调一次，带“准备命令出错”的结果，Worker 不会卡在准备中", async () => {
    const lines: string[] = [];
    const runner = createSetupRunner({ shell: "/bin/sh", log: (l) => lines.push(l) });
    const seen: SetupOutcome[] = [];
    await new Promise<void>((resolve) =>
      runner.start({
        workerId: 1,
        sessionId: 10,
        command: "true",
        cwd,
        rootPath: root,
        logPath,
        onDone: (o) => {
          seen.push(o);
          if (seen.length === 1) throw new Error("账本写不进去");
          resolve();
        },
      }),
    );
    expect(seen.map((o) => o.kind)).toEqual(["ok", "failed"]);
    expect(seen[1]!.error).toBe("准备命令出错：账本写不进去");
    expect(lines.join("\n")).toContain("账本写不进去");
  });
});
