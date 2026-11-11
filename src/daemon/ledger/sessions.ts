// 账本里的会话：内存里的会话状态（推给网页的 session.status）、建会话、重启恢复。
// 进程怎么起、停、重启在驱动层（driver/claude-driver.ts）；三类动作的处理函数在 handlers.ts。
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
import {
  MAX_STREAMING_TEXT_CHARS,
  MIN_TOOL_STEP_VISIBLE_MS,
  STREAMING_TEXT_THROTTLE_MS,
} from "../../shared/limits.ts";
import { getAgentSession, toAgentSessionRow } from "../store/index.ts";
import type { AgentSessionDbRow } from "../store/index.ts";
import type { LedgerContext, Pending } from "./context.ts";
import { stepOfTool } from "./tool-summary.ts";
import type { AgentVendor } from "../../shared/vendors.ts";

/** 只在内存里的会话状态（守护进程重启后从头开始）。status 不在这里，只从 agent_sessions 那一行读。 */
export interface LiveSession {
  activity: SessionActivity;
  currentTool: string | null;
  rateLimit?: RateLimitInfo | null;
  /** claude 正在重试（断网、过载）；下一个正常事件（working、idle）清掉。 */
  apiRetry?: ApiRetryInfo | null;
  /** 在做什么（见 AgentStep）；空闲时没有。 */
  step?: AgentStep | null;
  /** 调了、结果还没回来的工具（按调用顺序）：几个工具同时在跑时，结果一个个回来，还没回来的最后一个就是当前这一步。 */
  openTools?: Array<{ toolUseId: string; step: AgentStep }>;
  /**
   * 会话里还在跑的后台任务个数（驱动层的 background.changed，只有 claude 有这个信号）；没有信号就是 undefined。
   * 进程起来、退出时清掉。hub worker show 用，不推给网页。
   */
  backgroundTasks?: number;
  /** 当前正在流式生成的单段回复文字（上限 MAX_STREAMING_TEXT_CHARS 个码点）；段完成入库或换步/结束时清掉。 */
  streamingText?: string;
  /** streamingText 当前的 Unicode 码点数，避免每次 delta 重复展开整段字符串计数。 */
  streamingChars?: number;
  /** 最近一次当前工具 step 开始显示的时刻（毫秒），用于快工具不足 MIN_TOOL_STEP_VISIBLE_MS 时防闪没驻留；不推给网页。 */
  toolStepAt?: number;
}

const THINKING: AgentStep = { type: "thinking" };

function sameToolStep(a: AgentStep | null | undefined, b: AgentStep | null | undefined): boolean {
  if (a?.type !== "tool_use" || b?.type !== "tool_use" || a.name !== b.name) return false;
  const ak = Object.keys(a.input);
  const bk = Object.keys(b.input);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a.input[k as keyof typeof a.input] === b.input[k as keyof typeof b.input]);
}

/**
 * 正在停、准备中（Worker 在跑准备命令，还没开工）不被盖掉。step 不传就保持原样（还没有就是“在思考”：一轮刚开始，
 * claude 在想）；子任务里的事件不传，不改主 agent 的状态。
 */
export const working = (currentTool: string | null, step?: AgentStep) => (l: LiveSession) => {
  if (l.activity !== "stopping" && l.activity !== "preparing") l.activity = "working";
  l.currentTool = currentTool;
  l.apiRetry = null;
  l.step = step ?? l.step ?? THINKING;
};

/** 主 agent 调了一个工具：记下它没回结果，当前这一步就是它。 */
export const toolStarted = (currentTool: string, toolUseId: string, step: AgentStep) => (l: LiveSession) => {
  working(currentTool, step)(l);
  l.openTools = [...(l.openTools ?? []).filter((t) => t.toolUseId !== toolUseId), { toolUseId, step }];
};

/** 工具结果回来了：还有没回来的，当前这一步是其中最后一个；都回来了，claude 在接着想。 */
export const toolFinished = (toolUseIds: string[]) => (l: LiveSession) => {
  l.openTools = (l.openTools ?? []).filter((t) => !toolUseIds.includes(t.toolUseId));
  working(l.currentTool, l.openTools.at(-1)?.step ?? THINKING)(l);
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
  l.openTools = [];
  l.toolStepAt = undefined;
  clearStreaming(l);
};

export type LedgerSessions = ReturnType<typeof createLedgerSessions>;

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

  /** 对话当前这一代的会话。 */
  const currentSession = (conversationId: ConversationId): AgentSessionRow | null => {
    const row = db.get<AgentSessionDbRow>(
      "SELECT * FROM agent_sessions WHERE conversation_id = ? ORDER BY generation DESC LIMIT 1",
      conversationId,
    );
    return row === undefined ? null : toAgentSessionRow(row);
  };

  const liveOf = (id: SessionId): LiveSession => live.get(id) ?? { activity: "idle", currentTool: null };

  const sessionState = (row: AgentSessionRow): SessionState => {
    const l = liveOf(row.id);
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
      lastEventAt: row.lastEventAt,
      ...(l.streamingText ? { streamingText: l.streamingText } : {}),
    };
  };

  /**
   * 改内存里的会话状态，再按 agent_sessions 那一行算出网页看到的状态，和上次推出去的比，变了就推一条 session.status。
   * 和上次推的比、不和“改之前按行算的”比：驱动层先写库再发事件也不会漏推。lastEventAt 不参与比较。
   */
  const updateLive = (p: Pending, sessionId: SessionId, mutate: (l: LiveSession) => void) => {
    const row = getAgentSession(db, sessionId);
    if (row === null) return;
    const prev = liveOf(sessionId);
    const hadHold = toolHoldTimers.has(sessionId);
    const next = { ...prev };
    mutate(next);
    if (next.streamingText === undefined) cancelStreamTimer(sessionId);
    if (next.activity !== "working" || next.step?.type !== "tool_use") {
      cancelToolHoldTimer(sessionId);
      next.toolStepAt = undefined;
    } else if ((next.openTools?.length ?? 0) > 0) {
      cancelToolHoldTimer(sessionId);
      if (hadHold || !sameToolStep(prev.step, next.step) || next.toolStepAt === undefined) {
        next.toolStepAt = now();
      }
    }
    live.set(sessionId, next);
    const after = sessionState(row);
    const key = JSON.stringify({ ...after, lastEventAt: null });
    if ((p.pushed.get(sessionId) ?? pushed.get(sessionId)) === key) return;
    p.pushed.set(sessionId, key);
    p.changes.push({ type: "session.status", data: { session: after } });
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

  /**
   * 收到厂商流式工具早捕获预览（agent.tool_preview）：只改内存态 LiveSession.step 并立即推 session.status，
   * 零 SQLite 写入、绝不插 messages 或 session_steps；若对应已打开的 openTools 条目（如 ACP tool_call_update 补齐路径），同步升级其 step。
   */
  const applyToolPreview = (
    session: AgentSessionRow,
    preview: { toolUseId?: string; name: string; input?: unknown },
  ) => {
    if (preview.name === "" || isHiddenStreamingSession(session)) return;
    const sessionId = session.id;
    const prev = liveOf(sessionId);
    // 只升级正在跑的这一轮：停止中、准备中不盖；空闲（轮已结束、进程已退）时迟到的预览不能把会话“救活”成在干活（它不入库，
    // 后面也不会再有 turn.ended 把它收回去）。正式的 agent.tool 之前一定先有 message.processing / turn.started 把状态置成 working
    if (prev.activity !== "working") return;

    cancelStreamTimer(sessionId);
    cancelToolHoldTimer(sessionId);

    const step = stepOfTool(preview.name, preview.input);
    const next: LiveSession = { ...prev };
    clearStreaming(next);

    if (preview.toolUseId !== undefined && next.openTools?.some((t) => t.toolUseId === preview.toolUseId)) {
      next.openTools = next.openTools.map((t) => (t.toolUseId === preview.toolUseId ? { ...t, step } : t));
      const latest = next.openTools.at(-1)!;
      working(latest.step.type === "tool_use" ? latest.step.name : preview.name, latest.step)(next);
    } else {
      working(preview.name, step)(next);
    }

    if (!sameToolStep(prev.step, next.step) || next.toolStepAt === undefined) {
      next.toolStepAt = now();
    }
    live.set(sessionId, next);
    flushSessionStatusNow(sessionId, session);
  };

  /**
   * 工具结果返回（agent.tool_result）：
   * - 仍有未闭合并行工具时切到剩余最后一个；
   * - openTools 清空准备回退到 Thinking 时，若距最近一次工具 step 显示尚不足 MIN_TOOL_STEP_VISIBLE_MS，
   *   保留当前工具文案并设单会话唯一 setTimeout 到点回退 Thinking。
   */
  const finishTools = (p: Pending, sessionId: SessionId, toolUseIds: string[]) => {
    const prev = liveOf(sessionId);
    const remaining = (prev.openTools ?? []).filter((t) => !toolUseIds.includes(t.toolUseId));
    if (remaining.length > 0) {
      updateLive(p, sessionId, (l) => {
        clearStreaming(l);
        l.openTools = remaining;
        working(l.currentTool, remaining.at(-1)!.step)(l);
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
        working(l.currentTool, heldStep)(l);
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
          // 只是驻留到点，不是新事件：apiRetry 等别的状态原样留着（驻留期间来的 api_retry 不被冲掉）
          live.set(sessionId, { ...cur, step: THINKING, toolStepAt: undefined });
          flushSessionStatusNow(sessionId, row);
        }, delay),
      );
      return;
    }

    updateLive(p, sessionId, (l) => {
      clearStreaming(l);
      l.openTools = [];
      working(l.currentTool, THINKING)(l);
    });
  };

  /**
   * 收到厂商流式文字增量（agent.text_delta）：只改内存态 LiveSession 并做节流广播，绝不写 SQLite。
   * - 首块（或距上次广播已满 STREAMING_TEXT_THROTTLE_MS）0ms 延迟立即推出去；
   * - 节流窗口内的后续增量合并在内存里，窗口到点补发一次；
   * - 单段内存预览最多保留前 MAX_STREAMING_TEXT_CHARS 个码点，超出部分只等最终 agent.text 一次性入库。
   */
  const applyStreamingDelta = (session: AgentSessionRow, delta: string, reset?: boolean) => {
    if (delta === "" && !reset) return;
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
    if (combined === "") {
      clearStreaming(next);
    } else {
      cancelToolHoldTimer(sessionId);
      next.toolStepAt = undefined;
      working(null, { type: "text" })(next);
      next.streamingText = combined;
      next.streamingChars = nextChars;
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

  /** 项目经理的会话：pmId 是它；Worker 的会话（M3）：role worker、workerId 是它的记录，pmId 是 null。 */
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
      // Worker 的会话（M3）：已收工的不再发；worktree 还没建好的等 onWorktreeCreated 再登记（目录还不在，不能先起会话）
      const rows = db.all<{ id: number; session_id: number; sender: string; status: string }>(
        `SELECT m.id, m.session_id, m.sender, m.status FROM messages m
         JOIN agent_sessions s ON s.id = m.session_id
         LEFT JOIN workers w ON w.id = s.worker_id
         LEFT JOIN pm_archives pa ON pa.pm_id = COALESCE(s.pm_id, w.pm_id)
         WHERE pa.pm_id IS NULL
           AND (w.id IS NULL OR (w.status = 'open' AND (w.workspace = 'main' OR w.base_commit IS NOT NULL)))
           AND (
             m.status IN ('delivered', 'processing')
             -- 排队中的已有活动动作就不用管；已送达、处理中的总要再登记一次，把参数改成 resend
             OR (m.status = 'queued' AND NOT EXISTS (
               SELECT 1 FROM actions a
               WHERE a.type = 'session.send' AND a.dedupe_key = CAST(m.id AS TEXT) AND a.status IN ('pending', 'running')
             ))
           )
         ORDER BY m.id`,
      );
      const resentMessageIds: MessageId[] = [];
      const requeuedMessageIds: MessageId[] = [];
      // 按最早一条被打断的消息排，旧的先恢复
      const recoveredSessionIds: SessionId[] = [];
      for (const row of rows) {
        const resend = row.status !== "queued";
        (resend ? resentMessageIds : requeuedMessageIds).push(row.id);
        // 每个被打断的会话，第一条重发的消息带上恢复说明（和它写在同一行，不单独登记 session.start 去写）
        const recovery = resend && !recoveredSessionIds.includes(row.session_id);
        if (recovery) recoveredSessionIds.push(row.session_id);
        const source = row.sender === "system" ? "system" : "user";
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
    sessionState,
    updateLive,
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
