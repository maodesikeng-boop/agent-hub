import { randomUUID } from "node:crypto";
import type {
  AgentSessionRow,
  AgentStep,
  ApiRetryInfo,
  ConversationId,
  MessageId,
  PmId,
  RateLimitInfo,
  SessionActivity,
  SessionId,
  SessionState,
  WorkerId,
} from "../../shared/domain.ts";
import type { AgentTextDeltaEvent, BackgroundTaskInfo } from "../../shared/driver.ts";
import { clearRateLimitRejection, isQuotaExhausted } from "../../shared/domain.ts";
import {
  MAX_STREAMING_TEXT_CHARS,
  MIN_TOOL_STEP_VISIBLE_MS,
  STREAMING_TEXT_THROTTLE_MS,
  SESSION_STEPS_KEEP,
} from "../../shared/limits.ts";
import { deleteLegacyPendingSessionSend } from "../actions/index.ts";
import { getAgentSession, toAgentSessionRow } from "../store/index.ts";
import type { AgentSessionDbRow } from "../store/index.ts";
import type { LedgerContext, Pending } from "./context.ts";
import { stepOfTool } from "./tool-summary.ts";
import type { AgentVendor } from "../../shared/vendors.ts";

export interface LiveSession {
  activity: SessionActivity;
  currentTool: string | null;
  rateLimit?: RateLimitInfo | null;
  rateLimitReported?: boolean;
  apiRetry?: ApiRetryInfo | null;
  step?: AgentStep | null;
  stepStartedAt?: number | null;
  openTools?: LiveTool[];
  backgroundTasks?: number;
  backgroundTaskList?: readonly BackgroundTaskInfo[];
  streamingText?: string;
  /** Cached code point count so each delta does not re-count the whole string. */
  streamingChars?: number;
  toolStepAt?: number;
}

interface LiveTool {
  toolUseId: string;
  step: ToolStep;
  startedAt: number | null;
}

type ToolStep = Extract<AgentStep, { type: "tool_use" }>;

const THINKING: AgentStep = { type: "thinking" };

const RECOVER_MESSAGES_SQL = `
SELECT m.id, m.session_id, m.sender, m.status FROM messages m
JOIN agent_sessions s ON s.id = m.session_id
LEFT JOIN workers w ON w.id = s.worker_id
LEFT JOIN pm_archives pa ON pa.pm_id = COALESCE(s.pm_id, w.pm_id)
WHERE pa.pm_id IS NULL
  AND (w.id IS NULL OR (w.status = 'open' AND (w.workspace = 'main' OR w.base_commit IS NOT NULL)))
  AND NOT EXISTS (
    SELECT 1 FROM turn_completions c, json_each(c.event, '$.messageIds') ids
    WHERE c.session_id = m.session_id AND ids.value = m.id
      AND NOT (COALESCE(json_extract(c.event, '$.shutdown'), 0) = 1 AND (s.role = 'worker' OR m.sender = 'system'))
  )
  AND (
    m.status IN ('delivered', 'processing')
    OR (m.status = 'queued' AND NOT EXISTS (
      SELECT 1 FROM actions a
      WHERE a.type = 'session.send' AND a.status IN ('pending', 'running')
        AND (
          a.dedupe_key = (CAST(m.session_id AS TEXT) || ':' || CAST(m.id AS TEXT))
          OR (a.dedupe_key = CAST(m.id AS TEXT) AND json_extract(a.params, '$.sessionId') = m.session_id)
        )
    ))
  )
ORDER BY m.id`;

function sameToolStep(a: AgentStep | null | undefined, b: AgentStep | null | undefined): boolean {
  if (a?.type !== "tool_use" || b?.type !== "tool_use" || a.name !== b.name) return false;
  const ak = Object.keys(a.input);
  const bk = Object.keys(b.input);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a.input[k as keyof typeof a.input] === b.input[k as keyof typeof b.input]);
}

/** Stopping and preparing states are never overwritten. */
export const working = (at: number | null, currentTool: string | null, step?: AgentStep) => (l: LiveSession) => {
  if (l.activity !== "stopping" && l.activity !== "preparing") l.activity = "working";
  l.currentTool = currentTool;
  l.apiRetry = null;
  const next = step ?? l.step ?? THINKING;
  if (l.step?.type !== next.type || l.stepStartedAt === undefined) l.stepStartedAt = at;
  l.step = next;
};

function shownTool(tools: readonly LiveTool[] | undefined): LiveTool | undefined {
  return tools?.findLast((tool) => tool.startedAt !== null) ?? tools?.at(-1);
}

const showTool = (l: LiveSession, tool: LiveTool) => {
  working(tool.startedAt, tool.step.name, tool.step)(l);
  l.stepStartedAt = tool.startedAt;
};

export const toolStarted = (toolUseId: string, step: ToolStep, startedAt: number | null) => (l: LiveSession) => {
  const tool = { toolUseId, step, startedAt };
  l.openTools = [...(l.openTools ?? []).filter((t) => t.toolUseId !== toolUseId), tool].slice(-SESSION_STEPS_KEEP);
  showTool(l, shownTool(l.openTools) ?? tool);
};

export const toolRunning = (toolUseId: string, startedAt: number) => (l: LiveSession): void => {
  const tool = l.openTools?.find((t) => t.toolUseId === toolUseId);
  if (!tool || tool.startedAt !== null) return;
  toolStarted(toolUseId, tool.step, startedAt)(l);
};

export const clearStreaming = (l: LiveSession) => {
  l.streamingText = undefined;
  l.streamingChars = undefined;
};

export const idle = (l: LiveSession) => {
  l.activity = "idle";
  l.currentTool = null;
  l.apiRetry = null;
  l.step = null;
  l.stepStartedAt = null;
  l.openTools = [];
  l.toolStepAt = undefined;
  clearStreaming(l);
};

export type LedgerSessions = ReturnType<typeof createLedgerSessions>;

type StagedLive = WeakMap<Pending, Map<SessionId, LiveSession>>;

// Live state becomes visible only after commit, so a rolled-back transaction leaves no in-memory trace.
function stageLive(staged: StagedLive, p: Pending, sessionId: SessionId, next: LiveSession): void {
  const pending = staged.get(p) ?? new Map<SessionId, LiveSession>();
  staged.set(p, pending);
  pending.set(sessionId, next);
}

const stagedOf = (staged: StagedLive, p: Pending | null, sessionId: SessionId) => (p === null ? undefined : staged.get(p)?.get(sessionId));

/** Returns whether a pending tool hold timer should keep running. */
function stampToolStep(prev: LiveSession, next: LiveSession, hadHold: boolean, now: () => number): boolean {
  const holdsTool = next.activity === "working" && next.step?.type === "tool_use";
  const hasOpenTools = (next.openTools?.length ?? 0) > 0;
  if (!holdsTool) next.toolStepAt = undefined;
  else if (hasOpenTools && (hadHold || !sameToolStep(prev.step, next.step) || next.toolStepAt === undefined)) next.toolStepAt = now();
  return holdsTool && !hasOpenTools;
}

export function createLedgerSessions(ctx: LedgerContext) {
  const { db, now, write, emitChange, enqueue, pushed } = ctx;
  const live = new Map<SessionId, LiveSession>();
  const streamThrottles = new Map<SessionId, { lastFlushedAt: number; timer: ReturnType<typeof setTimeout> | null }>();
  const toolHoldTimers = new Map<SessionId, ReturnType<typeof setTimeout>>();

  const safeGetSession = (sessionId: SessionId): AgentSessionRow | null => {
    try {
      return getAgentSession(db, sessionId);
    } catch {
      return null;
    }
  };

  const cancelStreamTimer = (sessionId: SessionId) => {
    const entry = streamThrottles.get(sessionId);
    if (entry !== undefined) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      streamThrottles.delete(sessionId);
    }
  };

  const cancelToolHoldTimer = (sessionId: SessionId) => {
    const timer = toolHoldTimers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      toolHoldTimers.delete(sessionId);
    }
  };

  const hasToolHold = (sessionId: SessionId): boolean => toolHoldTimers.has(sessionId);

  const forgetSession = (sessionId: SessionId) => {
    cancelStreamTimer(sessionId);
    cancelToolHoldTimer(sessionId);
    live.delete(sessionId);
    pushed.delete(sessionId);
  };

  const clearAllStreaming = () => {
    for (const entry of streamThrottles.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
    }
    streamThrottles.clear();
    for (const timer of toolHoldTimers.values()) clearTimeout(timer);
    toolHoldTimers.clear();
    for (const l of live.values()) {
      clearStreaming(l);
      l.toolStepAt = undefined;
    }
  };

  const currentSession = (conversationId: ConversationId): AgentSessionRow | null => {
    const row = db.get<AgentSessionDbRow>(
      "SELECT * FROM agent_sessions WHERE conversation_id = ? ORDER BY generation DESC LIMIT 1",
      conversationId,
    );
    return row === undefined ? null : toAgentSessionRow(row);
  };

  const staged: StagedLive = new WeakMap();
  const liveOf = (id: SessionId): LiveSession => stagedOf(staged, ctx.activePending(), id) ?? live.get(id) ?? { activity: "idle", currentTool: null };

  const workingSessionIds = (): SessionId[] => [...live].filter(([, l]) => l.activity !== "idle").map(([id]) => id);

  const sessionState = (row: AgentSessionRow, l = liveOf(row.id)): SessionState => {
    return {
      sessionId: row.id,
      conversationId: row.conversationId,
      pmId: row.pmId,
      generation: row.generation,
      status: row.status,
      activity: l.activity,
      currentTool: l.currentTool,
      rateLimit: l.rateLimit !== undefined ? l.rateLimit : row.rateLimit,
      apiRetry: l.apiRetry ?? null,
      usage: row.usage,
      vendor: row.vendor,
      model: row.model,
      effort: row.effort,
      step: l.step ?? null,
      stepStartedAt: l.stepStartedAt ?? null,
      lastEventAt: row.lastEventAt,
      ...(l.streamingText ? { streamingText: l.streamingText } : {}),
    };
  };

  const updateLive = (p: Pending, sessionId: SessionId, mutate: (l: LiveSession) => void) => {
    const row = getAgentSession(db, sessionId);
    if (row === null) return;
    const prev = liveOf(sessionId);
    const next = { ...prev };
    mutate(next);
    const keepsHold = stampToolStep(prev, next, toolHoldTimers.has(sessionId), now);
    stageLive(staged, p, sessionId, next);
    p.after.push(() => {
      if (next.streamingText === undefined) cancelStreamTimer(sessionId);
      if (!keepsHold) cancelToolHoldTimer(sessionId);
      live.set(sessionId, next);
    });
    const after = sessionState(row, next);
    const key = JSON.stringify({ ...after, lastEventAt: null });
    if ((p.pushed.get(sessionId) ?? pushed.get(sessionId)) === key) return;
    p.pushed.set(sessionId, key);
    p.changes.push({ type: "session.status", data: { session: after } });
  };

  const dropRateLimitRejection = (p: Pending, sessionId: SessionId) => {
    const row = getAgentSession(db, sessionId);
    if (row === null) return;
    const l = liveOf(sessionId);
    const rowExhausted = row.rateLimit !== null && isQuotaExhausted(row.rateLimit);
    const liveExhausted = l.rateLimit !== undefined && l.rateLimit !== null && isQuotaExhausted(l.rateLimit);
    if (!rowExhausted && !liveExhausted) return;
    const info = l.rateLimit !== undefined ? l.rateLimit : row.rateLimit;
    const cleared = info === null ? null : clearRateLimitRejection(info);
    db.run("UPDATE agent_sessions SET rate_limit = ? WHERE id = ?", cleared === null ? null : JSON.stringify(cleared), sessionId);
    updateLive(p, sessionId, (next) => {
      next.rateLimit = cleared;
      next.rateLimitReported = false;
    });
  };

  const isHiddenStreamingSession = (session: AgentSessionRow): boolean =>
    session.conversationId === null ||
    (session.role === "pm" &&
      db.get(
        `SELECT 1 AS x FROM messages WHERE session_id = ? AND sender = 'system' AND kind = 'text'
           AND json_extract(meta, '$.event') = 'handover.requested' AND json_extract(meta, '$.writing') = 1 LIMIT 1`,
        session.id,
      ) !== undefined);

  const flushSessionStatusNow = (sessionId: SessionId, knownRow?: AgentSessionRow) => {
    const row = knownRow ?? safeGetSession(sessionId);
    if (row === null) return;
    const after = sessionState(row);
    const key = JSON.stringify({ ...after, lastEventAt: null });
    if (pushed.get(sessionId) === key) return;
    pushed.set(sessionId, key);
    emitChange({ type: "session.status", data: { session: after } });
  };

  /** Tool previews only update in-memory state and never write to SQLite. */
  const applyToolPreview = (
    session: AgentSessionRow,
    preview: { toolUseId?: string; name: string; input?: unknown },
  ) => {
    if (preview.name === "" || isHiddenStreamingSession(session)) return;
    const sessionId = session.id;
    const prev = liveOf(sessionId);
    // Only upgrade a running turn; stopping, preparing and idle stay as they are.
    if (prev.activity !== "working") return;

    cancelStreamTimer(sessionId);
    cancelToolHoldTimer(sessionId);

    const step = stepOfTool(preview.name, preview.input);
    const next: LiveSession = { ...prev };
    clearStreaming(next);

    if (preview.toolUseId !== undefined && next.openTools?.some((t) => t.toolUseId === preview.toolUseId)) {
      next.openTools = next.openTools.map((t) => (t.toolUseId === preview.toolUseId ? { ...t, step } : t));
      const tool = shownTool(next.openTools);
      if (tool) showTool(next, tool);
    } else {
      working(now(), preview.name, step)(next);
      next.stepStartedAt = null;
    }

    if (!sameToolStep(prev.step, next.step) || next.toolStepAt === undefined) {
      next.toolStepAt = now();
    }
    live.set(sessionId, next);
    flushSessionStatusNow(sessionId, session);
  };

  const finishTools = (p: Pending, sessionId: SessionId, toolUseIds: string[], at: number) => {
    const prev = liveOf(sessionId);
    const open = prev.openTools ?? [];
    const remaining = open.filter((t) => !toolUseIds.includes(t.toolUseId));
    if (remaining.length === open.length) return;
    const tool = shownTool(remaining);
    if (tool) {
      updateLive(p, sessionId, (l) => {
        clearStreaming(l);
        l.openTools = remaining;
        showTool(l, tool);
      });
      return;
    }

    const currentNow = now();
    const shownAt = prev.toolStepAt;
    const elapsed = shownAt === undefined ? MIN_TOOL_STEP_VISIBLE_MS : currentNow - shownAt;
    if (prev.activity === "working" && prev.step?.type === "tool_use" && elapsed < MIN_TOOL_STEP_VISIBLE_MS) {
      const heldStep = prev.step;
      updateLive(p, sessionId, (l) => {
        clearStreaming(l);
        l.openTools = [];
        working(at, l.currentTool, heldStep)(l);
        l.toolStepAt = shownAt;
      });
      cancelToolHoldTimer(sessionId);
      const delay = Math.max(1, MIN_TOOL_STEP_VISIBLE_MS - Math.max(0, elapsed));
      toolHoldTimers.set(
        sessionId,
        setTimeout(() => {
          toolHoldTimers.delete(sessionId);
          const cur = live.get(sessionId);
          if (
            cur === undefined ||
            cur.activity !== "working" ||
            (cur.openTools?.length ?? 0) > 0 ||
            cur.streamingText !== undefined ||
            cur.step?.type !== "tool_use"
          ) {
            return;
          }
          const row = safeGetSession(sessionId);
          if (row === null) return;
          // A dwell timer is not a new event, so other states such as apiRetry stay untouched.
          live.set(sessionId, { ...cur, step: THINKING, stepStartedAt: now(), toolStepAt: undefined });
          flushSessionStatusNow(sessionId, row);
        }, delay),
      );
      return;
    }

    updateLive(p, sessionId, (l) => {
      clearStreaming(l);
      l.openTools = [];
      working(at, l.currentTool, THINKING)(l);
    });
  };

  /** Streaming text deltas are throttled broadcasts of in-memory state and never write to SQLite. */
  const applyStreamingDelta = (session: AgentSessionRow, { delta, reset, startedAt, at }: AgentTextDeltaEvent) => {
    if (delta === "" && !reset && startedAt === undefined) return;
    const sessionId = session.id;
    if (isHiddenStreamingSession(session)) {
      return;
    }

    const prev = liveOf(sessionId);
    if (prev.activity === "stopping") return;
    const base = reset ? "" : (prev.streamingText ?? "");
    const baseChars = reset || prev.streamingText === undefined ? 0 : (prev.streamingChars ?? [...base].length);
    if (!reset && baseChars >= MAX_STREAMING_TEXT_CHARS) return;

    let combined = base;
    let nextChars = baseChars;
    if (delta !== "" && baseChars < MAX_STREAMING_TEXT_CHARS) {
      const room = MAX_STREAMING_TEXT_CHARS - baseChars;
      if (delta.length <= room) {
        combined = base + delta;
        nextChars = baseChars + [...delta].length;
      } else {
        const deltaChars = [...delta];
        const slice = deltaChars.length <= room ? delta : deltaChars.slice(0, room).join("");
        combined = base + slice;
        nextChars = baseChars + Math.min(deltaChars.length, room);
      }
    }

    const next: LiveSession = { ...prev };
    if (combined === "") clearStreaming(next);
    if (combined !== "" || startedAt !== undefined) {
      cancelToolHoldTimer(sessionId);
      next.toolStepAt = undefined;
      working(at, null, { type: "text" })(next);
      if (startedAt !== undefined) next.stepStartedAt = startedAt;
      if (combined !== "") {
        next.streamingText = combined;
        next.streamingChars = nextChars;
      }
    }
    live.set(sessionId, next);

    const flushNow = () => flushSessionStatusNow(sessionId);

    const currentNow = now();
    let entry = streamThrottles.get(sessionId);
    if (entry === undefined) {
      if (streamThrottles.size > 64) {
        for (const [id, item] of streamThrottles) {
          if (item.timer === null && currentNow - item.lastFlushedAt >= STREAMING_TEXT_THROTTLE_MS) {
            streamThrottles.delete(id);
          }
        }
      }
      streamThrottles.set(sessionId, { lastFlushedAt: currentNow, timer: null });
      flushNow();
      return;
    }

    const elapsed = currentNow - entry.lastFlushedAt;
    if (entry.timer === null && elapsed >= STREAMING_TEXT_THROTTLE_MS) {
      entry.lastFlushedAt = currentNow;
      flushNow();
      return;
    }

    if (entry.timer === null) {
      const delay = Math.max(1, STREAMING_TEXT_THROTTLE_MS - Math.max(0, elapsed));
      entry.timer = setTimeout(() => {
        const latest = streamThrottles.get(sessionId);
        if (latest === undefined) return;
        latest.timer = null;
        latest.lastFlushedAt = now();
        flushNow();
      }, delay);
    }
  };

  const insertSession = (
    p: Pending,
    fields: {
      role?: "pm" | "worker";
      conversationId: ConversationId;
      pmId: PmId | null;
      workerId?: WorkerId;
      cwd: string;
      addDirs: string[];
      generation: number;
      vendor: AgentVendor;
      model: string | null;
      effort: string | null;
    },
  ): AgentSessionRow => {
    const t = now();
    const id = db.run(
      `INSERT INTO agent_sessions (role, conversation_id, pm_id, worker_id, vendor, vendor_session_id, cwd, add_dirs, generation, model, effort,
                                   created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      fields.role ?? "pm",
      fields.conversationId,
      fields.pmId,
      fields.workerId ?? null,
      fields.vendor,
      randomUUID(),
      fields.cwd,
      JSON.stringify(fields.addDirs),
      fields.generation,
      fields.model,
      fields.effort,
      t,
      t,
    ).lastInsertRowid;
    const row = getAgentSession(db, id)!;
    p.changes.push({ type: "session.created", data: { session: sessionState(row) } });
    return row;
  };

  const refreshSessionState = (sessionId: SessionId) => {
    write((p) => updateLive(p, sessionId, idle));
  };

  const recoverAfterRestart = () => {
    return write((p) => {
      const rows = db.all<{ id: number; session_id: number; sender: string; status: string }>(RECOVER_MESSAGES_SQL);
      const resentMessageIds: MessageId[] = [];
      const requeuedMessageIds: MessageId[] = [];
      // Resume the oldest interrupted message first.
      const recoveredSessionIds: SessionId[] = [];
      for (const row of rows) {
        const resend = row.status !== "queued";
        (resend ? resentMessageIds : requeuedMessageIds).push(row.id);
        const recovery = resend && !recoveredSessionIds.includes(row.session_id);
        if (recovery) recoveredSessionIds.push(row.session_id);
        const source = row.sender === "system" ? "system" : "user";
        if (resend) deleteLegacyPendingSessionSend(db, row.session_id, row.id);
        enqueue(p, {
          type: "session.send",
          params: { sessionId: row.session_id, messageId: row.id, source, ...(resend ? { resend: true } : {}), ...(recovery ? { recovery: true } : {}) },
        });
      }
      return { resentMessageIds, requeuedMessageIds, recoveredSessionIds };
    });
  };

  return {
    currentSession,
    liveOf,
    workingSessionIds,
    sessionState,
    updateLive,
    dropRateLimitRejection,
    applyStreamingDelta,
    applyToolPreview,
    finishTools,
    hasToolHold,
    cancelStreamTimer,
    cancelToolHoldTimer,
    clearAllStreaming,
    forgetSession,
    insertSession,
    refreshSessionState,
    recoverAfterRestart,
  };
}
