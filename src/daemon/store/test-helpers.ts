// 测试用：内存库 + 迁移，和直接插一行会话。
import { randomUUID } from "node:crypto";
import { openDatabase } from "./db.ts";
import type { Db } from "./db.ts";
import { migrate } from "./migrate.ts";

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
