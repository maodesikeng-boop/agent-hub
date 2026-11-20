import type { MessageId, PmId, WorkerId } from "../../../shared/domain.ts";
import type { HubArgs, HubResult } from "../../../shared/hub.ts";
import { DEFAULT_WORKER_MAX_TIME_MS, WORKTREE_RETENTION_DAYS } from "../../../shared/limits.ts";
import { formatDurationShort } from "../../../shared/schedule.ts";
import { userBlockerResumeText, type UserBlocker } from "../../../shared/user-blockers.ts";
import { composerBaseOf } from "../../vendors/index.ts";
import { fail } from "../context.ts";
import type { Pending } from "../context.ts";
import { toWorkerRecord } from "../rows.ts";
import type { WorkerDbRow } from "../rows.ts";
import { idle } from "../sessions.ts";
import type { StepWorkspacePlan, TaskGraphWorkersBridge } from "../task-graphs.ts";
import { ownWorker, workerRow, workerSession } from "./ctx.ts";
import { insertLine, insertPmMessage, isWorkerInFlight, stopQueued } from "./lines.ts";
import { notStarted, sendDedupeKey, validMaxTimeMs, validTask, worktreeLabel } from "./text.ts";
import { clearMaxTime, startMaxTime } from "./timers.ts";
import type { PmCaller, WorkersCtx } from "./types.ts";

export type EndedWorker = { ended: WorkerDbRow; interrupted: boolean; nodeNote: string | null };

export function endWorkerIn(w: WorkersCtx, p: Pending, worker: WorkerDbRow, opts: { notifyGraph?: boolean } = {}): EndedWorker {
  clearMaxTime(w, worker.worker_conversation_id);
  const session = workerSession(w, worker);
  const interrupted = !notStarted(worker) && w.messages.stopIn(p, { ...session, conversationId: worker.worker_conversation_id });
  if (interrupted) w.endInterrupted.add(session.id);
  w.awaitingBackground.take(session.id);
  w.db.run("UPDATE workers SET status = 'ended', updated_at = ? WHERE id = ?", w.now(), worker.id);
  const ended = workerRow(w, worker.id)!;
  w.enqueue(p, { type: "session.end", params: { sessionId: session.id, generation: session.generation } });
  stopQueued(w, p, ended);
  insertLine(w, p, ended, { event: "ended", status: null, summary: null, turnMessageId: null, deliver: null });
  const nodeNote = opts.notifyGraph === false ? null : (w.options.taskGraphs?.onWorkerEndedIn(p, ended.id) ?? null);
  return { ended, interrupted, nodeNote };
}

export function endOpenUpstreamIn(w: WorkersCtx, p: Pending, plan: StepWorkspacePlan): void {
  const path = plan.kind === "inherit" ? plan.worktreePath : plan.kind === "review" ? plan.implWorktreePath : null;
  if (path === null) return;
  for (const prevWorker of w.db.all<WorkerDbRow>("SELECT * FROM workers WHERE worktree_path = ? AND status = 'open' ORDER BY id", path)) {
    endWorkerIn(w, p, prevWorker, { notifyGraph: false });
  }
}

export function stopWorkersIn(w: WorkersCtx, p: Pending, workerIds: readonly WorkerId[]): WorkerId[] {
  const stopped: WorkerId[] = [];
  for (const wid of workerIds) {
    const worker = workerRow(w, wid);
    if (worker === null || worker.status === "ended") continue;
    endWorkerIn(w, p, worker, { notifyGraph: false });
    stopped.push(wid);
  }
  return stopped;
}

export type DeliverInput = Parameters<TaskGraphWorkersBridge["deliverToWorkerIn"]>[1];

export function deliverToWorkerIn(w: WorkersCtx, p: Pending, input: DeliverInput): MessageId | null {
  const existing = w.db.get<{ id: number }>("SELECT id FROM messages WHERE dedupe_key = ?", input.dedupeKey);
  if (existing !== undefined) return existing.id;
  const worker = workerRow(w, input.workerId);
  if (worker === null || worker.status === "ended") return null;
  const session = workerSession(w, worker);
  const message = insertPmMessage(w, p, worker, session, input.text, input.dedupeKey);
  if (!notStarted(worker)) {
    w.enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId: message.id, source: "user" } });
    startMaxTime(w, worker, input.maxTimeMs ?? DEFAULT_WORKER_MAX_TIME_MS);
  }
  return message.id;
}

export function resumeUserBlockedWorkerIn(w: WorkersCtx, p: Pending, workerId: WorkerId, messageIds: readonly MessageId[], blocker: UserBlocker): void {
  const worker = workerRow(w, workerId);
  if (worker === null || worker.status === "ended") return;
  const session = workerSession(w, worker);
  const failed = messageIds.filter((id) => w.db.get<{ status: string | null }>("SELECT status FROM messages WHERE id = ?", id)?.status === "failed");
  if (failed.length === 0) {
    const inFlight = w.db.get(
      "SELECT 1 AS x FROM messages WHERE conversation_id = ? AND sender IN ('pm', 'user') AND status IN ('queued', 'delivered', 'processing') LIMIT 1",
      worker.worker_conversation_id,
    );
    if (inFlight === undefined) {
      deliverToWorkerIn(w, p, { workerId, text: userBlockerResumeText(blocker), dedupeKey: `user-blocker-resumed:${blocker.id}:${workerId}` });
    }
    return;
  }
  const t = w.now();
  for (const id of failed) {
    w.db.run(
      "UPDATE messages SET status = 'queued', failure_reason = NULL, meta = json_remove(meta, '$.deliveryConfirmed'), session_id = ?, updated_at = ? WHERE id = ?",
      session.id,
      t,
      id,
    );
    w.enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId: id, source: "user" } });
    const message = w.messages.getMessage(id);
    if (message !== null) p.changes.push({ type: "message.updated", data: { message } });
  }
  startMaxTime(w, worker);
}

export function sendIn(w: WorkersCtx, p: Pending, caller: PmCaller, args: HubArgs<"worker.send">): HubResult<"worker.send"> {
  w.persona.assertPmNotArchived(caller.pmId);
  const maxTimeMs = validMaxTimeMs(args.maxTimeMs);
  const worker = ownWorker(w, caller.pmId, args.workerId);
  if (worker.status === "ended") throw fail("conflict", `Worker #${worker.id} 已经收工了，要接着做请重新派一个`);
  // Before work starts the first turn must be the task brief; sending now would start the session early.
  if (notStarted(worker)) throw fail("conflict", `Worker 还在准备，等它开工后再发（Worker #${worker.id} 在建 worktree 或跑项目的准备命令）`);
  const text = validTask(args.text, "要发给 Worker 的话");
  const session = workerSession(w, worker);
  // Hidden commands like /clear would swap the session id and later resumes would reattach the old conversation.
  const blocked = w.ctx.commandBlockReason(session, text);
  if (blocked !== null) throw fail("invalid", blocked);
  w.options.taskGraphs?.onWorkerResumedIn(p, worker.id);
  w.sessions.dropRateLimitRejection(p, session.id);
  const message = insertPmMessage(w, p, worker, session, text, sendDedupeKey(worker.id));
  w.enqueue(p, { type: "session.send", params: { sessionId: message.session_id!, messageId: message.id, source: "user" } });
  const compactOnly = composerBaseOf(session.vendor)?.isCompactCommand(text) === true;
  startMaxTime(w, worker, maxTimeMs);
  return {
    text: compactOnly
      ? `已发给 Worker #${worker.id}“${worker.title}”：这一轮只压缩上下文，不会有汇报，压缩完它就空闲了，不用等。`
      : `已发给 Worker #${worker.id}“${worker.title}”，它会接着做，做完一轮汇报会自动发给你。`,
    data: { worker: toWorkerRecord(worker), messageId: message.id },
  };
}

export function maxTimeIn(w: WorkersCtx, _p: Pending, caller: PmCaller, args: HubArgs<"worker.max-time">): HubResult<"worker.max-time"> {
  w.persona.assertPmNotArchived(caller.pmId);
  const maxTimeMs = validMaxTimeMs(args.maxTimeMs);
  const worker = ownWorker(w, caller.pmId, args.workerId);
  if (worker.status === "ended") throw fail("conflict", `Worker #${worker.id} 已经收工了，不能再改最大时间`);
  if (!notStarted(worker) && !isWorkerInFlight(w, worker)) {
    throw fail("conflict", `Worker #${worker.id} 当前没有正在运行的一轮，发下一条时用 --max-time 指定即可`);
  }
  startMaxTime(w, worker, maxTimeMs);
  const label = formatDurationShort(maxTimeMs);
  return {
    text: `已将 Worker #${worker.id}“${worker.title}”本轮最大时间设为 ${label}（从现在重新计时）。`,
    data: { worker: toWorkerRecord(worker), maxTimeMs },
  };
}

export function endIn(w: WorkersCtx, p: Pending, caller: PmCaller, args: HubArgs<"worker.end">): HubResult<"worker.end"> {
  w.persona.assertPmNotArchived(caller.pmId);
  const worker = ownWorker(w, caller.pmId, args.workerId);
  if (worker.status === "ended") {
    clearMaxTime(w, worker.worker_conversation_id);
    return { text: `Worker #${worker.id}“${worker.title}”已经收工了，什么也没做。`, data: { worker: toWorkerRecord(worker) } };
  }
  const { ended, interrupted, nodeNote } = endWorkerIn(w, p, worker, { notifyGraph: true });
  const cleanup =
    ended.workspace === "worktree" && ended.review_json !== null
      ? ` ${worktreeLabel(ended)}会自动删掉。`
      : ended.workspace === "worktree"
        ? ` worktree ${ended.worktree_path} 和分支 ${ended.branch} 还在：PR 合并后或收工满 ${WORKTREE_RETENTION_DAYS} 天且没有未提交改动时会自动清理 worktree（分支保留；还有 Worker 接着用这个目录、或它经手的任务图还没结束时不清）。`
        : "";
  const interruptNote = interrupted ? "已打断正在跑的那一轮。" : "";
  return {
    text: `Worker #${ended.id}“${ended.title}”已收工。${interruptNote}${nodeNote === null ? "" : ` ${nodeNote}`}${cleanup}`,
    data: { worker: toWorkerRecord(ended) },
  };
}

export function endOpenWorkersIn(w: WorkersCtx, p: Pending, pmId: PmId): void {
  const openWorkers = w.db.all<WorkerDbRow>("SELECT * FROM workers WHERE pm_id = ? AND status = 'open' ORDER BY id", pmId);
  const t = w.now();
  for (const worker of openWorkers) {
    clearMaxTime(w, worker.worker_conversation_id);
    const session = workerSession(w, worker);
    const queued = w.db.all<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? AND status = 'queued' ORDER BY id", worker.worker_conversation_id);
    for (const { id } of queued) w.messages.transition(p, id, "stopped");
    const interrupted = !notStarted(worker) && w.messages.stopIn(p, { ...session, conversationId: worker.worker_conversation_id });
    if (interrupted) w.endInterrupted.add(session.id);
    if (!interrupted && !notStarted(worker) && (queued.length > 0 || session.status === "running")) {
      p.stops.push({ conversationId: worker.worker_conversation_id, sessionId: session.id });
    }
    w.awaitingBackground.take(session.id);
    w.db.run("UPDATE workers SET status = 'ended', updated_at = ? WHERE id = ?", t, worker.id);
    w.db.run("UPDATE agent_sessions SET status = 'ended', updated_at = ? WHERE id = ? AND status != 'ended'", t, session.id);
    const ended = workerRow(w, worker.id)!;
    w.enqueue(p, { type: "session.end", params: { sessionId: session.id, generation: session.generation } });
    w.sessions.updateLive(p, session.id, idle);
    insertLine(w, p, ended, { event: "ended", status: null, summary: null, turnMessageId: null, deliver: null });
    w.options.taskGraphs?.onWorkerEndedIn(p, ended.id);
  }
}
