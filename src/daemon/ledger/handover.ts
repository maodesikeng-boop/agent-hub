// 开新会话（资料页的按钮）：项目经理的上下文太长时，先让它写交接，再换一个新的 claude 会话接着干。用户看来还是同一个对话。
// 1. renewSession：给现在这一代会话发一条 handover.requested（source system），忙时照常在驱动层排队，等这一轮结束再写；
// 2. 那一轮正常结束（applyDriverEvent → afterDriverEvent）时同一个事务里换代：旧会话登记 session.end；建 generation + 1 的会话
//    （工作目录、模型、思考程度抄旧的；提示词、启动参数照常由启动准备按项目经理现在的设置拼）；新会话的第一条是 session.renewed：
//    交接全文 + 交接之前最近 HANDOVER_RECENT_MESSAGES 条用户和项目经理的原话；
// 3. 换代期间（交接请求还没结果、新会话的第一条还在排队）这个对话里别的消息都压着（waitsForHandover），换代时改发给新会话。
// 换代和那一轮的结果在同一个事务里：重启只会落在换代前（交接请求按“至少一次”重发给旧会话）或换代后，不会换两次。
import { agentTextOf } from "../../shared/attachments.ts";
import { systemEventOf, systemMessageDedupeKey } from "../../shared/domain.ts";
import type { AgentSessionRow, MessageId, PmId, SystemMessageMeta } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import { HANDOVER_RECENT_MESSAGES } from "../../shared/limits.ts";
import type { AgentVendor } from "../../shared/vendors.ts";
import type { LedgerContext, Pending } from "./context.ts";
import type { LedgerMessages } from "./messages.ts";
import type { LedgerPersona } from "./persona.ts";
import { toMessage } from "./rows.ts";
import type { MessageDbRow } from "./rows.ts";
import type { LedgerSessions } from "./sessions.ts";

/** 发给旧会话：让项目经理把交接写成这一轮的回复。 */
export const HANDOVER_REQUEST_TEXT = `【系统】用户要给你换一个新会话（现在的上下文太长了）。请在这一轮写一份交接，直接写成这一轮的回复：新会话看不到现在的上下文，只看得到这份交接和最近 ${HANDOVER_RECENT_MESSAGES} 条你和用户的原话。
交接写清楚：现状、已经定下的事、正在做的事、还在跑的 Worker 和 PR（编号、在做什么、到哪一步了）、下一步。这一轮只写交接，不做别的事。`;

/** 发给新会话的第一条：交接 + 最近几条原话。 */
export function renewedText(handover: string, recent: { sender: string; text: string }[]): string {
  const lines = recent.map((m) => `${m.sender === "user" ? "用户" : "你"}：${m.text}`).join("\n\n");
  return [
    "【系统】这是新会话：你还是同一个项目经理，接着上一个会话干（上一个会话太长，写完交接后换成了你）。下面是上一个会话写的交接，和交接之前最近几条你和用户的原话。还在跑的 Worker 照常会把汇报发给你。读完简短回一句“已接上”，然后等用户或 Worker 的消息。",
    `## 交接\n\n${handover.trim() === "" ? "（上一个会话没有写交接）" : handover}`,
    `## 最近的原话\n\n${lines === "" ? "（没有）" : lines}`,
  ].join("\n\n");
}

export type LedgerHandover = ReturnType<typeof createLedgerHandover>;

export function createLedgerHandover(ctx: LedgerContext, sessions: LedgerSessions, messages: LedgerMessages, persona: LedgerPersona) {
  const { db, now, write, enqueue } = ctx;
  const { currentSession, insertSession } = sessions;
  const { getMessage } = messages;
  const { requirePm, privateConversation } = persona;

  /** 一条要发给 agent 的系统消息（有会话、从 queued 起走），登记 session.send。 */
  const insertQueued = (p: Pending, session: AgentSessionRow, meta: SystemMessageMeta, text: string): MessageId => {
    const t = now();
    const row = db.get<MessageDbRow>(
      `INSERT INTO messages (conversation_id, session_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, 'system', 'text', ?, ?, ?, 'queued', ?, ?) RETURNING *`,
      session.conversationId,
      session.id,
      text,
      JSON.stringify(meta),
      systemMessageDedupeKey(session.conversationId!, meta),
      t,
      t,
    )!;
    p.changes.push({ type: "message.created", data: { message: toMessage(row) } });
    enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId: row.id, source: "system" } });
    return row.id;
  };

  const renewSession = (pmId: PmId): { messageId: MessageId } =>
    write((p) => {
      requirePm(pmId);
      const conversation = privateConversation(pmId)!;
      const session = currentSession(conversation.id)!;
      const meta: SystemMessageMeta = { event: "handover.requested", sessionId: session.id };
      // 每一代最多一条交接请求：还在等就是它；上一次被停止、失败了，同一条重新排队（和用户点重试一样）
      const existing = db.get<MessageDbRow>("SELECT * FROM messages WHERE dedupe_key = ?", systemMessageDedupeKey(conversation.id, meta));
      if (existing === undefined) return { messageId: insertQueued(p, session, meta, HANDOVER_REQUEST_TEXT) };
      if (existing.status === "stopped" || existing.status === "failed") {
        db.run("UPDATE messages SET status = 'queued', failure_reason = NULL, updated_at = ? WHERE id = ?", now(), existing.id);
        enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId: existing.id, source: "system" } });
        p.changes.push({ type: "message.updated", data: { message: getMessage(existing.id)! } });
      }
      return { messageId: existing.id };
    });

  const waitsForHandover = (messageId: MessageId): boolean =>
    db.get(
      `SELECT 1 AS x FROM messages m JOIN messages h ON h.conversation_id = m.conversation_id
       WHERE m.id = ? AND h.id != m.id AND h.sender = 'system' AND h.kind = 'text'
         AND ((json_extract(h.meta, '$.event') = 'handover.requested' AND h.status IN ('queued', 'delivered', 'processing'))
           OR (json_extract(h.meta, '$.event') = 'session.renewed' AND h.status = 'queued'))
       LIMIT 1`,
      messageId,
    ) !== undefined;

  /** 换代。request 是旧会话里刚回完的交接请求。 */
  const renew = (p: Pending, old: AgentSessionRow, request: MessageId) => {
    const conversationId = old.conversationId!;
    const handover = db
      .all<{ text: string }>("SELECT text FROM messages WHERE session_id = ? AND sender = 'agent' AND kind = 'text' AND id > ? ORDER BY id", old.id, request)
      .map((r) => r.text)
      .join("\n\n");
    const recent = db
      .all<MessageDbRow>(
        `SELECT * FROM messages WHERE conversation_id = ? AND id < ? AND kind = 'text' AND sender IN ('user', 'agent') ORDER BY id DESC LIMIT ?`,
        conversationId,
        request,
        HANDOVER_RECENT_MESSAGES,
      )
      .reverse()
      .map((row) => ({ sender: row.sender, text: agentTextOf(toMessage(row)) }));

    const next = insertSession(p, {
      conversationId,
      pmId: old.pmId,
      cwd: old.cwd,
      addDirs: old.addDirs,
      generation: old.generation + 1,
      vendor: old.vendor as AgentVendor,
      model: old.model,
      effort: old.effort,
    });
    enqueue(p, { type: "session.end", params: { sessionId: old.id, generation: old.generation } });
    insertQueued(p, next, { event: "session.renewed", sessionId: next.id, fromSessionId: old.id }, renewedText(handover, recent));
    // 换代期间压着的消息（用户的、Worker 的汇报）改发给新会话，排在交接后面
    const held = db.all<MessageDbRow>("SELECT * FROM messages WHERE session_id = ? AND status = 'queued' ORDER BY id", old.id);
    for (const row of held) {
      db.run("UPDATE messages SET session_id = ?, updated_at = ? WHERE id = ?", next.id, now(), row.id);
      enqueue(p, { type: "session.send", params: { sessionId: next.id, messageId: row.id, source: row.sender === "system" ? "system" : "user" } });
      p.changes.push({ type: "message.updated", data: { message: getMessage(row.id)! } });
    }
  };

  /** 交接请求那一轮正常结束（已回复），而且它的会话还是最新一代（重放的同一个事件不会再换）：换代。 */
  const afterDriverEvent = (p: Pending, session: AgentSessionRow, event: DriverEvent) => {
    if (event.type !== "turn.ended" || !event.ok || event.interrupted || session.role !== "pm" || session.conversationId === null) return;
    for (const id of event.messageIds) {
      const message = getMessage(id);
      const meta = message === null ? null : systemEventOf(message);
      if (meta?.event !== "handover.requested" || message!.status !== "replied" || meta.sessionId !== session.id) continue;
      if (currentSession(session.conversationId)?.id !== session.id) return;
      renew(p, session, id);
      return;
    }
  };

  return { renewSession, waitsForHandover, afterDriverEvent };
}
