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

const SANDBOX_SIDS_FILE = "win-sandbox-sids.json";
const READER_SID_KEY_PREFIX = "read-";

/** An ACE is bound to the directory object and SID; recreating the directory or rotating the SID table invalidates it. */
interface AclTarget {
  stateDir: string;
  path: string;
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

/** ACL calls use async execFile so they never block the event loop; successes are cached by directory identity (dev, ino, birthtime) and SID. */
function createAclRunner(max: number) {
  const done = new LRUCache<string, string>({ max });
  const inflight = new Map<string, Promise<boolean>>();
  const fingerprint = async (target: AclTarget, identity: string) => `${identity}\0${await sidsOf(target.stateDir, target.sidKey)}`;
  const applyOnce = async (key: string, target: AclTarget, identity: string | null, apply: () => Promise<unknown>): Promise<boolean> => {
    await apply();
    if (identity === null) {
      done.delete(key);
      return true;
    }
    if ((await dirIdentity(target.path)) !== identity) {
      done.delete(key);
      return false;
    }
    done.set(key, await fingerprint(target, identity));
    return true;
  };
  const start = (key: string, target: AclTarget, identity: string | null, apply: () => Promise<unknown>): Promise<boolean> => {
    const next: Promise<boolean> = applyOnce(key, target, identity, apply).finally(() => {
      if (inflight.get(key) === next) inflight.delete(key);
    });
    inflight.set(key, next);
    return next;
  };
  return {
    async run(key: string, target: AclTarget, apply: () => Promise<unknown>, force = false): Promise<void> {
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
        // Other calls may have started during the two awaits above.
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

export function denyWin32WorkerReadAcl(stateDir: string, dataDir: string, options?: { env?: Record<string, string | undefined> }): Promise<void> {
  const key = `deny\0${normalizePathForComparison(stateDir)}\0${normalizePathForComparison(dataDir)}`;
  return readBoundary.run(key, { stateDir, path: dataDir, sidKey: null }, () => runAclHelper(["acl", "deny-read", "--state-dir", stateDir, "--path", dataDir], options?.env));
}

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

/** Same-user processes can open the pipe, so the admin pipe needs DENY FusaWorker. */
export function denyWin32WorkerPipeAccess(stateDir: string, pipePath: string, options?: { env?: Record<string, string | undefined> }): Promise<void> {
  return runAclHelper(["acl", "deny-pipe", "--state-dir", stateDir, "--path", pipePath], options?.env).then(() => undefined);
}

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

/** LUA_TOKEN Workers need explicit pipe access when the daemon runs elevated. */
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
