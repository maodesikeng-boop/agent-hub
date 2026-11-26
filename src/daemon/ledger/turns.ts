import { randomUUID } from "node:crypto";
import { turnFailureReason } from "../../shared/driver.ts";
import { TURN_HISTORY_MAX_PER_CONV, TURN_RECOVERY_MAX_ATTEMPTS, TURN_SUMMARIES_PER_PAGE_MAX } from "../../shared/limits.ts";
import { isRecoveryStop } from "../../shared/turn.ts";
import { getAgentSession } from "../store/index.ts";
import { exitFailureReason } from "./messages.ts";
import { CHECKLIST_REMINDER_SQL } from "./checklist-reminders.ts";
import type { AgentSessionRow, ConversationId, Message, MessageId, MessageStatus, SessionId } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import type { StopSource, TurnCause, TurnId, TurnInputRole, TurnOutcome, TurnStatus, TurnSummary } from "../../shared/turn.ts";
import type { LedgerContext, Pending } from "./context.ts";
import type { LegacyTurnReplyFacts, TurnEndedEvent } from "./turn-completions.ts";

export const SHUTDOWN_INTERRUPTED_REASON = "守护进程关闭打断了这一轮，重启后会重发";

export interface TurnRecord {
  readonly id: TurnId;
  readonly sessionId: SessionId;
  readonly conversationId: ConversationId;
  readonly cause: TurnCause;
  readonly status: TurnStatus;
  readonly outcome: TurnOutcome | null;
  readonly stopSource: StopSource | null;
  readonly failureReason: string | null;
  readonly parentTurnId: TurnId | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly durationMs: number | null;
  readonly firstOutputId: MessageId | null;
  readonly lastOutputId: MessageId | null;
  readonly replyMessageId: MessageId | null;
}

export type InputOutcome = "replied" | "stopped" | "failed" | "interrupted";

export interface TurnInputRecord {
  readonly turnId: TurnId;
  readonly messageId: MessageId;
  readonly role: TurnInputRole;
  readonly afterMessageId: MessageId | null;
  readonly takenAt: number | null;
  readonly outcome: InputOutcome | null;
  readonly stopSource: StopSource | null;
}

export interface SettledTurn {
  readonly turn: TurnRecord;
  readonly inputs: readonly TurnInputRecord[];
  /** True when the turn produced no text, tool call, or checklist update. */
  readonly empty: boolean;
}

export interface RecoveryResend {
  readonly sessionId: SessionId;
  readonly messageId: MessageId;
  readonly interruptedTurnId: TurnId;
  /** 1 for the first resend of this input after a restart. */
  readonly attempt: number;
}

export interface TurnsDeps {
  failureReasonOfTurn?(session: AgentSessionRow, event: TurnEndedEvent): string | null;
  closeTurnActivity(session: AgentSessionRow, turnId: TurnId, endedAt: number): void;
  /** Writes the `messages.status` projection for one input; supplied by the messages module, which owns the column. */
  projectInputStatus(p: Pending, messageId: MessageId, status: MessageStatus, reason: string | null, replyId?: MessageId): void;
}

export interface LedgerTurns {
  /**
   * Opens a turn on the first taken input or `turn.started` of an idle session, attaches later taken inputs as `mid_turn`,
   * and extends the running turn's output range on agent text, tool, and checklist messages.
   * Postcondition: events for a session with no running turn and no opening signal change nothing.
   */
  afterDriverEvent(p: Pending, session: AgentSessionRow, event: Exclude<DriverEvent, TurnEndedEvent>): void;
  /**
   * Ends the running turn from a durable `turn.ended` receipt in the receipt's transaction and settles every input the
   * turn took. A successful receipt settles its inputs as replied even when a stop was requested meanwhile; only a
   * receipt that reports interruption settles them as stopped, with the recorded stop source.
   * Postcondition: returns null for a duplicate receipt or a session with no running turn; never reopens an ended turn.
   */
  settle(p: Pending, session: AgentSessionRow, event: TurnEndedEvent, previousRun: boolean, storedFacts?: LegacyTurnReplyFacts): SettledTurn | null;
  /** Ends the running turn when the process exits without a receipt; `startup_failed` before any turn opens a failed turn. */
  settleExit(p: Pending, session: AgentSessionRow, event: Extract<DriverEvent, { type: "session.exited" | "driver.error" }>): SettledTurn | null;
  /** Records the stop source. Inputs in a running turn stay unsettled until the terminal event. */
  requestStopIn(p: Pending, sessionId: SessionId, source: StopSource): void;
  recordOutputIn(p: Pending, session: AgentSessionRow, event: DriverEvent): void;
  recordFailedStartIn(p: Pending, session: AgentSessionRow, messageId: MessageId, reason: string): void;
  ownsInput(messageId: MessageId): boolean;
  stopInputIn(p: Pending, messageId: MessageId, source: StopSource | null): boolean;
  runningTurnOf(sessionId: SessionId): TurnRecord | null;
  lastEndedTurnOf(sessionId: SessionId, before?: TurnId): TurnRecord | null;
  sessionTurns(sessionId: SessionId): TurnRecord[];
  turnOf(id: TurnId): TurnRecord | null;
  /** The newest turn that took this input, or null when no turn has taken it yet. */
  turnTakingInput(messageId: MessageId): TurnRecord | null;
  /**
   * Postcondition: one summary per turn whose output range or inputs intersect `messages`, plus the session's running
   * turn, ordered by id and capped at TURN_SUMMARIES_PER_PAGE_MAX.
   */
  summariesFor(conversationId: ConversationId, messages: readonly Message[]): TurnSummary[];
  publishTurnIn(p: Pending, turnId: TurnId): void;
  /**
   * Runs once at startup after every pending receipt settles and before any send. Ends each turn still running (the
   * previous process died without a receipt) as interrupted by `crash`. Returns one resend per input that a turn interrupted by `shutdown` or `crash` took and that no later turn has taken, skipping inputs
   * already resent TURN_RECOVERY_MAX_ATTEMPTS times. Postcondition: a second call before any send returns nothing new.
   */
  recoverAfterRestartIn(p: Pending): RecoveryResend[];
}

const TURN_COLUMNS = `t.id, t.session_id AS sessionId, t.conversation_id AS conversationId, t.cause, t.status,
  t.outcome, t.stop_source AS stopSource, t.failure_reason AS failureReason, t.parent_turn_id AS parentTurnId,
  t.started_at AS startedAt, t.ended_at AS endedAt, t.duration_ms AS durationMs, t.first_output_id AS firstOutputId,
  t.last_output_id AS lastOutputId, t.reply_message_id AS replyMessageId`;
const INPUT_COLUMNS = `i.turn_id AS turnId, i.message_id AS messageId, i.role, i.after_message_id AS afterMessageId,
  i.taken_at AS takenAt, i.outcome, i.stop_source AS stopSource`;

interface TakeableInput {
  id: MessageId;
  parentTurnId: TurnId | null;
  attempts: number;
}

type End =
  | { outcome: "ok" | "empty_recovery"; at: number }
  | { outcome: "interrupted"; at: number; source: StopSource; stopRequested?: boolean }
  | { outcome: "failed"; at: number; reason: string; source?: StopSource; finishedWithText?: MessageId };

function summariesFor(db: LedgerContext["db"], conversationId: ConversationId, messages: readonly Message[]): TurnSummary[] {
  const first = messages[0]?.id ?? null;
  const last = messages.at(-1)?.id ?? null;
  const turns = db.all<TurnRecord>(
    `WITH matching(id, running) AS (
       SELECT id, 1 FROM turns WHERE conversation_id = ? AND status = 'running'
       UNION
       SELECT id, 0 FROM turns WHERE conversation_id = ? AND status = 'ended' AND last_output_id >= ? AND first_output_id <= ?
       UNION
       SELECT t.id, t.status = 'running' FROM turn_inputs i
       CROSS JOIN turns t ON t.id = i.turn_id
       WHERE i.message_id IN (SELECT value FROM json_each(?)) AND t.conversation_id = ?
       ORDER BY 2 DESC, 1 DESC LIMIT ?
     )
     SELECT ${TURN_COLUMNS} FROM matching JOIN turns t ON t.id = matching.id`,
    conversationId, conversationId, first, last, JSON.stringify(messages.map((message) => message.id)), conversationId, TURN_SUMMARIES_PER_PAGE_MAX,
  );
  return summarizeTurns(db, turns);
}

function summarizeTurns(db: LedgerContext["db"], turns: TurnRecord[]): TurnSummary[] {
  if (turns.length === 0) return [];
  const ids = JSON.stringify(turns.map((turn) => turn.id));
  const inputs = new Map<TurnId, TurnSummary["inputs"][number][]>();
  for (const row of db.all<TurnInputRecord>(
    `SELECT ${INPUT_COLUMNS} FROM turn_inputs i JOIN messages m ON m.id = i.message_id
     WHERE i.turn_id IN (SELECT value FROM json_each(?)) AND i.taken_at IS NOT NULL AND NOT ${CHECKLIST_REMINDER_SQL}
     ORDER BY i.taken_at, i.message_id`, ids,
  )) {
    const input = { messageId: row.messageId, role: row.role, afterMessageId: row.afterMessageId };
    const list = inputs.get(row.turnId);
    if (list === undefined) inputs.set(row.turnId, [input]);
    else list.push(input);
  }
  const waits = db.all<{ turnId: TurnId } & NonNullable<TurnSummary["background"]>>(
    `SELECT turn_id AS turnId, active_count AS activeCount, waiting_since AS waitingSince, reminders_sent AS remindersSent
       FROM turn_background_waits WHERE turn_id IN (SELECT value FROM json_each(?))`, ids,
  );
  const background = new Map(waits.map(({ turnId, ...wait }) => [turnId, wait]));
  return turns.sort((a, b) => a.id - b.id).map(({ replyMessageId: _reply, failureReason: _reason, ...turn }) => ({
    ...turn, inputs: inputs.get(turn.id) ?? [], background: background.get(turn.id) ?? null,
  }));
}

function turnOwnsInput(db: LedgerContext["db"], id: MessageId): boolean {
  return db.get(
    `SELECT 1 FROM turn_inputs i JOIN turns t ON t.id = i.turn_id JOIN messages m ON m.id = i.message_id
     WHERE i.message_id = ? AND i.taken_at IS NOT NULL AND m.session_id = t.session_id
       AND (t.status = 'running' OR (i.outcome = 'interrupted' AND m.status = 'processing'))
       AND NOT EXISTS (SELECT 1 FROM turn_inputs n WHERE n.message_id = i.message_id AND n.turn_id > i.turn_id)`, id,
  ) !== undefined;
}

function legacyInputsOf(db: LedgerContext["db"], sessionId: SessionId, ids: readonly MessageId[]): MessageId[] {
  return db.all<{ id: MessageId }>(
    `SELECT m.id FROM messages m WHERE m.session_id = ? AND m.id IN (SELECT value FROM json_each(?))
     AND m.status IN ('delivered', 'processing')
     AND NOT EXISTS (SELECT 1 FROM turn_inputs i WHERE i.message_id = m.id)`,
    sessionId, JSON.stringify(ids),
  ).map((row) => row.id);
}

function validateLegacyReply(db: LedgerContext["db"], sessionId: SessionId, facts?: LegacyTurnReplyFacts): LegacyTurnReplyFacts | undefined {
  if (facts?.reply == null || db.get(
    "SELECT 1 FROM messages WHERE id = ? AND session_id = ? AND kind = 'text' AND sender = 'agent'", facts.reply.messageId, sessionId,
  )) return facts;
  return { ...facts, reply: null };
}

function openTurn(db: LedgerContext["db"], session: AgentSessionRow, cause: TurnCause, at: number, parent: TurnId | null) {
  if (session.conversationId === null) return null;
  return db.run(
    `INSERT INTO turns (session_id, conversation_id, cause, status, parent_turn_id, started_at, updated_at)
     VALUES (?, ?, ?, 'running', ?, ?, ?)`,
    session.id, session.conversationId, cause, parent, at, at,
  ).lastInsertRowid;
}

function attachFailedDeliveries(db: LedgerContext["db"], session: AgentSessionRow, turn: TurnRecord | null, event: TurnEndedEvent): TurnRecord | null {
  if (event.shutdown || (event.ok && !event.interrupted) || event.messageIds.length === 0) return turn;
  const inputs = db.all<{ id: MessageId }>(
    `SELECT id FROM messages WHERE session_id = ? AND status = 'delivered'
       AND id IN (SELECT value FROM json_each(?)) ORDER BY id`, session.id, JSON.stringify(event.messageIds),
  );
  if (inputs.length === 0) return turn;
  const turnId = turn?.id ?? openTurn(db, session, "input", event.at, null);
  if (turnId === null) return turn;
  for (const { id } of inputs) {
    db.run("INSERT OR IGNORE INTO turn_inputs (turn_id, message_id, role) VALUES (?, ?, ?)",
      turnId, id, turn === null ? "opening" : "mid_turn");
  }
  return turn ?? db.get<TurnRecord>(`SELECT ${TURN_COLUMNS} FROM turns t WHERE t.id = ?`, turnId) ?? null;
}

export function createLedgerTurns(ctx: LedgerContext, deps: TurnsDeps): LedgerTurns {
  const { db, now } = ctx;
  const recoveryBootId = randomUUID();
  let recoveredOrphans = false;
  const runningTurnOf = (id: SessionId) => db.get<TurnRecord>(
    `SELECT ${TURN_COLUMNS} FROM turns t WHERE t.session_id = ? AND t.status = 'running'`, id,
  ) ?? null;
  const lastEndedTurnOf = (id: SessionId, before: TurnId = Number.MAX_SAFE_INTEGER) => db.get<TurnRecord>(
    `SELECT ${TURN_COLUMNS} FROM turns t WHERE t.session_id = ? AND t.status = 'ended' AND t.id < ? ORDER BY t.id DESC LIMIT 1`, id, before,
  ) ?? null;
  const turnOf = (id: TurnId) => db.get<TurnRecord>(`SELECT ${TURN_COLUMNS} FROM turns t WHERE t.id = ?`, id) ?? null;
  const turnTakingInput = (id: MessageId) => db.get<TurnRecord>(
    `SELECT ${TURN_COLUMNS} FROM turn_inputs i JOIN turns t ON t.id = i.turn_id
      WHERE i.message_id = ? ORDER BY i.turn_id DESC LIMIT 1`, id,
  ) ?? null;

  function publishTurnIn(p: Pending, turnId: TurnId): void {
    const turn = turnOf(turnId);
    const summary = turn === null ? undefined : summarizeTurns(db, [turn])[0];
    if (summary === undefined) return;
    const index = p.changes.findIndex((change) => change.type === "turn.updated" && change.data.turn.id === turnId);
    const change = { type: "turn.updated", data: { turn: summary } } satisfies Pending["changes"][number];
    if (index === -1) p.changes.push(change);
    else p.changes[index] = change;
  }

  const open = (session: AgentSessionRow, cause: TurnCause, at: number, parent: TurnId | null) => openTurn(db, session, cause, at, parent);

  function takeableInputs(sessionId: SessionId, ids: readonly MessageId[]): TakeableInput[] {
    if (ids.length === 0) return [];
    return db.all<TakeableInput>(
      `SELECT m.id, CASE WHEN p.outcome = 'interrupted' AND (p.recovery_boot_id IS NOT NULL OR p.stop_source = 'crash') AND m.status = 'processing'
                          THEN p.turn_id END AS parentTurnId,
              CASE WHEN m.status = 'processing' THEN coalesce(p.recovery_attempts, 0) ELSE 0 END AS attempts
       FROM messages m
       LEFT JOIN turn_inputs p ON p.message_id = m.id AND p.turn_id = (
         SELECT max(i.turn_id) FROM turn_inputs i WHERE i.message_id = m.id
       )
       WHERE m.session_id = ? AND m.id IN (SELECT value FROM json_each(?))
         AND (m.status = 'delivered' OR
              (m.status = 'processing' AND (p.turn_id IS NULL OR (p.outcome = 'interrupted' AND (p.recovery_boot_id IS NOT NULL OR p.stop_source = 'crash')))))
       ORDER BY m.id`, sessionId, JSON.stringify(ids),
    );
  }

  function take(p: Pending, session: AgentSessionRow, ids: readonly MessageId[], at: number) {
    const inputs = takeableInputs(session.id, ids);
    if (inputs.length === 0 || session.conversationId === null) return;
    const running = runningTurnOf(session.id);
    const parent = inputs.find((input) => input.parentTurnId !== null)?.parentTurnId ?? null;
    const turnId = running?.id ?? open(session, parent === null ? "input" : "recovery", at, parent);
    if (turnId === null) return;
    const after = running?.lastOutputId ?? db.get<{ id: MessageId | null }>(
      "SELECT max(id) AS id FROM messages WHERE conversation_id = ?", session.conversationId,
    )?.id ?? null;
    for (const input of inputs) {
      db.run(
        `INSERT INTO turn_inputs (turn_id, message_id, role, after_message_id, taken_at, recovery_attempts)
         VALUES (?, ?, ?, ?, ?, ?)`, turnId, input.id, running === null ? "opening" : "mid_turn", after, at, input.attempts,
      );
      deps.projectInputStatus(p, input.id, "processing", null);
    }
    publishTurnIn(p, turnId);
  }

  function recordOutputIn(p: Pending, session: AgentSessionRow, event: DriverEvent) {
    if (event.type !== "agent.text" && event.type !== "agent.tool" && event.type !== "agent.checklist") return;
    const change = p.changes.findLast((c) => c.type === "message.created" && c.data.message.sessionId === session.id && c.data.message.sender === "agent");
    if (change?.type !== "message.created") return;
    const msg = change.data.message;
    const reply = event.type === "agent.text" && event.parentToolUseId === undefined && msg.meta?.["handover"] !== true ? msg.id : null;
    const updated = db.get<{ id: TurnId }>(
      `UPDATE turns SET first_output_id = coalesce(first_output_id, ?), last_output_id = ?,
         reply_message_id = coalesce(?, reply_message_id), updated_at = ?
       WHERE session_id = ? AND status = 'running' RETURNING id`, msg.id, msg.id, reply, event.at, session.id,
    );
    if (updated !== undefined) publishTurnIn(p, updated.id);
  }

  function finish(p: Pending, session: AgentSessionRow, turn: TurnRecord, end: End, legacy?: LegacyTurnReplyFacts): SettledTurn {
    const endedAt = Math.max(end.at, turn.startedAt);
    const stopSource = ("source" in end ? end.source : undefined) ?? turn.stopSource;
    const reason = end.outcome === "failed" ? end.reason : null;
    const reply = end.outcome === "interrupted" ? null : turn.replyMessageId ?? legacy?.reply?.messageId ?? null;
    db.run(
      `UPDATE turns SET status = 'ended', outcome = ?, stop_source = ?, failure_reason = ?, ended_at = ?,
         duration_ms = ?, reply_message_id = ?, updated_at = ? WHERE id = ?`,
      end.outcome, stopSource, reason, endedAt, endedAt - turn.startedAt, reply, endedAt, turn.id,
    );
    deps.closeTurnActivity(session, turn.id, endedAt);
    const rows = db.all<TurnInputRecord & { ownerId: SessionId | null; sender: Message["sender"]; scheduleRun: number }>(
      `SELECT ${INPUT_COLUMNS}, m.session_id AS ownerId, m.sender, (CASE WHEN json_valid(m.meta) THEN json_extract(m.meta, '$.event') IS 'schedule.run' ELSE 0 END) AS scheduleRun
       FROM turn_inputs i JOIN messages m ON m.id = i.message_id WHERE i.turn_id = ? ORDER BY i.message_id`, turn.id,
    );
    const inputs: TurnInputRecord[] = [];
    for (const row of rows) {
      const after = row.afterMessageId ?? 0;
      const resend = end.outcome === "interrupted" && end.stopRequested !== true && isRecoveryStop(stopSource) &&
        (stopSource === "crash" || session.role === "worker" || row.sender === "system");
      const hasReply = end.outcome === "failed" && row.takenAt !== null && row.sender === "user" &&
        ((end.finishedWithText ?? 0) > after || legacy?.finishedWithText?.includes(row.messageId) === true);
      const outcome: InputOutcome = end.outcome === "interrupted" ? (resend ? "interrupted" : "stopped") :
        end.outcome === "failed" && !hasReply ? "failed" : "replied";
      const source = end.outcome === "interrupted" ? stopSource : null;
      db.run("UPDATE turn_inputs SET outcome = ?, stop_source = ? WHERE turn_id = ? AND message_id = ?", outcome, source, turn.id, row.messageId);
      if (row.ownerId !== session.id) continue;
      inputs.push({ ...row, outcome, stopSource: source });
      if (outcome === "interrupted") continue;
      const replyId = outcome === "replied" && row.takenAt !== null && session.role === "pm" && (row.sender === "user" || row.scheduleRun === 1)
        && reply !== null && (legacy === undefined ? reply > after : legacy.reply?.requestIds.includes(row.messageId) === true) ? reply : undefined;
      deps.projectInputStatus(p, row.messageId, outcome, reason, replyId);
    }
    publishTurnIn(p, turn.id);
    return { turn: { ...turn, status: "ended", endedAt, durationMs: endedAt - turn.startedAt, outcome: end.outcome,
      stopSource, failureReason: reason, replyMessageId: reply }, inputs, empty: turn.firstOutputId === null };
  }

  function settle(p: Pending, session: AgentSessionRow, event: TurnEndedEvent, previousRun: boolean, storedFacts?: LegacyTurnReplyFacts): SettledTurn | null {
    let legacy: LegacyTurnReplyFacts | undefined;
    if (previousRun && runningTurnOf(session.id) === null) {
      take(p, session, legacyInputsOf(db, session.id, event.messageIds), event.at);
      legacy = validateLegacyReply(db, session.id, storedFacts);
    }
    const running = runningTurnOf(session.id);
    if (running !== null && event.at < running.startedAt) return null;
    const turn = attachFailedDeliveries(db, session, running, event);
    if (turn === null) return null;
    if (event.messageIds.length > 0 && !db.get(
      `SELECT 1 FROM turn_inputs WHERE turn_id = ? AND message_id IN (SELECT value FROM json_each(?)) LIMIT 1`,
      turn.id, JSON.stringify(event.messageIds),
    )) return null;
    if (event.interrupted || event.shutdown) {
      return finish(p, session, turn, { outcome: "interrupted", at: event.at,
        source: event.shutdown ? "shutdown" : turn.stopSource ?? "session_ended", stopRequested: turn.stopSource !== null });
    }
    const failure = deps.failureReasonOfTurn?.(session, event) ?? null;
    if (failure !== null) return finish(p, session, turn, { outcome: "failed", at: event.at, reason: failure });
    if (!event.ok) {
      const text = turn.lastOutputId !== null && db.get("SELECT 1 FROM messages WHERE id = ? AND kind = 'text'", turn.lastOutputId);
      return finish(p, session, turn, { outcome: "failed", at: event.at,
        reason: event.error ? turnFailureReason(event.error) : "turn_failed", ...(text ? { finishedWithText: turn.lastOutputId } : {}) }, legacy);
    }
    return finish(p, session, turn, { outcome: turn.cause === "recovery" && turn.firstOutputId === null ? "empty_recovery" : "ok", at: event.at }, legacy);
  }

  function recordFailedStartIn(p: Pending, session: AgentSessionRow, messageId: MessageId, reason: string, at = now()): void {
    if (runningTurnOf(session.id) !== null || session.conversationId === null || session.status === "ended") return;
    const previous = turnTakingInput(messageId);
    const parent = previous?.outcome === "interrupted" && isRecoveryStop(previous.stopSource) ? previous.id : null;
    const turnId = open(session, parent === null ? "input" : "recovery", at, parent);
    if (turnId === null) return;
    db.run("INSERT INTO turn_inputs (turn_id, message_id, role) VALUES (?, ?, 'opening')", turnId, messageId);
    const turn = turnOf(turnId);
    if (turn !== null) finish(p, session, turn, { outcome: "failed", at, reason });
  }

  function settleExit(p: Pending, session: AgentSessionRow, event: Extract<DriverEvent, { type: "session.exited" | "driver.error" }>) {
    const turn = runningTurnOf(session.id);
    if (turn === null) {
      if (event.type === "session.exited" && event.reason === "startup_failed" && event.messageIds[0] !== undefined) {
        recordFailedStartIn(p, session, event.messageIds[0], exitFailureReason(event), event.at);
      }
      return null;
    }
    if (event.type === "driver.error") {
      if (!event.messageIds?.some((id) => turnTakingInput(id)?.id === turn.id)) return null;
      return finish(p, session, turn, { outcome: "failed", at: event.at, reason: event.message });
    }
    if (event.reason === "crash" || event.reason === "startup_failed") {
      return finish(p, session, turn, { outcome: "failed", at: event.at, reason: exitFailureReason(event), source: turn.stopSource ?? "crash" });
    }
    return finish(p, session, turn, { outcome: "interrupted", at: event.at,
      source: event.reason === "shutdown" ? "shutdown" : turn.stopSource ?? "session_ended", stopRequested: turn.stopSource !== null });
  }

  function recoverAfterRestartIn(p: Pending): RecoveryResend[] {
    if (!recoveredOrphans) {
      for (const turn of db.all<TurnRecord>(
        `SELECT ${TURN_COLUMNS} FROM turns t WHERE t.status = 'running'
         AND NOT EXISTS (SELECT 1 FROM turn_completions c WHERE c.session_id = t.session_id)`,
      )) {
        const session = getAgentSession(db, turn.sessionId);
        if (session !== null) finish(p, session, turn, { outcome: "interrupted", at: now(), source: "crash", stopRequested: turn.stopSource !== null });
      }
      p.after.push(() => { recoveredOrphans = true; });
    }
    const candidates = db.all<Omit<RecoveryResend, "attempt"> & { attempts: number }>(
      `SELECT t.session_id AS sessionId, i.message_id AS messageId, t.id AS interruptedTurnId, i.recovery_attempts AS attempts
       FROM turn_inputs i JOIN turns t ON t.id = i.turn_id
       JOIN messages m ON m.id = i.message_id AND m.session_id = t.session_id
       JOIN agent_sessions s ON s.id = t.session_id
       LEFT JOIN workers w ON w.id = s.worker_id
       LEFT JOIN pm_archives pa ON pa.pm_id = coalesce(s.pm_id, w.pm_id)
       WHERE i.outcome = 'interrupted' AND i.stop_source IN ('shutdown', 'crash')
         AND i.recovery_boot_id IS NOT ? AND m.status = 'processing'
         AND NOT EXISTS (SELECT 1 FROM turn_inputs later WHERE later.message_id = i.message_id AND later.turn_id > i.turn_id)
         AND NOT EXISTS (SELECT 1 FROM turn_completions c WHERE c.session_id = s.id)
         AND s.status != 'ended' AND pa.pm_id IS NULL
         AND (w.id IS NULL OR (w.status = 'open' AND (w.workspace = 'main' OR w.base_commit IS NOT NULL)))
         AND NOT EXISTS (SELECT 1 FROM worker_sandbox_approvals a WHERE a.worker_id = w.id AND a.status = 'pending')
       ORDER BY i.message_id`, recoveryBootId,
    );
    const resends: RecoveryResend[] = [];
    for (const { attempts, ...input } of candidates) {
      if (attempts >= TURN_RECOVERY_MAX_ATTEMPTS) {
        db.run("UPDATE turn_inputs SET outcome = 'stopped' WHERE turn_id = ? AND message_id = ?", input.interruptedTurnId, input.messageId);
        deps.projectInputStatus(p, input.messageId, "stopped", null);
        continue;
      }
      const attempt = attempts + 1;
      db.run("UPDATE turn_inputs SET recovery_attempts = ?, recovery_boot_id = ? WHERE turn_id = ? AND message_id = ?",
        attempt, recoveryBootId, input.interruptedTurnId, input.messageId);
      resends.push({ ...input, attempt });
    }
    return resends;
  }

  function stopInputIn(p: Pending, id: MessageId, source: StopSource | null): boolean {
    const turn = turnTakingInput(id);
    if (turn === null) return false;
    if (turn.status === "running") {
      if (source !== null) db.run("UPDATE turns SET stop_source = coalesce(stop_source, ?) WHERE id = ?", source, turn.id);
      return true;
    }
    const stopped = db.run(
      "UPDATE turn_inputs SET outcome = 'stopped', stop_source = ? WHERE turn_id = ? AND message_id = ? AND outcome = 'interrupted'",
      source ?? "session_ended", turn.id, id,
    ).changes > 0;
    if (stopped) deps.projectInputStatus(p, id, "stopped", null);
    return stopped;
  }

  return {
    afterDriverEvent(p, session, event) {
      if (event.type === "message.processing") take(p, session, event.messageIds, event.at);
      else if (event.type === "turn.started") {
        if (runningTurnOf(session.id) === null) {
          const turnId = open(session, "self", event.at, null);
          if (turnId !== null) publishTurnIn(p, turnId);
        }
      } else if (event.type === "session.started") {
        const turn = runningTurnOf(session.id);
        if (turn !== null) finish(p, session, turn, { outcome: "interrupted", at: event.at,
          source: "crash", stopRequested: turn.stopSource !== null });
      } else recordOutputIn(p, session, event);
    },
    settle, settleExit, recordOutputIn, recordFailedStartIn, runningTurnOf, lastEndedTurnOf, turnOf, turnTakingInput, summariesFor: (id, messages) => summariesFor(db, id, messages), recoverAfterRestartIn,
    publishTurnIn,
    sessionTurns: (id) => db.all<TurnRecord>(
      `SELECT ${TURN_COLUMNS} FROM turns t WHERE t.session_id = ? ORDER BY t.id DESC LIMIT ?`, id, TURN_HISTORY_MAX_PER_CONV,
    ).reverse(),
    requestStopIn(p, id, source) {
      const running = db.run("UPDATE turns SET stop_source = coalesce(stop_source, ?) WHERE session_id = ? AND status = 'running'", source, id);
      if (running.changes > 0) return;
      for (const message of db.all<{ id: MessageId }>("SELECT id FROM messages WHERE session_id = ? AND status = 'processing'", id)) {
        stopInputIn(p, message.id, source);
      }
    },
    ownsInput: (id) => turnOwnsInput(db, id),
    stopInputIn,
  };
}
