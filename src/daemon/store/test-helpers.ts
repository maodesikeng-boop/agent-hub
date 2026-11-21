import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "./db.ts";
import type { Db } from "./db.ts";
import { MIGRATION_MANIFEST, migrate, migrationChecksum } from "./migrate.ts";

export function openTestDb(): Db {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

export function insertTestSession(db: Db, options: { conversationId?: number | null; createdAt?: number } = {}): number {
  const createdAt = options.createdAt ?? 0;
  return db.run(
    "INSERT INTO agent_sessions (role, conversation_id, vendor_session_id, cwd, created_at, updated_at) VALUES ('pm', ?, ?, '/tmp', ?, ?)",
    options.conversationId ?? null,
    randomUUID(),
    createdAt,
    createdAt,
  ).lastInsertRowid;
}

/** Rebuilds a scratch migrations directory's manifest from the SQL files it holds, as `shasum -a 256 *.sql` would. */
export function writeMigrationManifest(dir: string): void {
  const files = readdirSync(dir).filter((name) => /^\d+_.*\.sql$/.test(name)).sort();
  writeFileSync(join(dir, MIGRATION_MANIFEST), files.map((name) => `${migrationChecksum(readFileSync(join(dir, name)))}  ${name}\n`).join(""));
}

export function writeMigration(dir: string, file: string, sql: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), sql);
  writeMigrationManifest(dir);
}
