// Invariant: every allocated session temp directory is a realpath-resolved 0700 directory under the OS temp root prefixed with SESSION_TMP_DIR_PREFIX, persisted in state/session-tmp.json so crashes cannot orphan it.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
   * Postcondition: removes tracked directories for non-active sessions and stale unmanaged SESSION_TMP_DIR_PREFIX directories older than SESSION_TMP_ORPHAN_RETENTION_MS.
   */
  sweepOrphans(activeSessionIds: ReadonlySet<SessionId>, signal?: AbortSignal): Promise<SessionTmpSweepResult>;

  /**
   * Precondition: none.
   * Postcondition: returns all tracked session temp directory entries currently recorded in the ledger file.
   */
  listTracked(): SessionTmpEntry[];
}

const SHORT_TMP_MAX_BYTES = 40;

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

/** Bind the session temp dir onto /tmp inside Linux bwrap unless a required mount already lives under /tmp. */
export function bwrapTmpBindArgs(
  tmpDir: string | undefined,
  otherPaths: readonly (string | undefined)[],
  real: (p: string) => string,
  exists: (p: string) => boolean,
): string[] {
  if (!tmpDir) return [];
  const targetTmp = real(tmpDir);
  if (!exists(targetTmp)) return [];
  const tmpRoot = real("/tmp");
  const underTmp = (p: string) => p === "/tmp" || p.startsWith("/tmp/") || p === tmpRoot || p.startsWith(`${tmpRoot}/`);
  const conflict = otherPaths.some((raw) => {
    if (!raw) return false;
    const resolved = real(raw);
    return resolved !== targetTmp && underTmp(resolved);
  });
  if (conflict) return ["--bind", targetTmp, targetTmp];
  return ["--bind", targetTmp, "/tmp", "--setenv", "TMPDIR", "/tmp", "--setenv", "TEMP", "/tmp", "--setenv", "TMP", "/tmp"];
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

function isExistingManagedDir(dir: string, tmpRoot: string): boolean {
  if (!isPathInsideOrEqual(tmpRoot, dir) || dir === tmpRoot) return false;
  if (!basename(dir).startsWith(SESSION_TMP_DIR_PREFIX)) return false;
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
    allocate(sessionId) {
      if (!Number.isInteger(sessionId) || sessionId <= 0) {
        throw new Error(`Invalid sessionId for temp dir allocation: ${sessionId}`);
      }
      const existing = entries.get(sessionId);
      if (existing !== undefined && isExistingManagedDir(existing.path, tmpRoot)) {
        return existing.path;
      }
      mkdirSync(tmpRoot, { recursive: true });
      const created = mkdtempSync(join(tmpRoot, SESSION_TMP_DIR_PREFIX));
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
        if (!name.startsWith(SESSION_TMP_DIR_PREFIX)) continue;
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
  const tagNonce = randomBytes(6).toString("hex");
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
