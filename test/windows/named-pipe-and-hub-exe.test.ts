import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeHubLedger } from "../../src/daemon/agent-api/fake-ledger.ts";
import { startAgentApi, type RunningAgentApi } from "../../src/daemon/agent-api/server.ts";
import { installHubShim } from "../../src/daemon/agent-api/shim.ts";
import { createSessionTokens } from "../../src/daemon/agent-api/tokens.ts";
import { startDaemon, type RunningDaemon } from "../../src/daemon/daemon.ts";
import { removeTreeWithRetry } from "../../src/daemon/platform/index.ts";
import { DaemonAlreadyRunningError } from "../../src/daemon/store/index.ts";
import { ENV_HOME, ENV_HUB_SOCK, ENV_HUB_TOKEN, ENV_PORT } from "../../src/shared/index.ts";
import { isWindowsNamedPipe, resolveHubPaths } from "../../src/shared/paths.ts";
import { writeDiagLog } from "./diag-helper.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    try {
      await fn();
    } catch (err) {
      writeDiagLog("pipe-cleanup", String(err));
    }
  }
});

function findGitBash(): string {
  const candidates = [
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "bash.exe"),
  ];
  const hit = candidates.find((c) => existsSync(c));
  if (!hit) throw new Error("Git Bash not found on Windows runner");
  return hit;
}

function runChildAsync(
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; input?: string },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ status: code, stdout, stderr });
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input, "utf8");
    } else {
      child.stdin.end();
    }
  });
}

describe.runIf(process.platform === "win32")("Windows 真机集成：命名管道、hub.exe 三种 Shell 防注入与单实例互斥", () => {
  it("cmd / pwsh / Git Bash 调用 hub.exe 传递特殊元字符、中文、emoji 与多行 stdin 逐字节无损；Git Bash 下 /model 参数报可读中文错", { timeout: 30_000 }, async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "fusa-pipe-hub-")));
    cleanups.push(() => removeTreeWithRetry(dir));

    const paths = resolveHubPaths({}, dir);
    expect(isWindowsNamedPipe(paths.hubSock)).toBe(true);

    const ledger = new FakeHubLedger();
    const tokens = createSessionTokens();
    const api: RunningAgentApi = await startAgentApi({
      ledger,
      tokens,
      runDir: paths.runDir,
      hubSock: paths.hubSock,
    });
    cleanups.push(() => api.close());

    const hubExe = installHubShim({ binDir: paths.hubBinDir });
    expect(hubExe.endsWith("hub.exe")).toBe(true);
    const token = tokens.issue(77);
    const baseEnv = {
      ...process.env,
      PATH: `${paths.hubBinDir};${process.env.PATH ?? process.env.Path ?? ""}`,
      [ENV_HUB_TOKEN]: token,
      [ENV_HUB_SOCK]: api.socketPath,
    };

    const trickyKeywords = [
      "a&b",
      "a|b",
      "%PATH%",
      "!x!",
      "^caret^",
      '"quoted"',
      "中文关键字",
      "🚀emoji",
    ];

    // 1) cmd.exe /d /c（用外层双引号与转义双引号，验证 hub.exe 绕过 .cmd 二次解析，%PATH% 不展开为系统路径当用延时/变量保护或 pwsh/bash 原样传）
    ledger.calls.length = 0;
    const cmdRes = await runChildAsync(
      "cmd.exe",
      ["/d", "/c", 'hub worker search "a&b" "a|b" "^caret^" "中文关键字" "🚀emoji"'],
      { env: baseEnv },
    );
    expect(cmdRes.status, cmdRes.stderr).toBe(0);
    expect((ledger.calls.at(-1)?.args as { keywords: string[] }).keywords).toEqual([
      "a&b",
      "a|b",
      "^caret^",
      "中文关键字",
      "🚀emoji",
    ]);

    // 2) PowerShell 7 (pwsh) 传递全集特殊参数（含字面 %PATH%、!x!、引号）
    ledger.calls.length = 0;
    const pwshLit = trickyKeywords.map((s) => `'${s.replaceAll("'", "''")}'`).join(" ");
    const pwshRes = await runChildAsync(
      "pwsh.exe",
      ["-NoProfile", "-Command", `& hub worker search ${pwshLit}`],
      { env: baseEnv },
    );
    expect(pwshRes.status, pwshRes.stderr).toBe(0);
    expect((ledger.calls.at(-1)?.args as { keywords: string[] }).keywords).toEqual(trickyKeywords);

    // 3) Git Bash (bash.exe -c) 传递全集特殊参数 + 多行 --stdin
    const gitBash = findGitBash();
    ledger.calls.length = 0;
    const bashLit = trickyKeywords.map((s) => `'${s}'`).join(" ");
    const bashRes = await runChildAsync(
      gitBash,
      ["-c", `hub worker search ${bashLit}`],
      { env: baseEnv },
    );
    expect(bashRes.status, bashRes.stderr).toBe(0);
    expect((ledger.calls.at(-1)?.args as { keywords: string[] }).keywords).toEqual(trickyKeywords);

    // 多行 --stdin（含换行、%PATH%、&、|、中文、emoji）逐字节一致
    ledger.calls.length = 0;
    const multilinePayload = "第一行 & | ^ %PATH% !x!\n第二行 \"引号\" 中文 🚀\n第三行末尾";
    const stdinRes = await runChildAsync(hubExe, ["persona", "edit", "--stdin"], {
      env: baseEnv,
      input: `${multilinePayload}\n`,
    });
    expect(stdinRes.status, stdinRes.stderr).toBe(0);
    expect((ledger.calls.at(-1)?.args as { text: string }).text).toBe(multilinePayload);

    // 4) Git Bash 下不带 MSYS_NO_PATHCONV 传 `/model` 开头的参数：MSYS 改写后应报可读中文错（退出码 2）
    const msysSlashRes = await runChildAsync(
      gitBash,
      ["-c", "hub worker search /model"],
      { env: baseEnv },
    );
    expect(msysSlashRes.status).toBe(2);
    expect(msysSlashRes.stderr).toContain("Git Bash (MSYSTEM)");
  });

  it("同一数据目录启动第二个后台立即被目录锁 / admin 管道拒绝（DaemonAlreadyRunningError）", { timeout: 30_000 }, async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "fusa-single-inst-")));
    cleanups.push(() => removeTreeWithRetry(dir));
    const userHome = join(dir, "user");
    const dataHome = join(dir, "data");
    mkdirSync(userHome, { recursive: true });

    const env = {
      ...process.env,
      [ENV_HOME]: dataHome,
      [ENV_PORT]: "0",
    };
    const noTailnet = { current: () => null, refresh: async () => null };

    const first: RunningDaemon = await startDaemon({
      userHome,
      env,
      tailnet: noTailnet,
      log: () => {},
    });
    cleanups.push(() => first.stop());

    await expect(
      startDaemon({
        userHome,
        env,
        tailnet: noTailnet,
        log: () => {},
      }),
    ).rejects.toThrow(DaemonAlreadyRunningError);

    // 同时核验 fusa-run inspect 对当前存活进程给出稳定创建时间
    const helperOut = execFileSync(
      join(process.env.AGENT_HUB_WIN_HELPERS || join(process.cwd(), "apps", "windows", "target", "release"), "fusa-run.exe"),
      ["inspect", "--pid", String(process.pid)],
      { encoding: "utf8", windowsHide: true },
    );
    const inspected = JSON.parse(helperOut) as { alive: boolean; creationTime?: string };
    expect(inspected.alive).toBe(true);
    expect(inspected.creationTime).toMatch(/^\d+$/);
  });
});
