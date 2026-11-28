// Invariant: pre-upgrade rollback backups survive repeated failed migration restarts, backup count stays bounded under crash loops, and rotation only evicts old versions after a migration or rebuild finishes.

export interface MigrationBackupAnchor {
  readonly fromVersion: number;
  readonly lastVersion: number;
  readonly backupFile: string;
}

export type MigrationBackupPlan =
  | { readonly action: "reuse"; readonly backupFile: string }
  | { readonly action: "create"; readonly replaceSameVersionBackup?: string };

/**
 * Precondition: dbFile is the absolute path to the main SQLite database file.
 * Postcondition: returns the path of the migration anchor sidecar file adjacent to dbFile.
 */
export function migrationAnchorPath(_dbFile: string): string {
  throw new Error("Not implemented");
}

/**
 * Precondition: dbFile is the path to the main SQLite database file.
 * Postcondition: returns the validated MigrationBackupAnchor when the sidecar exists, parses cleanly, and references a backup file inside dirname(dbFile); returns null when absent, corrupt, or escaping dirname(dbFile).
 */
export function readMigrationAnchor(_dbFile: string): MigrationBackupAnchor | null {
  throw new Error("Not implemented");
}

/**
 * Precondition: dbFile is the path to the main SQLite database file and anchor.backupFile is a backup in dirname(dbFile).
 * Postcondition: persists anchor to migrationAnchorPath(dbFile) with owner-only permissions on POSIX platforms.
 */
export function writeMigrationAnchor(_dbFile: string, _anchor: MigrationBackupAnchor): void {
  throw new Error("Not implemented");
}

/**
 * Precondition: dbFile is the path to the main SQLite database file.
 * Postcondition: removes migrationAnchorPath(dbFile) if present and does not throw when absent.
 */
export function clearMigrationAnchor(_dbFile: string): void {
  throw new Error("Not implemented");
}

/**
 * Precondition: dbFile is the path to the main SQLite database file and fromVersion is a positive integer user_version.
 * Postcondition: reuses anchor.backupFile when anchor exists on disk and fromVersion > anchor.fromVersion and fromVersion === anchor.lastVersion; requests a fresh backup replacing the superseded same-version backup when anchor exists on disk and fromVersion === anchor.fromVersion && anchor.lastVersion === anchor.fromVersion; otherwise requests a fresh backup without deleting existing backups.
 */
export function planMigrationBackup(
  _dbFile: string,
  _fromVersion: number,
  _anchor: MigrationBackupAnchor | null,
): MigrationBackupPlan {
  throw new Error("Not implemented");
}

/**
 * Precondition: dbFile is the path to the main SQLite database file and maxBackups is a positive integer.
 * Postcondition: prunes recognized `<dbName>.bak-<version>-<timestamp>[-<n>]` files in dirname(dbFile) down to at most maxBackups files, never deleting keep or unrecognized files, and evicting older duplicate backups of the same source version before evicting older distinct versions.
 */
export function pruneDatabaseBackups(_dbFile: string, _keep: string | undefined, _maxBackups: number): void {
  throw new Error("Not implemented");
}
