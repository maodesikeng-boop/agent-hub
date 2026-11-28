import { lstatSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { MAX_DB_BACKUPS } from "../../shared/limits.ts";

export interface MigrationBackupAnchor {
  readonly fromVersion: number;
  readonly lastVersion: number;
  readonly pendingVersion?: number;
  readonly backupFile: string;
}

export type MigrationBackupPlan =
  | { readonly action: "reuse"; readonly backupFile: string }
  | { readonly action: "create"; readonly replaceSameVersionBackup?: string };

interface ParsedBackupEntry {
  readonly fullPath: string;
  readonly version: number;
  readonly timestamp: string;
  readonly seq: number;
}

const BACKUP_SUFFIX_RE = /^(\d+)-(\d{8}T\d{6}Z)(?:-(\d+))?$/;
const ANCHOR_FILE_MODE = 0o600;

function parseBackupEntry(dbFile: string, name: string): ParsedBackupEntry | null {
  const dbName = basename(dbFile);
  const prefix = `${dbName}.bak-`;
  if (!name.startsWith(prefix)) return null;
  const match = BACKUP_SUFFIX_RE.exec(name.slice(prefix.length));
  if (match === null) return null;
  const version = Number(match[1]);
  const seq = match[3] === undefined ? 1 : Number(match[3]);
  if (!Number.isSafeInteger(version) || !Number.isSafeInteger(seq)) return null;
  return {
    fullPath: join(dirname(dbFile), name),
    version,
    timestamp: match[2]!,
    seq,
  };
}

function canonicalDir(dir: string): string {
  const resolved = resolve(dir);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function canonicalFilePath(filePath: string): string {
  const resolved = resolve(filePath);
  return join(canonicalDir(dirname(resolved)), basename(resolved));
}

function validateBackupPathInDbDir(dbFile: string, candidate: string): ParsedBackupEntry | null {
  if (candidate === "") return null;
  const dbDir = canonicalDir(dirname(dbFile));
  const resolvedCandidate = resolve(candidate);
  if (canonicalDir(dirname(resolvedCandidate)) !== dbDir) return null;
  const entry = parseBackupEntry(dbFile, basename(resolvedCandidate));
  if (entry === null) return null;
  try {
    if (!lstatSync(entry.fullPath).isFile()) return null;
  } catch {
    return null;
  }
  return entry;
}

function compareBackupAge(a: ParsedBackupEntry, b: ParsedBackupEntry): number {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
  return a.seq - b.seq;
}

/**
 * Precondition: dbFile is the absolute path to the main SQLite database file.
 * Postcondition: returns the path of the migration anchor sidecar file adjacent to dbFile.
 */
export function migrationAnchorPath(dbFile: string): string {
  return `${dbFile}.migrating`;
}

/**
 * Precondition: dbFile is the path to the main SQLite database file.
 * Postcondition: returns the validated MigrationBackupAnchor when the sidecar exists, parses cleanly, and references a backup file inside dirname(dbFile); returns null when absent, corrupt, or escaping dirname(dbFile).
 */
export function readMigrationAnchor(dbFile: string): MigrationBackupAnchor | null {
  let rawText: string;
  try {
    rawText = readFileSync(migrationAnchorPath(dbFile), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const fromVersion = record.fromVersion;
  const lastVersion = record.lastVersion;
  const pendingVersion = record.pendingVersion;
  const backupFile = record.backupFile;
  if (
    typeof fromVersion !== "number" ||
    !Number.isInteger(fromVersion) ||
    fromVersion <= 0 ||
    typeof lastVersion !== "number" ||
    !Number.isInteger(lastVersion) ||
    lastVersion < fromVersion ||
    (pendingVersion !== undefined &&
      (typeof pendingVersion !== "number" || !Number.isInteger(pendingVersion) || pendingVersion <= lastVersion)) ||
    typeof backupFile !== "string"
  ) {
    return null;
  }
  const entry = validateBackupPathInDbDir(dbFile, backupFile);
  if (entry === null || entry.version !== fromVersion) return null;
  return {
    fromVersion,
    lastVersion,
    ...(pendingVersion !== undefined ? { pendingVersion } : {}),
    backupFile: entry.fullPath,
  };
}

/**
 * Precondition: dbFile is the path to the main SQLite database file and anchor.backupFile is a backup in dirname(dbFile).
 * Postcondition: atomically persists anchor to migrationAnchorPath(dbFile) with owner-only permissions on POSIX platforms.
 */
export function writeMigrationAnchor(dbFile: string, anchor: MigrationBackupAnchor): void {
  const payload = JSON.stringify({
    fromVersion: anchor.fromVersion,
    lastVersion: anchor.lastVersion,
    ...(anchor.pendingVersion !== undefined ? { pendingVersion: anchor.pendingVersion } : {}),
    backupFile: anchor.backupFile,
  });
  const anchorPath = migrationAnchorPath(dbFile);
  const tmpPath = `${anchorPath}.tmp-${process.pid}`;
  try {
    writeFileSync(tmpPath, payload, { encoding: "utf8", mode: ANCHOR_FILE_MODE });
    renameSync(tmpPath, anchorPath);
  } catch (error) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
    }
    throw error;
  }
}

/**
 * Precondition: dbFile is the path to the main SQLite database file.
 * Postcondition: removes migrationAnchorPath(dbFile) if present and does not throw when absent.
 */
export function clearMigrationAnchor(dbFile: string): void {
  try {
    rmSync(migrationAnchorPath(dbFile), { force: true });
  } catch {
  }
}

/**
 * Precondition: dbFile is the path to the main SQLite database file and fromVersion is a positive integer user_version.
 * Postcondition: reuses anchor.backupFile when anchor exists on disk, fromVersion > anchor.fromVersion, and fromVersion matches anchor.lastVersion or anchor.pendingVersion; requests a fresh backup replacing the superseded same-version backup when fromVersion === anchor.fromVersion && anchor.lastVersion === anchor.fromVersion; otherwise requests a fresh backup without deleting existing backups.
 */
export function planMigrationBackup(
  dbFile: string,
  fromVersion: number,
  anchor: MigrationBackupAnchor | null,
): MigrationBackupPlan {
  if (anchor === null) return { action: "create" };
  const entry = validateBackupPathInDbDir(dbFile, anchor.backupFile);
  if (entry === null || entry.version !== anchor.fromVersion) return { action: "create" };
  const matchesCommittedProgress =
    fromVersion === anchor.lastVersion ||
    (anchor.pendingVersion !== undefined && fromVersion === anchor.pendingVersion);
  if (fromVersion > anchor.fromVersion && matchesCommittedProgress) {
    return { action: "reuse", backupFile: entry.fullPath };
  }
  if (fromVersion === anchor.fromVersion && anchor.lastVersion === anchor.fromVersion) {
    return { action: "create", replaceSameVersionBackup: entry.fullPath };
  }
  return { action: "create" };
}

/**
 * Precondition: dbFile is the absolute path to the main SQLite database file.
 * Postcondition: returns the fixed staging file path adjacent to dbFile used during VACUUM INTO before atomic publish.
 */
export function backupStagingPath(dbFile: string): string {
  return `${dbFile}.backup-tmp`;
}

/**
 * Precondition: dbFile is the absolute path to the main SQLite database file.
 * Postcondition: removes any leftover staging file adjacent to dbFile without throwing when absent.
 */
export function clearBackupStaging(dbFile: string): void {
  try {
    rmSync(backupStagingPath(dbFile), { force: true });
  } catch {
  }
}

/**
 * Precondition: dbFile is the path to the main SQLite database file and version is a positive integer.
 * Postcondition: removes duplicate backups of the same source version while leaving keep (if given), any anchored rollback backup (unless explicitly named in allowDelete), and all other schema versions untouched.
 */
export function pruneSameVersionBackups(dbFile: string, version: number, keep?: string, allowDelete?: string): void {
  const dir = dirname(dbFile);
  const keepCanonical = keep !== undefined ? canonicalFilePath(keep) : undefined;
  const allowDeleteCanonical = allowDelete !== undefined ? canonicalFilePath(allowDelete) : undefined;
  const anchor = readMigrationAnchor(dbFile);
  const anchorCanonical = anchor !== null ? canonicalFilePath(anchor.backupFile) : undefined;
  for (const name of readdirSync(dir)) {
    const entry = parseBackupEntry(dbFile, name);
    if (entry === null || entry.version !== version) continue;
    const entryCanonical = canonicalFilePath(entry.fullPath);
    if (keepCanonical !== undefined && entryCanonical === keepCanonical) continue;
    if (entryCanonical === anchorCanonical && entryCanonical !== allowDeleteCanonical) continue;
    try {
      rmSync(entry.fullPath, { force: true });
    } catch {
    }
  }
}

function listBackups(dbFile: string): ParsedBackupEntry[] {
  return readdirSync(dirname(dbFile)).flatMap((name) => {
    const entry = parseBackupEntry(dbFile, name);
    return entry === null ? [] : [entry];
  }).sort(compareBackupAge);
}

function backupRemovalOrder(backups: readonly ParsedBackupEntry[], keep: ReadonlySet<string>): ParsedBackupEntry[] {
  const retainedVersions = new Set(backups.filter((entry) => keep.has(entry.fullPath)).map((entry) => entry.version));
  const duplicates: ParsedBackupEntry[] = [];
  const distinct: ParsedBackupEntry[] = [];
  for (const entry of [...backups].reverse()) {
    if (keep.has(entry.fullPath)) continue;
    if (retainedVersions.has(entry.version)) duplicates.push(entry);
    else distinct.push(entry);
    retainedVersions.add(entry.version);
  }
  return [...duplicates.reverse(), ...distinct.reverse()];
}

export function prepareBackupPublication(dbFile: string, version: number, replaceAnchored?: string): string | undefined {
  rmSync(backupStagingPath(dbFile), { force: true });
  const backups = listBackups(dbFile);
  const anchor = readMigrationAnchor(dbFile);
  const keep = new Set(anchor === null ? [] : [anchor.backupFile]);
  const sameVersion = backups.findLast((entry) =>
    entry.version === version && !keep.has(entry.fullPath) && validateBackupPathInDbDir(dbFile, entry.fullPath) !== null,
  );
  const excess = backups.length - MAX_DB_BACKUPS;
  let replacement = sameVersion?.fullPath;
  if (excess > 0) {
    const olderVersions = new Set(backups
      .filter((entry) => entry.version < version && validateBackupPathInDbDir(dbFile, entry.fullPath) !== null)
      .map((entry) => entry.version));
    // An interrupted publish can leave an extra unanchored snapshot alongside two historical rollbacks.
    const retireInterrupted = olderVersions.size >= MAX_DB_BACKUPS;
    if (!retireInterrupted && replacement !== undefined && anchor?.fromVersion !== version) keep.add(replacement);
    const order = backupRemovalOrder(backups, keep);
    const candidates = retireInterrupted
      ? [...order.filter((entry) => entry.version === version), ...order.filter((entry) => entry.version !== version)]
      : order;
    for (const entry of candidates.slice(0, excess)) {
      rmSync(entry.fullPath, { force: true });
      if (entry.fullPath === replacement) replacement = undefined;
    }
  }
  if (anchor !== null && anchor.backupFile === replaceAnchored && anchor.fromVersion === version) return anchor.backupFile;
  return replacement;
}

export function pruneDatabaseBackups(dbFile: string, keep: string | undefined, maxBackups: number): void {
  const backups = listBackups(dbFile);
  const excess = backups.length - maxBackups;
  if (excess <= 0) return;
  const keptEntry = keep === undefined ? null : validateBackupPathInDbDir(dbFile, keep);
  const protectedPaths = new Set(keptEntry === null ? [] : [keptEntry.fullPath]);
  const anchor = readMigrationAnchor(dbFile);
  if (anchor !== null) protectedPaths.add(anchor.backupFile);
  for (const entry of backupRemovalOrder(backups, protectedPaths).slice(0, excess)) {
    try {
      rmSync(entry.fullPath, { force: true });
    } catch {
    }
  }
}
