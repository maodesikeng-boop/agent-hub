// Invariant: every allocated session temp directory is a realpath-resolved 0700 directory under the OS temp root named with this data directory's owner prefix, persisted in state/session-tmp.json so crashes cannot orphan it, and sweeps never touch directories without that prefix.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import type { SessionId } from "../shared/domain.ts";
import { ENV_SESSION_OWNER_TAG, SESSION_TMP_DIR_PREFIX, SESSION_TMP_ORPHAN_RETENTION_MS } from "../shared/limits.ts";
import { LOG_PREFIX } from "../shared/names.ts";
import { isPathInsideOrEqual, makeSessionOwnerTag, removeTreeWithRetry } from "./platform/index.ts";
import type { Db } from "./store/index.ts";

export interface SessionTmpEntry {
  readonly sessionId: SessionId;
  readonly path: string;
  readonly createdAt: number;
}

export interface SessionTmpStoreOptions {
  readonly ledgerFile: string;
  readonly tmpRoot?: string;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export interface SessionTmpSweepResult {
  readonly removedPaths: readonly string[];
  readonly failedPaths: readonly string[];
}

export interface SessionTmpStore {
  /** Directory-name prefix (SESSION_TMP_DIR_PREFIX plus the data directory's owner id) shared by every temp dir this store creates. */
  readonly ownerPrefix: string;

  /**
   * Precondition: sessionId is a positive integer.
   * Postcondition: returns the existing directory for sessionId if still valid on disk, or creates a new 0700 directory under shortOsTmpRoot() and persists it atomically.
   */
  allocate(sessionId: SessionId): string;

  /**
   * Precondition: sessionId is a positive integer.
   * Postcondition: returns the tracked realpath for sessionId or null when none is recorded.
   */
  get(sessionId: SessionId): string | null;

  /**
   * Precondition: the session's processes have exited or been reaped.
   * Postcondition: removes the tracked directory using removeTreeWithRetry and removes its ledger entry; ignores missing directories.
   */
  remove(sessionId: SessionId, signal?: AbortSignal): Promise<boolean>;

  /**
   * Precondition: activeSessionIds contains every currently live session id.
   * Postcondition: removes tracked directories for non-active sessions and stale untracked directories carrying ownerPrefix older than SESSION_TMP_ORPHAN_RETENTION_MS; directories of other data directories or other tools are never touched.
   */
  sweepOrphans(activeSessionIds: ReadonlySet<SessionId>, signal?: AbortSignal): Promise<SessionTmpSweepResult>;

  /**
   * Precondition: none.
   * Postcondition: returns all tracked session temp directory entries currently recorded in the ledger file.
   */
  listTracked(): SessionTmpEntry[];

  /**
   * Precondition: path is absolute.
   * Postcondition: true when path is inside a temp dir carrying ownerPrefix, tracked or not, even after the directory itself is gone.
   */
  isSessionTmpPath(path: string): boolean;
}

const SHORT_TMP_MAX_BYTES = 40;
const OWNER_ID_HEX_CHARS = 10;

function realpathOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * Precondition: none.
 * Postcondition: returns a realpath-resolved temp root short enough for macOS Unix socket path limits (preferring /tmp when os.tmpdir() exceeds 40 bytes and /tmp exists, or os.tmpdir() on Windows).
 */
export function shortOsTmpRoot(options?: { platform?: NodeJS.Platform; osTmpDir?: string }): string {
  const platform = options?.platform ?? process.platform;
  const raw = options?.osTmpDir ?? tmpdir();
  if (platform === "win32") return realpathOrSelf(raw);
  if (Buffer.byteLength(raw) > SHORT_TMP_MAX_BYTES && existsSync("/tmp")) {
    return realpathOrSelf("/tmp");
  }
  return realpathOrSelf(raw);
}

function isValidEntry(value: unknown): value is SessionTmpEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    Number.isInteger(e.sessionId) &&
    (e.sessionId as number) > 0 &&
    typeof e.path === "string" &&
    e.path !== "" &&
    typeof e.createdAt === "number" &&
    Number.isFinite(e.createdAt)
  );
}

function readEntries(file: string): Map<SessionId, SessionTmpEntry> {
  const map = new Map<SessionId, SessionTmpEntry>();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return map;
    for (const item of parsed.entries) {
      if (isValidEntry(item)) map.set(item.sessionId, item);
    }
  } catch {
  }
  return map;
}

/**
 * Precondition: stateDir is this daemon's state directory.
 * Postcondition: returns a short stable id derived from its real path, so every daemon on the account names its temp dirs and process tags differently and a restart keeps the same id.
 */
export function dataDirOwnerId(stateDir: string): string {
  return createHash("sha256").update(realpathOrSelf(stateDir)).digest("hex").slice(0, OWNER_ID_HEX_CHARS);
}

function isExistingManagedDir(dir: string, tmpRoot: string, ownerPrefix: string): boolean {
  if (!isPathInsideOrEqual(tmpRoot, dir) || dir === tmpRoot) return false;
  if (!basename(dir).startsWith(ownerPrefix)) return false;
  try {
    return lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Precondition: options.ledgerFile points inside the daemon state directory.
 * Postcondition: returns a SessionTmpStore backed by options.ledgerFile.
 */
export function createSessionTmpStore(options: SessionTmpStoreOptions): SessionTmpStore {
  const { ledgerFile, now = Date.now, log = () => {} } = options;
  const tmpRoot = realpathOrSelf(options.tmpRoot ?? shortOsTmpRoot());
  const ownerPrefix = `${SESSION_TMP_DIR_PREFIX}${dataDirOwnerId(dirname(ledgerFile))}-`;
  const entries = readEntries(ledgerFile);

  const persist = () => {
    const tmp = `${ledgerFile}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(ledgerFile), { recursive: true, mode: 0o700 });
      writeFileSync(tmp, JSON.stringify({ version: 1, entries: [...entries.values()] }), { mode: 0o600 });
      renameSync(tmp, ledgerFile);
    } catch (error) {
      rmSync(tmp, { force: true });
      log(`${LOG_PREFIX} 会话临时目录账本写不进 ${ledgerFile}：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return {
    ownerPrefix,

    allocate(sessionId) {
      if (!Number.isInteger(sessionId) || sessionId <= 0) {
        throw new Error(`Invalid sessionId for temp dir allocation: ${sessionId}`);
      }
      const existing = entries.get(sessionId);
      if (existing !== undefined && isExistingManagedDir(existing.path, tmpRoot, ownerPrefix)) {
        return existing.path;
      }
      mkdirSync(tmpRoot, { recursive: true });
      const created = mkdtempSync(join(tmpRoot, ownerPrefix));
      if (process.platform !== "win32") {
        try {
          chmodSync(created, 0o700);
        } catch {
        }
      }
      const real = realpathOrSelf(created);
      entries.set(sessionId, { sessionId, path: real, createdAt: now() });
      persist();
      return real;
    },

    get(sessionId) {
      return entries.get(sessionId)?.path ?? null;
    },

    async remove(sessionId, signal) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return false;
      try {
        if (existsSync(entry.path)) await removeTreeWithRetry(entry.path, { signal });
        entries.delete(sessionId);
        persist();
        return true;
      } catch (error) {
        log(`${LOG_PREFIX} 清理会话 ${sessionId} 临时目录失败（${entry.path}）：${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    },

    async sweepOrphans(activeSessionIds, signal) {
      const removedPaths: string[] = [];
      const failedPaths: string[] = [];
      const activePaths = new Set<string>();
      for (const [sid, entry] of [...entries]) {
        if (activeSessionIds.has(sid)) {
          activePaths.add(entry.path);
          continue;
        }
        try {
          const existed = existsSync(entry.path);
          if (existed) await removeTreeWithRetry(entry.path, { signal });
          entries.delete(sid);
          if (existed) removedPaths.push(entry.path);
        } catch {
          failedPaths.push(entry.path);
        }
      }
      persist();

      const cutoff = now() - SESSION_TMP_ORPHAN_RETENTION_MS;
      const ownUid = process.getuid?.();
      let names: string[];
      try {
        names = readdirSync(tmpRoot);
      } catch {
        return { removedPaths, failedPaths };
      }
      for (const name of names) {
        if (!name.startsWith(ownerPrefix)) continue;
        const candidate = join(tmpRoot, name);
        if (activePaths.has(candidate)) continue;
        let st;
        try {
          st = lstatSync(candidate);
        } catch {
          continue;
        }
        if (!st.isDirectory()) continue;
        if (ownUid !== undefined && st.uid !== ownUid) continue;
        if (st.mtimeMs > cutoff) continue;
        try {
          await removeTreeWithRetry(candidate, { signal });
          removedPaths.push(candidate);
        } catch {
          failedPaths.push(candidate);
        }
      }
      return { removedPaths, failedPaths };
    },

    listTracked() {
      return [...entries.values()];
    },

    isSessionTmpPath(path) {
      if (!isPathInsideOrEqual(tmpRoot, path) || path === tmpRoot) return false;
      const rel = relative(tmpRoot, path);
      return rel.split(sep, 1)[0]!.startsWith(ownerPrefix);
    },
  };
}

export interface DaemonSessionScope {
  readonly tmp: SessionTmpStore;
  readonly tagNonce: string;
  readonly parentTag: string | undefined;
  ownerTag(sessionId: SessionId): string;
  ownerEnv(sessionId: SessionId): string;
  sweepStartupOrphans(db: Db): Promise<SessionTmpSweepResult>;
}

export function createDaemonSessionScope(options: {
  ledgerFile: string;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}): DaemonSessionScope {
  const tmp = createSessionTmpStore({ ledgerFile: options.ledgerFile, log: options.log });
  // Stable across restarts so descendants tagged before a self-reload are still found when their session ends.
  const tagNonce = dataDirOwnerId(dirname(options.ledgerFile));
  const parentTag = (options.env ?? process.env)[ENV_SESSION_OWNER_TAG];
  return {
    tmp,
    tagNonce,
    parentTag,
    ownerTag: (sessionId) => `s${sessionId}:${tagNonce}`,
    ownerEnv: (sessionId) => makeSessionOwnerTag(sessionId, tagNonce, parentTag),
    sweepStartupOrphans: (db) => {
      const active = new Set(
        db.all<{ id: number }>("SELECT id FROM agent_sessions WHERE status != 'ended' OR pid IS NOT NULL").map((r) => r.id),
      );
      return tmp.sweepOrphans(active);
    },
  };
}
