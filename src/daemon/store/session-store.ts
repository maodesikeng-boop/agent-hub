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

function validObservedAt(w: RateLimitWindow): number | null {
  return typeof w.observedAt === "number" && Number.isFinite(w.observedAt) && w.observedAt > 0 ? w.observedAt : null;
}

function isWindowUnexpired(w: RateLimitWindow, parentResetsAt: number | null, prevUpdatedAt: number, nowMs: number): boolean {
  if (w.resetsAt > 0) return w.resetsAt * 1000 > nowMs;
  if (typeof parentResetsAt === "number" && Number.isFinite(parentResetsAt) && parentResetsAt > 0) {
    return parentResetsAt * 1000 > nowMs;
  }
  return (validObservedAt(w) ?? prevUpdatedAt) + OBSERVED_QUOTA_FALLBACK_TTL_MS > nowMs;
}

function stampTimelessExhaustedWindows(info: RateLimitInfo, nowMs: number): RateLimitInfo {
  const rawWindows = info.windows as unknown;
  if (typeof rawWindows !== "object" || rawWindows === null || Array.isArray(rawWindows)) return info;
  let stamped: Record<string, RateLimitWindow> | null = null;
  for (const [key, value] of Object.entries(rawWindows as Record<string, unknown>)) {
    if (!isValidRateLimitWindow(value) || !isWindowExhausted(value) || value.resetsAt > 0 || validObservedAt(value) !== null) {
      continue;
    }
    stamped ??= { ...(rawWindows as Record<string, RateLimitWindow>) };
    stamped[key] = { ...value, observedAt: nowMs };
  }
  return stamped === null ? info : { ...info, windows: stamped };
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
  const stampedNext = stampTimelessExhaustedWindows(next, nowMs);
  if (prev === null) return stampedNext;
  const rawPrevWindows = prev.windows as unknown;
  if (typeof rawPrevWindows !== "object" || rawPrevWindows === null || Array.isArray(rawPrevWindows)) return stampedNext;
  const rawNextWindows = stampedNext.windows as unknown;
  const nextWindows: Record<string, RateLimitWindow> =
    typeof rawNextWindows === "object" && rawNextWindows !== null && !Array.isArray(rawNextWindows)
      ? { ...(rawNextWindows as Record<string, RateLimitWindow>) }
      : {};
  const prevResetFromOverwrittenWindow =
    typeof prev.resetsAt === "number" &&
    Number.isFinite(prev.resetsAt) &&
    prev.resetsAt > 0 &&
    Object.entries(rawPrevWindows as Record<string, unknown>).some(
      ([key, value]) =>
        Object.prototype.hasOwnProperty.call(nextWindows, key) &&
        isValidRateLimitWindow(value) &&
        value.resetsAt === prev.resetsAt,
    );
  const effectivePrevResetsAt = prevResetFromOverwrittenWindow ? null : prev.resetsAt;
  const carried: Array<[string, RateLimitWindow]> = [];
  for (const [key, value] of Object.entries(rawPrevWindows as Record<string, unknown>)) {
    if (Object.prototype.hasOwnProperty.call(nextWindows, key)) continue;
    if (!isValidRateLimitWindow(value) || !isWindowExhausted(value)) continue;
    if (!isWindowUnexpired(value, effectivePrevResetsAt, prevUpdatedAt, nowMs)) continue;
    // Pin the original observation time when carrying a timestamp-less window so row updated_at bumps do not extend fallback TTL.
    const carriedWindow =
      value.resetsAt > 0 ? value : { ...value, observedAt: validObservedAt(value) ?? prevUpdatedAt };
    carried.push([key, carriedWindow]);
  }
  if (carried.length === 0) return stampedNext;
  for (const [key, value] of carried) nextWindows[key] = value;
  const resets: number[] = [];
  for (const w of Object.values(nextWindows)) {
    if (isValidRateLimitWindow(w) && isWindowExhausted(w) && w.resetsAt > 0 && w.resetsAt * 1000 > nowMs) {
      resets.push(w.resetsAt);
    }
  }
  if (
    stampedNext.status === "rejected" &&
    typeof stampedNext.resetsAt === "number" &&
    Number.isFinite(stampedNext.resetsAt) &&
    stampedNext.resetsAt * 1000 > nowMs
  ) {
    resets.push(stampedNext.resetsAt);
  }
  if (
    resets.length === 0 &&
    typeof effectivePrevResetsAt === "number" &&
    Number.isFinite(effectivePrevResetsAt) &&
    effectivePrevResetsAt * 1000 > nowMs
  ) {
    resets.push(effectivePrevResetsAt);
  }
  return {
    ...stampedNext,
    status: "rejected",
    resetsAt: resets.length > 0 ? Math.max(...resets) : null,
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
