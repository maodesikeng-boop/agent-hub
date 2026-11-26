import type { MessageId, SessionId } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import {
  TURN_COMPLETION_RETRY_BATCH_SIZE,
  TURN_COMPLETION_RETRY_MAX_MS,
  TURN_COMPLETION_RETRY_MIN_MS,
  TURN_COMPLETION_UNPERSISTED_MAX,
} from "../../shared/limits.ts";
import { LOG_PREFIX } from "../../shared/names.ts";
import type { LedgerContext, Pending } from "./context.ts";

export type TurnEndedEvent = Extract<DriverEvent, { type: "turn.ended" }>;

export interface TurnCompletionReceipt {
  readonly sequence: number;
  readonly sessionId: SessionId;
  readonly event: TurnEndedEvent;
}

export interface LegacyTurnReplyFacts {
  readonly reply?: { readonly messageId: MessageId; readonly requestIds: readonly MessageId[] } | null;
  readonly finishedWithText?: readonly MessageId[];
}

export interface TurnCompletionFacts extends LegacyTurnReplyFacts {
  readonly worker: {
    readonly turnStart: MessageId;
    readonly waitingForBackground: boolean;
  } | null;
}

export const NO_TURN_FACTS: TurnCompletionFacts = { worker: null };

export type TurnCompletionResult =
  | { readonly kind: "settled" }
  | { readonly kind: "already_settled" }
  | { readonly kind: "pending"; readonly retryAt: number }
  | { readonly kind: "dropped" };

export interface TurnCompletionEffects {
  /** `previousRun` marks a receipt recorded before this daemon started, so its agent process and background commands are gone. */
  apply(p: Pending, receipt: TurnCompletionReceipt, facts: TurnCompletionFacts, previousRun: boolean): void;
  onSettled(receipt: TurnCompletionReceipt): void;
  onOverflow(sessionId: SessionId): void;
}

interface ReceiptRow {
  sequence: number;
  session_id: SessionId;
  event: string;
  facts: string | null;
  attempts: number;
  next_attempt_at: number;
}

interface PendingWrite {
  receipt: TurnCompletionReceipt;
  facts: TurnCompletionFacts | null;
  attempts: number;
  retryAt: number;
}

const ERROR_PREFIX = "Turn completion write failed: ";
const delayOf = (attempts: number) => Math.min(TURN_COMPLETION_RETRY_MAX_MS, TURN_COMPLETION_RETRY_MIN_MS * 2 ** attempts);
const SESSION_HEAD = `NOT EXISTS (SELECT 1 FROM turn_completions earlier WHERE earlier.session_id = r.session_id AND earlier.sequence < r.sequence)`;

export function createTurnCompletionLedger(ctx: LedgerContext, effects: TurnCompletionEffects) {
  const { db, now, write, reportHealthIn } = ctx;
  const startupSequence = db.get<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'turn_completions'")?.seq ?? 0;
  let sequence = startupSequence;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerAt = Infinity;
  let closed = false;
  let overflow = false;
  let reportedError: string | undefined;
  const pendingWrites = new Map<number, PendingWrite>();

  const hasEarlierWrite = (receipt: TurnCompletionReceipt) => [...pendingWrites.values()].some(
    (entry) => entry.receipt.sessionId === receipt.sessionId && entry.receipt.sequence < receipt.sequence,
  );

  function wakeAt(at: number): void {
    if (closed || at >= timerAt) return;
    clearTimeout(timer);
    timerAt = at;
    timer = setTimeout(() => {
      timer = undefined;
      timerAt = Infinity;
      retryDue(now());
    }, Math.max(TURN_COMPLETION_RETRY_MIN_MS, at - now()));
    timer.unref();
  }

  function report(error: unknown, receipt?: TurnCompletionReceipt): void {
    const message = `${ERROR_PREFIX}${receipt ? `session ${receipt.sessionId}, receipt ${receipt.sequence}: ` : ""}${String(error)}`;
    console.error(`${LOG_PREFIX} ${message}`);
    try {
      write((p) => reportHealthIn(p, "store", message));
      reportedError = message;
    } catch {
      // The same outage can prevent the health record from being saved.
    }
  }

  function writeReceipt(receipt: TurnCompletionReceipt, facts: TurnCompletionFacts | null): void {
    db.run(
      `INSERT INTO turn_completions (sequence, session_id, event, facts, next_attempt_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT (sequence) DO UPDATE SET facts = COALESCE(turn_completions.facts, excluded.facts)`,
      receipt.sequence, receipt.sessionId, JSON.stringify(receipt.event), facts === null ? null : JSON.stringify(facts), now(),
    );
  }

  /** Keeps the receipt in memory and schedules another upsert; returns null when the buffer is full and the receipt is dropped. */
  function hold(receipt: TurnCompletionReceipt, facts: TurnCompletionFacts | null, attempts: number, error: unknown): number | null {
    if (!pendingWrites.has(receipt.sequence) && pendingWrites.size >= TURN_COMPLETION_UNPERSISTED_MAX) {
      overflow = true;
      report(new Error("Receipt buffer is full"), receipt);
      effects.onOverflow(receipt.sessionId);
      return null;
    }
    const retryAt = now() + delayOf(attempts);
    pendingWrites.set(receipt.sequence, { receipt, facts, attempts: attempts + 1, retryAt });
    report(error, receipt);
    wakeAt(retryAt);
    return retryAt;
  }

  function save(receipt: TurnCompletionReceipt, facts: TurnCompletionFacts | null, attempts = 0): void {
    try {
      writeReceipt(receipt, facts);
      pendingWrites.delete(receipt.sequence);
    } catch (error) {
      hold(receipt, facts, attempts, error);
    }
  }

  function run(receipt: TurnCompletionReceipt, facts: TurnCompletionFacts, attempts: number): TurnCompletionResult {
    try {
      const applied = write((p) => {
        if (!db.get("SELECT 1 FROM turn_completions WHERE sequence = ? AND session_id = ?", receipt.sequence, receipt.sessionId)) return false;
        const settled = db.get("SELECT 1 FROM turn_completion_watermarks WHERE session_id = ? AND sequence >= ?", receipt.sessionId, receipt.sequence);
        db.run(
          `INSERT INTO turn_completion_watermarks (session_id, sequence) VALUES (?, ?)
           ON CONFLICT (session_id) DO UPDATE SET sequence = max(sequence, excluded.sequence)`,
          receipt.sessionId, receipt.sequence,
        );
        db.run("DELETE FROM turn_completions WHERE sequence = ?", receipt.sequence);
        if (!settled) effects.apply(p, receipt, facts, receipt.sequence <= startupSequence);
        return !settled;
      });
      return { kind: applied ? "settled" : "already_settled" };
    } catch (error) {
      const retryAt = now() + delayOf(attempts);
      try {
        db.run("UPDATE turn_completions SET attempts = attempts + 1, next_attempt_at = ? WHERE sequence = ?", retryAt, receipt.sequence);
      } catch {
        // The committed receipt remains available even if the retry metadata cannot be saved.
      }
      report(error, receipt);
      wakeAt(retryAt);
      return { kind: "pending", retryAt };
    }
  }

  function rowFor(receipt: TurnCompletionReceipt): ReceiptRow | undefined {
    return db.get<ReceiptRow>("SELECT * FROM turn_completions WHERE sequence = ? AND session_id = ?", receipt.sequence, receipt.sessionId);
  }

  function receive(sessionId: SessionId, event: TurnEndedEvent, facts: TurnCompletionFacts | null): TurnCompletionReceipt {
    const receipt = { sequence: ++sequence, sessionId, event: { ...event, messageIds: [...event.messageIds] } };
    save(receipt, facts);
    return receipt;
  }

  /** Never throws: a failed read or write hands the receipt to the retry timer, which wakes the session queue on settlement. */
  function settle(receipt: TurnCompletionReceipt, facts: TurnCompletionFacts): TurnCompletionResult {
    const pending = pendingWrites.get(receipt.sequence);
    if (pending !== undefined) {
      pending.facts ??= facts;
      return { kind: "pending", retryAt: pending.retryAt };
    }
    let row: ReceiptRow | undefined;
    try {
      row = rowFor(receipt);
      if (row === undefined) return { kind: "already_settled" };
      if (row.facts === null) writeReceipt(receipt, facts);
      if (hasEarlierWrite(receipt) || db.get("SELECT 1 FROM turn_completions WHERE session_id = ? AND sequence < ? LIMIT 1", receipt.sessionId, receipt.sequence)) {
        const retryAt = now() + TURN_COMPLETION_RETRY_MIN_MS;
        wakeAt(retryAt);
        return { kind: "pending", retryAt };
      }
    } catch (error) {
      const retryAt = hold(receipt, facts, 0, error);
      return retryAt === null ? { kind: "dropped" } : { kind: "pending", retryAt };
    }
    if (row.attempts > 0) return { kind: "pending", retryAt: row.next_attempt_at };
    return run(receipt, row.facts === null ? facts : JSON.parse(row.facts) as TurnCompletionFacts, row.attempts);
  }

  function persistDue(at: number): void {
    let budget = TURN_COMPLETION_RETRY_BATCH_SIZE;
    for (const { receipt, facts, attempts, retryAt } of pendingWrites.values()) {
      if (retryAt > at) continue;
      if (budget-- === 0) break;
      if (db.get("SELECT 1 FROM agent_sessions WHERE id = ?", receipt.sessionId) === undefined) {
        pendingWrites.delete(receipt.sequence);
        effects.onSettled(receipt);
      } else {
        save(receipt, facts, attempts);
      }
    }
  }

  /** Settles one bounded batch of due session heads, skipping receipts already tried by the caller, and returns how many ran. */
  function settleBatch(at: number, tried: Set<number>): number {
    const rows = db.all<ReceiptRow>(
      `SELECT r.* FROM turn_completions r WHERE r.next_attempt_at <= ? AND (r.facts IS NOT NULL OR r.sequence <= ?)
        AND r.sequence NOT IN (SELECT value FROM json_each(?)) AND ${SESSION_HEAD}
        ORDER BY r.next_attempt_at, r.sequence LIMIT ?`,
      at, startupSequence, JSON.stringify([...tried]), TURN_COMPLETION_RETRY_BATCH_SIZE + pendingWrites.size,
    );
    let ran = 0;
    for (const row of rows) {
      const receipt = { sequence: row.sequence, sessionId: row.session_id, event: JSON.parse(row.event) as TurnEndedEvent };
      if (hasEarlierWrite(receipt)) continue;
      if (ran === TURN_COMPLETION_RETRY_BATCH_SIZE) break;
      ran++;
      tried.add(row.sequence);
      const result = run(receipt, row.facts === null ? NO_TURN_FACTS : JSON.parse(row.facts) as TurnCompletionFacts, row.attempts);
      if (result.kind !== "pending") effects.onSettled(receipt);
    }
    return ran;
  }

  function scheduleNext(): void {
    for (const entry of pendingWrites.values()) wakeAt(entry.retryAt);
    const next = db.get<{ next_attempt_at: number }>(
      `SELECT r.next_attempt_at FROM turn_completions r WHERE (r.facts IS NOT NULL OR r.sequence <= ?) AND ${SESSION_HEAD}
       ORDER BY r.next_attempt_at, r.sequence LIMIT 1`, startupSequence,
    );
    if (next !== undefined) wakeAt(next.next_attempt_at);
    if (reportedError !== undefined && !overflow && next === undefined && pendingWrites.size === 0) {
      if (db.get<{ last_error: string }>("SELECT last_error FROM health WHERE module = 'store'")?.last_error === reportedError) {
        write((p) => reportHealthIn(p, "store", null));
      }
      reportedError = undefined;
    }
  }

  function retryDue(at: number): void {
    if (closed) return;
    try {
      persistDue(at);
      settleBatch(at, new Set());
      scheduleNext();
    } catch (error) {
      report(error);
      wakeAt(now() + TURN_COMPLETION_RETRY_MAX_MS);
    }
  }

  /** Startup tries every committed receipt once, including each session's later receipts, before anything reads message status. */
  function recover(): void {
    if (closed) return;
    const tried = new Set<number>();
    try {
      while (settleBatch(Infinity, tried) > 0);
      scheduleNext();
    } catch (error) {
      report(error);
      wakeAt(now() + TURN_COMPLETION_RETRY_MAX_MS);
    }
  }

  function blocksSend(sessionId: SessionId): boolean {
    return overflow || [...pendingWrites.values()].some((entry) => entry.receipt.sessionId === sessionId) ||
      db.get("SELECT 1 FROM turn_completions WHERE session_id = ? LIMIT 1", sessionId) !== undefined;
  }

  return {
    receive, settle, retryDue, blocksSend, recover,
    close() {
      closed = true;
      clearTimeout(timer);
      pendingWrites.clear();
    },
  };
}
