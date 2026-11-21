import { mkdirSync } from "node:fs";
import type { HubPaths } from "../../shared/paths.ts";
import { StartupError } from "../startup-error.ts";
import { openDatabase } from "./db.ts";
import type { Db } from "./db.ts";
import { ensureIncrementalVacuum } from "./maintenance.ts";
import type { EnsureIncrementalResult } from "./maintenance.ts";
import { DEFAULT_MIGRATIONS_DIR, migrate } from "./migrate.ts";
import type { MigrationResult } from "./migrate.ts";

const SQLITE_BUSY = 5;

function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number" && (code & 0xff) === SQLITE_BUSY;
}

export interface OpenStoreOptions {
  migrationsDir?: string;
  /** Lets other processes open the ledger while the daemon runs (end-to-end tests, live inspection); their write locks then stall the daemon. */
  sharedAccess?: boolean;
}

export interface OpenedStore {
  db: Db;
  migration: MigrationResult;
  autoVacuum: EnsureIncrementalResult;
}

export function openStore(paths: Pick<HubPaths, "stateDir" | "dbFile">, options: OpenStoreOptions = {}): OpenedStore {
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  let db: Db;
  try {
    db = openDatabase(paths.dbFile, { exclusive: options.sharedAccess !== true });
  } catch (error) {
    if (isBusy(error)) throw new StartupError("ledger_locked", paths.dbFile, { cause: error });
    throw error;
  }
  try {
    const migration = migrate(db, options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
    const autoVacuum = ensureIncrementalVacuum(db, { backup: migration.backupFile === undefined });
    return { db, migration, autoVacuum };
  } catch (error) {
    db.close();
    throw error;
  }
}
