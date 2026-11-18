// 项目经理一轮的正式回复挂回它处理的用户消息（docs/router-forward-reply-design.md，规则见 shared/turn-reply.ts 顶部）。
// ledger.ts 的 applyDriverEvent 在 messages.applyEvent 之后、同一个事务里调 afterDriverEvent；界面服务的 GET /api/messages/:id/turn-reply 调 turnReplyOf。
// 不变量：
// - 只看项目经理会话（role pm）；Worker、总助单轮会话的事件直接跳过。
// - 内存里只记在途的东西（每个会话这一轮最后一段顶层文字、每条在途消息送达时的最大消息编号），这一轮结束或会话退出就清掉。
//   守护进程重启后在途的轮次本来就会被标成已停止或重新排队，不需要恢复。
import { agentMessageDedupeKey } from "../../shared/domain.ts";
import type { AgentSessionRow, ConversationId, MessageId, SessionId } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import { replyIdOf } from "../../shared/turn-reply.ts";
import type { TurnReplyView } from "../../shared/turn-reply.ts";
import type { LedgerContext, Pending } from "./context.ts";
import { toMessage } from "./rows.ts";
import type { MessageDbRow } from "./rows.ts";

export interface LedgerTurnReplies {
  /**
   * 前置：在 applyDriverEvent 的写事务里、messages.applyEvent 之后调。
   * 后置：turn.ended 里状态变成 replied 的用户消息，若这一轮在它送达之后写过顶层文字，meta.replyId 记成最后那一段的编号，
   * 并推一条 message.updated；已经有 replyId 的不改。别的事件不写库。
   */
  afterDriverEvent(p: Pending, session: AgentSessionRow, event: DriverEvent): void;
  /**
   * 后置：messageId 是项目经理对话里的用户消息时返回它和 replyId 指向的回复（没有 replyId 或回复已被清理时 reply 是 null）；
   * 不存在、不是用户消息、不在项目经理对话里返回 null（界面服务回 404）。
   */
  turnReplyOf(messageId: MessageId): TurnReplyView | null;
  /** 内存里还留着在途记录的项目经理会话数：测试和上限核对用，不会超过在跑的项目经理会话数。 */
  activeTurns(): number;
}

/** 项目经理会话在途的轮次：这一轮最后一段顶层文字，和每条在途用户消息送达时全库最大的消息编号（它之后写下的文字才可能是它的回复）。 */
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

  /** 在途消息被取消、重排、失败移除后：没有别的在途消息、也没有未结的文字，就不留这个会话的记录。 */
  const dropDelivered = (sessionId: SessionId, ids: readonly MessageId[]) => {
    const st = turns.get(sessionId);
    if (st === undefined) return;
    for (const id of ids) st.deliveredAt.delete(id);
    if (st.deliveredAt.size === 0 && st.lastText === null) turns.delete(sessionId);
  };

  const maxMessageId = (): MessageId => db.get<{ id: number | null }>("SELECT max(id) AS id FROM messages")!.id ?? 0;

  /**
   * 送达时记下全库最大的消息编号，之后写下的文字才可能是它的回复。一轮中途插进来的消息（midTurn）agent 还没读到，
   * 送达到 agent 取走（message.processing）之间 agent 还在答前面的话，所以那种消息以取走的那一刻为准。重复的事件不改已记的数。
   */
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
      // 同一个事务里状态变化已经推过一条 message.updated，换成带 replyId 的这一条，不推两条
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
