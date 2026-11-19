// acl.ts 运行期调 fusa-run.exe：异步执行不卡事件循环，(Worker, 目录) 去重。用假的 fusa-run.exe（shell 脚本）记下每次调用，只在 POSIX 上跑。
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_WIN_HELPERS } from "../../../shared/limits.ts";
import { allowWin32WorkerWorktreeAcl, ensureWin32ProtectedRootAcl, resetVerifiedProtectedRootsForTest } from "./acl.ts";

let root: string;
let stateDir: string;
let logFile: string;
let env: Record<string, string>;

/** 假的 fusa-run.exe：每次调用把参数写一行进日志，再睡 delay 秒；exitCode 非 0 时失败退出。 */
function fakeHelper(options: { delay?: number; exitCode?: number } = {}) {
  const dir = join(root, "helpers");
  mkdirSync(dir, { recursive: true });
  const helper = join(dir, "fusa-run.exe");
  writeFileSync(helper, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${logFile}'\nsleep ${options.delay ?? 0.2}\nexit ${options.exitCode ?? 0}\n`);
  chmodSync(helper, 0o755);
  env = { [ENV_WIN_HELPERS]: dir };
}

const invocations = () => {
  try {
    return readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

/** 跑 fn 期间事件循环转了几次（计时器回调次数）。 */
async function ticksDuring(fn: () => unknown): Promise<number> {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  try {
    await fn();
  } finally {
    clearInterval(timer);
  }
  return ticks;
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-acl-")));
  stateDir = join(root, "state");
  logFile = join(root, "calls.log");
  mkdirSync(stateDir, { recursive: true });
  resetVerifiedProtectedRootsForTest();
});

afterEach(() => {
  resetVerifiedProtectedRootsForTest();
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("acl.ts 运行期调 fusa-run.exe", () => {
  it("allow-worker：异步执行、不卡事件循环；同一个 Worker 同一个目录只调一次", async () => {
    fakeHelper();
    const wt = join(root, "worktrees", "1", "7");
    const ticks = await ticksDuring(async () => {
      await allowWin32WorkerWorktreeAcl(stateDir, 7, wt, { env });
      await allowWin32WorkerWorktreeAcl(stateDir, "7", wt, { env });
    });
    expect(invocations()).toEqual([`acl allow-worker --state-dir ${stateDir} --worker 7 --path ${wt}`]);
    expect(ticks).toBeGreaterThan(0);
  });

  it("allow-worker：换了 Worker 或目录照常再调；调失败的不记，下次重试", async () => {
    fakeHelper({ delay: 0, exitCode: 1 });
    const wt = join(root, "worktrees", "1", "7");
    await expect(allowWin32WorkerWorktreeAcl(stateDir, "7", wt, { env })).rejects.toThrow();
    fakeHelper({ delay: 0 });
    await allowWin32WorkerWorktreeAcl(stateDir, "7", wt, { env });
    await allowWin32WorkerWorktreeAcl(stateDir, "8", wt, { env });
    await allowWin32WorkerWorktreeAcl(stateDir, "7", join(root, "worktrees", "1", "9"), { env });
    expect(invocations()).toHaveLength(4);
  });

  it("protect-root：异步执行、不卡事件循环；同一个根只调一次", async () => {
    fakeHelper();
    const ticks = await ticksDuring(async () => {
      await ensureWin32ProtectedRootAcl(stateDir, root, { env });
      await ensureWin32ProtectedRootAcl(stateDir, root, { env });
    });
    expect(invocations()).toEqual([`acl protect-root --state-dir ${stateDir} --path ${root}`]);
    expect(ticks).toBeGreaterThan(0);
  });
});
