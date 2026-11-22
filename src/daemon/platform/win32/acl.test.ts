// acl.ts 运行期调 fusa-run.exe：异步执行不卡事件循环，(Worker, 目录) 去重。用假的 fusa-run.exe（shell 脚本）记下每次调用，只在 POSIX 上跑。
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_WIN_HELPERS, TEST_TIMEOUT_MS, WIN_ACL_REVERIFY_ATTEMPTS_MAX } from "../../../shared/limits.ts";
import { allowWin32WorkerReadAcl, allowWin32WorkerWorktreeAcl, ensureWin32ProtectedRootAcl, resetVerifiedProtectedRootsForTest } from "./acl.ts";

let root: string;
let stateDir: string;
let logFile: string;
let env: Record<string, string>;

/** 假的 fusa-run.exe：每次调用把参数写一行进日志，再睡 delay 秒（或等到 releaseFile 出现）；exitCode 非 0 时失败退出。 */
function fakeHelper(options: { delay?: number; exitCode?: number; releaseFile?: string } = {}) {
  const dir = join(root, "helpers");
  mkdirSync(dir, { recursive: true });
  const helper = join(dir, "fusa-run.exe");
  const wait = options.releaseFile ? `while [ ! -e '${options.releaseFile}' ]; do sleep 0.01; done` : `sleep ${options.delay ?? 0.2}`;
  writeFileSync(helper, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${logFile}'\n${wait}\nexit ${options.exitCode ?? 0}\n`);
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
    mkdirSync(wt, { recursive: true });
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

  it("allow-worker：同一路径的目录被删掉重建（ACE 跟着旧目录没了）：再调一次", async () => {
    fakeHelper({ delay: 0 });
    const wt = join(root, "worktrees", "1", "7");
    mkdirSync(wt, { recursive: true });
    await allowWin32WorkerWorktreeAcl(stateDir, 7, wt, { env });
    renameSync(wt, `${wt}-old`);
    mkdirSync(wt);
    await allowWin32WorkerWorktreeAcl(stateDir, 7, wt, { env });
    await allowWin32WorkerWorktreeAcl(stateDir, 7, wt, { env });
    expect(invocations()).toHaveLength(2);
  });

  it("allow-worker：在途期间同一路径的目录被替换，后来的调用等在途的跑完再对新目录调一次", async () => {
    const release = join(root, "release");
    fakeHelper({ releaseFile: release });
    const wt = join(root, "worktrees", "1", "7");
    mkdirSync(wt, { recursive: true });
    const first = allowWin32WorkerWorktreeAcl(stateDir, 7, wt, { env });
    await vi.waitFor(() => expect(invocations()).toHaveLength(1), { timeout: TEST_TIMEOUT_MS, interval: 10 });
    renameSync(wt, `${wt}-old`);
    mkdirSync(wt);
    const second = allowWin32WorkerWorktreeAcl(stateDir, 7, wt, { env });
    writeFileSync(release, "");
    await Promise.all([first, second]);
    expect(invocations()).toHaveLength(2);
    await allowWin32WorkerWorktreeAcl(stateDir, 7, wt, { env });
    expect(invocations()).toHaveLength(2);
  });

  it("allow-worker：每次调用期间目录都被换掉，重试几次仍对不上就报错，不当成功", async () => {
    const dir = join(root, "helpers");
    mkdirSync(dir, { recursive: true });
    const helper = join(dir, "fusa-run.exe");
    // 最后一个参数是目录：每次调用都把它换成新目录
    writeFileSync(helper, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${logFile}'\nfor last do :; done\nmv "$last" "$last-$(date +%s%N)-$$"\nmkdir "$last"\n`);
    chmodSync(helper, 0o755);
    env = { [ENV_WIN_HELPERS]: dir };
    const wt = join(root, "worktrees", "1", "7");
    mkdirSync(wt, { recursive: true });
    await expect(allowWin32WorkerWorktreeAcl(stateDir, 7, wt, { env })).rejects.toThrow();
    expect(invocations().length).toBeGreaterThan(1);
    expect(invocations().length).toBeLessThanOrEqual(WIN_ACL_REVERIFY_ATTEMPTS_MAX);
  });

  it("allow-worker：找不到辅助程序（同步抛错）不留在途记录，装好后照常设", async () => {
    const wt = join(root, "worktrees", "1", "7");
    mkdirSync(wt, { recursive: true });
    const empty = join(root, "no-helpers");
    mkdirSync(empty);
    await expect(allowWin32WorkerWorktreeAcl(stateDir, 7, wt, { env: { [ENV_WIN_HELPERS]: empty } })).rejects.toThrow();
    fakeHelper({ delay: 0 });
    await allowWin32WorkerWorktreeAcl(stateDir, 7, wt, { env });
    expect(invocations()).toHaveLength(1);
  });

  it("allow-worker：目录还不存在时不记缓存，建好后照常设", async () => {
    fakeHelper({ delay: 0 });
    const wt = join(root, "worktrees", "1", "7");
    await allowWin32WorkerWorktreeAcl(stateDir, 7, wt, { env });
    mkdirSync(wt, { recursive: true });
    await allowWin32WorkerWorktreeAcl(stateDir, 7, wt, { env });
    expect(invocations()).toHaveLength(2);
  });

  it("allow-worker / allow-read：SID 表里这个 Worker、会话的 SID 轮换掉了（或整张表重建），再调一次", async () => {
    fakeHelper({ delay: 0 });
    const wt = join(root, "worktrees", "1", "7");
    const launch = join(root, "state", "launch", "42");
    mkdirSync(wt, { recursive: true });
    mkdirSync(launch, { recursive: true });
    const sids = (group: string, worker: string, reader: string) =>
      writeFileSync(
        join(stateDir, "win-sandbox-sids.json"),
        JSON.stringify({ version: 1, worker_group_sid: group, worker_sids: { "7": { sid: worker, seq: 1 }, "read-42": { sid: reader, seq: 2 } } }),
      );
    const apply = async () => {
      await allowWin32WorkerWorktreeAcl(stateDir, 7, wt, { env });
      await allowWin32WorkerReadAcl(stateDir, launch, { reader: "42", env });
    };
    sids("S-1-5-21-1-1-1-1", "S-1-5-21-2-2-2-2", "S-1-5-21-3-3-3-3");
    await apply();
    await apply();
    expect(invocations()).toHaveLength(2);
    sids("S-1-5-21-1-1-1-1", "S-1-5-21-4-4-4-4", "S-1-5-21-3-3-3-3");
    await apply();
    expect(invocations()).toHaveLength(3);
    sids("S-1-5-21-5-5-5-5", "S-1-5-21-4-4-4-4", "S-1-5-21-3-3-3-3");
    await apply();
    expect(invocations()).toHaveLength(5);
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
