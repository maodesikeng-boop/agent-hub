import type { ConversationSnapshot, ConversationsLookup, EndedWorkersPage } from "../../shared/api.ts";
import type { AgentSessionRow, ConversationId, MessageKind, PmId, SessionState, TaskGraph, WorkerId } from "../../shared/domain.ts";
import { CONVERSATION_LOOKUP_MAX_IDS, ENDED_WORKERS_PAGE_SIZE, MESSAGE_PAGE_SIZE, SNAPSHOT_ENDED_WORKERS_PER_PM } from "../../shared/limits.ts";
import { snapshotWindowStart, workerLineSummaries } from "../../shared/snapshot.ts";
import { toAgentSessionRow } from "../store/index.ts";
import type { AgentSessionDbRow, Db } from "../store/index.ts";
import { fail } from "./context.ts";
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

export function createLedgerSnapshotQueries(db: Db, deps: { sessionState: (row: AgentSessionRow) => SessionState }) {
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
    const endedWithMessages = new Set(
      ended.size === 0
        ? []
        : db
            .all<{ id: number }>(
              `SELECT c.id FROM conversations c WHERE c.id ${IN_IDS} AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)`,
              idList(ended),
            )
            .map((r) => r.id),
    );
    return rows.map((row) => {
      const conversation = toConversation(row);
      const workerLine = row.kind === "worker" ? workerLines.get(row.id) : undefined;
      const summary = workerLine !== undefined ? { workerLine } : {};
      if (ended.has(row.id)) {
        return { conversation, messages: [], hasMore: row.purged_at == null && endedWithMessages.has(row.id), ...summary };
      }
      const shape = db
        .all<MessageDbRow>(`SELECT ${MESSAGE_SHAPE_COLUMNS} FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`, row.id, MESSAGE_PAGE_SIZE + 1);
      const pageHasMore = shape.length > MESSAGE_PAGE_SIZE;
      const recent = shape.slice(0, MESSAGE_PAGE_SIZE).reverse().map(toMessage);
      if (recent.length === 0) return { conversation, messages: [], hasMore: false, ...summary };
      const start = snapshotWindowStart(recent);
      const messages = db
        .all<MessageDbRow>(
          `SELECT ${WEB_MESSAGE_COLUMNS} FROM messages WHERE conversation_id = ? AND id >= ? AND id <= ? ORDER BY id`,
          row.id,
          recent[start]!.id,
          recent.at(-1)!.id,
        )
        .map(toMessage);
      return { conversation, messages, hasMore: pageHasMore || start > 0, ...summary };
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
    const oldestKept = new Map<PmId, ConversationId>();
    const hasOlder = new Set<PmId>();
    for (const w of workers) {
      if (w.ended === 0 || (w.worker_id !== null && bound.has(w.worker_id))) {
        keep.add(w.id);
        continue;
      }
      const kept = endedKept.get(w.pm_id) ?? 0;
      if (kept >= SNAPSHOT_ENDED_WORKERS_PER_PM) {
        if (w.pm_id !== null) hasOlder.add(w.pm_id);
        continue;
      }
      endedKept.set(w.pm_id, kept + 1);
      keep.add(w.id);
      if (w.pm_id !== null) oldestKept.set(w.pm_id, w.id);
    }
    const olderEndedWorkers: Record<PmId, ConversationId> = Object.fromEntries([...hasOlder].map((pmId) => [pmId, oldestKept.get(pmId)!]));
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
    return { conversations, sessions, olderEndedWorkers };
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

  const endedWorkersPage = (pmId: PmId, before: ConversationId | null): EndedWorkersPage => {
    if (db.get("SELECT 1 FROM pms WHERE id = ?", pmId) === undefined) throw fail("not_found", `没有编号 ${pmId} 的项目经理`);
    const page = db
      .all<{ id: number }>(
        `SELECT c.id FROM conversations c WHERE c.kind = 'worker' AND c.pm_id = ? AND c.id < ? AND ${ENDED_WORKER} ORDER BY c.id DESC LIMIT ?`,
        pmId,
        before ?? Number.MAX_SAFE_INTEGER,
        ENDED_WORKERS_PAGE_SIZE + 1,
      )
      .map((r) => r.id);
    const shown = page.slice(0, ENDED_WORKERS_PAGE_SIZE);
    const rows = conversationRows(shown);
    return {
      conversations: entriesOf(rows),
      sessions: sessionsOf(shown),
      nextBefore: page.length > ENDED_WORKERS_PAGE_SIZE ? shown.at(-1)! : null,
    };
  };

  return { snapshotConversations, lookupConversations, endedWorkersPage };
}
