// 守护进程启动失败时终端上看到什么（entry.ts）：已知的码一句话 + hint，不认识的一句话 + 日志路径，堆栈只进日志。
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { arch } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_ERRORS } from "../shared/errors.ts";
import { DAEMON_LOG_MAX_BYTES, ENV_HOME, ENV_PORT, LOG_PREFIX, WORKER_ENV } from "../shared/index.ts";
import { resolveHubPaths } from "../shared/paths.ts";
import { startDaemon, type RunningDaemon } from "./daemon.ts";
import { reportFatalError, reportStartupFailure, runDaemonProcess } from "./entry.ts";

const NO_TAILNET = { current: () => null, refresh: async () => null };

describe("守护进程启动失败：终端上的输出", () => {
  let dir: string;
  let userHome: string;
  const running: RunningDaemon[] = [];
  let errors: string[];
  let logs: string[];

  const envOf = (name: string, port: string): Record<string, string | undefined> => {
    const env: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(process.env)) if (!(key in WORKER_ENV)) env[key] = value;
    env[ENV_HOME] = join(dir, name);
    env[ENV_PORT] = port;
    return env;
  };
  const home = (name: string) => join(dir, name);

  beforeEach(() => {
    dir = mkdtempSync("/tmp/ah-entry-");
    userHome = join(dir, "user");
    mkdirSync(userHome);
    errors = [];
    logs = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(" ")));
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
  });

  afterEach(async () => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    for (const daemon of running.splice(0)) await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("同一个端口起两个守护进程：终端上只有一句话加 hint，没有堆栈、没有英文异常", async () => {
    const first = await startDaemon({ userHome, env: envOf("first", "0"), tailnet: NO_TAILNET, log: () => {} });
    running.push(first);

    await runDaemonProcess({ userHome, env: envOf("second", String(first.port)), tailnet: NO_TAILNET });

    expect(process.exitCode).toBe(1);
    expect(logs).toEqual([]);
    // 启动过程中的进度行（第一次启动、没找到网页文件……）不算；失败的是最后一行，只有这一句话
    expect(errors.at(-1)).toBe(`${LOG_PREFIX} ${LOCAL_ERRORS.port_in_use.text}（${first.port}）。${LOCAL_ERRORS.port_in_use.hint}`);
    const terminal = errors.join("\n");
    expect(terminal).not.toMatch(/EADDRINUSE|listen|Error|\n\s+at /);
    // 堆栈和原文写进日志
    const log = readFileSync(join(home("second"), "state", "logs", "daemon.log"), "utf8");
    expect(log).toContain("EADDRINUSE");
    expect(log).toMatch(/\n\s+at /);
  });

  it("AGENT_HUB_PORT=abc：中文，写出填的是什么，不是英文异常", async () => {
    await runDaemonProcess({ userHome, env: envOf("bad", "abc"), tailnet: NO_TAILNET });

    expect(process.exitCode).toBe(1);
    expect(errors).toEqual([`${LOG_PREFIX} ${LOCAL_ERRORS.bad_port.text}（现在是 abc）。${LOCAL_ERRORS.bad_port.hint}`]);
    expect(errors.join("\n")).not.toMatch(/must be|Error|\n\s+at /);
  });

  it("已经有守护进程在跑：一句话，不再启动第二个", async () => {
    const env = envOf("same", "0");
    running.push(await startDaemon({ userHome, env, tailnet: NO_TAILNET, log: () => {} }));
    await runDaemonProcess({ userHome, env, tailnet: NO_TAILNET });

    expect(process.exitCode).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(new RegExp(`^${LOG_PREFIX} 已有守护进程在跑（进程号 \\d+），不再启动第二个。$`));
  });

  it("不认识的异常：一句话 + 详情在哪个日志，堆栈和原文只进日志", () => {
    const paths = resolveHubPaths({ [ENV_HOME]: join(dir, "odd") }, userHome);
    const error = new Error("ENOTDIR: not a directory, open '/x/y'");
    reportStartupFailure(error, paths);

    const logPath = join(paths.logsDir, "daemon.log");
    expect(errors).toEqual([`${LOG_PREFIX} 启动失败了，出了意外的错。详情在 ${logPath}`]);
    expect(errors.join("\n")).not.toMatch(/ENOTDIR|Error|\n\s+at /);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("ENOTDIR: not a directory");
    expect(log).toMatch(/\n\s+at /);
  });

  it("不认识的异常、日志也写不进去：说日志没写成，不假装有日志", () => {
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "是个文件，不是目录");
    const paths = resolveHubPaths({ [ENV_HOME]: blocked }, userHome);
    reportStartupFailure(new Error("boom"), paths);
    expect(errors).toEqual([`${LOG_PREFIX} 启动失败了，出了意外的错，日志也没写成。`]);
  });

  it("运行中 uncaughtException / unhandledRejection：把完整错误写进 daemon.log 和标准错误", () => {
    const paths = resolveHubPaths({ [ENV_HOME]: join(dir, "fatal") }, userHome);
    const lines: string[] = [];
    reportFatalError(new Error("fatal-boom"), "uncaughtException", paths, (line) => lines.push(line));
    reportFatalError(new Error("reject-boom"), "unhandledRejection", paths, (line) => lines.push(line));

    const logPath = join(paths.logsDir, "daemon.log");
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("未捕获异常 (uncaughtException)");
    expect(log).toContain("fatal-boom");
    expect(log).toContain("未处理的 Promise 拒绝 (unhandledRejection)");
    expect(log).toContain("reject-boom");
    expect(lines[0]).toContain("fatal-boom");
    expect(lines[1]).toContain("reject-boom");
  });

  it("子进程中触发 uncaughtException / unhandledRejection：写完日志后以退出码 1 退出，不吞错继续跑", async () => {
    for (const kind of ["uncaughtException", "unhandledRejection"] as const) {
      const subHome = home(`sub-${kind}`);
      const script = `
        import { runDaemonProcess } from "./src/daemon/entry.ts";
        const NO_TAILNET = { current: () => null, refresh: async () => null };
        await runDaemonProcess({
          userHome: ${JSON.stringify(userHome)},
          env: { ...process.env, AGENT_HUB_HOME: ${JSON.stringify(subHome)}, AGENT_HUB_PORT: "0" },
          tailnet: NO_TAILNET,
        });
        if (${JSON.stringify(kind)} === "uncaughtException") {
          setImmediate(() => { throw new Error("crash-by-uncaught"); });
        } else {
          setImmediate(() => { Promise.reject(new Error("crash-by-rejection")); });
        }
      `;
      const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", reject);
        child.on("exit", (code) => resolve({ code, stderr }));
      });

      expect(result.code).toBe(1);
      // 先正常关机再退出（不是直接 process.exit 留下子进程）
      expect(result.stderr).toContain("先正常关机再退出");
      const expectedMsg = kind === "uncaughtException" ? "crash-by-uncaught" : "crash-by-rejection";
      expect(result.stderr).toContain(expectedMsg);
      // 最后一行是一句话摘要（Mac 应用取标准错误最后一行做菜单里的崩溃原因，关机日志排在错误详情后面）
      expect(result.stderr.trimEnd().split("\n").at(-1)).toBe(`${LOG_PREFIX} 因 ${kind} 退出：Error: ${expectedMsg}`);
      const log = readFileSync(join(subHome, "state", "logs", "daemon.log"), "utf8");
      expect(log).toContain(expectedMsg);
      expect(log).toContain(kind);
    }
  });

  it("关机过程中又抛异常：两条都记日志，关机走完，退出码 1，不半路退出", async () => {
    const subHome = home("sub-double");
    const script = `
      import { runDaemonProcess } from "./src/daemon/entry.ts";
      const NO_TAILNET = { current: () => null, refresh: async () => null };
      await runDaemonProcess({
        userHome: ${JSON.stringify(userHome)},
        env: { ...process.env, AGENT_HUB_HOME: ${JSON.stringify(subHome)}, AGENT_HUB_PORT: "0" },
        tailnet: NO_TAILNET,
      });
      setImmediate(() => {
        setImmediate(() => { throw new Error("second-during-shutdown"); });
        throw new Error("first-fatal");
      });
    `;
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, stderr }));
    });
    expect(result.code).toBe(1);
    const log = readFileSync(join(subHome, "state", "logs", "daemon.log"), "utf8");
    expect(log).toContain("first-fatal");
    expect(log).toContain("second-during-shutdown");
    expect(result.stderr.match(/先正常关机再退出/g)).toHaveLength(1);
  });

  it("daemon.log 超过上限：改名成 .1 再写，磁盘上最多两份", () => {
    const paths = resolveHubPaths({ [ENV_HOME]: join(dir, "rotate") }, userHome);
    mkdirSync(paths.logsDir, { recursive: true });
    const file = join(paths.logsDir, "daemon.log");
    writeFileSync(file, "x".repeat(DAEMON_LOG_MAX_BYTES + 1));
    reportFatalError(new Error("after-rotate"), "uncaughtException", paths, () => {});
    expect(readFileSync(`${file}.1`, "utf8").length).toBe(DAEMON_LOG_MAX_BYTES + 1);
    const fresh = readFileSync(file, "utf8");
    expect(fresh).toContain("after-rotate");
    expect(fresh.length).toBeLessThan(DAEMON_LOG_MAX_BYTES);
  });

  it.skipIf(process.platform !== "darwin")(
    "macOS DaemonSupervisor：kill -9 自动拉起、用户点重启不计入崩溃、连续崩溃 5 次停止重试并更新菜单栏状态",
    async () => {
      const freePort = await new Promise<number>((resolve, reject) => {
        const srv = createServer();
        srv.listen(0, "127.0.0.1", () => {
          const addr = srv.address();
          const port = typeof addr === "object" && addr ? addr.port : 0;
          srv.close((err) => (err ? reject(err) : resolve(port)));
        });
      });

      const crashEntryPath = join(dir, "crash-daemon.ts");
      writeFileSync(
        crashEntryPath,
        `console.error("Fatal: simulated database corruption");\nprocess.exit(1);\n`,
      );

      const external = await startDaemon({ userHome, env: envOf("ext", "0"), tailnet: NO_TAILNET, log: () => {} });
      running.push(external);

      const swiftMainPath = join(dir, "main.swift");
      const binPath = join(dir, "supervisor-harness");
      const repoRoot = process.cwd();

      writeFileSync(
        swiftMainPath,
        `import AppKit
import Darwin
import Foundation

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

func pumpRunLoop(_ seconds: TimeInterval) {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
}

func waitUntil(timeout: TimeInterval, condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
        if condition() { return true }
    }
    return condition()
}

// 0. 已有外部后台在跑时：只复用、不接管，stopIfOwned 不会关掉外部后台
setenv("AGENT_HUB_PORT", CommandLine.arguments[2], 1)
let extSupervisor = DaemonSupervisor()
var extReady = false
extSupervisor.ensureRunning { result in
    if case .success = result { extReady = true }
}
guard waitUntil(timeout: 5.0, condition: { extReady }), extSupervisor.currentPid == nil else {
    fputs("FAIL: external daemon reuse check failed\\n", stderr)
    exit(1)
}
extSupervisor.stopIfOwned()

// 切换到本测试专属端口，由 DaemonSupervisor 自己拉起后台
setenv("AGENT_HUB_PORT", CommandLine.arguments[3], 1)
let supervisor = DaemonSupervisor()
let statusBar = StatusBarController(
    onOpenMainWindow: {},
    onRestartDaemon: {},
    onQuitApp: {}
)
var crashedPids: [Int32] = []
supervisor.onStateChange = { state, lastCrash in
    statusBar.updateDaemonState(state, lastCrash: lastCrash)
    switch state {
    case .restarting(_, _, _, let crash), .failed(_, _, let crash):
        if !crashedPids.contains(crash.pid) {
            crashedPids.append(crash.pid)
        }
    case .running:
        break
    }
}

var startedOk = false
supervisor.ensureRunning { result in
    if case .success = result { startedOk = true }
}
guard waitUntil(timeout: 15.0, condition: { startedOk }), let pid1 = supervisor.currentPid else {
    fputs("FAIL: initial start failed\\n", stderr)
    exit(1)
}
assert(statusBar.currentSummaryTitle == "后台服务运行中")
assert(!statusBar.isLastCrashVisible)

// 1. 手动 kill -9 自己起的后台 -> 自动拉起
kill(pid1, SIGKILL)
guard waitUntil(timeout: 3.0, condition: {
    if case .restarting(let attempt, _, _, _) = supervisor.currentState {
        return attempt == 1
    }
    return false
}) else {
    fputs("FAIL: did not enter restarting state after SIGKILL\\n", stderr)
    supervisor.stopIfOwned()
    exit(1)
}
let restartingSummaryAfterKill9 = statusBar.currentSummaryTitle
let crashTitleAfterKill9 = statusBar.currentLastCrashTitle

guard waitUntil(timeout: 15.0, condition: {
    supervisor.currentState == .running && supervisor.currentPid != nil && supervisor.currentPid != pid1
}), let pid2 = supervisor.currentPid else {
    fputs("FAIL: did not auto-restart after SIGKILL\\n", stderr)
    supervisor.stopIfOwned()
    exit(1)
}
let runningSummaryAfterAutoRestart = statusBar.currentSummaryTitle
let crashVisibleAfterAutoRestart = statusBar.isLastCrashVisible

// 2. 用户点重启 -> 不计入崩溃，且重置连续崩溃计数
var restartedOk = false
supervisor.restartDaemon { result in
    if case .success = result { restartedOk = true }
}
guard waitUntil(timeout: 15.0, condition: { restartedOk }), let pid3 = supervisor.currentPid, pid3 != pid2 else {
    fputs("FAIL: manual restartDaemon failed\\n", stderr)
    supervisor.stopIfOwned()
    exit(1)
}
let crashCountAfterManualRestart = supervisor.recentCrashCount
let crashTitleAfterManualRestart = statusBar.currentLastCrashTitle

// 3. 连续崩溃 5 次（1s + 2s + 4s + 8s 退避）-> 停止重试并在菜单栏显示失败状态
setenv("AGENT_HUB_DAEMON_ENTRY", CommandLine.arguments[1], 1)
// 先把当前正常跑的 pid3 杀掉触发第 1 次崩溃，后续 4 次自动拉起会跑 crashEntryPath 立即以退出码 1 崩溃
kill(pid3, SIGKILL)

guard waitUntil(timeout: 30.0, condition: {
    if case .failed(let count, _, _) = supervisor.currentState {
        return count == SupervisorConfig.maxCrashCountInWindow
    }
    return false
}) else {
    fputs("FAIL: did not enter failed state after consecutive crashes, state=\\(supervisor.currentState)\\n", stderr)
    supervisor.stopIfOwned()
    exit(1)
}
// 多等 1.5 秒确认不会再拉起第 6 个进程
pumpRunLoop(1.5)
let pidAfterFailed = supervisor.currentPid
let failedSummaryTitle = statusBar.currentSummaryTitle
let failedButtonTitle = statusBar.currentButtonTitle
let failedLastCrashTitle = statusBar.currentLastCrashTitle

supervisor.stopIfOwned()
pumpRunLoop(0.5)

let output: [String: Any] = [
    "pid1": pid1,
    "pid2": pid2,
    "pid3": pid3,
    "crashedPids": crashedPids,
    "restartingSummaryAfterKill9": restartingSummaryAfterKill9,
    "crashTitleAfterKill9": crashTitleAfterKill9,
    "runningSummaryAfterAutoRestart": runningSummaryAfterAutoRestart,
    "crashVisibleAfterAutoRestart": crashVisibleAfterAutoRestart,
    "crashCountAfterManualRestart": crashCountAfterManualRestart,
    "crashTitleAfterManualRestart": crashTitleAfterManualRestart,
    "pidAfterFailed": pidAfterFailed as Any,
    "failedSummaryTitle": failedSummaryTitle,
    "failedButtonTitle": failedButtonTitle,
    "failedLastCrashTitle": failedLastCrashTitle,
]
let jsonData = try! JSONSerialization.data(withJSONObject: output, options: [])
print(String(data: jsonData, encoding: .utf8)!)
`,
      );

      const targetArch = arch() === "arm64" ? "arm64" : "x86_64";
      execFileSync(
        "/usr/bin/swiftc",
        [
          "-target",
          `${targetArch}-apple-macos13.0`,
          "-framework",
          "AppKit",
          join(repoRoot, "apps/macos/DaemonSupervisor.swift"),
          join(repoRoot, "apps/macos/StatusBarController.swift"),
          swiftMainPath,
          "-o",
          binPath,
        ],
        { stdio: "pipe" },
      );

      const supHome = home("macos-sup");
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn(binPath, [crashEntryPath, String(external.port), String(freePort)], {
          env: {
            ...envOf("macos-sup", String(freePort)),
            AGENT_HUB_REPO_DIR: repoRoot,
            AGENT_HUB_NODE: process.execPath,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
        child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code === 0) resolve(out);
          else reject(new Error(`supervisor-harness exited ${code}: ${err}`));
        });
      });

      // 外部守护进程未受 stopIfOwned 影响，仍在正常响应
      const extResp = await fetch(`http://127.0.0.1:${external.port}/api/auth/status`);
      expect(extResp.status).toBeGreaterThan(0);

      const jsonLine = stdout
        .trim()
        .split("\n")
        .find((line) => line.startsWith("{"));
      expect(jsonLine).toBeDefined();
      const res = JSON.parse(jsonLine!) as {
        pid1: number;
        pid2: number;
        pid3: number;
        crashedPids: number[];
        restartingSummaryAfterKill9: string;
        crashTitleAfterKill9: string;
        runningSummaryAfterAutoRestart: string;
        crashVisibleAfterAutoRestart: boolean;
        crashCountAfterManualRestart: number;
        crashTitleAfterManualRestart: string;
        pidAfterFailed: number | null;
        failedSummaryTitle: string;
        failedButtonTitle: string;
        failedLastCrashTitle: string;
      };

      expect(res.pid1).toBeGreaterThan(0);
      expect(res.pid2).toBeGreaterThan(0);
      expect(res.pid2).not.toBe(res.pid1);
      expect(res.pid3).toBeGreaterThan(0);
      expect(res.pid3).not.toBe(res.pid2);
      expect(res.crashedPids.length).toBe(6);

      // 1. kill -9 后自动重启，且菜单栏保留上次崩溃时间与原因
      expect(res.restartingSummaryAfterKill9).toContain("后台意外退出");
      expect(res.crashTitleAfterKill9).toContain("信号 9 (SIGKILL)");
      expect(res.runningSummaryAfterAutoRestart).toBe("后台服务运行中");
      expect(res.crashVisibleAfterAutoRestart).toBe(true);

      // 2. 用户点重启不计入崩溃（crashCount 清零，上次崩溃记录不被 SIGTERM 覆盖）
      expect(res.crashCountAfterManualRestart).toBe(0);
      expect(res.crashTitleAfterManualRestart).toBe(res.crashTitleAfterKill9);

      // 3. 连续崩溃 5 次后停止重试，菜单栏显示失败状态及包含 stderr 的原因
      expect(res.pidAfterFailed ?? null).toBeNull();
      expect(res.failedSummaryTitle).toBe("后台服务异常停止（连续崩溃 5 次，已停止重试）");
      expect(res.failedButtonTitle).toBe(" !");
      expect(res.failedLastCrashTitle).toContain("退出码 1（Fatal: simulated database corruption）");

      // 4. desktop-daemon.log 包含信号、退出码、stderr 最后几行和停止重试说明
      const desktopLog = readFileSync(join(supHome, "state", "logs", "desktop-daemon.log"), "utf8");
      expect(desktopLog).toContain(`守护进程（PID ${res.pid1}）意外退出：信号 9 (SIGKILL)`);
      expect(desktopLog).not.toContain(`守护进程（PID ${res.pid2}）意外退出`);
      expect(desktopLog).toContain("Fatal: simulated database corruption");
      expect(desktopLog).toContain("60 秒内连续崩溃 5 次，已停止自动重启");

      // 5. 确认测试拉起的所有后台进程均已退出
      for (const pid of new Set([res.pid1, res.pid2, res.pid3, ...res.crashedPids])) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
      console.info("SUPERVISOR_TEST_PIDS:", JSON.stringify({ pid1: res.pid1, pid2: res.pid2, pid3: res.pid3, crashedPids: res.crashedPids }));
    },
    60_000,
  );
});
