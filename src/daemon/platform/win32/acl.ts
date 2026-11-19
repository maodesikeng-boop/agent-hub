import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { LRUCache } from "lru-cache";
import {
  WIN_HELPER_PROBE_TIMEOUT_MS,
  WIN_PROTECTED_ROOTS_CACHE_MAX,
  WIN_WORKER_ACL_CACHE_MAX,
} from "../../../shared/limits.ts";
import { findWinHelperBinary, requireWinHelperBinary } from "./helper-bins.ts";
import { normalizePathForComparison } from "./path-key.ts";

const execFileAsync = promisify(execFile);

/**
 * 运行期（建 worktree、起 Worker 前）调 fusa-run.exe 设 ACL 都走异步 execFile，不卡守护进程的事件循环。
 * 设成功的记进有界缓存，同一个键在途时共用一次调用；失败的不记，下次重试。
 */
function createAclRunner(max: number) {
  const done = new LRUCache<string, true>({ max });
  const inflight = new Map<string, Promise<void>>();
  return {
    run(key: string, apply: () => Promise<unknown>, force = false): Promise<void> {
      if (!force && done.has(key)) return Promise.resolve();
      const pending = inflight.get(key);
      if (pending !== undefined) return pending;
      const next = apply()
        .then(() => {
          done.set(key, true);
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, next);
      return next;
    },
    clear() {
      done.clear();
    },
  };
}

const protectedRoots = createAclRunner(WIN_PROTECTED_ROOTS_CACHE_MAX);
const workerWorktrees = createAclRunner(WIN_WORKER_ACL_CACHE_MAX);
const readBoundary = createAclRunner(WIN_WORKER_ACL_CACHE_MAX);

export function resetVerifiedProtectedRootsForTest(): void {
  protectedRoots.clear();
  workerWorktrees.clear();
  readBoundary.clear();
}

function runAclHelper(args: string[], env: Record<string, string | undefined> | undefined) {
  return execFileAsync(requireWinHelperBinary("fusa-run.exe", { env }), args, { timeout: WIN_HELPER_PROBE_TIMEOUT_MS * 2, windowsHide: true });
}

/** 数据目录读边界：数据目录设可继承的 `DENY FusaWorker` 读（内容、扩展属性、执行），沙箱里的 Worker 列不了、读不了。 */
export function denyWin32WorkerReadAcl(stateDir: string, dataDir: string, options?: { env?: Record<string, string | undefined> }): Promise<void> {
  const key = `deny\0${normalizePathForComparison(stateDir)}\0${normalizePathForComparison(dataDir)}`;
  return readBoundary.run(key, () => runAclHelper(["acl", "deny-read", "--state-dir", stateDir, "--path", dataDir], options?.env));
}

/**
 * 在禁读的数据目录里放行读：不带 reader 时给所有 Worker（worktrees、uploads、tools、run\bin），
 * 带 reader 时只给这一个会话的 `FusaRead-<reader>`（它自己的启动目录）。
 */
export function allowWin32WorkerReadAcl(
  stateDir: string,
  path: string,
  options?: { reader?: string; env?: Record<string, string | undefined> },
): Promise<void> {
  const reader = options?.reader;
  const key = `allow\0${normalizePathForComparison(stateDir)}\0${reader ?? ""}\0${normalizePathForComparison(path)}`;
  return readBoundary.run(key, () =>
    runAclHelper(["acl", "allow-read", "--state-dir", stateDir, ...(reader === undefined ? [] : ["--reader", reader]), "--path", path], options?.env),
  );
}

/** 管理命名管道（admin）设 `DENY FusaWorker`：沙箱里的 Worker 连不上，哪怕和守护进程是同一个用户。 */
export function denyWin32WorkerPipeAccess(stateDir: string, pipePath: string, options?: { env?: Record<string, string | undefined> }): Promise<void> {
  return runAclHelper(["acl", "deny-pipe", "--state-dir", stateDir, "--path", pipePath], options?.env).then(() => undefined);
}

/** Runs `fusa-run.exe probe` to verify Job Object + restricted token + NTFS ACL enforcement (write deny and data-dir read deny). */
export function runWin32SandboxProbe(options?: {
  stateDir?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}): boolean {
  const helper = findWinHelperBinary("fusa-run.exe", { env: options?.env });
  if (helper === null) return false;
  const args = ["probe"];
  if (options?.stateDir) {
    args.push("--state-dir", options.stateDir);
  }
  try {
    execFileSync(helper, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options?.timeoutMs ?? WIN_HELPER_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/** Ensures a protected root (`dataDir` or cross-volume `.fusa-wt`) has inheritable `DENY FusaWorker` write ACE + `OWNER RIGHTS: READ_CONTROL`. */
export function ensureWin32ProtectedRootAcl(
  stateDir: string,
  rootPath: string,
  options?: { force?: boolean; env?: Record<string, string | undefined> },
): Promise<void> {
  const key = `${normalizePathForComparison(stateDir)}\0${normalizePathForComparison(rootPath)}`;
  return protectedRoots.run(
    key,
    () =>
      execFileAsync(requireWinHelperBinary("fusa-run.exe", { env: options?.env }), ["acl", "protect-root", "--state-dir", stateDir, "--path", rootPath], {
        timeout: WIN_HELPER_PROBE_TIMEOUT_MS * 4,
        windowsHide: true,
      }),
    options?.force === true,
  );
}

/** Grants `ALLOW FusaWorker-<workerId>` Modify ACE on an empty worktree directory before `git worktree add`. */
export function allowWin32WorkerWorktreeAcl(
  stateDir: string,
  workerId: string | number,
  worktreePath: string,
  options?: { env?: Record<string, string | undefined> },
): Promise<void> {
  const key = `${normalizePathForComparison(stateDir)}\0${String(workerId)}\0${normalizePathForComparison(worktreePath)}`;
  return workerWorktrees.run(key, () =>
    execFileAsync(
      requireWinHelperBinary("fusa-run.exe", { env: options?.env }),
      ["acl", "allow-worker", "--state-dir", stateDir, "--worker", String(workerId), "--path", worktreePath],
      { timeout: WIN_HELPER_PROBE_TIMEOUT_MS * 2, windowsHide: true },
    ),
  );
}

/** Windows 0700 equivalent on `state\`, `run\`, `backups\` (protected DACL + `DENY FusaWorker`). */
export function hardenWin32PrivateDirAcl(
  stateDir: string,
  dirPath: string,
  options?: { env?: Record<string, string | undefined> },
): boolean {
  const helper = findWinHelperBinary("fusa-run.exe", { env: options?.env });
  if (helper === null) return false;
  try {
    execFileSync(helper, ["acl", "harden", "--state-dir", stateDir, "--path", dirPath], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: WIN_HELPER_PROBE_TIMEOUT_MS * 4,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Grants `FILE_GENERIC_READ | FILE_GENERIC_WRITE | SYNCHRONIZE` to the current user's personal SID
 * on a Windows Named Pipe so `LUA_TOKEN` sandboxed Workers can connect even when the daemon runs elevated.
 */
export function allowWin32NamedPipeUserAccess(
  pipePath: string,
  options?: { env?: Record<string, string | undefined> },
): boolean {
  const helper = findWinHelperBinary("fusa-run.exe", { env: options?.env });
  if (helper === null) return false;
  try {
    execFileSync(helper, ["acl", "allow-pipe", "--path", pipePath], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: WIN_HELPER_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

export interface Win32LockHolder {
  pid: number;
  appName: string;
  serviceShortName: string;
  applicationType: number;
}

/** Queries Windows Restart Manager via `fusa-run.exe who-locks <path>` to report processes locking a path. */
export function queryWin32WhoLocks(
  targetPath: string,
  options?: { env?: Record<string, string | undefined> },
): Win32LockHolder[] {
  const helper = findWinHelperBinary("fusa-run.exe", { env: options?.env });
  if (helper === null) return [];
  try {
    const stdout = execFileSync(helper, ["who-locks", targetPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: WIN_HELPER_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const parsed = JSON.parse(stdout) as { holders?: unknown };
    if (!Array.isArray(parsed.holders)) return [];
    return parsed.holders.filter(
      (h): h is Win32LockHolder =>
        typeof h === "object" &&
        h !== null &&
        typeof (h as { pid?: unknown }).pid === "number" &&
        typeof (h as { appName?: unknown }).appName === "string",
    );
  } catch {
    return [];
  }
}

export function formatWin32LockHolders(holders: readonly Win32LockHolder[]): string {
  if (holders.length === 0) return "";
  return holders
    .slice(0, 8)
    .map((h) => `${h.appName || h.serviceShortName || "unknown"} (PID ${h.pid})`)
    .join("、");
}
