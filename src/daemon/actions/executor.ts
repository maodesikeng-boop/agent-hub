// 执行器（设计第 12.2 节）：取到点的“待执行”动作，调注册的处理函数，按结果改状态。
// - 同一个会话一次只跑一个动作（params.sessionId 相同的排队），不同会话并行，总数不超过 concurrency；
// - 到点的动作里“启动或恢复会话”一律排在“发消息”前面（不看谁先到点），重启恢复时先带着恢复说明把会话起来；
// - 处理函数抛错按 ACTION_RETRY 退避，每次都 reportHealth（DriverError → "driver"，其他 → "actions"），
//   次数用完标 failed 并调 onActionFailed；任何一个动作成功，都把 "driver" 和 "actions" 清零（不看内存里报过什么）；
// - 改动作状态写库失败记 "store"；没跑完却停在 running 的行（结果没写进去），下一轮改回 pending 重做；
// - 放弃的动作（坏行、没有处理函数）能认出是 session.send 的，也调 onActionFailed，原因前加“放弃：”。
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

export interface ActionExecutorOptions {
  now?: () => number;
  /** 没有到点的动作时最多隔多久再查一次（兜底，平时靠 wake 和下一个到点时间）。默认 ACTION_POLL_INTERVAL_MS。 */
  pollIntervalMs?: number;
  /** 同时最多跑几个动作。默认 ACTION_CONCURRENCY。 */
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

/** 从一行（可能是坏行）里认出 session.send；认不出返回 null。 */
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

function sessionKey(row: AnyActionRow): number | null {
  const id = (row.params as { sessionId?: unknown }).sessionId;
  return typeof id === "number" ? id : null;
}

export function createActionExecutor(db: Db, deps: ActionExecutorDeps, options: ActionExecutorOptions = {}): ActionExecutor {
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? ACTION_POLL_INTERVAL_MS;
  const concurrency = options.concurrency ?? ACTION_CONCURRENCY;
  const retry = options.retry ?? ACTION_RETRY;

  const handlers = new Map<ActionType, ActionHandler>();
  const inFlight = new Map<ActionId, Promise<void>>();
  const busySessions = new Set<number>();
  let started = false;
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** timer 到点的时刻（Date.now 的时间，和 setTimeout 一致）。 */
  let timerAt = 0;

  const report = (module: HealthModule, error: string | null) => {
    try {
      deps.reportHealth(module, error);
    } catch (e) {
      console.error(`${LOG_PREFIX} executor: reportHealth failed:`, e);
    }
  };

  /** 写库（改动作状态、调账本）出错时用：不往外抛，记 "store"。 */
  const safely = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      console.error(`${LOG_PREFIX} executor:`, error);
      report("store", errorMessage(error));
    }
  };

  /** 只把下次唤醒往前挪，不往后推（免得 wake() 被这一轮末尾的 schedule 盖掉）。 */
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

  /** later 的 delayMs：不是有限数按轮询间隔（不忙等也不卡住），小数向上取整，负数按 0。 */
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
      // 结果没写进去（写库失败）而停在 running 的行：改回 pending，下面照常再取
      const running = [...inFlight.keys()];
      db.run(
        `UPDATE actions SET status = 'pending', updated_at = ? WHERE status = 'running' AND id NOT IN (${running.map(() => "?").join(", ")})`,
        t,
        ...running,
      );
      for (const raw of db.all<ActionDbRow>(DUE_SQL, t)) {
        if (inFlight.size >= concurrency) break;
        let row: AnyActionRow;
        try {
          row = toActionRow(raw);
        } catch (error) {
          abandon(raw.id, `bad action row: ${errorMessage(error)}`, parseSend(raw));
          continue;
        }
        const key = sessionKey(row);
        if (key !== null && busySessions.has(key)) continue;
        const handler = handlers.get(row.type);
        if (handler === undefined) {
          abandon(row.id, `no handler registered for ${row.type}`, row.type === "session.send" ? row : null);
          continue;
        }
        setActionStatus(db, row.id, { status: "running" }, t);
        if (key !== null) busySessions.add(key);
        const job = execute({ ...row, status: "running", updatedAt: t }, handler).finally(() => {
          inFlight.delete(row.id);
          if (key !== null) busySessions.delete(key);
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
