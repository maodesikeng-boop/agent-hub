import { askOf, type MessageId, type PmId, type RouterItemId, type TaskGraphId, type TaskNodeKey } from "../../shared/domain.ts";
import type { HubArgs, HubResult } from "../../shared/hub.ts";
import { ASK_LIST_MAX, DELIVERABLES_PER_CARD_MAX, MAX_PENDING_ASKS_PER_PM, WAITING_ASK_QUESTION_CHARS } from "../../shared/limits.ts";
import { formatAskDetail, formatPendingAskList, type AskDetail, type PendingAsk } from "../../shared/pending-asks.ts";
import type { RouterDecisionItem } from "../../shared/router.ts";
import type { Db } from "../store/index.ts";
import { fail } from "./context.ts";
import { readRouterItem } from "./router.ts";
import { parseMessageMeta } from "./rows.ts";

interface PendingAskRow {
  item_id: RouterItemId | null;
  message_id: MessageId | null;
  question: string;
  asked_at: number;
  graph_id: TaskGraphId;
  graph_title: string;
  node_key: TaskNodeKey;
  checkpoint: number | null;
}

export function pendingAsksOfPm(db: Db, pmId: PmId): PendingAsk[] {
  const rows = db.all<PendingAskRow>(
    `WITH owner AS (
       SELECT id FROM pms WHERE id = ? AND NOT EXISTS (SELECT 1 FROM pm_archives WHERE pm_id = pms.id)
     ), steps AS (
       SELECT s.id, s.graph_id, s.node_key, s.title, s.status, s.waiting_for, s.active_worker_id,
              s.gate_question, s.gate_ask_message_id, s.updated_at,
              CASE WHEN json_valid(s.artifact_json) THEN json_type(s.artifact_json, '$.checkpointPending') IS 'true' ELSE 0 END AS checkpoint,
              g.title AS graph_title, m.created_at AS asked_at, m.sender,
              CASE WHEN json_valid(m.meta) THEN m.meta END AS ask_meta
         FROM owner JOIN task_graphs g ON g.pm_id = owner.id AND g.status = 'active'
         JOIN task_graph_steps s ON s.graph_id = g.id
         LEFT JOIN messages m ON m.id = s.gate_ask_message_id
     )
     SELECT i.id AS item_id, i.ask_message_id AS message_id, substr(coalesce(i.question, ''), 1, ?) AS question,
            i.created_at AS asked_at, NULL AS graph_id, NULL AS graph_title, NULL AS node_key, NULL AS checkpoint
       FROM owner JOIN router_items i ON i.pm_id = owner.id AND i.kind = 'decision' AND i.status = 'pending'
       LEFT JOIN messages m ON m.id = i.ask_message_id
      WHERE NOT EXISTS (SELECT 1 FROM steps s WHERE s.gate_ask_message_id = i.ask_message_id)
        AND NOT CASE WHEN m.sender = 'agent' AND json_valid(m.meta) THEN
          json_type(m.meta, '$.needsUser') IS 'true'
          AND json_type(m.meta, '$.gateRef.graphId') IS 'integer'
          AND json_type(m.meta, '$.gateRef.nodeKey') IS 'text'
          ELSE 0 END
     UNION ALL
     SELECT NULL, s.gate_ask_message_id, substr(coalesce(s.gate_question, s.title), 1, ?), coalesce(s.asked_at, s.updated_at),
            s.graph_id, s.graph_title, s.node_key, s.checkpoint
       FROM steps s
      WHERE NOT (s.status = 'waiting' AND s.waiting_for IS 'user' AND EXISTS (
              SELECT 1 FROM worker_sandbox_approvals a
               WHERE a.step_id = s.id AND a.worker_id = s.active_worker_id AND a.status = 'pending'
            ))
        AND (CASE WHEN s.gate_ask_message_id IS NOT NULL THEN
               s.sender = 'agent' AND json_type(s.ask_meta, '$.needsUser') IS 'true'
               AND json_type(s.ask_meta, '$.gateRef.graphId') IS 'integer' AND json_type(s.ask_meta, '$.gateRef.nodeKey') IS 'text'
               AND json_type(s.ask_meta, '$.answered') IS NOT 'true' AND json_type(s.ask_meta, '$.dismissed') IS NOT 'true'
               AND json_type(s.ask_meta, '$.closed') IS NOT 'true'
             ELSE s.status = 'waiting' AND s.waiting_for = 'user' AND NOT EXISTS (
               SELECT 1 FROM user_blocker_steps bs JOIN user_blockers b ON b.id = bs.blocker_id
                WHERE bs.step_id = s.id AND b.status = 'open'
             ) END)
      ORDER BY asked_at, item_id, graph_id, node_key LIMIT ?`,
    pmId,
    WAITING_ASK_QUESTION_CHARS + 1,
    WAITING_ASK_QUESTION_CHARS + 1,
    MAX_PENDING_ASKS_PER_PM,
  );
  return rows.map((r) => ({
    source: r.item_id !== null
      ? { kind: "ask", itemId: r.item_id }
      : { kind: "step", graphId: r.graph_id, graphTitle: r.graph_title, nodeKey: r.node_key, checkpoint: r.checkpoint === 1 },
    messageId: r.message_id,
    question: r.question.split(/\r?\n/, 1)[0] ?? "",
    askedAt: r.asked_at,
  }));
}

function askMessageOf(db: Db, pmId: PmId, messageId: MessageId | null) {
  if (messageId === null) return null;
  const row = db.get<{ id: MessageId; text: string; created_at: number; updated_at: number; meta: string | null }>(
    `SELECT m.id, m.text, m.created_at, m.updated_at, CASE WHEN json_type(CASE WHEN json_valid(m.meta) THEN m.meta END) = 'object' THEN m.meta END AS meta
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = ? AND c.pm_id = ? AND m.sender = 'agent' AND m.kind = 'text'`,
    messageId, pmId,
  );
  return row === undefined ? null : { message: row, ask: askOf({ sender: "agent", meta: parseMessageMeta("text", row.meta) }) };
}

function independentDetailOf(db: Db, pmId: PmId, item: RouterDecisionItem): AskDetail {
  const original = askMessageOf(db, pmId, item.askMessageId);
  const resolution = item.resolution;
  return {
    source: { kind: "ask", itemId: item.id },
    messageId: original?.message.id ?? null,
    text: original?.message.text ?? null,
    options: original?.ask?.options ?? item.options,
    recommended: original?.ask?.recommended ?? null,
    deliverables: (original?.ask?.deliverables ?? item.deliverables ?? []).slice(0, DELIVERABLES_PER_CARD_MAX),
    askedAt: original?.message.created_at ?? item.createdAt,
    status: item.status === "pending" ? { state: "waiting" } : item.status === "resolved"
      ? { state: "answered", choice: resolution?.chosenOption ?? null, note: resolution?.note || null, at: resolution?.resolvedAt ?? item.updatedAt }
      : { state: "closed", at: item.updatedAt },
  };
}

export function askDetailOf(db: Db, pmId: PmId, ref: HubArgs<"ask.show">): AskDetail {
  if ("itemId" in ref) {
    const item = readRouterItem(db, ref.itemId);
    if (item?.kind !== "decision" || item.pmId !== pmId) throw fail("not_found", `没有编号 ${ref.itemId} 的卡`);
    return independentDetailOf(db, pmId, item);
  }
  const original = askMessageOf(db, pmId, ref.messageId);
  if (original?.ask?.gateRef === undefined) throw fail("not_found", `没有编号 ${ref.messageId} 的步骤拍板卡`);
  const { message, ask } = original;
  const { graphId, nodeKey, checkpoint } = original.ask.gateRef;
  const graph = db.get<{ title: string }>("SELECT title FROM task_graphs WHERE id = ? AND pm_id = ?", graphId, pmId);
  return {
    source: { kind: "step", graphId, graphTitle: graph?.title ?? "", nodeKey, checkpoint: checkpoint === true },
    messageId: message.id,
    text: message.text,
    options: ask.options ?? [],
    recommended: ask.recommended ?? null,
    deliverables: (ask.deliverables ?? []).slice(0, DELIVERABLES_PER_CARD_MAX),
    askedAt: message.created_at,
    status: ask.closed ? { state: "closed", at: message.updated_at } : ask.answered
      ? { state: "answered", choice: ask.chosenOption ?? null, note: ask.answerNote ?? null, at: message.updated_at }
      : { state: "waiting" },
  };
}

export function askListIn(db: Db, caller: { pmId: PmId }, now: number): HubResult<"ask.list"> {
  const asks = pendingAsksOfPm(db, caller.pmId);
  return { text: formatPendingAskList(asks, now), data: { asks: asks.slice(0, ASK_LIST_MAX) } };
}

export function askShowIn(db: Db, caller: { pmId: PmId }, args: HubArgs<"ask.show">, now: number): HubResult<"ask.show"> {
  const ask = askDetailOf(db, caller.pmId, args);
  return { text: formatAskDetail(ask, now), data: { ask } };
}
