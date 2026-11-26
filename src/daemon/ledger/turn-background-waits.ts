import { systemMessageDedupeKey, type MessageId, type SessionId, type SystemMessageMeta } from "../../shared/domain.ts";
import type { BackgroundChangedEvent, BackgroundTaskInfo } from "../../shared/driver.ts";
import { MAX_BACKGROUND_TASKS_TRACKED, WORKER_BACKGROUND_REMIND_AT_MS, WORKER_BACKGROUND_WAKE_GRACE_MS, WORKER_PURGE_BATCH_ROWS } from "../../shared/limits.ts";
import { HUB_COMMAND } from "../../shared/names.ts";
import { formatDurationShort } from "../../shared/schedule.ts";
import type { TurnId } from "../../shared/turn.ts";
import { isAgentVendor, vendorSpec } from "../../shared/vendors.ts";
import { z } from "zod";
import type { LedgerContext, Pending } from "./context.ts";
import { toMessage, type MessageDbRow } from "./rows.ts";
import type { TurnRecord } from "./turns.ts";

export interface BackgroundWaitRecord {
  readonly turnId: TurnId;
  readonly sessionId: SessionId;
  readonly draftMessageId: MessageId | null;
  readonly directChat: boolean;
  readonly tasks: readonly BackgroundTaskInfo[];
  readonly activeCount: number;
  readonly waitingSince: number;
  /** When the active count last reached zero; the wait then gives the vendor WORKER_BACKGROUND_WAKE_GRACE_MS to continue. */
  readonly drainedAt: number | null;
  readonly remindersSent: number;
  readonly nextRemindAt: number | null;
}

export type WaitRelease =
  | { readonly kind: "continued" }
  | { readonly kind: "drained" }
  | { readonly kind: "process_exited"; readonly reason: "interrupt" | "crash" | "startup_failed"; readonly failureReason: string }
  | { readonly kind: "process_exited"; readonly reason: "idle" }
  | { readonly kind: "restart" }
  | { readonly kind: "worker_ended" };

export interface BackgroundAtReply {
  readonly tasks: readonly BackgroundTaskInfo[];
  readonly activeCount: number;
}

interface WaitEntry extends BackgroundAtReply {
  readonly draftMessageId: MessageId | null;
  readonly directChat: boolean;
}

interface WorkerReply extends WaitEntry {
  readonly turn: TurnRecord;
  readonly vendor: string;
  readonly ownReply: boolean;
  readonly quiet: boolean;
  readonly previousRun: boolean;
}

interface TurnBackgroundWaitsDeps {
  deliverHeldReportIn(p: Pending, wait: BackgroundWaitRecord, release: Exclude<WaitRelease, { kind: "continued" | "worker_ended" }>): void;
  publishTurnIn(p: Pending, turnId: TurnId): void;
}

export interface LedgerTurnBackgroundWaits {
  /**
   * Precondition: `turn` just ended ok and its vendor declares `backgroundWake`.
   * Postcondition: one wait row for the turn's session with the first reminder due at waiting_since + WORKER_BACKGROUND_REMIND_AT_MS[0].
   */
  enterIn(p: Pending, turn: TurnRecord, entry: WaitEntry): BackgroundWaitRecord;
  /** Persists the task list and count; a count of zero starts the wake grace instead of releasing. */
  onBackgroundChangedIn(p: Pending, sessionId: SessionId, event: BackgroundChangedEvent): void;
  /** Deletes the session's wait and hands its draft to `deliverHeldReportIn` unless a continuation turn replaces it. */
  releaseIn(p: Pending, sessionId: SessionId, release: WaitRelease): BackgroundWaitRecord | null;
  waitOf(sessionId: SessionId): BackgroundWaitRecord | null;
  settleReplyIn(p: Pending, reply: WorkerReply): { kind: "held" | "released" } | { kind: "deliver"; infoNote?: string };
  /**
   * Enqueues at most one due reminder per wait and releases drained waits after the wake grace when no turn is running.
   * Postcondition: at most WORKER_BACKGROUND_REMIND_AT_MS.length reminders per wait; returns how many notices were enqueued.
   */
  runDue(nowMs: number): number;
  recover(): void;
  recoverSessionIn(p: Pending, sessionId: SessionId): void;
  /** True only while the reminder's wait still exists for the same turn and still has an active background command. */
  isReminderCurrent(messageId: MessageId): boolean;
}

type BackgroundDisposition =
  | { kind: "none" }
  | { kind: "hold" }
  | { kind: "deliver"; note: string };

const taskList = z.array(z.object({ id: z.string(), label: z.string(), startedAt: z.number() })).max(MAX_BACKGROUND_TASKS_TRACKED);
const clock = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const WAIT_COLUMNS = `b.turn_id AS turnId, b.session_id AS sessionId, b.draft_message_id AS draftMessageId,
  b.direct_chat AS directChat, b.tasks_json AS tasks, b.active_count AS activeCount, b.waiting_since AS waitingSince,
  b.drained_at AS drainedAt, b.reminders_sent AS remindersSent, b.next_remind_at AS nextRemindAt`;
const NO_PENDING_RECEIPT = "NOT EXISTS (SELECT 1 FROM turn_completions c WHERE c.session_id = b.session_id)";

type WaitRow = Omit<BackgroundWaitRecord, "tasks" | "directChat"> & { tasks: string; directChat: 0 | 1 };

function toWait(row: WaitRow): BackgroundWaitRecord {
  const tasks = taskList.safeParse(JSON.parse(row.tasks));
  return { ...row, tasks: tasks.data ?? [], directChat: row.directChat === 1 };
}

function backgroundDisposition(vendor: string, background: BackgroundAtReply): BackgroundDisposition {
  if (background.activeCount === 0) return { kind: "none" };
  if (isAgentVendor(vendor) && vendorSpec(vendor).capabilities.backgroundWake) return { kind: "hold" };
  const labels = background.tasks.slice(0, MAX_BACKGROUND_TASKS_TRACKED).map((task) => task.label).join("、");
  return { kind: "deliver", note: `【系统】模型已回复，还有 ${background.activeCount} 个后台命令在跑${labels === "" ? "。" : `：${labels}。`}` };
}

function reminderText(wait: BackgroundWaitRecord, worker: { id: number; title: string }, now: number): string {
  const elapsed = formatDurationShort(now - wait.waitingSince);
  const tasks = wait.tasks.map((task) => `- ${task.label} · 已跑 ${formatDurationShort(now - task.startedAt)}`);
  return `【Worker #${worker.id} · ${worker.title} 已回复，但还有 ${wait.activeCount} 个后台命令在跑（已等 ${elapsed}）】\n` +
    `模型 ${clock.format(wait.waitingSince)} 已写完回复，汇报等后台命令结束后再交。` +
    (tasks.length === 0 ? "\n" : `\n${tasks.join("\n")}\n`) +
    `用 ${HUB_COMMAND} worker show ${worker.id} 看现场，需要时用 ${HUB_COMMAND} worker send ${worker.id} 或 ${HUB_COMMAND} worker stop ${worker.id} 处理。`;
}

export function createLedgerTurnBackgroundWaits(ctx: LedgerContext, deps: TurnBackgroundWaitsDeps): LedgerTurnBackgroundWaits {
  const { db, now, write, enqueue } = ctx;
  const waitOf = (id: SessionId) => {
    const row = db.get<WaitRow>(`SELECT ${WAIT_COLUMNS} FROM turn_background_waits b WHERE b.session_id = ?`, id);
    return row === undefined ? null : toWait(row);
  };
  const reminderAt = (since: number, index: number) => {
    const delay = WORKER_BACKGROUND_REMIND_AT_MS[index];
    return delay === undefined ? null : since + delay;
  };

  function enterIn(p: Pending, turn: TurnRecord, entry: WaitEntry): BackgroundWaitRecord {
    const waitingSince = turn.endedAt ?? now();
    const nextRemindAt = reminderAt(waitingSince, 0);
    const tasks = entry.tasks.slice(0, MAX_BACKGROUND_TASKS_TRACKED);
    db.run(
      `INSERT INTO turn_background_waits
         (turn_id, session_id, draft_message_id, direct_chat, tasks_json, active_count, waiting_since, next_remind_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      turn.id, turn.sessionId, entry.draftMessageId, Number(entry.directChat),
      JSON.stringify(tasks), entry.activeCount, waitingSince, nextRemindAt, now(),
    );
    deps.publishTurnIn(p, turn.id);
    return { ...entry, tasks, turnId: turn.id, sessionId: turn.sessionId, waitingSince, nextRemindAt, drainedAt: null, remindersSent: 0 };
  }

  function onBackgroundChangedIn(p: Pending, sessionId: SessionId, event: BackgroundChangedEvent): void {
    const wait = waitOf(sessionId);
    if (wait === null) return;
    const at = event.at;
    const drainedAt = event.count === 0 ? wait.drainedAt ?? at : null;
    const tasks = event.count === 0 ? [] : (event.tasks ?? []).slice(0, MAX_BACKGROUND_TASKS_TRACKED);
    db.run(
      `UPDATE turn_background_waits SET tasks_json = ?, active_count = ?, drained_at = ?, next_remind_at = ?, updated_at = ?
       WHERE turn_id = ?`,
      JSON.stringify(tasks), event.count, drainedAt, drainedAt === null ? reminderAt(wait.waitingSince, wait.remindersSent) : null, at, wait.turnId,
    );
    deps.publishTurnIn(p, wait.turnId);
  }

  function releaseIn(p: Pending, sessionId: SessionId, release: WaitRelease): BackgroundWaitRecord | null {
    const wait = waitOf(sessionId);
    if (wait === null) return null;
    db.run("DELETE FROM turn_background_waits WHERE turn_id = ?", wait.turnId);
    deps.publishTurnIn(p, wait.turnId);
    if (release.kind !== "continued" && release.kind !== "worker_ended") deps.deliverHeldReportIn(p, wait, release);
    return wait;
  }

  function settleReplyIn(p: Pending, reply: WorkerReply): ReturnType<LedgerTurnBackgroundWaits["settleReplyIn"]> {
    const { turn, directChat, draftMessageId, activeCount, tasks } = reply;
    const wait = waitOf(turn.sessionId);
    if (wait !== null && directChat && turn.cause !== "self" && reply.quiet) return { kind: "held" };
    const disposition: BackgroundDisposition = reply.previousRun ? { kind: "none" } : backgroundDisposition(reply.vendor, reply);
    if (wait !== null && turn.cause === "self" && !reply.ownReply) {
      if (disposition.kind === "hold") return { kind: "held" };
      releaseIn(p, turn.sessionId, { kind: reply.previousRun ? "restart" : "drained" });
      return { kind: "released" };
    }
    if (wait !== null) releaseIn(p, turn.sessionId, { kind: "continued" });
    if (disposition.kind === "hold") {
      enterIn(p, turn, { draftMessageId, directChat, activeCount, tasks });
      return { kind: "held" };
    }
    return disposition.kind === "deliver" ? { kind: "deliver", infoNote: disposition.note } : { kind: "deliver" };
  }

  function enqueueReminderIn(p: Pending, wait: BackgroundWaitRecord, reminder: number, at: number): boolean {
    const worker = db.get<{ id: number; title: string; pmConversationId: number; workerConversationId: number; pmSessionId: SessionId }>(
      `SELECT w.id, w.title, w.pm_conversation_id AS pmConversationId, w.worker_conversation_id AS workerConversationId,
         pm.id AS pmSessionId FROM agent_sessions s JOIN workers w ON w.id = s.worker_id
       JOIN agent_sessions pm ON pm.conversation_id = w.pm_conversation_id
       WHERE s.id = ? AND w.status = 'open' ORDER BY pm.generation DESC LIMIT 1`, wait.sessionId,
    );
    if (worker === undefined) return false;
    const meta: SystemMessageMeta = {
      event: "worker.background_wait", workerId: worker.id, workerConversationId: worker.workerConversationId,
      turnId: wait.turnId, reminder,
    };
    const row = db.get<MessageDbRow>(
      `INSERT INTO messages (conversation_id, session_id, worker_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, ?, 'system', 'text', ?, ?, ?, 'queued', ?, ?)
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
      worker.pmConversationId, worker.pmSessionId, worker.id, reminderText(wait, worker, at), JSON.stringify(meta),
      systemMessageDedupeKey(worker.pmConversationId, meta), at, at,
    );
    if (row === undefined) return false;
    p.changes.push({ type: "message.created", data: { message: toMessage(row) } });
    enqueue(p, { type: "session.send", params: { sessionId: worker.pmSessionId, messageId: row.id, source: "system" } });
    return true;
  }

  function remindIn(p: Pending, wait: BackgroundWaitRecord, at: number): number {
    let { remindersSent, nextRemindAt } = wait;
    while (nextRemindAt !== null && nextRemindAt <= at) {
      remindersSent++;
      nextRemindAt = reminderAt(wait.waitingSince, remindersSent);
    }
    db.run("UPDATE turn_background_waits SET reminders_sent = ?, next_remind_at = ?, updated_at = ? WHERE turn_id = ?",
      remindersSent, nextRemindAt, at, wait.turnId);
    deps.publishTurnIn(p, wait.turnId);
    return enqueueReminderIn(p, wait, remindersSent, at) ? 1 : 0;
  }

  function runDue(at: number): number {
    const due = db.all<WaitRow>(
      `SELECT ${WAIT_COLUMNS} FROM turn_background_waits b
       WHERE ((b.active_count > 0 AND b.next_remind_at <= ?)
           OR (b.drained_at <= ? AND NOT EXISTS (
             SELECT 1 FROM turns t WHERE t.session_id = b.session_id AND t.status = 'running'
           ))) AND ${NO_PENDING_RECEIPT}
       ORDER BY coalesce(b.next_remind_at, b.drained_at), b.turn_id LIMIT ?`,
      at, at - WORKER_BACKGROUND_WAKE_GRACE_MS, WORKER_PURGE_BATCH_ROWS,
    );
    if (due.length === 0) return 0;
    return write((p) => {
      let count = 0;
      for (const row of due) {
        const wait = toWait(row);
        if (wait.activeCount === 0) releaseIn(p, wait.sessionId, { kind: "drained" });
        else count += remindIn(p, wait, at);
      }
      return count;
    });
  }

  function recover(): void {
    for (;;) {
      const rows = db.all<{ sessionId: SessionId }>(
        `SELECT b.session_id AS sessionId FROM turn_background_waits b WHERE ${NO_PENDING_RECEIPT}
         ORDER BY b.session_id LIMIT ?`, WORKER_PURGE_BATCH_ROWS,
      );
      if (rows.length === 0) return;
      write((p) => {
        for (const row of rows) releaseIn(p, row.sessionId, { kind: "restart" });
      });
    }
  }

  function recoverSessionIn(p: Pending, id: SessionId): void {
    if (db.get("SELECT 1 FROM turn_completions WHERE session_id = ? LIMIT 1", id) === undefined) {
      releaseIn(p, id, { kind: "restart" });
    }
  }

  function isReminderCurrent(id: MessageId): boolean {
    return db.get(
      `SELECT 1 FROM messages m JOIN turn_background_waits b ON b.turn_id = json_extract(m.meta, '$.turnId')
       JOIN agent_sessions s ON s.id = b.session_id JOIN workers w ON w.id = s.worker_id
       WHERE m.id = ? AND b.active_count > 0 AND m.worker_id = w.id
         AND m.conversation_id = w.pm_conversation_id AND w.status = 'open' AND ${NO_PENDING_RECEIPT}`, id,
    ) !== undefined;
  }

  return { enterIn, onBackgroundChangedIn, releaseIn, waitOf, settleReplyIn, runDue, recover, recoverSessionIn, isReminderCurrent };
}
