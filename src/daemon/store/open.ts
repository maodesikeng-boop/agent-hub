// 打开数据目录里的账本：建 state/（0700），开库，跑迁移。拿目录锁是另一步（lock.ts），由组装代码先做。
import { mkdirSync } from "node:fs";
import type { HubPaths } from "../../shared/paths.ts";
import { openDatabase } from "./db.ts";
import type { Db } from "./db.ts";
import { DEFAULT_MIGRATIONS_DIR, migrate } from "./migrate.ts";
import type { MigrationResult } from "./migrate.ts";

export interface OpenStoreOptions {
  migrationsDir?: string;
}

export interface OpenedStore {
  db: Db;
  migration: MigrationResult;
}

export function openStore(paths: Pick<HubPaths, "stateDir" | "dbFile">, options: OpenStoreOptions = {}): OpenedStore {
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  const db = openDatabase(paths.dbFile);
  try {
    return { db, migration: migrate(db, options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR) };
  } catch (error) {
    db.close();
    throw error;
  }
}
