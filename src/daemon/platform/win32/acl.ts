import { execFile, execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { LRUCache } from "lru-cache";
import {
  WIN_ACL_REVERIFY_ATTEMPTS_MAX,
  WIN_HELPER_PROBE_TIMEOUT_MS,
  WIN_PROTECTED_ROOTS_CACHE_MAX,
  WIN_WORKER_ACL_CACHE_MAX,
} from "../../../shared/limits.ts";
import { findWinHelperBinary, requireWinHelperBinary } from "./helper-bins.ts";
import { normalizePathForComparison } from "./path-key.ts";

const execFileAsync = promisify(execFile);

/** fusa-run 存 SID 的表（fusa-win-helper sids.rs 的 SANDBOX_SIDS_FILE），在状态目录下。 */
const SANDBOX_SIDS_FILE = "win-sandbox-sids.json";
/** 会话读 SID 在表里的键前缀（sids.rs 的 READER_KEY_PREFIX）。 */
const READER_SID_KEY_PREFIX = "read-";

/** ACE 设在哪个目录对象上、给的是哪个 SID：目录删掉重建（ACE 跟着旧目录没了）、SID 表轮换或重建后都会变。 */
interface AclTarget {
  stateDir: string;
  path: string;
  /** SID 表里的键（Worker 编号或 read-<会话>）；只涉及所有 Worker 共用的组 SID 的是 null。 */
  sidKey: string | null;
}

async function dirIdentity(path: string): Promise<string | null> {
  try {
    const st = await stat(path, { bigint: true });
    return `${st.dev}:${st.ino}:${st.birthtimeNs}`;
  } catch {
    return null;
  }
}

/** 组 SID 和 sidKey 的 SID；表还没建、读不了当空（建了以后不再相等，会再调一次）。 */
async function sidsOf(stateDir: string, sidKey: string | null): Promise<string> {
  try {
    const store = JSON.parse(await readFile(join(stateDir, SANDBOX_SIDS_FILE), "utf8")) as {
      worker_group_sid?: unknown;
      worker_sids?: Record<string, { sid?: unknown } | undefined>;
    };
    const group = typeof store.worker_group_sid === "string" ? store.worker_group_sid : "";
    const sid = sidKey === null ? undefined : store.worker_sids?.[sidKey]?.sid;
    return `${group}\0${typeof sid === "string" ? sid : ""}`;
  } catch {
    return "\0";
  }
}

/**
 * 运行期（建 worktree、起 Worker 前）调 fusa-run.exe 设 ACL 都走异步 execFile，不卡守护进程的事件循环。
 * 设成功的记进有界缓存，值是当时的目录身份（dev、ino、创建时间）和 SID：再来时两样都没变才跳过；目录不存在不记。
 * 同一个键在途时等它跑完再按当前目录重新判断，不直接共用它的结果：在途期间目录可能被换掉，它设的是旧目录。
 * 调用前后目录身份对不上（调用期间被换掉）的不算设好，重调，最多 WIN_ACL_REVERIFY_ATTEMPTS_MAX 次；失败的不记，下次重试。
 */
function createAclRunner(max: number) {
  const done = new LRUCache<string, string>({ max });
  const inflight = new Map<string, Promise<boolean>>();
  const fingerprint = async (target: AclTarget, identity: string) => `${identity}\0${await sidsOf(target.stateDir, target.sidKey)}`;
  /** 调一次辅助程序；返回 false 表示调用期间目录被换掉了，这次不算数。 */
  const applyOnce = async (key: string, target: AclTarget, identity: string | null, apply: () => Promise<unknown>): Promise<boolean> => {
    await apply();
    // 调用前目录还不存在：辅助程序会建（create_dir_all），建出来的就是它设过的
    if (identity === null) {
      done.delete(key);
      return true;
    }
    if ((await dirIdentity(target.path)) !== identity) {
      done.delete(key);
      return false;
    }
    // SID 取调用后的：第一次调用才建出 SID
    done.set(key, await fingerprint(target, identity));
    return true;
  };
  /** 登记成在途再跑；跑完（包括 apply 同步抛错）从在途表里删掉的只是自己这一次。 */
  const start = (key: string, target: AclTarget, identity: string | null, apply: () => Promise<unknown>): Promise<boolean> => {
    const next: Promise<boolean> = applyOnce(key, target, identity, apply).finally(() => {
      if (inflight.get(key) === next) inflight.delete(key);
    });
    inflight.set(key, next);
    return next;
  };
  return {
    async run(key: string, target: AclTarget, apply: () => Promise<unknown>, force = false): Promise<void> {
      // 只数目录被换掉的那几次（自己调的、等到的在途调用都算）；等到的在途调用成功了不算，接着按当前目录判断
      let replaced = 0;
      while (replaced < WIN_ACL_REVERIFY_ATTEMPTS_MAX) {
        const pending = inflight.get(key);
        if (pending !== undefined) {
          if (!(await pending)) replaced++;
          force = false;
          continue;
        }
        const identity = await dirIdentity(target.path);
        const cached = done.get(key);
        if (!force && identity !== null && cached !== undefined && cached === (await fingerprint(target, identity))) return;
        // 上面两次 await 期间别的调用可能已经开跑
        if (inflight.has(key)) continue;
        if (await start(key, target, identity, apply)) return;
        replaced++;
        force = false;
      }
      throw new Error(`${target.path}: ${WIN_ACL_REVERIFY_ATTEMPTS_MAX} 次设 ACL 期间目录都被换掉了`);
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
  return readBoundary.run(key, { stateDir, path: dataDir, sidKey: null }, () => runAclHelper(["acl", "deny-read", "--state-dir", stateDir, "--path", dataDir], options?.env));
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
  const sidKey = reader === undefined ? null : `${READER_SID_KEY_PREFIX}${reader.trim()}`;
  return readBoundary.run(key, { stateDir, path, sidKey }, () =>
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
    { stateDir, path: rootPath, sidKey: null },
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
  return workerWorktrees.run(key, { stateDir, path: worktreePath, sidKey: String(workerId).trim() }, () =>
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
