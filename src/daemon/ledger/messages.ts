// 账本里的消息：用户发消息、停止、重试，驱动层事件变成 agent 的消息和消息状态，系统消息。
// 消息状态只按 MESSAGE_STATUS_TRANSITIONS 改（transition）。
import type { AnyActionRow } from "../../shared/actions.ts";
import type { MessagesPage } from "../../shared/api.ts";
import { agentMessageDedupeKey, canTransitionMessage, systemMessageDedupeKey, userMessageDedupeKey } from "../../shared/domain.ts";
import type { AgentSessionRow, ConversationId, Message, MessageId, MessageStatus, SessionId, SystemMessageMeta } from "../../shared/domain.ts";
import { turnFailureReason } from "../../shared/driver.ts";
import type { DriverEvent, SessionExitedEvent } from "../../shared/driver.ts";
import { ConversationNotFoundError } from "../../shared/ledger.ts";
import type { PostUserMessageInput, PostUserMessageResult } from "../../shared/ledger.ts";
import { MESSAGE_PAGE_SIZE } from "../../shared/limits.ts";
import { fail } from "./context.ts";
import type { LedgerContext, Pending } from "./context.ts";
import { toMessage } from "./rows.ts";
import type { MessageDbRow } from "./rows.ts";
import { idle, working } from "./sessions.ts";
import type { LedgerSessions } from "./sessions.ts";
import { summarizeToolCall } from "./tool-summary.ts";

const ACTIVE_MESSAGE_STATUSES = "('delivered', 'processing')";

export function exitFailureReason(event: SessionExitedEvent): string {
  if (event.signal !== null) return `${event.reason}: signal ${event.signal}`;
  if (event.exitCode !== null) return `${event.reason}: exit code ${event.exitCode}`;
  return event.reason;
}

/**
 * 守护进程关机打断的一轮（M3，m3-plan 第 3 节接口约定、验收第 11 条）：哪些消息不标已停止，还是已送达、处理中，
 * 重启恢复（sessions.ts 的 recoverAfterRestart）把它重发给同一个会话，接着做完：
 * - Worker 会话里的消息（任务说明、打回）：Worker 接着做完再汇报；也不发“这一轮没做完”（workers.ts）；
 * - 系统交给 agent 的消息（sender system：Worker 的汇报、turn_failed 那几行，见 workers.ts 的 insertLine）：
 *   项目经理重启后照样收到，不用等用户提醒。
 * 用户自己发的照 M2 标已停止，用户自己再发。
 */
export function resumesAfterShutdown(session: AgentSessionRow, message: Pick<MessageDbRow, "sender">): boolean {
  return session.role === "worker" || message.sender === "system";
}

export type LedgerMessages = ReturnType<typeof createLedgerMessages>;

export function createLedgerMessages(ctx: LedgerContext, sessions: LedgerSessions) {
  const { db, now, write, enqueue, reportHealthIn } = ctx;
  const { currentSession, liveOf, updateLive } = sessions;

  /** 老的项目群（11-03 拿掉了）当作不存在。 */
  const conversationExists = (id: ConversationId) =>
    db.get("SELECT 1 AS x FROM conversations WHERE id = ? AND kind != 'project_group'", id) !== undefined;

  const getMessage = (id: MessageId): Message | null => {
    const row = db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", id);
    return row === undefined ? null : toMessage(row);
  };

  const page = (rows: MessageDbRow[]): MessagesPage => {
    const hasMore = rows.length > MESSAGE_PAGE_SIZE;
    return { messages: rows.slice(0, MESSAGE_PAGE_SIZE).reverse().map(toMessage), hasMore };
  };

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
      `INSERT INTO messages (conversation_id, session_id, worker_id, sender, kind, text, meta, collapsed, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, ?, 'agent', ?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
      session.conversationId,
      session.id,
      session.workerId,
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

  /** 写一条只给人看的系统消息（规则见 domain.ts 的 SystemMessageMeta）：没有会话、没有状态。 */
  const insertSystemMessage = (p: Pending, conversationId: ConversationId, meta: SystemMessageMeta, text: string): Message => {
    const t = now();
    const row = db.get<MessageDbRow>(
      `INSERT INTO messages (conversation_id, sender, kind, text, meta, dedupe_key, created_at, updated_at)
       VALUES (?, 'system', 'text', ?, ?, ?, ?, ?) RETURNING *`,
      conversationId,
      text,
      JSON.stringify(meta),
      systemMessageDedupeKey(conversationId, meta),
      t,
      t,
    )!;
    const message = toMessage(row);
    p.changes.push({ type: "message.created", data: { message } });
    return message;
  };

  /** 关机打断时这条消息留着重启后重发（resumesAfterShutdown）。 */
  const keptAfterShutdown = (session: AgentSessionRow, id: MessageId) => {
    const row = db.get<Pick<MessageDbRow, "sender">>("SELECT sender FROM messages WHERE id = ?", id);
    return row !== undefined && resumesAfterShutdown(session, row);
  };

  const applyEvent = (p: Pending, session: AgentSessionRow, event: DriverEvent) => {
    const sessionId = session.id;
    switch (event.type) {
      case "session.started":
        // 状态（running）由驱动层写进那一行；这里只清掉上一次没等到退出的“正在停”
        updateLive(p, sessionId, (l) => {
          if (l.activity === "stopping") idle(l);
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
        const reason = event.error === undefined ? "turn_failed" : turnFailureReason(event.error);
        for (const id of event.messageIds) {
          if (event.shutdown === true && keptAfterShutdown(session, id)) continue;
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
      case "api_retry":
        updateLive(p, sessionId, (l) => {
          l.apiRetry = event.info;
        });
        return;
      case "session.exited": {
        for (const id of event.messageIds) {
          if (event.reason === "shutdown" && keptAfterShutdown(session, id)) continue;
          if (event.reason === "interrupt" || event.reason === "shutdown") transition(p, id, "stopped");
          else if (event.reason === "crash" || event.reason === "startup_failed") transition(p, id, "failed", exitFailureReason(event));
        }
        updateLive(p, sessionId, idle);
        return;
      }
      case "driver.error":
        for (const id of event.messageIds ?? []) transition(p, id, "failed", event.message);
        reportHealthIn(p, "driver", event.message);
        return;
    }
  };

  const postUserMessage = (input: PostUserMessageInput): PostUserMessageResult => {
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
  };

  const requestStop = (conversationId: ConversationId) => {
    if (!conversationExists(conversationId)) throw new ConversationNotFoundError(conversationId);
    const session = currentSession(conversationId);
    if (session === null) return;
    const working = liveOf(session.id).activity !== "idle";
    // 重启后内存里是空闲、库里还有处理中的消息：进程不在，只记下停止请求，不标“正在停”（不会有事件把它清掉）
    const leftover =
      !working &&
      db.get(
        `SELECT 1 AS x FROM messages WHERE session_id = ? AND status IN ${ACTIVE_MESSAGE_STATUSES} LIMIT 1`,
        session.id,
      ) !== undefined;
    if (!working && !leftover) return;
    write((p) => {
      if (working) {
        updateLive(p, session.id, (l) => {
          l.activity = "stopping";
        });
      }
      p.stops.push({ conversationId, sessionId: session.id });
    });
  };

  const messagesBefore = (conversationId: ConversationId, before: MessageId): MessagesPage => {
    if (!conversationExists(conversationId)) throw new ConversationNotFoundError(conversationId);
    return page(
      db.all<MessageDbRow>(
        "SELECT * FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
        conversationId,
        before,
        MESSAGE_PAGE_SIZE + 1,
      ),
    );
  };

  /** 动作彻底失败（在 ledger.onActionFailed 的事务里）：session.send 的那条消息标 failed。Worker 的另见 workers.ts。 */
  const actionFailedIn = (p: Pending, action: AnyActionRow, error: string) => {
    // session.start 失败时执行器每次都已经记过 health，这里不再记
    if (action.type === "session.send") transition(p, action.params.messageId, "failed", error);
  };

  /** 只停写进去了的（已送达、处理中）；排队中的不归它管（queued → stopped 只给 Worker 收工用，见 workers.ts）。 */
  const stopMessage = (messageId: MessageId) => {
    write((p) => {
      const status = getMessage(messageId)?.status;
      if (status === "delivered" || status === "processing") transition(p, messageId, "stopped");
    });
  };

  const retryMessage = (messageId: MessageId): { messageId: MessageId } => {
    return write((p) => {
      const message = getMessage(messageId);
      // 老项目群里的消息也当作没有（群对外不存在）
      if (message === null || !conversationExists(message.conversationId)) throw fail("not_found", `没有编号 ${messageId} 的消息`);
      if (message.sender !== "user") throw fail("conflict", "只能重试自己发的消息");
      if (message.status !== "failed") throw fail("conflict", "只有发送失败的消息能重试");
      const session = currentSession(message.conversationId);
      if (session === null) throw new Error(`conversation ${message.conversationId} has no agent session`);
      db.run(
        "UPDATE messages SET status = 'queued', failure_reason = NULL, session_id = ?, updated_at = ? WHERE id = ?",
        session.id,
        now(),
        messageId,
      );
      enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId, source: "user" } });
      p.changes.push({ type: "message.updated", data: { message: getMessage(messageId)! } });
      return { messageId };
    });
  };

  return {
    getMessage,
    page,
    transition,
    applyEvent,
    insertSystemMessage,
    postUserMessage,
    requestStop,
    messagesBefore,
    actionFailedIn,
    stopMessage,
    retryMessage,
  };
}
