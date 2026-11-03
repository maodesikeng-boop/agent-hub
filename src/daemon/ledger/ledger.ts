// 账本（设计第 6.2 节）：业务表的唯一写者。每个命令一个事务，提交之后才推变化、通知新登记的动作。
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AnyActionRow, NewAction } from "../../shared/actions.ts";
import type { Change, ConversationSnapshot, MessagesPage, StateSnapshot } from "../../shared/api.ts";
import {
  agentMessageDedupeKey,
  canTransitionMessage,
  userMessageDedupeKey,
} from "../../shared/domain.ts";
import type {
  AgentSessionRow,
  ConversationId,
  HealthModule,
  Message,
  MessageId,
  MessageStatus,
  RateLimitInfo,
  SessionActivity,
  SessionId,
  SessionState,
  SessionStatus,
} from "../../shared/domain.ts";
import type { DriverEvent, SessionExitedEvent } from "../../shared/driver.ts";
import { ConversationNotFoundError } from "../../shared/ledger.ts";
import type { CreatePmInput, CreatePmResult, Ledger, PostUserMessageInput } from "../../shared/ledger.ts";
import { CHANGE_BUFFER_SIZE, MESSAGE_PAGE_SIZE } from "../../shared/limits.ts";
import { enqueueAction } from "../actions/index.ts";
import { getAgentSession, toAgentSessionRow } from "../store/index.ts";
import type { AgentSessionDbRow, Db } from "../store/index.ts";
import { createChangeLog } from "./change-log.ts";
import type { ChangeInput } from "./change-log.ts";
import { toConversation, toHealth, toMessage, toPm } from "./rows.ts";
import type { ConversationDbRow, HealthDbRow, MessageDbRow, PmDbRow } from "./rows.ts";
import { summarizeToolCall } from "./tool-summary.ts";

export type SqliteLedger = Ledger;

export interface LedgerOptions {
  now?: () => number;
  /** 本次启动的初始 seq，默认启动时刻的毫秒时间戳（比上次运行用过的都大）。 */
  initialSeq?: number;
  changeBufferSize?: number;
}

type StopEvent = { conversationId: ConversationId; sessionId: SessionId };

/** 一个事务里攒下的、提交后才发出去的东西；回滚就整个丢掉。 */
interface Pending {
  changes: ChangeInput[];
  actions: AnyActionRow[];
  stops: StopEvent[];
}

/** 只在内存里的会话状态（守护进程重启后从数据库那一行重新开始）。 */
interface LiveSession {
  activity: SessionActivity;
  currentTool: string | null;
  /** 驱动层事件推出来的状态；没有时用 agent_sessions 那一行的。 */
  status?: SessionStatus;
  rateLimit?: RateLimitInfo | null;
}

const ACTIVE_MESSAGE_STATUSES = "('delivered', 'processing')";

function exitFailureReason(event: SessionExitedEvent): string {
  if (event.signal !== null) return `${event.reason}: signal ${event.signal}`;
  if (event.exitCode !== null) return `${event.reason}: exit code ${event.exitCode}`;
  return event.reason;
}

export function createLedger(db: Db, options: LedgerOptions = {}): SqliteLedger {
  const now = options.now ?? Date.now;
  const log = createChangeLog(options.initialSeq ?? Date.now(), options.changeBufferSize ?? CHANGE_BUFFER_SIZE);
  const changeListeners = new Set<(change: Change) => void>();
  const actionListeners = new Set<(action: AnyActionRow) => void>();
  const stopListeners = new Set<(event: StopEvent) => void>();
  const live = new Map<SessionId, LiveSession>();

  const notify = <T>(listeners: Set<(value: T) => void>, value: T) => {
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch (error) {
        console.error("agent-hub ledger listener:", error);
      }
    }
  };

  const subscribe = <T>(listeners: Set<T>, listener: T) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  /** 在一个事务里做 fn，提交后按顺序发变化、动作登记、停止请求。 */
  const write = <T>(fn: (p: Pending) => T): T => {
    const pending: Pending = { changes: [], actions: [], stops: [] };
    const result = db.transaction(() => fn(pending));
    for (const input of pending.changes) notify(changeListeners, log.append(input));
    for (const action of pending.actions) notify(actionListeners, action);
    for (const stop of pending.stops) notify(stopListeners, stop);
    return result;
  };

  const enqueue = (p: Pending, action: NewAction) => {
    const { row, enqueued } = enqueueAction(db, action, now());
    if (enqueued) p.actions.push(row);
  };

  // ---- 读 ----

  const conversationExists = (id: ConversationId) =>
    db.get("SELECT 1 AS x FROM conversations WHERE id = ?", id) !== undefined;

  const getMessage = (id: MessageId): Message | null => {
    const row = db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", id);
    return row === undefined ? null : toMessage(row);
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
      status: l.status ?? row.status,
      activity: l.activity,
      currentTool: l.currentTool,
      rateLimit: l.rateLimit !== undefined ? l.rateLimit : row.rateLimit,
      lastEventAt: row.lastEventAt,
    };
  };

  /** 改内存里的会话状态；网页看得到的部分变了就推一条 session.status。 */
  const updateLive = (p: Pending, sessionId: SessionId, mutate: (l: LiveSession) => void) => {
    const row = getAgentSession(db, sessionId);
    if (row === null) return;
    const before = sessionState(row);
    const next = { ...liveOf(sessionId) };
    mutate(next);
    live.set(sessionId, next);
    const after = sessionState(row);
    if (JSON.stringify(before) !== JSON.stringify(after)) p.changes.push({ type: "session.status", data: { session: after } });
  };

  const working = (currentTool: string | null) => (l: LiveSession) => {
    if (l.activity !== "stopping") l.activity = "working";
    l.currentTool = currentTool;
  };

  const idle = (l: LiveSession) => {
    l.activity = "idle";
    l.currentTool = null;
  };

  const page = (rows: MessageDbRow[]): MessagesPage => {
    const hasMore = rows.length > MESSAGE_PAGE_SIZE;
    return { messages: rows.slice(0, MESSAGE_PAGE_SIZE).reverse().map(toMessage), hasMore };
  };

  // ---- 写 ----

  /** 按 MESSAGE_STATUS_TRANSITIONS 改状态；不合法（包括同状态）、找不到、没有状态的消息忽略。 */
  const transition = (p: Pending, id: MessageId, to: MessageStatus, reason: string | null = null) => {
    const message = getMessage(id);
    if (message === null || message.status === null || !canTransitionMessage(message.status, to)) return;
    db.run(
      "UPDATE messages SET status = ?, failure_reason = ?, updated_at = ? WHERE id = ?",
      to,
      to === "failed" ? reason : null,
      now(),
      id,
    );
    p.changes.push({ type: "message.updated", data: { message: getMessage(id)! } });
  };

  const insertAgentMessage = (
    p: Pending,
    session: AgentSessionRow,
    fields: { kind: "text" | "tool"; text: string; meta: Record<string, unknown> | null; dedupeKey: string },
  ) => {
    if (session.conversationId === null) return;
    const t = now();
    const row = db.get<MessageDbRow>(
      `INSERT INTO messages (conversation_id, session_id, ticket_id, sender, kind, text, meta, collapsed, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, ?, 'agent', ?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
      session.conversationId,
      session.id,
      session.ticketId,
      fields.kind,
      fields.text,
      fields.meta === null ? null : JSON.stringify(fields.meta),
      fields.kind === "tool" ? 1 : 0,
      fields.dedupeKey,
      t,
      t,
    );
    if (row !== undefined) p.changes.push({ type: "message.created", data: { message: toMessage(row) } });
  };

  const reportHealthIn = (p: Pending, module: HealthModule, error: string | null) => {
    const row = db.get<HealthDbRow>("SELECT * FROM health WHERE module = ?", module);
    const t = now();
    if (error === null) {
      if (row === undefined || (row.consecutive_failures === 0 && row.last_error === null)) return;
      db.run("UPDATE health SET consecutive_failures = 0, last_error = NULL, updated_at = ? WHERE module = ?", t, module);
    } else {
      db.run(
        `INSERT INTO health (module, consecutive_failures, last_error, updated_at) VALUES (?, 1, ?, ?)
         ON CONFLICT (module) DO UPDATE SET consecutive_failures = consecutive_failures + 1, last_error = excluded.last_error, updated_at = excluded.updated_at`,
        module,
        error,
        t,
      );
    }
    const updated = db.get<HealthDbRow>("SELECT * FROM health WHERE module = ?", module)!;
    p.changes.push({ type: "health.updated", data: { health: toHealth(updated) } });
  };

  const applyEvent = (p: Pending, session: AgentSessionRow, event: DriverEvent) => {
    const sessionId = session.id;
    switch (event.type) {
      case "session.started":
        updateLive(p, sessionId, (l) => {
          l.status = "running";
        });
        return;
      case "message.delivered":
      case "message.processing": {
        const to = event.type === "message.delivered" ? "delivered" : "processing";
        for (const id of event.messageIds) transition(p, id, to);
        updateLive(p, sessionId, working(liveOf(sessionId).currentTool));
        return;
      }
      case "agent.text":
        insertAgentMessage(p, session, {
          kind: "text",
          text: event.text,
          meta: null,
          dedupeKey: agentMessageDedupeKey(sessionId, event.uuid),
        });
        updateLive(p, sessionId, working(null));
        return;
      case "agent.tool":
        insertAgentMessage(p, session, {
          kind: "tool",
          text: summarizeToolCall(event.name, event.input),
          meta: { toolUseId: event.toolUseId, name: event.name, input: event.input },
          dedupeKey: agentMessageDedupeKey(sessionId, event.uuid, event.toolUseId),
        });
        updateLive(p, sessionId, working(event.name));
        return;
      case "turn.ended": {
        const reason = event.error === undefined ? "turn_failed" : `${event.error.subtype}: ${event.error.message}`;
        for (const id of event.messageIds) {
          if (event.interrupted) transition(p, id, "stopped");
          else if (event.ok) transition(p, id, "replied");
          else transition(p, id, "failed", reason);
        }
        updateLive(p, sessionId, idle);
        return;
      }
      case "rate_limit":
        updateLive(p, sessionId, (l) => {
          l.rateLimit = event.info;
        });
        return;
      case "session.exited": {
        for (const id of event.messageIds) {
          if (event.reason === "interrupt" || event.reason === "shutdown") transition(p, id, "stopped");
          else if (event.reason === "crash" || event.reason === "startup_failed") transition(p, id, "failed", exitFailureReason(event));
        }
        updateLive(p, sessionId, (l) => {
          idle(l);
          l.status = "idle";
        });
        return;
      }
      case "driver.error":
        for (const id of event.messageIds ?? []) transition(p, id, "failed", event.message);
        reportHealthIn(p, "driver", event.message);
        return;
    }
  };

  return {
    postUserMessage(input: PostUserMessageInput) {
      return write((p) => {
        if (!conversationExists(input.conversationId)) throw new ConversationNotFoundError(input.conversationId);
        const dedupeKey = userMessageDedupeKey(input.conversationId, input.clientId);
        const existing = db.get<{ id: number }>("SELECT id FROM messages WHERE dedupe_key = ?", dedupeKey);
        if (existing !== undefined) return { messageId: existing.id };
        const session = currentSession(input.conversationId);
        if (session === null) throw new Error(`conversation ${input.conversationId} has no agent session`);
        const t = now();
        const row = db.get<MessageDbRow>(
          `INSERT INTO messages (conversation_id, session_id, sender, kind, text, dedupe_key, status, created_at, updated_at)
           VALUES (?, ?, 'user', 'text', ?, ?, 'queued', ?, ?) RETURNING *`,
          input.conversationId,
          session.id,
          input.text,
          dedupeKey,
          t,
          t,
        )!;
        enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId: row.id, source: "user" } });
        p.changes.push({ type: "message.created", data: { message: toMessage(row) } });
        return { messageId: row.id };
      });
    },

    requestStop(conversationId) {
      if (!conversationExists(conversationId)) throw new ConversationNotFoundError(conversationId);
      const session = currentSession(conversationId);
      if (session === null) return;
      const inTurn =
        liveOf(session.id).activity !== "idle" ||
        db.get(
          `SELECT 1 AS x FROM messages WHERE session_id = ? AND status IN ${ACTIVE_MESSAGE_STATUSES} LIMIT 1`,
          session.id,
        ) !== undefined;
      if (!inTurn) return;
      write((p) => {
        updateLive(p, session.id, (l) => {
          l.activity = "stopping";
        });
        p.stops.push({ conversationId, sessionId: session.id });
      });
    },

    snapshot(): StateSnapshot {
      const conversations: ConversationSnapshot[] = db
        .all<ConversationDbRow>("SELECT * FROM conversations ORDER BY id")
        .map((row) => {
          const { messages, hasMore } = page(
            db.all<MessageDbRow>("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?", row.id, MESSAGE_PAGE_SIZE + 1),
          );
          return { conversation: toConversation(row), messages, hasMore };
        });
      return {
        seq: log.seq,
        pms: db.all<PmDbRow>("SELECT * FROM pms ORDER BY id").map(toPm),
        conversations,
        sessions: db.all<AgentSessionDbRow>("SELECT * FROM agent_sessions ORDER BY id").map((r) => sessionState(toAgentSessionRow(r))),
        health: db.all<HealthDbRow>("SELECT * FROM health ORDER BY module").map(toHealth),
      };
    },

    messagesBefore(conversationId, before) {
      return page(
        db.all<MessageDbRow>(
          "SELECT * FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
          conversationId,
          before,
          MESSAGE_PAGE_SIZE + 1,
        ),
      );
    },

    changesSince: (seq) => log.since(seq),
    onChange: (listener) => subscribe(changeListeners, listener),
    onStopRequested: (listener) => subscribe(stopListeners, listener),
    onActionEnqueued: (listener) => subscribe(actionListeners, listener),

    applyDriverEvent(sessionId, event) {
      const session = getAgentSession(db, sessionId);
      if (session === null) return;
      write((p) => applyEvent(p, session, event));
    },

    recoverAfterRestart() {
      return write((p) => {
        const rows = db.all<{ id: number; session_id: number; sender: string; status: string }>(
          `SELECT m.id, m.session_id, m.sender, m.status FROM messages m
           WHERE m.status IN ('queued', 'delivered', 'processing') AND m.session_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM actions a
               WHERE a.type = 'session.send' AND a.dedupe_key = CAST(m.id AS TEXT) AND a.status IN ('pending', 'running')
             )
           ORDER BY m.id`,
        );
        const resentMessageIds: MessageId[] = [];
        const requeuedMessageIds: MessageId[] = [];
        // 按最早一条被打断的消息排，旧的先恢复
        const recoveredSessionIds: SessionId[] = [];
        for (const row of rows) {
          const interrupted = row.status !== "queued";
          (interrupted ? resentMessageIds : requeuedMessageIds).push(row.id);
          if (interrupted && !recoveredSessionIds.includes(row.session_id)) recoveredSessionIds.push(row.session_id);
        }
        for (const sessionId of recoveredSessionIds) {
          const session = getAgentSession(db, sessionId)!;
          enqueue(p, { type: "session.start", params: { sessionId, generation: session.generation, recovery: true } });
        }
        for (const row of rows) {
          const source = row.sender === "system" ? "system" : "user";
          const resend = row.status !== "queued";
          enqueue(p, {
            type: "session.send",
            params: { sessionId: row.session_id, messageId: row.id, source, ...(resend ? { resend: true } : {}) },
          });
        }
        return { resentMessageIds, requeuedMessageIds, recoveredSessionIds };
      });
    },

    createPm(input: CreatePmInput): CreatePmResult {
      return write(() => {
        const t = now();
        const pmRow = db.get<PmDbRow>(
          "INSERT INTO pms (name, default_model, persona_file, created_at) VALUES (?, ?, ?, ?) RETURNING *",
          input.name,
          input.defaultModel ?? null,
          input.personaFile ?? null,
          t,
        )!;
        const conversationRow = db.get<ConversationDbRow>(
          "INSERT INTO conversations (kind, pm_id, title, created_at) VALUES ('pm', ?, ?, ?) RETURNING *",
          pmRow.id,
          input.name,
          t,
        )!;
        const cwd = join(input.pmHomeRoot, String(pmRow.id));
        mkdirSync(cwd, { recursive: true });
        const sessionId = db.run(
          `INSERT INTO agent_sessions (role, conversation_id, vendor_session_id, cwd, model, created_at, updated_at)
           VALUES ('pm', ?, ?, ?, ?, ?, ?)`,
          conversationRow.id,
          randomUUID(),
          cwd,
          input.defaultModel ?? null,
          t,
          t,
        ).lastInsertRowid;
        return { pm: toPm(pmRow), conversation: toConversation(conversationRow), sessionId };
      });
    },

    getMessage,

    onActionFailed(action, error) {
      if (action.type === "session.send") {
        write((p) => transition(p, action.params.messageId, "failed", error));
      } else {
        write((p) => reportHealthIn(p, "actions", error));
      }
    },

    reportHealth(module, error) {
      write((p) => reportHealthIn(p, module, error));
    },
  };
}
