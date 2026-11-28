import type { AgentSessionPatch, SessionStore } from "../../shared/store.ts";
import { EMPTY_TOKEN_USAGE } from "../../shared/domain.ts";
import type { AgentRole, AgentSessionRow, RateLimitInfo, RateLimitWindow, SessionId, SessionStatus, TokenUsage } from "../../shared/domain.ts";
import { OBSERVED_QUOTA_FALLBACK_TTL_MS } from "../../shared/limits.ts";
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
  persona_revision?: number | null;
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
    personaRevision: row.persona_revision ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_SESSION = `SELECT s.*, p.revision AS persona_revision FROM agent_sessions s LEFT JOIN session_persona_seen p ON p.session_id = s.id`;

export function getAgentSession(db: Db, id: SessionId): AgentSessionRow | null {
  const row = db.get<AgentSessionDbRow>(`${SELECT_SESSION} WHERE s.id = ?`, id);
  return row === undefined ? null : toAgentSessionRow(row);
}

const PATCH_COLUMNS: { [K in Exclude<keyof Required<AgentSessionPatch>, "personaRevision">]: (value: AgentSessionPatch[K]) => [string, SqlValue] } = {
  vendorSessionId: (v) => ["vendor_session_id", v ?? ""],
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

function isValidRateLimitWindow(value: unknown): value is RateLimitWindow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const w = value as Record<string, unknown>;
  return (
    typeof w.utilization === "number" && Number.isFinite(w.utilization) &&
    typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt) &&
    typeof w.status === "string"
  );
}

function isWindowExhausted(w: RateLimitWindow): boolean {
  if (w.status === "rejected") return true;
  if (w.status === "allowed" || w.status === "allowed_warning") return false;
  return w.utilization >= 1;
}

function isWindowUnexpired(w: RateLimitWindow, parentResetsAt: number | null, prevUpdatedAt: number, nowMs: number): boolean {
  if (w.resetsAt > 0) return w.resetsAt * 1000 > nowMs;
  if (typeof parentResetsAt === "number" && Number.isFinite(parentResetsAt) && parentResetsAt > 0) {
    return parentResetsAt * 1000 > nowMs;
  }
  return prevUpdatedAt + OBSERVED_QUOTA_FALLBACK_TTL_MS > nowMs;
}

function parseStoredRateLimit(raw: string | null): RateLimitInfo | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as RateLimitInfo;
  } catch {
    return null;
  }
}

// Keep unexpired rejected windows that a partial rate_limit update omits so a restart never drops them.
function mergePersistedRateLimit(
  prev: RateLimitInfo | null,
  next: RateLimitInfo,
  nowMs: number,
  prevUpdatedAt: number,
): RateLimitInfo {
  if (prev === null) return next;
  const rawPrevWindows = prev.windows as unknown;
  if (typeof rawPrevWindows !== "object" || rawPrevWindows === null || Array.isArray(rawPrevWindows)) return next;
  const rawNextWindows = next.windows as unknown;
  const nextWindows: Record<string, RateLimitWindow> =
    typeof rawNextWindows === "object" && rawNextWindows !== null && !Array.isArray(rawNextWindows)
      ? { ...(rawNextWindows as Record<string, RateLimitWindow>) }
      : {};
  const carried: Array<[string, RateLimitWindow]> = [];
  for (const [key, value] of Object.entries(rawPrevWindows as Record<string, unknown>)) {
    if (Object.prototype.hasOwnProperty.call(nextWindows, key)) continue;
    if (!isValidRateLimitWindow(value) || !isWindowExhausted(value)) continue;
    if (!isWindowUnexpired(value, prev.resetsAt, prevUpdatedAt, nowMs)) continue;
    carried.push([key, value]);
  }
  if (carried.length === 0) return next;
  for (const [key, value] of carried) nextWindows[key] = value;
  const resets: number[] = [];
  for (const w of Object.values(nextWindows)) {
    if (isValidRateLimitWindow(w) && isWindowExhausted(w) && w.resetsAt > 0 && w.resetsAt * 1000 > nowMs) {
      resets.push(w.resetsAt);
    }
  }
  if (next.status === "rejected" && typeof next.resetsAt === "number" && Number.isFinite(next.resetsAt) && next.resetsAt * 1000 > nowMs) {
    resets.push(next.resetsAt);
  }
  if (resets.length === 0 && typeof prev.resetsAt === "number" && Number.isFinite(prev.resetsAt) && prev.resetsAt * 1000 > nowMs) {
    resets.push(prev.resetsAt);
  }
  return {
    ...next,
    status: "rejected",
    resetsAt: resets.length > 0 ? Math.max(...resets) : (prev.resetsAt ?? next.resetsAt),
    windows: nextWindows,
  };
}

export function createSessionStore(db: Db, options: SessionStoreOptions = {}): SessionStore {
  const now = options.now ?? Date.now;
  return {
    get: (id) => getAgentSession(db, id),
    update(id, patch) {
      const nowMs = now();
      let effectivePatch = patch;
      if (patch.rateLimit !== undefined && patch.rateLimit !== null) {
        const existing = db.get<{ rate_limit: string | null; updated_at: number }>(
          "SELECT rate_limit, updated_at FROM agent_sessions WHERE id = ?",
          id,
        );
        if (existing !== undefined) {
          const merged = mergePersistedRateLimit(parseStoredRateLimit(existing.rate_limit), patch.rateLimit, nowMs, existing.updated_at);
          if (merged !== patch.rateLimit) effectivePatch = { ...patch, rateLimit: merged };
        }
      }
      const sets: string[] = [];
      const values: SqlValue[] = [];
      for (const key of Object.keys(effectivePatch) as (keyof AgentSessionPatch)[]) {
        if (key === "personaRevision") continue;
        const toColumn = PATCH_COLUMNS[key] as ((v: unknown) => [string, SqlValue]) | undefined;
        if (toColumn === undefined || effectivePatch[key] === undefined) continue;
        const [column, value] = toColumn(effectivePatch[key]);
        sets.push(`${column} = ?`);
        values.push(value);
      }
      sets.push("updated_at = ?");
      values.push(nowMs);
      const { changes } = db.run(`UPDATE agent_sessions SET ${sets.join(", ")} WHERE id = ?`, ...values, id);
      if (changes === 0) throw new Error(`agent session ${id} not found`);
      if (effectivePatch.personaRevision != null) {
        db.run(
          "INSERT INTO session_persona_seen (session_id, revision) VALUES (?, ?) ON CONFLICT (session_id) DO UPDATE SET revision = excluded.revision",
          id,
          effectivePatch.personaRevision,
        );
      }
      return getAgentSession(db, id)!;
    },
    listWithProcess() {
      return db.all<AgentSessionDbRow>(`${SELECT_SESSION} WHERE s.pid IS NOT NULL ORDER BY s.id`).map(toAgentSessionRow);
    },
  };
}
