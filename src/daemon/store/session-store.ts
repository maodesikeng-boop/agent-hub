// SessionStore：驱动层读写 agent_sessions 的一行。
import type { AgentSessionPatch, SessionStore } from "../../shared/store.ts";
import { EMPTY_TOKEN_USAGE } from "../../shared/domain.ts";
import type { AgentRole, AgentSessionRow, RateLimitInfo, SessionId, SessionStatus, TokenUsage } from "../../shared/domain.ts";
import type { Db, SqlValue } from "./db.ts";

export interface AgentSessionDbRow {
  id: number;
  role: string;
  conversation_id: number | null;
  pm_id: number | null;
  worker_id: number | null;
  vendor: string;
  vendor_session_id: string;
  cwd: string;
  add_dirs: string;
  generation: number;
  model: string | null;
  effort: string | null;
  pid: number | null;
  status: string;
  has_completed_turn: number;
  last_event_at: number | null;
  rate_limit: string | null;
  token_usage: string | null;
  created_at: number;
  updated_at: number;
}

export function toAgentSessionRow(row: AgentSessionDbRow): AgentSessionRow {
  return {
    id: row.id,
    role: row.role as AgentRole,
    conversationId: row.conversation_id,
    pmId: row.pm_id,
    workerId: row.worker_id,
    vendor: row.vendor,
    vendorSessionId: row.vendor_session_id,
    cwd: row.cwd,
    addDirs: JSON.parse(row.add_dirs) as string[],
    generation: row.generation,
    model: row.model,
    effort: row.effort,
    pid: row.pid,
    status: row.status as SessionStatus,
    hasCompletedTurn: row.has_completed_turn === 1,
    lastEventAt: row.last_event_at,
    rateLimit: row.rate_limit === null ? null : (JSON.parse(row.rate_limit) as RateLimitInfo),
    usage: row.token_usage === null ? { ...EMPTY_TOKEN_USAGE } : { ...EMPTY_TOKEN_USAGE, ...(JSON.parse(row.token_usage) as Partial<TokenUsage>) },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getAgentSession(db: Db, id: SessionId): AgentSessionRow | null {
  const row = db.get<AgentSessionDbRow>("SELECT * FROM agent_sessions WHERE id = ?", id);
  return row === undefined ? null : toAgentSessionRow(row);
}

const PATCH_COLUMNS: { [K in keyof Required<AgentSessionPatch>]: (value: AgentSessionPatch[K]) => [string, SqlValue] } = {
  pid: (v) => ["pid", v ?? null],
  status: (v) => ["status", v ?? null],
  hasCompletedTurn: (v) => ["has_completed_turn", v ? 1 : 0],
  lastEventAt: (v) => ["last_event_at", v ?? null],
  rateLimit: (v) => ["rate_limit", v == null ? null : JSON.stringify(v)],
  usage: (v) => ["token_usage", v == null ? null : JSON.stringify(v)],
};

export interface SessionStoreOptions {
  now?: () => number;
}

export function createSessionStore(db: Db, options: SessionStoreOptions = {}): SessionStore {
  const now = options.now ?? Date.now;
  return {
    get: (id) => getAgentSession(db, id),
    update(id, patch) {
      const sets: string[] = [];
      const values: SqlValue[] = [];
      for (const key of Object.keys(patch) as (keyof AgentSessionPatch)[]) {
        const toColumn = PATCH_COLUMNS[key] as ((v: unknown) => [string, SqlValue]) | undefined;
        if (toColumn === undefined || patch[key] === undefined) continue;
        const [column, value] = toColumn(patch[key]);
        sets.push(`${column} = ?`);
        values.push(value);
      }
      sets.push("updated_at = ?");
      values.push(now());
      const { changes } = db.run(`UPDATE agent_sessions SET ${sets.join(", ")} WHERE id = ?`, ...values, id);
      if (changes === 0) throw new Error(`agent session ${id} not found`);
      return getAgentSession(db, id)!;
    },
    listWithProcess() {
      return db.all<AgentSessionDbRow>("SELECT * FROM agent_sessions WHERE pid IS NOT NULL ORDER BY id").map(toAgentSessionRow);
    },
  };
}
