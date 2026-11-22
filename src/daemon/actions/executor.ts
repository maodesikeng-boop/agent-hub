import { ACTION_RETRY, retryDelayMs } from "../../shared/actions.ts";
import { ACTION_CONCURRENCY, ACTION_POLL_INTERVAL_MS } from "../../shared/limits.ts";
import type {
  ActionExecutor,
  ActionHandler,
  ActionResult,
  ActionType,
  AnyActionRow,
  RetryPolicy,
} from "../../shared/actions.ts";
import { DriverError } from "../../shared/driver.ts";
import type { ActionId, HealthModule } from "../../shared/domain.ts";
import type { Ledger } from "../../shared/ledger.ts";
import { LOG_PREFIX } from "../../shared/names.ts";
import type { Db } from "../store/index.ts";
import { setActionStatus, toActionRow } from "./queue.ts";
import type { ActionDbRow } from "./queue.ts";

export type ActionExecutorDeps = Pick<Ledger, "reportHealth" | "onActionFailed">;

interface ActionExecutorOptions {
  now?: () => number;
  pollIntervalMs?: number;
  concurrency?: number;
  retry?: Record<ActionType, RetryPolicy>;
}

const DUE_SQL = `
SELECT * FROM actions
WHERE status = 'pending' AND next_attempt_at <= ?
ORDER BY CASE type WHEN 'session.start' THEN 0 ELSE 1 END, next_attempt_at, id`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseSend(raw: ActionDbRow): AnyActionRow | null {
  if (raw.type !== "session.send") return null;
  let params: unknown;
  try {
    params = JSON.parse(raw.params);
  } catch {
    return null;
  }
  const p = params as { sessionId?: unknown; messageId?: unknown } | null;
  if (typeof p?.sessionId !== "number" || typeof p.messageId !== "number") return null;
  return {
    id: raw.id,
    type: "session.send",
    dedupeKey: raw.dedupe_key,
    params,
    status: "abandoned",
    attempts: raw.attempts,
    nextAttemptAt: raw.next_attempt_at,
    lastError: raw.last_error,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  } as AnyActionRow;
}

/** Actions sharing a lane run one at a time: one lane per session, and one for all review stamps. */
function laneKey(row: AnyActionRow): string | null {
  // GitHub keeps the last status posted, so two stamps in flight could land out of order and leave a stale verdict.
  if (row.type === "review.stamp") return "review.stamp";
  const id = (row.params as { sessionId?: unknown }).sessionId;
  return typeof id === "number" ? `session:${id}` : null;
}

export function createActionExecutor(db: Db, deps: ActionExecutorDeps, options: ActionExecutorOptions = {}): ActionExecutor {
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? ACTION_POLL_INTERVAL_MS;
  const concurrency = options.concurrency ?? ACTION_CONCURRENCY;
  const retry = options.retry ?? ACTION_RETRY;

  const handlers = new Map<ActionType, ActionHandler>();
  const inFlight = new Map<ActionId, Promise<void>>();
  const busyLanes = new Set<string>();
  let started = false;
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerAt = 0;

  const report = (module: HealthModule, error: string | null) => {
    try {
      deps.reportHealth(module, error);
    } catch (e) {
      console.error(`${LOG_PREFIX} executor: reportHealth failed:`, e);
    }
  };

  const safely = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      console.error(`${LOG_PREFIX} executor:`, error);
      report("store", errorMessage(error));
    }
  };

  /** Only move the wakeup earlier, so the schedule at the end of a tick cannot override wake(). */
  const schedule = (delayMs: number) => {
    if (!started || stopping) return;
    const at = Date.now() + Math.max(0, delayMs);
    if (timer !== undefined) {
      if (timerAt <= at) return;
      clearTimeout(timer);
    }
    timerAt = at;
    timer = setTimeout(tick, Math.max(0, delayMs));
  };

  const abandon = (id: ActionId, error: string, send: AnyActionRow | null) => {
    setActionStatus(db, id, { status: "abandoned", lastError: error }, now());
    report("actions", error);
    if (send !== null) {
      const abandoned: AnyActionRow = { ...send, status: "abandoned", lastError: error };
      safely(() => deps.onActionFailed(abandoned, `放弃：${error}`));
    }
  };

  const laterDelay = (delayMs: number) => (Number.isFinite(delayMs) ? Math.max(0, Math.ceil(delayMs)) : pollIntervalMs);

  const finish = (row: AnyActionRow, result: ActionResult) => {
    const t = now();
    if (result.kind === "done") {
      setActionStatus(db, row.id, { status: "done", lastError: null }, t);
      report("driver", null);
      report("actions", null);
    } else {
      setActionStatus(db, row.id, { status: "pending", nextAttemptAt: t + laterDelay(result.delayMs) }, t);
    }
  };

  const fail = (row: AnyActionRow, error: unknown) => {
    const message = errorMessage(error);
    const attempts = row.attempts + 1;
    const policy = retry[row.type];
    const t = now();
    const exhausted = attempts >= policy.maxAttempts;
    if (exhausted) {
      setActionStatus(db, row.id, { status: "failed", attempts, lastError: message }, t);
    } else {
      setActionStatus(db, row.id, { status: "pending", attempts, lastError: message, nextAttemptAt: t + retryDelayMs(policy, attempts) }, t);
    }
    report(error instanceof DriverError ? "driver" : "actions", message);
    if (exhausted) {
      const failed: AnyActionRow = { ...row, status: "failed", attempts, lastError: message, updatedAt: t };
      safely(() => deps.onActionFailed(failed, message));
    }
  };

  const execute = async (row: AnyActionRow, handler: ActionHandler): Promise<void> => {
    let result: ActionResult;
    try {
      result = await handler(row);
    } catch (error) {
      safely(() => fail(row, error));
      return;
    }
    safely(() => finish(row, result));
  };

  function tick() {
    timer = undefined;
    if (!started || stopping) return;
    const t = now();
    try {
      // Rows left running after a failed write are reset to pending and picked up again.
      for (const { id } of db.all<{ id: number }>("SELECT id FROM actions WHERE status = 'running'")) {
        if (!inFlight.has(id)) {
          db.run("UPDATE actions SET status = 'pending', updated_at = ? WHERE id = ?", t, id);
        }
      }
      for (const raw of db.all<ActionDbRow>(DUE_SQL, t)) {
        if (inFlight.size >= concurrency) break;
        let row: AnyActionRow;
        try {
          row = toActionRow(raw);
        } catch (error) {
          abandon(raw.id, `bad action row: ${errorMessage(error)}`, parseSend(raw));
          continue;
        }
        const key = laneKey(row);
        if (key !== null && busyLanes.has(key)) continue;
        const handler = handlers.get(row.type);
        if (handler === undefined) {
          abandon(row.id, `no handler registered for ${row.type}`, row.type === "session.send" ? row : null);
          continue;
        }
        setActionStatus(db, row.id, { status: "running" }, t);
        if (key !== null) busyLanes.add(key);
        const job = execute({ ...row, status: "running", updatedAt: t }, handler).finally(() => {
          inFlight.delete(row.id);
          if (key !== null) busyLanes.delete(key);
          schedule(0);
        });
        inFlight.set(row.id, job);
      }
      const next = db.get<{ next: number | null }>(
        "SELECT MIN(next_attempt_at) AS next FROM actions WHERE status = 'pending' AND next_attempt_at > ?",
        t,
      )?.next;
      schedule(next == null ? pollIntervalMs : Math.min(next - t, pollIntervalMs));
    } catch (error) {
      report("store", errorMessage(error));
      schedule(pollIntervalMs);
    }
  }

  return {
    register(type, handler) {
      if (started) throw new Error(`register ${type} before start()`);
      if (handlers.has(type)) throw new Error(`handler for ${type} already registered`);
      handlers.set(type, handler as unknown as ActionHandler);
    },
    start() {
      if (started) return;
      started = true;
      db.run("UPDATE actions SET status = 'pending', updated_at = ? WHERE status = 'running'", now());
      schedule(0);
    },
    wake() {
      schedule(0);
    },
    async stop() {
      stopping = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      while (inFlight.size > 0) await Promise.allSettled([...inFlight.values()]);
    },
  };
}
