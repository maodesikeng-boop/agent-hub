import { agentMessageDedupeKey } from "../../shared/domain.ts";
import type { AgentSessionRow, ConversationId, MessageId, SessionId } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import { replyIdOf } from "../../shared/turn-reply.ts";
import type { TurnReplyView } from "../../shared/turn-reply.ts";
import type { LedgerContext, Pending } from "./context.ts";
import { toMessage } from "./rows.ts";
import type { MessageDbRow } from "./rows.ts";

export interface LedgerTurnReplies {
  afterDriverEvent(p: Pending, session: AgentSessionRow, event: DriverEvent): void;
  turnReplyOf(messageId: MessageId): TurnReplyView | null;
  activeTurns(): number;
}

interface TurnState {
  lastText: MessageId | null;
  deliveredAt: Map<MessageId, { mark: number; awaitingProcessing: boolean }>;
}

export function createLedgerTurnReplies(ctx: LedgerContext): LedgerTurnReplies {
  const { db, now } = ctx;
  const turns = new Map<SessionId, TurnState>();

  const stateOf = (sessionId: SessionId): TurnState => {
    let st = turns.get(sessionId);
    if (st === undefined) {
      st = { lastText: null, deliveredAt: new Map() };
      turns.set(sessionId, st);
    }
    return st;
  };

  const dropDelivered = (sessionId: SessionId, ids: readonly MessageId[]) => {
    const st = turns.get(sessionId);
    if (st === undefined) return;
    for (const id of ids) st.deliveredAt.delete(id);
    if (st.deliveredAt.size === 0 && st.lastText === null) turns.delete(sessionId);
  };

  const maxMessageId = (): MessageId => db.get<{ id: number | null }>("SELECT max(id) AS id FROM messages")!.id ?? 0;

  const recordDelivery = (session: AgentSessionRow, event: Extract<DriverEvent, { type: "message.delivered" | "message.processing" }>) => {
    for (const id of event.messageIds) {
      const known = turns.get(session.id)?.deliveredAt.get(id);
      if (known !== undefined) {
        if (event.type === "message.processing" && known.awaitingProcessing) {
          known.mark = maxMessageId();
          known.awaitingProcessing = false;
        }
        continue;
      }
      const row = db.get<{ sender: string; conversation_id: ConversationId }>("SELECT sender, conversation_id FROM messages WHERE id = ?", id);
      if (row?.sender !== "user" || row.conversation_id !== session.conversationId) continue;
      const midTurn = event.type === "message.delivered" && event.midTurn === true;
      stateOf(session.id).deliveredAt.set(id, { mark: maxMessageId(), awaitingProcessing: midTurn });
    }
  };

  const recordText = (session: AgentSessionRow, uuid: string) => {
    const row = db.get<{ id: MessageId; meta: string | null }>(
      "SELECT id, meta FROM messages WHERE dedupe_key = ? AND kind = 'text'",
      agentMessageDedupeKey(session.id, uuid),
    );
    if (row === undefined) return;
    const meta = row.meta === null ? null : (JSON.parse(row.meta) as Record<string, unknown>);
    if (meta?.["handover"] === true) return;
    const st = stateOf(session.id);
    if (st.lastText === null || row.id > st.lastText) st.lastText = row.id;
  };

  const finishTurn = (p: Pending, session: AgentSessionRow, ids: readonly MessageId[]) => {
    const st = turns.get(session.id);
    if (st === undefined) return;
    const reply = st.lastText;
    for (const id of ids) {
      const mark = st.deliveredAt.get(id)?.mark;
      st.deliveredAt.delete(id);
      if (reply === null || mark === undefined || reply <= mark) continue;
      const row = db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", id);
      if (row === undefined || row.sender !== "user" || row.status !== "replied" || row.conversation_id !== session.conversationId) continue;
      if (replyIdOf(toMessage(row)) !== null) continue;
      db.run("UPDATE messages SET meta = json_set(COALESCE(meta, '{}'), '$.replyId', ?), updated_at = ? WHERE id = ?", reply, now(), id);
      const updated = toMessage(db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", id)!);
      // The status change already pushed a message.updated in this transaction; replace it instead of pushing two.
      const pushed = p.changes.findIndex((c) => c.type === "message.updated" && c.data.message.id === id);
      if (pushed >= 0) p.changes[pushed] = { type: "message.updated", data: { message: updated } };
      else p.changes.push({ type: "message.updated", data: { message: updated } });
    }
    st.lastText = null;
    if (st.deliveredAt.size === 0) turns.delete(session.id);
  };

  return {
    afterDriverEvent(p, session, event) {
      if (session.role !== "pm") return;
      switch (event.type) {
        case "message.delivered":
        case "message.processing":
          recordDelivery(session, event);
          return;
        case "message.cancelled":
        case "message.requeued":
          dropDelivered(session.id, event.messageIds);
          return;
        case "driver.error":
          dropDelivered(session.id, event.messageIds ?? []);
          return;
        case "agent.text":
          if (event.parentToolUseId === undefined) recordText(session, event.uuid);
          return;
        case "turn.ended":
          finishTurn(p, session, event.messageIds);
          return;
        case "session.exited":
          turns.delete(session.id);
          return;
        default:
          return;
      }
    },

    activeTurns: () => turns.size,

    turnReplyOf(messageId) {
      const row = db.get<MessageDbRow>(
        `SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ? AND m.sender = 'user' AND c.kind = 'pm'`,
        messageId,
      );
      if (row === undefined) return null;
      const request = toMessage(row);
      const replyId = replyIdOf(request);
      const replyRow =
        replyId === null
          ? undefined
          : db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ? AND conversation_id = ? AND sender = 'agent' AND kind = 'text'", replyId, request.conversationId);
      return { request, reply: replyRow === undefined ? null : toMessage(replyRow) };
    },
  };
}
