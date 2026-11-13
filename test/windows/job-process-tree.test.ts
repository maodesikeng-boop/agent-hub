import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { forceKill, isAlive, signalChild, waitForExit } from "../../src/daemon/driver/process.ts";
import { removeTreeWithRetry, spawnOwnedProcess } from "../../src/daemon/platform/index.ts";
import { writeExecutableNodeScript } from "../fake-cli-shim.ts";
import { writeDiagLog } from "./diag-helper.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    try {
      await fn();
    } catch (err) {
      writeDiagLog("job-cleanup", String(err));
    }
  }
});

async function waitForFileLines(file: string, minLines: number, timeoutMs = 8_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const lines = readFileSync(file, "utf8")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (lines.length >= minLines) return lines;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Timed out waiting for ${minLines} lines in ${file}`);
}

describe.runIf(process.platform === "win32")("Windows 真机集成：fusa-run Job Object 进程树强杀与 1s 内删目录", () => {
  it("① 停一轮强杀：孙进程、cmd start /b 后台进程与 worktree 内占用进程在 1s 内全部清空且 worktree 可立即删除", { timeout: 30_000 }, async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "fusa-job-kill-")));
    cleanups.push(() => removeTreeWithRetry(root));
    const wtDir = join(root, "wt");
    mkdirSync(wtDir, { recursive: true });
    const pidsFile = join(root, "pids.txt");

    const fakeCli = writeExecutableNodeScript(
      join(root, "fake-cli"),
      `
import { spawn } from "node:child_process";
import { appendFileSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const wt = process.cwd();
const heldFd = openSync(join(wt, "locked.bin"), "w");
writeFileSync(join(wt, "marker.txt"), "busy");

const grandNode = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  cwd: wt,
  stdio: "ignore",
  windowsHide: true,
});
const startBg = spawn("cmd.exe", ["/d", "/c", "start /b ping -n 60 127.0.0.1 >NUL"], {
  cwd: wt,
  stdio: "ignore",
  windowsHide: true,
});
const longPing = spawn("ping.exe", ["-n", "60", "127.0.0.1"], {
  cwd: wt,
  stdio: "ignore",
  windowsHide: true,
});

appendFileSync(${JSON.stringify(pidsFile)}, [process.pid, grandNode.pid, longPing.pid].join("\\n") + "\\n");
setInterval(() => { void heldFd; }, 1000);
`,
    );

    const { child } = spawnOwnedProcess(fakeCli, [], {
      cwd: wtDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const pids = (await waitForFileLines(pidsFile, 3)).map(Number);
    for (const pid of pids) expect(isAlive(pid)).toBe(true);

    const t0 = Date.now();
    await forceKill(child);
    for (const pid of pids) {
      expect(await waitForExit(pid, 1_000), `PID ${pid} should exit within 1s`).toBe(true);
    }
    expect(Date.now() - t0).toBeLessThan(1_500);

    // 进程树死透后 worktree 目录（含刚才被打开且作为孙进程 cwd 的目录）立即一次删除成功
    await removeTreeWithRetry(wtDir);
    expect(existsSync(wtDir)).toBe(false);
  });

  it("② 直接 TerminateProcess 外层守护进程：libuv Job -> fusa-run Job 链式回收整棵孙进程树", { timeout: 30_000 }, async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "fusa-job-chain-")));
    cleanups.push(() => removeTreeWithRetry(root));
    const pidsFile = join(root, "chain-pids.txt");
    const helperDir = process.env.AGENT_HUB_WIN_HELPERS || join(process.cwd(), "apps", "windows", "target", "release");

    const innerScript = join(root, "inner-worker.mjs");
    writeFileSync(
      innerScript,
      `
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
const leaf = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
  windowsHide: true,
});
appendFileSync(${JSON.stringify(pidsFile)}, process.pid + "\\n" + leaf.pid + "\\n");
setInterval(() => {}, 1000);
`,
    );

    const outerScript = join(root, "outer-daemon.mjs");
    writeFileSync(
      outerScript,
      `
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const fusaRun = join(${JSON.stringify(helperDir)}, "fusa-run.exe");
const runner = spawn(fusaRun, ["--", process.execPath, ${JSON.stringify(innerScript)}], {
  stdio: "ignore",
  detached: false,
  windowsHide: true,
});
appendFileSync(${JSON.stringify(pidsFile)}, runner.pid + "\\n");
setInterval(() => {}, 1000);
`,
    );

    const outer = spawn(process.execPath, [outerScript], { stdio: "ignore", windowsHide: true });
    const pids = (await waitForFileLines(pidsFile, 3)).map(Number);
    for (const pid of pids) expect(isAlive(pid)).toBe(true);

    // 模拟外层守护进程崩溃被系统强杀
    outer.kill("SIGKILL");
    for (const pid of pids) {
      expect(await waitForExit(pid, 2_000), `chained PID ${pid} should die with outer process`).toBe(true);
    }
  });

  it("③ 根进程提前退出而孙进程仍驻留后台：fusa-run 退出前 TerminateJobObject 清空残留后代", { timeout: 30_000 }, async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "fusa-job-early-exit-")));
    cleanups.push(() => removeTreeWithRetry(root));
    const leafPidFile = join(root, "leaf.pid");

    const fakeCli = writeExecutableNodeScript(
      join(root, "early-exit-cli"),
      `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const bg = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
});
bg.unref();
writeFileSync(${JSON.stringify(leafPidFile)}, String(bg.pid));
process.exit(0);
`,
    );

    const { child } = spawnOwnedProcess(fakeCli, [], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    const exitCode = await new Promise<number | null>((resolve) => child.once("exit", (c) => resolve(c)));
    expect(exitCode).toBe(0);

    const leafPid = Number(readFileSync(leafPidFile, "utf8").trim());
    expect(await waitForExit(leafPid, 1_000)).toBe(true);
  });

  it("④ 控制管道复用：同一长驻会话连续多次发送 SIGINT（CTRL_C_EVENT）均能送达而不丢失", { timeout: 30_000 }, async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "fusa-job-multi-int-")));
    cleanups.push(() => removeTreeWithRetry(root));
    const sigLog = join(root, "signals.txt");

    const fakeCli = writeExecutableNodeScript(
      join(root, "multi-int-cli"),
      `
import { appendFileSync } from "node:fs";
let count = 0;
process.on("SIGINT", () => {
  count += 1;
  appendFileSync(${JSON.stringify(sigLog)}, "sigint-" + count + "\\n");
  if (count >= 2) {
    process.exit(0);
  }
});
appendFileSync(${JSON.stringify(sigLog)}, "ready\\n");
setInterval(() => {}, 1000);
`,
    );

    const { child } = spawnOwnedProcess(fakeCli, [], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    cleanups.push(() => forceKill(child));

    await waitForFileLines(sigLog, 1);
    signalChild(child, "SIGINT");
    await waitForFileLines(sigLog, 2);
    signalChild(child, "SIGINT");
    const lines = await waitForFileLines(sigLog, 3);
    expect(lines).toEqual(["ready", "sigint-1", "sigint-2"]);
  });
});
