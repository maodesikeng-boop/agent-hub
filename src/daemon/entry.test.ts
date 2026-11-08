// 守护进程启动失败时终端上看到什么（entry.ts）：已知的码一句话 + hint，不认识的一句话 + 日志路径，堆栈只进日志。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_ERRORS } from "../shared/errors.ts";
import { ENV_HOME, ENV_PORT, LOG_PREFIX, WORKER_ENV } from "../shared/index.ts";
import { resolveHubPaths } from "../shared/paths.ts";
import { startDaemon, type RunningDaemon } from "./daemon.ts";
import { reportStartupFailure, runDaemonProcess } from "./entry.ts";

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
});
