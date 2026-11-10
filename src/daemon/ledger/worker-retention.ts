// 已收工 Worker 的对话保留期：Worker 收工（workers.updated_at：收工时写，之后不再改）满 WORKER_RETENTION_DAYS 天，
// 清掉它自己对话里只属于它的大块数据——对话消息（messages）、步骤日志（session_steps）、hub 调用记录（hub_calls）、
// 它对话上的交接（handovers）、跑完了的动作（actions）、后台等待和性格已读标记，以及磁盘上的 launch 目录和准备命令日志。
// 留着的“基本记录”（hub worker search / show / list、网页已收工列表、项目经理收到的汇报都靠它们）：
// - workers 行：编号、标题、任务说明、分支、worktree、状态、收工时间；
// - conversations 行（conversation_purges 里记着清的时间）和 agent_sessions 行：模型、思考程度、用量；
// - 项目经理对话里的消息：Worker 每一轮的汇报（kind worker、meta.event 是 report）、已收工那一行——那是项目经理的对话，不删。
// 不碰：项目经理的对话（归档到期的清理见 persona.ts 的 purgeExpiredArchivedPms，不变）、还没收工的 Worker、会话还在跑或还有没做完的动作的 Worker、
// worktree 目录和分支（可能有没合的活，用户自己 git worktree remove）、uploads/ 和 sent-files/（文件按编号存、不按 Worker 分，
// 由 daemon/file-cleanup.ts 按目录修改时间满 FILE_RETENTION_DAYS 天清；它和本保留期同样是 30 天，Worker 对话里的文件到本清理时早已过期）。
// 分批：每批一个事务（BEGIN IMMEDIATE），最多删 maxRows 行，没删完的下一批（下一轮）接着删，所以锁库的时间有上限；
// 一个 Worker 的数据删完的那一批才记进 conversation_purges、推 conversation.purged，中途失败回滚后下次接着来。
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ConversationId, SessionId, WorkerId } from "../../shared/domain.ts";
import { WORKER_PURGE_BATCH_ROWS, WORKER_RETENTION_MS } from "../../shared/limits.ts";
import { workerSetupLogPath } from "../../shared/paths.ts";
import type { LedgerContext, LedgerFiles, Pending } from "./context.ts";

export interface WorkerPurgeBatch {
  /** 这一批删了多少行（各表加起来，包括打标记前顺手清掉的小表）。 */
  rows: number;
  /** 这一批里数据删完、打上 purged_at 的 Worker。 */
  purged: WorkerId[];
  /** 还有没清完的、到期的 Worker：true 就该再来一批。 */
  more: boolean;
}

interface Candidate {
  id: WorkerId;
  conv: ConversationId;
}

/** 每批最多看几个候选 Worker（预算花完就停，多取没用；取少了下一批还会取）。 */
const CANDIDATES_PER_BATCH = 20;

const placeholders = (ids: readonly number[]) => (ids.length === 0 ? "(NULL)" : `(${ids.map(() => "?").join(",")})`);

export function createLedgerWorkerRetention(ctx: LedgerContext, files: Pick<LedgerFiles, "launchDir" | "setupLogsDir">) {
  const { db, now, write } = ctx;

  const sessionIdsOf = (c: Candidate): SessionId[] =>
    db.all<{ id: number }>("SELECT id FROM agent_sessions WHERE worker_id = ? OR conversation_id = ?", c.id, c.conv).map((r) => r.id);

  /** 还有没做完的动作（排着的、在跑的：给它的消息、结束会话、建 worktree……）的 Worker：等做完再清。动作队列里没做完的很少，一次读完。 */
  const busyWorkers = (): number[] => {
    const ids = new Set<number>();
    const workerOfSession = (id: unknown) =>
      typeof id === "number" ? db.get<{ worker_id: number | null }>("SELECT worker_id FROM agent_sessions WHERE id = ?", id)?.worker_id : undefined;
    const workerOfMessage = (id: unknown) =>
      typeof id === "number" ? db.get<{ worker_id: number | null }>("SELECT worker_id FROM messages WHERE id = ?", id)?.worker_id : undefined;
    for (const { params } of db.all<{ params: string }>("SELECT params FROM actions WHERE status IN ('pending', 'running') AND json_valid(params)")) {
      const a = JSON.parse(params) as { workerId?: unknown; sessionId?: unknown; messageId?: unknown };
      for (const id of [typeof a.workerId === "number" ? a.workerId : undefined, workerOfSession(a.sessionId), workerOfMessage(a.messageId)]) {
        if (id != null) ids.add(id);
      }
    }
    return [...ids];
  };

  /** 到期、没清过、会话没在跑、没有没做完的动作的 Worker，先收工的在前。 */
  const eligible = (cutoff: number, limit: number): Candidate[] => {
    const busy = busyWorkers();
    return db.all<{ id: number; conv: number }>(
      `SELECT w.id, w.worker_conversation_id AS conv FROM workers w
        WHERE w.status = 'ended' AND w.updated_at <= ?
          AND NOT EXISTS (SELECT 1 FROM conversation_purges x WHERE x.conversation_id = w.worker_conversation_id)
          ${busy.length === 0 ? "" : `AND w.id NOT IN ${placeholders(busy)}`}
          AND NOT EXISTS (
            SELECT 1 FROM agent_sessions s
             WHERE (s.worker_id = w.id OR s.conversation_id = w.worker_conversation_id) AND (s.status = 'running' OR s.pid IS NOT NULL))
        ORDER BY w.updated_at, w.id LIMIT ?`,
      cutoff,
      ...busy,
      limit,
    );
  };

  /** 删 table 里满足 where 的至多 limit 行（rowid 子查询限量，一条 DELETE 不会一次删几万行）；返回删了几行。 */
  const deleteChunk = (table: string, where: string, params: number[], limit: number): number =>
    db.run(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ?)`, ...params, limit).changes;

  /** 清一个 Worker，至多删 budget 行；全删完（并打上 purged_at）finished 是 true，预算花完还有剩的是 false。 */
  const purgeOne = (p: Pending, c: Candidate, budget: number, purgedAt: number): { rows: number; finished: boolean } => {
    const sessionIds = sessionIdsOf(c);
    // 先删跑完了的动作：它们里的 messageId 要靠 messages 还在才查得到，所以赶在删消息之前（第一批就把全部消息对应的动作删光）
    let rows = db.run(
      `DELETE FROM actions WHERE status IN ('done', 'failed', 'abandoned') AND CASE WHEN json_valid(params) THEN
         json_extract(params, '$.sessionId') IN ${placeholders(sessionIds)} OR json_extract(params, '$.workerId') = ?
         OR json_extract(params, '$.messageId') IN (SELECT id FROM messages WHERE conversation_id = ?)
       ELSE 0 END`,
      ...sessionIds,
      c.id,
      c.conv,
    ).changes;
    const heavy: Array<{ table: string; where: string; params: number[] }> = [
      { table: "messages", where: "conversation_id = ?", params: [c.conv] },
      { table: "session_steps", where: `session_id IN ${placeholders(sessionIds)}`, params: sessionIds },
      { table: "hub_calls", where: `session_id IN ${placeholders(sessionIds)}`, params: sessionIds },
      {
        table: "handovers",
        where: `conversation_id = ? OR from_session_id IN ${placeholders(sessionIds)} OR to_session_id IN ${placeholders(sessionIds)}`,
        params: [c.conv, ...sessionIds, ...sessionIds],
      },
    ];
    let left = budget - rows;
    for (const { table, where, params } of heavy) {
      if (left <= 0) return { rows, finished: false };
      const deleted = deleteChunk(table, where, params, left);
      rows += deleted;
      // 刚好把预算用光：这张表可能还有，留给下一批（下一批删不到东西才往下走）
      if (deleted >= left) return { rows, finished: false };
      left -= deleted;
    }
    rows += db.run(`DELETE FROM worker_background_waits WHERE session_id IN ${placeholders(sessionIds)}`, ...sessionIds).changes;
    rows += db.run(`DELETE FROM session_persona_seen WHERE session_id IN ${placeholders(sessionIds)}`, ...sessionIds).changes;
    db.run("INSERT INTO conversation_purges (conversation_id, purged_at) VALUES (?, ?)", c.conv, purgedAt);
    p.changes.push({ type: "conversation.purged", data: { conversationId: c.conv, purgedAt } });
    p.after.push(() => {
      if (files.launchDir !== undefined) for (const sid of sessionIds) rmSync(join(files.launchDir, `session-${sid}`), { recursive: true, force: true });
      if (files.setupLogsDir !== undefined) rmSync(workerSetupLogPath(files.setupLogsDir, c.id), { force: true });
    });
    return { rows, finished: true };
  };

  /**
   * 清一批：一个事务，最多删 maxRows 行。nowMs 是现在（测试和模拟用），到期的是 workers.updated_at <= nowMs - WORKER_RETENTION_MS 的。
   * 返回这一批删了多少行、哪些 Worker 清完了、是否还有到期没清完的。
   */
  const purgeBatch = (nowMs: number = now(), maxRows: number = WORKER_PURGE_BATCH_ROWS): WorkerPurgeBatch => {
    const cutoff = nowMs - WORKER_RETENTION_MS;
    const budget = Math.max(1, Math.floor(maxRows));
    const result = write((p) => {
      let rows = 0;
      const purged: WorkerId[] = [];
      for (const c of eligible(cutoff, CANDIDATES_PER_BATCH)) {
        if (rows >= budget) break;
        const one = purgeOne(p, c, budget - rows, nowMs);
        rows += one.rows;
        if (one.finished) purged.push(c.id);
      }
      return { rows, purged };
    });
    return { ...result, more: eligible(cutoff, 1).length > 0 };
  };

  return { purgeBatch };
}
