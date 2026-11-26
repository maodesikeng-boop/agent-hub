import { agentMessageDedupeKey } from "../../shared/domain.ts";
import type { AgentSessionRow, ConversationId, MessageId, SessionId } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import { replyIdOf } from "../../shared/turn-reply.ts";
import type { TurnReplyView } from "../../shared/turn-reply.ts";
import type { LedgerContext, Pending } from "./context.ts";
import { toMessage } from "./rows.ts";
import type { MessageDbRow } from "./rows.ts";
import type { TurnCompletionFacts } from "./turn-completions.ts";

export interface LedgerTurnReplies {
  afterDriverEvent(p: Pending, session: AgentSessionRow, event: DriverEvent): void;
  turnReplyOf(messageId: MessageId): TurnReplyView | null;
  activeTurns(): number;
  factsOf(session: AgentSessionRow, ids: readonly MessageId[]): Pick<TurnCompletionFacts, "reply" | "finishedWithText">;
  settle(p: Pending, session: AgentSessionRow, ids: readonly MessageId[], reply: TurnCompletionFacts["reply"]): void;
}

interface TurnState {
  lastText: MessageId | null;
  lastOutput: { id: MessageId; kind: "text" | "tool" } | null;
  deliveredAt: Map<MessageId, { mark: number; awaitingProcessing: boolean; scheduleRun: boolean }>;
}

const SCHEDULE_RUN_SQL = `sender = 'system' AND CASE WHEN json_valid(meta) THEN json_extract(meta, '$.event') IS 'schedule.run' ELSE 0 END`;

export function createLedgerTurnReplies(ctx: LedgerContext): LedgerTurnReplies {
  const { db, now } = ctx;
  const turns = new Map<SessionId, TurnState>();

  const stateOf = (sessionId: SessionId): TurnState => {
    let st = turns.get(sessionId);
    if (st === undefined) {
      st = { lastText: null, lastOutput: null, deliveredAt: new Map() };
      turns.set(sessionId, st);
    }
    return st;
  };

  const dropDelivered = (sessionId: SessionId, ids: readonly MessageId[]) => {
    const st = turns.get(sessionId);
    if (st === undefined) return;
    for (const id of ids) st.deliveredAt.delete(id);
    if (st.deliveredAt.size === 0 && st.lastText === null && st.lastOutput === null) turns.delete(sessionId);
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
      const row = db.get<{ sender: string; conversation_id: ConversationId; session_id: SessionId | null; schedule_run: number }>(
        `SELECT sender, conversation_id, session_id, (${SCHEDULE_RUN_SQL}) AS schedule_run FROM messages WHERE id = ?`,
        id,
      );
      if (row?.conversation_id !== session.conversationId || row.session_id !== session.id) continue;
      const scheduleRun = session.role === "pm" && row.schedule_run === 1;
      if (row.sender !== "user" && !scheduleRun) continue;
      const midTurn = event.type === "message.delivered" && event.midTurn === true;
      stateOf(session.id).deliveredAt.set(id, { mark: maxMessageId(), awaitingProcessing: midTurn, scheduleRun });
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

  const factsOf: LedgerTurnReplies["factsOf"] = (session, ids) => {
    const state = turns.get(session.id);
    const followsDelivery = (id: MessageId, output: MessageId) => output > (state?.deliveredAt.get(id)?.mark ?? Infinity);
    const text = state?.lastText ?? null;
    const output = state?.lastOutput;
    return {
      reply: session.role !== "pm" || text === null ? null : { messageId: text, requestIds: ids.filter((id) => followsDelivery(id, text)) },
      finishedWithText: output?.kind === "text"
        ? ids.filter((id) => !state?.deliveredAt.get(id)?.scheduleRun && followsDelivery(id, output.id))
        : [],
    };
  };

  const settle: LedgerTurnReplies["settle"] = (p, session, ids, fact) => {
    p.after.push(() => {
      const state = turns.get(session.id);
      if (state === undefined) return;
      state.lastText = null;
      state.lastOutput = null;
      dropDelivered(session.id, ids);
    });
    if (fact === null || session.role !== "pm") return;
    const reply = fact.messageId;
    if (!db.get("SELECT 1 FROM messages WHERE id = ? AND session_id = ? AND sender = 'agent' AND kind = 'text'", reply, session.id)) return;
    for (const id of fact.requestIds) {
      if (!ids.includes(id)) continue;
      const row = db.get<Pick<MessageDbRow, "id">>(
        `SELECT id FROM messages WHERE id = ? AND status = 'replied' AND session_id = ? AND conversation_id = ?
          AND (sender = 'user' OR (${SCHEDULE_RUN_SQL}))
          AND CASE WHEN json_valid(meta) THEN
            NOT (json_type(meta, '$.replyId') IS 'integer' AND json_extract(meta, '$.replyId') > 0)
          ELSE meta IS NULL END`,
        id, session.id, session.conversationId,
      );
      if (row === undefined) continue;
      db.run("UPDATE messages SET meta = json_set(COALESCE(meta, '{}'), '$.replyId', ?), updated_at = ? WHERE id = ?", reply, now(), id);
      const updated = toMessage(db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", id)!);
      // The status change already pushed a message.updated in this transaction; replace it instead of pushing two.
      const pushed = p.changes.findIndex((c) => c.type === "message.updated" && c.data.message.id === id);
      if (pushed >= 0) p.changes[pushed] = { type: "message.updated", data: { message: updated } };
      else p.changes.push({ type: "message.updated", data: { message: updated } });
    }
  };

  return {
    factsOf,
    settle,
    afterDriverEvent(_p, session, event) {
      if (session.role === "assistant") return;
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
        case "agent.tool": {
          const key = agentMessageDedupeKey(session.id, event.uuid, event.type === "agent.tool" ? event.toolUseId : undefined);
          const row = db.get<{ id: MessageId; kind: "text" | "tool" }>("SELECT id, kind FROM messages WHERE dedupe_key = ?", key);
          if (row !== undefined) {
            const state = stateOf(session.id);
            if (state.lastOutput === null || row.id > state.lastOutput.id) state.lastOutput = row;
          }
          if (event.type === "agent.text" && event.parentToolUseId === undefined && session.role === "pm") recordText(session, event.uuid);
          return;
        }
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
