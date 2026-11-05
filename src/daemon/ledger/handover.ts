// 开新会话（资料页的按钮）：项目经理的上下文太长时，先让它写交接，再换一个新的 claude 会话接着干。用户看来还是同一个对话。
// 1. renewSession：给现在这一代会话发一条 handover.requested（source system），忙时照常在驱动层排队，等这一轮结束再写；
// 2. 那一轮正常结束（applyDriverEvent → afterDriverEvent）时同一个事务里换代：旧会话登记 session.end；建 generation + 1 的会话
//    （工作目录、模型、思考程度抄旧的；提示词、启动参数照常由启动准备按项目经理现在的设置拼）；新会话的第一条是 session.renewed：
//    交接全文 + 交接之前最近 HANDOVER_RECENT_MESSAGES 条用户和项目经理的原话；
// 3. 换代期间（交接请求 H、新会话第一条 R 还没结果）这个对话里同一代或更晚的别的消息都压着（waitsForHandover），换代时改发给新会话；
// 4. H 没写成（失败、被停止）：不换代，对话里提示一句；R 没送成：原地重新排队（退避），最多 HANDOVER_RENEW_RETRIES 次，
//    还不行就放行压着的消息、提示一句，再点“开新会话”把同一条 R 重新排队。
// 换代和那一轮的结果在同一个事务里：重启只会落在换代前（交接请求按“至少一次”重发给旧会话）或换代后，不会换两次。
// H、R 的 meta 里另记几个字段（只有这里用）：turnStartId（H 开始处理时库里最大的消息编号）、attempts（R 重排了几次）、
// settled（这次没成已经处理过：提示过或重排过，不再处理；重新排队时清掉）、notices（提示过几次，做去重键）。
import { agentTextOf } from "../../shared/attachments.ts";
import { systemEventOf, systemMessageDedupeKey } from "../../shared/domain.ts";
import type { AgentSessionRow, ConversationId, MessageId, PmId, SystemMessageMeta } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import { ACTION_RETRY, retryDelayMs } from "../../shared/actions.ts";
import type { AnyActionRow } from "../../shared/actions.ts";
import { HANDOVER_RECENT_MESSAGES, HANDOVER_RENEW_RETRIES } from "../../shared/limits.ts";
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

/** H 没写成时对话里的提示。 */
export const HANDOVER_NOT_WRITTEN_TEXT = "交接没写成，没换会话";
/** R 重排次数用完时对话里的提示。 */
export function renewFailedText(reason: string): string {
  return `新会话没接上交接（${reason}），可以再点一次开新会话`;
}

/** H、R 的 meta（SystemMessageMeta 加上只有这里用的几个字段，见文件开头）。 */
type HandoverMeta = SystemMessageMeta & { turnStartId?: number; attempts?: number; settled?: boolean; notices?: number };

const IN_FLIGHT = "('queued', 'delivered', 'processing')";

export type LedgerHandover = ReturnType<typeof createLedgerHandover>;

export function createLedgerHandover(ctx: LedgerContext, sessions: LedgerSessions, messages: LedgerMessages, persona: LedgerPersona) {
  const { db, now, write, enqueue } = ctx;
  const { currentSession, insertSession, updateLive } = sessions;
  const { getMessage, insertSystemMessage } = messages;
  const { requirePm, privateConversation } = persona;

  const metaOf = (row: Pick<MessageDbRow, "meta">): HandoverMeta => JSON.parse(row.meta!) as HandoverMeta;

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

  /** H 或 R 原地重新排队：状态回到 queued、改 meta，重新登记 session.send（delayMs 后才发）。 */
  const requeue = (p: Pending, row: MessageDbRow, meta: HandoverMeta, delayMs = 0) => {
    const t = now();
    db.run("UPDATE messages SET status = 'queued', failure_reason = NULL, meta = ?, updated_at = ? WHERE id = ?", JSON.stringify(meta), t, row.id);
    enqueue(p, { type: "session.send", params: { sessionId: row.session_id!, messageId: row.id, source: "system" } });
    if (delayMs > 0) db.run("UPDATE actions SET next_attempt_at = ? WHERE type = 'session.send' AND dedupe_key = ?", t + delayMs, String(row.id));
    p.changes.push({ type: "message.updated", data: { message: getMessage(row.id)! } });
  };

  /** 对话里最新的一条 H 或 R。 */
  const latest = (conversationId: ConversationId, event: "handover.requested" | "session.renewed"): MessageDbRow | undefined =>
    db.get<MessageDbRow>(
      `SELECT * FROM messages WHERE conversation_id = ? AND sender = 'system' AND kind = 'text' AND json_extract(meta, '$.event') = ?
       ORDER BY id DESC LIMIT 1`,
      conversationId,
      event,
    );

  const renewSession = (pmId: PmId): { messageId: MessageId } =>
    write((p) => {
      requirePm(pmId);
      const conversation = privateConversation(pmId)!;
      const session = currentSession(conversation.id)!;
      // 新会话的第一条还没结果：就是它（再发 H 会和它互相等）；重排次数用完了：同一条重新排队，次数清零
      const renewed = latest(conversation.id, "session.renewed");
      if (renewed !== undefined && renewed.session_id === session.id) {
        if (["queued", "delivered", "processing"].includes(renewed.status!)) return { messageId: renewed.id };
        if (renewed.status === "failed" || renewed.status === "stopped") {
          requeue(p, renewed, { ...metaOf(renewed), attempts: 0, settled: false });
          return { messageId: renewed.id };
        }
      }
      const meta: SystemMessageMeta = { event: "handover.requested", sessionId: session.id };
      // 每一代最多一条交接请求：还在等就是它；上一次被停止、失败了，同一条重新排队（和用户点重试一样）
      const existing = db.get<MessageDbRow>("SELECT * FROM messages WHERE dedupe_key = ?", systemMessageDedupeKey(conversation.id, meta));
      if (existing === undefined) return { messageId: insertQueued(p, session, meta, HANDOVER_REQUEST_TEXT) };
      if (existing.status === "stopped" || existing.status === "failed") requeue(p, existing, { ...metaOf(existing), settled: false });
      return { messageId: existing.id };
    });

  /** 同一代或更早的 H、R 还没结果（排队、已送达、处理中）就压着；R 自己不压（它是新会话的第一条）。 */
  const waitsForHandover = (messageId: MessageId): boolean =>
    db.get(
      `SELECT 1 AS x FROM messages m JOIN agent_sessions ms ON ms.id = m.session_id
       JOIN messages h ON h.conversation_id = m.conversation_id JOIN agent_sessions hs ON hs.id = h.session_id
       WHERE m.id = ? AND h.id != m.id AND hs.generation <= ms.generation
         AND NOT (m.sender = 'system' AND m.kind = 'text' AND json_extract(m.meta, '$.event') = 'session.renewed')
         AND h.sender = 'system' AND h.kind = 'text' AND json_extract(h.meta, '$.event') IN ('handover.requested', 'session.renewed')
         AND h.status IN ${IN_FLIGHT}
       LIMIT 1`,
      messageId,
    ) !== undefined;

  /** 换代。request 是旧会话里刚回完的交接请求。 */
  const renew = (p: Pending, old: AgentSessionRow, request: MessageDbRow) => {
    const conversationId = old.conversationId!;
    // 交接那一轮开始时库里最大的编号：交接全文取它之后的文字，最近原话取它之前（含）已回复的（不带还排着的、没发成的）
    const turnStart = metaOf(request).turnStartId ?? request.id;
    const handover = db
      .all<{ text: string }>("SELECT text FROM messages WHERE session_id = ? AND sender = 'agent' AND kind = 'text' AND id > ? ORDER BY id", old.id, turnStart)
      .map((r) => r.text)
      .join("\n\n");
    const recent = db
      .all<MessageDbRow>(
        `SELECT * FROM messages WHERE conversation_id = ? AND id <= ? AND kind = 'text'
           AND (sender = 'agent' OR (sender = 'user' AND status = 'replied'))
         ORDER BY id DESC LIMIT ?`,
        conversationId,
        turnStart,
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
    // 旧会话刚报额度用完的话，新会话也要知道，不然第一条立刻撞上额度失败
    if (old.rateLimit !== null) {
      db.run("UPDATE agent_sessions SET rate_limit = ? WHERE id = ?", JSON.stringify(old.rateLimit), next.id);
      updateLive(p, next.id, () => {});
    }
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

  /** 对话里提示一句（只给人看），记下提示过几次（同一条重新排队后又没成，再提示一次）。 */
  const notify = (p: Pending, row: MessageDbRow, meta: HandoverMeta, text: string) => {
    const attempt = (meta.notices ?? 0) + 1;
    db.run("UPDATE messages SET meta = ? WHERE id = ?", JSON.stringify({ ...meta, settled: true, notices: attempt }), row.id);
    insertSystemMessage(p, row.conversation_id, { event: "handover.failed", messageId: row.id, attempt }, text);
  };

  /** 这个对话里刚没成（失败、被停止）还没处理过的 H、R：H 提示一句；R 重新排队，次数用完提示一句。 */
  const settleFailures = (p: Pending, conversationId: ConversationId) => {
    const rows = db.all<MessageDbRow>(
      `SELECT * FROM messages WHERE conversation_id = ? AND sender = 'system' AND kind = 'text' AND status IN ('failed', 'stopped')
         AND json_extract(meta, '$.event') IN ('handover.requested', 'session.renewed') AND json_extract(meta, '$.settled') IS NOT 1`,
      conversationId,
    );
    for (const row of rows) {
      const meta = metaOf(row);
      if (meta.event === "handover.requested") {
        notify(p, row, meta, HANDOVER_NOT_WRITTEN_TEXT);
        continue;
      }
      const attempts = meta.attempts ?? 0;
      if (attempts < HANDOVER_RENEW_RETRIES) requeue(p, row, { ...meta, attempts: attempts + 1 }, retryDelayMs(ACTION_RETRY["session.send"], attempts + 1));
      else notify(p, row, meta, renewFailedText(row.failure_reason ?? (row.status === "stopped" ? "被停止了" : "没送成")));
    }
  };

  const afterDriverEvent = (p: Pending, session: AgentSessionRow, event: DriverEvent) => {
    if (session.role !== "pm" || session.conversationId === null) return;
    // H 开始处理：记下那一刻库里最大的编号（之后的文字才是交接）
    if (event.type === "message.processing") {
      for (const id of event.messageIds) {
        const row = db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", id);
        if (row === undefined || row.sender !== "system" || systemEventOf(toMessage(row))?.event !== "handover.requested") continue;
        const max = db.get<{ id: number }>("SELECT max(id) AS id FROM messages")!.id;
        db.run("UPDATE messages SET meta = ? WHERE id = ?", JSON.stringify({ ...metaOf(row), turnStartId: max }), id);
      }
      return;
    }
    // 只有这几种事件会把消息标成失败、已停止
    if (event.type === "turn.ended" || event.type === "session.exited" || event.type === "driver.error") settleFailures(p, session.conversationId);
    // 交接请求那一轮正常结束（已回复），而且它的会话还是最新一代（重放的同一个事件不会再换）：换代
    if (event.type !== "turn.ended" || !event.ok || event.interrupted) return;
    for (const id of event.messageIds) {
      const row = db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", id);
      const meta = row === undefined ? null : systemEventOf(toMessage(row));
      if (meta?.event !== "handover.requested" || row!.status !== "replied" || meta.sessionId !== session.id) continue;
      if (currentSession(session.conversationId)?.id !== session.id) return;
      renew(p, session, row!);
      return;
    }
  };

  /** session.send 次数用完（ledger.onActionFailed，消息已经标了 failed）：H、R 一样处理。 */
  const actionFailedIn = (p: Pending, action: AnyActionRow) => {
    if (action.type !== "session.send") return;
    const conversationId = getMessage(action.params.messageId)?.conversationId;
    if (conversationId !== undefined) settleFailures(p, conversationId);
  };

  return { renewSession, waitsForHandover, afterDriverEvent, actionFailedIn };
}
