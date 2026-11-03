// 执行器（设计第 12.2 节）：取到点的“待执行”动作，调注册的处理函数，按结果改状态。
// - 同一个会话一次只跑一个动作（params.sessionId 相同的排队），不同会话并行，总数不超过 concurrency；
// - 同时到点时“启动或恢复会话”排在“发消息”前面，重启恢复时先带着恢复说明把会话起来；
// - 处理函数抛错按 ACTION_RETRY 退避，每次都 reportHealth（DriverError → "driver"，其他 → "actions"），
//   次数用完标 failed 并调 onActionFailed；之后任何一个动作成功，就把执行器报过错的模块清零。
import { ACTION_RETRY, retryDelayMs } from "../../shared/actions.ts";
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
import type { Db } from "../store/index.ts";
import { setActionStatus, toActionRow } from "./queue.ts";
import type { ActionDbRow } from "./queue.ts";

export type ActionExecutorDeps = Pick<Ledger, "reportHealth" | "onActionFailed">;

export interface ActionExecutorOptions {
  now?: () => number;
  /** 没有到点的动作时最多隔多久再查一次（兜底，平时靠 wake 和下一个到点时间）。默认 30 秒。 */
  pollIntervalMs?: number;
  /** 同时最多跑几个动作。默认 4。 */
  concurrency?: number;
  retry?: Record<ActionType, RetryPolicy>;
}

const DUE_SQL = `
SELECT * FROM actions
WHERE status = 'pending' AND next_attempt_at <= ?
ORDER BY next_attempt_at, CASE type WHEN 'session.start' THEN 0 ELSE 1 END, id`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionKey(row: AnyActionRow): number | null {
  const id = (row.params as { sessionId?: unknown }).sessionId;
  return typeof id === "number" ? id : null;
}

export function createActionExecutor(db: Db, deps: ActionExecutorDeps, options: ActionExecutorOptions = {}): ActionExecutor {
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? 30_000;
  const concurrency = options.concurrency ?? 4;
  const retry = options.retry ?? ACTION_RETRY;

  const handlers = new Map<ActionType, ActionHandler>();
  const inFlight = new Map<ActionId, Promise<void>>();
  const busySessions = new Set<number>();
  const failedModules = new Set<HealthModule>();
  let started = false;
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const safely = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      console.error("agent-hub executor:", error);
    }
  };

  const report = (module: HealthModule, error: string | null) => {
    if (error !== null) failedModules.add(module);
    safely(() => deps.reportHealth(module, error));
  };

  const schedule = (delayMs: number) => {
    if (!started || stopping) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(tick, Math.max(0, delayMs));
  };

  const abandon = (id: ActionId, error: string) => {
    setActionStatus(db, id, { status: "abandoned", lastError: error }, now());
    report("actions", error);
  };

  const finish = (row: AnyActionRow, result: ActionResult) => {
    const t = now();
    if (result.kind === "done") {
      setActionStatus(db, row.id, { status: "done", lastError: null }, t);
      for (const module of failedModules) safely(() => deps.reportHealth(module, null));
      failedModules.clear();
    } else {
      setActionStatus(db, row.id, { status: "pending", nextAttemptAt: t + Math.max(0, result.delayMs) }, t);
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
      for (const raw of db.all<ActionDbRow>(DUE_SQL, t)) {
        if (inFlight.size >= concurrency) break;
        let row: AnyActionRow;
        try {
          row = toActionRow(raw);
        } catch (error) {
          abandon(raw.id, `bad action row: ${errorMessage(error)}`);
          continue;
        }
        const key = sessionKey(row);
        if (key !== null && busySessions.has(key)) continue;
        const handler = handlers.get(row.type);
        if (handler === undefined) {
          abandon(row.id, `no handler registered for ${row.type}`);
          continue;
        }
        setActionStatus(db, row.id, { status: "running" }, t);
        if (key !== null) busySessions.add(key);
        const running = execute({ ...row, status: "running", updatedAt: t }, handler).finally(() => {
          inFlight.delete(row.id);
          if (key !== null) busySessions.delete(key);
          schedule(0);
        });
        inFlight.set(row.id, running);
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
