import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type RmOptions,
} from "node:fs";
import { rename as asyncRename, rm as nodeAsyncRm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import writeFileAtomic from "write-file-atomic";
import {
  WIN_REMOVE_PASS_DELAYS_MS,
  WIN_RENAME_RETRY_DELAYS_MS,
} from "../../../shared/limits.ts";
import { formatWin32LockHolders, queryWin32WhoLocks } from "./acl.ts";
import {
  isUncNetworkPath,
  normalizePathForComparison,
  toWin32NamespacedPath,
} from "./path-key.ts";

export const FUSA_MANAGED_COPY_MARKER = ".fusa-managed";

const WIN_DEVICE_NAMESPACE = /^(?:\\\\\.\\|\/\/\.\/|\\\\\?\\GLOBALROOT)/i;
const WIN_RESERVED_DEVICE_BASENAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..+)?$/i;

export function isWindowsDevicePath(targetPath: string): boolean {
  if (WIN_DEVICE_NAMESPACE.test(targetPath.trim())) return true;
  const base = basename(targetPath.trim().replace(/[\\/]+$/, ""));
  return WIN_RESERVED_DEVICE_BASENAME.test(base);
}

function createEloopError(targetPath: string, detail: string): NodeJS.ErrnoException {
  const err = new Error(`${detail}: ${targetPath}`) as NodeJS.ErrnoException;
  err.code = "ELOOP";
  return err;
}

/**
 * Cross-platform `O_NOFOLLOW` + `O_NONBLOCK` regular file opener:
 * - Rejects Windows device namespace paths (`\\.\pipe\...`, `\\?\GLOBALROOT...`, `CON`, `NUL`, etc.);
 * - On POSIX: opens with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` and verifies `fstatSync(fd).isFile()`;
 * - On Windows (where `O_NOFOLLOW` is undefined / 0): checks `lstatSync(path, { bigint: true })` is a non-symlink regular file,
 *   opens `O_RDONLY`, then verifies `fstatSync(fd, { bigint: true })` has identical `(dev, ino)` and `realpathSync.native` matches!
 */
export function openRegularFileNoFollowSync(
  targetPath: string,
  options?: { nonBlock?: boolean; platform?: NodeJS.Platform },
): number {
  const platform = options?.platform ?? process.platform;
  if (platform === "win32" && isWindowsDevicePath(targetPath)) {
    throw createEloopError(targetPath, "refusing to open Windows device path");
  }

  if (platform !== "win32") {
    const flags =
      fsConstants.O_RDONLY |
      (fsConstants.O_NOFOLLOW ?? 0) |
      (options?.nonBlock ? (fsConstants.O_NONBLOCK ?? 0) : 0);
    const fd = openSync(targetPath, flags);
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) {
        const err = new Error(`not a regular file: ${targetPath}`) as NodeJS.ErrnoException;
        err.code = "EINVAL";
        throw err;
      }
      return fd;
    } catch (err) {
      closeSync(fd);
      throw err;
    }
  }

  const before = lstatSync(targetPath, { bigint: true });
  if (before.isSymbolicLink()) {
    throw createEloopError(targetPath, "symlink or junction is not allowed");
  }
  if (!before.isFile()) {
    const err = new Error(`not a regular file: ${targetPath}`) as NodeJS.ErrnoException;
    err.code = "EINVAL";
    throw err;
  }
  const expectedReal = realpathSync.native(targetPath);
  const fd = openSync(targetPath, fsConstants.O_RDONLY);
  try {
    const after = fstatSync(fd, { bigint: true });
    if (!after.isFile()) {
      throw createEloopError(targetPath, "opened handle is not a regular file");
    }
    if (after.dev !== before.dev || (before.ino !== 0n && after.ino !== before.ino)) {
      throw createEloopError(targetPath, "file identity changed during open");
    }
    const afterReal = realpathSync.native(targetPath);
    if (normalizePathForComparison(afterReal) !== normalizePathForComparison(expectedReal)) {
      throw createEloopError(targetPath, "file realpath changed during open");
    }
    return fd;
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

function isRetryableRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

function sleepSyncMs(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Synchronous `rename` with bounded Windows retry (`50/100/150/200/250 ms` on `EPERM/EACCES/EBUSY`). */
export function renameSyncWithWindowsRetry(
  source: string,
  target: string,
  options?: {
    platform?: NodeJS.Platform;
    delaysMs?: readonly number[];
    renameImpl?: (src: string, dst: string) => void;
  },
): void {
  const platform = options?.platform ?? process.platform;
  const delays = platform === "win32" ? (options?.delaysMs ?? WIN_RENAME_RETRY_DELAYS_MS) : [];
  const doRename = options?.renameImpl ?? renameSync;
  for (let attempt = 0; ; attempt += 1) {
    try {
      doRename(source, target);
      return;
    } catch (error) {
      if (attempt >= delays.length || !isRetryableRenameError(error)) {
        throw error;
      }
      sleepSyncMs(delays[attempt]!);
    }
  }
}

/** Async `rename` with bounded Windows retry (`50/100/150/200/250 ms` on `EPERM/EACCES/EBUSY`). */
export async function renameWithWindowsRetry(
  source: string,
  target: string,
  options?: {
    platform?: NodeJS.Platform;
    delaysMs?: readonly number[];
    renameImpl?: (src: string, dst: string) => Promise<void>;
  },
): Promise<void> {
  const platform = options?.platform ?? process.platform;
  const delays = platform === "win32" ? (options?.delaysMs ?? WIN_RENAME_RETRY_DELAYS_MS) : [];
  const doRename = options?.renameImpl ?? asyncRename;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await doRename(source, target);
      return;
    } catch (error) {
      if (attempt >= delays.length || !isRetryableRenameError(error)) {
        throw error;
      }
      await delay(delays[attempt]!);
    }
  }
}

/** Wraps `write-file-atomic` `.sync()` with bounded Windows lock retries on `EPERM/EACCES/EBUSY`. */
export function writeFileAtomicSyncWithRetry(
  targetPath: string,
  content: string,
  options?: {
    mode?: number;
    fsync?: boolean;
    platform?: NodeJS.Platform;
    delaysMs?: readonly number[];
    writeImpl?: (path: string, data: string, opts: { encoding: "utf8"; mode?: number; fsync?: boolean }) => void;
  },
): void {
  const platform = options?.platform ?? process.platform;
  const delays = platform === "win32" ? (options?.delaysMs ?? WIN_RENAME_RETRY_DELAYS_MS) : [];
  const doWrite =
    options?.writeImpl ??
    ((p, d, o) => {
      writeFileAtomic.sync(p, d, o);
    });
  for (let attempt = 0; ; attempt += 1) {
    try {
      doWrite(targetPath, content, {
        encoding: "utf8",
        ...(options?.fsync !== undefined ? { fsync: options.fsync } : {}),
        ...(options?.mode !== undefined ? { mode: options.mode } : {}),
      });
      return;
    } catch (error) {
      if (attempt >= delays.length || !isRetryableRenameError(error)) {
        throw error;
      }
      sleepSyncMs(delays[attempt]!);
    }
  }
}

export function isTransientWindowsDeleteError(error: unknown, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32" || typeof error !== "object" || error === null) return false;
  const code = "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
  if (code && ["EBUSY", "ENOTEMPTY", "EPERM"].includes(code)) return true;
  const message = "message" in error && typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : "";
  return /directory not empty|resource busy|operation not permitted/i.test(message);
}

type AsyncRmFn = (path: string, options: RmOptions) => Promise<void>;

/**
 * Whole-pass recursive directory delete with bounded Windows lock retries (`250/500/1000/2000 ms`).
 * Never passes `maxRetries` to async `fs.rm` (which multiplies retries at every directory level).
 * On final Windows failure, queries Restart Manager (`who-locks`) and appends locking process details.
 */
export async function removeTreeWithRetry(
  targetPath: string,
  options?: {
    rm?: AsyncRmFn;
    signal?: AbortSignal;
    platform?: NodeJS.Platform;
    passDelaysMs?: readonly number[];
    whoLocks?: (path: string) => string;
  },
): Promise<void> {
  const platform = options?.platform ?? process.platform;
  const rmFn = options?.rm ?? nodeAsyncRm;
  const passDelays = platform === "win32" ? (options?.passDelaysMs ?? WIN_REMOVE_PASS_DELAYS_MS) : [];
  const effectivePath = toWin32NamespacedPath(targetPath, platform);

  for (let attempt = 0; ; attempt += 1) {
    options?.signal?.throwIfAborted();
    try {
      await rmFn(effectivePath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= passDelays.length || !isTransientWindowsDeleteError(error, platform)) {
        if (platform === "win32") {
          const lockSummary =
            options?.whoLocks !== undefined
              ? options.whoLocks(targetPath)
              : formatWin32LockHolders(queryWin32WhoLocks(targetPath));
          if (lockSummary !== "" && error instanceof Error) {
            error.message = `${error.message}（占用进程：${lockSummary}）`;
          }
        }
        throw error;
      }
    }
    await delay(passDelays[attempt]!, undefined, { signal: options?.signal });
  }
}

export interface ManagedSkillCopyMeta {
  version: 1;
  canonicalPath: string;
  contentHash: string;
}

/** Computes a deterministic content digest of all files inside a skill directory (excluding `.fusa-managed`). */
export function hashDirectoryContents(dirPath: string): string {
  const hash = createHash("sha256");
  const walk = (cur: string, relPrefix: string) => {
    const entries = readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === FUSA_MANAGED_COPY_MARKER) continue;
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const full = join(cur, entry.name);
      if (entry.isDirectory()) {
        hash.update(`D:${rel}\0`);
        walk(full, rel);
      } else if (entry.isFile()) {
        hash.update(`F:${rel}\0`);
        hash.update(readFileSync(full));
        hash.update("\0");
      }
    }
  };
  if (existsSync(dirPath)) {
    walk(dirPath, "");
  }
  return hash.digest("hex");
}

export function readManagedSkillCopyMeta(entryPath: string): ManagedSkillCopyMeta | null {
  const markerPath = join(entryPath, FUSA_MANAGED_COPY_MARKER);
  try {
    const raw = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<ManagedSkillCopyMeta>;
    if (
      raw.version === 1 &&
      typeof raw.canonicalPath === "string" &&
      typeof raw.contentHash === "string"
    ) {
      return { version: 1, canonicalPath: raw.canonicalPath, contentHash: raw.contentHash };
    }
    return null;
  } catch {
    return null;
  }
}

/** Removes an existing symlink or Windows junction reparse point WITHOUT deleting target directory contents. */
export function unlinkDirectoryLinkSync(linkPath: string): void {
  try {
    unlinkSync(linkPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    try {
      rmdirSync(linkPath);
    } catch (rmErr) {
      if ((rmErr as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

/**
 * Creates a directory link:
 * - POSIX: `symlinkSync(targetValue, linkPath, "dir")` (preserving relative `targetValue` when given);
 * - Windows: resolves `targetValue` to an absolute path and creates an NTFS `"junction"` (requires neither admin nor Developer Mode);
 * - Windows UNC / network share target (where NTFS junctions are unsupported): falls back to a managed copy with `.fusa-managed`.
 */
export function createDirectoryLinkOrManagedCopySync(
  targetValue: string,
  linkPath: string,
  options?: { platform?: NodeJS.Platform },
): "symlink" | "junction" | "managed_copy" {
  const platform = options?.platform ?? process.platform;
  mkdirSync(dirname(linkPath), { recursive: true });

  if (platform !== "win32") {
    symlinkSync(targetValue, linkPath, "dir");
    return "symlink";
  }

  const absTarget = resolve(dirname(linkPath), targetValue);
  if (!isUncNetworkPath(absTarget)) {
    try {
      symlinkSync(absTarget, linkPath, "junction");
      return "junction";
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EXDEV" && code !== "EINVAL" && code !== "ENOTSUP") {
        throw err;
      }
    }
  }

  rmSync(linkPath, { recursive: true, force: true });
  cpSync(absTarget, linkPath, { recursive: true });
  const meta: ManagedSkillCopyMeta = {
    version: 1,
    canonicalPath: absTarget,
    contentHash: hashDirectoryContents(absTarget),
  };
  writeFileSync(join(linkPath, FUSA_MANAGED_COPY_MARKER), `${JSON.stringify(meta, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return "managed_copy";
}
