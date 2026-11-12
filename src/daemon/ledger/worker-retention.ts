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
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ConversationId, SessionId, WorkerId } from "../../shared/domain.ts";
import { WORKER_PURGE_BATCH_ROWS, WORKER_PURGE_CANDIDATES_PER_BATCH, WORKER_RETENTION_MS } from "../../shared/limits.ts";
import { removeSessionLaunchDir, workerSetupLogPath } from "../../shared/paths.ts";
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

const placeholders = (ids: readonly number[]) => (ids.length === 0 ? "(NULL)" : `(${ids.map(() => "?").join(",")})`);

export function createLedgerWorkerRetention(ctx: LedgerContext, files: Pick<LedgerFiles, "launchDir" | "setupLogsDir">) {
  const { db, now, write } = ctx;

  const sessionIdsOf = (c: Candidate): SessionId[] =>
    db.all<{ id: number }>("SELECT id FROM agent_sessions WHERE role = 'worker' AND (worker_id = ? OR conversation_id = ?)", c.id, c.conv).map((r) => r.id);

  /** 还有没做完的动作（排着的、在跑的：给它的消息、结束会话、建 worktree……）的 Worker：等做完再清。动作队列里没做完的很少，一次读完。 */
  const busyWorkers = (): number[] => {
    const ids = new Set<number>();
    const workerOfSession = (id: unknown) =>
      typeof id === "number"
        ? db.get<{ worker_id: number | null }>(
            "SELECT COALESCE(s.worker_id, w.id) AS worker_id FROM agent_sessions s LEFT JOIN workers w ON w.worker_conversation_id = s.conversation_id WHERE s.id = ?",
            id,
          )?.worker_id
        : undefined;
    const workerOfMessage = (id: unknown) =>
      typeof id === "number"
        ? db.get<{ worker_id: number | null }>(
            "SELECT COALESCE(m.worker_id, w.id) AS worker_id FROM messages m LEFT JOIN workers w ON w.worker_conversation_id = m.conversation_id WHERE m.id = ?",
            id,
          )?.worker_id
        : undefined;
    for (const { params } of db.all<{ params: string }>("SELECT params FROM actions WHERE status IN ('pending', 'running') AND json_valid(params)")) {
      const a = JSON.parse(params) as { workerId?: unknown; sessionId?: unknown; messageId?: unknown };
      for (const id of [typeof a.workerId === "number" ? a.workerId : undefined, workerOfSession(a.sessionId), workerOfMessage(a.messageId)]) {
        if (id != null) ids.add(id);
      }
    }
    return [...ids];
  };

  /** 快速判断现在有没有到期且还没清过的 Worker（一条只读查询，没有就不进写事务、也不扫 actions）。 */
  const hasExpiredCandidate = (cutoff: number): boolean =>
    db.get(
      `SELECT 1 AS x FROM workers w
        JOIN conversations c ON c.id = w.worker_conversation_id AND c.kind = 'worker'
        WHERE w.status = 'ended' AND w.updated_at <= ?
          AND w.worker_conversation_id != w.pm_conversation_id
          AND NOT EXISTS (SELECT 1 FROM conversation_purges x WHERE x.conversation_id = w.worker_conversation_id)
        LIMIT 1`,
      cutoff,
    ) !== undefined;

  /** 到期、没清过、会话没在跑、没有没做完的动作的 Worker，先收工的在前。 */
  const eligible = (cutoff: number, limit: number): Candidate[] => {
    const busy = busyWorkers();
    return db.all<{ id: number; conv: number }>(
      `SELECT w.id, w.worker_conversation_id AS conv FROM workers w
        JOIN conversations c ON c.id = w.worker_conversation_id AND c.kind = 'worker'
        WHERE w.status = 'ended' AND w.updated_at <= ?
          AND w.worker_conversation_id != w.pm_conversation_id
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
    // 先删跑完了的动作：它们里的 messageId 要靠 messages 还在才查得到，所以排在 messages 前面（actions 没删完绝不会开始删 messages）
    const heavy: Array<{ table: string; where: string; params: number[] }> = [
      {
        table: "actions",
        where: `status IN ('done', 'failed', 'abandoned') AND CASE WHEN json_valid(params) THEN
          json_extract(params, '$.sessionId') IN ${placeholders(sessionIds)} OR json_extract(params, '$.workerId') = ?
          OR json_extract(params, '$.messageId') IN (SELECT id FROM messages WHERE conversation_id = ?)
        ELSE 0 END`,
        params: [...sessionIds, c.id, c.conv],
      },
      { table: "messages", where: "conversation_id = ?", params: [c.conv] },
      { table: "session_steps", where: `session_id IN ${placeholders(sessionIds)}`, params: sessionIds },
      { table: "hub_calls", where: `session_id IN ${placeholders(sessionIds)}`, params: sessionIds },
      {
        table: "handovers",
        where: `conversation_id = ? OR from_session_id IN ${placeholders(sessionIds)} OR to_session_id IN ${placeholders(sessionIds)}`,
        params: [c.conv, ...sessionIds, ...sessionIds],
      },
      { table: "worker_background_waits", where: `session_id IN ${placeholders(sessionIds)}`, params: sessionIds },
      { table: "session_persona_seen", where: `session_id IN ${placeholders(sessionIds)}`, params: sessionIds },
    ];
    let rows = 0;
    let left = budget;
    for (const { table, where, params } of heavy) {
      if (left <= 0) return { rows, finished: false };
      const deleted = deleteChunk(table, where, params, left);
      rows += deleted;
      // 刚好把预算用光：这张表可能还有，留给下一批（下一批删不到东西才往下走）
      if (deleted >= left) return { rows, finished: false };
      left -= deleted;
    }
    db.run("INSERT INTO conversation_purges (conversation_id, purged_at) VALUES (?, ?)", c.conv, purgedAt);
    p.changes.push({ type: "conversation.purged", data: { conversationId: c.conv, purgedAt } });
    p.after.push(() => {
      if (files.launchDir !== undefined) for (const sid of sessionIds) removeSessionLaunchDir(files.launchDir, sid);
      if (files.setupLogsDir !== undefined) rmSync(workerSetupLogPath(files.setupLogsDir, c.id), { force: true });
    });
    return { rows, finished: true };
  };

  /**
   * 清理已退役或历史遗留的启动目录（`state/launch/<编号>` 与旧版 `state/launch/session-<编号>`）：
   * - 活跃 PM 换会话（`handover`）淘汰下来的已结束旧 PM 会话（`role = 'pm' AND status = 'ended'`，且进程已退、无进行中交接、无待处理动作）；
   * - 已结束的总助轨道 B 会话（`role = 'assistant' AND status = 'ended'`）或行已删的孤儿会话；
   * - 已走完保留期清理（`conversation_purges`）的 Worker 会话；
   * - 历史遗留的 `session-<编号>` 旧命名目录。
   * 绝不碰：还在跑或有进程/待处理动作的会话、当前未结束的 PM 会话（含已归档未满 7 天的）、未满 30 天保留期的已收工 Worker 会话。
   */
  const sweepRetiredLaunchDirs = (): void => {
    const launchDir = files.launchDir;
    if (launchDir === undefined || !existsSync(launchDir)) return;
    let entries: string[];
    try {
      entries = readdirSync(launchDir);
    } catch {
      return;
    }
    const parsed: Array<{ entry: string; sid: number; legacy: boolean }> = [];
    for (const entry of entries) {
      const m = /^(session-)?([1-9]\d*)$/.exec(entry);
      if (m) parsed.push({ entry, sid: Number(m[2]), legacy: m[1] === "session-" });
    }
    if (parsed.length === 0) return;

    const keep = new Set<number>();
    for (const { id } of db.all<{ id: number }>(
      `SELECT s.id FROM agent_sessions s
        WHERE s.status != 'ended'
           OR s.pid IS NOT NULL
           OR (s.role = 'worker' AND (s.conversation_id IS NULL OR NOT EXISTS (
                 SELECT 1 FROM conversation_purges cp WHERE cp.conversation_id = s.conversation_id
               )))
           OR (s.role = 'pm' AND EXISTS (
                 SELECT 1 FROM handovers h
                  WHERE h.from_session_id = s.id AND h.status IN ('queued', 'forking', 'writing', 'ready')
               ))`,
    )) {
      keep.add(id);
    }
    for (const { params } of db.all<{ params: string }>("SELECT params FROM actions WHERE status IN ('pending', 'running') AND json_valid(params)")) {
      const a = JSON.parse(params) as { sessionId?: unknown };
      if (typeof a.sessionId === "number") keep.add(a.sessionId);
    }

    for (const { entry, sid, legacy } of parsed) {
      if (legacy || !keep.has(sid)) {
        rmSync(join(launchDir, entry), { recursive: true, force: true });
      }
    }
  };

  /**
   * 清一批：一个事务，最多删 maxRows 行。nowMs 是现在（测试和模拟用），到期的是 workers.updated_at <= nowMs - WORKER_RETENTION_MS 的。
   * 返回这一批删了多少行、哪些 Worker 清完了、是否还有到期没清完的。
   */
  const purgeBatch = (nowMs: number = now(), maxRows: number = WORKER_PURGE_BATCH_ROWS): WorkerPurgeBatch => {
    const cutoff = nowMs - WORKER_RETENTION_MS;
    if (!hasExpiredCandidate(cutoff)) {
      sweepRetiredLaunchDirs();
      return { rows: 0, purged: [], more: false };
    }
    const budget = Math.max(1, Math.floor(maxRows));
    const { rows, purged, candidatesCount } = write((p) => {
      const candidates = eligible(cutoff, WORKER_PURGE_CANDIDATES_PER_BATCH);
      let batchRows = 0;
      const batchPurged: WorkerId[] = [];
      for (const c of candidates) {
        if (batchRows >= budget) break;
        const one = purgeOne(p, c, budget - batchRows, nowMs);
        batchRows += one.rows;
        if (one.finished) batchPurged.push(c.id);
      }
      return { rows: batchRows, purged: batchPurged, candidatesCount: candidates.length };
    });
    sweepRetiredLaunchDirs();
    const more =
      candidatesCount === 0
        ? false
        : purged.length < candidatesCount
          ? true
          : candidatesCount < WORKER_PURGE_CANDIDATES_PER_BATCH
            ? false
            : eligible(cutoff, 1).length > 0;
    return { rows, purged, more };
  };

  return { purgeBatch };
}
