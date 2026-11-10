// 打开数据目录里的账本：建 state/（0700），开库，跑迁移。拿目录锁是另一步（lock.ts），由组装代码先做。
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
  /** 老库有没有在这次启动时重建成增量回收模式（maintenance.ts）。 */
  autoVacuum: EnsureIncrementalResult;
}

export function openStore(paths: Pick<HubPaths, "stateDir" | "dbFile">, options: OpenStoreOptions = {}): OpenedStore {
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  const db = openDatabase(paths.dbFile);
  try {
    const migration = migrate(db, options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
    // 老库改成增量回收要整库重建一次：这次启动刚升级过的，迁移已经备份了；新库一开始就是增量回收，用不着备份
    const autoVacuum = ensureIncrementalVacuum(db, { backup: migration.backupFile === undefined });
    return { db, migration, autoVacuum };
  } catch (error) {
    db.close();
    throw error;
  }
}
