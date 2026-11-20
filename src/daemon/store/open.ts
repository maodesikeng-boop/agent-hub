import { mkdirSync } from "node:fs";
import type { HubPaths } from "../../shared/paths.ts";
import { openDatabase } from "./db.ts";
import type { Db } from "./db.ts";
import { ensureIncrementalVacuum } from "./maintenance.ts";
import type { EnsureIncrementalResult } from "./maintenance.ts";
import { DEFAULT_MIGRATIONS_DIR, migrate } from "./migrate.ts";
import type { MigrationResult } from "./migrate.ts";

export interface OpenStoreOptions {
  migrationsDir?: string;
}

export interface OpenedStore {
  db: Db;
  migration: MigrationResult;
  autoVacuum: EnsureIncrementalResult;
}

export function openStore(paths: Pick<HubPaths, "stateDir" | "dbFile">, options: OpenStoreOptions = {}): OpenedStore {
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  const db = openDatabase(paths.dbFile);
  try {
    const migration = migrate(db, options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
    const autoVacuum = ensureIncrementalVacuum(db, { backup: migration.backupFile === undefined });
    return { db, migration, autoVacuum };
  } catch (error) {
    db.close();
    throw error;
  }
}
