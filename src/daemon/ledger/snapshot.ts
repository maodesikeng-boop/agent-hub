import type { ConversationSnapshot, ConversationsLookup } from "../../shared/api.ts";
import type { AgentSessionRow, ConversationId, MessageKind, PmId, SessionState, TaskGraph, WorkerId } from "../../shared/domain.ts";
import { CONVERSATION_LOOKUP_MAX_IDS, MESSAGE_PAGE_SIZE, SNAPSHOT_ENDED_WORKERS_PER_PM } from "../../shared/limits.ts";
import { snapshotWindowStart, workerLineSummaries } from "../../shared/snapshot.ts";
import type { LedgerTurns } from "./turns.ts";
import { toAgentSessionRow } from "../store/index.ts";
import { CHECKLIST_REMINDER_SQL } from "./checklist-reminders.ts";
import type { AgentSessionDbRow, Db } from "../store/index.ts";
import { MESSAGE_SHAPE_COLUMNS, WEB_MESSAGE_COLUMNS, parseMessageMeta, toConversation, toMessage } from "./rows.ts";
import type { ConversationDbRow, MessageDbRow } from "./rows.ts";

const idList = (ids: Iterable<number>) => JSON.stringify([...ids]);
const IN_IDS = "IN (SELECT value FROM json_each(?))";

const ENDED_WORKER = `(EXISTS (SELECT 1 FROM workers w WHERE w.worker_conversation_id = c.id AND w.status = 'ended')
  OR EXISTS (SELECT 1 FROM agent_sessions s WHERE s.conversation_id = c.id AND s.status = 'ended'))`;

const NOT_GROUP_SESSION = `(s.conversation_id IS NULL OR s.conversation_id NOT IN (SELECT id FROM conversations WHERE kind = 'project_group'))`;

function boundWorkerIds(graphs: readonly TaskGraph[]): Set<WorkerId> {
  const ids = new Set<WorkerId>();
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      for (const id of node.workerIds) ids.add(id);
      if (node.activeWorkerId !== null) ids.add(node.activeWorkerId);
    }
  }
  return ids;
}

export function createLedgerSnapshotQueries(db: Db, deps: {
  sessionState: (row: AgentSessionRow) => SessionState;
  turnsFor: LedgerTurns["summariesFor"];
}) {
  const entriesOf = (rows: readonly ConversationDbRow[]): ConversationSnapshot[] => {
    if (rows.length === 0) return [];
    const workerConvIds = rows.filter((r) => r.kind === "worker").map((r) => r.id);
    const ended = new Set(
      workerConvIds.length === 0
        ? []
        : db.all<{ id: number }>(`SELECT c.id FROM conversations c WHERE c.id ${IN_IDS} AND ${ENDED_WORKER}`, idList(workerConvIds)).map((r) => r.id),
    );
    const workerLines = workerLineSummaries(
      workerConvIds.length === 0
        ? []
        : db
            .all<Pick<MessageDbRow, "id" | "kind" | "meta" | "created_at">>(
              `SELECT id, kind, meta, created_at FROM messages
                WHERE kind = 'worker' AND worker_id IN (SELECT id FROM workers WHERE worker_conversation_id ${IN_IDS}) ORDER BY id`,
              idList(workerConvIds),
            )
            .map((r) => ({ id: r.id, kind: r.kind as MessageKind, meta: parseMessageMeta(r.kind, r.meta), createdAt: r.created_at })),
    );
    const workerBranches = new Map(
      workerConvIds.length === 0
        ? []
        : db
            .all<{ id: number; branch: string | null }>(
              `SELECT worker_conversation_id AS id, branch FROM workers WHERE worker_conversation_id ${IN_IDS}`,
              idList(workerConvIds),
            )
            .map((r) => [r.id, r.branch]),
    );
    const endedWithMessages = new Set(
      ended.size === 0
        ? []
        : db
            .all<{ id: number }>(
              `SELECT c.id FROM conversations c WHERE c.id ${IN_IDS} AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND NOT ${CHECKLIST_REMINDER_SQL})`,
              idList(ended),
            )
            .map((r) => r.id),
    );
    return rows.map((row) => {
      const conversation = toConversation(row);
      const workerLine = row.kind === "worker" ? workerLines.get(row.id) : undefined;
      const workerBranch = row.kind === "worker" ? workerBranches.get(row.id) : undefined;
      const summary = {
        ...(workerLine !== undefined ? { workerLine } : {}),
        ...(workerBranch !== undefined ? { workerBranch } : {}),
      };
      if (ended.has(row.id)) {
        return { conversation, messages: [], hasMore: row.purged_at == null && endedWithMessages.has(row.id), ...summary };
      }
      const shape = db
        .all<MessageDbRow>(
          `SELECT ${MESSAGE_SHAPE_COLUMNS} FROM messages WHERE conversation_id = ? AND NOT ${CHECKLIST_REMINDER_SQL} ORDER BY id DESC LIMIT ?`,
          row.id, MESSAGE_PAGE_SIZE + 1,
        );
      const pageHasMore = shape.length > MESSAGE_PAGE_SIZE;
      const recent = shape.slice(0, MESSAGE_PAGE_SIZE).reverse().map(toMessage);
      if (recent.length === 0) return { conversation, messages: [], hasMore: false, turns: deps.turnsFor(row.id, []), ...summary };
      const start = snapshotWindowStart(recent);
      const messages = db
        .all<MessageDbRow>(
          `SELECT ${WEB_MESSAGE_COLUMNS} FROM messages WHERE conversation_id = ? AND id >= ? AND id <= ? AND NOT ${CHECKLIST_REMINDER_SQL} ORDER BY id`,
          row.id,
          recent[start]!.id,
          recent.at(-1)!.id,
        )
        .map(toMessage);
      return { conversation, messages, hasMore: pageHasMore || start > 0, turns: deps.turnsFor(row.id, messages), ...summary };
    });
  };

  const conversationRows = (ids: Iterable<ConversationId>): ConversationDbRow[] =>
    db.all<ConversationDbRow>(
      `SELECT c.*, p.purged_at FROM conversations c LEFT JOIN conversation_purges p ON p.conversation_id = c.id
        WHERE c.id ${IN_IDS} AND c.kind != 'project_group' ORDER BY c.id`,
      idList(ids),
    );

  const sessionsOf = (conversationIds: Iterable<ConversationId>): SessionState[] =>
    db
      .all<AgentSessionDbRow>(
        `SELECT s.* FROM agent_sessions s
          WHERE s.role != 'assistant' AND s.conversation_id ${IN_IDS}
            AND (s.status != 'ended' OR s.generation = (SELECT MAX(generation) FROM agent_sessions x WHERE x.conversation_id = s.conversation_id))
          ORDER BY s.id`,
        idList(conversationIds),
      )
      .map((r) => deps.sessionState(toAgentSessionRow(r)));

  const snapshotConversations = (activeGraphs: readonly TaskGraph[]) => {
    const workers = db.all<{ id: number; pm_id: number | null; worker_id: number | null; ended: number }>(
      `SELECT c.id, c.pm_id, (SELECT w.id FROM workers w WHERE w.worker_conversation_id = c.id) AS worker_id, ${ENDED_WORKER} AS ended
         FROM conversations c WHERE c.kind = 'worker' ORDER BY c.id DESC`,
    );
    const bound = boundWorkerIds(activeGraphs);
    const keep = new Set<ConversationId>(db.all<{ id: number }>("SELECT id FROM conversations WHERE kind NOT IN ('worker', 'project_group')").map((r) => r.id));
    const endedKept = new Map<PmId | null, number>();
    for (const w of workers) {
      if (w.ended === 0 || (w.worker_id !== null && bound.has(w.worker_id))) {
        keep.add(w.id);
        continue;
      }
      const kept = endedKept.get(w.pm_id) ?? 0;
      if (kept >= SNAPSHOT_ENDED_WORKERS_PER_PM) continue;
      endedKept.set(w.pm_id, kept + 1);
      keep.add(w.id);
    }
    const conversations = entriesOf(conversationRows(keep));
    const extra = db.all<AgentSessionDbRow>(
      `SELECT s.* FROM agent_sessions s WHERE s.role != 'assistant' AND ${NOT_GROUP_SESSION} AND (
          (s.conversation_id IS NULL AND s.status != 'ended')
          OR s.id IN (SELECT MAX(s.id) FROM agent_sessions s WHERE s.role != 'assistant' AND ${NOT_GROUP_SESSION} GROUP BY s.vendor)
          OR s.id IN (SELECT MAX(s.id) FROM agent_sessions s WHERE s.role != 'assistant' AND s.rate_limit IS NOT NULL AND ${NOT_GROUP_SESSION} GROUP BY s.vendor))
        ORDER BY s.id`,
    );
    const sessions = sessionsOf(keep);
    const have = new Set(sessions.map((s) => s.sessionId));
    for (const row of extra) if (!have.has(row.id)) sessions.push(deps.sessionState(toAgentSessionRow(row)));
    sessions.sort((a, b) => a.sessionId - b.sessionId);
    return { conversations, sessions };
  };

  const lookupConversations = (query: { ids: readonly ConversationId[]; workerIds: readonly WorkerId[] }): ConversationsLookup => {
    const ids = new Set(query.ids.slice(0, CONVERSATION_LOOKUP_MAX_IDS));
    const workerIds = query.workerIds.slice(0, CONVERSATION_LOOKUP_MAX_IDS);
    if (workerIds.length > 0) {
      for (const r of db.all<{ id: number }>(`SELECT worker_conversation_id AS id FROM workers WHERE id ${IN_IDS}`, idList(workerIds))) ids.add(r.id);
    }
    if (ids.size === 0) return { conversations: [], sessions: [] };
    const rows = conversationRows(ids);
    return { conversations: entriesOf(rows), sessions: sessionsOf(rows.map((r) => r.id)) };
  };

  return { snapshotConversations, lookupConversations };
}
