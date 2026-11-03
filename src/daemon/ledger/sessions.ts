// 账本里的会话：内存里的会话状态（推给网页的 session.status）、建会话、重启恢复。
// 进程怎么起、停、重启在驱动层（driver/claude-driver.ts）；三类动作的处理函数在 handlers.ts。
import { randomUUID } from "node:crypto";
import type {
  AgentSessionRow,
  ConversationId,
  MessageId,
  PmId,
  RateLimitInfo,
  SessionActivity,
  SessionId,
  SessionState,
  WorkerId,
} from "../../shared/domain.ts";
import { getAgentSession, toAgentSessionRow } from "../store/index.ts";
import type { AgentSessionDbRow } from "../store/index.ts";
import type { LedgerContext, Pending } from "./context.ts";

/** 只在内存里的会话状态（守护进程重启后从头开始）。status 不在这里，只从 agent_sessions 那一行读。 */
export interface LiveSession {
  activity: SessionActivity;
  currentTool: string | null;
  rateLimit?: RateLimitInfo | null;
}

export const working = (currentTool: string | null) => (l: LiveSession) => {
  if (l.activity !== "stopping") l.activity = "working";
  l.currentTool = currentTool;
};

export const idle = (l: LiveSession) => {
  l.activity = "idle";
  l.currentTool = null;
};

export type LedgerSessions = ReturnType<typeof createLedgerSessions>;

export function createLedgerSessions(ctx: LedgerContext) {
  const { db, now, write, enqueue, pushed } = ctx;
  const live = new Map<SessionId, LiveSession>();

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
      lastEventAt: row.lastEventAt,
    };
  };

  /**
   * 改内存里的会话状态，再按 agent_sessions 那一行算出网页看到的状态，和上次推出去的比，变了就推一条 session.status。
   * 和上次推的比、不和“改之前按行算的”比：驱动层先写库再发事件也不会漏推。lastEventAt 不参与比较。
   */
  const updateLive = (p: Pending, sessionId: SessionId, mutate: (l: LiveSession) => void) => {
    const row = getAgentSession(db, sessionId);
    if (row === null) return;
    const next = { ...liveOf(sessionId) };
    mutate(next);
    live.set(sessionId, next);
    const after = sessionState(row);
    const key = JSON.stringify({ ...after, lastEventAt: null });
    if ((p.pushed.get(sessionId) ?? pushed.get(sessionId)) === key) return;
    p.pushed.set(sessionId, key);
    p.changes.push({ type: "session.status", data: { session: after } });
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
      model: string | null;
    },
  ): AgentSessionRow => {
    const t = now();
    const id = db.run(
      `INSERT INTO agent_sessions (role, conversation_id, pm_id, worker_id, vendor_session_id, cwd, add_dirs, generation, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      fields.role ?? "pm",
      fields.conversationId,
      fields.pmId,
      fields.workerId ?? null,
      randomUUID(),
      fields.cwd,
      JSON.stringify(fields.addDirs),
      fields.generation,
      fields.model,
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
         WHERE (w.id IS NULL OR (w.status = 'open' AND (w.workspace = 'main' OR w.base_commit IS NOT NULL)))
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

  return { currentSession, liveOf, sessionState, updateLive, insertSession, refreshSessionState, recoverAfterRestart };
}
