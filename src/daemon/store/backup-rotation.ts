// Invariant: pre-upgrade rollback backups survive repeated failed migration restarts, backup count stays bounded under crash loops, and rotation only evicts old versions after a migration or rebuild finishes.
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

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
  readonly name: string;
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
    name,
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
    if (lstatSync(entry.fullPath).isSymbolicLink()) return null;
  } catch {
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
  if (entry === null || !existsSync(entry.fullPath)) return { action: "create" };
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

/**
 * Precondition: dbFile is the path to the main SQLite database file and maxBackups is a positive integer.
 * Postcondition: prunes recognized `<dbName>.bak-<version>-<timestamp>[-<n>]` files in dirname(dbFile) down to at most maxBackups files, never deleting keep or unrecognized files, and evicting older duplicate backups of the same source version before evicting older distinct versions.
 */
export function pruneDatabaseBackups(dbFile: string, keep: string | undefined, maxBackups: number): void {
  const dir = dirname(dbFile);
  const backups: ParsedBackupEntry[] = [];
  for (const name of readdirSync(dir)) {
    const entry = parseBackupEntry(dbFile, name);
    if (entry !== null) backups.push(entry);
  }
  const excess = backups.length - maxBackups;
  if (excess <= 0) return;

  backups.sort(compareBackupAge);
  const keepCanonical = keep !== undefined ? canonicalFilePath(keep) : undefined;
  const byVersion = new Map<number, ParsedBackupEntry[]>();
  for (const entry of backups) {
    const group = byVersion.get(entry.version);
    if (group === undefined) byVersion.set(entry.version, [entry]);
    else group.push(entry);
  }

  const versionSurvivors = new Set<string>();
  for (const group of byVersion.values()) {
    const keptInGroup = group.find((item) => keepCanonical !== undefined && canonicalFilePath(item.fullPath) === keepCanonical);
    const survivor = keptInGroup ?? group[group.length - 1]!;
    versionSurvivors.add(canonicalFilePath(survivor.fullPath));
  }

  const duplicates: ParsedBackupEntry[] = [];
  const distinctOld: ParsedBackupEntry[] = [];
  for (const entry of backups) {
    const canonical = canonicalFilePath(entry.fullPath);
    if (keepCanonical !== undefined && canonical === keepCanonical) continue;
    if (versionSurvivors.has(canonical)) distinctOld.push(entry);
    else duplicates.push(entry);
  }

  const toDelete = [...duplicates, ...distinctOld].slice(0, excess);
  for (const entry of toDelete) {
    try {
      rmSync(entry.fullPath, { force: true });
    } catch {
    }
  }
}
